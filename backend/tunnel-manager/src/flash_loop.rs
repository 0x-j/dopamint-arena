//! Bot-vs-bot flash self-play supervisor. Two seats share one anchor: in-memory
//! for local dev, or a real on-chain `SuiOpenIntentAnchor` when configured.
//! Moves are real co-signed state updates; each confirmed move is published to
//! the flash transcript store for the SSE feed. At the 1,000,000 move cap (or on
//! Stop) the tunnel is settled and a fresh one opens.

use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::flash_store::{FlashMessage, FlashTranscriptStore};
use tunnel_core::protocol_id::ProtocolId;
use tunnel_core::wire::{serialize_settlement, serialize_settlement_with_root, Settlement};
use tunnel_flash::{reply_for, Flash, FlashMove};
use tunnel_harness::{
    Balances, FrameTransport, HarnessError, InMemoryAnchor, InMemoryFrameTransport,
    InMemoryTranscriptRecorder, LocalSigner, PartyRuntime, Protocol, Seat, Signer,
    TranscriptRecorder, TunnelAnchor, TunnelContext, TunnelOpenRequest, TunnelSettleRequest,
};

const INITIAL_BALANCE: u64 = 100;

/// Handle held in AppState so Start is idempotent and Stop cancels the loop.
pub struct FlashLoop {
    cancel: Mutex<Option<CancellationToken>>,
    anchor: Option<Arc<sui_tunnel_anchor::SuiSponsoredAnchor>>,
}

impl FlashLoop {
    pub fn new(anchor: Option<Arc<sui_tunnel_anchor::SuiSponsoredAnchor>>) -> Self {
        Self {
            cancel: Mutex::new(None),
            anchor,
        }
    }
}

/// Start the loop if one isn't already running. Returns true if started.
pub async fn start(loop_handle: &FlashLoop, store: Arc<FlashTranscriptStore>) -> bool {
    let anchor = loop_handle.anchor.clone();
    let mut guard = loop_handle.cancel.lock().await;
    if guard.is_some() {
        return false;
    }
    let token = CancellationToken::new();
    let child = token.child_token();
    *guard = Some(token);
    tokio::spawn(run(store, anchor, child));
    true
}

/// Stop the running loop (settles the current tunnel). Returns true if stopped.
pub async fn stop(loop_handle: &FlashLoop) -> bool {
    let token = loop_handle.cancel.lock().await.take();
    if let Some(t) = token {
        t.cancel();
        true
    } else {
        false
    }
}

/// Whether a self-play loop is currently running — the source of truth for the FE's Start/Stop
/// button state, so a tab that opens onto an already-running loop shows the correct controls.
pub async fn is_running(loop_handle: &FlashLoop) -> bool {
    loop_handle.cancel.lock().await.is_some()
}

async fn run(
    store: Arc<FlashTranscriptStore>,
    anchor: Option<Arc<sui_tunnel_anchor::SuiSponsoredAnchor>>,
    cancel: CancellationToken,
) {
    loop {
        if cancel.is_cancelled() {
            break;
        }
        match play_one_cycle(&store, anchor.clone(), &cancel).await {
            Ok(()) => { /* reopened automatically by looping */ }
            Err(e) => {
                tracing::warn!(error = %e, "flash loop cycle ended");
                break;
            }
        }
    }
}

enum FlashAnchor {
    Memory(InMemoryAnchor),
    Sui(sui_tunnel_anchor::SuiOpenIntentAnchor),
}

impl TunnelAnchor for FlashAnchor {
    fn settlement_mode(&self) -> tunnel_harness::SettlementMode {
        match self {
            FlashAnchor::Memory(a) => a.settlement_mode(),
            FlashAnchor::Sui(a) => a.settlement_mode(),
        }
    }

    async fn open(
        &self,
        request: TunnelOpenRequest,
    ) -> Result<tunnel_harness::OpenedTunnel, tunnel_harness::TunnelAnchorError> {
        match self {
            FlashAnchor::Memory(a) => a.open(request).await,
            FlashAnchor::Sui(a) => a.open(request).await,
        }
    }

    async fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<tunnel_harness::SettledTunnel, tunnel_harness::TunnelAnchorError> {
        match self {
            FlashAnchor::Memory(a) => a.settle(request).await,
            FlashAnchor::Sui(a) => a.settle(request).await,
        }
    }
}

async fn play_one_cycle(
    store: &Arc<FlashTranscriptStore>,
    sui_anchor: Option<Arc<sui_tunnel_anchor::SuiSponsoredAnchor>>,
    cancel: &CancellationToken,
) -> anyhow::Result<()> {
    // Fresh per-cycle identities. The on-chain anchor keys a tunnel by its party identity, so a
    // FIXED identity every cycle resolves back to the first cycle's tunnel — already closed after its
    // settle — and the next settle aborts on-chain with `ETunnelClosed`. Random keys per cycle open a
    // genuinely new tunnel each time, so settle (at cap or on Stop) succeeds and the loop can reopen.
    let secret_a = random_secret();
    let secret_b = random_secret();

    let signer_a = LocalSigner::from_secret(&secret_a);
    let signer_b = LocalSigner::from_secret(&secret_b);
    let pk_a = signer_a.public_key();
    let pk_b = signer_b.public_key();

    let initial = Balances {
        a: INITIAL_BALANCE,
        b: INITIAL_BALANCE,
    };

    let protocol_id =
        ProtocolId::parse(Flash.name()).map_err(|s| anyhow::anyhow!("invalid protocol id: {s}"))?;
    let open_request = TunnelOpenRequest {
        protocol: protocol_id,
        party_a: pk_a,
        party_b: pk_b,
        initial,
    };

    let (anchor, on_chain): (FlashAnchor, bool) = match sui_anchor {
        Some(anchor) => {
            let intent_id = sui_tunnel_anchor::SuiOpenIntentId::from_label(format!(
                "flash-spectator-{}",
                uuid::Uuid::new_v4()
            ));
            (FlashAnchor::Sui(anchor.for_open_intent(intent_id)), true)
        }
        None => (FlashAnchor::Memory(InMemoryAnchor::new()), false),
    };

    let opened = anchor
        .open(open_request)
        .await
        .map_err(|e| anyhow::anyhow!("flash anchor open failed: {e:?}"))?;
    let tunnel_id = opened.tunnel_id;
    let final_nonce = opened
        .onchain_nonce
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("anchor nonce overflow"))?;

    let (ch_a, ch_b) = InMemoryFrameTransport::pair();

    let ctx_a = TunnelContext {
        tunnel_id: tunnel_id.clone(),
        initial,
        seat: Seat::A,
    };
    let ctx_b = TunnelContext {
        tunnel_id: tunnel_id.clone(),
        initial,
        seat: Seat::B,
    };

    let mut seat_a = PartyRuntime::<Flash, LocalSigner>::new(Flash, signer_a.clone(), pk_b, ctx_a);
    let mut seat_b = PartyRuntime::<Flash, LocalSigner>::new(Flash, signer_b.clone(), pk_a, ctx_b);

    let recorder = if on_chain {
        Some(InMemoryTranscriptRecorder::<FlashMove>::new())
    } else {
        None
    };

    let mut move_count = 0u64;
    let mut last_timestamp = 0u64;
    let mut turn = Seat::A;

    loop {
        if cancel.is_cancelled() {
            break;
        }
        // At the shared move cap, stop stepping so the code below settles this tunnel; `run` then
        // loops and `play_one_cycle` opens a fresh one — the automatic settle→reopen at 1M.
        if move_count >= tunnel_flash::FLASH_MAX_MOVES {
            break;
        }

        let (proposer, responder, proposer_ch, responder_ch): (
            &mut PartyRuntime<Flash, LocalSigner>,
            &mut PartyRuntime<Flash, LocalSigner>,
            &InMemoryFrameTransport,
            &InMemoryFrameTransport,
        ) = match turn {
            Seat::A => (&mut seat_a, &mut seat_b, &ch_a, &ch_b),
            Seat::B => (&mut seat_b, &mut seat_a, &ch_b, &ch_a),
        };

        let text = reply_for(&proposer.state().transcript_digest);
        let mv = FlashMove { text };
        let timestamp = now_ms();

        let frame = match proposer.propose(mv, timestamp) {
            Ok(f) => f,
            Err(HarnessError::Verification(ref msg)) if msg.contains("cap reached") => break,
            Err(e) => return Err(anyhow::anyhow!("flash propose failed: {e:?}")),
        };

        proposer_ch
            .send(frame)
            .await
            .map_err(|e| anyhow::anyhow!("flash transport send failed: {e:?}"))?;

        let incoming = responder_ch
            .recv()
            .await
            .map_err(|e| anyhow::anyhow!("flash transport recv failed: {e:?}"))?
            .ok_or_else(|| anyhow::anyhow!("flash transport closed"))?;
        let ack_frames = responder
            .handle_frame(&incoming)
            .map_err(|e| anyhow::anyhow!("flash responder handle failed: {e:?}"))?;
        let ack = ack_frames
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("expected ack frame"))?;

        responder_ch
            .send(ack)
            .await
            .map_err(|e| anyhow::anyhow!("flash transport send failed: {e:?}"))?;

        let ack_incoming = proposer_ch
            .recv()
            .await
            .map_err(|e| anyhow::anyhow!("flash transport recv failed: {e:?}"))?
            .ok_or_else(|| anyhow::anyhow!("flash transport closed"))?;
        proposer
            .handle_frame(&ack_incoming)
            .map_err(|e| anyhow::anyhow!("flash proposer handle failed: {e:?}"))?;

        if let Some((nonce, timestamp)) =
            record_committed_move(proposer, responder, recorder.as_ref(), store).await?
        {
            move_count = nonce;
            last_timestamp = timestamp;
        }

        turn = turn.other();
    }

    // Settle the current tunnel before reopening (or exiting).
    let balances = seat_a.balances();
    let timestamp = last_timestamp.max(opened.created_at_ms.unwrap_or(0)).max(1);
    let settlement = Settlement {
        tunnel_id: tunnel_id.clone(),
        party_a_balance: balances.a,
        party_b_balance: balances.b,
        final_nonce,
        timestamp,
    };

    let (settle_bytes, transcript_root) = if let Some(ref r) = recorder {
        let root = r
            .snapshot()
            .canonical_root_for_tunnel(&tunnel_id)
            .map_err(|e| anyhow::anyhow!("flash transcript root failed: {e}"))?;
        (
            serialize_settlement_with_root(&settlement, &root),
            Some(root),
        )
    } else {
        (serialize_settlement(&settlement), None)
    };

    let sig_a = signer_a.sign(&settle_bytes);
    let sig_b = signer_b.sign(&settle_bytes);

    let (ra, rb) = tokio::join!(
        anchor.settle(TunnelSettleRequest {
            by: Seat::A,
            tunnel_id: tunnel_id.clone(),
            party_a_balance: balances.a,
            party_b_balance: balances.b,
            final_nonce,
            timestamp,
            signature: sig_a,
            transcript_root,
            transcript_entries: Vec::new(),
        }),
        anchor.settle(TunnelSettleRequest {
            by: Seat::B,
            tunnel_id,
            party_a_balance: balances.a,
            party_b_balance: balances.b,
            final_nonce,
            timestamp,
            signature: sig_b,
            transcript_root,
            transcript_entries: Vec::new(),
        }),
    );
    ra.map_err(|e| anyhow::anyhow!("flash anchor settle failed: {e:?}"))?;
    rb.map_err(|e| anyhow::anyhow!("flash anchor settle failed: {e:?}"))?;

    Ok(())
}

/// Record and publish the committed move for the just-completed exchange, returning its
/// `(nonce, timestamp)`.
///
/// Both seats commit the IDENTICAL transition — same nonce, same `state_hash`, and both
/// signatures (each seat ends up holding the proposer sig and the responder ACK sig). So the
/// transition is recorded ONCE, from the proposer's view. Recording the responder's copy too
/// would repeat the nonce and trip `InMemoryTranscriptRecorder`'s duplicate-nonce guard, which
/// previously aborted the on-chain spectator loop after its first move. The responder's copy is
/// still drained so its buffer never carries a stale entry into the next exchange.
async fn record_committed_move(
    proposer: &mut PartyRuntime<Flash, LocalSigner>,
    responder: &mut PartyRuntime<Flash, LocalSigner>,
    recorder: Option<&InMemoryTranscriptRecorder<FlashMove>>,
    store: &FlashTranscriptStore,
) -> anyhow::Result<Option<(u64, u64)>> {
    let _ = responder.take_last_committed();
    let Some(entry) = proposer.take_last_committed() else {
        return Ok(None);
    };
    if let Some(r) = recorder {
        r.record(entry.clone())
            .map_err(|e| anyhow::anyhow!("flash transcript record failed: {e}"))?;
    }
    let nonce = entry.nonce;
    let timestamp = entry.timestamp;
    store
        .publish(FlashMessage {
            sender: match entry.by {
                Seat::A => "A".into(),
                Seat::B => "B".into(),
            },
            text: entry.mv.text,
            move_no: nonce,
        })
        .await;
    Ok(Some((nonce, timestamp)))
}

/// A random 32-byte secret from two v4 uuids (32 random bytes) — a fresh per-cycle self-play
/// identity, no extra crypto dependency. Mirrors the co-located bot's per-match key generation.
fn random_secret() -> [u8; 32] {
    let mut s = [0u8; 32];
    s[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    s[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    s
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn start_is_idempotent_and_stop_cancels() {
        let store = Arc::new(FlashTranscriptStore::new());
        let handle = FlashLoop::new(None);
        assert!(start(&handle, store.clone()).await);
        assert!(!start(&handle, store.clone()).await);
        assert!(stop(&handle).await);
        assert!(!stop(&handle).await);
    }

    // Regression: the self-play loop must record each committed move exactly ONCE. Both seats
    // commit the same nonce, so recording both (the old behavior) tripped the recorder's
    // duplicate-nonce guard and killed the on-chain spectator loop after move 1. Drives the real
    // propose→ACK→record cycle with a recorder present (the on-chain path) and asserts a clean,
    // monotonic transcript.
    #[tokio::test]
    async fn records_one_entry_per_nonce_across_moves() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let signer_a = LocalSigner::from_secret(&secret_a);
        let signer_b = LocalSigner::from_secret(&secret_b);
        let pk_a = signer_a.public_key();
        let pk_b = signer_b.public_key();
        let initial = Balances {
            a: INITIAL_BALANCE,
            b: INITIAL_BALANCE,
        };
        let ctx_a = TunnelContext {
            tunnel_id: "0x1".into(),
            initial,
            seat: Seat::A,
        };
        let ctx_b = TunnelContext {
            tunnel_id: "0x1".into(),
            initial,
            seat: Seat::B,
        };
        let mut seat_a = PartyRuntime::<Flash, LocalSigner>::new(Flash, signer_a, pk_b, ctx_a);
        let mut seat_b = PartyRuntime::<Flash, LocalSigner>::new(Flash, signer_b, pk_a, ctx_b);
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();

        let recorder = InMemoryTranscriptRecorder::<FlashMove>::new();
        let store = FlashTranscriptStore::new();

        let mut turn = Seat::A;
        for _ in 0..6 {
            let (proposer, responder, pch, rch): (
                &mut PartyRuntime<Flash, LocalSigner>,
                &mut PartyRuntime<Flash, LocalSigner>,
                &InMemoryFrameTransport,
                &InMemoryFrameTransport,
            ) = match turn {
                Seat::A => (&mut seat_a, &mut seat_b, &ch_a, &ch_b),
                Seat::B => (&mut seat_b, &mut seat_a, &ch_b, &ch_a),
            };
            let text = reply_for(&proposer.state().transcript_digest);
            let frame = proposer.propose(FlashMove { text }, 1).expect("propose");
            pch.send(frame).await.expect("send move");
            let incoming = rch.recv().await.expect("recv move").expect("move frame");
            let ack = responder
                .handle_frame(&incoming)
                .expect("handle move")
                .into_iter()
                .next()
                .expect("ack frame");
            rch.send(ack).await.expect("send ack");
            let ack_in = pch.recv().await.expect("recv ack").expect("ack frame");
            proposer.handle_frame(&ack_in).expect("handle ack");

            // Both seats now hold a committed entry for the same nonce — the exact condition
            // that made the old double-record fail.
            record_committed_move(proposer, responder, Some(&recorder), &store)
                .await
                .expect("recording a committed move must not fail with a duplicate nonce");
            turn = turn.other();
        }

        let nonces: Vec<u64> = recorder
            .snapshot()
            .entries()
            .iter()
            .map(|e| e.nonce)
            .collect();
        assert_eq!(
            nonces,
            vec![1, 2, 3, 4, 5, 6],
            "one entry per nonce, monotonic — no duplicate, no gap"
        );
    }
}
