//! Storage seam: the in-memory impl (today's maps/atomics; tests + local dev) and the Redis
//! impl (prod/HA) live behind these traits. Handlers hold `Arc<dyn …>` and never see Redis.
//!
//! ## Aggregation invariant
//! Each instance pushes only its own deltas into a merge-commutative primitive; no method
//! read-modify-writes a shared aggregate. Three shapes: counts → `INCRBY` (grow-only,
//! order-independent); membership → `SADD`/`SREM` (idempotent union); owned/last-writer →
//! single key + CAS (Lua), never summed. The move counter is at-most-once (undercount-safe):
//! it only ever pushes already-counted deltas, so it never inflates — do NOT add flush
//! retries, which would make it at-least-once and double-count.

pub mod memory;
pub mod redis;

use async_trait::async_trait;

/// Bounded depth of the recent-events display ring (ADR-0005). Newest-first; older rows
/// fall off. The durable record lives on-chain + Walrus, so this is display-only.
pub const RECENT_EVENTS_CAP: usize = 50;

/// Bounded depth of the set-once `tunnel_id → owner` map. Generous vs. the 50-row display
/// window; on a miss ownership degrades to `None` (no highlight), so a cap is always safe.
pub const TUNNEL_OWNER_CAP: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConnRef {
    pub instance_id: String,
    pub conn_id: crate::mp::ConnId,
}

#[async_trait]
pub trait ControlStore: Send + Sync {
    async fn put_session(&self, id: &str, rec: crate::state::SessionRecord);
    async fn get_session(&self, id: &str) -> Option<crate::state::SessionRecord>;
    async fn set_tunnel_status(&self, id: &str, s: crate::state::TunnelStatus);
    async fn get_tunnel_status(&self, id: &str) -> Option<crate::state::TunnelStatus>;
    async fn add_actions(&self, game: &str, delta: u64);
    /// Fold the latest `tps` into the maintained peak (running max). Idempotent on a lower value.
    async fn update_peak_tps(&self, tps: f64);
    /// Cumulative snapshot; `tps` is filled by the broadcaster from its per-tick diff.
    async fn snapshot(&self) -> crate::state::StatsSnapshot;
    /// Append a displayable lifecycle row to the bounded recent-events ring, idempotent by
    /// `tx_digest` (cursor-restart replays and multi-instance indexers must not double-insert).
    async fn push_recent_event(&self, ev: crate::state::TunnelEvent);
    /// The ring, newest-first, capped at `RECENT_EVENTS_CAP`.
    async fn recent_events(&self) -> Vec<crate::state::TunnelEvent>;
    // ADR-0014 ownership join: written by the indexer at `TunnelCreated`, read when enriching rows.
    /// Record tunnel ownership, set-once (first writer wins; replays are no-ops). Bounded.
    async fn set_tunnel_owner(&self, tunnel_id: &str, owner: crate::state::TunnelOwner);
    /// Look up captured ownership, or `None` if not seen / evicted.
    async fn get_tunnel_owner(&self, tunnel_id: &str) -> Option<crate::state::TunnelOwner>;
    /// The game a tunnel belongs to, joined from the session registry; `None` for PvP/unknown.
    async fn tunnel_game(&self, tunnel_id: &str) -> Option<String>;
    /// Tag a tunnel with its game directly — the arena path reserves a match (no `put_session`),
    /// so it records the join here. Same map `tunnel_game` reads.
    async fn set_tunnel_game(&self, tunnel_id: &str, game: &str);
    /// Claim one faucet slot for `address` in a fixed `window_secs` window that allows up to
    /// `max_per_window` pulls. Returns `true` when within the limit (a slot is consumed), `false`
    /// when the window is exhausted. The window starts on the first pull and resets `window_secs`
    /// later. On a store error returns `false` (fail closed — a cache blip never enables an
    /// unmetered mint). The caller passes a canonical address; this is the per-recipient rate limit.
    async fn claim_faucet_slot(&self, address: &str, window_secs: i64, max_per_window: u32)
        -> bool;
    /// Seconds until `address`'s current window resets, or `None` if no window is active — feeds
    /// `Retry-After` when the limit is hit.
    async fn faucet_window_ttl(&self, address: &str) -> Option<i64>;
    /// Give back a slot for `address` (a claimed pull whose mint then failed), so a transient error
    /// does not burn one of the window's allowed pulls.
    async fn release_faucet_slot(&self, address: &str);
    /// PING the cache cluster (for /health/ready). In-memory is always ready.
    async fn ready(&self) -> bool;
}

/// The recipe for one reserved arena match, seeded at `allocate` and consumed at `arena.join` to
/// spawn the bot on the SAME instance as the user's socket (co-location — no cross-instance relay).
/// Everything the join-instance needs to reconstruct party B; the running bot is never stored, only
/// this recipe. `eph_secret_hex` is the bot's per-match co-signing secret — low-sensitivity (fake
/// stake token, honest bot, funds protected on-chain by the tunnel's dispute path).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct ArenaReservation {
    pub game: String,
    /// Party A wallet — the user who allocated. Authorizes the join.
    pub seat_a: String,
    /// Party B — the bot's on-chain address (funded at allocate).
    pub seat_b: String,
    pub tunnel_id: String,
    pub eph_secret_hex: String,
    /// The tunnel's on-chain `created_at` (ms), captured at allocate from the object read that already
    /// correlates seat B. The bot signs its settle half with `timestamp = created_at` (matching the FE,
    /// which reads the same field), so carrying it here lets the bot do ZERO chain IO before its first
    /// move — a stalled Sui RPC on that path is what left bots spawned-but-silent. `#[serde(default)]`
    /// so a reservation seeded before this field existed decodes to 0 during rollout.
    #[serde(default)]
    pub created_at_ms: u64,
}

/// Result of an atomic `claim_arena`. Exactly one caller ever gets `Claimed` for a given match, so
/// exactly one bot is spawned even under a double-join (reconnect / StrictMode double-mount).
pub enum ArenaClaim {
    Claimed(ArenaReservation),
    NotFound,
    ForeignWallet,
    AlreadyClaimed,
}

#[async_trait]
pub trait MpStore: Send + Sync {
    async fn set_presence(&self, wallet: &str, at: ConnRef);
    async fn get_presence(&self, wallet: &str) -> Option<ConnRef>;
    async fn clear_presence_if(&self, wallet: &str, conn: crate::mp::ConnId);
    /// Join the queue. Same-instance opponents are preferred; if none, a different-wallet waiter
    /// past its hold deadline is taken; else parks self with `deadline = now + hold_ms`.
    async fn join_or_pair(
        &self,
        game: &str,
        me: crate::mp::Waiting,
        hold_ms: u64,
    ) -> Option<crate::mp::Waiting>;
    /// Timer-driven cross-instance fallback: if `wallet` is still parked in `game`'s queue,
    /// pair it with the oldest different-wallet waiter and return that opponent; else `None`.
    async fn fallback_pair(&self, game: &str, wallet: &str) -> Option<crate::mp::Waiting>;
    async fn leave_queue(&self, game: &str, wallet: &str);
    async fn put_invite(&self, match_id: &str, inv: crate::mp::DirectedInvite);
    async fn take_invite(
        &self,
        match_id: &str,
        accepter: &str,
    ) -> Option<crate::mp::DirectedInvite>;
    async fn drop_invite(&self, match_id: &str);
    async fn put_match(&self, match_id: &str, m: crate::mp::MatchRecord);
    async fn get_match(&self, match_id: &str) -> Option<crate::mp::MatchRecord>;
    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str);
    async fn record_checkpoint(&self, match_id: &str, cp: crate::mp::Checkpoint);
    /// Rebind a seat's live connection after a reconnect. Authorized by seat ownership:
    /// rebinds `conn_a` iff `wallet == seat_a`, else `conn_b` iff `wallet == seat_b`, else
    /// no-op. Refreshes the record TTL. Returns the rebound seat, or `None` if the match is
    /// gone or the wallet owns no seat. Atomic (last-writer-wins per seat).
    async fn rebind_match_conn(
        &self,
        match_id: &str,
        wallet: &str,
        at: ConnRef,
    ) -> Option<crate::mp::Seat>;
    /// Seed a pending arena match at allocate; TTL-bounded so a user who never joins simply expires.
    async fn put_arena_reservation(&self, match_id: &str, rec: ArenaReservation);
    /// Atomically claim a reserved match for play: verify `wallet` is the allocator (seat A) and no
    /// one has claimed it yet, mark it claimed, and return the recipe. The one `Claimed` caller
    /// spawns the bot; every other join gets a non-`Claimed` outcome.
    async fn claim_arena(&self, match_id: &str, wallet: &str) -> ArenaClaim;
}

/// Per-connection control signal routed over the bus ctrl channel (parallel to the hot-path
/// client channel). `Evict` drops a match from the connection's relay cache; `Populate` warms it
/// with a freshly-created record so a never-relayed seat still has the match cached. The record is
/// boxed to keep `Evict` (the common signal) cheap to move and the enum small.
#[derive(Debug)]
pub enum CtrlMsg {
    Evict(String),
    Populate(String, Box<crate::mp::MatchRecord>),
}

#[async_trait]
pub trait Bus: Send + Sync {
    fn instance_id(&self) -> &str;
    /// `client_tx` carries client-bound frames (written to the socket). `ctrl_tx` carries
    /// internal control signals — match-cache evict/populate. Kept separate so control never
    /// competes with or parses the hot-path frame stream.
    fn register(
        &self,
        conn: crate::mp::ConnId,
        client_tx: tokio::sync::mpsc::UnboundedSender<String>,
        ctrl_tx: tokio::sync::mpsc::UnboundedSender<CtrlMsg>,
    );
    fn unregister(&self, conn: crate::mp::ConnId);
    async fn deliver(&self, target: &ConnRef, text: String);
    /// Fire-and-forget publish to a Redis channel (cross-service signal). In-memory is a no-op.
    async fn publish_raw(&self, channel: &str, payload: String);
    /// Tell `target`'s connection task to drop `match_id` from its relay cache (so its next
    /// relay re-reads the match and picks up a rebound peer `ConnRef`). Routes locally or via
    /// the cross-instance pub/sub channel. No-op if the target is unknown.
    async fn evict(&self, target: &ConnRef, match_id: &str);
    /// Warm `target`'s relay cache with a freshly-created match record (so a seat that has not yet
    /// relayed still has the match cached for disconnect-notify and first-relay-without-GET). Routes
    /// locally or via the cross-instance pub/sub channel. No-op if the target is unknown.
    async fn populate(&self, target: &ConnRef, match_id: &str, rec: &crate::mp::MatchRecord);
}
