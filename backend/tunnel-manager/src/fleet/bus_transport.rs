//! In-process relay transport for co-located fleet bots (ADR-0024).
//!
//! The co-located game-server runs bots as virtual bus connections instead of WebSocket clients:
//! a bot registers a `ConnId` + client channel on the relay [`crate::store::Bus`] (no socket), is
//! assigned a seat, and drives `fleet_core::play_match` over a [`BusRelayTransport`] — the
//! in-process mirror of bot-fleet's `WsRelayTransport`. This removes the bot's WS hop (the capacity
//! win at 5000 CCU: ~40k → ~5k sockets). Correctness is identical because outbound relay routing
//! reuses the SAME [`crate::mp::ws::relay_to_other`] the human WS path uses, so move-counting and
//! seat routing stay in exact parity — the relay still never signs.
//!
//! The co-located [`crate::fleet::colocated`] supervisor constructs these to play arena matches:
//! `conn_ref` is bound into the match by the [`crate::fleet::arena_rendezvous`], and `send_to_peer`
//! carries the bot's settle half for [`crate::fleet::arena_anchor`]. `await_match` mirrors the WS
//! `RelayConnection`'s queue entry for the matchmaking path (the arena flow gets its match via the
//! `BotPool` `Opened` push instead), so it stays test-exercised behind an item-level dead-code allow.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use tokio::sync::{mpsc, Mutex};
use tunnel_harness::FrameTransportError;
use uuid::Uuid;

use fleet_core::relay_ws::RelayTransport;
use fleet_core::{MatchInfo, Role};

use crate::mp::protocol::ServerMsg;
use crate::mp::{ConnId, MatchRecord};
use crate::state::SharedState;
use crate::store::{ConnRef, CtrlMsg};

/// A fleet bot's virtual connection on the relay bus: a registered `ConnId` + client channel, with
/// NO socket. Frames the relay would write to a socket arrive on `inbound`; the bot reads them
/// here. The in-process analog of bot-fleet's `RelayConnection`.
pub struct BusRelayConnection {
    state: SharedState,
    conn_id: ConnId,
    /// Server-bound frames `Bus::deliver` routes to this conn: MatchFound, Relay, PeerDropped.
    inbound: Mutex<mpsc::UnboundedReceiver<String>>,
    /// Held (undrained) so `Bus::populate`'s ctrl sends never fail — a bot keeps no relay cache, so
    /// evict/populate are irrelevant to it, but the bus must find a live sender registered.
    _ctrl_rx: mpsc::UnboundedReceiver<CtrlMsg>,
}

impl BusRelayConnection {
    /// Register a fresh virtual connection on the bus. The returned `Arc` owns the conn; dropping it
    /// unregisters (the analog of the WS task's disconnect cleanup).
    pub fn register(state: SharedState) -> Arc<BusRelayConnection> {
        let conn_id = Uuid::new_v4();
        let (client_tx, inbound) = mpsc::unbounded_channel();
        let (ctrl_tx, _ctrl_rx) = mpsc::unbounded_channel();
        state.bus.register(conn_id, client_tx, ctrl_tx);
        Arc::new(BusRelayConnection {
            state,
            conn_id,
            inbound: Mutex::new(inbound),
            _ctrl_rx,
        })
    }

    /// This connection's `ConnRef` — the seat identity the arena rendezvous binds into the match's
    /// `MatchRecord` (party B) so `relay_to_other` can route the human seat's frames here.
    pub fn conn_ref(&self) -> ConnRef {
        ConnRef {
            instance_id: self.state.bus.instance_id().to_owned(),
            conn_id: self.conn_id,
        }
    }

    /// Wait for matchmaking to pair us, returning the seat assignment. Mirrors
    /// `RelayConnection::await_match` over the WS — the queue-flow entry (the arena flow gets its
    /// match via the `BotPool` `Opened` push instead), kept for when that path is wired.
    #[allow(dead_code)]
    pub async fn await_match(&self) -> Result<MatchInfo> {
        loop {
            match self.recv_server_msg().await {
                Some(ServerMsg::MatchFound {
                    match_id,
                    role,
                    opponent_wallet,
                    ..
                }) => {
                    let role = match role.as_str() {
                        "A" => Role::A,
                        "B" => Role::B,
                        other => bail!("unknown role from relay: {other}"),
                    };
                    return Ok(MatchInfo {
                        match_id,
                        role,
                        opponent_wallet,
                    });
                }
                Some(ServerMsg::Error { code, message }) => bail!("relay error: {code} {message}"),
                Some(_) => continue,
                None => bail!("bus closed before match.found"),
            }
        }
    }

    /// Next inbound server frame, decoded. `None` when this connection's channel closes. The bus
    /// carries our own server-serialized frames, so a decode miss is a bug we skip, not peer input.
    async fn recv_server_msg(&self) -> Option<ServerMsg> {
        let text = self.inbound.lock().await.recv().await?;
        serde_json::from_str(&text).ok()
    }

    /// Route a control payload to this match's peer over the SAME [`crate::mp::ws::relay_to_other`]
    /// path game frames take. Used by [`crate::fleet::arena_anchor::RelayBridgedAnchor`] to emit the
    /// bot's settle half — the bot is not the frame transport but must still speak the peer protocol
    /// to the human seat. A fresh routing cache is fine: the anchor emits once per match, and a
    /// control payload (`t != "frame"`) is never counted as a move, exactly like a human peer's.
    pub async fn send_to_peer(&self, match_id: &str, payload: String) {
        let mut cache = HashMap::new();
        crate::mp::ws::relay_to_other(
            &self.state,
            &mut cache,
            self.conn_id,
            match_id.to_owned(),
            payload,
        )
        .await;
    }

    /// Next raw inbound frame text, for tests that assert what the relay routed to this conn.
    #[cfg(test)]
    pub async fn recv_for_test(&self) -> Option<String> {
        self.inbound.lock().await.recv().await
    }
}

impl Drop for BusRelayConnection {
    fn drop(&mut self) {
        self.state.bus.unregister(self.conn_id);
    }
}

/// How long a parked bot waits for a dropped human to resume before ending the match. Bounded
/// (unlike the FE's 1h settlement grace) because a parked bot still holds an in-flight fleet slot
/// against the per-game cap — a human who never returns must free it. A browser reload reconnects in
/// seconds; the headroom covers a slow reconnect / a user who tabs away briefly and returns. Past
/// this the bot exits (and its in-memory per-match state is gone), so a later resume can't continue.
const PEER_RESUME_GRACE: Duration = Duration::from_secs(300);

/// How many recent game frames the bot retains for a resume replay. On resume the human announces
/// its highest co-signed nonce and the bot replays only the frames past it (see `replay_since`), so
/// this just bounds memory; the human is at most ~2 nonces behind the bot's latest (one round-trip),
/// plus debounce slack, so a handful is ample headroom.
const RESUME_REPLAY_FRAMES: usize = 8;

/// The nonce of a seat frame carried in a relay envelope (`{"t":"frame","kind":…,"data":"<inner>"}`),
/// read from the inner frame's decimal `nonce`. `None` for non-frame payloads (settle halves, resync,
/// hello, …) — which are never retained or replayed, so a settle half can't disturb the handshake.
fn frame_nonce(payload: &str) -> Option<u64> {
    let env: serde_json::Value = serde_json::from_str(payload).ok()?;
    if env.get("t").and_then(|t| t.as_str()) != Some("frame") {
        return None;
    }
    let data = env.get("data").and_then(|d| d.as_str())?;
    let inner: serde_json::Value = serde_json::from_str(data).ok()?;
    inner.get("nonce").and_then(|n| n.as_str())?.parse().ok()
}

/// If `payload` is the human's resume `resync`, the highest co-signed nonce it announced. The bot
/// intercepts this at the transport (never surfacing it to the play loop) to drive a targeted replay.
fn resync_nonce(payload: &str) -> Option<u64> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    if v.get("t").and_then(|t| t.as_str()) != Some("resync") {
        return None;
    }
    v.get("nonce").and_then(|n| n.as_str())?.parse().ok()
}

/// Whether `payload` is the human's bare `forfeit` frame (`{ "t": "forfeit" }`, no body). The bot
/// diverts it out-of-band at the transport so it never reaches the fleet_core demux (which would
/// drop the unknown tag) — the play task races this signal and leads a forced-close half instead.
fn is_forfeit(payload: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return false;
    };
    v.get("t").and_then(|t| t.as_str()) == Some("forfeit")
}

/// A [`RelayTransport`] over the in-process bus, scoped to one match. `send_payload` routes through
/// the SAME [`crate::mp::ws::relay_to_other`] the human WS path uses (so move-counting + seat
/// routing are identical); `recv_payload` yields the next inbound `Relay` payload for this match.
///
/// Resume-aware (ADR-0028 lifecycle): a human's `peer.dropped` does NOT collapse the match — the bot
/// parks (keeping itself and its per-match co-signing key alive) until they `peer.resumed` or the
/// [`PEER_RESUME_GRACE`] elapses. On resume the human sends a `resync` announcing its highest nonce;
/// the bot replays exactly the frames past it (`replay_since`) so the human re-applies/re-ACKs the
/// tail it missed and the match continues instead of stalling on a lost frame.
pub struct BusRelayTransport {
    conn: Arc<BusRelayConnection>,
    match_id: String,
    /// Per-match record cache for routing, exactly as the WS connection task holds — the store is
    /// hit at most once per match for `relay_to_other`.
    cache: Mutex<HashMap<String, MatchRecord>>,
    /// False while the human seat is dropped (parked, awaiting resume); gates the grace timeout.
    peer_online: AtomicBool,
    /// Recent game frames as `(nonce, payload)`, oldest→newest, capped at [`RESUME_REPLAY_FRAMES`].
    /// A resume replays those with `nonce >= K` (the human's announced checkpoint) so it catches up.
    recent_frames: Mutex<VecDeque<(u64, Vec<u8>)>>,
    /// Grace to wait for a dropped human before ending the match; injectable so tests run fast.
    resume_grace: Duration,
    /// Out-of-band sink for an inbound bare `forfeit` frame. `Some` on the co-located bot's transport
    /// (the arena forfeit seam); `None` on the human-side / test transports, which surface no forfeit.
    /// A `(1)`-capacity channel: forfeit is a one-shot, and a full channel (already forfeited) drops.
    forfeit_tx: Option<mpsc::Sender<()>>,
}

impl BusRelayTransport {
    pub fn new(conn: Arc<BusRelayConnection>, match_id: String) -> BusRelayTransport {
        Self::with_resume_grace(conn, match_id, PEER_RESUME_GRACE)
    }

    /// Divert an inbound bare `forfeit` frame to `forfeit_tx` (which the play task races to lead a
    /// forced close) instead of surfacing it to the play loop. The co-located bot chains this onto
    /// `new`; the human-side / test transports leave it unset (no forfeit). Entirely fleet-layer — no
    /// harness change; a diverted frame never reaches the fleet_core demux.
    pub fn forfeit_to(mut self, forfeit_tx: mpsc::Sender<()>) -> BusRelayTransport {
        self.forfeit_tx = Some(forfeit_tx);
        self
    }

    fn with_resume_grace(
        conn: Arc<BusRelayConnection>,
        match_id: String,
        resume_grace: Duration,
    ) -> BusRelayTransport {
        BusRelayTransport {
            conn,
            match_id,
            cache: Mutex::new(HashMap::new()),
            peer_online: AtomicBool::new(true),
            recent_frames: Mutex::new(VecDeque::new()),
            resume_grace,
            forfeit_tx: None,
        }
    }

    /// Targeted resume replay: re-emit every retained frame with `nonce >= k` (the human's announced
    /// checkpoint), oldest→newest, to the reconnected seat. `>= k` (not `> k`) is deliberate — the
    /// frame AT k re-triggers the human's `onMove` re-ACK, which unblocks a bot still awaiting that
    /// ACK; frames past k the human applies forward. Order matters: the FE applies each at exactly
    /// `nonce+1`, so a newer frame ahead of an older one it depends on trips its "nonce gap" guard.
    /// The routing cache is dropped first so the replay re-reads the record's rebound `conn_a`.
    async fn replay_since(&self, k: u64) {
        let mut cache = self.cache.lock().await;
        cache.remove(&self.match_id);
        let frames: Vec<Vec<u8>> = self
            .recent_frames
            .lock()
            .await
            .iter()
            .filter(|(nonce, _)| *nonce >= k)
            .map(|(_, payload)| payload.clone())
            .collect();
        for frame in frames {
            if let Ok(payload) = String::from_utf8(frame) {
                crate::mp::ws::relay_to_other(
                    &self.conn.state,
                    &mut cache,
                    self.conn.conn_id,
                    self.match_id.clone(),
                    payload,
                )
                .await;
            }
        }
    }
}

impl RelayTransport for BusRelayTransport {
    async fn send_payload(&self, payload: Vec<u8>) -> Result<(), FrameTransportError> {
        let payload = String::from_utf8(payload)
            .map_err(|e| FrameTransportError::Transport(format!("payload not UTF-8: {e}")))?;
        tracing::debug!(match_id = %self.match_id, head = %&payload[..payload.len().min(120)], "bus tx (bot→peer)");
        {
            let mut cache = self.cache.lock().await;
            crate::mp::ws::relay_to_other(
                &self.conn.state,
                &mut cache,
                self.conn.conn_id,
                self.match_id.clone(),
                payload.clone(),
            )
            .await;
        }
        // Retain recent game frames by nonce (bounded ring) so a resume can replay exactly the tail
        // the human missed. Never cleared on inbound: the human's persisted checkpoint can lag the
        // frame it just ACKed (write debounce), so a frame it "acknowledged" may still be needed.
        if let Some(nonce) = frame_nonce(&payload) {
            let mut ring = self.recent_frames.lock().await;
            ring.push_back((nonce, payload.into_bytes()));
            while ring.len() > RESUME_REPLAY_FRAMES {
                ring.pop_front();
            }
        }
        Ok(())
    }

    async fn recv_payload(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
        loop {
            // While the human is parked (dropped, awaiting resume) bound the wait so a human who
            // never returns can't pin this bot's in-flight fleet slot forever; online → wait freely.
            let msg = if self.peer_online.load(Ordering::Relaxed) {
                self.conn.recv_server_msg().await
            } else {
                match tokio::time::timeout(self.resume_grace, self.conn.recv_server_msg()).await {
                    Ok(m) => m,
                    Err(_) => return Ok(None), // grace expired while parked → end the match
                }
            };
            match msg {
                Some(ServerMsg::Relay { match_id, payload }) if match_id == self.match_id => {
                    tracing::debug!(match_id = %self.match_id, head = %&payload[..payload.len().min(120)], "bus rx (peer→bot)");
                    // The human's resume `resync` is handled HERE, at the transport, and never reaches
                    // the play loop: replay the frames past its announced nonce so it catches up.
                    if let Some(k) = resync_nonce(&payload) {
                        self.replay_since(k).await;
                        continue;
                    }
                    // A bare `forfeit` is diverted out-of-band to the play task (which leads a forced
                    // close) and never surfaced as a frame — the fleet_core demux would drop the tag.
                    if let Some(forfeit_tx) = &self.forfeit_tx {
                        if is_forfeit(&payload) {
                            // Non-blocking: forfeit is one-shot, and a full channel (already
                            // forfeited) drops rather than waiting, matching the field doc below.
                            let _ = forfeit_tx.try_send(());
                            continue;
                        }
                    }
                    return Ok(Some(payload.into_bytes()));
                }
                // Other-match frames shouldn't arrive (one match per virtual conn); ignore.
                Some(ServerMsg::Relay { .. }) => continue,
                // The human reloaded/disconnected. DON'T collapse the match — park and keep the bot
                // (and its co-signing key) alive so the game resumes when they reconnect.
                Some(ServerMsg::PeerDropped { .. }) => {
                    self.peer_online.store(false, Ordering::Relaxed);
                    continue;
                }
                // The human is back: stop the grace countdown. The actual catch-up is driven by the
                // `resync` it sends next (handled in the Relay arm above), not by a blind re-emit here.
                Some(ServerMsg::PeerResumed { .. }) => {
                    self.peer_online.store(true, Ordering::Relaxed);
                    continue;
                }
                // The bus connection itself closed → end the match channel.
                None => return Ok(None),
                Some(_) => continue,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use fleet_core::match_channel::MatchChannel;
    use fleet_core::play_match::{play_blackjack, BLACKJACK};
    use fleet_core::signer_durable::DurableSigner;
    use tunnel_harness::{InMemoryAnchor, NullTranscriptRecorder};

    // Two virtual bus connections complete a full co-signed blackjack match over the REAL relay bus
    // (LocalBus + the shared `relay_to_other` routing) — the co-located analog of the WS
    // `BOT_COUNT=2` test. Proves the `BusRelayTransport` seam carries the whole orchestration on the
    // merged `PartyDriver` (hello exchange → anchor open → co-signed play → settle PAIRING) without
    // a WebSocket. Both seats share one `InMemoryAnchor`, so both returning Ok means the cooperative
    // close verified. A regression in bus routing or the payload round-trip fails here.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn full_match_completes_over_the_bus() {
        let state = AppState::in_memory_for_test();
        let conn_a = BusRelayConnection::register(state.clone());
        let conn_b = BusRelayConnection::register(state.clone());

        // Pre-create the match so `relay_to_other` can route seat A ↔ seat B by their `ConnRef`s
        // (Increment 3 will create this via matchmaking/arena; here we wire it directly).
        let match_id = "m-bus-1";
        state
            .mp
            .put_match(
                match_id,
                MatchRecord {
                    game: "blackjack".into(),
                    seat_a: "0xhumanA".into(),
                    seat_b: "0xbotB".into(),
                    conn_a: conn_a.conn_ref(),
                    conn_b: conn_b.conn_ref(),
                    tunnel_id: None,
                    latest_checkpoint: None,
                },
            )
            .await;

        let cha = MatchChannel::new(BusRelayTransport::new(conn_a.clone(), match_id.into()));
        let chb = MatchChannel::new(BusRelayTransport::new(conn_b.clone(), match_id.into()));
        // One shared anchor so the two seats' settle halves pair (open idempotent, settle paired).
        let anchor = InMemoryAnchor::new();

        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);

        let (ra, rb) = tokio::join!(
            play_blackjack(
                cha,
                anchor.clone(),
                DurableSigner::from_secret(&sa),
                Role::A,
                "0xbotB",
                NullTranscriptRecorder,
            ),
            play_blackjack(
                chb,
                anchor.clone(),
                DurableSigner::from_secret(&sb),
                Role::B,
                "0xhumanA",
                NullTranscriptRecorder,
            ),
        );

        let a = ra.expect("seat A completes open → play → settle over the bus");
        let b = rb.expect("seat B completes open → play → settle over the bus");
        let total = 2 * BLACKJACK.stake_each;
        assert_eq!(
            a.final_balances.sum(),
            total,
            "stakes conserved over the bus"
        );
        assert_eq!(
            a.final_balances, b.final_balances,
            "both seats agree on the outcome"
        );
        assert!(a.moves > 0, "match progressed over the bus transport");
        // Both Ok ⇒ the shared anchor PAIRED the two settle halves over the bus: cooperative close
        // verified, not just the move loop.
    }

    // `await_match` decodes a delivered `match.found` into the seat assignment — the entry the
    // supervisor (Increment 3) drives before handing the match to `play_match`.
    #[tokio::test]
    async fn await_match_decodes_match_found() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        state
            .bus
            .deliver(
                &conn.conn_ref(),
                ServerMsg::MatchFound {
                    match_id: "m1".into(),
                    role: "B".into(),
                    opponent_wallet: "0xhuman".into(),
                    game: "blackjack".into(),
                }
                .to_text(),
            )
            .await;
        let info = conn.await_match().await.expect("await_match resolves");
        assert_eq!(info.match_id, "m1");
        assert_eq!(info.role, Role::B);
        assert_eq!(info.opponent_wallet, "0xhuman");
    }

    // A human `peer.dropped` must NOT collapse the bot's match (the old `Ok(None)` bug that killed the
    // bot on reload). The transport parks: a frame arriving after the drop is still delivered, so the
    // game continues when the human reconnects. The regression this whole change fixes.
    #[tokio::test]
    async fn peer_dropped_parks_instead_of_ending_the_match() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        let match_id = "m-park";
        let transport = BusRelayTransport::new(conn.clone(), match_id.into());

        // Human drops, then (after reconnecting) sends a frame. A collapsing transport would have
        // returned None on the drop; the parking one skips it and delivers the frame.
        let frame_env = r#"{"t":"frame","kind":"move","data":"{}"}"#;
        state
            .bus
            .deliver(
                &conn.conn_ref(),
                ServerMsg::PeerDropped {
                    match_id: match_id.into(),
                }
                .to_text(),
            )
            .await;
        state
            .bus
            .deliver(
                &conn.conn_ref(),
                ServerMsg::Relay {
                    match_id: match_id.into(),
                    payload: frame_env.into(),
                }
                .to_text(),
            )
            .await;

        let got = transport.recv_payload().await.expect("recv ok");
        assert_eq!(
            got.as_deref(),
            Some(frame_env.as_bytes()),
            "parked past the drop and delivered the next frame instead of ending the match",
        );
    }

    // The bare `forfeit` frame is recognized; ordinary frames / other control tags are not, so the
    // diversion never swallows a real move.
    #[test]
    fn is_forfeit_recognizes_only_the_bare_forfeit_frame() {
        assert!(is_forfeit(r#"{"t":"forfeit"}"#));
        assert!(!is_forfeit(r#"{"t":"frame","kind":"move","data":"{}"}"#));
        assert!(!is_forfeit(r#"{"t":"resync","nonce":"3"}"#));
        assert!(!is_forfeit("not json"));
    }

    // On the bot's transport, an inbound `forfeit` is diverted out-of-band onto the forfeit channel
    // and NOT surfaced to the play loop (the fleet_core demux would drop the unknown tag). `recv_payload`
    // skips it and returns the next real frame, exactly like the resync interception. Without the
    // `forfeit_to` sink (human/test transports) the same frame WOULD surface — see the second assert.
    #[tokio::test]
    async fn forfeit_frame_is_diverted_not_surfaced() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        let match_id = "m-forfeit-divert";
        let (forfeit_tx, mut forfeit_rx) = mpsc::channel::<()>(1);
        let transport =
            BusRelayTransport::new(conn.clone(), match_id.into()).forfeit_to(forfeit_tx);

        let frame_env = r#"{"t":"frame","kind":"move","data":"{}"}"#;
        for payload in [r#"{"t":"forfeit"}"#, frame_env] {
            state
                .bus
                .deliver(
                    &conn.conn_ref(),
                    ServerMsg::Relay {
                        match_id: match_id.into(),
                        payload: payload.into(),
                    }
                    .to_text(),
                )
                .await;
        }

        let got = transport.recv_payload().await.expect("recv ok");
        assert_eq!(
            got.as_deref(),
            Some(frame_env.as_bytes()),
            "the forfeit was diverted; recv_payload surfaced the next real frame, not the forfeit",
        );
        assert_eq!(
            forfeit_rx.try_recv(),
            Ok(()),
            "the forfeit signal reached the play task's channel out-of-band",
        );
    }

    // Regression (Theodore's forfeit review): an arena forfeit drops the play future via `select!`,
    // which drops its `MatchChannel`. That drop MUST release the bot's relay connection. The old
    // `play_match` spawned a stop task that OWNED the whole channel, so dropping the play future
    // detached it — the channel never dropped, its demux never aborted, and the conn stayed registered
    // (one conn + two tasks leaked per forfeit, for the process's lifetime). Now the watcher is owned
    // by the channel and aborted in its `Drop`. Here we stand in for the cancellation by dropping the
    // channel directly and assert the conn `Arc` is fully released — its `Drop` is what unregisters it.
    #[tokio::test]
    async fn dropping_the_match_channel_releases_the_bot_conn() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        let weak = Arc::downgrade(&conn);

        let mut channel = MatchChannel::new(BusRelayTransport::new(conn.clone(), "m-leak".into()));
        let frame_transport = channel.take_frame_transport();
        // Arm the stop watcher exactly as `play_match` does after the hello exchange.
        channel.watch_stop(|| {});

        // Forfeit cancellation stand-in: the play future (owning the channel + its frame transport)
        // is dropped. Then release the test's own conn handle — only a leaked task could still pin it.
        drop(frame_transport);
        drop(channel);
        drop(conn);

        // The demux + watcher aborts are asynchronous; let the runtime run them to completion.
        for _ in 0..100 {
            if weak.upgrade().is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            weak.upgrade().is_none(),
            "dropping the channel released the bot conn (Drop → bus.unregister); no forfeit leak",
        );
    }

    // A seat frame in its relay envelope: `{"t":"frame","kind":…,"data":"<inner-json>"}`, inner nonce
    // a decimal string (matches `relay_envelope::wrap` + `JsonFrameCodec`), so `frame_nonce` reads it.
    fn frame_env(kind: &str, nonce: u64) -> String {
        let inner = serde_json::json!({ "kind": kind, "nonce": nonce.to_string() }).to_string();
        serde_json::json!({ "t": "frame", "kind": kind, "data": inner }).to_string()
    }
    fn resync_env(nonce: u64) -> String {
        serde_json::json!({ "t": "resync", "nonce": nonce.to_string(), "hasPending": false })
            .to_string()
    }

    // The parse helpers the replay targeting relies on.
    #[test]
    fn frame_and_resync_nonces_parse() {
        assert_eq!(frame_nonce(&frame_env("move", 42)), Some(42));
        assert_eq!(frame_nonce(&frame_env("ack", 7)), Some(7));
        assert_eq!(frame_nonce(&resync_env(9)), None, "resync is not a frame");
        assert_eq!(resync_nonce(&resync_env(9)), Some(9));
        assert_eq!(
            resync_nonce(&frame_env("move", 1)),
            None,
            "frame is not a resync"
        );
    }

    async fn resume_match(
        state: &SharedState,
        match_id: &str,
    ) -> (Arc<BusRelayConnection>, BusRelayTransport) {
        let bot = BusRelayConnection::register(state.clone());
        let human = BusRelayConnection::register(state.clone());
        let record = MatchRecord {
            game: "blackjack".into(),
            seat_a: "0xhuman".into(),
            seat_b: "0xbot".into(),
            conn_a: human.conn_ref(),
            conn_b: bot.conn_ref(),
            tunnel_id: None,
            latest_checkpoint: None,
        };
        let transport = BusRelayTransport::new(bot.clone(), match_id.into());
        state.mp.put_match(match_id, record).await;
        (human, transport)
    }

    // The stall this whole change fixes: one round-trip advances the bot TWO nonces (ACK the human's
    // move, then propose its own), so a reload mid-round-trip leaves the human two frames behind. On
    // resume the human announces its highest nonce K in a `resync`; the bot replays exactly the frames
    // with `nonce >= K`, oldest→newest — the ACK(K) (re-triggers the human's re-ACK) then MOVE(K+1) —
    // and SKIPS anything below K. A single-frame or blind replay couldn't do this targeting.
    #[tokio::test]
    async fn resync_replays_frames_at_and_after_the_announced_nonce() {
        let state = AppState::in_memory_for_test();
        let match_id = "m-resync";
        let (human, transport) = resume_match(&state, match_id).await;

        // Bot's recent frames span a stale one (n=0, already deep in the human's history) and this
        // round-trip's tail: ACK(n=1) + MOVE(n=2).
        for (kind, nonce) in [("move", 0u64), ("ack", 1), ("move", 2)] {
            transport
                .send_payload(frame_env(kind, nonce).into_bytes())
                .await
                .expect("send ok");
            human
                .recv_for_test()
                .await
                .expect("human gets the original");
        }

        // Human resumes at nonce 1 → announce it. The bot replays n>=1 (ACK 1, MOVE 2), not n=0.
        state
            .bus
            .deliver(
                &transport.conn.conn_ref(),
                ServerMsg::Relay {
                    match_id: match_id.into(),
                    payload: resync_env(1),
                }
                .to_text(),
            )
            .await;
        let _ = tokio::time::timeout(Duration::from_millis(100), transport.recv_payload()).await;

        let first = tokio::time::timeout(Duration::from_millis(200), human.recv_for_test())
            .await
            .expect("first replay delivered, no hang")
            .expect("human gets a replayed frame");
        let second = tokio::time::timeout(Duration::from_millis(200), human.recv_for_test())
            .await
            .expect("second replay delivered, no hang")
            .expect("human gets a replayed frame");
        assert!(
            first.contains("ack") && !first.contains("move"),
            "replayed the frame AT K (ACK n=1) first — it re-triggers the human's re-ACK: {first}",
        );
        assert!(
            second.contains("move"),
            "replayed the frame past K (MOVE n=2) second: {second}",
        );
        // The stale n=0 frame is NOT replayed: no third frame arrives.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), human.recv_for_test())
                .await
                .is_err(),
            "targeting skipped the frame below K — only n>=1 replayed",
        );
    }

    // Blind replay is gone: `peer.resumed` alone (no `resync`) re-emits NOTHING. Catch-up is driven
    // solely by the human's announced nonce, so a bot can't spray stale frames on a bare resume.
    #[tokio::test]
    async fn peer_resumed_alone_does_not_replay() {
        let state = AppState::in_memory_for_test();
        let match_id = "m-bare-resume";
        let (human, transport) = resume_match(&state, match_id).await;

        transport
            .send_payload(frame_env("move", 1).into_bytes())
            .await
            .expect("send ok");
        human
            .recv_for_test()
            .await
            .expect("human gets the original");

        state
            .bus
            .deliver(
                &transport.conn.conn_ref(),
                ServerMsg::PeerResumed {
                    match_id: match_id.into(),
                    seat: "A".into(),
                    conn_ref: human.conn_ref(),
                }
                .to_text(),
            )
            .await;
        let _ = tokio::time::timeout(Duration::from_millis(100), transport.recv_payload()).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), human.recv_for_test())
                .await
                .is_err(),
            "peer.resumed without a resync must not re-emit any frame",
        );
    }

    // A human who never returns must not pin the bot's in-flight fleet slot forever: after the grace
    // the parked match ends (freeing the slot). Uses a short injected grace so the test runs fast.
    #[tokio::test]
    async fn grace_expiry_ends_a_parked_match_when_the_human_never_returns() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        let match_id = "m-grace";
        let transport = BusRelayTransport::with_resume_grace(
            conn.clone(),
            match_id.into(),
            Duration::from_millis(50),
        );

        state
            .bus
            .deliver(
                &conn.conn_ref(),
                ServerMsg::PeerDropped {
                    match_id: match_id.into(),
                }
                .to_text(),
            )
            .await;
        let got = transport.recv_payload().await.expect("recv ok");
        assert_eq!(
            got, None,
            "grace expiry ends the parked match so the fleet slot frees"
        );
    }
}
