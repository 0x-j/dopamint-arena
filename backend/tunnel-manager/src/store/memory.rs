//! In-memory impls of `ControlStore`, `MpStore`, and `Bus`. Today's `RwLock`
//! maps/atomics lifted here. Selected when no `REDIS_CACHE_URL` is set.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use async_trait::async_trait;
use tokio::sync::mpsc;

use super::{Bus, ConnRef, ControlStore, CtrlMsg, MpStore};
use crate::mp::{pairing_allowed, Checkpoint, ConnId, DirectedInvite, MatchRecord, Waiting};
use crate::state::{
    GameStat, SessionRecord, StatsSnapshot, TunnelEvent, TunnelOwner, TunnelStatus,
};

// ===== ControlStore =====

#[derive(Default)]
pub struct InMemoryControlStore {
    sessions: RwLock<HashMap<String, SessionRecord>>,
    tunnels: RwLock<HashMap<String, TunnelStatus>>,
    active_tunnels: AtomicU64,
    settled_tunnels: AtomicU64,
    // Running max of tps, milli-tps to stay an integer atomic (fetch_max is lock-free).
    peak_tps_milli: AtomicU64,
    per_game_actions: RwLock<HashMap<String, u64>>,
    // Maintained at put_session time (replaces the old per-tick session scan in stats.rs).
    per_game_tunnels: RwLock<HashMap<String, u64>>,
    recent_ring: RwLock<VecDeque<TunnelEvent>>,
    seen_digests: RwLock<HashSet<String>>,
    // ADR-0014 ownership map (set-once, FIFO-bounded); the indexer captures, the display join reads.
    tunnel_owners: RwLock<HashMap<String, TunnelOwner>>,
    owner_order: RwLock<VecDeque<String>>, // FIFO eviction keys, bounds tunnel_owners
    tunnel_games: RwLock<HashMap<String, String>>,
    // Per-address faucet rate-limit window: address -> (pulls so far, window deadline). Lazily reset
    // on read/claim (single-process dev/test; the Redis impl uses a TTL'd counter in prod).
    faucet_windows: RwLock<HashMap<String, (u32, std::time::Instant)>>,
}

#[async_trait]
impl ControlStore for InMemoryControlStore {
    async fn put_session(&self, id: &str, rec: SessionRecord) {
        *self
            .per_game_tunnels
            .write()
            .unwrap()
            .entry(rec.game.clone())
            .or_insert(0) += rec.tunnels.len() as u64;
        {
            let mut games = self.tunnel_games.write().unwrap();
            for t in &rec.tunnels {
                games.insert(t.tunnel_id.clone(), rec.game.clone());
            }
        }
        self.sessions.write().unwrap().insert(id.to_owned(), rec);
    }

    async fn get_session(&self, id: &str) -> Option<SessionRecord> {
        self.sessions.read().unwrap().get(id).cloned()
    }

    async fn set_tunnel_status(&self, id: &str, s: TunnelStatus) {
        let mut map = self.tunnels.write().unwrap();
        let prev = map.insert(id.to_owned(), s);
        let was_active = matches!(prev, Some(TunnelStatus::Active));
        match s {
            TunnelStatus::Active if !was_active => {
                self.active_tunnels.fetch_add(1, Ordering::Relaxed);
            }
            TunnelStatus::Closed if !matches!(prev, Some(TunnelStatus::Closed)) => {
                if was_active {
                    self.active_tunnels.fetch_sub(1, Ordering::Relaxed);
                }
                self.settled_tunnels.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }

    async fn get_tunnel_status(&self, id: &str) -> Option<TunnelStatus> {
        self.tunnels.read().unwrap().get(id).copied()
    }

    async fn add_actions(&self, game: &str, delta: u64) {
        // Per-game only; total is derived in `snapshot` (parity with the Redis impl).
        *self
            .per_game_actions
            .write()
            .unwrap()
            .entry(game.to_owned())
            .or_insert(0) += delta;
    }

    async fn update_peak_tps(&self, tps: f64) {
        self.peak_tps_milli
            .fetch_max((tps * 1000.0) as u64, Ordering::Relaxed);
    }

    async fn snapshot(&self) -> StatsSnapshot {
        let actions = self.per_game_actions.read().unwrap();
        let tunnels = self.per_game_tunnels.read().unwrap();
        let mut total_actions: u64 = 0;
        let mut per_game: HashMap<String, GameStat> = HashMap::new();
        for (game, total) in actions.iter() {
            per_game
                .entry(game.clone())
                .or_insert(GameStat {
                    tps: 0.0,
                    tunnels: 0,
                    total_actions: 0,
                })
                .total_actions = *total;
            total_actions += *total;
        }
        for (game, n) in tunnels.iter() {
            per_game
                .entry(game.clone())
                .or_insert(GameStat {
                    tps: 0.0,
                    tunnels: 0,
                    total_actions: 0,
                })
                .tunnels = *n;
        }
        StatsSnapshot {
            tps: 0.0, // filled by the broadcaster from its per-tick diff
            peak_tps: self.peak_tps_milli.load(Ordering::Relaxed) as f64 / 1000.0,
            total_actions,
            active_tunnels: self.active_tunnels.load(Ordering::Relaxed),
            settled_tunnels: self.settled_tunnels.load(Ordering::Relaxed),
            per_game,
            recent_events: self.recent_ring.read().unwrap().iter().cloned().collect(),
        }
    }

    async fn push_recent_event(&self, ev: TunnelEvent) {
        let mut seen = self.seen_digests.write().unwrap();
        let mut ring = self.recent_ring.write().unwrap();
        if seen.insert(ev.tx_digest.clone()) {
            ring.push_front(ev);
            ring.truncate(super::RECENT_EVENTS_CAP);
            return;
        }
        // Already recorded. The /settle handler's enriched row (with a Walrus proofUrl) and the
        // event indexer's bare row race for the same digest; whichever lands first claims it.
        // The handler loses that race when Walrus upload delays its push past the indexer's 1s
        // poll — so upgrade the stored row in place when this one carries a proofUrl it lacks,
        // and never downgrade an existing one.
        if ev.proof_url.is_some() {
            if let Some(row) = ring.iter_mut().find(|r| r.tx_digest == ev.tx_digest) {
                if row.proof_url.is_none() {
                    row.proof_url = ev.proof_url;
                }
            }
        }
    }

    async fn recent_events(&self) -> Vec<TunnelEvent> {
        self.recent_ring.read().unwrap().iter().cloned().collect()
    }

    async fn set_tunnel_owner(&self, tunnel_id: &str, owner: TunnelOwner) {
        let mut map = self.tunnel_owners.write().unwrap();
        if map.contains_key(tunnel_id) {
            return; // set-once
        }
        map.insert(tunnel_id.to_owned(), owner);
        let mut order = self.owner_order.write().unwrap();
        order.push_back(tunnel_id.to_owned());
        while order.len() > super::TUNNEL_OWNER_CAP {
            if let Some(old) = order.pop_front() {
                map.remove(&old);
            }
        }
    }

    async fn get_tunnel_owner(&self, tunnel_id: &str) -> Option<TunnelOwner> {
        self.tunnel_owners.read().unwrap().get(tunnel_id).cloned()
    }

    async fn tunnel_game(&self, tunnel_id: &str) -> Option<String> {
        self.tunnel_games.read().unwrap().get(tunnel_id).cloned()
    }

    async fn set_tunnel_game(&self, tunnel_id: &str, game: &str) {
        self.tunnel_games
            .write()
            .unwrap()
            .insert(tunnel_id.to_owned(), game.to_owned());
    }

    async fn claim_faucet_slot(
        &self,
        address: &str,
        window_secs: i64,
        max_per_window: u32,
    ) -> bool {
        let now = std::time::Instant::now();
        let window = std::time::Duration::from_secs(window_secs.max(0) as u64);
        let mut map = self.faucet_windows.write().unwrap();
        let entry = map.entry(address.to_owned()).or_insert((0, now + window));
        if entry.1 <= now {
            *entry = (0, now + window); // window elapsed — start a fresh one
        }
        if entry.0 < max_per_window {
            entry.0 += 1;
            true
        } else {
            false
        }
    }

    async fn faucet_window_ttl(&self, address: &str) -> Option<i64> {
        let now = std::time::Instant::now();
        self.faucet_windows
            .read()
            .unwrap()
            .get(address)
            .filter(|(count, deadline)| *count > 0 && *deadline > now)
            .and_then(|(_, deadline)| deadline.checked_duration_since(now))
            .map(|d| d.as_secs() as i64)
    }

    async fn release_faucet_slot(&self, address: &str) {
        if let Some(entry) = self.faucet_windows.write().unwrap().get_mut(address) {
            entry.0 = entry.0.saturating_sub(1);
        }
    }

    async fn ready(&self) -> bool {
        true
    }
}

// ===== MpStore =====

#[derive(Default)]
pub struct InMemoryMpStore {
    presence: RwLock<HashMap<String, ConnRef>>,
    queues: RwLock<HashMap<String, VecDeque<Waiting>>>,
    invites: RwLock<HashMap<String, DirectedInvite>>,
    matches: RwLock<HashMap<String, MatchRecord>>,
    // (reservation, claimed). Single-instance, so no TTL: tests are short-lived.
    arena: RwLock<HashMap<String, (crate::store::ArenaReservation, bool)>>,
}

#[async_trait]
impl MpStore for InMemoryMpStore {
    async fn set_presence(&self, wallet: &str, at: ConnRef) {
        self.presence.write().unwrap().insert(wallet.to_owned(), at);
    }

    async fn get_presence(&self, wallet: &str) -> Option<ConnRef> {
        self.presence.read().unwrap().get(wallet).cloned()
    }

    async fn clear_presence_if(&self, wallet: &str, conn: ConnId) {
        let mut p = self.presence.write().unwrap();
        if p.get(wallet).map(|c| c.conn_id) == Some(conn) {
            p.remove(wallet);
        }
    }

    async fn join_or_pair(&self, game: &str, me: Waiting, _hold_ms: u64) -> Option<Waiting> {
        // Single-instance store: every waiter shares this instance, so the same-instance branch
        // always hits and we pair immediately. The hold never engages (no cross-instance waiters).
        let mut queues = self.queues.write().unwrap();
        let q = queues.entry(game.to_owned()).or_default();
        q.retain(|w| w.wallet != me.wallet);
        // A bot is NEVER paired with another bot (see `pairing_allowed`); the oldest pairable
        // waiter wins.
        match q.iter().position(|w| pairing_allowed(me.is_bot, w.is_bot)) {
            Some(i) => q.remove(i),
            None => {
                q.push_back(me);
                None
            }
        }
    }

    async fn fallback_pair(&self, game: &str, wallet: &str) -> Option<Waiting> {
        // Reachable only in multi-instance deployments; single-instance pairs at join time. Kept
        // consistent: if `wallet` is still parked, pair it with the oldest different-wallet waiter
        // that is not a bot-vs-bot match.
        let mut queues = self.queues.write().unwrap();
        let q = queues.entry(game.to_owned()).or_default();
        let me_is_bot = q.iter().find(|w| w.wallet == wallet)?.is_bot;
        let opp_idx = q
            .iter()
            .position(|w| w.wallet != wallet && pairing_allowed(me_is_bot, w.is_bot))?;
        let opp = q.remove(opp_idx);
        q.retain(|w| w.wallet != wallet);
        opp
    }

    async fn leave_queue(&self, game: &str, wallet: &str) {
        if let Some(q) = self.queues.write().unwrap().get_mut(game) {
            q.retain(|w| w.wallet != wallet);
        }
    }

    async fn put_invite(&self, match_id: &str, inv: DirectedInvite) {
        self.invites
            .write()
            .unwrap()
            .insert(match_id.to_owned(), inv);
    }

    async fn take_invite(&self, match_id: &str, accepter: &str) -> Option<DirectedInvite> {
        let mut inv = self.invites.write().unwrap();
        match inv.get(match_id) {
            Some(i) if i.to == accepter => inv.remove(match_id),
            _ => None,
        }
    }

    async fn drop_invite(&self, match_id: &str) {
        self.invites.write().unwrap().remove(match_id);
    }

    async fn put_match(&self, match_id: &str, m: MatchRecord) {
        self.matches.write().unwrap().insert(match_id.to_owned(), m);
    }

    async fn get_match(&self, match_id: &str) -> Option<MatchRecord> {
        self.matches.read().unwrap().get(match_id).cloned()
    }

    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str) {
        if let Some(m) = self.matches.write().unwrap().get_mut(match_id) {
            m.tunnel_id = Some(tunnel_id.to_owned());
        }
    }

    async fn record_checkpoint(&self, match_id: &str, cp: Checkpoint) {
        if let Some(m) = self.matches.write().unwrap().get_mut(match_id) {
            if m.latest_checkpoint
                .as_ref()
                .map_or(true, |c| cp.nonce >= c.nonce)
            {
                m.latest_checkpoint = Some(cp);
            }
        }
    }

    async fn rebind_match_conn(
        &self,
        match_id: &str,
        wallet: &str,
        at: ConnRef,
    ) -> Option<crate::mp::Seat> {
        let mut matches = self.matches.write().unwrap();
        let m = matches.get_mut(match_id)?;
        if m.seat_a == wallet {
            m.conn_a = at;
            Some(crate::mp::Seat::A)
        } else if m.seat_b == wallet {
            m.conn_b = at;
            Some(crate::mp::Seat::B)
        } else {
            None
        }
    }

    async fn put_arena_reservation(&self, match_id: &str, rec: crate::store::ArenaReservation) {
        self.arena
            .write()
            .unwrap()
            .insert(match_id.to_owned(), (rec, false));
    }

    async fn claim_arena(&self, match_id: &str, wallet: &str) -> crate::store::ArenaClaim {
        use crate::store::ArenaClaim;
        let mut arena = self.arena.write().unwrap();
        let Some((rec, claimed)) = arena.get_mut(match_id) else {
            return ArenaClaim::NotFound;
        };
        if rec.seat_a != wallet {
            return ArenaClaim::ForeignWallet;
        }
        if *claimed {
            return ArenaClaim::AlreadyClaimed;
        }
        *claimed = true;
        ArenaClaim::Claimed(rec.clone())
    }
}

// ===== Bus =====

pub struct LocalBus {
    instance_id: String,
    conns: RwLock<HashMap<ConnId, mpsc::UnboundedSender<String>>>,
    ctrls: RwLock<HashMap<ConnId, mpsc::UnboundedSender<CtrlMsg>>>,
}

impl LocalBus {
    pub fn new(instance_id: String) -> Self {
        Self {
            instance_id,
            conns: RwLock::new(HashMap::new()),
            ctrls: RwLock::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl Bus for LocalBus {
    fn instance_id(&self) -> &str {
        &self.instance_id
    }

    fn register(
        &self,
        conn: ConnId,
        client_tx: mpsc::UnboundedSender<String>,
        ctrl_tx: mpsc::UnboundedSender<CtrlMsg>,
    ) {
        self.conns.write().unwrap().insert(conn, client_tx);
        self.ctrls.write().unwrap().insert(conn, ctrl_tx);
    }

    fn unregister(&self, conn: ConnId) {
        self.conns.write().unwrap().remove(&conn);
        self.ctrls.write().unwrap().remove(&conn);
    }

    async fn deliver(&self, target: &ConnRef, text: String) {
        // Single instance: target is always local. (Phase 3 adds the cross-instance branch.)
        if let Some(tx) = self.conns.read().unwrap().get(&target.conn_id) {
            let _ = tx.send(text);
        }
    }

    async fn publish_raw(&self, channel: &str, payload: String) {
        let _ = (channel, payload);
    }

    async fn evict(&self, target: &ConnRef, match_id: &str) {
        let tx = self.ctrls.read().unwrap().get(&target.conn_id).cloned();
        if let Some(tx) = tx {
            let _ = tx.send(CtrlMsg::Evict(match_id.to_owned()));
        }
    }

    async fn populate(&self, target: &ConnRef, match_id: &str, rec: &MatchRecord) {
        let tx = self.ctrls.read().unwrap().get(&target.conn_id).cloned();
        if let Some(tx) = tx {
            let _ = tx.send(CtrlMsg::Populate(
                match_id.to_owned(),
                Box::new(rec.clone()),
            ));
        }
    }
}

// ===== Tests =====
// These cover ControlStore and MpStore invariants; relay routing moves into ws.rs.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{TunnelEvent, TunnelEventKind, TunnelStatus};

    fn settled(tunnel: &str, digest: &str) -> TunnelEvent {
        TunnelEvent {
            tunnel_id: tunnel.into(),
            kind: TunnelEventKind::Settled,
            party_a: None,
            party_b: None,
            funder: None,
            game: None,
            party_a_balance: Some(1),
            party_b_balance: Some(1),
            transcript_root: None,
            tx_digest: digest.into(),
            timestamp_ms: 1,
            proof_url: None,
        }
    }

    // Ownership is captured once (first writer wins) and the map is bounded: past the cap the
    // oldest entry is evicted, after which a lookup degrades to None (no attribution, graceful).
    #[tokio::test]
    async fn tunnel_owner_is_set_once_and_capped() {
        use crate::state::TunnelOwner;
        let s = InMemoryControlStore::default();
        let owner = |a: &str| TunnelOwner {
            party_a: Some(a.into()),
            party_b: Some("0xb".into()),
            funder: Some("0xf".into()),
        };
        s.set_tunnel_owner("0xt", owner("0xa1")).await;
        s.set_tunnel_owner("0xt", owner("0xLATER")).await; // set-once: ignored
        assert_eq!(
            s.get_tunnel_owner("0xt").await.unwrap().party_a.as_deref(),
            Some("0xa1")
        );
        for i in 0..(crate::store::TUNNEL_OWNER_CAP + 10) {
            s.set_tunnel_owner(&format!("0xc{i}"), owner("0xa")).await;
        }
        assert!(
            s.get_tunnel_owner("0xt").await.is_none(),
            "oldest evicted past cap"
        );
    }

    // The game a tunnel belongs to is joined from the session registry at put_session; an unknown
    // tunnel (PvP, or not seen) returns None so the display simply skips attribution.
    #[tokio::test]
    async fn tunnel_game_indexed_at_put_session() {
        use crate::routes::TunnelRef;
        let s = InMemoryControlStore::default();
        s.put_session(
            "sess1",
            SessionRecord {
                game: "blackjack".into(),
                tunnels: vec![TunnelRef {
                    tunnel_id: "0xt1".into(),
                    party_a: "0xa".into(),
                    party_b: "0xb".into(),
                }],
                stats_token: "tok".into(),
            },
        )
        .await;
        assert_eq!(s.tunnel_game("0xt1").await.as_deref(), Some("blackjack"));
        assert_eq!(s.tunnel_game("0xunknown").await, None);
    }

    // The arena path reserves a match instead of registering a session, so it tags the game
    // directly — without this the per-game tabs stay empty for every arena (user-vs-bot) row.
    #[tokio::test]
    async fn set_tunnel_game_tags_arena_tunnels() {
        let s = InMemoryControlStore::default();
        s.set_tunnel_game("0xarena", "quantumPoker").await;
        assert_eq!(
            s.tunnel_game("0xarena").await.as_deref(),
            Some("quantumPoker")
        );
    }

    // The faucet allows up to N pulls per window: the first N succeed, the (N+1)th is refused, and
    // releasing a slot (a failed mint) frees one so it doesn't burn an allowed pull.
    #[tokio::test]
    async fn faucet_slot_allows_n_per_window_then_refuses() {
        let s = InMemoryControlStore::default();
        for i in 0..5 {
            assert!(
                s.claim_faucet_slot("0xabc", 1800, 5).await,
                "pull {i} within the limit must succeed"
            );
        }
        assert!(
            !s.claim_faucet_slot("0xabc", 1800, 5).await,
            "the 6th pull in the window is refused"
        );
        assert!(
            s.faucet_window_ttl("0xabc").await.is_some(),
            "ttl reported while the window is active"
        );
        // A different address has its own window.
        assert!(s.claim_faucet_slot("0xdef", 1800, 5).await);
        // Releasing a slot (failed mint) frees one pull within the window.
        s.release_faucet_slot("0xabc").await;
        assert!(
            s.claim_faucet_slot("0xabc", 1800, 5).await,
            "a freed slot can be re-claimed"
        );
    }

    // A pushed event must appear in the broadcast snapshot — that is how the dashboard receives
    // the feed (it rides the existing /v1/stats/live SSE; no new endpoint).
    #[tokio::test]
    async fn snapshot_includes_recent_events() {
        let s = InMemoryControlStore::default();
        s.push_recent_event(settled("0xt", "dig1")).await;
        let snap = s.snapshot().await;
        assert_eq!(snap.recent_events.len(), 1);
        assert_eq!(snap.recent_events[0].tx_digest, "dig1");
    }

    // Newest-first, capped, and idempotent by tx_digest: a re-polled event (cursor restart /
    // second indexer) must NOT create a duplicate row. This is success criterion #3 in the spec.
    #[tokio::test]
    async fn recent_events_are_newest_first_capped_and_deduped() {
        let s = InMemoryControlStore::default();
        for i in 0..(crate::store::RECENT_EVENTS_CAP + 5) {
            s.push_recent_event(settled(&format!("0x{i}"), &format!("d{i}")))
                .await;
        }
        s.push_recent_event(settled("0x0", "d0")).await; // replay of the oldest — must be a no-op
        let got = s.recent_events().await;
        assert_eq!(got.len(), crate::store::RECENT_EVENTS_CAP, "ring is capped");
        let newest = crate::store::RECENT_EVENTS_CAP + 4;
        assert_eq!(got[0].tx_digest, format!("d{newest}"), "newest first");
    }

    // The /settle handler's enriched row (with a Walrus proofUrl) and the indexer's bare row
    // race for the same tx_digest. The proofUrl MUST survive regardless of arrival order: a
    // later enriched row upgrades a bare one (the real case — Walrus upload makes the handler
    // lose the race), and a later bare row never erases an existing proofUrl. Without this the
    // Transaction Log shows a successful settle with no proof link.
    #[tokio::test]
    async fn proof_url_survives_indexer_handler_race_either_order() {
        let proof = "https://agg/v1/blobs/xyz";
        let enriched = |t, d| TunnelEvent {
            proof_url: Some(proof.into()),
            ..settled(t, d)
        };

        // indexer (bare) first, then handler (enriched): the bare row is upgraded.
        let s = InMemoryControlStore::default();
        s.push_recent_event(settled("0xt", "d")).await;
        s.push_recent_event(enriched("0xt", "d")).await;
        let got = s.recent_events().await;
        assert_eq!(got.len(), 1, "still one row (deduped by digest)");
        assert_eq!(
            got[0].proof_url.as_deref(),
            Some(proof),
            "bare row upgraded to the proofUrl"
        );

        // handler (enriched) first, then indexer (bare): the proofUrl is not downgraded.
        let s2 = InMemoryControlStore::default();
        s2.push_recent_event(enriched("0xt", "d")).await;
        s2.push_recent_event(settled("0xt", "d")).await;
        let got2 = s2.recent_events().await;
        assert_eq!(got2.len(), 1);
        assert_eq!(
            got2[0].proof_url.as_deref(),
            Some(proof),
            "bare row never downgrades a proofUrl"
        );
    }

    // Heartbeat deltas must accrue to the session's game. Moved from routes.rs.
    #[tokio::test]
    async fn heartbeats_attribute_actions_per_game() {
        let s = InMemoryControlStore::default();
        s.add_actions("blackjack", 1000).await;
        s.add_actions("payments", 250).await;
        s.add_actions("blackjack", 200).await;
        let snap = s.snapshot().await;
        assert_eq!(snap.per_game["blackjack"].total_actions, 1200);
        assert_eq!(snap.per_game["payments"].total_actions, 250);
        assert_eq!(snap.total_actions, 1450);
    }

    // peak_tps is a maintained running max, not a recomputed aggregate: a later lower reading
    // never lowers it. The broadcaster folds each tick's tps in via update_peak_tps.
    #[tokio::test]
    async fn peak_tps_is_a_running_max() {
        let s = InMemoryControlStore::default();
        s.update_peak_tps(10.0).await;
        s.update_peak_tps(4.0).await;
        s.update_peak_tps(25.0).await;
        assert_eq!(s.snapshot().await.peak_tps, 25.0);
    }

    // Created→Active→Closed reduces correctly; replay (cursor restart) is idempotent.
    // Moved from sui.rs::events_reduce_to_terminal_status_and_maintain_counts.
    #[tokio::test]
    async fn tunnel_events_reduce_to_terminal_and_maintain_counts() {
        let s = InMemoryControlStore::default();
        s.set_tunnel_status("0xt", TunnelStatus::Created).await;
        s.set_tunnel_status("0xt", TunnelStatus::Active).await;
        let snap = s.snapshot().await;
        assert_eq!(snap.active_tunnels, 1);
        s.set_tunnel_status("0xt", TunnelStatus::Closed).await;
        s.set_tunnel_status("0xt", TunnelStatus::Closed).await; // replay — no-op
        let snap = s.snapshot().await;
        assert_eq!((snap.active_tunnels, snap.settled_tunnels), (0, 1));
    }

    fn cr() -> ConnRef {
        ConnRef {
            instance_id: "i".into(),
            conn_id: uuid::Uuid::new_v4(),
        }
    }

    // First joiner parks; second joiner gets back the earlier waiter (seat A).
    #[tokio::test]
    async fn join_or_pair_returns_the_earlier_waiter_then_drains() {
        let s = InMemoryMpStore::default();
        let a = Waiting {
            wallet: "0xa".into(),
            conn: cr(),
            is_bot: false,
        };
        let b = Waiting {
            wallet: "0xb".into(),
            conn: cr(),
            is_bot: false,
        };
        assert!(
            s.join_or_pair("ttt", a.clone(), 0).await.is_none(),
            "first parks"
        );
        let opp = s.join_or_pair("ttt", b, 0).await.expect("second pairs");
        assert_eq!(opp.wallet, "0xa", "opponent is the earlier waiter (seat A)");
    }

    // The fleet invariant: a bot is never matched to another bot. Two bot waiters both park;
    // a human joining pairs with the waiting bot (bot-primary). See spec §7.
    #[tokio::test]
    async fn bots_never_pair_with_each_other_but_do_pair_a_human() {
        let s = InMemoryMpStore::default();
        let bot1 = Waiting {
            wallet: "0xbot1".into(),
            conn: cr(),
            is_bot: true,
        };
        let bot2 = Waiting {
            wallet: "0xbot2".into(),
            conn: cr(),
            is_bot: true,
        };
        let human = Waiting {
            wallet: "0xhuman".into(),
            conn: cr(),
            is_bot: false,
        };

        assert!(
            s.join_or_pair("blackjack", bot1, 0).await.is_none(),
            "first bot parks"
        );
        assert!(
            s.join_or_pair("blackjack", bot2, 0).await.is_none(),
            "a second bot must NOT be paired with the waiting bot"
        );
        let opp = s
            .join_or_pair("blackjack", human, 0)
            .await
            .expect("a human pairs with a waiting bot");
        assert!(opp.is_bot, "the human's opponent is the waiting bot");
    }

    // Players queued for different games never pair.
    #[tokio::test]
    async fn join_or_pair_is_per_game() {
        let s = InMemoryMpStore::default();
        assert!(s
            .join_or_pair(
                "ttt",
                Waiting {
                    wallet: "0xa".into(),
                    conn: cr(),
                    is_bot: false,
                },
                0
            )
            .await
            .is_none());
        assert!(s
            .join_or_pair(
                "chess",
                Waiting {
                    wallet: "0xb".into(),
                    conn: cr(),
                    is_bot: false,
                },
                0
            )
            .await
            .is_none());
    }

    // Only the invited wallet can accept; a wrong wallet returns None.
    #[tokio::test]
    async fn challenge_accept_requires_the_invited_wallet() {
        let s = InMemoryMpStore::default();
        let inv = DirectedInvite {
            from: "0xa".into(),
            to: "0xb".into(),
            game: "ttt".into(),
            from_conn: ConnRef {
                instance_id: "i".into(),
                conn_id: uuid::Uuid::nil(),
            },
        };
        s.put_invite("mid1", inv).await;
        assert!(s.take_invite("mid1", "0xWRONG").await.is_none());
        let got = s.take_invite("mid1", "0xb").await.expect("accept");
        assert_eq!(got.from, "0xa");
        // invite is consumed
        assert!(s.take_invite("mid1", "0xb").await.is_none());
    }

    #[tokio::test]
    async fn rebind_match_conn_rebinds_owning_seat_and_noops_otherwise() {
        let s = InMemoryMpStore::default();
        let mid = "m-rebind";
        let cr = |id: &str| ConnRef {
            instance_id: id.into(),
            conn_id: uuid::Uuid::new_v4(),
        };
        s.put_match(
            mid,
            crate::mp::MatchRecord {
                game: "ttt".into(),
                seat_a: "0xa".into(),
                seat_b: "0xb".into(),
                conn_a: cr("i1"),
                conn_b: cr("i1"),
                tunnel_id: None,
                latest_checkpoint: None,
            },
        )
        .await;
        // Wrong wallet → None, nothing changes.
        assert_eq!(s.rebind_match_conn(mid, "0xstranger", cr("i9")).await, None);
        // Seat A owner rebinds conn_a only.
        let new_a = cr("i2");
        assert_eq!(
            s.rebind_match_conn(mid, "0xa", new_a.clone()).await,
            Some(crate::mp::Seat::A)
        );
        let got = s.get_match(mid).await.unwrap();
        assert_eq!(got.conn_a.instance_id, new_a.instance_id);
        assert_eq!(got.conn_a.conn_id, new_a.conn_id);
        // conn_b is untouched by a seat-A rebind.
        assert_eq!(got.conn_b.instance_id, "i1");
        // Seat B owner rebinds conn_b only.
        let new_b = cr("i3");
        assert_eq!(
            s.rebind_match_conn(mid, "0xb", new_b.clone()).await,
            Some(crate::mp::Seat::B)
        );
        let got = s.get_match(mid).await.unwrap();
        assert_eq!(got.conn_b.instance_id, new_b.instance_id);
        assert_eq!(got.conn_b.conn_id, new_b.conn_id);
        // ...and conn_a still holds the seat-A rebind, not clobbered.
        assert_eq!(got.conn_a.conn_id, new_a.conn_id);
        // Absent match → None.
        assert_eq!(s.rebind_match_conn("nope", "0xa", cr("i4")).await, None);
    }

    // LocalBus.populate must route the freshly-created record to the target's ctrl channel so a
    // never-relayed seat has the match cached (the gap this closes for single-instance/local dev).
    #[tokio::test]
    async fn populate_routes_to_the_target_ctrl_channel() {
        let bus = LocalBus::new("i".into());
        let conn = uuid::Uuid::new_v4();
        let (tx, _rx) = mpsc::unbounded_channel::<String>();
        let (ctx, mut crx) = mpsc::unbounded_channel::<CtrlMsg>();
        bus.register(conn, tx, ctx);
        let cr = ConnRef {
            instance_id: "i".into(),
            conn_id: uuid::Uuid::new_v4(),
        };
        let rec = MatchRecord {
            game: "ttt".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: cr.clone(),
            conn_b: cr,
            tunnel_id: None,
            latest_checkpoint: None,
        };
        bus.populate(
            &ConnRef {
                instance_id: "i".into(),
                conn_id: conn,
            },
            "m1",
            &rec,
        )
        .await;
        match crx.recv().await {
            Some(CtrlMsg::Populate(id, got)) => {
                assert_eq!(id, "m1");
                assert_eq!(got.seat_a, "0xa");
            }
            other => panic!("expected CtrlMsg::Populate, got {other:?}"),
        }
    }

    // A newer checkpoint supersedes an older one; a stale lower-nonce one is ignored.
    #[tokio::test]
    async fn record_checkpoint_keeps_highest_nonce() {
        let s = InMemoryMpStore::default();
        let cr_ref = ConnRef {
            instance_id: "i".into(),
            conn_id: uuid::Uuid::nil(),
        };
        s.put_match(
            "m",
            MatchRecord {
                game: "ttt".into(),
                seat_a: "0xa".into(),
                seat_b: "0xb".into(),
                conn_a: cr_ref.clone(),
                conn_b: cr_ref,
                tunnel_id: None,
                latest_checkpoint: None,
            },
        )
        .await;
        let cp = |n| Checkpoint {
            nonce: n,
            party_a_balance: 1,
            party_b_balance: 1,
            state_hash: "h".into(),
            sig_a: "a".into(),
            sig_b: "b".into(),
        };
        s.record_checkpoint("m", cp(5)).await;
        s.record_checkpoint("m", cp(3)).await; // stale
        assert_eq!(
            s.get_match("m")
                .await
                .unwrap()
                .latest_checkpoint
                .unwrap()
                .nonce,
            5
        );
    }
}
