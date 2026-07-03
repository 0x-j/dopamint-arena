//! Read-only explorer API service (deploy autoscaled). Serves the SettlementStore over HTTP
//! and fans out live rows from Redis `explorer:events` as SSE. Verification is client-side.

use std::convert::Infallible;
use std::sync::Arc;

use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use fred::prelude::*;
use futures::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::cors::{Any, CorsLayer};

use explorer::api::{router, ApiState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Pin one rustls CryptoProvider (ring) as the process default BEFORE any TLS. Building the S3
    // client (S3TranscriptStore::from_env, once S3_TRANSCRIPTS_BUCKET is set) pulls aws-lc-rs into
    // the graph alongside ring; without this, rustls 0.23 can't auto-select a provider and panics at
    // startup (the S3-enabled task crash-loops on exit 101). Mirrors tunnel-manager + indexer.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")?;
    let store = Arc::new(shared::postgres::PgSettlementStore::connect(&database_url).await?);
    // One S3 store, two read views: streamed chunks and the one-object settle archive (it
    // implements both traits). Same bucket/prefix the tunnel-manager writes to (S3_TRANSCRIPTS_BUCKET
    // / S3_TRANSCRIPTS_PREFIX). Unset -> None -> /transcript serves only the legacy Walrus blob, so
    // the explorer runs unchanged where S3 isn't configured.
    let s3 = match transcript_store::S3TranscriptStore::from_env().await {
        Ok(store) => Some(Arc::new(store)),
        Err(e) => {
            tracing::info!("s3 transcript reader disabled: {e}");
            None
        }
    };
    let chunks = s3
        .clone()
        .map(|s| s as Arc<dyn transcript_store::TranscriptChunkReader>);
    let archive = s3.map(|s| s as Arc<dyn transcript_store::TranscriptReader>);
    let state = ApiState {
        store,
        walrus_aggregator_url: std::env::var("WALRUS_AGGREGATOR_URL")
            .unwrap_or_else(|_| "https://aggregator.walrus-testnet.walrus.space".into()),
        http: reqwest::Client::new(),
        chunks,
        archive,
    };

    // Bridge Redis pub/sub -> a broadcast channel the SSE handler subscribes to.
    // `SubscriberClient` (not the base `Client`) owns the message stream.
    // `_rx` is held here intentionally: without at least one receiver the channel reports
    // zero receivers and the first `tx.send` would silently fail before any SSE client connects.
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(256);
    if let Ok(url) = std::env::var("REDIS_PUBSUB_URL") {
        let sub = Builder::from_config(RedisConfig::from_url(&url)?).build_subscriber_client()?;
        sub.init().await?;
        sub.subscribe("explorer:events").await?;
        let mut messages = sub.message_rx();
        let tx2 = tx.clone();
        tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            loop {
                match messages.recv().await {
                    Ok(msg) => {
                        if let Some(s) = msg.value.as_string() {
                            let _ = tx2.send(s);
                        }
                    }
                    // Transient lag is NOT end-of-stream: skip the dropped window and keep bridging.
                    // (The bare `while let Ok` this replaces exited here, silencing the feed forever.)
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!(
                            skipped = n,
                            "explorer:events message_rx lagged; live rows dropped"
                        );
                    }
                    Err(RecvError::Closed) => break,
                }
            }
            tracing::warn!(
                "Redis explorer:events subscription closed; SSE live feed silent until restart"
            );
        });
    }

    // Live-stats deriver (ADR: read-time derivation). Once a second, derive ONE coherent frame from
    // the deduped `metric_bucket` counter series — the same source `/v1/stats/history` reads — and
    // fan it out to `/v1/stats/live`. `derive_live_frame` is a pure function of the shared rows, so
    // every explorer-api replica computes the identical value: no per-instance windows, no
    // interleaving (the flicker this replaces). `_stats_rx` is held so the channel keeps ≥1 receiver
    // (same reason as `_rx` above).
    let (stats_tx, _stats_rx) = tokio::sync::broadcast::channel::<String>(256);
    {
        let store = state.store.clone();
        let tx = stats_tx.clone();
        tokio::spawn(async move {
            // Current TPS is the counter slope over a WIDE trailing window. It must be wide because
            // `metric_bucket` is sparse: the fleet's snapshot publishes land only ~every 2-3s (gaps
            // up to ~13s observed), so a short 5s window held ~2 points — and a single one of those
            // being a laggy/out-of-order read (the per-second GREATEST collapse only orders WITHIN a
            // second, not across seconds) drove the slope to 0, i.e. the 1-2M↔0 flicker. Over 30s the
            // window holds ~10 points and ~30s of real growth dwarfs any single ~2M cross-second dip,
            // so the number stays a stable trailing rate. Verified on 641 real rows: 27 spurious 0s at
            // 5s → 0 at 30s. PEAK is separate and stays 1s-resolution (bursts still show there),
            // maintained durably via bump_peak_tps (GREATEST). FETCH a touch beyond the window so the
            // oldest in-window bucket is always fetched despite gaps.
            const WINDOW_SECS: i64 = 30;
            const FETCH_SECS: i64 = 36;
            const GAP_MAX_SECS: i64 = 10;
            let unix_secs = || {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0)
            };
            // Seed the durable peak from the last 24h of history so a fresh deploy shows the true
            // peak immediately instead of climbing from 0 (best-effort).
            let seed_now = unix_secs();
            if let Ok(hist) = store.metric_history(seed_now - 86_400, seed_now, 1).await {
                let _ = store
                    .bump_peak_tps(explorer::api::peak_1s_rate(&hist, GAP_MAX_SECS))
                    .await;
            }
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                ticker.tick().await;
                let now = unix_secs();
                let rows = match store.metric_recent(now - FETCH_SECS).await {
                    Ok(rows) => rows,
                    Err(e) => {
                        tracing::warn!(error = %e, "live-stats metric_recent failed");
                        continue;
                    }
                };
                // Fold the sharpest recent 1s-rate into the durable all-time peak; the returned value
                // is coherent across replicas (GREATEST) and is what the frame reports.
                let series: Vec<(i64, i64)> = rows.iter().map(|&(t, v, _, _)| (t, v)).collect();
                let peak = store
                    .bump_peak_tps(explorer::api::peak_1s_rate(&series, GAP_MAX_SECS))
                    .await
                    .unwrap_or(0.0);
                // None ⇒ no fresh rows (indexer stalled / cold start) ⇒ hold the last frame.
                if let Some(frame) = explorer::api::derive_live_frame(&rows, WINDOW_SECS, peak) {
                    if let Ok(json) = serde_json::to_string(&frame) {
                        let _ = tx.send(json);
                    }
                }
            }
        });
    }

    let sse_tx = tx.clone();
    let stats_sse_tx = stats_tx.clone();
    let app = router(state)
        .route(
            "/v1/explorer/stream",
            get(move || {
                let rx = sse_tx.subscribe();
                async move {
                    let stream = BroadcastStream::new(rx).filter_map(|m| async move {
                        m.ok()
                            .map(|json| Ok::<_, Infallible>(Event::default().data(json)))
                    });
                    Sse::new(stream).keep_alive(KeepAlive::default())
                }
            }),
        )
        .route(
            "/v1/stats/live",
            get(move || {
                let rx = stats_sse_tx.subscribe();
                async move {
                    let stream = BroadcastStream::new(rx).filter_map(|m| async move {
                        m.ok()
                            .map(|json| Ok::<_, Infallible>(Event::default().data(json)))
                    });
                    Sse::new(stream).keep_alive(KeepAlive::default())
                }
            }),
        )
        .layer(cors_layer());

    let addr = std::env::var("EXPLORER_API_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "explorer-api listening");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Build a CORS layer from `CORS_ALLOWED_ORIGINS`. When the env var is set, only the listed
/// comma-separated origins are allowed; otherwise the layer remains permissive for local dev.
fn cors_layer() -> CorsLayer {
    match std::env::var("CORS_ALLOWED_ORIGINS") {
        Ok(origins) if !origins.is_empty() => {
            let origins: Vec<http::HeaderValue> = origins
                .split(',')
                .map(|s| {
                    s.trim()
                        .parse()
                        .expect("invalid CORS_ALLOWED_ORIGINS value")
                })
                .collect();
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods(Any)
                .allow_headers(Any)
        }
        _ => CorsLayer::permissive(),
    }
}
