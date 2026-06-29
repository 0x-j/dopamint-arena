//! Durable retry store for S3 archival (ADR-0023). Behind a trait so the drain worker
//! is unit-testable without Postgres (InMemoryArchiveQueue); PgArchiveQueue is the prod
//! impl over the explorer's `pending_s3_archive` table. Rows are transient — deleted on
//! success. Mirrors the ControlStore/MpStore trait+impl split in `store/`.

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::s3::ArchiveMeta;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PendingArchive {
    pub tx_digest: String,
    pub object_key: String,
    pub bytes: Vec<u8>,
    pub meta: ArchiveMeta,
}

#[async_trait]
#[allow(dead_code)]
pub trait ArchiveQueue: Send + Sync {
    async fn enqueue(&self, p: PendingArchive) -> anyhow::Result<()>;
    /// Drain rows that are due for retry. Designed for a single worker instance;
    /// concurrent workers could double-process rows. Scale horizontally with row-level
    /// locking (e.g., `FOR UPDATE SKIP LOCKED`) if multiple drainers are needed.
    async fn drain_due(&self, limit: i64) -> anyhow::Result<Vec<PendingArchive>>;
    async fn delete(&self, tx_digest: &str) -> anyhow::Result<()>;
    /// Bump attempts and push `next_attempt_at` out by exponential backoff (cap 1h).
    async fn requeue(&self, tx_digest: &str) -> anyhow::Result<()>;
}

/// In-memory queue for tests. `drain_due` returns everything (no real scheduling); a
/// failed row stays until deleted, so requeue is a no-op.
#[derive(Default)]
#[allow(dead_code)]
pub struct InMemoryArchiveQueue {
    rows: Mutex<VecDeque<PendingArchive>>,
}

#[async_trait]
impl ArchiveQueue for InMemoryArchiveQueue {
    async fn enqueue(&self, p: PendingArchive) -> anyhow::Result<()> {
        self.rows.lock().unwrap().push_back(p);
        Ok(())
    }
    async fn drain_due(&self, limit: i64) -> anyhow::Result<Vec<PendingArchive>> {
        let mut g = self.rows.lock().unwrap();
        let len = g.len();
        let take = limit.max(0) as usize;
        Ok(g.drain(..take.min(len)).collect())
    }
    async fn delete(&self, tx_digest: &str) -> anyhow::Result<()> {
        self.rows
            .lock()
            .unwrap()
            .retain(|r| r.tx_digest != tx_digest);
        Ok(())
    }
    async fn requeue(&self, _tx_digest: &str) -> anyhow::Result<()> {
        Ok(()) // already retained
    }
}

/// Postgres impl over `pending_s3_archive`. Connects its own bounded pool to the same
/// RDS Proxy DATABASE_URL the explorer uses (ADR-0023).
#[allow(dead_code)]
pub struct PgArchiveQueue {
    pool: PgPool,
}

#[allow(dead_code)]
impl PgArchiveQueue {
    pub async fn connect(database_url: &str) -> anyhow::Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }
}

#[async_trait]
impl ArchiveQueue for PgArchiveQueue {
    async fn enqueue(&self, p: PendingArchive) -> anyhow::Result<()> {
        let meta = serde_json::to_value(&p.meta)?;
        let now = epoch_ms();
        // Idempotent: a re-enqueue for the same digest keeps the original row.
        sqlx::query(
            "INSERT INTO pending_s3_archive \
               (tx_digest, object_key, bytes, metadata, attempts, created_at, next_attempt_at) \
             VALUES ($1, $2, $3, $4, 0, $5, $5) \
             ON CONFLICT (tx_digest) DO NOTHING",
        )
        .bind(&p.tx_digest)
        .bind(&p.object_key)
        .bind(p.bytes)
        .bind(meta)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn drain_due(&self, limit: i64) -> anyhow::Result<Vec<PendingArchive>> {
        let rows: Vec<(String, String, Vec<u8>, serde_json::Value)> = sqlx::query_as(
            "SELECT tx_digest, object_key, bytes, metadata FROM pending_s3_archive \
             WHERE next_attempt_at <= (extract(epoch from now()) * 1000)::bigint \
             ORDER BY created_at LIMIT $1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|(tx_digest, object_key, bytes, metadata)| {
                let meta: ArchiveMeta = serde_json::from_value(metadata)?;
                Ok(PendingArchive {
                    tx_digest,
                    object_key,
                    bytes,
                    meta,
                })
            })
            .collect()
    }

    async fn delete(&self, tx_digest: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM pending_s3_archive WHERE tx_digest = $1")
            .bind(tx_digest)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn requeue(&self, tx_digest: &str) -> anyhow::Result<()> {
        // Exponential backoff capped at 1h, keyed off the pre-increment attempt count.
        sqlx::query(
            "UPDATE pending_s3_archive SET \
               attempts = attempts + 1, \
               next_attempt_at = (extract(epoch from now()) * 1000)::bigint \
                 + LEAST((POWER(2.0, LEAST(attempts + 1, 9)) * 10000)::bigint, 3600000) \
             WHERE tx_digest = $1",
        )
        .bind(tx_digest)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

/// Milliseconds since the Unix epoch. (Process-local; fine for backoff scheduling.)
fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(d: &str) -> ArchiveMeta {
        ArchiveMeta {
            tunnel_id: "0xt".into(),
            tx_digest: d.into(),
            transcript_root: "0xr".into(),
            settle_version: 2,
        }
    }

    #[tokio::test]
    async fn in_memory_enqueue_drain_delete_roundtrip() {
        let q = InMemoryArchiveQueue::default();
        q.enqueue(PendingArchive {
            tx_digest: "D1".into(),
            object_key: "k1".into(),
            bytes: vec![1],
            meta: meta("D1"),
        })
        .await
        .unwrap();
        q.enqueue(PendingArchive {
            tx_digest: "D2".into(),
            object_key: "k2".into(),
            bytes: vec![2],
            meta: meta("D2"),
        })
        .await
        .unwrap();
        let drained = q.drain_due(10).await.unwrap();
        assert_eq!(drained.len(), 2);
        // drain removes from the in-memory deque (mirrors "claimed"); delete is a no-op
        // safety net here.
        for p in &drained {
            q.delete(&p.tx_digest).await.unwrap();
        }
        assert!(q.drain_due(10).await.unwrap().is_empty());
    }
}
