//! Drives one party asynchronously, bracketed by chain IO: `open` resolves the
//! tunnel and yields the `tunnel_id` the seat is built from; the move loop runs;
//! `settle` submits the co-signed close. A `TranscriptRecorder` taps each
//! committed transition in the loop's effects band, independent of the anchor.

use std::time::Duration;

use crate::{
    Balances, DriverObserver, DriverStart, FrameCodec, FrameTransport, FrameTransportError,
    HarnessError, JsonFrameCodec, MoveCommitted, MoveStrategy, MoveStrategyContext, PartyRuntime,
    Protocol, Seat, SettlementMode, Signer, TranscriptRecorder, TranscriptSettleEntry,
    TunnelAnchor, TunnelAnchorError, TunnelContext, TunnelOpenRequest, TunnelSettleRequest,
};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;
use tokio::sync::watch;
use tunnel_core::protocol_id::ProtocolId;
use tunnel_core::wire::{serialize_settlement, serialize_settlement_with_root, Settlement};

/// Default wait for an ACK before re-sending our co-signed MOVE. Sized well above
/// relay RTT (the peer ACKs mechanically, not at human pace), so a timeout means the
/// MOVE or its ACK was actually dropped — e.g. the browser's first frame arriving
/// before its `onFrame` is wired at match start.
const DEFAULT_ACK_TIMEOUT: Duration = Duration::from_millis(2000);
/// Default number of MOVE re-sends before giving up and aborting the match. Sized to span the
/// peer-resume window (bus_transport `PEER_RESUME_GRACE` = 300s ÷ the 2s ack timeout), NOT a few
/// seconds: a dropped B→A move (or a browser that briefly stops ACKing and then resyncs) must be
/// re-driven long enough to recover — the old cap of 4 (~8s) aborted an otherwise-live match on a
/// single transient relay drop, stranding the human on "opponent's turn". A truly-disconnected peer
/// still ends the match earlier and cheaply via `recv → None` (the transport's own park bound).
const DEFAULT_MAX_ACK_RESENDS: u32 = 150;

#[derive(Debug)]
pub struct DriverOutcome {
    pub moves: u64,
    pub final_balances: Balances,
    /// Wall time spent in the move loop alone, in nanoseconds — excludes anchor
    /// `open`/`settle` and settlement-root construction. Lets callers separate
    /// gameplay latency from chain/setup overhead instead of conflating them
    /// into one end-to-end span.
    pub play_ns: u128,
}

/// Everything needed to build the seat except the `tunnel_id`, which `open`
/// produces. Held by the driver so the seat is constructed post-open.
pub struct SeatParts<P: Protocol, S: Signer> {
    pub protocol: P,
    pub signer: S,
    pub opponent_pk: [u8; 32],
    pub initial: Balances,
    pub seat: Seat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DriverStopMode {
    Hard,
    Graceful,
}

/// Run-level state shared by *every* tunnel in a run: the stop signal and the
/// global committed-move budget. Cloning a [`DriverRunControl`] shares this, so
/// one `request_stop` / move target governs the whole swarm at once.
struct RunLevelControl {
    move_limit: Option<u64>,
    stop_mode: DriverStopMode,
    /// Monotonic count of reserved proposals, consulted only to cap total moves
    /// at `move_limit` under a hard stop. Graceful mode enforces the limit via
    /// committed moves and never reads this.
    reservations: AtomicU64,
    /// Committed moves across all tunnels — the run's move budget. Reaching
    /// `move_limit` requests the run-wide stop.
    moves: AtomicU64,
    stop_tx: watch::Sender<bool>,
}

/// Per-seat-pair drain state. Each tunnel owns its own gate (see
/// [`DriverRunControl::tunnel`]), so one tunnel's in-flight move can never block
/// another tunnel from honoring a stop. Both seats of a tunnel share one gate.
#[derive(Default)]
struct TunnelGate {
    /// Moves proposed by one seat but not yet committed by the other — a frame
    /// is on the wire that the receiver still owes an ack for. The proposer
    /// increments it on reserve; the receiver decrements it on commit.
    inflight: AtomicU64,
}

/// A driver's handle onto the run-wide stop and its single opponent's drain
/// coordination. Cloning shares *both* the run-level state and the per-tunnel
/// gate — that is how the two seats of one tunnel pair up.
/// [`tunnel`](Self::tunnel) mints a fresh gate over the same run-level state for
/// a *different* tunnel.
#[derive(Clone)]
pub struct DriverRunControl {
    run: Arc<RunLevelControl>,
    gate: Arc<TunnelGate>,
}

impl Default for DriverRunControl {
    fn default() -> Self {
        Self::unbounded()
    }
}

impl DriverRunControl {
    fn from_run(run: RunLevelControl) -> Self {
        Self {
            run: Arc::new(run),
            gate: Arc::new(TunnelGate::default()),
        }
    }

    pub fn unbounded() -> Self {
        let (stop_tx, _) = watch::channel(false);
        Self::from_run(RunLevelControl {
            move_limit: None,
            stop_mode: DriverStopMode::Hard,
            reservations: AtomicU64::new(0),
            moves: AtomicU64::new(0),
            stop_tx,
        })
    }

    pub fn with_move_limit(move_limit: u64) -> Self {
        let (stop_tx, _) = watch::channel(move_limit == 0);
        Self::from_run(RunLevelControl {
            move_limit: Some(move_limit),
            stop_mode: DriverStopMode::Hard,
            reservations: AtomicU64::new(0),
            moves: AtomicU64::new(0),
            stop_tx,
        })
    }

    pub fn graceful_unbounded() -> Self {
        let (stop_tx, _) = watch::channel(false);
        Self::from_run(RunLevelControl {
            move_limit: None,
            stop_mode: DriverStopMode::Graceful,
            reservations: AtomicU64::new(0),
            moves: AtomicU64::new(0),
            stop_tx,
        })
    }

    pub fn with_graceful_move_limit(move_limit: u64) -> Self {
        let (stop_tx, _) = watch::channel(move_limit == 0);
        Self::from_run(RunLevelControl {
            move_limit: Some(move_limit),
            stop_mode: DriverStopMode::Graceful,
            reservations: AtomicU64::new(0),
            moves: AtomicU64::new(0),
            stop_tx,
        })
    }

    /// Mint a handle for a *new* tunnel: the same run-level stop/budget, but a
    /// fresh per-tunnel drain gate. Both seats of that tunnel must share the
    /// returned handle (clone it once per seat).
    pub fn tunnel(&self) -> Self {
        Self {
            run: Arc::clone(&self.run),
            gate: Arc::new(TunnelGate::default()),
        }
    }

    pub fn request_stop(&self) {
        self.run.stop_tx.send_replace(true);
    }

    pub fn stopped(&self) -> bool {
        *self.run.stop_tx.borrow()
    }

    pub fn moves(&self) -> u64 {
        self.run.moves.load(Ordering::Relaxed)
    }

    fn subscribe(&self) -> watch::Receiver<bool> {
        self.run.stop_tx.subscribe()
    }

    fn is_graceful(&self) -> bool {
        self.run.stop_mode == DriverStopMode::Graceful
    }

    /// True while this tunnel has a move on the wire that its receiver has not
    /// yet committed. Reads only this tunnel's gate, so concurrent tunnels never
    /// interfere with each other's stop decisions.
    fn has_inflight_move(&self) -> bool {
        self.gate.inflight.load(Ordering::Acquire) > 0
    }

    /// Reserve the right to propose a move. Returns false when the run has
    /// stopped or a hard move-limit cap is reached, in which case the caller
    /// must not send. On success the tunnel gate records the move as in flight.
    fn reserve_move_proposal(&self) -> bool {
        if self.is_graceful() {
            // Graceful drains keep proposing until a close boundary; the limit is
            // enforced through committed moves, not by capping reservations.
            self.gate.inflight.fetch_add(1, Ordering::AcqRel);
            return true;
        }

        let Some(move_limit) = self.run.move_limit else {
            if self.stopped() {
                return false;
            }
            self.gate.inflight.fetch_add(1, Ordering::AcqRel);
            return true;
        };

        loop {
            if self.stopped() {
                return false;
            }
            let reservations = self.run.reservations.load(Ordering::Acquire);
            if reservations >= move_limit {
                return false;
            }
            if self
                .run
                .reservations
                .compare_exchange_weak(
                    reservations,
                    reservations + 1,
                    Ordering::AcqRel,
                    Ordering::Relaxed,
                )
                .is_ok()
            {
                self.gate.inflight.fetch_add(1, Ordering::AcqRel);
                return true;
            }
        }
    }

    /// Record a committed transition. `observer` is the seat reporting it;
    /// `mover` authored the move. The proposer's own ack (`observer == mover`)
    /// is ignored so each move counts exactly once — on the receiver, which is
    /// also where this tunnel's in-flight move clears.
    fn record_committed_move(&self, observer: Seat, mover: Seat) {
        if observer == mover {
            return;
        }

        self.gate.inflight.fetch_sub(1, Ordering::AcqRel);
        let moves = self.run.moves.fetch_add(1, Ordering::Relaxed) + 1;
        if self
            .run
            .move_limit
            .is_some_and(|move_limit| moves >= move_limit)
        {
            self.request_stop();
        }
    }
}

pub struct PartyDriver<P, Pol, Ch, S, A, R, C = JsonFrameCodec>
where
    P: Protocol,
    Pol: MoveStrategy<P>,
    Ch: FrameTransport,
    S: Signer,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<P::Move> + Send + Sync,
    C: FrameCodec<P::Move>,
{
    parts: SeatParts<P, S>,
    move_strategy: Pol,
    frame_transport: Ch,
    anchor: A,
    recorder: R,
    observers: Vec<Box<dyn DriverObserver>>,
    codec: C,
    run_control: Option<DriverRunControl>,
    ack_timeout: Duration,
    max_ack_resends: u32,
}

impl<P, Pol, Ch, S, A, R> PartyDriver<P, Pol, Ch, S, A, R, JsonFrameCodec>
where
    P: Protocol,
    Pol: MoveStrategy<P>,
    Ch: FrameTransport,
    S: Signer,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<P::Move> + Send + Sync,
    JsonFrameCodec: FrameCodec<P::Move>,
{
    pub fn new(
        parts: SeatParts<P, S>,
        move_strategy: Pol,
        frame_transport: Ch,
        anchor: A,
        recorder: R,
    ) -> Self {
        Self::with_codec(
            parts,
            move_strategy,
            frame_transport,
            anchor,
            recorder,
            JsonFrameCodec,
        )
    }
}

impl<P, Pol, Ch, S, A, R, C> PartyDriver<P, Pol, Ch, S, A, R, C>
where
    P: Protocol,
    Pol: MoveStrategy<P>,
    Ch: FrameTransport,
    S: Signer,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<P::Move> + Send + Sync,
    C: FrameCodec<P::Move>,
{
    pub fn with_codec(
        parts: SeatParts<P, S>,
        move_strategy: Pol,
        frame_transport: Ch,
        anchor: A,
        recorder: R,
        codec: C,
    ) -> Self {
        PartyDriver {
            parts,
            move_strategy,
            frame_transport,
            anchor,
            recorder,
            observers: Vec::new(),
            codec,
            run_control: None,
            ack_timeout: DEFAULT_ACK_TIMEOUT,
            max_ack_resends: DEFAULT_MAX_ACK_RESENDS,
        }
    }

    /// Register a passive lifecycle observer. Observers are notified in
    /// registration order; each receives every event read-only.
    pub fn observe(mut self, observer: Box<dyn DriverObserver>) -> Self {
        self.observers.push(observer);
        self
    }

    pub fn with_run_control(mut self, run_control: DriverRunControl) -> Self {
        self.run_control = Some(run_control);
        self
    }

    /// Override the ACK re-send policy (wait before re-sending an unacked MOVE, and the
    /// resend cap). Defaults suit relay play; tests inject a tiny timeout to exercise
    /// the resend path without waiting real seconds.
    pub fn with_ack_resend_policy(mut self, ack_timeout: Duration, max_ack_resends: u32) -> Self {
        self.ack_timeout = ack_timeout;
        self.max_ack_resends = max_ack_resends;
        self
    }

    /// Open, drive to terminal while recording each commit, then settle. Returns
    /// the outcome and the recorder so the caller can export afterwards.
    pub async fn run(
        self,
        max_moves: u64,
        mut now: impl FnMut() -> u64 + Send,
    ) -> Result<(DriverOutcome, R), HarnessError> {
        let PartyDriver {
            parts,
            mut move_strategy,
            frame_transport,
            anchor,
            recorder,
            mut observers,
            codec,
            run_control,
            ack_timeout,
            max_ack_resends,
        } = self;

        let result = Self::drive(
            parts,
            codec,
            &mut move_strategy,
            &frame_transport,
            &anchor,
            &recorder,
            &mut observers,
            max_moves,
            run_control,
            ack_timeout,
            max_ack_resends,
            &mut now,
        )
        .await;

        match result {
            Ok(outcome) => Ok((outcome, recorder)),
            Err(e) => {
                move_strategy.abort();
                for o in &mut observers {
                    o.on_aborted();
                }
                Err(e)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn drive(
        parts: SeatParts<P, S>,
        codec: C,
        move_strategy: &mut Pol,
        frame_transport: &Ch,
        anchor: &A,
        recorder: &R,
        observers: &mut [Box<dyn DriverObserver>],
        max_moves: u64,
        run_control: Option<DriverRunControl>,
        ack_timeout: Duration,
        max_ack_resends: u32,
        now: &mut (impl FnMut() -> u64 + Send),
    ) -> Result<DriverOutcome, HarnessError> {
        let protocol_id = ProtocolId::parse(parts.protocol.name())
            .map_err(|e| HarnessError::Anchor(TunnelAnchorError::Rejected(e.to_string())))?;
        let my_pk = parts.signer.public_key();
        let (party_a, party_b) = match parts.seat {
            Seat::A => (my_pk, parts.opponent_pk),
            Seat::B => (parts.opponent_pk, my_pk),
        };
        let opened = anchor
            .open(TunnelOpenRequest {
                protocol: protocol_id,
                party_a,
                party_b,
                initial: parts.initial,
            })
            .await?;
        let tunnel_id = opened.tunnel_id.clone();
        let final_nonce = opened.onchain_nonce.checked_add(1).ok_or_else(|| {
            HarnessError::Anchor(TunnelAnchorError::Rejected(
                "opened tunnel nonce cannot be closed".into(),
            ))
        })?;
        let min_timestamp = opened.created_at_ms.unwrap_or(0);
        let mut next_timestamp = || now().max(min_timestamp);

        let our_seat = parts.seat;
        let mut seat = PartyRuntime::<P, S, C>::with_codec(
            parts.protocol,
            parts.signer,
            codec,
            parts.opponent_pk,
            TunnelContext {
                tunnel_id,
                initial: parts.initial,
                seat: our_seat,
            },
        );
        recorder.set_tunnel_id(seat.tunnel_id());

        let ctx = MoveStrategyContext {
            tunnel_id: String::new(),
            seat: our_seat,
        };
        let start = DriverStart {
            tunnel_id: seat.tunnel_id(),
            our_seat,
        };
        for o in observers.iter_mut() {
            o.on_started(&start);
        }

        let mut moves = 0u64;
        let mut last_timestamp = 0u64;

        // Time the move loop alone — open already resolved above, settle happens
        // after — so callers get gameplay latency free of chain/setup cost.
        let play_started = Instant::now();
        loop {
            if seat.is_terminal() {
                break;
            }

            // A stop request winds the seat down. A hard stop halts at once; a
            // graceful stop keeps playing only until the protocol reaches a safe
            // close boundary. `boundary_ok` is a pure function of this seat's
            // committed state, so it stays valid even while parked in recv.
            let (stopped, graceful) = run_control
                .as_ref()
                .map_or((false, false), |c| (c.stopped(), c.is_graceful()));
            let boundary_ok = moves == 0 || seat.can_gracefully_close();
            let winding_down = stopped && (!graceful || boundary_ok);

            if moves >= max_moves {
                return Err(HarnessError::Verification(
                    "max moves reached before terminal".into(),
                ));
            }

            // Skip proposing when the protocol pins this nonce's turn to the other seat — a free
            // co-draw whose turn is invisible in the co-signed state, so the strategy can't self-gate
            // (see `Protocol::proposer_for_nonce`). Without this the always-proposing bot cross-proposes
            // with the peer and the seat aborts (`expected ack, got move`). `None` (every state-based
            // game) leaves proposing to the strategy, unchanged.
            let not_our_turn = seat.proposer_for_nonce().is_some_and(|p| p != our_seat);
            // Never open a new move while settling here; fall through to the
            // receiver arm to drain any in-flight move and then stop.
            let planned_move = if winding_down || not_our_turn {
                None
            } else {
                move_strategy.plan_move(seat.state(), our_seat, &ctx).await
            };

            if let Some(mv) = planned_move {
                if let Some(control) = run_control.as_ref() {
                    if !control.reserve_move_proposal() {
                        // Stop won the race, or the hard move cap is reached; loop
                        // back to re-evaluate the stop and settle.
                        continue;
                    }
                }
                let frame = seat.propose(mv, next_timestamp())?;
                let proposed_nonce = seat.nonce() + 1;
                frame_transport.send(frame.clone()).await?;
                // The opponent must ack a move it has seen in flight before it can
                // honor a stop, so this recv cannot hang on a cooperative shutdown.
                let mut resends = 0u32;
                loop {
                    let received =
                        match tokio::time::timeout(ack_timeout, frame_transport.recv()).await {
                            Ok(recv_result) => recv_result?,
                            // No ACK within the window: our MOVE or its ACK was dropped (e.g. the
                            // browser's first frame arriving before its onFrame is wired). Re-send
                            // the same co-signed frame; the peer re-applies/re-ACKs idempotently.
                            Err(_elapsed) => {
                                if resends >= max_ack_resends {
                                    return Err(HarnessError::FrameTransport(
                                        FrameTransportError::Transport(format!(
                                        "no ack for nonce {proposed_nonce} after {resends} resends"
                                    )),
                                    ));
                                }
                                resends += 1;
                                frame_transport.send(frame.clone()).await?;
                                continue;
                            }
                        };
                    let Some(bytes) = received else {
                        return Err(HarnessError::FrameTransport(FrameTransportError::Closed));
                    };
                    let out = seat.handle_frame(&bytes)?;
                    for f in out {
                        frame_transport.send(f).await?;
                    }
                    // A stale/duplicate ACK is absorbed as a no-op (no commit); only advance
                    // once our proposal actually commits, so resends never inflate the count.
                    let Some(entry) = seat.take_last_committed() else {
                        continue;
                    };
                    move_strategy.confirm_move(seat.state());
                    moves += 1;
                    let ev = MoveCommitted {
                        by: our_seat,
                        nonce: seat.nonce(),
                        move_index: moves,
                        timestamp_ms: next_timestamp(),
                    };
                    for o in observers.iter_mut() {
                        o.on_move_committed(&ev);
                    }
                    last_timestamp = entry.timestamp;
                    recorder.record(entry)?;
                    if let Some(control) = run_control.as_ref() {
                        control.record_committed_move(our_seat, our_seat);
                    }
                    break;
                }
                continue;
            }

            // Receiver turn, or winding down with nothing left to propose: take
            // the opponent's move, or stop once it is safe to.
            match Self::recv_or_stop(frame_transport, run_control.as_ref(), boundary_ok).await? {
                DriverRecv::Frame(bytes) => {
                    let out = seat.handle_frame(&bytes)?;
                    for f in out {
                        frame_transport.send(f).await?;
                    }
                    // Only count a genuine commit; a re-delivered MOVE (idempotent re-ACK) or a
                    // stale ACK handled as a no-op must not advance the move count. The per-tunnel
                    // gate must clear only on a real commit, so drain accounting stays balanced.
                    if let Some(entry) = seat.take_last_committed() {
                        // The peer's move just committed — hand the strategy the decoded plaintext
                        // (its one window onto the peer's actual message) before it plans a reply.
                        move_strategy.observe_peer_move(&entry.mv);
                        moves += 1;
                        let ev = MoveCommitted {
                            by: our_seat.other(),
                            nonce: seat.nonce(),
                            move_index: moves,
                            timestamp_ms: next_timestamp(),
                        };
                        for o in observers.iter_mut() {
                            o.on_move_committed(&ev);
                        }
                        last_timestamp = entry.timestamp;
                        recorder.record(entry)?;
                        if let Some(control) = run_control.as_ref() {
                            control.record_committed_move(our_seat, our_seat.other());
                        }
                    }
                }
                DriverRecv::Closed => {
                    return Err(HarnessError::FrameTransport(FrameTransportError::Closed));
                }
                DriverRecv::Stopped => break,
            }
        }

        let play_ns = play_started.elapsed().as_nanos();
        let final_balances = seat.balances();
        // The v2 cooperative close signs `timestamp` into the settlement, and the remote (browser)
        // half signs `timestamp = tunnel.created_at` (it reads it on-chain). So when the anchor
        // surfaces the on-chain createdAt we MUST sign that EXACT value, or the two co-signing halves
        // commit to different bytes and never combine (`combineSettlementWithRoot` fails). Signing
        // createdAt also satisfies the on-chain floor (`timestamp >= tunnel.created_at`). Anchors that
        // don't surface it (in-memory self-play) fall back to the move-loop clock — both seats run
        // this driver there, so they agree regardless.
        let timestamp = match opened.created_at_ms {
            Some(created_at) => created_at,
            None if moves == 0 => next_timestamp(),
            None => last_timestamp,
        };
        let settlement = Settlement {
            tunnel_id: seat.tunnel_id().to_string(),
            party_a_balance: final_balances.a,
            party_b_balance: final_balances.b,
            final_nonce,
            timestamp,
        };
        let (signature, transcript_root, transcript_entries) = match anchor.settlement_mode() {
            SettlementMode::Rootless => (
                seat.sign(&serialize_settlement(&settlement)),
                None,
                Vec::new(),
            ),
            SettlementMode::TranscriptRoot => {
                if !recorder.records_transcript() {
                    return Err(HarnessError::Verification(
                        "anchor requires transcript recorder".into(),
                    ));
                }
                let root = recorder.canonical_root_for_tunnel(seat.tunnel_id())?;
                let transcript = recorder.snapshot();
                let msg = serialize_settlement_with_root(&settlement, &root);
                let entries = transcript
                    .entries()
                    .iter()
                    .map(|entry| {
                        TranscriptSettleEntry::from_transcript_entry(seat.tunnel_id(), entry)
                    })
                    .collect();
                (seat.sign(&msg), Some(root), entries)
            }
        };
        anchor
            .settle(TunnelSettleRequest {
                by: our_seat,
                tunnel_id: seat.tunnel_id().to_string(),
                party_a_balance: final_balances.a,
                party_b_balance: final_balances.b,
                final_nonce,
                timestamp,
                signature,
                transcript_root,
                transcript_entries,
            })
            .await?;

        let outcome = DriverOutcome {
            moves,
            final_balances,
            play_ns,
        };
        for o in observers.iter_mut() {
            o.on_finished(&outcome);
        }
        Ok(outcome)
    }

    /// Wait for the opponent's next move, or return `Stopped` once a cooperative
    /// shutdown is safe to honor. `boundary_ok` reports whether this seat's
    /// committed state sits at a protocol close boundary; it is stable while
    /// parked, so re-checking it on a stop wake is sound.
    async fn recv_or_stop(
        frame_transport: &Ch,
        run_control: Option<&DriverRunControl>,
        boundary_ok: bool,
    ) -> Result<DriverRecv, HarnessError> {
        let Some(run_control) = run_control else {
            return match frame_transport.recv().await? {
                Some(bytes) => Ok(DriverRecv::Frame(bytes)),
                None => Ok(DriverRecv::Closed),
            };
        };

        // A stop is honorable once the run has stopped and this seat is at a safe
        // point: a close boundary for graceful stops, or with nothing in flight
        // for hard stops. The per-tunnel gate keeps `has_inflight_move` scoped to
        // this seat-pair, so a busy neighbor tunnel never blocks the decision.
        let may_stop = || {
            run_control.stopped()
                && !run_control.has_inflight_move()
                && (!run_control.is_graceful() || boundary_ok)
        };

        if may_stop() {
            return Ok(DriverRecv::Stopped);
        }

        let mut stop_rx = run_control.subscribe();
        loop {
            tokio::select! {
                biased;

                frame = frame_transport.recv() => {
                    return match frame? {
                        Some(bytes) => Ok(DriverRecv::Frame(bytes)),
                        // Peer closed its end. If we are already stopping this is
                        // the coordinated shutdown; otherwise it is an unexpected
                        // mid-play EOF that must abort.
                        None if run_control.stopped() => Ok(DriverRecv::Stopped),
                        None => Ok(DriverRecv::Closed),
                    };
                }
                changed = stop_rx.changed() => {
                    if changed.is_err() || may_stop() {
                        return Ok(DriverRecv::Stopped);
                    }
                    // Stopped but not yet safe (a move is still in flight): keep
                    // waiting for the frame that clears the drain.
                }
            }
        }
    }
}

enum DriverRecv {
    Frame(Vec<u8>),
    Closed,
    Stopped,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Balances, FrameTransportError, InMemoryAnchor, InMemoryFrameTransport, LocalSigner,
        NullTranscriptRecorder, OpenedTunnel, Seat, SettledTunnel, Transcript, TranscriptEntry,
        TranscriptError, TunnelOpenRequest,
    };
    use std::marker::PhantomData;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    };
    use tunnel_core::crypto::keypair_from_secret;

    #[derive(Clone)]
    struct OneMoveProtocol;

    #[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
    struct OneMove;

    #[derive(Clone)]
    struct OneMoveState {
        moved: bool,
        balances: Balances,
    }

    #[derive(Clone)]
    struct RepeatingProtocol;

    #[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
    struct RepeatingMove;

    #[derive(Clone)]
    struct RepeatingState {
        moves: u64,
        balances: Balances,
    }

    impl Protocol for RepeatingProtocol {
        type State = RepeatingState;
        type Move = RepeatingMove;

        fn name(&self) -> &str {
            "repeating.v1"
        }

        fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
            RepeatingState {
                moves: 0,
                balances: ctx.initial,
            }
        }

        fn apply_move(
            &self,
            state: &Self::State,
            _mv: &Self::Move,
            by: Seat,
        ) -> Result<Self::State, crate::ProtocolError> {
            if by != Seat::A {
                return Err(crate::ProtocolError("only A can move".into()));
            }
            Ok(RepeatingState {
                moves: state.moves + 1,
                balances: state.balances,
            })
        }

        fn encode_state(&self, state: &Self::State) -> Vec<u8> {
            state.moves.to_le_bytes().to_vec()
        }

        fn balances(&self, state: &Self::State) -> Balances {
            state.balances
        }

        fn is_terminal(&self, state: &Self::State) -> bool {
            state.moves >= 100
        }

        fn can_gracefully_close(&self, state: &Self::State) -> bool {
            state.moves > 0 && state.moves % 3 == 0
        }
    }

    impl Protocol for OneMoveProtocol {
        type State = OneMoveState;
        type Move = OneMove;

        fn name(&self) -> &str {
            "one_move.v1"
        }

        fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
            OneMoveState {
                moved: false,
                balances: ctx.initial,
            }
        }

        fn apply_move(
            &self,
            state: &Self::State,
            _mv: &Self::Move,
            by: Seat,
        ) -> Result<Self::State, crate::ProtocolError> {
            if by != Seat::A {
                return Err(crate::ProtocolError("only A can move".into()));
            }
            if state.moved {
                return Err(crate::ProtocolError("already moved".into()));
            }
            Ok(OneMoveState {
                moved: true,
                balances: state.balances,
            })
        }

        fn encode_state(&self, state: &Self::State) -> Vec<u8> {
            vec![u8::from(state.moved)]
        }

        fn balances(&self, state: &Self::State) -> Balances {
            state.balances
        }

        fn is_terminal(&self, state: &Self::State) -> bool {
            state.moved
        }
    }

    #[derive(Clone)]
    struct RejectingRecorder<M>(PhantomData<M>);

    impl<M> Default for RejectingRecorder<M> {
        fn default() -> Self {
            Self(PhantomData)
        }
    }

    impl<M> TranscriptRecorder<M> for RejectingRecorder<M> {
        fn record(&self, entry: TranscriptEntry<M>) -> Result<(), TranscriptError> {
            Err(TranscriptError::DuplicateNonce { nonce: entry.nonce })
        }

        fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
            Transcript::from_entries(Vec::new())
        }
    }

    struct TrackingStrategy {
        seat: Seat,
        planned: Arc<AtomicU64>,
        confirmed: Arc<AtomicU64>,
        aborted: Arc<AtomicU64>,
    }

    impl TrackingStrategy {
        fn new(
            seat: Seat,
            planned: Arc<AtomicU64>,
            confirmed: Arc<AtomicU64>,
            aborted: Arc<AtomicU64>,
        ) -> Self {
            Self {
                seat,
                planned,
                confirmed,
                aborted,
            }
        }
    }

    impl MoveStrategy<OneMoveProtocol> for TrackingStrategy {
        async fn plan_move(
            &mut self,
            state: &OneMoveState,
            seat: Seat,
            _ctx: &crate::MoveStrategyContext,
        ) -> Option<OneMove> {
            if self.seat == Seat::A && seat == Seat::A && !state.moved {
                self.planned.fetch_add(1, Ordering::Relaxed);
                return Some(OneMove);
            }
            None
        }

        fn confirm_move(&mut self, state: &OneMoveState) {
            if state.moved {
                self.confirmed.fetch_add(1, Ordering::Relaxed);
            }
        }

        fn abort(&mut self) {
            self.aborted.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Seat A proposes the single move; seat B only listens. `observed` counts how many
    /// times this seat's `observe_peer_move` fired — the hook an LLM strategy relies on.
    struct ObservingStrategy {
        seat: Seat,
        observed: Arc<AtomicU64>,
    }

    impl MoveStrategy<OneMoveProtocol> for ObservingStrategy {
        async fn plan_move(
            &mut self,
            state: &OneMoveState,
            seat: Seat,
            _ctx: &crate::MoveStrategyContext,
        ) -> Option<OneMove> {
            if self.seat == Seat::A && seat == Seat::A && !state.moved {
                return Some(OneMove);
            }
            None
        }

        fn observe_peer_move(&mut self, _mv: &OneMove) {
            self.observed.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn parts(
        seat: Seat,
        secret: &[u8; 32],
        opponent_pk: [u8; 32],
    ) -> SeatParts<OneMoveProtocol, LocalSigner> {
        SeatParts {
            protocol: OneMoveProtocol,
            signer: LocalSigner::from_secret(secret),
            opponent_pk,
            initial: Balances { a: 100, b: 100 },
            seat,
        }
    }

    fn repeating_parts(
        seat: Seat,
        secret: &[u8; 32],
        opponent_pk: [u8; 32],
    ) -> SeatParts<RepeatingProtocol, LocalSigner> {
        SeatParts {
            protocol: RepeatingProtocol,
            signer: LocalSigner::from_secret(secret),
            opponent_pk,
            initial: Balances { a: 100, b: 100 },
            seat,
        }
    }

    struct RepeatingStrategy;

    impl MoveStrategy<RepeatingProtocol> for RepeatingStrategy {
        async fn plan_move(
            &mut self,
            _state: &RepeatingState,
            seat: Seat,
            _ctx: &crate::MoveStrategyContext,
        ) -> Option<RepeatingMove> {
            (seat == Seat::A).then_some(RepeatingMove)
        }
    }

    struct StopAfterSendTransport<T> {
        inner: T,
        run_control: DriverRunControl,
    }

    impl<T: FrameTransport> FrameTransport for StopAfterSendTransport<T> {
        async fn send(&self, bytes: Vec<u8>) -> Result<(), FrameTransportError> {
            self.inner.send(bytes).await?;
            self.run_control.request_stop();
            Ok(())
        }

        async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
            self.inner.recv().await
        }
    }

    struct StopAfterNthSendTransport<T> {
        inner: T,
        run_control: DriverRunControl,
        sends: Arc<AtomicU64>,
        stop_after_send: u64,
    }

    impl<T: FrameTransport> FrameTransport for StopAfterNthSendTransport<T> {
        async fn send(&self, bytes: Vec<u8>) -> Result<(), FrameTransportError> {
            self.inner.send(bytes).await?;
            let sends = self.sends.fetch_add(1, Ordering::Relaxed) + 1;
            if sends == self.stop_after_send {
                self.run_control.request_stop();
            }
            Ok(())
        }

        async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
            self.inner.recv().await
        }
    }

    struct StopBeforeSendTransport<T> {
        inner: T,
        run_control: DriverRunControl,
    }

    impl<T: FrameTransport> FrameTransport for StopBeforeSendTransport<T> {
        async fn send(&self, bytes: Vec<u8>) -> Result<(), FrameTransportError> {
            self.run_control.request_stop();
            tokio::task::yield_now().await;
            self.inner.send(bytes).await
        }

        async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
            self.inner.recv().await
        }
    }

    struct StopOnRecvCallTransport<T> {
        inner: T,
        run_control: DriverRunControl,
        recv_calls: Arc<AtomicU64>,
        stop_on_call: u64,
    }

    impl<T: FrameTransport> FrameTransport for StopOnRecvCallTransport<T> {
        async fn send(&self, bytes: Vec<u8>) -> Result<(), FrameTransportError> {
            self.inner.send(bytes).await
        }

        async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
            let call = self.recv_calls.fetch_add(1, Ordering::Relaxed) + 1;
            if call == self.stop_on_call {
                self.run_control.request_stop();
                tokio::task::yield_now().await;
            }
            self.inner.recv().await
        }
    }

    struct ReadyFrameTransport {
        frame: Vec<u8>,
        recv_calls: Arc<AtomicU64>,
    }

    impl FrameTransport for ReadyFrameTransport {
        async fn send(&self, _bytes: Vec<u8>) -> Result<(), FrameTransportError> {
            Ok(())
        }

        async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
            self.recv_calls.fetch_add(1, Ordering::Relaxed);
            Ok(Some(self.frame.clone()))
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_control_move_limit_stops_non_terminal_drivers_and_settles() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests));
        let run_control = DriverRunControl::with_move_limit(2);

        let driver_a = PartyDriver::new(
            repeating_parts(Seat::A, &secret_a, pk_b),
            RepeatingStrategy,
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());
        let driver_b = PartyDriver::new(
            repeating_parts(Seat::B, &secret_b, pk_a),
            RepeatingStrategy,
            ch_b,
            anchor,
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());

        let (out_a, out_b) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1))
        })
        .await
        .expect("drivers should stop and settle after the cooperative limit");

        let (out_a, _) = out_a.unwrap();
        let (out_b, _) = out_b.unwrap();
        assert_eq!(out_a.moves, 2);
        assert_eq!(out_b.moves, 2);
        assert_eq!(run_control.moves(), 2);
        assert!(run_control.stopped());
        assert_eq!(settled.load(Ordering::Relaxed), 2);

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r.party_a_balance == 100));
        assert!(requests.iter().all(|r| r.party_b_balance == 100));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn graceful_move_limit_drains_until_protocol_close_boundary() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests));
        let run_control = DriverRunControl::with_graceful_move_limit(1);

        let driver_a = PartyDriver::new(
            repeating_parts(Seat::A, &secret_a, pk_b),
            RepeatingStrategy,
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());
        let driver_b = PartyDriver::new(
            repeating_parts(Seat::B, &secret_b, pk_a),
            RepeatingStrategy,
            ch_b,
            anchor,
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());

        let (out_a, out_b) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1))
        })
        .await
        .expect("drivers should stop at the first close boundary after the limit");

        let (out_a, _) = out_a.unwrap();
        let (out_b, _) = out_b.unwrap();
        assert_eq!(out_a.moves, 3);
        assert_eq!(out_b.moves, 3);
        assert_eq!(run_control.moves(), 3);
        assert!(run_control.stopped());
        assert_eq!(settled.load(Ordering::Relaxed), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn graceful_external_stop_wakes_receiver_at_close_boundary() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests));
        let run_control = DriverRunControl::graceful_unbounded();
        let recv_calls = Arc::new(AtomicU64::new(0));

        let driver_a = PartyDriver::new(
            repeating_parts(Seat::A, &secret_a, pk_b),
            RepeatingStrategy,
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());
        let driver_b = PartyDriver::new(
            repeating_parts(Seat::B, &secret_b, pk_a),
            RepeatingStrategy,
            StopOnRecvCallTransport {
                inner: ch_b,
                run_control: run_control.clone(),
                recv_calls,
                stop_on_call: 4,
            },
            anchor,
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());

        let (out_a, out_b) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1))
        })
        .await
        .expect("graceful stop should wake a receiver already parked at a close boundary");

        let (out_a, _) = out_a.unwrap();
        let (out_b, _) = out_b.unwrap();
        assert_eq!(out_a.moves, 3);
        assert_eq!(out_b.moves, 3);
        assert_eq!(run_control.moves(), 3);
        assert!(run_control.stopped());
        assert_eq!(settled.load(Ordering::Relaxed), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn graceful_stop_after_peer_close_boundary_still_acks_reserved_move() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests));
        let run_control = DriverRunControl::graceful_unbounded();
        let sends = Arc::new(AtomicU64::new(0));

        let driver_a = PartyDriver::new(
            repeating_parts(Seat::A, &secret_a, pk_b),
            RepeatingStrategy,
            StopAfterNthSendTransport {
                inner: ch_a,
                run_control: run_control.clone(),
                sends,
                stop_after_send: 4,
            },
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());
        let driver_b = PartyDriver::new(
            repeating_parts(Seat::B, &secret_b, pk_a),
            RepeatingStrategy,
            ch_b,
            anchor,
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());

        let (out_a, out_b) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1))
        })
        .await
        .expect("reserved move should be acked before graceful stop is honored");

        let (out_a, _) = out_a.unwrap();
        let (out_b, _) = out_b.unwrap();
        assert_eq!(out_a.moves, 6);
        assert_eq!(out_b.moves, 6);
        assert_eq!(run_control.moves(), 6);
        assert!(run_control.stopped());
        assert_eq!(settled.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn run_control_reserves_move_limit_exactly() {
        let run_control = DriverRunControl::with_move_limit(1);

        assert!(run_control.reserve_move_proposal());
        assert!(!run_control.reserve_move_proposal());
        assert_eq!(run_control.moves(), 0);

        run_control.record_committed_move(Seat::B, Seat::A);

        assert_eq!(run_control.moves(), 1);
        assert!(run_control.stopped());
    }

    #[tokio::test]
    async fn graceful_stop_waits_for_outstanding_reserved_move() {
        let run_control = DriverRunControl::graceful_unbounded();
        assert!(run_control.reserve_move_proposal());
        run_control.request_stop();
        assert!(run_control.has_inflight_move());

        let recv_calls = Arc::new(AtomicU64::new(0));
        let transport = ReadyFrameTransport {
            frame: vec![42],
            recv_calls: Arc::clone(&recv_calls),
        };

        let received = PartyDriver::<
            RepeatingProtocol,
            RepeatingStrategy,
            ReadyFrameTransport,
            LocalSigner,
            InMemoryAnchor,
            NullTranscriptRecorder,
        >::recv_or_stop(&transport, Some(&run_control), true)
        .await
        .unwrap();

        assert!(matches!(received, DriverRecv::Frame(bytes) if bytes == vec![42]));
        assert_eq!(recv_calls.load(Ordering::Relaxed), 1);
    }

    async fn run_repeating_tunnel_to_settlement(control: DriverRunControl) -> u64 {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests));
        let driver_a = PartyDriver::new(
            repeating_parts(Seat::A, &secret_a, pk_b),
            RepeatingStrategy,
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .with_run_control(control.clone());
        let driver_b = PartyDriver::new(
            repeating_parts(Seat::B, &secret_b, pk_a),
            RepeatingStrategy,
            ch_b,
            anchor,
            NullTranscriptRecorder,
        )
        .with_run_control(control);
        let (out_a, out_b) = tokio::join!(driver_a.run(100, || 1), driver_b.run(100, || 1));
        out_a.expect("seat A settles");
        out_b.expect("seat B settles");
        settled.load(Ordering::Relaxed)
    }

    #[test]
    fn tunnels_isolate_inflight_from_one_another() {
        // One run-wide control governs every tunnel's stop, yet each tunnel must
        // drain on its own: a move in flight in one tunnel must not pin another
        // tunnel's graceful stop. Regression for the shared-counter deadlock that
        // wedged large concurrent settlements.
        let run = DriverRunControl::graceful_unbounded();
        let tunnel_a = run.tunnel();
        let tunnel_b = run.tunnel();

        assert!(tunnel_a.reserve_move_proposal());
        assert!(tunnel_a.has_inflight_move());

        run.request_stop();
        assert!(tunnel_a.stopped() && tunnel_b.stopped());

        assert!(
            !tunnel_b.has_inflight_move(),
            "tunnel B must not observe tunnel A's in-flight move"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_tunnels_all_settle_under_shared_graceful_stop() {
        // Two tunnels share one run-level graceful control, exactly as the swarm
        // does. The shared move budget stops both, and each must reach its own
        // close boundary and settle — neither wedged by the other's in-flight
        // move. Under the old shared-counter drain this deadlocked.
        let run_control = DriverRunControl::with_graceful_move_limit(1);

        let settled = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                run_repeating_tunnel_to_settlement(run_control.tunnel()),
                run_repeating_tunnel_to_settlement(run_control.tunnel()),
            )
        })
        .await
        .expect("both tunnels must settle without deadlock");

        assert_eq!(settled.0, 2, "tunnel 1 must settle both seats");
        assert_eq!(settled.1, 2, "tunnel 2 must settle both seats");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn graceful_stop_before_first_move_settles_initial_state() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests));
        let run_control = DriverRunControl::graceful_unbounded();
        run_control.request_stop();

        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_b,
            anchor,
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());

        let (out_a, out_b) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1))
        })
        .await
        .expect("drivers should settle initial state when graceful stop precedes play");

        let (out_a, _) = out_a.unwrap();
        let (out_b, _) = out_b.unwrap();
        assert_eq!(out_a.moves, 0);
        assert_eq!(out_b.moves, 0);
        assert_eq!(run_control.moves(), 0);
        assert_eq!(settled.load(Ordering::Relaxed), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn external_stop_after_queued_move_still_allows_ack_and_settlement() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests));
        let run_control = DriverRunControl::unbounded();

        let driver_a = PartyDriver::new(
            repeating_parts(Seat::A, &secret_a, pk_b),
            RepeatingStrategy,
            StopAfterSendTransport {
                inner: ch_a,
                run_control: run_control.clone(),
            },
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());
        let driver_b = PartyDriver::new(
            repeating_parts(Seat::B, &secret_b, pk_a),
            RepeatingStrategy,
            ch_b,
            anchor,
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());

        let (out_a, out_b) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1))
        })
        .await
        .expect("queued move should be acked before cooperative stop is honored");

        let (out_a, _) = out_a.unwrap();
        let (out_b, _) = out_b.unwrap();
        assert_eq!(out_a.moves, 1);
        assert_eq!(out_b.moves, 1);
        assert_eq!(run_control.moves(), 1);
        assert!(run_control.stopped());
        assert_eq!(settled.load(Ordering::Relaxed), 2);

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r.party_a_balance == 100));
        assert!(requests.iter().all(|r| r.party_b_balance == 100));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn external_stop_after_reservation_before_send_still_allows_ack_and_settlement() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests));
        let run_control = DriverRunControl::with_move_limit(1);

        let driver_a = PartyDriver::new(
            repeating_parts(Seat::A, &secret_a, pk_b),
            RepeatingStrategy,
            StopBeforeSendTransport {
                inner: ch_a,
                run_control: run_control.clone(),
            },
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());
        let driver_b = PartyDriver::new(
            repeating_parts(Seat::B, &secret_b, pk_a),
            RepeatingStrategy,
            ch_b,
            anchor,
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());

        let (out_a, out_b) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1))
        })
        .await
        .expect("reserved move should be acked before cooperative stop is honored");

        let (out_a, _) = out_a.unwrap();
        let (out_b, _) = out_b.unwrap();
        assert_eq!(out_a.moves, 1);
        assert_eq!(out_b.moves, 1);
        assert_eq!(run_control.moves(), 1);
        assert!(run_control.stopped());
        assert_eq!(settled.load(Ordering::Relaxed), 2);

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r.party_a_balance == 100));
        assert!(requests.iter().all(|r| r.party_b_balance == 100));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unbounded_external_stop_after_reservation_before_send_still_allows_ack_and_settlement()
    {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests));
        let run_control = DriverRunControl::unbounded();

        let driver_a = PartyDriver::new(
            repeating_parts(Seat::A, &secret_a, pk_b),
            RepeatingStrategy,
            StopBeforeSendTransport {
                inner: ch_a,
                run_control: run_control.clone(),
            },
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());
        let driver_b = PartyDriver::new(
            repeating_parts(Seat::B, &secret_b, pk_a),
            RepeatingStrategy,
            ch_b,
            anchor,
            NullTranscriptRecorder,
        )
        .with_run_control(run_control.clone());

        let (out_a, out_b) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1))
        })
        .await
        .expect("reserved move should be acked before duration stop is honored");

        let (out_a, _) = out_a.unwrap();
        let (out_b, _) = out_b.unwrap();
        assert_eq!(out_a.moves, 1);
        assert_eq!(out_b.moves, 1);
        assert_eq!(run_control.moves(), 1);
        assert!(run_control.stopped());
        assert_eq!(settled.load(Ordering::Relaxed), 2);

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r.party_a_balance == 100));
        assert!(requests.iter().all(|r| r.party_b_balance == 100));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn strategy_confirms_after_own_move_is_acked() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let planned = Arc::new(AtomicU64::new(0));
        let confirmed = Arc::new(AtomicU64::new(0));
        let aborted = Arc::new(AtomicU64::new(0));

        let anchor = InMemoryAnchor::with_fixed_id("0x1");
        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::clone(&planned),
                Arc::clone(&confirmed),
                Arc::clone(&aborted),
            ),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::clone(&planned),
                Arc::clone(&confirmed),
                Arc::clone(&aborted),
            ),
            ch_b,
            anchor.clone(),
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1),);

        assert!(out_a.unwrap().0.final_balances.sum() == 200);
        assert!(out_b.unwrap().0.final_balances.sum() == 200);
        assert_eq!(planned.load(Ordering::Relaxed), 1);
        assert_eq!(confirmed.load(Ordering::Relaxed), 1);
        assert_eq!(aborted.load(Ordering::Relaxed), 0);
    }

    // The driver must hand the receiving seat its peer's committed move via `observe_peer_move`
    // (and never fire it for the seat's own move): the seam an LLM strategy uses to read the
    // opponent's plaintext, which the co-signed state otherwise hides behind the folded digest.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn strategy_observes_only_the_peers_committed_move() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let observed_a = Arc::new(AtomicU64::new(0));
        let observed_b = Arc::new(AtomicU64::new(0));

        let anchor = InMemoryAnchor::with_fixed_id("0x1");
        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            ObservingStrategy {
                seat: Seat::A,
                observed: Arc::clone(&observed_a),
            },
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            ObservingStrategy {
                seat: Seat::B,
                observed: Arc::clone(&observed_b),
            },
            ch_b,
            anchor.clone(),
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1));
        out_a.unwrap();
        out_b.unwrap();

        // B received A's single move → observed exactly once; A proposed its own move and received
        // nothing back, so its peer-observe hook never fires.
        assert_eq!(observed_b.load(Ordering::Relaxed), 1, "B observes A's move");
        assert_eq!(
            observed_a.load(Ordering::Relaxed),
            0,
            "a seat never observes its own move"
        );
    }

    // Silently drops the first frame this seat sends, then behaves normally — models
    // the peer's first frame landing before its receiver is wired at match start.
    struct DropFirstSend {
        inner: InMemoryFrameTransport,
        dropped: std::sync::atomic::AtomicBool,
    }

    impl DropFirstSend {
        fn new(inner: InMemoryFrameTransport) -> Self {
            Self {
                inner,
                dropped: std::sync::atomic::AtomicBool::new(false),
            }
        }
    }

    impl FrameTransport for DropFirstSend {
        async fn send(&self, bytes: Vec<u8>) -> Result<(), FrameTransportError> {
            if !self.dropped.swap(true, Ordering::Relaxed) {
                return Ok(());
            }
            self.inner.send(bytes).await
        }

        async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
            self.inner.recv().await
        }
    }

    // A dropped MOVE must be recovered by a re-send and commit exactly once — the resend
    // must not inflate the move count or fire confirm_move per attempt.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resends_dropped_move_and_commits_once() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let confirmed = Arc::new(AtomicU64::new(0));
        let anchor = InMemoryAnchor::with_fixed_id("0x1");

        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::clone(&confirmed),
                Arc::new(AtomicU64::new(0)),
            ),
            DropFirstSend::new(ch_a),
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .with_ack_resend_policy(Duration::from_millis(50), 5);
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_b,
            anchor.clone(),
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1));
        let (oa, _) = out_a.unwrap();
        let (ob, _) = out_b.unwrap();
        assert_eq!(oa.moves, 1);
        assert_eq!(ob.moves, 1);
        assert_eq!(oa.final_balances.sum(), 200);
        assert_eq!(confirmed.load(Ordering::Relaxed), 1);
    }

    struct FailingSendTransport;

    impl FrameTransport for FailingSendTransport {
        async fn send(&self, _bytes: Vec<u8>) -> Result<(), FrameTransportError> {
            Err(FrameTransportError::Transport("send failed".into()))
        }

        async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
            Ok(None)
        }
    }

    #[tokio::test]
    async fn strategy_aborts_when_driver_errors() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let planned = Arc::new(AtomicU64::new(0));
        let confirmed = Arc::new(AtomicU64::new(0));
        let aborted = Arc::new(AtomicU64::new(0));
        let driver = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::clone(&planned),
                Arc::clone(&confirmed),
                Arc::clone(&aborted),
            ),
            FailingSendTransport,
            InMemoryAnchor::with_fixed_id("0x1"),
            NullTranscriptRecorder,
        );

        let err = driver.run(10, || 1).await.unwrap_err();

        assert_eq!(
            err,
            HarnessError::FrameTransport(FrameTransportError::Transport("send failed".into()))
        );
        assert_eq!(planned.load(Ordering::Relaxed), 1);
        assert_eq!(confirmed.load(Ordering::Relaxed), 0);
        assert_eq!(aborted.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn max_moves_before_terminal_aborts_without_settling() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let settled = Arc::new(AtomicU64::new(0));
        let driver = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            FailingSendTransport,
            CapturingAnchor::new(
                "0x1",
                0,
                Arc::clone(&settled),
                Arc::new(Mutex::new(Vec::new())),
            ),
            NullTranscriptRecorder,
        );

        let err = driver.run(0, || 1).await.unwrap_err();

        assert!(matches!(err, HarnessError::Verification(_)));
        assert_eq!(settled.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn peer_eof_before_terminal_aborts_without_settling() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let settled = Arc::new(AtomicU64::new(0));
        let driver = PartyDriver::new(
            parts(Seat::B, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            FailingSendTransport,
            CapturingAnchor::new(
                "0x1",
                0,
                Arc::clone(&settled),
                Arc::new(Mutex::new(Vec::new())),
            ),
            NullTranscriptRecorder,
        );

        let err = driver.run(10, || 1).await.unwrap_err();

        assert_eq!(
            err,
            HarnessError::FrameTransport(FrameTransportError::Closed)
        );
        assert_eq!(settled.load(Ordering::Relaxed), 0);
    }

    #[derive(Clone)]
    struct CapturingAnchor {
        tunnel_id: String,
        onchain_nonce: u64,
        created_at_ms: Option<u64>,
        settlement_mode: SettlementMode,
        settled: Arc<AtomicU64>,
        requests: Arc<Mutex<Vec<TunnelSettleRequest>>>,
    }

    impl CapturingAnchor {
        fn new(
            tunnel_id: &str,
            onchain_nonce: u64,
            settled: Arc<AtomicU64>,
            requests: Arc<Mutex<Vec<TunnelSettleRequest>>>,
        ) -> Self {
            Self {
                tunnel_id: tunnel_id.into(),
                onchain_nonce,
                created_at_ms: None,
                settlement_mode: SettlementMode::Rootless,
                settled,
                requests,
            }
        }

        fn with_created_at_ms(mut self, created_at_ms: u64) -> Self {
            self.created_at_ms = Some(created_at_ms);
            self
        }

        fn with_settlement_mode(mut self, settlement_mode: SettlementMode) -> Self {
            self.settlement_mode = settlement_mode;
            self
        }
    }

    impl TunnelAnchor for CapturingAnchor {
        fn settlement_mode(&self) -> SettlementMode {
            self.settlement_mode
        }

        async fn open(
            &self,
            _request: TunnelOpenRequest,
        ) -> Result<OpenedTunnel, TunnelAnchorError> {
            Ok(OpenedTunnel {
                tunnel_id: self.tunnel_id.clone(),
                created: true,
                onchain_nonce: self.onchain_nonce,
                created_at_ms: self.created_at_ms,
            })
        }

        async fn settle(
            &self,
            request: TunnelSettleRequest,
        ) -> Result<SettledTunnel, TunnelAnchorError> {
            self.settled.fetch_add(1, Ordering::Relaxed);
            self.requests.lock().unwrap().push(request);
            Ok(SettledTunnel {
                digest: "0xdigest".into(),
                final_balances: Balances { a: 100, b: 100 },
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settlement_uses_opened_tunnel_onchain_nonce() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 41, Arc::clone(&settled), Arc::clone(&requests));

        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_b,
            anchor,
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1));
        out_a.unwrap();
        out_b.unwrap();

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r.final_nonce == 42));
    }

    // The v2 cooperative close signs `timestamp` into the settlement, and the browser half signs
    // `timestamp = tunnel.created_at` (it reads it on-chain). When the anchor surfaces the on-chain
    // createdAt the driver MUST sign that EXACT value — not merely a value >= it — or the two
    // co-signing halves commit to different bytes and `combineSettlementWithRoot` never combines.
    // The move-loop clock (20_000) is set past createdAt (10_000) to prove we sign createdAt, not
    // the last move's timestamp.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settlement_timestamp_equals_opened_tunnel_creation_time() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests))
            .with_created_at_ms(10_000);

        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_b,
            anchor,
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 20_000), driver_b.run(10, || 20_000));
        out_a.unwrap();
        out_b.unwrap();

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r.timestamp == 10_000));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transcript_root_anchor_requires_recording_recorder() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests))
            .with_settlement_mode(SettlementMode::TranscriptRoot);

        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_b,
            anchor,
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1));
        assert_eq!(
            out_a.unwrap_err(),
            HarnessError::Verification("anchor requires transcript recorder".into())
        );
        assert_eq!(
            out_b.unwrap_err(),
            HarnessError::Verification("anchor requires transcript recorder".into())
        );
        assert_eq!(settled.load(Ordering::Relaxed), 0);
        assert!(requests.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recorder_failure_aborts_before_settlement() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests));

        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_a,
            anchor.clone(),
            RejectingRecorder::<OneMove>::default(),
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_b,
            anchor,
            RejectingRecorder::<OneMove>::default(),
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1));
        let err_a = match out_a {
            Err(e) => e,
            Ok(_) => panic!("seat A should fail on transcript record"),
        };
        let err_b = match out_b {
            Err(e) => e,
            Ok(_) => panic!("seat B should fail on transcript record"),
        };
        assert_eq!(
            err_a,
            HarnessError::Verification("transcript has duplicate entries for nonce 1".into())
        );
        assert_eq!(
            err_b,
            HarnessError::Verification("transcript has duplicate entries for nonce 1".into())
        );
        assert_eq!(settled.load(Ordering::Relaxed), 0);
        assert!(requests.lock().unwrap().is_empty());
    }

    use crate::{DriverObserver, DriverStart, MoveCommitted};

    #[derive(Default)]
    struct CountingObserver {
        started: Vec<(String, Seat)>,
        moves: Vec<MoveCommitted>,
        finished: u64,
        aborted: u64,
    }

    impl DriverObserver for CountingObserver {
        fn on_started(&mut self, s: &DriverStart<'_>) {
            self.started.push((s.tunnel_id.to_string(), s.our_seat));
        }

        fn on_move_committed(&mut self, ev: &MoveCommitted) {
            self.moves.push(*ev);
        }

        fn on_finished(&mut self, _o: &DriverOutcome) {
            self.finished += 1;
        }

        fn on_aborted(&mut self) {
            self.aborted += 1;
        }
    }

    // A shared recorder so the test can read what the driver fanned out.
    #[derive(Clone, Default)]
    struct SharedObserver(Arc<std::sync::Mutex<CountingObserver>>);

    impl DriverObserver for SharedObserver {
        fn on_started(&mut self, s: &DriverStart<'_>) {
            self.0.lock().unwrap().on_started(s);
        }

        fn on_move_committed(&mut self, ev: &MoveCommitted) {
            self.0.lock().unwrap().on_move_committed(ev);
        }

        fn on_finished(&mut self, o: &DriverOutcome) {
            self.0.lock().unwrap().on_finished(o);
        }

        fn on_aborted(&mut self) {
            self.0.lock().unwrap().on_aborted();
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn driver_fans_lifecycle_events_to_observers() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let z = || Arc::new(AtomicU64::new(0));

        let obs_a = SharedObserver::default();
        let obs_a2 = SharedObserver::default();
        let anchor = InMemoryAnchor::with_fixed_id("0x1");
        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(Seat::A, z(), z(), z()),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .observe(Box::new(obs_a.clone()))
        .observe(Box::new(obs_a2.clone()));
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(Seat::B, z(), z(), z()),
            ch_b,
            anchor.clone(),
            NullTranscriptRecorder,
        );

        let mut ta = 0u64;
        let (ra, rb) = tokio::join!(
            driver_a.run(10, move || {
                ta += 100;
                ta
            }),
            driver_b.run(10, || 1),
        );
        ra.unwrap();
        rb.unwrap();

        let a = obs_a.0.lock().unwrap();
        assert_eq!(a.started, vec![("0x1".to_string(), Seat::A)]);
        assert_eq!(a.finished, 1);
        assert_eq!(a.aborted, 0);
        // OneMove protocol: exactly one committed move, authored by Seat::A.
        assert_eq!(a.moves.len(), 1);
        assert_eq!(a.moves[0].by, Seat::A);
        assert_eq!(a.moves[0].move_index, 1);
        assert_eq!(a.moves[0].nonce, 1);
        assert!(a.moves[0].timestamp_ms >= 100);
        // Fan-out: the second observer saw the same single move.
        assert_eq!(obs_a2.0.lock().unwrap().moves.len(), 1);
    }

    #[tokio::test]
    async fn driver_notifies_observers_on_abort() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let z = || Arc::new(AtomicU64::new(0));
        let obs = SharedObserver::default();
        let driver = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(Seat::A, z(), z(), z()),
            FailingSendTransport,
            InMemoryAnchor::with_fixed_id("0x1"),
            NullTranscriptRecorder,
        )
        .observe(Box::new(obs.clone()));

        let res = driver.run(10, || 1).await;
        assert!(res.is_err());
        let g = obs.0.lock().unwrap();
        assert_eq!(g.aborted, 1);
        assert_eq!(g.finished, 0);
    }
}
