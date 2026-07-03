//! `MatchChannel` — demultiplexes one match's relay channel into a game-frame stream (driving
//! the seat `PartyDriver`) and a control peer-message stream (hello / opened / settle / closed).
//!
//! Everything for a match rides the relay `payload` ([`crate::peer`]); a single reader must
//! route by `t`. A background task pumps the underlying [`RelayTransport`], classifying each
//! inbound payload: game frames are unwrapped and pushed to the frame queue (the
//! [`MatchFrameTransport`] the driver consumes); control messages go to the peer queue
//! ([`MatchChannel::recv_peer`]). Outbound frames and peer messages share the one transport.

use std::sync::Arc;

use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio::sync::Mutex;
use tunnel_harness::{FrameTransport, FrameTransportError};

use crate::peer::{classify, Incoming, PeerMsg};
use crate::relay_envelope;
use crate::relay_ws::RelayTransport;

pub struct MatchChannel<T: RelayTransport> {
    transport: Arc<T>,
    /// Behind an `Arc` so [`watch_stop`]'s background task can share it without owning the channel —
    /// that ownership split is what lets `Drop` abort the watcher instead of it detaching.
    peer_rx: Arc<Mutex<UnboundedReceiver<PeerMsg>>>,
    /// Taken once by [`MatchChannel::take_frame_transport`]; the driver owns it thereafter.
    frame_rx: Option<UnboundedReceiver<Vec<u8>>>,
    demux: tokio::task::JoinHandle<()>,
    /// Graceful-stop watcher spawned by [`watch_stop`]. Owned HERE (not by the play task) so it is
    /// aborted in `Drop` alongside `demux`: a cancelled play loop — e.g. an arena forfeit dropping
    /// the play future — must not detach it, or it keeps the shared transport `Arc` (and through it
    /// the registered relay connection) alive for the process's lifetime.
    stop_watcher: Option<tokio::task::JoinHandle<()>>,
}

impl<T: RelayTransport> Drop for MatchChannel<T> {
    fn drop(&mut self) {
        // Abort both background tasks when the match ends — either outliving the channel keeps the
        // shared transport `Arc` alive and leaks the relay connection (it never unregisters).
        self.demux.abort();
        if let Some(watcher) = self.stop_watcher.take() {
            watcher.abort();
        }
    }
}

impl<T: RelayTransport> MatchChannel<T> {
    /// Wrap a per-match transport and start demultiplexing its inbound payloads.
    pub fn new(transport: T) -> MatchChannel<T> {
        let transport = Arc::new(transport);
        let (frame_tx, frame_rx) = unbounded_channel();
        let (peer_tx, peer_rx) = unbounded_channel();
        let pump = transport.clone();
        // Demux loop: ends when the transport closes (recv_payload -> None) or an end drops.
        let demux = tokio::spawn(async move {
            while let Ok(Some(payload)) = pump.recv_payload().await {
                match classify(&payload) {
                    Ok(Incoming::Frame(p)) => {
                        // Hand the seat the inner frame bytes (envelope stripped).
                        if let Ok(inner) = relay_envelope::unwrap(&p) {
                            if frame_tx.send(inner).is_err() {
                                break;
                            }
                        }
                    }
                    Ok(Incoming::Peer(msg)) => {
                        if peer_tx.send(msg).is_err() {
                            break;
                        }
                    }
                    Err(_) => {} // ignore unclassifiable payloads rather than tear down the match
                }
            }
        });
        MatchChannel {
            transport,
            peer_rx: Arc::new(Mutex::new(peer_rx)),
            frame_rx: Some(frame_rx),
            demux,
            stop_watcher: None,
        }
    }

    /// Send a control peer message (hello / opened / settle / closed) to the opponent.
    pub async fn send_peer(&self, msg: &PeerMsg) -> Result<(), FrameTransportError> {
        self.transport
            .send_payload(msg.to_payload().into_bytes())
            .await
    }

    /// Next control peer message, or `None` when the match channel closes.
    pub async fn recv_peer(&self) -> Option<PeerMsg> {
        self.peer_rx.lock().await.recv().await
    }

    /// Spawn a background watcher that runs `on_stop` once when the peer sends `{t:"stop"}` (the FE's
    /// graceful "settle now"). Non-terminal protocols never wind down otherwise. The task is OWNED by
    /// this channel and aborted in `Drop` — unlike a caller-spawned task that would detach and pin the
    /// relay connection if the play loop is cancelled (arena forfeit). Call once, after the hello.
    pub fn watch_stop(&mut self, on_stop: impl FnOnce() + Send + 'static) {
        let peer_rx = self.peer_rx.clone();
        self.stop_watcher = Some(tokio::spawn(async move {
            let mut on_stop = Some(on_stop);
            while let Some(msg) = peer_rx.lock().await.recv().await {
                if msg == PeerMsg::Stop {
                    if let Some(f) = on_stop.take() {
                        f();
                    }
                    break;
                }
            }
        }));
    }

    /// Take the frame transport the `PartyDriver` runs on (callable once).
    pub fn take_frame_transport(&mut self) -> MatchFrameTransport<T> {
        let frame_rx = self
            .frame_rx
            .take()
            .expect("take_frame_transport called once");
        MatchFrameTransport {
            transport: self.transport.clone(),
            frames: Mutex::new(frame_rx),
        }
    }
}

/// The game-frame half of a demultiplexed match channel: a `FrameTransport` that reads
/// already-demuxed inner frames and wraps outbound frames in the relay envelope.
pub struct MatchFrameTransport<T: RelayTransport> {
    transport: Arc<T>,
    frames: Mutex<UnboundedReceiver<Vec<u8>>>,
}

impl<T: RelayTransport> FrameTransport for MatchFrameTransport<T> {
    async fn send(&self, inner: Vec<u8>) -> Result<(), FrameTransportError> {
        let payload = relay_envelope::wrap(&inner)
            .map_err(|e| FrameTransportError::Transport(format!("relay wrap: {e}")))?;
        self.transport.send_payload(payload.into_bytes()).await
    }

    async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
        Ok(self.frames.lock().await.recv().await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay_ws::MockTransport;

    // The demux routes a game frame to the frame transport and a control message to the peer
    // queue, off the same underlying channel.
    #[tokio::test]
    async fn demuxes_frames_from_control_messages() {
        let (ta, tb) = MockTransport::pair();
        let mut ch = MatchChannel::new(tb);
        let ft = ch.take_frame_transport();

        // Peer A sends one hello (control) and one game frame down the raw transport.
        ta.send_payload(
            PeerMsg::Hello {
                ephemeral_pubkey: "ab".into(),
            }
            .to_payload()
            .into_bytes(),
        )
        .await
        .unwrap();
        let inner = br#"{"kind":"move","nonce":"1","by":"A","move":{"action":"stand"}}"#;
        ta.send_payload(relay_envelope::wrap(inner).unwrap().into_bytes())
            .await
            .unwrap();

        // Control surfaces on the peer stream; the frame (envelope stripped) on the frame stream.
        assert_eq!(
            ch.recv_peer().await,
            Some(PeerMsg::Hello {
                ephemeral_pubkey: "ab".into()
            })
        );
        assert_eq!(ft.recv().await.unwrap().unwrap(), inner.to_vec());
    }
}
