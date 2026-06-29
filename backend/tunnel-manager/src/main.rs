//! tunnel-manager — Dopamint Arena control-plane backend (DOP-170).
//! Off the per-move path (ADR-0001): registry + settlement + Walrus + stats only.

mod chat_store;
mod config;
mod enoki;
mod error;
mod mp;
mod ollama;
mod routes;
mod state;
mod stats;
mod stats_counter;
mod store;
mod sui;
mod walrus;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;
use tokio::sync::broadcast;
use tower::limit::GlobalConcurrencyLimitLayer;
use tower::ServiceBuilder;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::config::Config;
use crate::state::{AppState, SharedState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=debug".into()),
        )
        .init();

    let config = Config::from_env()?;
    let bind_addr = config.bind_addr.clone();

    let settler = sui::SuiSettler::new(
        Config::require("SUI_RPC_URL", &config.sui_rpc_url)?.to_string(),
        Config::require("TUNNEL_PACKAGE_ID", &config.package_id)?,
        &config.coin_type,
        config.agent_allowance_package_id.as_deref(),
        config.streaming_payment_package_id.as_deref(),
        Config::require("SUI_SETTLER_KEY", &config.settler_key)?,
    )?;
    // Enoki is the primary gas sponsor when configured; the settler above is the fallback (ADR-0014).
    // The settler's close/fallback path pins a hard-coded testnet genesis digest (`sui.rs`), so guard
    // against a mainnet-Enoki / testnet-settler split-brain until that digest is config-driven.
    let enoki = match config.enoki_api_key.clone() {
        Some(key) => {
            anyhow::ensure!(
                config.sui_network == "testnet",
                "SUI_NETWORK must be 'testnet' (the settler fallback's chain digest is testnet-pinned); got {}",
                config.sui_network
            );
            tracing::info!(network = %config.sui_network, "enoki sponsor enabled (settler is the fallback)");
            Some(enoki::EnokiClient::new(
                key,
                config.sui_network.clone(),
                enoki::ENOKI_BASE_URL,
            )?)
        }
        None => {
            tracing::info!("enoki not configured; using settler-only gas sponsorship");
            None
        }
    };
    let walrus = walrus::WalrusClient::new(
        Config::require("WALRUS_PUBLISHER_URL", &config.walrus_publisher_url)?.to_string(),
        Config::require("WALRUS_AGGREGATOR_URL", &config.walrus_aggregator_url)?.to_string(),
    );
    let ollama = crate::ollama::OllamaClient::new(
        config
            .ollama_url
            .clone()
            .unwrap_or_else(|| "http://localhost:11434".into()),
        config
            .ollama_model
            .clone()
            .unwrap_or_else(|| "qwen2.5:1.5b".into()),
    )?;

    let instance_id = config
        .instance_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let (stats_tx, _) = broadcast::channel::<String>(16);

    let (control, mp, bus): (
        Arc<dyn store::ControlStore>,
        Arc<dyn store::MpStore>,
        Arc<dyn store::Bus>,
    ) = if let Some(cache_url) = config.redis_cache_url.clone() {
        let pubsub_url = Config::require("REDIS_PUBSUB_URL", &config.redis_pubsub_url)?.to_string();
        let cache = store::redis::connect(&cache_url).await?;
        let pubsub = store::redis::connect(&pubsub_url).await?;
        (
            Arc::new(store::redis::RedisControlStore::new(cache.clone())),
            Arc::new(store::redis::RedisMpStore::new(cache)),
            Arc::new(store::redis::RedisBus::new(instance_id.clone(), pubsub).await?),
        )
    } else {
        (
            Arc::new(store::memory::InMemoryControlStore::default()),
            Arc::new(store::memory::InMemoryMpStore::default()),
            Arc::new(store::memory::LocalBus::new(instance_id.clone())),
        )
    };

    let pair_hold_ms = std::env::var("MP_PAIR_HOLD_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(750);
    let state: SharedState = Arc::new(AppState {
        control,
        mp,
        bus,
        settler,
        enoki,
        walrus,
        ollama,
        stats_tx,
        actions: crate::stats_counter::LocalActionCounter::default(),
        pair_hold_ms,
        pairing: crate::stats_counter::MatchPairingMetrics::default(),
        chat: crate::chat_store::ChatTranscriptStore::new(),
    });
    stats::spawn_stats_broadcaster(state.clone());
    spawn_action_flusher(state.clone());
    // Poll-index on-chain tunnel events (Created/Activated/Closed) into recent_events so the
    // live feed reflects real settlements; without this the stats SSE never emits any.
    sui::spawn_event_indexer(state.clone());

    // Clone before `state` is consumed by `.with_state` so we can flush after shutdown.
    let flush_state = state.clone();
    let app = Router::new()
        .route("/healthz", get(routes::health))
        .route("/health/live", get(routes::live))
        .route("/health/ready", get(routes::ready))
        .route("/metrics", get(routes::metrics))
        .route("/v1/sessions", post(routes::register_session))
        .route("/v1/sessions/:id/heartbeat", post(routes::heartbeat))
        // Settlement carries the off-chain transcript as a v2 binary body (one fixed ~248 B entry
        // per co-signed move), archived to Walrus verbatim. Maximizing moves/tunnel amortizes the
        // on-chain close and Walrus per-blob cost, so a long self-play game ships tens of thousands
        // of moves. 16 MB for /settle only (≈67k moves) caps tunnel length; the body is raw bytes,
        // so it stays ~1× in memory (the canonical MAX_MOVES_PER_TUNNEL=50k sits well inside this).
        .route(
            "/v1/tunnels/:tunnel_id/settle",
            // One ServiceBuilder (not two chained `.layer()`s, which leaves axum's error type
            // ambiguous). First-added layer is outermost: the concurrency limit gates BEFORE the
            // body is read, so worst-case memory is (limit × body cap), not (in-flight × cap).
            post(routes::settle).layer(
                ServiceBuilder::new()
                    .layer(GlobalConcurrencyLimitLayer::new(
                        config.settle_max_concurrency,
                    ))
                    .layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
            ),
        )
        .route("/v1/sponsor", post(routes::sponsor))
        .route("/v1/sessions/:session_id/chat", post(routes::chat))
        .route("/v1/sessions/:session_id/chat/topic", get(routes::chat_topic))
        .route("/v1/chat/live/publish", post(routes::chat_publish))
        .route("/v1/chat/live", get(routes::chat_live))
        .route("/v1/stats/live", get(routes::stats_live))
        .route("/v1/sponsor/execute", post(routes::sponsor_execute))
        .route("/v1/mp", get(crate::mp::ws::mp_upgrade))
        .layer(TraceLayer::new_for_http())
        .layer(cors_layer())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!(%bind_addr, "tunnel-manager listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    // Graceful shutdown completed: push the last sub-second of counted moves so a clean
    // rollout doesn't drop them (the 1 Hz flusher is gone with the runtime by now).
    flush_actions(&flush_state).await;
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

/// Drain the per-instance move counter into ControlStore once. At-most-once by design: the
/// watermark advances at drain time, so a failed push loses ≤1 interval of display counts and
/// never double-counts. Used both by the 1 Hz flusher and the shutdown drain.
async fn flush_actions(state: &SharedState) {
    for (game, delta) in state.actions.drain_deltas() {
        state.control.add_actions(&game, delta).await;
    }
}

/// Drain the per-instance move counter into ControlStore once per second (no Redis round trip
/// per move). Lossy-by-design on crash: ≤1s of display counts.
fn spawn_action_flusher(state: SharedState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tick.tick().await;
            flush_actions(&state).await;
        }
    });
}

/// Resolve on SIGINT (Ctrl-C) or SIGTERM so the orchestrator can roll the service cleanly.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
    tracing::info!("shutdown signal received; draining");
}

#[cfg(test)]
mod flush_tests {
    use super::*;

    #[tokio::test]
    async fn flush_actions_drains_counter_into_control_store() {
        let state = crate::state::AppState::in_memory_for_test();
        state.actions.incr("ttt", 3);
        state.actions.incr("ttt", 2);
        flush_actions(&state).await;
        assert_eq!(
            state.control.snapshot().await.per_game["ttt"].total_actions,
            5
        );
        // Nothing new since the last drain → a second flush adds nothing.
        flush_actions(&state).await;
        assert_eq!(
            state.control.snapshot().await.per_game["ttt"].total_actions,
            5
        );
    }
}
