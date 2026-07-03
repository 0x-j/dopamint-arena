//! The framework indexer binary: wires the `SettlementPipeline` into a `sui-indexer-alt-framework`
//! `IndexerCluster` (Diesel/Postgres). The framework owns ingestion, watermarks, batching, and
//! shutdown; this binary just configures the cluster and registers the one pipeline.
//!
//! Ingestion source + checkpoint range come from CLI flags parsed into `cluster::Args`
//! (e.g. `--remote-store-url`). Connection + package id come from the environment.
use clap::Parser;
use diesel::sql_types::{Array, Nullable, Text};
use diesel_async::pooled_connection::bb8::Pool;
use diesel_async::pooled_connection::AsyncDieselConnectionManager;
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use explorer::handler::{SettlementPipeline, PENDING_PROOF_DRAIN_SQL, PENDING_PROOF_UPSERT_SQL};
use fred::prelude::*;
use move_core_types::account_address::AccountAddress;
use sui_indexer_alt_framework::cluster::{Args, IndexerCluster};
use sui_indexer_alt_framework::pipeline::concurrent::ConcurrentConfig;

/// Wire shape published by the control plane on `explorer:proofs`. Camel-case to match the
/// /settle path; only the digest + the two proof fields are relevant here.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProofLink {
    tx_digest: Option<String>,
    walrus_blob_id: Option<String>,
    proof_url: Option<String>,
}

/// Subset of the `StatsSnapshot` JSON tunnel-manager publishes on `stats:snapshot`. Camel-case
/// to match the snapshot wire shape; these three counters serialize as plain numbers (not the
/// JS-safe decimal strings used for balances/nonce), so `i64` parses directly.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsSample {
    total_actions: i64,
    active_tunnels: i64,
    settled_tunnels: i64,
}

const METRIC_RETENTION_SECS: i64 = 30 * 24 * 3600;
// The N fleet instances each publish a snapshot per tick; their `total_actions` and
// `settled_tunnels` are lagging, phase-offset observations of the same monotonic global
// counters. Last-write-wins stored whichever message *arrived* last (arrival order != read
// order), so the per-second series jumped backwards and the derived live TPS clamped to 0
// (`current_tps` floors negative deltas). GREATEST keeps each cumulative counter
// non-decreasing — and since every observation is <= the true count, `max` is also the
// least-lagged/least-torn estimate. `active_tunnels` is a concurrency gauge (opens and
// closes), so it stays last-write-wins; GREATEST would wrongly pin it to all-time-max.
const METRIC_UPSERT_SQL: &str = "INSERT INTO metric_bucket \
    (ts_bucket, total_actions, active_tunnels, settled_tunnels) VALUES ($1,$2,$3,$4) \
    ON CONFLICT (ts_bucket) DO UPDATE SET \
    total_actions=GREATEST(metric_bucket.total_actions, EXCLUDED.total_actions), \
    active_tunnels=EXCLUDED.active_tunnels, \
    settled_tunnels=GREATEST(metric_bucket.settled_tunnels, EXCLUDED.settled_tunnels)";
const METRIC_RETENTION_SQL: &str = "DELETE FROM metric_bucket WHERE ts_bucket < $1";

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Pin one rustls CryptoProvider (ring) as the process default BEFORE any TLS. The framework's
    // ingestion client fetches checkpoints over HTTPS; with both aws-lc-rs and ring in the graph,
    // rustls 0.23 cannot auto-select a provider and panics on the first handshake (crash-loop that
    // froze the watermark). Mirrors tunnel-manager/main.rs.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _ = dotenvy::dotenv();
    // Do NOT install a tracing subscriber here: `IndexerCluster::build()` installs the framework's
    // own global subscriber (telemetry/metrics), and a second `.init()` panics on boot with
    // "a global default trace dispatcher has already been set". The framework's subscriber honors
    // RUST_LOG. (The `api` binary, which does not use the framework, keeps its own init.)
    let args = Args::parse();
    let package = AccountAddress::from_hex_literal(&std::env::var("TUNNEL_PACKAGE_ID")?)
        .map_err(|e| anyhow::anyhow!("invalid TUNNEL_PACKAGE_ID: {e}"))?;
    let database_url_str = std::env::var("DATABASE_URL")?;
    let database_url: url::Url = database_url_str.parse()?;

    let mut cluster = IndexerCluster::builder()
        .with_database_url(database_url)
        .with_args(args)
        .with_migrations(&MIGRATIONS)
        .build()
        .await?;

    cluster
        .concurrent_pipeline(SettlementPipeline { package }, ConcurrentConfig::default())
        .await?;

    // Redis wiring is additive and best-effort: gated entirely on REDIS_PUBSUB_URL so the indexer
    // still runs against chain-only ingestion without Redis. A bad URL or failed connect is logged
    // and skipped (warn-and-continue) — it never aborts the pipeline. Same posture as EXPLORER_*.
    if let Ok(redis_url) = std::env::var("REDIS_PUBSUB_URL") {
        if let Err(e) = wire_redis(&redis_url, &database_url_str).await {
            tracing::warn!(error = %e, "Redis explorer wiring failed; live feed + proof links disabled");
        }
    }

    // Framework owns watermarks + graceful shutdown; we just wait for the service to finish. The
    // proof subscriber task (spawned in `wire_redis`) runs concurrently for the process lifetime.
    cluster.run().await?.join().await?;
    Ok(())
}

/// Install the live-feed publisher and spawn the proof-link subscriber. Best-effort: any failure
/// here is reported by the caller and never aborts the indexer.
///
/// Two independent Redis roles:
/// - publisher (`RedisClient`): handed to `handler::init_events_publisher` so `commit` can push new
///   settlements to `explorer:events`.
/// - subscriber (`SubscriberClient`): regular `SUBSCRIBE explorer:proofs` (NOT sharded). The
///   control plane PUBLISHes `{txDigest, walrusBlobId, proofUrl}` here when it persists a Walrus
///   proof; we back-fill it onto the chain-sourced row.
async fn wire_redis(redis_url: &str, database_url_str: &str) -> anyhow::Result<()> {
    // Live-feed publisher (Part A): a plain client, init'd, installed into the process global.
    let publisher = Builder::from_config(RedisConfig::from_url(redis_url)?).build()?;
    publisher.init().await?;
    explorer::handler::init_events_publisher(publisher);

    // A standalone diesel-async pool for the proof UPDATEs, separate from the framework's internal
    // pool (the framework's `Connection` is only reachable inside `commit`). Same DATABASE_URL.
    let mgr = AsyncDieselConnectionManager::<AsyncPgConnection>::new(database_url_str);
    let pool: Pool<AsyncPgConnection> = Pool::builder().build(mgr).await?;
    // Clone before the proofs task moves `pool`, so the stats-sample task can own its own handle.
    let stats_pool = pool.clone();

    let subscriber =
        Builder::from_config(RedisConfig::from_url(redis_url)?).build_subscriber_client()?;
    subscriber.init().await?;
    subscriber.subscribe("explorer:proofs").await?;
    let mut messages = subscriber.message_rx();

    // Lives for the process: drains proof links concurrently with `cluster.run()`.
    tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        // Keep the subscriber owned by the task so its connection stays alive for the message_rx.
        let _subscriber = subscriber;
        loop {
            let msg = match messages.recv().await {
                Ok(msg) => msg,
                // A transient lag is NOT end-of-stream: skip the dropped window and keep draining.
                // (The bare `while let Ok` this replaces exited here, silencing proofs until restart.)
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!(
                        skipped = n,
                        "explorer:proofs message_rx lagged; proof links dropped"
                    );
                    continue;
                }
                Err(RecvError::Closed) => break,
            };
            let Some(payload) = msg.value.as_string() else {
                continue;
            };
            let link: ProofLink = match serde_json::from_str(&payload) {
                Ok(link) => link,
                Err(e) => {
                    tracing::warn!(error = %e, "explorer:proofs payload not parseable; skipping");
                    continue;
                }
            };
            // Need a digest, and at least one proof field worth recording.
            let Some(digest) = link.tx_digest else {
                continue;
            };
            if link.proof_url.is_none() && link.walrus_blob_id.is_none() {
                continue;
            }
            let mut conn = match pool.get().await {
                Ok(conn) => conn,
                Err(e) => {
                    tracing::warn!(error = %e, "explorer proof pool exhausted; skipping link");
                    continue;
                }
            };
            // Record the proof durably FIRST, then drain it onto the settlement row — which usually
            // does NOT exist yet (the proof beats the chain-ingested close row). The indexer commit
            // runs the SAME drain after it writes a row, so the link attaches in either arrival
            // order. Best-effort: log and keep draining on error.
            if let Err(e) = diesel::sql_query(PENDING_PROOF_UPSERT_SQL)
                .bind::<Text, _>(digest.clone())
                .bind::<Nullable<Text>, _>(link.proof_url)
                .bind::<Nullable<Text>, _>(link.walrus_blob_id)
                .execute(&mut conn)
                .await
            {
                tracing::warn!(error = %e, %digest, "explorer pending_proof upsert failed");
                continue;
            }
            if let Err(e) = diesel::sql_query(PENDING_PROOF_DRAIN_SQL)
                .bind::<Array<Text>, _>(vec![digest.clone()])
                .execute(&mut conn)
                .await
            {
                tracing::warn!(error = %e, %digest, "explorer proof drain failed");
            }
        }
        tracing::warn!("explorer:proofs subscription closed; proof links disabled until restart");
    });

    // TPS time-series subscriber: tunnel-manager publishes the full snapshot on `stats:snapshot`
    // each tick; we upsert one row per epoch-second (PK dedup collapses the N near-identical
    // publishes per second into one row) and roll off rows past the retention window.
    let stats_sub =
        Builder::from_config(RedisConfig::from_url(redis_url)?).build_subscriber_client()?;
    stats_sub.init().await?;
    stats_sub.subscribe("stats:snapshot").await?;
    let mut stats_msgs = stats_sub.message_rx();
    tokio::spawn(async move {
        use diesel::sql_types::BigInt;
        use tokio::sync::broadcast::error::RecvError;
        // Keep the subscriber owned by the task so its connection stays alive for message_rx.
        let _stats_sub = stats_sub;
        loop {
            let msg = match stats_msgs.recv().await {
                Ok(m) => m,
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!(
                        skipped = n,
                        "stats:snapshot message_rx lagged; samples dropped"
                    );
                    continue;
                }
                Err(RecvError::Closed) => break,
            };
            let Some(payload) = msg.value.as_string() else {
                continue;
            };
            let Ok(s) = serde_json::from_str::<StatsSample>(&payload) else {
                continue;
            };
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;
            let mut conn = match stats_pool.get().await {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "stats sample pool exhausted; skipping");
                    continue;
                }
            };
            let _ = diesel::sql_query(METRIC_UPSERT_SQL)
                .bind::<BigInt, _>(ts)
                .bind::<BigInt, _>(s.total_actions)
                .bind::<BigInt, _>(s.active_tunnels)
                .bind::<BigInt, _>(s.settled_tunnels)
                .execute(&mut conn)
                .await;
            let _ = diesel::sql_query(METRIC_RETENTION_SQL)
                .bind::<BigInt, _>(ts - METRIC_RETENTION_SECS)
                .execute(&mut conn)
                .await;
        }
        tracing::warn!("stats:snapshot subscription closed; tps samples disabled until restart");
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::METRIC_UPSERT_SQL;
    use diesel::sql_types::BigInt;
    use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};

    #[derive(diesel::QueryableByName)]
    struct MetricRow {
        #[diesel(sql_type = BigInt)]
        total_actions: i64,
        #[diesel(sql_type = BigInt)]
        settled_tunnels: i64,
    }

    // A stale, phase-offset fleet publish (lower cumulative counters, but arriving last) must
    // NOT lower a bucket-second a fresher publish already raised — last-write-wins let it, and
    // the derived live TPS then clamped to 0. GREATEST makes the per-second collapse monotonic.
    #[tokio::test]
    async fn metric_upsert_collapses_monotonically_not_last_write_wins() {
        let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
            return; // gated: needs a Postgres
        };
        let mut conn = AsyncPgConnection::establish(&url).await.unwrap();
        diesel::sql_query(
            "CREATE TABLE IF NOT EXISTS metric_bucket (ts_bucket BIGINT PRIMARY KEY, \
             total_actions BIGINT NOT NULL, active_tunnels BIGINT NOT NULL, \
             settled_tunnels BIGINT NOT NULL)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        // A ts_bucket far outside the live/retention range so we never touch real rows.
        let ts: i64 = -424242;
        diesel::sql_query("DELETE FROM metric_bucket WHERE ts_bucket = $1")
            .bind::<BigInt, _>(ts)
            .execute(&mut conn)
            .await
            .unwrap();

        let upsert = |total: i64, settled: i64| {
            diesel::sql_query(METRIC_UPSERT_SQL)
                .bind::<BigInt, _>(ts)
                .bind::<BigInt, _>(total)
                .bind::<BigInt, _>(99) // active_tunnels is a gauge: last-write-wins is correct
                .bind::<BigInt, _>(settled)
        };
        // The fresh, higher publishes land first; the stale, lower one arrives LAST — the exact
        // order last-write-wins would mishandle (it would store 600/20). GREATEST must keep 1400/70.
        upsert(1000, 50).execute(&mut conn).await.unwrap();
        upsert(1400, 70).execute(&mut conn).await.unwrap();
        upsert(600, 20).execute(&mut conn).await.unwrap(); // stale publish arriving last

        let row: MetricRow = diesel::sql_query(
            "SELECT total_actions, settled_tunnels FROM metric_bucket WHERE ts_bucket = $1",
        )
        .bind::<BigInt, _>(ts)
        .get_result(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            row.total_actions, 1400,
            "cumulative total must not step back"
        );
        assert_eq!(row.settled_tunnels, 70, "settled count must not step back");
    }
}
