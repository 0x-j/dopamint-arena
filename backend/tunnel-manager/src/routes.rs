//! HTTP handlers for the control-plane contract (ADR-0002). Per-move traffic never
//! reaches here (ADR-0001): only register / heartbeat / settle / live-stats.

use std::convert::Infallible;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};
use uuid::Uuid;

use crate::error::ApiError;
use crate::state::{SessionRecord, SharedState, StatsSnapshot};

#[cfg(test)]
pub(crate) mod test_support {
    use crate::state::{AppState, SharedState};

    /// Shared `AppState` builder for unit tests across modules.
    pub(crate) fn test_state() -> SharedState {
        use base64::Engine;
        let key = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
        let rpc = crate::sui_rpc::GovernedRpc::new(
            "http://127.0.0.1:9999".into(),
            crate::sui_rpc::RpcLimits::default(),
        );
        let settler = std::sync::Arc::new(
            crate::sui::SuiSettler::new(rpc, "0x2", "0x2::sui::SUI", None, None, &key, None)
                .expect("test settler"),
        );
        let walrus = crate::walrus::WalrusClient::new("http://pub".into(), "http://agg".into());
        let ollama = crate::ollama::OllamaClient::new(
            "http://localhost:11434".into(),
            "qwen2.5:1.5b".into(),
        )
        .expect("test ollama client");
        let (stats_tx, _) = tokio::sync::broadcast::channel(4);
        std::sync::Arc::new(AppState {
            control: std::sync::Arc::new(crate::store::memory::InMemoryControlStore::default()),
            mp: std::sync::Arc::new(crate::store::memory::InMemoryMpStore::default()),
            bus: std::sync::Arc::new(crate::store::memory::LocalBus::new("test-instance".into())),
            settler,
            settle_queue: std::sync::Arc::new(crate::settle_queue::InMemorySettleQueue::default()),
            enoki: None,
            walrus,
            archiver: None,
            s3_prefix: "".into(),
            chunk_writer: None,
            chunk_upload_tx: None,
            ollama,
            stats_tx,
            actions: crate::stats_counter::LocalActionCounter::default(),
            pair_hold_ms: 750,
            pairing: crate::stats_counter::MatchPairingMetrics::default(),
            chat: crate::chat_store::ChatTranscriptStore::new(),
            fleet: crate::fleet::BotPool::default(),
            arena_opener: std::sync::Arc::new(crate::fleet::arena_opener::NoopArenaOpener),
            arena_fleet_count: 0,
            arena_fleet_games: std::collections::HashSet::new(),
            wallet_pool: None,
            faucet_user_amount: 10_000,
            faucet_internal_amount: 1_000_000,
            faucet_cooldown_secs: 1_800,
            faucet_max_per_window: 5,
            faucet_admin_token: None,
        })
    }
}

// ===== Wire types — JSON is camelCase to match the SDK (see ADR-0002). =====
// `u64` fields that exceed JS precision (balances, nonce, timestamp) are strings.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegisterSessionRequest {
    user_address: String,
    game: String,
    tunnels: Vec<TunnelRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRef {
    pub tunnel_id: String,
    pub party_a: String,
    pub party_b: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegisterSessionResponse {
    session_id: String,
    stats_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeartbeatRequest {
    tunnel_id: String,
    nonce: String,
    actions_delta: u64,
    window_ms: u64,
}

/// The fixed-offset header of the binary `/settle` body (octet-stream). The whole body
/// (header + length-prefixed entries) is archived to Walrus verbatim; the backend parses only
/// the header here. Byte-identical to the SDK codec (`encodeSettleBody`), golden-vector-pinned.
/// `final_nonce` is parsed for the tracing log only — the chain derives the on-chain nonce, so it
/// is NOT part of `CloseArgs`.
struct SettleBody {
    tunnel_id: String,
    party_a_balance: u64,
    party_b_balance: u64,
    final_nonce: u64,
    timestamp: u64,
    transcript_root: Vec<u8>,
    sig_a: Vec<u8>,
    sig_b: Vec<u8>,
    update_count: u32,
}

pub(crate) const SETTLE_BODY_VERSION: u8 = 0x01;
pub(crate) const SETTLE_BODY_HEADER_LEN: usize = 229;

/// Parse the binary settle-body header (big-endian, fixed offsets — see the plan layout).
/// Returns `Err` on a short body or a wrong version byte; the handler maps that to 422 before
/// touching the settler. Entries past the header are not parsed (only `count` matters); the raw
/// body is what gets archived.
fn parse_settle_body(b: &[u8]) -> Result<SettleBody, String> {
    if b.len() < SETTLE_BODY_HEADER_LEN {
        return Err(format!(
            "body too short: {} < {}",
            b.len(),
            SETTLE_BODY_HEADER_LEN
        ));
    }
    if b[0] != SETTLE_BODY_VERSION {
        return Err(format!("unexpected settle version {}", b[0]));
    }
    let u64be = |o: usize| u64::from_be_bytes(b[o..o + 8].try_into().unwrap());
    Ok(SettleBody {
        tunnel_id: format!("0x{}", hex::encode(&b[1..33])),
        party_a_balance: u64be(33),
        party_b_balance: u64be(41),
        final_nonce: u64be(49),
        timestamp: u64be(57),
        transcript_root: b[65..97].to_vec(),
        sig_a: b[97..161].to_vec(),
        sig_b: b[161..225].to_vec(),
        update_count: u32::from_be_bytes(b[225..229].try_into().unwrap()),
    })
}

/// Rebuild `CloseArgs` from the 229-byte settle header (ADR-0029). The async worker re-parses the
/// header it dequeued to drive the on-chain close — the same fixed-offset layout the handler
/// validated at ingest, so there is one parser, not two.
pub(crate) fn close_args_from_settle_header(
    header: &[u8],
) -> Result<crate::sui::CloseArgs, String> {
    let p = parse_settle_body(header)?;
    Ok(crate::sui::CloseArgs {
        tunnel_id: p.tunnel_id,
        party_a_balance: p.party_a_balance,
        party_b_balance: p.party_b_balance,
        sig_a: p.sig_a,
        sig_b: p.sig_b,
        timestamp: p.timestamp,
        transcript_root: p.transcript_root,
    })
}

/// Normalize a Sui object/tunnel id for equality: strip an optional `0x`, lowercase, left-pad to
/// 32 bytes (64 hex). The path id is a free-form URL string (possibly shorthand like `0x1` or
/// mixed-case); the body id is always full lowercase. Comparing normalized forms prevents a valid
/// settle being falsely rejected by `tunnel_mismatch` on a mere format difference.
fn normalize_tunnel_id(id: &str) -> String {
    let h = id.trim_start_matches("0x").to_ascii_lowercase();
    format!("{h:0>64}")
}

pub(crate) async fn health() -> &'static str {
    "ok"
}

pub(crate) async fn live() -> StatusCode {
    StatusCode::OK
}

/// 200 iff the CACHE cluster answers. Pubsub is a WS-path soft dependency and is intentionally
/// NOT pinged here (else a pubsub blip would 503 stats/settle and the ALB would drop all targets).
pub(crate) async fn ready(State(state): State<SharedState>) -> StatusCode {
    if state.control.ready().await {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

/// Register the tunnels a client just opened+funded (via the wallet PTB) under a
/// session, so their stats and settlement can be tracked. Not trusted for funds —
/// on-chain events remain authoritative.
pub(crate) async fn register_session(
    State(state): State<SharedState>,
    Json(req): Json<RegisterSessionRequest>,
) -> Json<RegisterSessionResponse> {
    tracing::info!(user = %req.user_address, game = %req.game, tunnels = req.tunnels.len(), "register session");
    for t in &req.tunnels {
        tracing::debug!(tunnel = %t.tunnel_id, party_a = %t.party_a, party_b = %t.party_b, "registered tunnel");
    }
    let session_id = format!("sess_{}", Uuid::new_v4().simple());
    let stats_token = Uuid::new_v4().to_string();
    state
        .control
        .put_session(
            &session_id,
            SessionRecord {
                game: req.game,
                tunnels: req.tunnels,
                stats_token: stats_token.clone(),
            },
        )
        .await;
    Json(RegisterSessionResponse {
        session_id,
        stats_token,
    })
}

/// Coarse, aggregated throughput report (~1/s) — never one call per move.
pub(crate) async fn heartbeat(
    State(state): State<SharedState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<HeartbeatRequest>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let Some(rec) = state.control.get_session(&session_id).await else {
        return Err(ApiError::resp(
            StatusCode::NOT_FOUND,
            "unknown_session",
            "no such session",
        ));
    };
    if !bearer_matches(&headers, &rec.stats_token) {
        return Err(ApiError::resp(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token",
        ));
    }
    tracing::debug!(%session_id, tunnel = %req.tunnel_id, nonce = %req.nonce, window_ms = req.window_ms, "heartbeat");
    // Park the delta in the per-instance counter; the 1 Hz flusher drains it into ControlStore.
    // Avoids a per-heartbeat single-key INCRBY hotspot (the relay path already does this).
    state.actions.incr(&rec.game, req.actions_delta);
    Ok(StatusCode::NO_CONTENT)
}

// ===== Arena one-signature flow (ADR-0026). =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArenaAllocateRequest {
    user_address: String,
    games: Vec<ArenaGameRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArenaGameRequest {
    id: String,
    /// The user's per-game ephemeral pubkey (hex) — tunnel party A's `pk`, baked in at create
    /// (ADR-0028). One keypair per game so a key leak is isolated to a single tunnel.
    user_eph_pubkey: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArenaAllocation {
    game: String,
    match_id: String,
    /// The on-chain tunnel the fleet pre-created + funded seat B for (ADR-0028). The user's
    /// deposit-only PTB funds seat A into THIS tunnel; the tunnel activates on that one signature.
    tunnel_id: String,
    /// The reserved bot's ephemeral pubkey (hex) — tunnel party B's `pk` (verifies move sigs).
    bot_eph_pubkey: String,
    /// The reserved bot's on-chain address — tunnel party B's `address` (funds/receives seat B).
    /// Distinct from the ephemeral pubkey; the frontend needs both to build the open PTB's party B.
    bot_address: String,
    /// Per-seat stake (smallest MTPS unit) from the game's `GameProfile`. The fleet funded seat B
    /// with exactly this; the user's batched deposit must fund seat A with the SAME amount, or the
    /// off-chain initial balances diverge and co-signing fails. Single source of truth so the FE
    /// never hardcodes a per-game stake.
    stake_each: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArenaAllocateResponse {
    allocations: Vec<ArenaAllocation>,
}

/// Max tunnel opens per batched PTB (Design 1). ~7 catalog games fit comfortably; 30 is a flood cap
/// well under the ~1024-command / event ceilings (30 games ≈ 120 commands, ≈ 90 events). Larger
/// requests chunk into ceil(N / 30) PTBs. Matches the frontend deposit-batch cap.
const ARENA_OPEN_BATCH_MAX: usize = 30;

/// Reserve a match per requested game and pre-create + fund its tunnel's seat B. A player enters
/// every arena game at once, so the opens are BATCHED into one sponsored PTB (chunked under
/// `ARENA_OPEN_BATCH_MAX`) instead of a serial per-game loop — one on-chain wait for the whole batch,
/// not N. Games at the per-game cap (or with no `GameProfile`, or whose open fails) are omitted, so
/// the frontend opens only what it actually got.
pub(crate) async fn arena_allocate(
    State(state): State<SharedState>,
    Json(req): Json<ArenaAllocateRequest>,
) -> Json<ArenaAllocateResponse> {
    // Plan: keep only served games that have a `GameProfile` (the stake source that makes the on-chain
    // deposit match the off-chain initial balances the FE co-signs), preserving request order.
    let mut planned: Vec<(String, String, u64)> = Vec::new(); // (game_id, user_eph_pubkey, stake_each)
    for game in &req.games {
        // Served-set gate (`FLEET_COLOCATED_GAMES`): only offer games the fleet can actually play.
        // The concurrency cap is enforced at `arena.join`, where the bot is spawned (ADR-0005
        // co-location) — allocate no longer spawns anything.
        if !state.arena_fleet_games.contains(&game.id) {
            continue;
        }
        let Some(profile) = fleet_core::play_match::profile_for(&game.id) else {
            tracing::warn!(game = %game.id, "arena allocate: no GameProfile, omitting");
            continue;
        };
        planned.push((
            game.id.clone(),
            game.user_eph_pubkey.clone(),
            profile.stake_each,
        ));
    }
    if planned.is_empty() {
        return Json(ArenaAllocateResponse {
            allocations: Vec::new(),
        });
    }

    // Design 1 batching: check out ONE seat-B address for the whole request — every tunnel shares
    // party B (`deposit_party_b` asserts sender == party_b, and a PTB has one sender). Per-match
    // identity stays distinct via each slot's ephemeral key (settlement authenticates by pubkey, not
    // address). Mint one recipe (unique match id + ephemeral key) per game under that address.
    let shared_bot = crate::fleet::colocated::checkout_bot_address(&state, "arena");
    let slots: Vec<(crate::fleet::colocated::ArenaSlot, String, String, u64)> = planned
        .into_iter()
        .map(|(game, user_eph_pubkey, stake)| {
            (
                crate::fleet::colocated::reserve_arena_slot_on(shared_bot.clone()),
                game,
                user_eph_pubkey,
                stake,
            )
        })
        .collect();

    // Open in batched PTBs (one sponsored tx per chunk). A whole-chunk abort falls back to per-game
    // opens inside the opener, so a single unfundable/invalid game only drops itself.
    let mut allocations = Vec::new();
    for chunk in slots.chunks(ARENA_OPEN_BATCH_MAX) {
        let reqs: Vec<crate::fleet::arena_opener::ArenaOpenRequest> = chunk
            .iter()
            .map(|(slot, game, user_eph_pubkey, stake)| {
                crate::fleet::arena_opener::ArenaOpenRequest {
                    game,
                    user_address: &req.user_address,
                    user_eph_pubkey,
                    bot_address: &slot.bot_address,
                    bot_eph_pubkey: &slot.eph_pubkey,
                    stake_each: *stake,
                }
            })
            .collect();
        let results = state.arena_opener.open_and_fund_seat_b_many(reqs).await;
        for ((slot, game, _user_eph_pubkey, stake), result) in chunk.iter().zip(results) {
            let open = match result {
                Ok(open) => open,
                Err(e) => {
                    tracing::warn!(game = %game, "arena open failed, omitting: {e:#}");
                    continue;
                }
            };
            // Seed the shared reservation: ANY instance's `arena.join` reads this to reconstruct party
            // B and spawn the bot locally. The running bot is never stored — only this recipe. The
            // tunnel's `created_at` is captured HERE (from the open) so the bot never reads chain on its
            // play path — the root-cause fix for "bot never moves."
            state
                .mp
                .put_arena_reservation(
                    &slot.match_id,
                    crate::store::ArenaReservation {
                        game: game.clone(),
                        seat_a: req.user_address.clone(),
                        seat_b: slot.bot_address.clone(),
                        tunnel_id: open.tunnel_id.clone(),
                        eph_secret_hex: slot.eph_secret_hex.clone(),
                        created_at_ms: open.created_at_ms,
                    },
                )
                .await;
            // Tag the tunnel's game so the live feed's per-game tabs light up: the arena path
            // reserves (above) rather than calling register_session, which is the other writer.
            state.control.set_tunnel_game(&open.tunnel_id, game).await;
            allocations.push(ArenaAllocation {
                game: game.clone(),
                match_id: slot.match_id.clone(),
                tunnel_id: open.tunnel_id,
                bot_eph_pubkey: slot.eph_pubkey.clone(),
                bot_address: slot.bot_address.clone(),
                stake_each: *stake,
            });
        }
    }
    tracing::info!(user = %req.user_address, allocated = allocations.len(), "arena allocate");
    Json(ArenaAllocateResponse { allocations })
}

/// The user finished the batched deposit PTB. In the co-located design the bot is spawned at
/// `arena.join` (which always follows this call in the FE flow), so there is nothing to signal here —
/// the endpoint is retained for FE compatibility and returns 204, ignoring the body. The reservation's
/// TTL covers the deposit-signing window between allocate and join.
pub(crate) async fn arena_opened() -> StatusCode {
    StatusCode::NO_CONTENT
}

/// Submit `close_cooperative_with_root` for a tunnel. Authorization is the co-signed settlement
/// itself — the chain re-verifies both seat signatures — so there is NO session/bearer gate
/// (ADR-0007). The settler dry-runs the close before sponsoring gas, so a bad settlement is
/// rejected (422) at no cost.
pub(crate) async fn settle(
    State(state): State<SharedState>,
    Path(tunnel_id): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    let p = match parse_settle_body(&body) {
        Ok(p) => p,
        Err(e) => {
            return ApiError::resp(
                StatusCode::UNPROCESSABLE_ENTITY,
                "bad_settlement",
                &format!("invalid settle body: {e}"),
            )
            .into_response();
        }
    };
    tracing::info!(
        %tunnel_id,
        final_nonce = p.final_nonce,
        balance_a = p.party_a_balance,
        balance_b = p.party_b_balance,
        update_count = p.update_count,
        "settle requested"
    );

    // The signed settlement commits to its own tunnelId; a path/body mismatch is a client bug
    // or a misroute, never a thing to sponsor gas for. Compare normalized (the body id is full
    // lowercase, the path may be shorthand/mixed-case) so a valid settle isn't falsely rejected.
    if normalize_tunnel_id(&p.tunnel_id) != normalize_tunnel_id(&tunnel_id) {
        return ApiError::resp(
            StatusCode::UNPROCESSABLE_ENTITY,
            "tunnel_mismatch",
            "settlement tunnelId does not match the path",
        )
        .into_response();
    }

    // 409 if the event-derived registry already shows this tunnel closed (free reject, no RPC).
    if state.control.get_tunnel_status(&tunnel_id).await == Some(crate::state::TunnelStatus::Closed)
    {
        return ApiError::resp(
            StatusCode::CONFLICT,
            "already_settled",
            "tunnel already closed on-chain",
        )
        .into_response();
    }

    // Structural checks passed (ADR-0029): durably enqueue and return 202 immediately. No node
    // RPC on the request path, so a fleet burst is absorbed as queue depth, never a 429. The
    // worker pool coalesces many settles into one PTB; confirmation arrives via `explorer:proofs`.
    // The 229-byte header is enough for the PTB; the full body rides along for Walrus archival.
    let header = body[..SETTLE_BODY_HEADER_LEN].to_vec();
    match state.settle_queue.enqueue(&tunnel_id, header, body).await {
        Ok(id) => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "status": "accepted", "settlementId": id })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(%tunnel_id, error = %e, "settle enqueue failed");
            ApiError::resp(
                StatusCode::SERVICE_UNAVAILABLE,
                "settle_enqueue_failed",
                "could not queue settlement; retry shortly",
            )
            .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SponsorRequest {
    /// The user's address — the sender of the open/fund tx. Funds (stake) come from this account.
    sender: String,
    /// Base64 of the client-built transaction KIND (`build({ onlyTransactionKind: true })`).
    tx_kind_bytes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SponsorResponse {
    /// Which gas source sponsored this tx — `"enoki"` or `"settler"`. The client uses it to pick how
    /// to execute: Enoki via `POST /v1/sponsor/execute`, settler by submitting both sigs itself.
    provider: &'static str,
    /// Base64 of the sponsored transaction the user must sign.
    tx_bytes: String,
    /// Settler only: the settler's gas signature (base64), submitted with the user's sender sig.
    #[serde(skip_serializing_if = "Option::is_none")]
    sponsor_signature: Option<String>,
    /// Enoki only: the sponsored-tx handle, passed back to `/v1/sponsor/execute` with the signature.
    #[serde(skip_serializing_if = "Option::is_none")]
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatRequest {
    messages: Vec<crate::ollama::OllamaMessage>,
    /// Accepted for API compatibility but ignored: the configured `OLLAMA_MODEL` is always used.
    #[allow(dead_code)]
    model: Option<String>,
    /// Accepted for API compatibility but ignored: this proxy is non-streaming.
    #[allow(dead_code)]
    stream: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatResponse {
    content: String,
}

/// Sponsor gas (only) for a user's open/fund tx (ADR-0009, ADR-0014). Validates the client-built tx
/// KIND against the shared allowlist FIRST (so neither provider is ever asked to sponsor abuse),
/// then tries Enoki (the primary gas source); on ANY Enoki error it falls back to the settler, which
/// wraps the KIND in its own SIP-58 gas + dry-runs. The stake always comes from the user's own coin,
/// never the sponsor. No session/bearer gate — the allowlist + dry-run are the only thing standing
/// between this and a gas faucet.
pub(crate) async fn sponsor(
    State(state): State<SharedState>,
    Json(req): Json<SponsorRequest>,
) -> Response {
    // Validate FIRST against the shared anti-abuse allowlist; the returned move-call targets feed
    // Enoki's allowedMoveCallTargets. A rejection here means no provider should pay — fail loud.
    let targets = match state.settler.validate_kind(&req.tx_kind_bytes) {
        Ok(targets) => targets,
        Err(e) => {
            tracing::warn!(sender = %req.sender, error = %e, "sponsor refused (validation)");
            return ApiError::resp(
                StatusCode::UNPROCESSABLE_ENTITY,
                "sponsor_refused",
                &e.to_string(),
            )
            .into_response();
        }
    };

    // Enoki first when configured: it owns the gas AND executes, returning a handle the client
    // redeems via /v1/sponsor/execute. On any Enoki error (misconfig, 4xx/5xx, timeout) fall through
    // to the settler — the user's stated order. Execute-step failures are NOT recoverable here (the
    // signed bytes commit to Enoki's gas owner); the client surfaces those.
    if let Some(enoki) = &state.enoki {
        match enoki
            .sponsor(&req.sender, &req.tx_kind_bytes, &targets)
            .await
        {
            Ok((tx_bytes, digest)) => {
                return Json(SponsorResponse {
                    provider: "enoki",
                    tx_bytes,
                    sponsor_signature: None,
                    digest: Some(digest),
                })
                .into_response();
            }
            Err(e) => {
                tracing::warn!(sender = %req.sender, error = %e, "enoki sponsor failed; falling back to settler");
            }
        }
    }

    // Settler fallback: wrap in settler-owned SIP-58 gas + dry-run; the client submits both sigs.
    match state
        .settler
        .sponsor_open_fund(&req.sender, &req.tx_kind_bytes)
        .await
    {
        Ok((tx_bytes, sponsor_signature)) => Json(SponsorResponse {
            provider: "settler",
            tx_bytes,
            sponsor_signature: Some(sponsor_signature),
            digest: None,
        })
        .into_response(),
        Err(e) => {
            tracing::warn!(sender = %req.sender, error = %e, "sponsor refused");
            ApiError::resp(
                StatusCode::UNPROCESSABLE_ENTITY,
                "sponsor_refused",
                &e.to_string(),
            )
            .into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FaucetRequest {
    /// Recipient address — the requesting wallet. The cooldown is keyed on its canonical form.
    address: String,
    /// Deposit straight into the recipient's SIP-58 address balance (`admin_mint_to_balance`) when
    /// true — the default, since the stake path withdraws from the address balance (no client sweep).
    /// Set false to mint an owned coin (the coin-object stake fallback). Omitted = true.
    #[serde(default)]
    to_balance: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FaucetResponse {
    /// The `admin_mint` tx digest.
    digest: String,
    /// Whole-token MTPS minted (0 decimals; ADR-0023).
    amount: u64,
    /// Canonical recipient address the mint credited.
    recipient: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdminFaucetRequest {
    /// Recipient address to credit.
    recipient: String,
    /// Whole-token MTPS to mint; defaults to the configured internal amount, capped at
    /// `MAX_MINT_PER_CALL`.
    amount: Option<u64>,
    /// Deposit into the recipient's SIP-58 address balance when true (default), else an owned coin.
    #[serde(default)]
    to_balance: Option<bool>,
}

/// 503 response when the on-chain faucet (the `AdminCap`) is not configured. Returned by both
/// faucet routes so neither claims a cooldown nor signs a mint it cannot complete.
fn faucet_disabled() -> Response {
    ApiError::resp(
        StatusCode::SERVICE_UNAVAILABLE,
        "faucet_disabled",
        "faucet is not configured (MTPS_ADMIN_CAP_ID unset)",
    )
    .into_response()
}

/// Public MTPS faucet (ADR-0023): mint a fixed amount to the requesting address, rate-limited to
/// once per `faucet_cooldown_secs` per address. The cooldown is claimed BEFORE the mint and released
/// if the mint fails, so a transient backend error never locks the user out for the full window.
/// 503 when unconfigured, 422 on a bad address, 429 (+ `Retry-After`) when on cooldown.
pub(crate) async fn faucet(
    State(state): State<SharedState>,
    Json(req): Json<FaucetRequest>,
) -> Response {
    if !state.settler.mint_configured() {
        return faucet_disabled();
    }
    let recipient = match crate::sui::canonical_address(&req.address) {
        Ok(a) => a,
        Err(e) => {
            return ApiError::resp(
                StatusCode::UNPROCESSABLE_ENTITY,
                "bad_address",
                &e.to_string(),
            )
            .into_response();
        }
    };
    // Claim a slot in the per-address rate-limit window first. Window exhausted → 429 + Retry-After.
    if !state
        .control
        .claim_faucet_slot(
            &recipient,
            state.faucet_cooldown_secs,
            state.faucet_max_per_window,
        )
        .await
    {
        let retry = state
            .control
            .faucet_window_ttl(&recipient)
            .await
            .unwrap_or(state.faucet_cooldown_secs);
        let mut resp = ApiError::resp(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "faucet rate limit reached; try again later",
        )
        .into_response();
        if let Ok(v) = axum::http::HeaderValue::from_str(&retry.to_string()) {
            resp.headers_mut()
                .insert(axum::http::header::RETRY_AFTER, v);
        }
        return resp;
    }
    let amount = state.faucet_user_amount;
    let to_balance = req.to_balance.unwrap_or(true);
    match state
        .settler
        .mint_mtps(&recipient, amount, to_balance)
        .await
    {
        Ok(digest) => Json(FaucetResponse {
            digest,
            amount,
            recipient,
        })
        .into_response(),
        Err(e) => {
            // Free the slot so a transient failure doesn't burn one of the window's allowed pulls.
            state.control.release_faucet_slot(&recipient).await;
            tracing::warn!(recipient = %recipient, error = %e, "faucet mint failed");
            ApiError::resp(StatusCode::BAD_GATEWAY, "faucet_failed", &e.to_string()).into_response()
        }
    }
}

/// Internal (unlimited) MTPS faucet: mint to any recipient with no cooldown, for internal/ops use.
/// Bearer-gated by `FAUCET_ADMIN_TOKEN`; fails closed (503) when the token is unset so an unlimited
/// mint can never be accidentally open. Amount defaults to the configured internal amount, capped at
/// `MAX_MINT_PER_CALL`.
pub(crate) async fn faucet_admin(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<AdminFaucetRequest>,
) -> Response {
    let Some(token) = state.faucet_admin_token.as_deref() else {
        return ApiError::resp(
            StatusCode::SERVICE_UNAVAILABLE,
            "faucet_admin_disabled",
            "internal faucet is not configured (FAUCET_ADMIN_TOKEN unset)",
        )
        .into_response();
    };
    if !bearer_matches(&headers, token) {
        return ApiError::resp(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token",
        )
        .into_response();
    }
    if !state.settler.mint_configured() {
        return faucet_disabled();
    }
    let recipient = match crate::sui::canonical_address(&req.recipient) {
        Ok(a) => a,
        Err(e) => {
            return ApiError::resp(
                StatusCode::UNPROCESSABLE_ENTITY,
                "bad_address",
                &e.to_string(),
            )
            .into_response();
        }
    };
    let amount = req.amount.unwrap_or(state.faucet_internal_amount);
    let to_balance = req.to_balance.unwrap_or(true);
    if amount == 0 || amount > crate::sui::MAX_MINT_PER_CALL {
        return ApiError::resp(
            StatusCode::UNPROCESSABLE_ENTITY,
            "bad_amount",
            &format!("amount must be 1..={}", crate::sui::MAX_MINT_PER_CALL),
        )
        .into_response();
    }
    match state
        .settler
        .mint_mtps(&recipient, amount, to_balance)
        .await
    {
        Ok(digest) => Json(FaucetResponse {
            digest,
            amount,
            recipient,
        })
        .into_response(),
        Err(e) => {
            tracing::warn!(recipient = %recipient, error = %e, "internal faucet mint failed");
            ApiError::resp(StatusCode::BAD_GATEWAY, "faucet_failed", &e.to_string()).into_response()
        }
    }
}

/// Proxy a non-streaming chat request to the configured Ollama model.
pub(crate) async fn chat(
    State(state): State<SharedState>,
    Json(req): Json<ChatRequest>,
) -> Response {
    match state.ollama.chat(&req.messages).await {
        Ok(content) => Json(ChatResponse { content }).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "ollama chat failed");
            ApiError::resp(StatusCode::BAD_GATEWAY, "ollama_error", &e.to_string()).into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishChatRequest {
    pub messages: Vec<crate::chat_store::ChatMessage>,
}

pub(crate) async fn chat_publish(
    State(state): State<SharedState>,
    Json(req): Json<PublishChatRequest>,
) -> StatusCode {
    for msg in req.messages {
        state.chat.publish(msg).await;
    }
    StatusCode::NO_CONTENT
}

pub(crate) async fn chat_live(
    State(state): State<SharedState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.chat.subscribe()).filter_map(|msg| {
        msg.ok()
            .map(|json| Ok::<_, Infallible>(Event::default().data(json)))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SponsorExecuteRequest {
    /// The Enoki sponsored-tx handle returned by `POST /v1/sponsor` (provider `"enoki"`).
    digest: String,
    /// The user's signature (base64) over the sponsored bytes.
    signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SponsorExecuteResponse {
    /// The executed transaction digest.
    digest: String,
}

/// Execute an Enoki-sponsored tx (ADR-0014): hand Enoki the user's signature so it submits with its
/// own gas signature. Settler-sponsored txs do NOT use this route — the client submits those itself.
/// Returns 422 when Enoki is not configured, since no Enoki handle can exist in that case.
pub(crate) async fn sponsor_execute(
    State(state): State<SharedState>,
    Json(req): Json<SponsorExecuteRequest>,
) -> Response {
    let Some(enoki) = &state.enoki else {
        return ApiError::resp(
            StatusCode::UNPROCESSABLE_ENTITY,
            "enoki_not_configured",
            "enoki is not configured; settler-sponsored transactions execute client-side",
        )
        .into_response();
    };
    match enoki.execute(&req.digest, &req.signature).await {
        Ok(digest) => Json(SponsorExecuteResponse { digest }).into_response(),
        Err(e) => {
            tracing::warn!(digest = %req.digest, error = %e, "enoki execute failed");
            ApiError::resp(
                StatusCode::UNPROCESSABLE_ENTITY,
                "enoki_execute_failed",
                &e.to_string(),
            )
            .into_response()
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TopicResponse {
    topic: String,
}

/// Ask Ollama for a short random conversation topic for two chat bots.
pub(crate) async fn chat_topic(State(state): State<SharedState>) -> Response {
    match state.ollama.topic().await {
        Ok(topic) => Json(TopicResponse { topic }).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "ollama topic failed");
            ApiError::resp(StatusCode::BAD_GATEWAY, "ollama_error", &e.to_string()).into_response()
        }
    }
}

/// Build the settled Transaction-Log row for a successful close. The settle handler owns the
/// full proof (close digest + Walrus URL), so it pushes the enriched row directly; the
/// indexer's later explorer-only row for the same `tx_digest` is deduped. Empty strings
/// (Walrus archival failed) degrade to `None`, never a broken link.
#[allow(clippy::too_many_arguments)] // one flat row builder; grouping the payout fields buys nothing
pub(crate) fn settled_event(
    tunnel_id: &str,
    owner: Option<crate::state::TunnelOwner>,
    game: Option<String>,
    party_a_balance: u64,
    party_b_balance: u64,
    transcript_root_hex: &str,
    tx_digest: &str,
    timestamp_ms: u64,
    proof_url: &str,
) -> crate::state::TunnelEvent {
    let non_empty = |s: &str| (!s.is_empty()).then(|| s.to_string());
    // Carry ownership on the close row itself: the settle handler pushes before the indexer's
    // next poll and wins the per-digest dedup, so without this a settled row would never highlight.
    let (party_a, party_b, funder) = match owner {
        Some(o) => (o.party_a, o.party_b, o.funder),
        None => (None, None, None),
    };
    crate::state::TunnelEvent {
        tunnel_id: tunnel_id.to_string(),
        kind: crate::state::TunnelEventKind::Settled,
        party_a,
        party_b,
        funder,
        game,
        party_a_balance: Some(party_a_balance),
        party_b_balance: Some(party_b_balance),
        transcript_root: non_empty(transcript_root_hex),
        tx_digest: tx_digest.to_string(),
        timestamp_ms,
        proof_url: non_empty(proof_url),
    }
}

/// True iff `Authorization: Bearer <token>` is present and equals `expected`.
fn bearer_matches(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|t| t == expected)
        .unwrap_or(false)
}

/// SSE feed for the catalog activity panel (ADR-0002 `GET /v1/stats/live`).
pub(crate) async fn stats_live(
    State(state): State<SharedState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.stats_tx.subscribe()).filter_map(|msg| {
        msg.ok()
            .map(|json| Ok::<_, Infallible>(Event::default().data(json)))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Prometheus text exposition of the live counters.
pub(crate) async fn metrics(State(state): State<SharedState>) -> impl IntoResponse {
    let snap = state.control.snapshot().await;
    let (colocated, split) = state.pairing.snapshot();
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4",
        )],
        render_metrics(&snap, colocated, split),
    )
}

fn render_metrics(snap: &StatsSnapshot, colocated: u64, split: u64) -> String {
    format!(
        "# TYPE tunnel_actions_total counter\ntunnel_actions_total {}\n\
         # TYPE tunnel_settled_total counter\ntunnel_settled_total {}\n\
         # TYPE tunnel_active gauge\ntunnel_active {}\n\
         # TYPE tunnel_matches_colocated_total counter\ntunnel_matches_colocated_total {}\n\
         # TYPE tunnel_matches_split_total counter\ntunnel_matches_split_total {}\n",
        snap.total_actions, snap.settled_tunnels, snap.active_tunnels, colocated, split,
    )
}

#[cfg(test)]
mod tests {
    use super::test_support::test_state;
    use super::*;

    // The binary /settle body the SDK codec (`encodeSettleBody`) emits — byte-identical to
    // the TS golden vector (settleBinary.test.ts). Pasting it here pins TS↔Rust wire parity: a
    // layout drift on either side breaks the parse asserts below. See the plan §"Shared golden vector".
    const GOLDEN_HEX: &str = "01000000000000000000000000000000000000000000000000000000000000000100000000000000070000000000000003000000000000000500000000000004d2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222000000020078333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444445555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555500786666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666667777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777788888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888888";

    // The fixed-offset header parses byte-for-byte to the golden input. `final_nonce` is read
    // (logged) but NOT carried into CloseArgs — the chain derives the on-chain nonce.
    #[test]
    fn parse_settle_body_reads_header_from_golden_vector() {
        let bytes = hex::decode(GOLDEN_HEX).expect("golden hex decodes");
        let p = parse_settle_body(&bytes).expect("valid settle body");
        assert_eq!(p.tunnel_id, "0x".to_owned() + &"00".repeat(31) + "01");
        assert_eq!(p.party_a_balance, 7);
        assert_eq!(p.party_b_balance, 3);
        assert_eq!(p.final_nonce, 5);
        assert_eq!(p.timestamp, 1234);
        assert_eq!(p.transcript_root, vec![0xaa; 32]);
        assert_eq!(p.sig_a, vec![0x11; 64]);
        assert_eq!(p.sig_b, vec![0x22; 64]);
        assert_eq!(p.update_count, 2);
    }

    // A wrong version byte is a client/version bug — reject before the settler (mapped to 422).
    #[test]
    fn parse_settle_body_rejects_bad_version() {
        let mut bytes = hex::decode(GOLDEN_HEX).expect("golden hex decodes");
        bytes[0] = 0x02;
        assert!(parse_settle_body(&bytes).is_err());
    }

    // Two ids resolve to the same on-chain object iff their normalized forms match: shorthand
    // (`0x1`), full lowercase, and mixed-case all collapse so a valid settle isn't false-rejected.
    #[test]
    fn normalize_tunnel_id_collapses_format_differences() {
        let full = "0x".to_owned() + &"00".repeat(31) + "01";
        assert_eq!(normalize_tunnel_id("0x1"), normalize_tunnel_id(&full));
        assert_eq!(normalize_tunnel_id("0xABC"), normalize_tunnel_id("0xabc"));
        assert_ne!(normalize_tunnel_id("0x1"), normalize_tunnel_id("0x2"));
    }

    #[test]
    fn bearer_matches_only_exact_token() {
        let mut h = HeaderMap::new();
        assert!(!bearer_matches(&h, "tok"), "missing header must fail");
        h.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer wrong".parse().unwrap(),
        );
        assert!(!bearer_matches(&h, "tok"), "wrong token must fail");
        h.insert(axum::http::header::AUTHORIZATION, "tok".parse().unwrap());
        assert!(
            !bearer_matches(&h, "tok"),
            "missing Bearer prefix must fail"
        );
        h.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer tok".parse().unwrap(),
        );
        assert!(bearer_matches(&h, "tok"), "exact token must pass");
    }

    // A successful settle becomes a `settled` row carrying payout + transcript root + the Walrus
    // proof URL — what makes a global-log row clickable to its proof (spec §6).
    #[test]
    fn settled_event_carries_proof_and_payout() {
        let ev = settled_event(
            "0xT",
            Some(crate::state::TunnelOwner {
                party_a: Some("0xME".into()),
                party_b: Some("0xOPP".into()),
                funder: Some("0xME".into()),
            }),
            Some("blackjack".into()),
            1500,
            500,
            "deadbeef",
            "DiG",
            1_750_000_000_000,
            "https://agg/v1/blobs/abc",
        );
        assert_eq!(ev.kind, crate::state::TunnelEventKind::Settled);
        assert_eq!(ev.party_a_balance, Some(1500));
        // The close row inherits ownership so it can highlight for the viewer (spec: open AND close).
        assert_eq!(ev.party_a.as_deref(), Some("0xME"));
        assert_eq!(ev.funder.as_deref(), Some("0xME"));
        assert_eq!(ev.game.as_deref(), Some("blackjack"));
        assert_eq!(ev.transcript_root.as_deref(), Some("deadbeef"));
        assert_eq!(ev.tx_digest, "DiG");
        assert_eq!(ev.proof_url.as_deref(), Some("https://agg/v1/blobs/abc"));
    }

    // Walrus archival failure (empty url/root) must degrade to an explorer-only row, never a
    // broken link or anchor.
    #[test]
    fn settled_event_omits_proof_on_walrus_failure() {
        let ev = settled_event("0xT", None, None, 1, 1, "", "DiG", 1, "");
        assert!(ev.proof_url.is_none(), "empty url → no link");
        assert!(ev.transcript_root.is_none(), "empty root → no anchor");
    }

    // The golden settle body, whose tunnelId is 0x00..01 — reused by the guard tests as the request body.
    fn sample_settle_body() -> axum::body::Bytes {
        axum::body::Bytes::from(hex::decode(GOLDEN_HEX).expect("golden hex decodes"))
    }

    // The 0x-prefixed full-length form of the golden body's tunnelId (normalizes equal to it).
    fn golden_tunnel_id() -> String {
        "0x".to_owned() + &"00".repeat(31) + "01"
    }

    // ADR-0007: the signed settlement commits to its tunnelId, so a path/body mismatch is a
    // client bug or a misroute — reject before any RPC, never sponsor gas for it.
    #[tokio::test]
    async fn settle_rejects_path_tunnel_mismatch() {
        let state = test_state();
        let resp = settle(
            axum::extract::State(state),
            axum::extract::Path("0xDIFFERENT".to_string()),
            sample_settle_body(),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    }

    // 409 when the event-derived registry already shows this tunnel closed — a free reject that
    // never reaches the settler (idempotency; ADR-0007 keeps this guard). The path uses the full
    // form of the body's id so the mismatch guard passes and the conflict guard is what fires.
    #[tokio::test]
    async fn settle_conflicts_when_already_closed() {
        let state = test_state();
        let path = golden_tunnel_id();
        state
            .control
            .set_tunnel_status(&path, crate::state::TunnelStatus::Closed)
            .await;
        let resp = settle(
            axum::extract::State(state),
            axum::extract::Path(path),
            sample_settle_body(),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::CONFLICT);
    }

    // ADR-0029: a valid settle is durably enqueued and answered 202 immediately — no node RPC on
    // the request path. The worker pool (tested separately) drains it. This is what lets a fleet
    // burst be absorbed as queue depth instead of tripping the fullnode 429.
    #[tokio::test]
    async fn settle_enqueues_and_returns_202() {
        let state = test_state();
        let resp = settle(
            axum::extract::State(state.clone()),
            axum::extract::Path(golden_tunnel_id()),
            sample_settle_body(),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::ACCEPTED);
        assert_eq!(
            state.settle_queue.depth().await.unwrap(),
            1,
            "the settlement is on the queue"
        );
    }

    // /health/ready reflects ControlStore::ready(); in-memory is always ready.
    #[tokio::test]
    async fn health_ready_reflects_control_store() {
        let state = test_state();
        let code = ready(axum::extract::State(state)).await;
        assert_eq!(code, axum::http::StatusCode::OK);
    }

    // Heartbeat deltas must land in the per-instance LocalActionCounter (drained 1/s by the
    // flusher), NOT directly in the shared ControlStore — that single-key INCRBY is the hotspot
    // this change removes. The shared counter must stay untouched until the flusher runs.
    #[tokio::test]
    async fn heartbeat_feeds_local_counter_not_control_directly() {
        let state = crate::state::AppState::in_memory_for_test();
        let rec = SessionRecord {
            game: "blackjack".into(),
            tunnels: vec![],
            stats_token: "tok".into(),
        };
        state.control.put_session("s1", rec).await;

        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer tok".parse().unwrap(),
        );
        let req = HeartbeatRequest {
            tunnel_id: "0xt".into(),
            nonce: "1".into(),
            actions_delta: 7,
            window_ms: 1000,
        };

        heartbeat(State(state.clone()), Path("s1".into()), headers, Json(req))
            .await
            .unwrap();

        assert_eq!(
            state.control.snapshot().await.total_actions,
            0,
            "must not hit the shared counter directly"
        );
        assert_eq!(
            state.actions.drain_deltas(),
            vec![("blackjack".to_string(), 7)],
            "delta parked locally"
        );
    }

    // /metrics must expose the live counters in Prometheus text format.
    #[tokio::test]
    async fn metrics_render_exposes_counters() {
        let state = test_state();
        state.control.add_actions("blackjack", 42).await;
        state.pairing.observe(true);
        state.pairing.observe(true);
        state.pairing.observe(false);
        let snap = state.control.snapshot().await;
        let (colocated, split) = state.pairing.snapshot();
        let body = render_metrics(&snap, colocated, split);
        assert!(body.contains("tunnel_actions_total 42"), "got: {body}");
        assert!(body.contains("# TYPE tunnel_active gauge"));
        assert!(
            body.contains("tunnel_matches_colocated_total 2"),
            "got: {body}"
        );
        assert!(body.contains("tunnel_matches_split_total 1"), "got: {body}");
    }

    async fn response_body(resp: Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    // A settler whose faucet is configured (admin cap set) but whose RPC is unreachable — so the
    // config guards pass while any actual mint fails fast (connection refused).
    fn settler_with_admin_cap(rpc_url: &str) -> crate::sui::SuiSettler {
        use base64::Engine;
        let key = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
        let rpc =
            crate::sui_rpc::GovernedRpc::new(rpc_url.into(), crate::sui_rpc::RpcLimits::default());
        crate::sui::SuiSettler::new(rpc, "0x2", "0x2::sui::SUI", None, None, &key, Some("0x5"))
            .expect("settler with admin cap")
    }

    // The public faucet is 503 when the on-chain faucet is unconfigured (no AdminCap) — it never
    // claims a cooldown nor signs a mint it cannot complete. test_state has no admin cap.
    #[tokio::test]
    async fn faucet_disabled_without_admin_cap() {
        let state = test_state();
        let resp = faucet(
            State(state),
            Json(FaucetRequest {
                address: "0x9".into(),
                to_balance: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    // Once the per-address window is exhausted, the next pull is refused with 429 + Retry-After.
    // Pre-claim all `faucet_max_per_window` slots directly so the handler's own claim is the one
    // refused — no mint, no RPC.
    #[tokio::test]
    async fn faucet_rejects_pull_when_window_exhausted() {
        let mut state = test_state();
        std::sync::Arc::get_mut(&mut state)
            .expect("unique test arc")
            .settler = std::sync::Arc::new(settler_with_admin_cap("http://127.0.0.1:9999"));
        let recipient = crate::sui::canonical_address("0x9").unwrap();
        for _ in 0..state.faucet_max_per_window {
            assert!(
                state
                    .control
                    .claim_faucet_slot(
                        &recipient,
                        state.faucet_cooldown_secs,
                        state.faucet_max_per_window
                    )
                    .await
            );
        }
        let resp = faucet(
            State(state),
            Json(FaucetRequest {
                address: "0x9".into(),
                to_balance: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(
            resp.headers()
                .get(axum::http::header::RETRY_AFTER)
                .is_some(),
            "429 must carry Retry-After"
        );
    }

    // A failed mint frees the claimed slot, so a transient backend error doesn't burn one of the
    // window's allowed pulls. The settler's RPC is unreachable, so the mint errors after the slot
    // is claimed.
    #[tokio::test]
    async fn faucet_releases_slot_on_mint_failure() {
        let mut state = test_state();
        std::sync::Arc::get_mut(&mut state)
            .expect("unique test arc")
            .settler = std::sync::Arc::new(settler_with_admin_cap("http://127.0.0.1:9999"));
        let recipient = crate::sui::canonical_address("0x9").unwrap();
        let resp = faucet(
            State(state.clone()),
            Json(FaucetRequest {
                address: "0x9".into(),
                to_balance: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY, "mint failed");
        assert!(
            state.control.faucet_window_ttl(&recipient).await.is_none(),
            "slot freed so the pull wasn't counted against the window"
        );
    }

    // The internal faucet fails closed: with no FAUCET_ADMIN_TOKEN it is 503, never an open mint.
    #[tokio::test]
    async fn faucet_admin_disabled_without_token() {
        let state = test_state();
        let resp = faucet_admin(
            State(state),
            HeaderMap::new(),
            Json(AdminFaucetRequest {
                recipient: "0x9".into(),
                amount: None,
                to_balance: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    // With a token configured, a missing/wrong bearer is 401.
    #[tokio::test]
    async fn faucet_admin_requires_bearer() {
        let mut state = test_state();
        std::sync::Arc::get_mut(&mut state)
            .expect("unique test arc")
            .faucet_admin_token = Some("tok".into());
        let resp = faucet_admin(
            State(state),
            HeaderMap::new(),
            Json(AdminFaucetRequest {
                recipient: "0x9".into(),
                amount: None,
                to_balance: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // An over-cap amount is rejected (422) before any mint — mirrors the contract's MAX_MINT_PER_CALL.
    #[tokio::test]
    async fn faucet_admin_rejects_over_cap_amount() {
        let mut state = test_state();
        {
            let s = std::sync::Arc::get_mut(&mut state).expect("unique test arc");
            s.faucet_admin_token = Some("tok".into());
            s.settler = std::sync::Arc::new(settler_with_admin_cap("http://127.0.0.1:9999"));
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer tok".parse().unwrap(),
        );
        let resp = faucet_admin(
            State(state),
            headers,
            Json(AdminFaucetRequest {
                recipient: "0x9".into(),
                amount: Some(crate::sui::MAX_MINT_PER_CALL + 1),
                to_balance: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    // POST /v1/chat forwards messages to Ollama and returns the assistant reply.
    #[tokio::test]
    async fn chat_endpoint_forwards_to_ollama() {
        use crate::ollama::{OllamaClient, OllamaMessage};
        let mut state = test_state();
        let server = wiremock::MockServer::start().await;
        let body = serde_json::json!({ "message": { "role": "assistant", "content": "ok" } });
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/chat"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let ollama = OllamaClient::new(server.uri(), "qwen2.5:1.5b".into()).unwrap();
        std::sync::Arc::get_mut(&mut state)
            .expect("unique test arc")
            .ollama = ollama;

        let req = ChatRequest {
            messages: vec![OllamaMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            model: None,
            stream: None,
        };
        let resp = chat(axum::extract::State(state), axum::Json(req)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_body(resp).await).unwrap();
        assert_eq!(body["content"], "ok");
    }

    #[tokio::test]
    async fn chat_endpoint_returns_bad_gateway_on_ollama_error() {
        use crate::ollama::{OllamaClient, OllamaMessage};
        let mut state = test_state();
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/chat"))
            .respond_with(wiremock::ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let ollama = OllamaClient::new(server.uri(), "qwen2.5:1.5b".into()).unwrap();
        std::sync::Arc::get_mut(&mut state)
            .expect("unique test arc")
            .ollama = ollama;

        let req = ChatRequest {
            messages: vec![OllamaMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            model: None,
            stream: None,
        };
        let resp = chat(axum::extract::State(state), axum::Json(req)).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }

    // GET /v1/chat/topic asks Ollama for a short random conversation topic.
    #[tokio::test]
    async fn chat_topic_endpoint_returns_topic() {
        use crate::ollama::OllamaClient;
        let mut state = test_state();
        let server = wiremock::MockServer::start().await;
        let body =
            serde_json::json!({ "message": { "role": "assistant", "content": "space travel" } });
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/chat"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let ollama = OllamaClient::new(server.uri(), "qwen2.5:1.5b".into()).unwrap();
        std::sync::Arc::get_mut(&mut state)
            .expect("unique test arc")
            .ollama = ollama;

        let resp = chat_topic(axum::extract::State(state)).await;
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
    }
}

#[cfg(test)]
mod arena_tests {
    use super::*;
    use crate::state::AppState;

    fn game_req(id: &str) -> ArenaGameRequest {
        ArenaGameRequest {
            id: id.into(),
            user_eph_pubkey: format!("ueph_{id}"),
        }
    }

    // Co-located design (ADR-0005 addendum): `arena_opened` is a 204 no-op — the bot is spawned at
    // `arena.join`, not signalled here. The claim + spawn is covered by the `fleet::colocated` tests
    // (`second_join_is_rejected_not_double_spawned`, `join_and_spawn_settles_against_a_stand_in_human`).

    // No bots registered → allocate returns an empty list, never an error.
    #[tokio::test]
    async fn allocate_with_no_bots_is_empty() {
        let state = AppState::in_memory_for_test();
        let resp = arena_allocate(
            State(state),
            Json(ArenaAllocateRequest {
                user_address: "0xuser".into(),
                games: vec![game_req("blackjack")],
            }),
        )
        .await;
        assert!(resp.0.allocations.is_empty());
    }

    // On-demand seat-fill through the handler: with the co-located fleet configured (cap + game) and
    // NO warm bot, arena_allocate spawns a bot and allocates. Seat-fill no longer needs a warm pool,
    // only free capacity — this is the static-pool → on-demand cutover at the route boundary.
    #[tokio::test]
    async fn allocate_fills_a_seat_on_demand_when_fleet_configured() {
        let state = AppState::in_memory_with_arena_fleet(1, vec!["blackjack".into()]);
        let resp = arena_allocate(
            State(state),
            Json(ArenaAllocateRequest {
                user_address: "0xuser".into(),
                games: vec![game_req("blackjack")],
            }),
        )
        .await;
        assert_eq!(
            resp.0.allocations.len(),
            1,
            "a configured game fills on demand with no warm bot"
        );
        assert!(
            !resp.0.allocations[0].bot_eph_pubkey.is_empty(),
            "the on-demand bot has a fresh ephemeral key"
        );
    }

    // The `FLEET_COLOCATED_GAMES` gate: a game NOT in the served set has an effective cap of 0, so
    // even with the fleet enabled it is omitted — no bot is spawned for an untrusted/unlisted game.
    #[tokio::test]
    async fn allocate_omits_a_game_outside_the_served_set() {
        let state = AppState::in_memory_with_arena_fleet(1, vec!["blackjack".into()]);
        let resp = arena_allocate(
            State(state),
            Json(ArenaAllocateRequest {
                user_address: "0xuser".into(),
                games: vec![game_req("quantum_poker")], // enabled fleet, but not in the served set
            }),
        )
        .await;
        assert!(
            resp.0.allocations.is_empty(),
            "a game outside FLEET_COLOCATED_GAMES is not served"
        );
    }

    // The Design-1 batching invariant at the handler seam: every game in one allocate request shares
    // ONE seat-B on-chain address (so their opens collapse into a single-sender PTB), while match id,
    // tunnel, and the co-signing ephemeral pubkey stay DISTINCT per game. A regression that gave games
    // distinct addresses would silently defeat batching (each open needs its own sender); one that
    // shared the ephemeral key would break per-match co-signing.
    #[tokio::test]
    async fn allocate_shares_one_bot_address_but_keeps_per_match_identity_distinct() {
        let games = ["blackjack", "caro", "tic_tac_toe"];
        let state =
            AppState::in_memory_with_arena_fleet(3, games.iter().map(|g| g.to_string()).collect());
        let resp = arena_allocate(
            State(state),
            Json(ArenaAllocateRequest {
                user_address: "0xuser".into(),
                games: games.iter().map(|g| game_req(g)).collect(),
            }),
        )
        .await;

        let allocs = &resp.0.allocations;
        assert_eq!(
            allocs.len(),
            3,
            "all three served + profiled games allocate"
        );

        let uniq = |f: &dyn Fn(&ArenaAllocation) -> String| {
            allocs
                .iter()
                .map(f)
                .collect::<std::collections::HashSet<_>>()
                .len()
        };
        assert_eq!(
            uniq(&|a| a.bot_address.clone()),
            1,
            "one shared seat-B address across the whole batch"
        );
        assert_eq!(
            uniq(&|a| a.match_id.clone()),
            3,
            "distinct match id per game"
        );
        assert_eq!(
            uniq(&|a| a.tunnel_id.clone()),
            3,
            "distinct tunnel per game"
        );
        assert_eq!(
            uniq(&|a| a.bot_eph_pubkey.clone()),
            3,
            "distinct co-signing ephemeral pubkey per match"
        );

        for a in allocs {
            let profile =
                fleet_core::play_match::profile_for(&a.game).expect("served game has a profile");
            assert_eq!(
                a.stake_each, profile.stake_each,
                "stake comes from the game profile"
            );
        }
    }
}
