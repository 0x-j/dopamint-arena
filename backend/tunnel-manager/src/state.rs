//! Shared application state + the stats wire types.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::s3::TranscriptArchiver;

pub struct AppState {
    pub control: std::sync::Arc<dyn crate::store::ControlStore>,
    pub mp: std::sync::Arc<dyn crate::store::MpStore>,
    pub bus: std::sync::Arc<dyn crate::store::Bus>,
    /// Shared (`Arc`): the arena opener has the settler sponsor each bot open's gas (ADR-0028) and
    /// the async settle-worker pool holds it as a `BatchSettler` — one settler instance (and one
    /// `sponsor_nonce`) backs opens, faucet, `/settle`, and user sponsors.
    pub settler: std::sync::Arc<crate::sui::SuiSettler>,
    /// Durable settle queue (ADR-0029): `/settle` enqueues here and returns 202; the worker pool
    /// drains it, coalescing many closes into one PTB.
    pub settle_queue: std::sync::Arc<dyn crate::settle_queue::SettleQueue>,
    /// Enoki sponsored-tx client when configured (ADR-0014): the primary gas sponsor, with
    /// `settler` as the fallback. `None` = settler-only.
    pub enoki: Option<crate::enoki::EnokiClient>,
    pub walrus: crate::walrus::WalrusClient,
    /// S3 transcript archiver (ADR-0023). `None` when S3 is unconfigured (dev/test) —
    /// archival is then disabled. Concurrent with Walrus; Walrus is untouched.
    pub archiver: Option<Arc<dyn TranscriptArchiver>>,
    /// S3 object-key prefix for transcript archival (e.g. "prod/"). Empty when unset.
    pub s3_prefix: String,
    /// S3 transcript *chunk* writer — the streaming counterpart to `archiver` (same bucket). Used on
    /// the recorder's `finish()` path (tail chunk + manifest seal). `None` = no S3.
    pub chunk_writer: Option<Arc<dyn transcript_store::TranscriptChunkWriter>>,
    /// Sender into the per-instance bounded transcript uploader — the byte-budget that keeps
    /// streaming RAM-safe under S3 slowdown (producers block when it's full). `None` = no S3.
    pub chunk_upload_tx: Option<tokio::sync::mpsc::Sender<transcript_stream::ChunkUpload>>,
    #[allow(dead_code)] // TODO(chat-v2): used by chat routes in Task 4
    pub ollama: crate::ollama::OllamaClient,
    /// Latest aggregate snapshot is computed once per tick and fanned out here to
    /// every SSE subscriber — so cost scales with the audience, not with TPS.
    pub stats_tx: broadcast::Sender<String>,
    /// Per-instance move counter; flushed to `control` once/sec (see stats_counter).
    pub actions: crate::stats_counter::LocalActionCounter,
    /// Matchmaking hold in ms: how long a joiner waits for a same-instance partner
    /// before falling back to a cross-instance opponent. From `MP_PAIR_HOLD_MS`.
    pub pair_hold_ms: u64,
    /// Per-instance co-located-vs-split pairing tally (see stats_counter).
    pub pairing: crate::stats_counter::MatchPairingMetrics,
    /// Shared transcript for the bot-vs-bot live chat feed, fanned out via SSE.
    pub chat: crate::chat_store::ChatTranscriptStore,
    /// Arena bot pool for one-signature allocation (ADR-0026), backing on-demand co-located seat-fill.
    /// Per-instance, in-memory.
    pub fleet: crate::fleet::BotPool,
    /// On-chain tunnel-open seam for the arena 1a flow (ADR-0028): the fleet creates + funds seat B at
    /// allocate so the user's open is deposit-only. `SuiArenaOpener` when the wallet pool + on-chain
    /// config are set, else `Noop` (dev/test).
    pub arena_opener: std::sync::Arc<dyn crate::fleet::arena_opener::ArenaTunnelOpener>,
    /// Max co-located arena bot tasks spawned per instance (config `FLEET_COLOCATED_COUNT`). Enforced
    /// at `arena.join` where the bot is spawned; total fan-out is this × instances. `0` (default)
    /// serves no co-located bots (`.max(1)` at the join site keeps a single-slot dev default usable).
    pub arena_fleet_count: u32,
    /// Games the co-located fleet serves (config `FLEET_COLOCATED_GAMES`). A game not in this set has
    /// an effective cap of 0 — the trusted-subset gate (a `play_game` arm may exist before it's live).
    pub arena_fleet_games: std::collections::HashSet<String>,
    /// Funded seat-B identity source (PR #124): `Some` when `WALLET_POOL_ID` is configured, else
    /// `None` (on-demand bots use the deterministic placeholder address). Shared (`Arc`) with the
    /// `SuiArenaOpener`, which signs each open as the checked-out member.
    pub wallet_pool: Option<std::sync::Arc<crate::wallet::WalletPoolSource>>,
    /// Whole-token MTPS one public-faucet pull mints (config `FAUCET_USER_AMOUNT`).
    pub faucet_user_amount: u64,
    /// Whole-token MTPS the internal faucet mints by default (config `FAUCET_INTERNAL_AMOUNT`);
    /// capped at `crate::sui::MAX_MINT_PER_CALL`.
    pub faucet_internal_amount: u64,
    /// Public-faucet rate-limit window, seconds (config `FAUCET_COOLDOWN_SECS`).
    pub faucet_cooldown_secs: i64,
    /// Max public-faucet pulls per address within one window (config `FAUCET_MAX_PER_WINDOW`).
    pub faucet_max_per_window: u32,
    /// Shared bearer secret gating the internal faucet; `None` disables it (fail closed).
    pub faucet_admin_token: Option<String>,
}

pub type SharedState = std::sync::Arc<AppState>;

#[cfg(any(test, feature = "test-util"))]
impl AppState {
    /// Build an in-memory-backed `SharedState` for unit tests. Mirrors the no-Redis branch in
    /// `main.rs`: `InMemoryControlStore`, `InMemoryMpStore`, `LocalBus`. No network I/O; always
    /// synchronous and deterministic.
    pub fn in_memory_for_test() -> SharedState {
        Self::in_memory_with_arena_fleet(0, Vec::new())
    }

    /// Like [`in_memory_for_test`] but with the co-located arena fleet configured, so tests can
    /// exercise on-demand seat-fill (`reserve_or_spawn`) through `arena_allocate`.
    pub fn in_memory_with_arena_fleet(count: u32, games: Vec<String>) -> SharedState {
        use std::sync::Arc;

        use crate::store::memory::{InMemoryControlStore, InMemoryMpStore, LocalBus};

        let (stats_tx, _) = broadcast::channel(4);
        Arc::new(AppState {
            control: Arc::new(InMemoryControlStore::default()),
            mp: Arc::new(InMemoryMpStore::default()),
            bus: Arc::new(LocalBus::new("test-instance".to_owned())),
            settler: Arc::new(crate::sui::SuiSettler::noop()),
            settle_queue: Arc::new(crate::settle_queue::InMemorySettleQueue::default()),
            enoki: None,
            walrus: crate::walrus::WalrusClient::noop(),
            archiver: None,
            s3_prefix: "".into(),
            chunk_writer: None,
            chunk_upload_tx: None,
            ollama: crate::ollama::OllamaClient::new(
                "http://localhost:11434".into(),
                "qwen2.5:1.5b".into(),
            )
            .expect("test ollama client"),
            stats_tx,
            actions: crate::stats_counter::LocalActionCounter::default(),
            pair_hold_ms: 750,
            pairing: crate::stats_counter::MatchPairingMetrics::default(),
            chat: crate::chat_store::ChatTranscriptStore::new(),
            fleet: crate::fleet::BotPool::default(),
            arena_opener: Arc::new(crate::fleet::arena_opener::NoopArenaOpener),
            arena_fleet_count: count,
            arena_fleet_games: games.into_iter().collect(),
            wallet_pool: None,
            faucet_user_amount: 10_000,
            faucet_internal_amount: 1_000_000,
            faucet_cooldown_secs: 1_800,
            faucet_max_per_window: 5,
            faucet_admin_token: None,
        })
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionRecord {
    pub game: String,
    pub tunnels: Vec<crate::routes::TunnelRef>,
    /// Bearer token returned by `POST /sessions`; required on this session's writes.
    pub stats_token: String,
}

/// A tunnel's lifecycle status, derived from on-chain events (ADR-0002: events are
/// the authoritative registry; `POST /sessions` is advisory grouping only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus {
    Created,
    Active,
    Closed,
}

// ===== Stats wire types — JSON is camelCase to match the SDK (see ADR-0002). =====

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    pub tps: f64,
    /// Running max of `tps` since process/cluster start (maintained, never recomputed).
    pub peak_tps: f64,
    pub total_actions: u64,
    pub active_tunnels: u64,
    pub settled_tunnels: u64,
    pub per_game: HashMap<String, GameStat>,
    /// Newest-first ring of recent lifecycle rows (bounded; see store::RECENT_EVENTS_CAP).
    pub recent_events: Vec<TunnelEvent>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GameStat {
    pub tps: f64,
    pub tunnels: u64,
    /// Cumulative actions attributed to this game (basis for `tps`'s per-tick delta).
    pub total_actions: u64,
}

/// One displayable tunnel lifecycle row for the global Transaction Log — a settlement
/// projection (ADR-0005), sourced from the chain events the indexer already folds. The
/// durable record stays on-chain + Walrus; this is an ephemeral display projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelEvent {
    pub tunnel_id: String,
    pub kind: TunnelEventKind,
    /// On-chain parties (from `TunnelCreated`) — `None` when ownership was not captured.
    pub party_a: Option<String>,
    pub party_b: Option<String>,
    /// The open tx sender (the funding wallet) — distinguishes the owner in self-play, where
    /// both parties are ephemerals. `None` when not captured.
    pub funder: Option<String>,
    /// Game id joined from the session registry; `None`/PvP rows have no tag.
    pub game: Option<String>,
    /// Payout balances — present on `settled` rows.
    pub party_a_balance: Option<u64>,
    pub party_b_balance: Option<u64>,
    /// 32-byte transcript root, hex — present only on a with-root cooperative close.
    pub transcript_root: Option<String>,
    /// The lifecycle tx digest — the block-explorer link.
    pub tx_digest: String,
    pub timestamp_ms: u64,
    /// Walrus transcript URL — present only on a backend-settled row (the `/settle` handler
    /// supplies it; indexer-sourced rows are explorer-only). Set in Task 7; see spec §6.
    pub proof_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelEventKind {
    Opened,
    Settled,
}

/// Set-once ownership for a tunnel, captured at `TunnelCreated`. Inherited by the displayed
/// Opened/Settled rows (whose own events carry no addresses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelOwner {
    pub party_a: Option<String>,
    pub party_b: Option<String>,
    pub funder: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // The wire JSON must be camelCase to match the SDK/frontend (ADR-0002): a settled
    // event carries payout + root + digest; the kind is a lowercase tag.
    #[test]
    fn tunnel_event_serializes_camelcase() {
        let ev = TunnelEvent {
            tunnel_id: "0xabc".into(),
            kind: TunnelEventKind::Settled,
            party_a: Some("0xaaa".into()),
            party_b: Some("0xbbb".into()),
            funder: Some("0xfff".into()),
            game: Some("blackjack".into()),
            party_a_balance: Some(1500),
            party_b_balance: Some(500),
            transcript_root: Some("deadbeef".into()),
            tx_digest: "DiGeStXyZ".into(),
            timestamp_ms: 1_750_000_000_000,
            proof_url: Some("https://agg/v1/blobs/abc".into()),
        };
        let j = serde_json::to_value(&ev).unwrap();
        assert_eq!(j["tunnelId"], "0xabc");
        assert_eq!(j["kind"], "settled");
        assert_eq!(j["partyA"], "0xaaa");
        assert_eq!(j["funder"], "0xfff");
        assert_eq!(j["game"], "blackjack");
        assert_eq!(j["partyABalance"], 1500);
        assert_eq!(j["txDigest"], "DiGeStXyZ");
        assert_eq!(j["proofUrl"], "https://agg/v1/blobs/abc");
    }
}
