//! `GET /v1/mp` WebSocket. Upgrade → challenge → connect-auth → register presence + a local
//! outbound channel via Bus → drive matchmaking/relay through MpStore + Bus::deliver.
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::stream::FuturesUnordered;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::mp::protocol::{ClientMsg, ServerMsg};
use crate::mp::{auth, Checkpoint, ConnId, DirectedInvite, MatchRecord, Waiting};
use crate::state::SharedState;
use crate::store::{ConnRef, CtrlMsg};

/// A parked waiter's hold expiry: resolves to `(game, me)` after the hold elapses, on the
/// connection's task (dropped — cancelled — when the connection ends).
type HoldTimer = Pin<Box<dyn Future<Output = (String, Waiting)> + Send>>;

pub async fn mp_upgrade(State(state): State<SharedState>, ws: WebSocketUpgrade) -> Response {
    let instance = state.bus.instance_id().to_owned();
    let mut resp = ws.on_upgrade(move |socket| handle_socket(socket, state));
    // `SameSite=Lax` is correct for a same-origin relay. A cross-origin frontend needs
    // `SameSite=None; Secure` instead (see "relay session stickiness" in
    // docs/guide/adding-a-tunnel-game.md) — fold that in via config if/when the relay is cross-origin.
    if let Ok(value) =
        axum::http::HeaderValue::from_str(&format!("aff={instance}; Path=/; SameSite=Lax"))
    {
        resp.headers_mut()
            .insert(axum::http::header::SET_COOKIE, value);
    }
    resp
}

fn new_match_id() -> String {
    format!("match_{}", Uuid::new_v4().simple())
}
fn here(state: &SharedState, conn: ConnId) -> ConnRef {
    ConnRef {
        instance_id: state.bus.instance_id().to_owned(),
        conn_id: conn,
    }
}

/// Build, persist, and announce a freshly paired match. Used by both the join path and the
/// hold-timer fallback. Delivers `MatchFound` to both seats and warms both relay caches via the
/// bus (`populate`), so neither seat needs to be the synchronous creator — the timer path pairs
/// two parked waiters, neither of which is "the joiner".
async fn create_and_announce_match(
    state: &SharedState,
    game: &str,
    seat_a: Waiting,
    seat_b: Waiting,
) -> (String, MatchRecord) {
    let match_id = new_match_id();
    let rec = MatchRecord {
        game: game.to_owned(),
        seat_a: seat_a.wallet.clone(),
        seat_b: seat_b.wallet.clone(),
        conn_a: seat_a.conn.clone(),
        conn_b: seat_b.conn.clone(),
        tunnel_id: None,
        latest_checkpoint: None,
    };
    state.mp.put_match(&match_id, rec.clone()).await;
    state
        .pairing
        .observe(rec.conn_a.instance_id == rec.conn_b.instance_id);
    state
        .bus
        .deliver(
            &rec.conn_a,
            ServerMsg::MatchFound {
                match_id: match_id.clone(),
                role: "A".into(),
                opponent_wallet: rec.seat_b.clone(),
                game: game.to_owned(),
            }
            .to_text(),
        )
        .await;
    state
        .bus
        .deliver(
            &rec.conn_b,
            ServerMsg::MatchFound {
                match_id: match_id.clone(),
                role: "B".into(),
                opponent_wallet: rec.seat_a.clone(),
                game: game.to_owned(),
            }
            .to_text(),
        )
        .await;
    state.bus.populate(&rec.conn_a, &match_id, &rec).await;
    state.bus.populate(&rec.conn_b, &match_id, &rec).await;
    (match_id, rec)
}

/// Challenge-match: seat A = the inviter; seat B = the accepter.
fn build_challenge_match(
    inv: &DirectedInvite,
    accepter_wallet: &str,
    accepter_conn: ConnRef,
) -> MatchRecord {
    MatchRecord {
        game: inv.game.clone(),
        seat_a: inv.from.clone(),
        seat_b: accepter_wallet.to_owned(),
        conn_a: inv.from_conn.clone(),
        conn_b: accepter_conn,
        tunnel_id: None,
        latest_checkpoint: None,
    }
}

/// Server-driven keepalive cadence (RFC 6455 control frames). Browsers can't
/// originate Ping frames and auto-answer Pong below the app layer, so liveness
/// has to be server-side. A tick that finds the previous ping still unanswered
/// means the peer vanished (a half-open socket the browser/ALB can't surface),
/// so we drop the connection and run the cleanup below. Kept well under the ALB
/// idle timeout so the proxy never reaps a live-but-quiet match.
const KEEPALIVE_PING_INTERVAL: Duration = Duration::from_secs(30);

async fn handle_socket(socket: WebSocket, state: SharedState) {
    let conn_id: ConnId = Uuid::new_v4();
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<CtrlMsg>();
    let nonce = conn_id.to_string();
    let _ = tx.send(
        ServerMsg::Challenge {
            nonce: nonce.clone(),
        }
        .to_text(),
    );

    let mut wallet: Option<String> = None;
    let mut joined_games: HashSet<String> = HashSet::new();
    let mut matches: std::collections::HashMap<String, MatchRecord> =
        std::collections::HashMap::new();
    let mut holds: FuturesUnordered<HoldTimer> = FuturesUnordered::new();

    let mut keepalive = tokio::time::interval(KEEPALIVE_PING_INTERVAL);
    // A stall in `handle_message` must not burst-fire catch-up ticks and trip the
    // unanswered-ping check on a connection that is actually alive.
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut ping_unanswered = false;

    // Single loop owns the sink, so reads, queued outbound, and keepalive pings
    // never contend; pong replies arrive on the read half and clear the flag.
    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if ping_unanswered {
                    break; // last ping never got a pong → peer is gone
                }
                ping_unanswered = true;
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(text) => {
                        if sink.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            ctrl = ctrl_rx.recv() => {
                // The ctrl channel never closes before the socket; on `None` the next loop
                // iteration drops out via another arm. Fires only on evict/populate, never per move.
                match ctrl {
                    Some(CtrlMsg::Evict(match_id)) => { matches.remove(&match_id); }
                    Some(CtrlMsg::Populate(match_id, rec)) => { matches.insert(match_id, *rec); }
                    None => {}
                }
            }
            inbound = stream.next() => {
                let text = match inbound {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Pong(_))) => {
                        ping_unanswered = false;
                        continue;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => continue,
                };
                let client_msg = match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(m) => m,
                    Err(_) => {
                        let _ = tx.send(
                            ServerMsg::error("bad_message", "unparseable control message")
                                .to_text(),
                        );
                        continue;
                    }
                };
                if let Err(code) = handle_message(
                    &state,
                    &tx,
                    &ctrl_tx,
                    conn_id,
                    &nonce,
                    &mut wallet,
                    &mut joined_games,
                    &mut matches,
                    client_msg,
                    &mut holds,
                )
                .await
                {
                    let _ = tx.send(ServerMsg::error(code, code).to_text());
                }
            }
            Some((game, me)) = holds.next(), if !holds.is_empty() => {
                // Hold expired: if still parked, pair across instances and announce.
                if let Some(opp) = state.mp.fallback_pair(&game, &me.wallet).await {
                    // Seat A = this (the waiter whose timer fired), seat B = the opponent.
                    create_and_announce_match(&state, &game, me, opp).await;
                }
            }
        }
    }

    // Disconnect cleanup: conditional presence clear + leave every joined queue.
    if let Some(w) = wallet {
        state.mp.clear_presence_if(&w, conn_id).await;
        for g in joined_games {
            state.mp.leave_queue(&g, &w).await;
        }
    }
    notify_peers_dropped(&state, conn_id, &matches).await;
    state.bus.unregister(conn_id);
}

#[allow(clippy::too_many_arguments)] // per-connection state refs; no meaningful grouping
async fn handle_message(
    state: &SharedState,
    tx: &mpsc::UnboundedSender<String>,
    ctrl_tx: &mpsc::UnboundedSender<CtrlMsg>,
    conn_id: ConnId,
    nonce: &str,
    wallet: &mut Option<String>,
    joined: &mut HashSet<String>,
    matches: &mut std::collections::HashMap<String, MatchRecord>,
    msg: ClientMsg,
    holds: &mut FuturesUnordered<HoldTimer>,
) -> Result<(), &'static str> {
    match msg {
        ClientMsg::Connect {
            wallet: w,
            pubkey,
            sig,
            nonce: claimed,
        } => {
            if claimed != nonce {
                return Err("bad_nonce");
            }
            if !auth::verify_ed25519(&pubkey, nonce.as_bytes(), &sig) {
                return Err("bad_signature");
            }
            state.bus.register(conn_id, tx.clone(), ctrl_tx.clone());
            state.mp.set_presence(&w, here(state, conn_id)).await;
            *wallet = Some(w);
            Ok(())
        }
        other => {
            let w = wallet.as_ref().ok_or("not_authenticated")?.clone();
            handle_authed(state, conn_id, &w, joined, matches, other, holds).await
        }
    }
}

async fn handle_authed(
    state: &SharedState,
    conn_id: ConnId,
    wallet: &str,
    joined: &mut HashSet<String>,
    matches: &mut std::collections::HashMap<String, MatchRecord>,
    msg: ClientMsg,
    holds: &mut FuturesUnordered<HoldTimer>,
) -> Result<(), &'static str> {
    match msg {
        ClientMsg::QueueJoin { game, is_bot } => {
            joined.insert(game.clone());
            let me = Waiting {
                wallet: wallet.to_owned(),
                conn: here(state, conn_id),
                is_bot,
            };
            match state
                .mp
                .join_or_pair(&game, me.clone(), state.pair_hold_ms)
                .await
            {
                Some(opp) => {
                    // Seat A = earlier waiter (opp), seat B = this joiner (me).
                    create_and_announce_match(state, &game, opp, me).await;
                }
                None => {
                    // Parked: arm a hold timer on this connection's task. On expiry the select
                    // loop runs the cross-instance fallback. Cancelled if the connection ends.
                    let hold = state.pair_hold_ms;
                    let g = game.clone();
                    holds.push(Box::pin(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(hold)).await;
                        (g, me)
                    }));
                }
            }
            Ok(())
        }
        ClientMsg::QueueLeave => {
            for g in joined.drain() {
                state.mp.leave_queue(&g, wallet).await;
            }
            Ok(())
        }
        ClientMsg::ChallengeCreate {
            target_wallet,
            game,
        } => {
            let Some(target) = state.mp.get_presence(&target_wallet).await else {
                return Err("target_offline");
            };
            let match_id = new_match_id();
            state
                .mp
                .put_invite(
                    &match_id,
                    DirectedInvite {
                        from: wallet.to_owned(),
                        to: target_wallet.clone(),
                        game: game.clone(),
                        from_conn: here(state, conn_id),
                    },
                )
                .await;
            state
                .bus
                .deliver(
                    &target,
                    ServerMsg::ChallengeIncoming {
                        match_id,
                        from_wallet: wallet.to_owned(),
                        game,
                    }
                    .to_text(),
                )
                .await;
            Ok(())
        }
        ClientMsg::ChallengeAccept { match_id } => {
            let Some(inv) = state.mp.take_invite(&match_id, wallet).await else {
                return Err("unknown_invite");
            };
            let rec = build_challenge_match(&inv, wallet, here(state, conn_id));
            state.mp.put_match(&match_id, rec.clone()).await;
            matches.insert(match_id.clone(), rec.clone());
            // Captured before the two delivers consume `match_id`/`rec` so the populate below
            // can warm the waiter's (seat A / inviter) cache with owned copies.
            let (match_id_for_populate, rec_for_populate) = (match_id.clone(), rec.clone());
            state
                .bus
                .deliver(
                    &rec.conn_a,
                    ServerMsg::MatchFound {
                        match_id: match_id.clone(),
                        role: "A".into(),
                        opponent_wallet: rec.seat_b.clone(),
                        game: rec.game.clone(),
                    }
                    .to_text(),
                )
                .await;
            state
                .bus
                .deliver(
                    &rec.conn_b,
                    ServerMsg::MatchFound {
                        match_id,
                        role: "B".into(),
                        opponent_wallet: rec.seat_a,
                        game: rec.game,
                    }
                    .to_text(),
                )
                .await;
            // Warm the inviter's (seat A) relay cache; the accepter (seat B) is this creating
            // connection, already warmed locally.
            state
                .bus
                .populate(
                    &rec_for_populate.conn_a,
                    &match_id_for_populate,
                    &rec_for_populate,
                )
                .await;
            Ok(())
        }
        ClientMsg::ChallengeDecline { match_id } => {
            state.mp.drop_invite(&match_id).await;
            Ok(())
        }
        ClientMsg::PartyHello {
            match_id,
            ephemeral_pubkey,
            wallet_sig,
        } => {
            let envelope = serde_json::json!({
                "type": "party.hello", "matchId": match_id,
                "ephemeralPubkey": ephemeral_pubkey, "walletSig": wallet_sig,
            })
            .to_string();
            forward_to_other(state, &match_id, conn_id, envelope).await;
            Ok(())
        }
        ClientMsg::TunnelOpened {
            match_id,
            tunnel_id,
        } => {
            state.mp.set_tunnel_id(&match_id, &tunnel_id).await;
            Ok(())
        }
        ClientMsg::Relay { match_id, payload } => {
            // PvP throughput: the relay is the one point that sees every move, so count
            // each co-signed MOVE here — one action per move, the off-chain nonce step,
            // parity with self-play's per-update heartbeat. The ACK half is a separate
            // frame and is skipped (else every move double-counts). Only the transport
            // envelope (`t`/`kind`) is read; the game-specific move payload stays opaque.
            // The match record is cached per-connection so the store is hit at most once.
            relay_to_other(state, matches, conn_id, match_id, payload).await;
            Ok(())
        }
        ClientMsg::WatchtowerCheckpoint {
            match_id,
            nonce,
            party_a_balance,
            party_b_balance,
            state_hash,
            sig_a,
            sig_b,
        } => {
            let cp = Checkpoint {
                nonce: nonce.parse().map_err(|_| "bad_checkpoint")?,
                party_a_balance: party_a_balance.parse().map_err(|_| "bad_checkpoint")?,
                party_b_balance: party_b_balance.parse().map_err(|_| "bad_checkpoint")?,
                state_hash,
                sig_a,
                sig_b,
            };
            state.mp.record_checkpoint(&match_id, cp).await;
            Ok(())
        }
        ClientMsg::Resume { match_id } => {
            let me = here(state, conn_id);
            let seat = match state
                .mp
                .rebind_match_conn(&match_id, wallet, me.clone())
                .await
            {
                Some(s) => s,
                None => return Err("not_a_seat"),
            };
            let Some(rec) = state.mp.get_match(&match_id).await else {
                return Err("match_gone");
            };
            // Warm this connection's relay cache so its first post-resume relay needs no GET.
            matches.insert(match_id.clone(), rec.clone());
            // Opponent seat wallet + ConnRef.
            let (opp_wallet, opp_conn) = match seat {
                crate::mp::Seat::A => (rec.seat_b.clone(), rec.conn_b.clone()),
                crate::mp::Seat::B => (rec.seat_a.clone(), rec.conn_a.clone()),
            };
            let peer_online = state.mp.get_presence(&opp_wallet).await.is_some();
            // ResumeOk to self (delivered via the bus to this connection's socket).
            state
                .bus
                .deliver(
                    &me,
                    ServerMsg::ResumeOk {
                        match_id: match_id.clone(),
                        role: seat.as_role().to_owned(),
                        opponent_wallet: opp_wallet,
                        game: rec.game.clone(),
                        peer_online,
                    }
                    .to_text(),
                )
                .await;
            // Tell the opponent we're back: PeerResumed (FE re-sends state) + evict its stale
            // relay-cache entry so its next relay routes to our new ConnRef.
            state
                .bus
                .deliver(
                    &opp_conn,
                    ServerMsg::PeerResumed {
                        match_id: match_id.clone(),
                        seat: seat.as_role().to_owned(),
                        conn_ref: me,
                    }
                    .to_text(),
                )
                .await;
            state.bus.evict(&opp_conn, &match_id).await;
            Ok(())
        }
        ClientMsg::ArenaJoin { match_id } => {
            // Claim the pre-allocated arena match and spawn its bot HERE — co-located with this WS,
            // so the match relays in-process (ADR-0005). This delivers `MatchFound` to us (party A)
            // and starts the bot. An unknown/expired id, a foreign wallet, or a second (already
            // claimed) join all surface as `unknown_arena_match`.
            crate::fleet::colocated::join_and_spawn(state, &match_id, here(state, conn_id), wallet)
                .await
        }
        ClientMsg::Connect { .. } => Err("already_connected"),
    }
}

/// Forward an opaque envelope to the OTHER seat of `match_id`, wherever it lives.
/// Used for the `party.hello` path where a per-connection cache is not available.
async fn forward_to_other(state: &SharedState, match_id: &str, from: ConnId, text: String) {
    let Some(m) = state.mp.get_match(match_id).await else {
        return;
    };
    let target = if m.conn_a.conn_id == from {
        Some(m.conn_b)
    } else if m.conn_b.conn_id == from {
        Some(m.conn_a)
    } else {
        None
    };
    if let Some(t) = target {
        state.bus.deliver(&t, text).await;
    }
}

/// On disconnect, tell each active opponent that this connection's seat dropped so their FE can
/// start its grace timer. Driven by the per-connection relay cache (populated at match creation
/// in Step 3), so it fires even if this seat never relayed a frame. Control-plane only.
async fn notify_peers_dropped(
    state: &SharedState,
    conn_id: ConnId,
    matches: &std::collections::HashMap<String, MatchRecord>,
) {
    for (match_id, rec) in matches {
        let other = if rec.conn_a.conn_id == conn_id {
            Some(&rec.conn_b)
        } else if rec.conn_b.conn_id == conn_id {
            Some(&rec.conn_a)
        } else {
            None
        };
        if let Some(other) = other {
            state
                .bus
                .deliver(
                    other,
                    ServerMsg::PeerDropped {
                        match_id: match_id.clone(),
                    }
                    .to_text(),
                )
                .await;
        }
    }
}

/// Relay a frame using a per-connection match cache: fetch the `MatchRecord` from the
/// store at most once per match, then route every subsequent frame from the in-task copy.
/// Removes both per-move Redis GETs (counting + forwarding). conn_a/conn_b are fixed at
/// match creation, so the cached copy is valid for the life of the connection.
///
/// `pub(crate)` so the co-located fleet's `BusRelayTransport` (ADR-0027) routes a bot's outbound
/// frames through this SAME path — keeping move-counting and seat routing in exact parity with the
/// human WS path instead of duplicating either.
pub(crate) async fn relay_to_other(
    state: &SharedState,
    cache: &mut std::collections::HashMap<String, MatchRecord>,
    from: ConnId,
    match_id: String,
    payload: String,
) {
    if !cache.contains_key(&match_id) {
        match state.mp.get_match(&match_id).await {
            Some(m) => {
                cache.insert(match_id.clone(), m);
            }
            None => return, // unknown match: drop, same as today's get_match None
        }
    }
    let m = &cache[&match_id];
    if relay_payload_is_move(&payload) {
        state.actions.incr(&m.game, 1);
    }
    let target = if m.conn_a.conn_id == from {
        m.conn_b.clone()
    } else if m.conn_b.conn_id == from {
        m.conn_a.clone()
    } else {
        return; // not a seat in this match
    };
    let envelope = ServerMsg::Relay { match_id, payload }.to_text();
    state.bus.deliver(&target, envelope).await;
}

/// True iff a relayed payload carries a co-signed MOVE frame. Fast path: read the outer
/// `kind` tag (the SDK stamps it) without touching the opaque `data`. Fallback: legacy
/// frames without the outer tag are detected by the old inner parse, so SDK/backend can
/// deploy independently. Either way the game-specific move payload is never inspected.
fn relay_payload_is_move(payload: &str) -> bool {
    let Ok(envelope) = serde_json::from_str::<serde_json::Value>(payload) else {
        return false;
    };
    if envelope.get("t").and_then(serde_json::Value::as_str) != Some("frame") {
        return false;
    }
    // Fast path: outer kind tag.
    if let Some(kind) = envelope.get("kind").and_then(serde_json::Value::as_str) {
        return kind == "move";
    }
    // Fallback: legacy frames carry kind only inside the opaque inner `data`.
    let Some(frame_json) = envelope.get("data").and_then(serde_json::Value::as_str) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(frame_json)
        .ok()
        .and_then(|f| {
            f.get("kind")
                .and_then(serde_json::Value::as_str)
                .map(|k| k == "move")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use tokio::sync::mpsc;
    use uuid::Uuid;

    use super::*;
    use crate::mp::MatchRecord;
    use crate::routes::test_support::test_state;
    use crate::state::AppState;
    use crate::store::ConnRef;

    // Keepalive is server-driven (RFC 6455): a browser can't originate pings, so
    // without this the ALB reaps a quiet-but-live match. The immediate first
    // interval tick lets us assert it in milliseconds instead of a full period —
    // a regression that drops the server ping fails here, not in production.
    #[tokio::test]
    async fn server_originates_keepalive_ping_frame() {
        use axum::routing::get;
        use axum::Router;
        use tokio_tungstenite::tungstenite::Message as WsMessage;

        let app = Router::new()
            .route("/v1/mp", get(mp_upgrade))
            .with_state(test_state());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/mp"))
            .await
            .expect("ws connect");

        // Ignore the app-level challenge text; require a Ping control frame promptly.
        let saw_ping = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(Ok(frame)) = ws.next().await {
                if matches!(frame, WsMessage::Ping(_)) {
                    return true;
                }
            }
            false
        })
        .await
        .expect("server must send a ping before the timeout");

        assert!(saw_ping, "server must originate a WS Ping for keepalive");
    }

    fn make_conn_ref(state: &SharedState) -> (ConnId, mpsc::UnboundedReceiver<String>) {
        let conn_id = Uuid::new_v4();
        let (tx, rx) = mpsc::unbounded_channel();
        let (ctrl_tx, _ctrl_rx) = mpsc::unbounded_channel::<CtrlMsg>();
        state.bus.register(conn_id, tx, ctrl_tx);
        (conn_id, rx)
    }

    // Seat A → B, seat B → A, stranger → neither. Covers relay_target_is_the_other_seat.
    #[tokio::test]
    async fn relay_routes_to_the_opposite_seat() {
        let state = test_state();
        let (conn_a, mut rx_a) = make_conn_ref(&state);
        let (conn_b, mut rx_b) = make_conn_ref(&state);
        let (conn_x, mut rx_x) = make_conn_ref(&state);

        let inst = state.bus.instance_id().to_owned();
        let ref_a = ConnRef {
            instance_id: inst.clone(),
            conn_id: conn_a,
        };
        let ref_b = ConnRef {
            instance_id: inst.clone(),
            conn_id: conn_b,
        };
        let rec = MatchRecord {
            game: "chess".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: ref_a,
            conn_b: ref_b,
            tunnel_id: None,
            latest_checkpoint: None,
        };
        state.mp.put_match("m1", rec).await;

        // A sends → B receives
        forward_to_other(&state, "m1", conn_a, "hello_from_a".into()).await;
        assert_eq!(rx_b.try_recv().unwrap(), "hello_from_a");
        assert!(rx_a.try_recv().is_err());

        // B sends → A receives
        forward_to_other(&state, "m1", conn_b, "hello_from_b".into()).await;
        assert_eq!(rx_a.try_recv().unwrap(), "hello_from_b");
        assert!(rx_b.try_recv().is_err());

        // Stranger sends → nobody receives
        forward_to_other(&state, "m1", conn_x, "intrude".into()).await;
        assert!(rx_a.try_recv().is_err());
        assert!(rx_b.try_recv().is_err());
        assert!(rx_x.try_recv().is_err());
    }

    // Quick-match: the earlier waiter (opponent) is seat A; the late joiner is seat B.
    #[tokio::test]
    async fn quick_match_seat_a_is_earlier_waiter() {
        let state = AppState::in_memory_for_test();
        let conn_opp = ConnRef {
            instance_id: state.bus.instance_id().to_owned(),
            conn_id: Uuid::new_v4(),
        };
        let conn_me = ConnRef {
            instance_id: state.bus.instance_id().to_owned(),
            conn_id: Uuid::new_v4(),
        };
        // Register both so deliver() doesn't silently drop the frames.
        let (tx_opp, _rx_opp) = mpsc::unbounded_channel();
        let (ctrl_opp, _) = mpsc::unbounded_channel::<CtrlMsg>();
        state.bus.register(conn_opp.conn_id, tx_opp, ctrl_opp);
        let (tx_me, _rx_me) = mpsc::unbounded_channel();
        let (ctrl_me, _) = mpsc::unbounded_channel::<CtrlMsg>();
        state.bus.register(conn_me.conn_id, tx_me, ctrl_me);

        let opponent = Waiting {
            wallet: "0xearly".into(),
            conn: conn_opp.clone(),
            is_bot: false,
        };
        let joiner = Waiting {
            wallet: "0xlate".into(),
            conn: conn_me.clone(),
            is_bot: false,
        };

        let (_, rec) = create_and_announce_match(&state, "chess", opponent, joiner).await;

        assert_eq!(rec.seat_a, "0xearly", "seat A must be the earlier waiter");
        assert_eq!(rec.seat_b, "0xlate", "seat B must be the late joiner");
        assert_eq!(
            rec.conn_a, conn_opp,
            "conn_a must be the opponent's ConnRef"
        );
        assert_eq!(rec.conn_b, conn_me, "conn_b must be the joiner's ConnRef");
    }

    // Challenge-match: the inviter is seat A; the accepter is seat B.
    #[test]
    fn challenge_match_seat_a_is_inviter() {
        let conn_inviter = ConnRef {
            instance_id: "i".into(),
            conn_id: Uuid::new_v4(),
        };
        let conn_accepter = ConnRef {
            instance_id: "i".into(),
            conn_id: Uuid::new_v4(),
        };
        let inv = DirectedInvite {
            from: "0xinviter".into(),
            to: "0xaccepter".into(),
            game: "ttt".into(),
            from_conn: conn_inviter.clone(),
        };

        let rec = build_challenge_match(&inv, "0xaccepter", conn_accepter.clone());

        assert_eq!(rec.seat_a, "0xinviter", "seat A must be the inviter");
        assert_eq!(rec.seat_b, "0xaccepter", "seat B must be the accepter");
        assert_eq!(
            rec.conn_a, conn_inviter,
            "conn_a must be the inviter's ConnRef"
        );
        assert_eq!(
            rec.conn_b, conn_accepter,
            "conn_b must be the accepter's ConnRef"
        );
    }

    /// Build the relay envelope the SPA sends: an opaque `data` string wrapping a frame.
    fn relay_frame(kind: &str) -> String {
        let frame = serde_json::json!({ "kind": kind, "nonce": "1" }).to_string();
        serde_json::json!({ "t": "frame", "data": frame }).to_string()
    }

    // The fast path: an outer `kind` tag is read WITHOUT parsing the opaque inner `data`.
    // `data` is deliberately not valid JSON here — if the backend still tried to parse it,
    // move detection would fail. It must trust the outer tag.
    #[test]
    fn move_detection_reads_outer_kind_without_parsing_data() {
        let moved =
            serde_json::json!({ "t": "frame", "kind": "move", "data": "::opaque::" }).to_string();
        let acked =
            serde_json::json!({ "t": "frame", "kind": "ack", "data": "::opaque::" }).to_string();
        assert!(relay_payload_is_move(&moved), "outer kind=move counts");
        assert!(!relay_payload_is_move(&acked), "outer kind=ack does not");
    }

    // Throughput counting hinges on this discriminator: a MOVE is one action, an ACK is
    // the co-sign of that same move (not a new action), and peer/control messages aren't
    // game actions at all. Miscount any of these and PvP TPS is wrong.
    #[test]
    fn only_move_frames_count_as_actions() {
        assert!(
            relay_payload_is_move(&relay_frame("move")),
            "MOVE is an action"
        );
        assert!(!relay_payload_is_move(&relay_frame("ack")), "ACK is not");
        let hello = serde_json::json!({ "t": "hello", "ephemeralPubkey": "0xaa" }).to_string();
        assert!(
            !relay_payload_is_move(&hello),
            "peer messages are not actions"
        );
        assert!(
            !relay_payload_is_move("not json"),
            "malformed payload is not a move"
        );
    }

    // A second relay on the same match must NOT hit the store again: the per-connection
    // cache serves conn_a/conn_b after the first fetch. We prove it by overwriting the
    // store record after the first relay and asserting the second still routes correctly.
    #[tokio::test]
    async fn relay_uses_cached_match_after_first_fetch() {
        let state = test_state();
        let (conn_a, _rx_a) = make_conn_ref(&state);
        let (conn_b, mut rx_b) = make_conn_ref(&state);
        let inst = state.bus.instance_id().to_owned();
        let rec = MatchRecord {
            game: "ttt".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: ConnRef {
                instance_id: inst.clone(),
                conn_id: conn_a,
            },
            conn_b: ConnRef {
                instance_id: inst,
                conn_id: conn_b,
            },
            tunnel_id: None,
            latest_checkpoint: None,
        };
        state.mp.put_match("m1", rec).await;
        let mut cache: HashMap<String, MatchRecord> = HashMap::new();

        // first relay populates the cache and delivers to B
        relay_to_other(&state, &mut cache, conn_a, "m1".into(), "first".into()).await;
        assert!(rx_b.try_recv().is_ok(), "first relay delivers to B");
        // delete the authoritative record; the cache must still serve the route
        state
            .mp
            .put_match(
                "m1",
                MatchRecord {
                    game: "ttt".into(),
                    seat_a: "x".into(),
                    seat_b: "x".into(),
                    conn_a: ConnRef {
                        instance_id: "gone".into(),
                        conn_id: uuid::Uuid::nil(),
                    },
                    conn_b: ConnRef {
                        instance_id: "gone".into(),
                        conn_id: uuid::Uuid::nil(),
                    },
                    tunnel_id: None,
                    latest_checkpoint: None,
                },
            )
            .await;
        relay_to_other(&state, &mut cache, conn_a, "m1".into(), "second".into()).await;
        assert!(
            rx_b.try_recv().is_ok(),
            "second relay still routes from cache, not the overwritten store"
        );
    }

    #[tokio::test]
    async fn disconnect_notifies_the_other_seat() {
        let state = test_state();
        let inst = state.bus.instance_id().to_owned();
        let (conn_a, _rx_a) = make_conn_ref(&state); // the dropper (seat A)
        let (conn_b, mut rx_b) = make_conn_ref(&state); // the opponent (seat B)
        let mid = "m-drop";
        let rec = MatchRecord {
            game: "ttt".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: ConnRef {
                instance_id: inst.clone(),
                conn_id: conn_a,
            },
            conn_b: ConnRef {
                instance_id: inst.clone(),
                conn_id: conn_b,
            },
            tunnel_id: None,
            latest_checkpoint: None,
        };
        // A's per-connection cache holds the match (populated at match creation in real flow).
        let mut matches = HashMap::new();
        matches.insert(mid.to_string(), rec);
        // A disconnects.
        notify_peers_dropped(&state, conn_a, &matches).await;
        let b = rx_b.recv().await.unwrap();
        assert!(
            b.contains(r#""type":"peer.dropped""#) && b.contains(r#""matchId":"m-drop""#),
            "got: {b}"
        );
    }

    // Resume re-attach: rebind the stale seat ConnRef, ack the resumer with its role and the
    // peer's live status, notify the opponent (peer.resumed) and evict its stale relay cache.
    #[tokio::test]
    async fn resume_rebinds_seat_and_acks_with_role() {
        let state = test_state();
        let inst = state.bus.instance_id().to_owned();
        let mid = "m-resume";
        // Resumer (seat A) and opponent (seat B) connections, each with a frame receiver.
        let (conn_a, mut rx_a) = make_conn_ref(&state);
        let (conn_b, mut rx_b) = make_conn_ref(&state);
        let ref_b = ConnRef {
            instance_id: inst.clone(),
            conn_id: conn_b,
        };
        // Opponent is "online" (presence set); match has a STALE conn_a to be rebound.
        state.mp.set_presence("0xb", ref_b.clone()).await;
        state
            .mp
            .put_match(
                mid,
                MatchRecord {
                    game: "ttt".into(),
                    seat_a: "0xa".into(),
                    seat_b: "0xb".into(),
                    conn_a: ConnRef {
                        instance_id: "old".into(),
                        conn_id: Uuid::new_v4(),
                    },
                    conn_b: ref_b,
                    tunnel_id: None,
                    latest_checkpoint: None,
                },
            )
            .await;

        let mut joined = HashSet::new();
        let mut matches = HashMap::new();
        let mut holds: FuturesUnordered<HoldTimer> = FuturesUnordered::new();
        handle_authed(
            &state,
            conn_a,
            "0xa",
            &mut joined,
            &mut matches,
            ClientMsg::Resume {
                match_id: mid.into(),
            },
            &mut holds,
        )
        .await
        .unwrap();

        // Resumer got resume.ok with role A and peerOnline true.
        let a = rx_a.recv().await.unwrap();
        assert!(
            a.contains(r#""type":"resume.ok""#)
                && a.contains(r#""role":"A""#)
                && a.contains(r#""peerOnline":true"#),
            "got: {a}"
        );
        // Opponent got peer.resumed carrying the resumer's new ConnRef.
        let b = rx_b.recv().await.unwrap();
        assert!(
            b.contains(r#""type":"peer.resumed""#) && b.contains(r#""seat":"A""#),
            "got: {b}"
        );
        // The store now binds conn_a to the resumer's connection, and the cache is warm.
        assert_eq!(
            state.mp.get_match(mid).await.unwrap().conn_a.conn_id,
            conn_a
        );
        assert!(matches.contains_key(mid), "resumer cache warmed");
    }

    // A wallet that owns neither seat cannot rebind: the store rejects it and the arm errors.
    #[tokio::test]
    async fn resume_rejects_non_seat_wallet() {
        let state = test_state();
        let (conn, _rx) = make_conn_ref(&state);
        let cr = |id: &str| ConnRef {
            instance_id: id.into(),
            conn_id: Uuid::new_v4(),
        };
        state
            .mp
            .put_match(
                "m1",
                MatchRecord {
                    game: "ttt".into(),
                    seat_a: "0xa".into(),
                    seat_b: "0xb".into(),
                    conn_a: cr("i"),
                    conn_b: cr("i"),
                    tunnel_id: None,
                    latest_checkpoint: None,
                },
            )
            .await;
        let mut joined = HashSet::new();
        let mut matches = HashMap::new();
        let mut holds: FuturesUnordered<HoldTimer> = FuturesUnordered::new();
        let r = handle_authed(
            &state,
            conn,
            "0xstranger",
            &mut joined,
            &mut matches,
            ClientMsg::Resume {
                match_id: "m1".into(),
            },
            &mut holds,
        )
        .await;
        assert_eq!(r, Err("not_a_seat"));
    }

    // The behavior that was missing in PvP: a relayed MOVE must feed the actions counter
    // (so it shows up as TPS), while its ACK half must not double-count.
    #[tokio::test]
    async fn relayed_move_records_one_action_and_ack_does_not() {
        let state = test_state();
        let (conn_a, _rx_a) = make_conn_ref(&state);
        let (conn_b, _rx_b) = make_conn_ref(&state);
        let inst = state.bus.instance_id().to_owned();
        let rec = MatchRecord {
            game: "tictactoe".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: ConnRef {
                instance_id: inst.clone(),
                conn_id: conn_a,
            },
            conn_b: ConnRef {
                instance_id: inst,
                conn_id: conn_b,
            },
            tunnel_id: None,
            latest_checkpoint: None,
        };
        state.mp.put_match("m1", rec).await;
        let mut joined = HashSet::new();
        let mut matches = HashMap::new();
        let mut holds: FuturesUnordered<HoldTimer> = FuturesUnordered::new();

        handle_authed(
            &state,
            conn_a,
            "0xa",
            &mut joined,
            &mut matches,
            ClientMsg::Relay {
                match_id: "m1".into(),
                payload: relay_frame("move"),
            },
            &mut holds,
        )
        .await
        .unwrap();
        // Move is counted locally; drain into control before asserting.
        for (g, d) in state.actions.drain_deltas() {
            state.control.add_actions(&g, d).await;
        }
        assert_eq!(
            state.control.snapshot().await.total_actions,
            1,
            "a relayed MOVE must record one action"
        );

        handle_authed(
            &state,
            conn_b,
            "0xb",
            &mut joined,
            &mut matches,
            ClientMsg::Relay {
                match_id: "m1".into(),
                payload: relay_frame("ack"),
            },
            &mut holds,
        )
        .await
        .unwrap();
        // ACK must not produce any delta; drain should yield nothing.
        for (g, d) in state.actions.drain_deltas() {
            state.control.add_actions(&g, d).await;
        }
        assert_eq!(
            state.control.snapshot().await.total_actions,
            1,
            "the ACK half must not add a second action"
        );
    }

    // Register a connection on the bus and return its ConnRef + frame receiver.
    fn test_conn(state: &SharedState) -> (ConnRef, mpsc::UnboundedReceiver<String>) {
        let conn_id = Uuid::new_v4();
        let (tx, rx) = mpsc::unbounded_channel();
        let (ctrl_tx, _ctrl_rx) = mpsc::unbounded_channel::<CtrlMsg>();
        state.bus.register(conn_id, tx, ctrl_tx);
        let cr = ConnRef {
            instance_id: state.bus.instance_id().to_owned(),
            conn_id,
        };
        (cr, rx)
    }

    // Receive a frame and parse it as JSON. Panics if none arrives within 1 s.
    async fn recv_json(rx: &mut mpsc::UnboundedReceiver<String>) -> serde_json::Value {
        let text = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("recv_json timed out")
            .expect("channel closed");
        serde_json::from_str(&text).expect("frame is valid JSON")
    }

    // create_and_announce_match delivers MatchFound to BOTH seats and warms both caches.
    #[tokio::test]
    async fn announce_match_notifies_both_seats() {
        let state = AppState::in_memory_for_test();
        let inst = state.bus.instance_id().to_owned();
        let (ca, mut rxa) = test_conn(&state);
        let (cb, mut rxb) = test_conn(&state);
        let a = Waiting {
            wallet: "0xa".into(),
            conn: ca,
            is_bot: false,
        };
        let b = Waiting {
            wallet: "0xb".into(),
            conn: cb,
            is_bot: false,
        };
        let (_mid, rec) = create_and_announce_match(&state, "ttt", a, b).await;
        assert_eq!(rec.seat_a, "0xa");
        assert_eq!(rec.seat_b, "0xb");
        // Both sockets receive a match.found frame.
        let fa = recv_json(&mut rxa).await;
        let fb = recv_json(&mut rxb).await;
        assert_eq!(fa["type"], "match.found");
        assert_eq!(fa["role"], "A");
        assert_eq!(fa["opponentWallet"], "0xb");
        assert_eq!(fb["type"], "match.found");
        assert_eq!(fb["role"], "B");
        assert_eq!(fb["opponentWallet"], "0xa");
        let _ = inst;
    }

    // The WS handshake response sets the per-browser affinity cookie naming this instance, so the
    // LB can route reconnects back here (preserving co-location). See ADR-0011 / spec §Component 2.
    #[tokio::test]
    async fn mp_upgrade_sets_affinity_cookie() {
        use axum::routing::get;
        use axum::Router;

        let app = Router::new()
            .route("/v1/mp", get(mp_upgrade))
            .with_state(AppState::in_memory_for_test());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        // connect_async returns (stream, Response) — the Response carries the 101 headers.
        let (_ws, resp) = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/mp"))
            .await
            .expect("ws connect");

        let cookie = resp
            .headers()
            .get(axum::http::header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(cookie.starts_with("aff=test-instance"), "got: {cookie}");
    }

    // Two idle cross-instance waiters: the hold timer fires and both sockets receive match.found.
    // Uses a Redis-backed `RedisMpStore` + `LocalBus` so `fallback_pair` operates on real queue
    // state. Both wallets park with a long hold (so the join path never expires them), then wa's
    // hold timer fires and fallback_pair pairs them. Proves the select-loop timer wiring at seam.
    #[tokio::test]
    async fn hold_timer_pairs_two_idle_waiters() {
        use std::sync::Arc;
        use std::time::Duration;
        use testcontainers_modules::redis::Redis;
        use testcontainers_modules::testcontainers::{runners::AsyncRunner, ImageExt};

        use crate::store::memory::LocalBus;
        use crate::store::redis::{connect, RedisMpStore};

        // Spin up an ephemeral Redis 7 container (sharded pub/sub required).
        let node = Redis::default()
            .with_tag("7.4-alpine")
            .start()
            .await
            .expect("start redis container");
        let port = node.get_host_port_ipv4(6379).await.expect("redis port");
        let url = format!("redis://127.0.0.1:{port}");
        let mut pool = None;
        for _ in 0..40 {
            match connect(&url).await {
                Ok(p) => {
                    pool = Some(p);
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        let pool = pool.expect("connect to redis within 2s");

        let mp: Arc<dyn crate::store::MpStore> = Arc::new(RedisMpStore::new(pool));
        let bus: Arc<dyn crate::store::Bus> = Arc::new(LocalBus::new("test-hold".to_owned()));

        // Build a minimal SharedState with the Redis mp + local bus.
        let (stats_tx, _) = tokio::sync::broadcast::channel(4);
        let state: crate::state::SharedState = Arc::new(AppState {
            control: Arc::new(crate::store::memory::InMemoryControlStore::default()),
            mp: mp.clone(),
            bus: bus.clone(),
            settler: Arc::new(crate::sui::SuiSettler::noop()),
            settle_queue: Arc::new(crate::settle_queue::InMemorySettleQueue::default()),
            enoki: None,
            enoki_zklogin: None,
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
            pair_hold_ms: 10_000, // long hold — neither expires via the join path
            pairing: crate::stats_counter::MatchPairingMetrics::default(),
            chat: crate::chat_store::ChatTranscriptStore::new(),
            flash: std::sync::Arc::new(crate::flash_store::FlashTranscriptStore::new()),
            flash_sui_anchor: None,
            flash_loop: crate::flash_loop::FlashLoop::new(None),
            fleet: crate::fleet::BotPool::default(),
            arena_opener: Arc::new(crate::fleet::arena_opener::NoopArenaOpener),
            arena_fleet_count: 0,
            arena_fleet_games: std::collections::HashSet::new(),
            wallet_pool: None,
            faucet_user_amount: 10_000,
            faucet_internal_amount: 1_000_000,
            faucet_cooldown_secs: 1_800,
            faucet_max_per_window: 5,
            faucet_admin_token: None,
            session_jwt_secret: None,
        });

        let game = format!("hold-{}", uuid::Uuid::new_v4().simple());

        // Register two connections on the local bus so deliver() works.
        let (conn_wa_ref, mut rx_wa) = test_conn(&state);
        let (conn_wb_ref, mut rx_wb) = test_conn(&state);

        let wa = Waiting {
            wallet: "0xwa".into(),
            conn: conn_wa_ref.clone(),
            is_bot: false,
        };

        // Park wa first (queue empty → parks, no immediate pair).
        let parked_a = state.mp.join_or_pair(&game, wa.clone(), 10_000).await;
        assert!(parked_a.is_none(), "wa must park");

        // Park wb on a DIFFERENT instance id so the Redis JOIN_OR_PAIR script doesn't see a
        // same-instance partner and parks wb too (same-instance preference would pair them).
        // We inject wb directly with a different instance_id in its ConnRef.
        let wb_other_inst = Waiting {
            wallet: "0xwb".into(),
            conn: ConnRef {
                instance_id: "other-instance".to_owned(),
                conn_id: conn_wb_ref.conn_id,
            },
            is_bot: false,
        };
        let parked_b = state.mp.join_or_pair(&game, wb_other_inst, 10_000).await;
        assert!(parked_b.is_none(), "wb must also park (different instance)");

        // Build wa's hold timer (as the select arm does when join_or_pair returns None).
        let mut holds: FuturesUnordered<HoldTimer> = FuturesUnordered::new();
        let hold_ms: u64 = 30;
        {
            let g = game.clone();
            let me = wa.clone();
            holds.push(Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(hold_ms)).await;
                (g, me)
            }));
        }

        // Drive the timer arm: wait for the hold to expire.
        let (fired_game, fired_me) = tokio::time::timeout(Duration::from_secs(2), holds.next())
            .await
            .expect("hold timer must fire within 2s")
            .expect("holds must yield Some");
        assert_eq!(fired_me.wallet, "0xwa");

        // Execute the fallback exactly as the select arm does.
        let opp = state
            .mp
            .fallback_pair(&fired_game, &fired_me.wallet)
            .await
            .expect("fallback_pair must return wb");
        assert_eq!(opp.wallet, "0xwb", "opponent must be wb");

        // Announce: deliver match.found to both seats.
        // Remap opp's conn to the registered one so deliver() routes locally.
        let opp_remapped = Waiting {
            wallet: opp.wallet.clone(),
            conn: conn_wb_ref.clone(),
            is_bot: false,
        };
        create_and_announce_match(&state, &fired_game, fired_me, opp_remapped).await;

        // Both connections must have received match.found.
        let fa = recv_json(&mut rx_wa).await;
        let fb = recv_json(&mut rx_wb).await;
        assert_eq!(fa["type"], "match.found", "wa must receive match.found");
        assert_eq!(fa["role"], "A", "timer-fired waiter is seat A");
        assert_eq!(fa["opponentWallet"], "0xwb");
        assert_eq!(fb["type"], "match.found", "wb must receive match.found");
        assert_eq!(fb["role"], "B");
        assert_eq!(fb["opponentWallet"], "0xwa");
    }

    // ---- Reusable multi-instance Redis harness --------------------------------------------
    // Factored out of `hold_timer_pairs_two_idle_waiters` so the cross-instance e2e tests below
    // don't re-duplicate the container spin-up and `SharedState` wiring.

    // Ephemeral Redis 7.4 (sharded pub/sub, which `RedisBus` requires). Hold the returned node
    // for the test's lifetime — dropping it stops the container. Returns the mapped port so
    // several instances can share ONE Redis, which is the real multi-instance topology.
    async fn redis_container() -> (
        testcontainers_modules::testcontainers::ContainerAsync<
            testcontainers_modules::redis::Redis,
        >,
        u16,
    ) {
        use crate::store::redis::connect;
        use testcontainers_modules::redis::Redis;
        use testcontainers_modules::testcontainers::{runners::AsyncRunner, ImageExt};

        let node = Redis::default()
            .with_tag("7.4-alpine")
            .start()
            .await
            .expect("start redis container");
        let port = node.get_host_port_ipv4(6379).await.expect("redis port");
        // The mapped port can answer a beat before redis accepts; poll through that window.
        let url = format!("redis://127.0.0.1:{port}");
        for _ in 0..40 {
            if connect(&url).await.is_ok() {
                return (node, port);
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("redis container did not accept connections within 2s");
    }

    // A `SharedState` backed by `RedisMpStore` + `RedisBus` on `port`, identified by
    // `instance_id`. Two of these on one port are two relay instances sharing one Redis: a frame
    // addressed to a conn on the OTHER instance crosses via SPUBLISH, exactly as in production.
    async fn redis_state(
        instance_id: &str,
        port: u16,
        pair_hold_ms: u64,
    ) -> crate::state::SharedState {
        use crate::store::memory::InMemoryControlStore;
        use crate::store::redis::{connect, RedisBus, RedisMpStore};
        use std::sync::Arc;

        let url = format!("redis://127.0.0.1:{port}");
        let mp: Arc<dyn crate::store::MpStore> =
            Arc::new(RedisMpStore::new(connect(&url).await.expect("mp pool")));
        let bus: Arc<dyn crate::store::Bus> = Arc::new(
            RedisBus::new(
                instance_id.to_owned(),
                connect(&url).await.expect("bus pool"),
            )
            .await
            .expect("redis bus"),
        );
        let (stats_tx, _) = tokio::sync::broadcast::channel(4);
        Arc::new(AppState {
            control: Arc::new(InMemoryControlStore::default()),
            mp,
            bus,
            settler: Arc::new(crate::sui::SuiSettler::noop()),
            settle_queue: Arc::new(crate::settle_queue::InMemorySettleQueue::default()),
            enoki: None,
            enoki_zklogin: None,
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
            pair_hold_ms,
            pairing: crate::stats_counter::MatchPairingMetrics::default(),
            chat: crate::chat_store::ChatTranscriptStore::new(),
            flash: std::sync::Arc::new(crate::flash_store::FlashTranscriptStore::new()),
            flash_sui_anchor: None,
            flash_loop: crate::flash_loop::FlashLoop::new(None),
            fleet: crate::fleet::BotPool::default(),
            arena_opener: Arc::new(crate::fleet::arena_opener::NoopArenaOpener),
            arena_fleet_count: 0,
            arena_fleet_games: std::collections::HashSet::new(),
            wallet_pool: None,
            faucet_user_amount: 10_000,
            faucet_internal_amount: 1_000_000,
            faucet_cooldown_secs: 1_800,
            faucet_max_per_window: 5,
            faucet_admin_token: None,
            session_jwt_secret: None,
        })
    }

    // Like `recv_json` but with a caller-chosen timeout: cross-instance delivery over Redis
    // sharded pub/sub needs more than the 1 s same-process budget `recv_json` allows.
    async fn recv_json_within(
        rx: &mut mpsc::UnboundedReceiver<String>,
        secs: u64,
    ) -> serde_json::Value {
        let text = tokio::time::timeout(std::time::Duration::from_secs(secs), rx.recv())
            .await
            .expect("recv_json_within timed out")
            .expect("channel closed");
        serde_json::from_str(&text).expect("frame is valid JSON")
    }

    // Arm a hold timer exactly as the `QueueJoin` park branch does: sleep `hold_ms`, then yield
    // `(game, me)` for the select loop's timer arm to drive `fallback_pair`.
    fn arm_hold(holds: &mut FuturesUnordered<HoldTimer>, game: &str, me: Waiting, hold_ms: u64) {
        let g = game.to_owned();
        holds.push(Box::pin(async move {
            tokio::time::sleep(std::time::Duration::from_millis(hold_ms)).await;
            (g, me)
        }));
    }

    // A split match (seats on different instances) must announce ACROSS instances: the timer-path
    // fallback pairs two cross-instance waiters, and `create_and_announce_match` on the firing
    // instance must reach the remote seat over Redis SPUBLISH — the same `Bus::deliver` path every
    // in-match move takes. Also asserts the pairing is metered as split, not co-located.
    #[tokio::test]
    async fn split_match_announce_crosses_instances() {
        let (_node, port) = redis_container().await;
        let state_a = redis_state("inst-A", port, 10_000).await;
        let state_b = redis_state("inst-B", port, 10_000).await;

        // wa's socket lives on instance A; wb's on instance B.
        let (conn_wa, mut rx_wa) = test_conn(&state_a);
        let (conn_wb, mut rx_wb) = test_conn(&state_b);
        let game = format!("split-{}", Uuid::new_v4().simple());

        // wa joins on A → parks (queue empty).
        let wa = Waiting {
            wallet: "0xwa".into(),
            conn: conn_wa,
            is_bot: false,
        };
        assert!(
            state_a
                .mp
                .join_or_pair(&game, wa.clone(), 10_000)
                .await
                .is_none(),
            "wa parks"
        );
        // wb joins on B → cross-instance, not expired (long hold) → parks too.
        let wb = Waiting {
            wallet: "0xwb".into(),
            conn: conn_wb,
            is_bot: false,
        };
        assert!(
            state_b.mp.join_or_pair(&game, wb, 10_000).await.is_none(),
            "wb parks cross-instance"
        );

        // wa's hold timer fires on instance A → fallback pairs the cross-instance wb.
        let opp = state_a
            .mp
            .fallback_pair(&game, "0xwa")
            .await
            .expect("fallback pairs wb");
        assert_eq!(opp.wallet, "0xwb");
        assert_eq!(
            opp.conn.instance_id, "inst-B",
            "opponent is on the other instance"
        );

        // Announce on A: seat A = wa (local), seat B = wb (remote — must cross via SPUBLISH).
        create_and_announce_match(&state_a, &game, wa, opp).await;

        let fa = recv_json(&mut rx_wa).await; // local delivery, 1 s budget
        assert_eq!(fa["role"], "A");
        assert_eq!(fa["opponentWallet"], "0xwb");
        let fb = recv_json_within(&mut rx_wb, 2).await; // crossed instances over Redis
        assert_eq!(
            fb["type"], "match.found",
            "remote seat gets the announce over SPUBLISH"
        );
        assert_eq!(fb["role"], "B");
        assert_eq!(fb["opponentWallet"], "0xwa");

        assert_eq!(
            state_a.pairing.snapshot(),
            (0, 1),
            "cross-instance pairing is metered as split, not co-located"
        );
    }

    // The join-path/timer race: if a later same-instance joiner pairs a parked waiter before its
    // hold timer fires, the timer's `fallback_pair` must find the waiter already gone and no-op —
    // never a double-pair, never a second match.found. (Single Lua-atomic queue; this is the
    // exactly-once guarantee viewed from the connection layer.)
    #[tokio::test]
    async fn join_path_pairing_makes_hold_timer_a_noop() {
        let (_node, port) = redis_container().await;
        let state = redis_state("inst-A", port, 50).await;
        let (conn_wa, mut rx_wa) = test_conn(&state);
        let (conn_wb, mut rx_wb) = test_conn(&state);
        let game = format!("race-{}", Uuid::new_v4().simple());

        // wa parks and arms its hold timer (as the park branch does).
        let wa = Waiting {
            wallet: "0xwa".into(),
            conn: conn_wa,
            is_bot: false,
        };
        assert!(
            state.mp.join_or_pair(&game, wa.clone(), 50).await.is_none(),
            "wa parks"
        );
        let mut holds: FuturesUnordered<HoldTimer> = FuturesUnordered::new();
        arm_hold(&mut holds, &game, wa, 50);

        // wb joins the SAME instance → same-instance preference pairs wa immediately at join.
        let wb = Waiting {
            wallet: "0xwb".into(),
            conn: conn_wb,
            is_bot: false,
        };
        let opp = state
            .mp
            .join_or_pair(&game, wb.clone(), 50)
            .await
            .expect("join path pairs wa");
        assert_eq!(opp.wallet, "0xwa");
        create_and_announce_match(&state, &game, opp, wb).await; // seat A = wa, seat B = wb
        assert_eq!(recv_json(&mut rx_wa).await["role"], "A");
        assert_eq!(recv_json(&mut rx_wb).await["role"], "B");

        // Now wa's hold timer fires — the waiter is already gone, so the fallback is a no-op.
        let (fg, fme) = tokio::time::timeout(std::time::Duration::from_secs(2), holds.next())
            .await
            .expect("timer fires")
            .expect("yields Some");
        assert!(
            state.mp.fallback_pair(&fg, &fme.wallet).await.is_none(),
            "no double-pair: the join path already consumed wa"
        );
        // wa must NOT receive a second match.found.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), rx_wa.recv())
                .await
                .is_err(),
            "no second announce to the already-paired waiter"
        );
    }

    // A waiter that disconnects during its hold must leave no ghost in the queue: its own
    // `leave_queue` drains it, the late timer no-ops, and a fresh joiner does not pair against the
    // departed wallet. Guards the structural-cancellation claim at the queue level.
    #[tokio::test]
    async fn disconnect_during_hold_leaves_no_phantom() {
        let (_node, port) = redis_container().await;
        let state = redis_state("inst-A", port, 50).await;
        let (conn_wa, _rx_wa) = test_conn(&state);
        let game = format!("drop-{}", Uuid::new_v4().simple());

        let wa = Waiting {
            wallet: "0xwa".into(),
            conn: conn_wa,
            is_bot: false,
        };
        assert!(
            state.mp.join_or_pair(&game, wa.clone(), 50).await.is_none(),
            "wa parks"
        );
        let mut holds: FuturesUnordered<HoldTimer> = FuturesUnordered::new();
        arm_hold(&mut holds, &game, wa, 50);

        // wa disconnects: the socket-end cleanup runs leave_queue for each joined game.
        state.mp.leave_queue(&game, "0xwa").await;

        // The late timer fires but finds wa gone → no-op.
        let (fg, fme) = tokio::time::timeout(std::time::Duration::from_secs(2), holds.next())
            .await
            .expect("timer fires")
            .expect("yields Some");
        assert!(
            state.mp.fallback_pair(&fg, &fme.wallet).await.is_none(),
            "disconnected waiter must not pair"
        );

        // A fresh joiner sees an empty queue — no phantom wa to pair against.
        let (conn_wc, _rx_wc) = test_conn(&state);
        let wc = Waiting {
            wallet: "0xwc".into(),
            conn: conn_wc,
            is_bot: false,
        };
        assert!(
            state.mp.join_or_pair(&game, wc, 50).await.is_none(),
            "no ghost entry: fresh joiner parks instead of pairing the departed wallet"
        );
    }
}
