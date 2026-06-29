//! Shared application state + the stats wire types.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::archive_queue::ArchiveQueue;
use crate::s3::TranscriptArchiver;

pub struct AppState {
    pub control: std::sync::Arc<dyn crate::store::ControlStore>,
    pub mp: std::sync::Arc<dyn crate::store::MpStore>,
    pub bus: std::sync::Arc<dyn crate::store::Bus>,
    pub settler: crate::sui::SuiSettler,
    /// Enoki sponsored-tx client when configured (ADR-0014): the primary gas sponsor, with
    /// `settler` as the fallback. `None` = settler-only.
    pub enoki: Option<crate::enoki::EnokiClient>,
    pub walrus: crate::walrus::WalrusClient,
    /// S3 transcript archiver (ADR-0023). `None` when S3 is unconfigured (dev/test) —
    /// archival is then disabled. Concurrent with Walrus; Walrus is untouched.
    pub archiver: Option<Arc<dyn TranscriptArchiver>>,
    /// Durable retry queue for S3 archival. `None` when unconfigured.
    pub archive_queue: Option<Arc<dyn ArchiveQueue>>,
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
}

pub type SharedState = std::sync::Arc<AppState>;

#[cfg(any(test, feature = "test-util"))]
impl AppState {
    /// Build an in-memory-backed `SharedState` for unit tests. Mirrors the no-Redis branch in
    /// `main.rs`: `InMemoryControlStore`, `InMemoryMpStore`, `LocalBus`. No network I/O; always
    /// synchronous and deterministic.
    pub fn in_memory_for_test() -> SharedState {
        use std::sync::Arc;

        use crate::store::memory::{InMemoryControlStore, InMemoryMpStore, LocalBus};

        let (stats_tx, _) = broadcast::channel(4);
        Arc::new(AppState {
            control: Arc::new(InMemoryControlStore::default()),
            mp: Arc::new(InMemoryMpStore::default()),
            bus: Arc::new(LocalBus::new("test-instance".to_owned())),
            settler: crate::sui::SuiSettler::noop(),
            enoki: None,
            walrus: crate::walrus::WalrusClient::noop(),
            archiver: None,
            archive_queue: None,
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
        assert_eq!(j["partyABalance"], 1500);
        assert_eq!(j["txDigest"], "DiGeStXyZ");
        assert_eq!(j["proofUrl"], "https://agg/v1/blobs/abc");
    }
}
