//! Postgres (Aurora) read-model for the explorer-api. The `settlement` table and all writes
//! are owned by the `explorer` crate (Diesel). This reader opens the pool and queries only.
//! Integration tests are `#[ignore]` and require `TEST_DATABASE_URL`.

use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{PgPool, Row};

use crate::{LifecycleKind, SettlementPage, SettlementQuery, SettlementRow, SettlementStore};

pub struct PgSettlementStore {
    pool: PgPool,
}

impl PgSettlementStore {
    /// Connect and return the read store. Does NOT run migrations — Diesel (explorer crate)
    /// owns the schema. `database_url` is the RDS Proxy URL.
    pub async fn connect(database_url: &str) -> anyhow::Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }
}

fn row_from_pg(r: &PgRow) -> anyhow::Result<SettlementRow> {
    let kind_raw = r.get::<String, _>("kind");
    let kind = LifecycleKind::from_db_str(&kind_raw)
        .ok_or_else(|| anyhow::anyhow!("unrecognised lifecycle kind: {kind_raw:?}"))?;
    Ok(SettlementRow {
        tx_digest: r.get("tx_digest"),
        kind,
        tunnel_id: r.get("tunnel_id"),
        party_a_addr: r.get("party_a_addr"),
        party_b_addr: r.get("party_b_addr"),
        party_a_balance: r.get("party_a_balance"),
        party_b_balance: r.get("party_b_balance"),
        final_nonce: r.get("final_nonce"),
        transcript_root: r.get("transcript_root"),
        proof_url: r.get("proof_url"),
        walrus_blob_id: r.get("walrus_blob_id"),
        checkpoint: r.get("checkpoint"),
        timestamp_ms: r.get("timestamp_ms"),
        closed_at_ms: r.get("closed_at_ms"),
        game: r.get("game"),
    })
}

#[async_trait::async_trait]
impl SettlementStore for PgSettlementStore {
    async fn get(&self, tx_digest: &str) -> anyhow::Result<Option<SettlementRow>> {
        let r = sqlx::query("SELECT * FROM settlement WHERE tx_digest = $1")
            .bind(tx_digest)
            .fetch_optional(&self.pool)
            .await?;
        Ok(r.as_ref().map(row_from_pg).transpose()?)
    }

    async fn list(&self, q: &SettlementQuery) -> anyhow::Result<SettlementPage> {
        let limit = q.limit.clamp(1, 1000);
        // Composite keyset cursor over (ts, digest, tunnel_id): the row-value comparison
        // `(ts, digest, tunnel_id) < ($1, $2, $3)` matches the `(ts DESC, digest DESC, tunnel_id DESC)`
        // order. tunnel_id is in the key because one tx (PTB) can settle many tunnels — those rows
        // share (ts, digest), so a 2-part key would skip the un-returned siblings at a page edge.
        // All three halves are NULL on page 1 (the `IS NULL` branch lets all rows in).
        let cur = q.cursor.as_deref().and_then(crate::decode_cursor);
        let cur_ts = cur.as_ref().map(|c| c.0);
        let cur_digest = cur.as_ref().map(|c| c.1.clone());
        let cur_tunnel = cur.as_ref().map(|c| c.2.clone());
        // Fetch limit+1 to compute next_cursor without a second query.
        let rows = sqlx::query(
            r#"
            SELECT * FROM settlement
            WHERE ($1::bigint IS NULL OR (timestamp_ms, tx_digest, tunnel_id) < ($1, $2, $3))
              AND ($4::text IS NULL OR tunnel_id = $4)
              AND ($5::text IS NULL OR kind = $5)
              AND ($6::text IS NULL OR party_a_addr = $6 OR party_b_addr = $6)
            ORDER BY timestamp_ms DESC, tx_digest DESC, tunnel_id DESC
            LIMIT $7
            "#,
        )
        .bind(cur_ts)
        .bind(cur_digest)
        .bind(cur_tunnel)
        .bind(&q.tunnel_id)
        .bind(q.kind.map(LifecycleKind::as_str))
        .bind(&q.address)
        .bind(limit + 1)
        .fetch_all(&self.pool)
        .await?;

        let mut out: Vec<SettlementRow> = rows
            .iter()
            .map(row_from_pg)
            .collect::<anyhow::Result<Vec<_>>>()?;
        let next_cursor = if out.len() as i64 > limit {
            out.truncate(limit as usize);
            out.last()
                .map(|r| crate::encode_cursor(r.timestamp_ms, &r.tx_digest, &r.tunnel_id))
        } else {
            None
        };
        Ok(SettlementPage {
            rows: out,
            next_cursor,
        })
    }

    async fn settled_count(&self) -> anyhow::Result<i64> {
        Ok(
            sqlx::query_scalar("SELECT value FROM settlement_meta WHERE key = 'settled_count'")
                .fetch_one(&self.pool)
                .await?,
        )
    }

    async fn metric_history(
        &self,
        from_secs: i64,
        to_secs: i64,
        stride_secs: i64,
    ) -> anyhow::Result<Vec<(i64, i64)>> {
        // One point per stride-wide bucket: MAX(ts_bucket)/MAX(total_actions) per group. Both are
        // aggregates (valid under GROUP BY) and, the counter being monotonic, MAX is the bucket's
        // last value — so a bucket spanning a data gap still reports its true endpoint. stride=1
        // collapses to one row per bucket → the full-resolution per-second series.
        let rows = sqlx::query_as::<_, (i64, i64)>(
            "SELECT MAX(ts_bucket) AS bucket_ts, MAX(total_actions) AS total FROM metric_bucket \
             WHERE ts_bucket >= $1 AND ts_bucket <= $2 \
             GROUP BY ts_bucket / $3 ORDER BY bucket_ts ASC",
        )
        .bind(from_secs)
        .bind(to_secs)
        .bind(stride_secs.max(1))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SettlementQuery;

    // Set up a schema-owning connection for integration tests. Since `shared` is the reader
    // and Diesel (explorer crate) owns migrations, we create the tables here inline so the
    // reader has something to query. Not tested: write semantics (those belong to explorer).
    async fn store() -> Option<PgSettlementStore> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        let s = PgSettlementStore::connect(&url).await.expect("connect");
        // Mirror the DDL from the explorer crate's Diesel migration so the reader can be tested
        // without running the full explorer binary.
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS settlement (
                tx_digest        TEXT NOT NULL,
                kind             TEXT NOT NULL,
                tunnel_id        TEXT NOT NULL,
                party_a_addr     TEXT,
                party_b_addr     TEXT,
                party_a_balance  BIGINT,
                party_b_balance  BIGINT,
                final_nonce      BIGINT,
                transcript_root  TEXT,
                proof_url        TEXT,
                walrus_blob_id   TEXT,
                checkpoint       BIGINT NOT NULL,
                timestamp_ms     BIGINT NOT NULL,
                closed_at_ms     BIGINT,
                game             TEXT,
                PRIMARY KEY (tx_digest, tunnel_id)
            )
            "#,
        )
        .execute(&s.pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS settlement_ts_idx ON settlement (timestamp_ms DESC, tx_digest DESC)",
        )
        .execute(&s.pool)
        .await
        .unwrap();
        sqlx::query("CREATE INDEX IF NOT EXISTS settlement_tunnel_idx ON settlement (tunnel_id)")
            .execute(&s.pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS settlement_party_a_idx ON settlement (party_a_addr)",
        )
        .execute(&s.pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS settlement_party_b_idx ON settlement (party_b_addr)",
        )
        .execute(&s.pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS settlement_meta (
                key   TEXT PRIMARY KEY,
                value BIGINT NOT NULL
            )
            "#,
        )
        .execute(&s.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO settlement_meta (key, value) VALUES ('settled_count', 0) ON CONFLICT (key) DO NOTHING",
        )
        .execute(&s.pool)
        .await
        .unwrap();
        // Reset state before each test.
        sqlx::query("TRUNCATE settlement")
            .execute(&s.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE settlement_meta SET value = 0 WHERE key = 'settled_count'")
            .execute(&s.pool)
            .await
            .unwrap();
        Some(s)
    }

    /// Seed a settled row directly (no upsert on the read store — the indexer owns writes).
    async fn insert_row(pool: &PgPool, tx_digest: &str, ts: i64, party_b: Option<&str>) {
        sqlx::query(
            r#"
            INSERT INTO settlement (tx_digest, kind, tunnel_id, party_a_addr, party_b_addr,
                party_a_balance, party_b_balance, final_nonce, transcript_root, proof_url,
                walrus_blob_id, checkpoint, timestamp_ms, closed_at_ms, game)
            VALUES ($1,'settled','0xtun','0xa',$2,60,40,3,'aa',NULL,NULL,7,$3,$3,NULL)
            "#,
        )
        .bind(tx_digest)
        .bind(party_b)
        .bind(ts)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Seed a settled row with an explicit tunnel_id — two tunnels can share one tx_digest.
    async fn insert_tunnel_row(pool: &PgPool, tx_digest: &str, tunnel_id: &str, ts: i64) {
        sqlx::query(
            "INSERT INTO settlement (tx_digest, kind, tunnel_id, party_a_addr, party_b_addr, \
             party_a_balance, party_b_balance, final_nonce, transcript_root, proof_url, \
             walrus_blob_id, checkpoint, timestamp_ms, closed_at_ms, game) \
             VALUES ($1,'settled',$2,'0xa','0xb',60,40,3,'aa',NULL,NULL,7,$3,$3,NULL)",
        )
        .bind(tx_digest)
        .bind(tunnel_id)
        .bind(ts)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn list_keyset_does_not_drop_same_tx_siblings() {
        let Some(s) = store().await else { return };
        // One PTB closing two tunnels => two rows sharing timestamp_ms AND tx_digest, differing only
        // by tunnel_id. Paginating one-at-a-time must surface BOTH; a keyset on (ts, digest) alone
        // excludes the un-returned sibling at the page edge.
        insert_tunnel_row(&s.pool, "batch", "0xtun_a", 10).await;
        insert_tunnel_row(&s.pool, "batch", "0xtun_b", 10).await;

        let mut seen = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..3 {
            let page = s
                .list(&SettlementQuery {
                    limit: 1,
                    cursor: cursor.clone(),
                    ..Default::default()
                })
                .await
                .unwrap();
            seen.extend(page.rows.iter().map(|r| r.tunnel_id.clone()));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        seen.sort();
        assert_eq!(
            seen,
            vec!["0xtun_a".to_string(), "0xtun_b".to_string()],
            "both tunnels of a single batched tx must paginate, not be dropped at the page edge"
        );
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn list_keyset_and_address_filter() {
        let Some(s) = store().await else { return };
        for (d, ts) in [("a", 10i64), ("b", 20), ("c", 30)] {
            insert_row(&s.pool, d, ts, Some("0xb")).await;
        }
        let p1 = s
            .list(&SettlementQuery {
                limit: 2,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            p1.rows
                .iter()
                .map(|r| r.tx_digest.clone())
                .collect::<Vec<_>>(),
            ["c", "b"]
        );
        assert_eq!(p1.next_cursor.as_deref(), Some("20:b:0xtun"));
        let hit = s
            .list(&SettlementQuery {
                limit: 10,
                address: Some("0xb".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(hit.rows.len(), 3);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn settled_count_reads_meta_table() {
        let Some(s) = store().await else { return };
        // Initially 0 (reset by store()).
        assert_eq!(s.settled_count().await.unwrap(), 0);
        // Simulate indexer maintaining the counter at write time.
        sqlx::query("UPDATE settlement_meta SET value = 5 WHERE key = 'settled_count'")
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(
            s.settled_count().await.unwrap(),
            5,
            "reads the maintained counter, not COUNT(*)"
        );
    }
}
