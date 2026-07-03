//! The relay-bridged [`TunnelAnchor`]: a co-located bot's chain-IO bracket for a genuine
//! two-party arena match — "our layer on top of the boss's harness" (ADR-0024/0025).
//!
//! The boss's `PartyDriver` brackets every match `open → move loop → settle`, delegating the chain
//! IO to a [`TunnelAnchor`]. His shipped impls don't fit OUR genuine two-party flow:
//!   * `InMemoryAnchor` pairs both settle halves *in-process* — right for bot-vs-bot self-play, wrong
//!     for a remote (browser) half.
//!   * `SuiSponsoredAnchor` *creates* the tunnel and funds *both* seats from one key — self-play.
//!
//! In the arena flow the tunnel is created out of band at allocate (the fleet creates + funds seat B,
//! ADR-0025) and the user funds seat A with a deposit-only PTB. So this anchor:
//!   * `open()` RESOLVES the already-created tunnel — returns its id, no chain call — and emits the
//!     bot's party-B handshake (`stake` + `opened`) so the human FE, which blocks on them, proceeds.
//!   * `settle()` EMITS the bot's co-signed half as a [`PeerMsg::Settle`] over the relay; the human
//!     FE pairs it with its own half and submits the cooperative close via `POST /settle`. The bot
//!     is a protocol-faithful peer, exactly like the other human in a human-vs-human PvP match — it
//!     never submits the close itself.
//!
//! `settlement_mode()` is [`SettlementMode::TranscriptRoot`] to match the FE and `/settle`, which
//! sign/submit `close_cooperative_with_root` (v2). The driver therefore requires a real transcript
//! recorder (e.g. `InMemoryTranscriptRecorder`), not `NullTranscriptRecorder`.

use std::sync::Arc;

use tunnel_harness::{
    Balances, OpenedTunnel, SettledTunnel, SettlementMode, Signer, TunnelAnchor, TunnelAnchorError,
    TunnelOpenRequest, TunnelSettleRequest,
};

use fleet_core::peer::PeerMsg;
use fleet_core::signer_durable::DurableSigner;
use tunnel_core::wire::{serialize_settlement_with_root, Settlement};

use crate::fleet::bus_transport::BusRelayConnection;

/// Brackets one arena match's chain IO for the bot seat, bridging the boss's `TunnelAnchor` to the
/// relay. Holds the pre-created tunnel id and the bot's relay presence (to route the settle half).
pub struct RelayBridgedAnchor {
    /// The tunnel the fleet pre-created + funded seat B for at allocate (ADR-0025). `open()` returns
    /// this verbatim; the bot never creates a tunnel during play.
    tunnel_id: String,
    /// The bot's virtual relay connection — routes the settle half to the human seat over the same
    /// bus path game frames take. Shared with the match's `BusRelayTransport` (frames) via `Arc`.
    conn: Arc<BusRelayConnection>,
    /// The relay match id this anchor settles, used for `relay_to_other` routing.
    match_id: String,
    /// The tunnel's on-chain `created_at` (ms). The FE signs its settlement half with
    /// `timestamp = created_at` (it reads the same field on-chain), so `open()` surfaces this to the
    /// driver as `OpenedTunnel::created_at_ms` and the bot signs the SAME value — without it the two
    /// halves commit to different `timestamp` bytes and never combine. Read once at allocate by the
    /// [`crate::fleet::arena_opener::ArenaTunnelOpener`].
    created_at_ms: u64,
}

impl RelayBridgedAnchor {
    pub fn new(
        tunnel_id: String,
        conn: Arc<BusRelayConnection>,
        match_id: String,
        created_at_ms: u64,
    ) -> RelayBridgedAnchor {
        RelayBridgedAnchor {
            tunnel_id,
            conn,
            match_id,
            created_at_ms,
        }
    }

    /// Serialize the `settleHalf` wire and route it to the human seat. The single emit path shared by
    /// the driver-run `settle` (co-signing the human's split) and `emit_forfeit_half` (leading a
    /// forced split), so both put byte-identical frames on the bus — camelCase keys, hex
    /// `sig`/`transcriptRoot`, decimal-string numerics (the FE's `PeerMessage` `settleHalf`).
    async fn send_settle_half(
        &self,
        party_a_balance: u64,
        party_b_balance: u64,
        final_nonce: u64,
        timestamp: u64,
        transcript_root: [u8; 32],
        sig: [u8; 64],
    ) {
        let half = FeSettleHalf {
            t: "settleHalf",
            party_a_balance: party_a_balance.to_string(),
            party_b_balance: party_b_balance.to_string(),
            final_nonce: final_nonce.to_string(),
            timestamp: timestamp.to_string(),
            transcript_root: hex::encode(transcript_root),
            sig: hex::encode(sig),
        };
        self.conn
            .send_to_peer(
                &self.match_id,
                serde_json::to_string(&half).expect("FeSettleHalf serializes"),
            )
            .await;
    }

    /// The bot LEADS a cooperative close by forfeit: it signs and emits a forced
    /// `(party_a = 0, party_b = total)` half over its OWN transcript `root` — it does NOT co-sign a
    /// human-supplied settlement. `total` is the tunnel's full pot (`2 * stake_each`); `root` is the
    /// bot recorder's live canonical root; `match_key` is the bot's per-match ephemeral signer.
    ///
    /// Nonce is 1 (a freshly opened tunnel's first co-signed state — same as the natural close) and
    /// `timestamp = created_at_ms` so the bytes match the FE half. `(0, total)` is monotonically safe
    /// for the bot: the Move contract accepts any co-signed split summing to `total`, and awarding the
    /// full pot to the honest bot never over-pays it. The human FE pairs this with its own signature
    /// and submits `close_cooperative_with_root`; the bot never submits.
    pub async fn emit_forfeit_half(&self, total: u64, root: [u8; 32], match_key: &DurableSigner) {
        let settlement = Settlement {
            tunnel_id: self.tunnel_id.clone(),
            party_a_balance: 0,
            party_b_balance: total,
            final_nonce: 1,
            timestamp: self.created_at_ms,
        };
        // Guard the money invariant: the forced split is the WHOLE pot to the bot, nothing else. A
        // future edit that broke conservation or the `b == total` shape would fail loudly here.
        assert!(
            settlement.party_a_balance == 0 && settlement.party_b_balance == total,
            "forfeit half must force (0, total): the full pot to the bot",
        );
        let sig = match_key.sign(&serialize_settlement_with_root(&settlement, &root));
        self.send_settle_half(0, total, 1, self.created_at_ms, root, sig)
            .await;
    }
}

/// The FE-facing settlement-half wire — the TS `PeerMessage` `settleHalf` variant. Kept distinct from
/// the inbound-routable [`PeerMsg`] enum on purpose: the bot only EMITS this shape (the human's
/// inbound `settleHalf` is never consumed and stays dropped by `classify`), so making it a `PeerMsg`
/// variant would needlessly flip the demux from dropping that frame to routing it. Field casing +
/// encoding mirror exactly what the FE sends: camelCase keys, hex `sig`/`transcriptRoot` (TS
/// `bytesToHex`), decimal-string numerics (TS `.toString()`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FeSettleHalf {
    t: &'static str,
    party_a_balance: String,
    party_b_balance: String,
    final_nonce: String,
    timestamp: String,
    transcript_root: String,
    sig: String,
}

impl TunnelAnchor for RelayBridgedAnchor {
    fn settlement_mode(&self) -> SettlementMode {
        // The FE signs settlement_v2 (transcript root) and `/settle` submits
        // `close_cooperative_with_root`, so the bot's half must commit to the same root.
        SettlementMode::TranscriptRoot
    }

    async fn open(&self, request: TunnelOpenRequest) -> Result<OpenedTunnel, TunnelAnchorError> {
        // Be a faithful party-B peer to the human FE's handshake (hello → stake → opened): the FE
        // (party A) blocks awaiting our seat stake and tunnel announcement before the move loop. This
        // runs right after `play_match`'s hello exchange. Fire-and-forget: the FE buffers an early
        // `stake`. NOTE: the FE does NOT buffer `opened` today — in human PvP the dealer's on-chain
        // create delays it past the FE's await; the bot has no such gap, so T14 must add `opened`
        // buffering to the arena FE. We send our seat-B stake = the initial balance for party B.
        self.conn
            .send_to_peer(
                &self.match_id,
                PeerMsg::Stake {
                    amount: request.initial.b,
                }
                .to_payload(),
            )
            .await;
        self.conn
            .send_to_peer(
                &self.match_id,
                PeerMsg::Opened {
                    tunnel_id: self.tunnel_id.clone(),
                }
                .to_payload(),
            )
            .await;
        // Resolve the pre-created tunnel; never create on-chain here. `onchain_nonce: 0` assumes a
        // freshly created+funded tunnel with no prior co-signed state (deposits fund seats but do not
        // advance the off-chain state nonce), so the cooperative close signs nonce 1 — matching the
        // FE. RE-VERIFY against the real tunnel when the funded-account opener lands: if the open PTB
        // leaves nonce ≠ 0, this must read the real on-chain nonce or the close is rejected.
        Ok(OpenedTunnel {
            tunnel_id: self.tunnel_id.clone(),
            onchain_nonce: 0,
            // Surface the on-chain createdAt so the driver signs `timestamp = created_at`, matching
            // the FE half (see the `created_at_ms` field doc). `None`/`0` would sign a different ts.
            created_at_ms: Some(self.created_at_ms),
            created: false,
        })
    }

    async fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        // v2 settlement: the bot's half must carry the transcript root the FE also signs.
        let root = request.transcript_root.ok_or_else(|| {
            TunnelAnchorError::Rejected("arena settle requires a transcript root (v2)".into())
        })?;
        // Emit our co-signing half in the FE's `settleHalf` wire shape (TS `PeerMessage`): the browser
        // pairs it with its own half (`combineSettlementWithRoot`) and submits the cooperative close.
        // The FE reads only `sig`+`transcriptRoot`, but we send the full half the FE itself sends so the
        // wire stays symmetric. `sig`/root are lowercase no-`0x` hex (TS `bytesToHex`); balances/nonce/
        // timestamp are decimal strings (TS `.toString()`). This is NOT `PeerMsg::Settle` (tag
        // `settle`): every FE hook waits on tag `settleHalf`, so the old tag deadlocked the handshake.
        self.send_settle_half(
            request.party_a_balance,
            request.party_b_balance,
            request.final_nonce,
            request.timestamp,
            root,
            request.signature,
        )
        .await;
        // The human FE pairs this half with its own and submits the cooperative close; the bot does
        // not submit. Return the agreed balances; the on-chain digest is unknown on this side.
        Ok(SettledTunnel {
            digest: String::new(),
            final_balances: Balances {
                a: request.party_a_balance,
                b: request.party_b_balance,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mp::protocol::ServerMsg;
    use crate::mp::MatchRecord;
    // NOTE: the settle golden parses the emitted JSON directly (asserting the FE `settleHalf` wire),
    // so `classify`/`PeerMsg::Settle` are deliberately NOT used here — see the test's comment.
    use crate::state::AppState;
    use tunnel_harness::Seat;

    // The anchor's `open` resolves the pre-created tunnel (no chain call): it returns the id it was
    // built with, reports it did NOT create the tunnel, and leaves nonce 0 so the close signs 1.
    #[tokio::test]
    async fn open_resolves_the_precreated_tunnel() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        let anchor =
            RelayBridgedAnchor::new("0xtunnel".into(), conn, "m1".into(), 1_700_000_000_000);

        let opened = anchor
            .open(TunnelOpenRequest {
                protocol: tunnel_core::protocol_id::ProtocolId::parse("blackjack.v1").unwrap(),
                party_a: [1u8; 32],
                party_b: [2u8; 32],
                initial: Balances { a: 100, b: 100 },
            })
            .await
            .expect("open resolves");
        assert_eq!(opened.tunnel_id, "0xtunnel");
        assert!(
            !opened.created,
            "the fleet created the tunnel, not the anchor"
        );
        assert_eq!(opened.onchain_nonce, 0);
        // The driver signs `timestamp = created_at`; surfacing it here is what makes the bot's half
        // combine with the FE's (which signs the same on-chain createdAt).
        assert_eq!(opened.created_at_ms, Some(1_700_000_000_000));
    }

    // `settle` emits the bot's co-signed half to the human peer in the FE `settleHalf` wire — the
    // exact keys/values the browser's `waitPeer("settleHalf")` + `combineSettlementWithRoot` read.
    // This is the cross-language seam the genuine two-party close hinges on, so it asserts against the
    // TS `PeerMessage` shape (tag `settleHalf`, field `transcriptRoot`, decimal-string numerics), NOT
    // a Rust `PeerMsg` round-trip — the latter would pass even if the FE-facing wire drifted (the
    // self-assertion trap that let `settle`/`settleHalf` diverge unnoticed).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settle_emits_the_co_signed_half_to_the_peer() {
        let state = AppState::in_memory_for_test();
        let bot_conn = BusRelayConnection::register(state.clone());
        let user_conn = BusRelayConnection::register(state.clone());

        // Wire the match so `relay_to_other` routes the bot's half to the user seat.
        let match_id = "m-settle";
        state
            .mp
            .put_match(
                match_id,
                MatchRecord {
                    game: "blackjack".into(),
                    seat_a: "0xuserA".into(),
                    seat_b: "0xbotB".into(),
                    conn_a: user_conn.conn_ref(),
                    conn_b: bot_conn.conn_ref(),
                    tunnel_id: Some("0xtunnel".into()),
                    latest_checkpoint: None,
                },
            )
            .await;

        let anchor = RelayBridgedAnchor::new(
            "0xtunnel".into(),
            bot_conn,
            match_id.into(),
            1_700_000_000_000,
        );
        let sig = [7u8; 64];
        let root = [9u8; 32];
        anchor
            .settle(TunnelSettleRequest {
                by: Seat::B,
                tunnel_id: "0xtunnel".into(),
                party_a_balance: 120,
                party_b_balance: 80,
                final_nonce: 1,
                timestamp: 42,
                signature: sig,
                transcript_root: Some(root),
                transcript_entries: Vec::new(),
            })
            .await
            .expect("settle emits");

        // The user seat receives a relay frame carrying the bot's settle half, byte-for-byte.
        let inbound = user_conn
            .recv_for_test()
            .await
            .expect("user receives the bot's settle");
        let ServerMsg::Relay { payload, .. } =
            serde_json::from_str::<ServerMsg>(&inbound).expect("relay frame")
        else {
            panic!("expected a Relay frame");
        };
        let half: serde_json::Value = serde_json::from_str(&payload).expect("settle half is JSON");
        assert_eq!(
            half["t"], "settleHalf",
            "FE waits on tag `settleHalf`, not `settle`"
        );
        assert_eq!(
            half["sig"],
            hex::encode(sig),
            "sig is the bot's half, lowercase no-0x hex (TS bytesToHex)"
        );
        assert_eq!(
            half["transcriptRoot"],
            hex::encode(root),
            "FE reads `transcriptRoot`, not `root`"
        );
        assert_eq!(
            half["partyABalance"], "120",
            "balances are decimal strings (TS toString)"
        );
        assert_eq!(half["partyBBalance"], "80");
        assert_eq!(half["finalNonce"], "1");
        assert_eq!(half["timestamp"], "42");
    }

    // Forfeit: the bot LEADS with a forced `(party_a=0, party_b=total)` half over its OWN root — it
    // does not co-sign a human settlement. The emitted half must force A→0, award the whole pot to
    // the bot, sign nonce 1 + `timestamp = created_at`, and carry a `sig` that verifies over the v2
    // settlement bytes (`serialize_settlement_with_root`) under the bot pubkey. This is the
    // money-critical seam: a wrong split, nonce, timestamp, or an unverifiable sig would let the FE
    // submit a close the Move contract rejects (or, worse, one that pays the wrong seat).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn forfeit_half_forces_zero_total_and_verifies() {
        use fleet_core::signer_durable::DurableSigner;
        use tunnel_core::crypto::verify;
        use tunnel_core::wire::{serialize_settlement_with_root, Settlement};
        use tunnel_harness::Signer;

        // A valid 32-byte hex address: `serialize_settlement_with_root` parses the tunnel id.
        const TUNNEL: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

        let state = AppState::in_memory_for_test();
        let bot_conn = BusRelayConnection::register(state.clone());
        let user_conn = BusRelayConnection::register(state.clone());
        let match_id = "m-forfeit";
        state
            .mp
            .put_match(
                match_id,
                MatchRecord {
                    game: "blackjack".into(),
                    seat_a: "0xuserA".into(),
                    seat_b: "0xbotB".into(),
                    conn_a: user_conn.conn_ref(),
                    conn_b: bot_conn.conn_ref(),
                    tunnel_id: Some(TUNNEL.into()),
                    latest_checkpoint: None,
                },
            )
            .await;

        let created_at = 1_700_000_000_000u64;
        let anchor = RelayBridgedAnchor::new(TUNNEL.into(), bot_conn, match_id.into(), created_at);
        let match_key = DurableSigner::from_secret(&[5u8; 32]);
        let root = [9u8; 32];
        let total = 2000u64; // 2 * stake_each (blackjack stake_each = 1000)

        anchor.emit_forfeit_half(total, root, &match_key).await;

        let inbound = user_conn
            .recv_for_test()
            .await
            .expect("user receives the bot's forfeit half");
        let ServerMsg::Relay { payload, .. } =
            serde_json::from_str::<ServerMsg>(&inbound).expect("relay frame")
        else {
            panic!("expected a Relay frame");
        };
        let half: serde_json::Value = serde_json::from_str(&payload).expect("settle half is JSON");
        assert_eq!(half["t"], "settleHalf", "FE waits on tag `settleHalf`");
        assert_eq!(half["partyABalance"], "0", "forfeit forces party A to 0");
        assert_eq!(
            half["partyBBalance"],
            total.to_string(),
            "forfeit awards the whole pot to the bot"
        );
        assert_eq!(half["finalNonce"], "1", "the forced close signs nonce 1");
        assert_eq!(
            half["timestamp"],
            created_at.to_string(),
            "the bot signs `timestamp = created_at` (matches the FE half)"
        );
        assert_eq!(half["transcriptRoot"], hex::encode(root));

        // Conservation + the `b == total` safety invariant on the emitted wire.
        let a: u64 = half["partyABalance"].as_str().unwrap().parse().unwrap();
        let b: u64 = half["partyBBalance"].as_str().unwrap().parse().unwrap();
        assert_eq!(a + b, total, "stakes are conserved (0 + total == total)");
        assert_eq!(
            b, total,
            "party_b == total: the whole pot, never a partial split"
        );

        // The bot's sig verifies over the v2 settlement bytes under its own pubkey.
        let settlement = Settlement {
            tunnel_id: TUNNEL.into(),
            party_a_balance: 0,
            party_b_balance: total,
            final_nonce: 1,
            timestamp: created_at,
        };
        let sig_bytes: [u8; 64] = hex::decode(half["sig"].as_str().unwrap())
            .expect("sig is hex")
            .try_into()
            .expect("64-byte sig");
        assert!(
            verify(
                &match_key.public_key(),
                &serialize_settlement_with_root(&settlement, &root),
                &sig_bytes,
            ),
            "the bot's forfeit sig verifies over serialize_settlement_with_root",
        );
    }

    // Cross-language golden: pins `serialize_settlement_with_root` over the forfeit `(0, total)`
    // split byte-for-byte against the FE (frontend/src/pvp/forfeit.test.ts, same tunnel id/values).
    // The bytes-given-a-root are unchanged from a normal close — this specifically locks the forced
    // split so a wire-layout edit on either side gets caught here instead of at on-chain settlement.
    #[test]
    fn forfeit_settlement_bytes_match_the_fe_golden() {
        let settlement = Settlement {
            tunnel_id: format!("0x{}07", "00".repeat(31)),
            party_a_balance: 0,
            party_b_balance: 2000,
            final_nonce: 1,
            timestamp: 42,
        };
        let root = [9u8; 32];
        let bytes = serialize_settlement_with_root(&settlement, &root);
        assert_eq!(bytes.len(), 121);
        assert_eq!(
            hex::encode(&bytes),
            "7375695f74756e6e656c3a3a736574746c656d656e745f76320000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000007d00000000000000001000000000000002a0909090909090909090909090909090909090909090909090909090909090909",
        );
    }

    // v1 (rootless) settlement is rejected: the arena close is always v2, so a missing root is a
    // bug to fail loudly on, not silently emit an empty root the FE can't pair.
    #[tokio::test]
    async fn settle_without_root_is_rejected() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        let anchor =
            RelayBridgedAnchor::new("0xtunnel".into(), conn, "m1".into(), 1_700_000_000_000);
        let err = anchor
            .settle(TunnelSettleRequest {
                by: Seat::B,
                tunnel_id: "0xtunnel".into(),
                party_a_balance: 100,
                party_b_balance: 100,
                final_nonce: 1,
                timestamp: 1,
                signature: [0u8; 64],
                transcript_root: None,
                transcript_entries: Vec::new(),
            })
            .await
            .expect_err("rootless settle must be rejected");
        assert!(matches!(err, TunnelAnchorError::Rejected(_)));
    }
}
