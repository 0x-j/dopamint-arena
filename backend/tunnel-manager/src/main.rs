//! tunnel-manager — Dopamint Arena control-plane backend (DOP-170).
//! Off the per-move path (ADR-0001): registry + settlement + Walrus + stats only.

mod auth;
mod chat_store;
mod config;
mod enoki;
mod error;
mod flash_loop;
mod flash_responder;
mod flash_store;
mod fleet;
mod mp;
mod ollama;
mod routes;
mod s3;
mod settle_batch;
mod settle_queue;
mod settle_worker;
mod state;
mod stats;
mod stats_counter;
mod store;
mod sui;
mod sui_rpc;
mod wallet;
mod walrus;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;
use base64::Engine;
use bech32::ToBase32;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::config::Config;
use crate::state::{AppState, SharedState};

/// Convert the base64 Ed25519 seed stored in `SUI_SETTLER_KEY` into a bech32
/// Sui private key (`suiprivkey1...`) that `sui-tunnel-anchor` accepts.
fn base64_seed_to_sui_bech32(base64_seed: &str) -> anyhow::Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64_seed)?;
    if bytes.len() != 32 {
        anyhow::bail!("settler key seed must be 32 bytes, got {}", bytes.len());
    }
    // Sui bech32 private key: 1 scheme flag byte (0x00 = Ed25519) + 32 secret bytes.
    let mut key = vec![0u8; 33];
    key[1..].copy_from_slice(&bytes);
    Ok(bech32::encode(
        "suiprivkey",
        key.to_base32(),
        bech32::Variant::Bech32,
    )?)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Pin a single rustls CryptoProvider (ring) as the process default BEFORE any TLS
    // client (fred, reqwest, aws-sdk-s3) initializes. aws-sdk-s3 compiles aws-lc
    // (hence cmake in the Dockerfile) but at runtime every rustls user shares this one
    // provider, avoiding the rustls 0.23 "two default providers" panic. See Cargo.toml
    // TLS-provider note + ADR-0023.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=debug".into()),
        )
        .init();

    let config = Config::from_env()?;
    let bind_addr = config.bind_addr.clone();

    // One governed RPC client for all fullnode traffic (settler + arena opener): a single
    // process-wide throttle + retry/backoff against the one rate-limited node. The settler is shared
    // via Arc so the opener can have it sponsor each bot open's gas (ADR-0028) and the settle-worker
    // pool can hold it as a BatchSettler — one settler (one `sponsor_nonce`) behind opens, faucet,
    // `/settle`, and user sponsors.
    let governed_rpc = sui_rpc::GovernedRpc::new(
        Config::require("SUI_RPC_URL", &config.sui_rpc_url)?.to_string(),
        config.rpc_limits(),
    );
    let settler = Arc::new(sui::SuiSettler::new(
        governed_rpc.clone(),
        Config::require("TUNNEL_PACKAGE_ID", &config.package_id)?,
        &config.coin_type,
        config.agent_allowance_package_id.as_deref(),
        config.streaming_payment_package_id.as_deref(),
        Config::require("SUI_SETTLER_KEY", &config.settler_key)?,
        config.mtps_admin_cap_id.as_deref(),
    )?);
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
    // Identity verification for the B5 auth gate uses a SEPARATE Enoki key with the zkLogin feature
    // (`ENOKI_ZKLOGIN_API_KEY`) — a different Enoki feature than sponsorship — so verifying a user's
    // zkLogin id_token never forces Enoki to sponsor gas. Independent of `enoki` above: either, both,
    // or neither may be set. No network guard: `verify_zklogin` doesn't touch the settler's pinned
    // chain digest (it only resolves an address), so a network mismatch can't cause a split-brain.
    let enoki_zklogin = match config.enoki_zklogin_api_key.clone() {
        Some(key) => {
            tracing::info!("enoki zklogin identity verification enabled");
            Some(enoki::EnokiClient::new(
                key,
                config.sui_network.clone(),
                enoki::ENOKI_BASE_URL,
            )?)
        }
        None => {
            tracing::info!("enoki zklogin key not configured; arena session auth cannot mint");
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

    // S3 transcript archival (ADR-0023). Optional: absent in dev/test when
    // S3_TRANSCRIPTS_BUCKET is unset. Concurrent with Walrus; Walrus above is unchanged.
    let archiver: Option<std::sync::Arc<dyn crate::s3::TranscriptArchiver>> =
        match config.s3_bucket.clone() {
            Some(bucket) => {
                let aws_cfg = aws_config::defaults(aws_config::BehaviorVersion::latest())
                    .load()
                    .await;
                let client = aws_sdk_s3::Client::new(&aws_cfg);
                tracing::info!(bucket = %bucket, "s3 transcript archival enabled");
                Some(std::sync::Arc::new(crate::s3::S3Archiver::new(
                    client, bucket,
                )))
            }
            None => {
                tracing::info!("s3 transcript archival disabled (S3_TRANSCRIPTS_BUCKET unset)");
                None
            }
        };

    // Streaming transcript chunk writer (same bucket as `archiver`): the bot streams the co-signed
    // transcript to S3 in chunks *during play*. `chunk_writer` seals the manifest at `finish()`;
    // `chunk_upload_tx` feeds the per-instance bounded uploader (byte-budget backpressure). Both
    // `None` when S3 is unconfigured.
    let chunk_writer: Option<std::sync::Arc<dyn transcript_store::TranscriptChunkWriter>> =
        match config.s3_bucket.clone() {
            Some(bucket) => {
                let aws_cfg = aws_config::defaults(aws_config::BehaviorVersion::latest())
                    .load()
                    .await;
                let client = aws_sdk_s3::Client::new(&aws_cfg);
                let prefix = config.s3_prefix.clone().unwrap_or_default();
                Some(std::sync::Arc::new(
                    transcript_store::S3TranscriptStore::new(client, bucket, prefix),
                ))
            }
            None => None,
        };
    // Keep the uploader (not just its sender) so a clean SIGTERM roll can drain its queue before
    // exit: a settled match's early 1 MB chunks pass through here, and dropping them would leave
    // that transcript short. Drained after `serve` returns (below).
    let uploader = chunk_writer
        .clone()
        .map(transcript_stream::TranscriptUploader::spawn);
    let chunk_upload_tx = uploader.as_ref().map(|u| u.sender());

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

    // Funded seat-B wallet pool (PR #124): opened once if WALLET_POOL_ID is set, else None (bots use
    // the placeholder identity, the off-chain/Noop dev path). Same RPC + network as the settler. A
    // failed open (bad S3/passphrase/IAM) must NOT take down the whole backend — only arena opens lose
    // funded seat-B; faucet/settle/stats stay up. Degrade to None (Noop opener) and log loudly.
    let wallet_pool = match crate::wallet::build(
        config.wallet_pool_id.as_deref(),
        config.wallet_pool_access_value.as_deref(),
        config.wallet_pool_funded_count,
        config.sui_rpc_url.as_deref().unwrap_or_default(),
        if config.sui_network == "mainnet" {
            wallet_pool::Network::Mainnet
        } else {
            wallet_pool::Network::Testnet
        },
    )
    .await
    {
        Ok(pool) => pool.map(Arc::new),
        Err(e) => {
            tracing::error!(
                "wallet pool open failed — arena opener falls back to Noop/placeholder: {e:#}"
            );
            None
        }
    };

    // Arena opener (ADR-0028): the real `SuiArenaOpener` — each open self-signs create + fund-seat-B as
    // the checked-out pool member — when the wallet pool + on-chain package/RPC are configured; else
    // `Noop` so the allocate contract + FE deposit path still work for tests/dev without the pool.
    let arena_opener: Arc<dyn crate::fleet::arena_opener::ArenaTunnelOpener> = match (
        &wallet_pool,
        &config.sui_rpc_url,
        &config.package_id,
    ) {
        (Some(pool), Some(rpc), Some(pkg)) => Arc::new(
            crate::fleet::arena_opener::SuiArenaOpener::new(
                rpc.clone(),
                pkg,
                &config.coin_type,
                pool.clone(),
                settler.clone(),
            )
            .map_err(|e| anyhow::anyhow!("arena opener build: {e:#}"))?,
        ),
        _ => {
            tracing::info!(
                    "arena opener: Noop (set WALLET_POOL_ID + SUI_RPC_URL + TUNNEL_PACKAGE_ID for real on-chain opens)"
                );
            Arc::new(crate::fleet::arena_opener::NoopArenaOpener)
        }
    };

    // Durable settle queue (ADR-0029): `/settle` enqueues here and returns 202; the worker pool
    // below drains it into batched PTBs. Redis Streams when a cache cluster is configured (durable,
    // multi-instance), else in-memory (single-instance dev) — same seam, handler unchanged.
    let settle_queue: Arc<dyn settle_queue::SettleQueue> =
        if let Some(cache_url) = config.redis_cache_url.clone() {
            let pool = store::redis::connect(&cache_url).await?;
            Arc::new(
                settle_queue::RedisSettleQueue::new(
                    pool,
                    "settle:queue".to_owned(),
                    "settle-workers".to_owned(),
                    86_400, // body archive TTL (1d): generous retry window for Walrus upload
                )
                .await?,
            )
        } else {
            Arc::new(settle_queue::InMemorySettleQueue::default())
        };

    // On-chain anchor for the flash spectator bot-vs-bot loop. Optional: if the
    // settler key is missing or invalid the loop falls back to in-memory self-play.
    let flash_sui_anchor = match config.settler_key.as_deref() {
        Some(seed) => match base64_seed_to_sui_bech32(seed) {
            Ok(priv_key) => {
                let sui_config = sui_tunnel_anchor::SuiSponsoredAnchorConfig {
                    rpc_url: config.sui_rpc_url.clone().unwrap_or_default(),
                    backend_url: String::new(), // direct open/settle; backend endpoint unused
                    package_id: config.package_id.clone().unwrap_or_default(),
                    tunnel_coin_type: config.coin_type.clone(),
                    open_mode: sui_tunnel_anchor::SuiOpenMode::DirectCreateAndFund,
                    settle_mode: sui_tunnel_anchor::SuiSettleMode::DirectSettle,
                    funding_profile: sui_tunnel_anchor::SuiFundingProfile::SingleFunder {
                        priv_key,
                        stake_source: sui_tunnel_anchor::SuiStakeSource::AddressBalance,
                    },
                    open_batching: sui_tunnel_anchor::SuiOpenBatchingConfig::default(),
                    settle_batching: sui_tunnel_anchor::SuiOpenBatchingConfig::default(),
                };
                match sui_tunnel_anchor::SuiSponsoredAnchor::new(sui_config) {
                    Ok(a) => {
                        tracing::info!("flash spectator on-chain anchor enabled");
                        Some(Arc::new(a))
                    }
                    Err(e) => {
                        tracing::warn!(error = ?e, "flash spectator on-chain anchor disabled");
                        None
                    }
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "flash spectator on-chain anchor disabled: invalid settler key");
                None
            }
        },
        None => {
            tracing::warn!("flash spectator on-chain anchor disabled: SUI_SETTLER_KEY unset");
            None
        }
    };

    let state: SharedState = Arc::new(AppState {
        control,
        mp,
        bus,
        settler,
        settle_queue,
        enoki,
        enoki_zklogin,
        walrus,
        archiver,
        s3_prefix: config.s3_prefix.clone().unwrap_or_default(),
        chunk_writer,
        chunk_upload_tx,
        ollama,
        stats_tx,
        actions: crate::stats_counter::LocalActionCounter::default(),
        pair_hold_ms,
        pairing: crate::stats_counter::MatchPairingMetrics::default(),
        chat: crate::chat_store::ChatTranscriptStore::new(),
        flash: std::sync::Arc::new(crate::flash_store::FlashTranscriptStore::new()),
        flash_sui_anchor: flash_sui_anchor.clone(),
        flash_loop: crate::flash_loop::FlashLoop::new(flash_sui_anchor),
        fleet: crate::fleet::BotPool::default(),
        arena_opener,
        arena_fleet_count: config.colocated_fleet_count,
        arena_fleet_games: config.colocated_fleet_games.iter().cloned().collect(),
        wallet_pool,
        faucet_user_amount: config.faucet_user_amount,
        faucet_internal_amount: config.faucet_internal_amount,
        faucet_cooldown_secs: config.faucet_cooldown_secs,
        faucet_max_per_window: config.faucet_max_per_window,
        faucet_admin_token: config.faucet_admin_token.clone(),
        session_jwt_secret: config.session_jwt_secret.clone(),
        sponsor_sender_max_per_window: config.sponsor_sender_max_per_window,
        sponsor_sender_window_secs: config.sponsor_sender_window_secs,
        sponsor_global_daily_limit: config.sponsor_global_daily_limit,
    });
    if state.session_jwt_secret.is_none() {
        tracing::warn!(
            "arena allocate is UNAUTHENTICATED — set SESSION_JWT_SECRET (+ ship the FE session token) \
             to gate house on-chain spend (B5); the gate stays OFF until it is set"
        );
    }
    stats::spawn_stats_broadcaster(state.clone());
    spawn_action_flusher(state.clone());

    // Settle-worker pool (ADR-0029): N workers drain the settle queue, each coalescing a claim
    // into ONE batched `close_cooperative_with_root` PTB through the governed RPC. The worker count
    // + batch size are the tuning knobs for living under the fullnode's rate ceiling.
    let settle_workers: usize = std::env::var("SETTLE_WORKERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or(4);
    let settle_batch_max: usize = std::env::var("SETTLE_BATCH_MAX")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or(128);
    let settle_flush_ms: u64 = std::env::var("SETTLE_BATCH_FLUSH_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100);
    for i in 0..settle_workers {
        let deps = settle_worker::SettleWorkerDeps {
            queue: state.settle_queue.clone(),
            settler: state.settler.clone(),
            control: state.control.clone(),
            walrus: state.walrus.clone(),
            bus: state.bus.clone(),
            archiver: state.archiver.clone(),
            s3_prefix: state.s3_prefix.clone(),
        };
        tokio::spawn(settle_worker::run_settle_worker(
            deps,
            format!("settle-{i}"),
            settle_batch_max,
            settle_flush_ms,
        ));
    }
    tracing::info!(
        workers = settle_workers,
        batch_max = settle_batch_max,
        flush_ms = settle_flush_ms,
        "settle-worker pool started"
    );
    // Co-located fleet (ADR-0027): bots are spawned on demand by `arena_allocate`
    // (`reserve_or_spawn`), bounded by `arena_fleet_count`/`arena_fleet_games` on `AppState` — no
    // startup pre-spawn. Inert unless `FLEET_COLOCATED_COUNT > 0`.
    // Poll-index on-chain tunnel events (Created/Activated/Closed) into recent_events so the
    // live feed reflects real settlements; without this the stats SSE never emits any.
    sui::spawn_event_indexer(state.clone());

    // Watch the settler's SIP-58 gas pot: when it nears 0, every sponsored open/close/mint fails
    // (a recurring dev incident). `SETTLER_GAS_LOW_SUI` is the warn threshold in whole SUI.
    let settler_gas_low_mist = std::env::var("SETTLER_GAS_LOW_SUI")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .map_or(20_000_000_000, |sui| (sui * 1e9) as u64);
    sui::spawn_settler_gas_monitor(state.clone(), settler_gas_low_mist);

    // Clone before `state` is consumed by `.with_state` so we can flush after shutdown.
    let flush_state = state.clone();
    let app = Router::new()
        .route("/healthz", get(routes::health))
        .route("/health/live", get(routes::live))
        .route("/health/ready", get(routes::ready))
        .route("/metrics", get(routes::metrics))
        .route("/v1/sessions", post(routes::register_session))
        .route("/v1/sessions/:id/heartbeat", post(routes::heartbeat))
        // Settlement carries the off-chain transcript as a v2 binary body (one fixed 250 B entry
        // per co-signed move), archived to Walrus verbatim. Maximizing moves/tunnel amortizes the
        // on-chain close and Walrus per-blob cost, so a long self-play game ships tens of thousands
        // of moves. 32 MB for /settle only (≈134k moves) caps tunnel length; the body streams to
        // Walrus by reference (Bytes), so it stays 1× in memory (canonical MAX_MOVES_PER_TUNNEL=100k
        // ≈ 25 MB sits well inside this).
        .route(
            "/v1/tunnels/:tunnel_id/settle",
            // No concurrency limit (ADR-0029): ingest is O(1) (validate + enqueue), so a fleet
            // burst is absorbed as queue depth, not bounded here. The worker pool + governed RPC are
            // the real load bounds. Body cap stays so an oversized transcript can't exhaust memory.
            post(routes::settle).layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/v1/sponsor", post(routes::sponsor))
        // MTPS faucet (ADR-0023): the public route is per-address rate limited; the internal route
        // is unlimited and bearer-gated (fails closed when FAUCET_ADMIN_TOKEN is unset).
        .route("/v1/faucet", post(routes::faucet))
        .route("/v1/faucet/internal", post(routes::faucet_admin))
        // Session auth (B5): exchange a fresh Enoki id_token for a short-lived session JWT that gates
        // `/v1/arena/allocate`. Enforced only when SESSION_JWT_SECRET is set (else the gate is off).
        .route("/v1/auth/session", post(routes::auth_session))
        .route("/v1/chat", post(routes::chat))
        .route("/v1/chat/topic", get(routes::chat_topic))
        .route("/v1/chat/live/publish", post(routes::chat_publish))
        .route("/v1/chat/live", get(routes::chat_live))
        .route("/v1/flash/live", get(routes::flash_live))
        .route("/v1/flash/status", get(routes::flash_status))
        .route("/v1/flash/start", post(routes::flash_start))
        .route("/v1/flash/stop", post(routes::flash_stop))
        .route("/v1/stats/live", get(routes::stats_live))
        .route("/v1/sponsor/execute", post(routes::sponsor_execute))
        .route("/v1/mp", get(crate::mp::ws::mp_upgrade))
        // Arena one-signature flow (ADR-0026, ADR-0005 co-location): `allocate` seeds a shared
        // reservation recipe; `arena.join` (over /v1/mp) claims it and spawns the co-located bot.
        // `opened` is a compatibility 204 no-op.
        .route("/v1/arena/allocate", post(routes::arena_allocate))
        .route("/v1/arena/opened", post(routes::arena_opened))
        .layer(TraceLayer::new_for_http())
        .layer(cors_layer()?)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!(%bind_addr, "tunnel-manager listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    // Graceful shutdown completed: push the last sub-second of counted moves so a clean
    // rollout doesn't drop them (the 1 Hz flusher is gone with the runtime by now).
    flush_actions(&flush_state).await;
    // Then flush any transcript chunks still queued for S3, so a match that settled just before the
    // roll isn't left with missing chunks. Still-playing matches' tails are best-effort here.
    if let Some(uploader) = uploader {
        uploader.shutdown().await;
    }
    Ok(())
}

/// Build a CORS layer from `CORS_ALLOWED_ORIGINS`. Release deploys fail closed unless origins are
/// explicit; local/debug runs can opt into permissive CORS by leaving the env var unset.
fn cors_layer() -> anyhow::Result<CorsLayer> {
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
            Ok(CorsLayer::new()
                .allow_origin(origins)
                .allow_methods(Any)
                .allow_headers(Any))
        }
        _ if allow_permissive_cors() => Ok(CorsLayer::permissive()),
        _ => anyhow::bail!(
            "CORS_ALLOWED_ORIGINS must be set for release builds; set ALLOW_PERMISSIVE_CORS=true only for local/dev runs"
        ),
    }
}

fn allow_permissive_cors() -> bool {
    cfg!(debug_assertions)
        || std::env::var("ALLOW_PERMISSIVE_CORS")
            .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
            .unwrap_or(false)
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

#[cfg(test)]
mod test_init {
    #[ctor::ctor]
    fn install_ring_crypto_provider() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}
