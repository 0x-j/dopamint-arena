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
    use axum::http::HeaderMap;

    use crate::state::{AppState, SessionRecord, SharedState};

    /// Shared `AppState` builder for unit tests across modules.
    pub(crate) fn test_state() -> SharedState {
        use base64::Engine;
        let key = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
        let settler = crate::sui::SuiSettler::new(
            "http://127.0.0.1:9999".into(),
            "0x2",
            "0x2::sui::SUI",
            None,
            None,
            &key,
        )
        .expect("test settler");
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
            enoki: None,
            walrus,
            ollama,
            stats_tx,
            actions: crate::stats_counter::LocalActionCounter::default(),
            pair_hold_ms: 750,
            pairing: crate::stats_counter::MatchPairingMetrics::default(),
            chat: crate::chat_store::ChatTranscriptStore::new(),
        })
    }

    /// Register a fixed test session with a known bearer token.
    pub(crate) async fn register_test_session(state: &SharedState, token: &str) -> String {
        let session_id = "sess_test".to_string();
        state
            .control
            .put_session(
                &session_id,
                SessionRecord {
                    game: "chat".into(),
                    tunnels: vec![],
                    stats_token: token.into(),
                },
            )
            .await;
        session_id
    }

    /// Build an `Authorization: Bearer <token>` header map.
    pub(crate) fn auth_headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {}", token).parse().unwrap(),
        );
        headers
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

const SETTLE_BODY_VERSION: u8 = 0x01;
const SETTLE_BODY_HEADER_LEN: usize = 229;

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

    let a = p.party_a_balance;
    let b = p.party_b_balance;
    let ts = p.timestamp;
    // The explorer row stores the root as `0x`-prefixed hex (verifyTranscript re-checks it).
    let transcript_root_hex = format!("0x{}", hex::encode(&p.transcript_root));

    let close = crate::sui::CloseArgs {
        tunnel_id: tunnel_id.clone(),
        party_a_balance: a,
        party_b_balance: b,
        sig_a: p.sig_a,
        sig_b: p.sig_b,
        timestamp: ts,
        transcript_root: p.transcript_root,
    };
    match state.settler.submit_close(close).await {
        Ok(digest) => {
            // The close landed on-chain: record it in the event-derived registry so a duplicate
            // /settle is rejected for free by the 409 guard above (no chain dry-run). Without this
            // the guard is dead in production, since the in-process chain status poller is disabled.
            state
                .control
                .set_tunnel_status(&tunnel_id, crate::state::TunnelStatus::Closed)
                .await;
            // Archive the body verbatim — the blob IS the settle body. The in-browser verifier
            // (verifyTranscript) parses the same fixed-offset bytes and re-checks the
            // co-signed root against the recomputed Merkle root and the on-chain anchor.
            let (blob_id, proof_url) = match state.walrus.upload_transcript(body.to_vec()).await {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!(%digest, error = %e, "walrus archival failed");
                    (String::new(), String::new())
                }
            };
            state
                .control
                .push_recent_event(settled_event(
                    &tunnel_id,
                    a,
                    b,
                    &transcript_root_hex,
                    &digest,
                    ts,
                    &proof_url,
                ))
                .await;
            if !blob_id.is_empty() {
                let proof_msg = serde_json::json!({
                    "txDigest": digest,
                    "walrusBlobId": blob_id,
                    "proofUrl": proof_url,
                })
                .to_string();
                state.bus.publish_raw("explorer:proofs", proof_msg).await;
            }
            Json(serde_json::json!({ "txDigest": digest, "walrusBlobId": blob_id, "proofUrl": proof_url }))
                .into_response()
        }
        Err(e) => {
            tracing::warn!(tunnel_id = %tunnel_id, error = %e, "settle close failed");
            ApiError::resp(
                StatusCode::UNPROCESSABLE_ENTITY,
                "settle_failed",
                &e.to_string(),
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

/// Proxy a non-streaming chat request to the configured Ollama model.
pub(crate) async fn chat(
    State(state): State<SharedState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<ChatRequest>,
) -> Response {
    if let Err(resp) = require_session_auth(&state, &session_id, &headers).await {
        return resp;
    }
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
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<PublishChatRequest>,
) -> Response {
    if let Err(resp) = require_session_auth(&state, &session_id, &headers).await {
        return resp;
    }
    for msg in req.messages {
        state.chat.publish(msg).await;
    }
    StatusCode::NO_CONTENT.into_response()
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
pub(crate) async fn chat_topic(
    State(state): State<SharedState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_session_auth(&state, &session_id, &headers).await {
        return resp;
    }
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
fn settled_event(
    tunnel_id: &str,
    party_a_balance: u64,
    party_b_balance: u64,
    transcript_root_hex: &str,
    tx_digest: &str,
    timestamp_ms: u64,
    proof_url: &str,
) -> crate::state::TunnelEvent {
    let non_empty = |s: &str| (!s.is_empty()).then(|| s.to_string());
    crate::state::TunnelEvent {
        tunnel_id: tunnel_id.to_string(),
        kind: crate::state::TunnelEventKind::Settled,
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

/// Look up `session_id` and require a matching `Authorization: Bearer` token.
async fn require_session_auth(
    state: &SharedState,
    session_id: &str,
    headers: &HeaderMap,
) -> Result<SessionRecord, Response> {
    let Some(rec) = state.control.get_session(session_id).await else {
        return Err(ApiError::resp(
            StatusCode::NOT_FOUND,
            "unknown_session",
            "no such session",
        )
        .into_response());
    };
    if !bearer_matches(headers, &rec.stats_token) {
        return Err(ApiError::resp(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token",
        )
        .into_response());
    }
    Ok(rec)
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
    use super::test_support::{auth_headers, register_test_session, test_state};
    use super::*;
    use crate::ollama::{OllamaClient, OllamaMessage};

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
            1500,
            500,
            "deadbeef",
            "DiG",
            1_750_000_000_000,
            "https://agg/v1/blobs/abc",
        );
        assert_eq!(ev.kind, crate::state::TunnelEventKind::Settled);
        assert_eq!(ev.party_a_balance, Some(1500));
        assert_eq!(ev.transcript_root.as_deref(), Some("deadbeef"));
        assert_eq!(ev.tx_digest, "DiG");
        assert_eq!(ev.proof_url.as_deref(), Some("https://agg/v1/blobs/abc"));
    }

    // Walrus archival failure (empty url/root) must degrade to an explorer-only row, never a
    // broken link or anchor.
    #[test]
    fn settled_event_omits_proof_on_walrus_failure() {
        let ev = settled_event("0xT", 1, 1, "", "DiG", 1, "");
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

    fn chat_request() -> ChatRequest {
        ChatRequest {
            messages: vec![OllamaMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            model: None,
            stream: None,
        }
    }

    async fn install_mock_ollama(state: &mut SharedState) -> wiremock::MockServer {
        let server = wiremock::MockServer::start().await;
        let ollama = OllamaClient::new(server.uri(), "qwen2.5:1.5b".into()).unwrap();
        std::sync::Arc::get_mut(state)
            .expect("unique test arc")
            .ollama = ollama;
        server
    }

    // POST /v1/chat forwards messages to Ollama and returns the assistant reply.
    #[tokio::test]
    async fn chat_endpoint_forwards_to_ollama() {
        let mut state = test_state();
        let server = install_mock_ollama(&mut state).await;
        let body = serde_json::json!({ "message": { "role": "assistant", "content": "ok" } });
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/chat"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let session_id = register_test_session(&state, "tok").await;

        let resp = chat(
            axum::extract::State(state),
            axum::extract::Path(session_id),
            auth_headers("tok"),
            axum::Json(chat_request()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_body(resp).await).unwrap();
        assert_eq!(body["content"], "ok");
    }

    #[tokio::test]
    async fn chat_endpoint_rejects_missing_bearer_token() {
        let state = test_state();
        let session_id = register_test_session(&state, "tok").await;
        let resp = chat(
            axum::extract::State(state),
            axum::extract::Path(session_id),
            HeaderMap::new(),
            axum::Json(chat_request()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn chat_endpoint_rejects_wrong_bearer_token() {
        let state = test_state();
        let session_id = register_test_session(&state, "tok").await;
        let resp = chat(
            axum::extract::State(state),
            axum::extract::Path(session_id),
            auth_headers("wrong"),
            axum::Json(chat_request()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn chat_endpoint_rejects_unknown_session() {
        let state = test_state();
        let resp = chat(
            axum::extract::State(state),
            axum::extract::Path("sess_does_not_exist".into()),
            auth_headers("tok"),
            axum::Json(chat_request()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn chat_endpoint_returns_bad_gateway_on_ollama_error() {
        let mut state = test_state();
        let server = install_mock_ollama(&mut state).await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/chat"))
            .respond_with(wiremock::ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let session_id = register_test_session(&state, "tok").await;

        let resp = chat(
            axum::extract::State(state),
            axum::extract::Path(session_id),
            auth_headers("tok"),
            axum::Json(chat_request()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }

    // GET /v1/chat/topic asks Ollama for a short random conversation topic.
    #[tokio::test]
    async fn chat_topic_endpoint_returns_topic() {
        let mut state = test_state();
        let server = install_mock_ollama(&mut state).await;
        let body =
            serde_json::json!({ "message": { "role": "assistant", "content": "space travel" } });
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/chat"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let session_id = register_test_session(&state, "tok").await;

        let resp = chat_topic(
            axum::extract::State(state),
            axum::extract::Path(session_id),
            auth_headers("tok"),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_body(resp).await).unwrap();
        assert_eq!(body["topic"], "space travel");
    }

    #[tokio::test]
    async fn chat_topic_rejects_missing_bearer_token() {
        let state = test_state();
        let session_id = register_test_session(&state, "tok").await;
        let resp = chat_topic(
            axum::extract::State(state),
            axum::extract::Path(session_id),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn chat_topic_rejects_wrong_bearer_token() {
        let state = test_state();
        let session_id = register_test_session(&state, "tok").await;
        let resp = chat_topic(
            axum::extract::State(state),
            axum::extract::Path(session_id),
            auth_headers("wrong"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn chat_topic_rejects_unknown_session() {
        let state = test_state();
        let resp = chat_topic(
            axum::extract::State(state),
            axum::extract::Path("sess_does_not_exist".into()),
            auth_headers("tok"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn chat_publish_rejects_missing_bearer_token() {
        let state = test_state();
        let session_id = register_test_session(&state, "tok").await;
        let req = PublishChatRequest {
            messages: vec![crate::chat_store::ChatMessage {
                sender: "bot".into(),
                text: "hi".into(),
            }],
        };
        let resp = chat_publish(
            axum::extract::State(state),
            axum::extract::Path(session_id),
            HeaderMap::new(),
            axum::Json(req),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn chat_publish_rejects_wrong_bearer_token() {
        let state = test_state();
        let session_id = register_test_session(&state, "tok").await;
        let req = PublishChatRequest {
            messages: vec![crate::chat_store::ChatMessage {
                sender: "bot".into(),
                text: "hi".into(),
            }],
        };
        let resp = chat_publish(
            axum::extract::State(state),
            axum::extract::Path(session_id),
            auth_headers("wrong"),
            axum::Json(req),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn chat_publish_rejects_unknown_session() {
        let state = test_state();
        let req = PublishChatRequest {
            messages: vec![crate::chat_store::ChatMessage {
                sender: "bot".into(),
                text: "hi".into(),
            }],
        };
        let resp = chat_publish(
            axum::extract::State(state),
            axum::extract::Path("sess_does_not_exist".into()),
            auth_headers("tok"),
            axum::Json(req),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
