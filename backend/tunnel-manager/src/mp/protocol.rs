//! The `GET /v1/mp` control sub-protocol (spec §4). `#[serde(tag = "type")]` external
//! tagging matches the wire table; dotted message names use explicit `rename`.
//! `rename_all_fields = "camelCase"` makes struct-variant FIELDS camelCase (the
//! enum-level `rename_all` only renames the variant tag), matching the SDK wire (ADR-0002).

use serde::{Deserialize, Serialize};

/// Messages the client sends to the server.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientMsg {
    /// Authenticate: prove control of `pubkey` (which the client claims is `wallet`)
    /// by signing the server-issued `nonce`. See `auth.rs` for verification.
    Connect {
        wallet: String,
        pubkey: String,
        sig: String,
        nonce: String,
    },
    #[serde(rename = "queue.join")]
    QueueJoin {
        game: String,
        /// Set by fleet bots so the matchmaker never pairs two bots. Absent for human
        /// clients (defaults false).
        #[serde(default)]
        is_bot: bool,
    },
    #[serde(rename = "queue.leave")]
    QueueLeave,
    #[serde(rename = "challenge.create")]
    ChallengeCreate { target_wallet: String, game: String },
    #[serde(rename = "challenge.accept")]
    ChallengeAccept { match_id: String },
    #[serde(rename = "challenge.decline")]
    ChallengeDecline { match_id: String },
    #[serde(rename = "party.hello")]
    PartyHello {
        match_id: String,
        ephemeral_pubkey: String,
        wallet_sig: String,
    },
    #[serde(rename = "tunnel.opened")]
    TunnelOpened { match_id: String, tunnel_id: String },
    /// OPAQUE move/ack frame to forward to the other seat. `payload` is never parsed.
    Relay { match_id: String, payload: String },
    #[serde(rename = "watchtower.checkpoint")]
    WatchtowerCheckpoint {
        match_id: String,
        nonce: String,
        party_a_balance: String,
        party_b_balance: String,
        state_hash: String,
        sig_a: String,
        sig_b: String,
    },
    /// Re-attach to an existing match after a reconnect. Valid only after `Connect`.
    /// Authorization is the seat-ownership check server-side.
    #[serde(rename = "resume")]
    Resume { match_id: String },
    /// Join a pre-allocated arena match by its id (ADR-0027/0028). Unlike `queue.join` (matchmaking),
    /// this binds the user's connection to the SPECIFIC co-located bot + tunnel reserved at allocate;
    /// the server completes the `MatchRecord` and replies `MatchFound` (always party A). Valid only
    /// after `Connect`; authorized by wallet == the match's allocator.
    #[serde(rename = "arena.join")]
    ArenaJoin {
        match_id: String,
        /// Flash Play (chat) mode opts the co-located bot into LLM replies. Absent/false (Spectator,
        /// every non-chat game, older clients) keeps the offline Markov reply. Wire field: `chatLlm`.
        #[serde(default)]
        chat_llm: bool,
    },
}

/// Messages the server sends to the client. `Deserialize` is for the co-located fleet (ADR-0027):
/// an in-process bot reads its own bus-delivered frames back into typed form (the bus carries only
/// strings). The browser still only ever deserializes these — same wire either way.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerMsg {
    /// One-time nonce the client must sign in `connect`.
    Challenge {
        nonce: String,
    },
    #[serde(rename = "match.found")]
    MatchFound {
        match_id: String,
        role: String,
        opponent_wallet: String,
        game: String,
    },
    // emitted in a later phase; part of the FE wire contract
    #[allow(dead_code)]
    #[serde(rename = "queue.timeout")]
    QueueTimeout {
        match_id: String,
    },
    #[serde(rename = "challenge.incoming")]
    ChallengeIncoming {
        match_id: String,
        from_wallet: String,
        game: String,
    },
    // emitted in a later phase; part of the FE wire contract
    #[allow(dead_code)]
    #[serde(rename = "match.active")]
    MatchActive {
        match_id: String,
    },
    Relay {
        match_id: String,
        payload: String,
    },
    /// Re-attach confirmed. `peer_online` reflects whether the opponent currently has a live
    /// socket (from presence), so the client knows whether to expect a peer state re-send.
    #[serde(rename = "resume.ok")]
    ResumeOk {
        match_id: String,
        role: String,
        opponent_wallet: String,
        game: String,
        peer_online: bool,
    },
    /// Sent to the opponent when a seat reconnects: carries the new `ConnRef` so the FE can
    /// re-send its latest co-signed state. (Backend relay-cache invalidation is separate — the
    /// bus eviction path, Task 4.)
    #[serde(rename = "peer.resumed")]
    PeerResumed {
        match_id: String,
        seat: String,
        conn_ref: crate::store::ConnRef,
    },
    /// Sent to the still-present seat when the opponent's socket drops, so the FE can start its
    /// 60s grace timer.
    #[serde(rename = "peer.dropped")]
    PeerDropped {
        match_id: String,
    },
    Error {
        code: String,
        message: String,
    },
}

impl ServerMsg {
    pub fn error(code: &str, message: &str) -> Self {
        ServerMsg::Error {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }
    /// JSON text for a `Message::Text` frame (infallible for these owned types).
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("ServerMsg serializes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The control wire MUST round-trip the exact dotted, camelCase shapes the FE sends.
    // A rename here is an integration break with the browser client.
    #[test]
    fn client_queue_join_deserializes_dotted_name() {
        let m: ClientMsg = serde_json::from_str(r#"{"type":"queue.join","game":"ttt"}"#).unwrap();
        assert_eq!(
            m,
            ClientMsg::QueueJoin {
                game: "ttt".into(),
                is_bot: false,
            }
        );
    }

    // The relay payload is an opaque string the server never parses — an arbitrary
    // non-frame value round-trips verbatim through deserialization.
    #[test]
    fn client_relay_carries_opaque_payload_verbatim() {
        let raw = r#"{"type":"relay","matchId":"m1","payload":"opaque::not-a-frame::42"}"#;
        let m: ClientMsg = serde_json::from_str(raw).unwrap();
        match m {
            ClientMsg::Relay { match_id, payload } => {
                assert_eq!(match_id, "m1");
                assert_eq!(payload, "opaque::not-a-frame::42");
            }
            _ => panic!("expected relay"),
        }
    }

    // camelCase field rename must apply to struct-variant FIELDS, not just the tag.
    #[test]
    fn server_match_found_serializes_with_dotted_type() {
        let s = ServerMsg::MatchFound {
            match_id: "m1".into(),
            role: "A".into(),
            opponent_wallet: "0xb".into(),
            game: "ttt".into(),
        };
        let json = s.to_text();
        assert!(json.contains(r#""type":"match.found""#), "got {json}");
        assert!(json.contains(r#""opponentWallet":"0xb""#), "got {json}");
    }

    #[test]
    fn client_resume_deserializes_dotted_name() {
        let m: ClientMsg = serde_json::from_str(r#"{"type":"resume","matchId":"m1"}"#).unwrap();
        assert_eq!(
            m,
            ClientMsg::Resume {
                match_id: "m1".into()
            }
        );
    }

    // The arena join wire shape is the contract the FE arena tile (T14) must send to bind to its
    // pre-allocated match. A rename of the tag or `matchId` field silently breaks that join.
    #[test]
    fn client_arena_join_deserializes_dotted_name() {
        // Older clients omit `chatLlm`; it must default to false (Markov reply), not fail to parse.
        let m: ClientMsg =
            serde_json::from_str(r#"{"type":"arena.join","matchId":"arena_7"}"#).unwrap();
        assert_eq!(
            m,
            ClientMsg::ArenaJoin {
                match_id: "arena_7".into(),
                chat_llm: false,
            }
        );
    }

    // Flash Play sends `chatLlm:true` to route the co-located bot to LLM replies.
    #[test]
    fn client_arena_join_reads_chat_llm_flag() {
        let m: ClientMsg =
            serde_json::from_str(r#"{"type":"arena.join","matchId":"arena_7","chatLlm":true}"#)
                .unwrap();
        assert_eq!(
            m,
            ClientMsg::ArenaJoin {
                match_id: "arena_7".into(),
                chat_llm: true,
            }
        );
    }

    #[test]
    fn server_resume_ok_serializes_with_dotted_camelcase() {
        let s = ServerMsg::ResumeOk {
            match_id: "m1".into(),
            role: "A".into(),
            opponent_wallet: "0xb".into(),
            game: "ttt".into(),
            peer_online: true,
        }
        .to_text();
        assert!(s.contains(r#""type":"resume.ok""#));
        assert!(s.contains(r#""matchId":"m1""#));
        assert!(s.contains(r#""opponentWallet":"0xb""#));
        assert!(s.contains(r#""peerOnline":true"#));
    }

    #[test]
    fn server_peer_dropped_and_resumed_serialize() {
        assert!(ServerMsg::PeerDropped {
            match_id: "m1".into()
        }
        .to_text()
        .contains(r#""type":"peer.dropped""#));
        let pr = ServerMsg::PeerResumed {
            match_id: "m1".into(),
            seat: "B".into(),
            conn_ref: crate::store::ConnRef {
                instance_id: "i2".into(),
                conn_id: uuid::Uuid::nil(),
            },
        }
        .to_text();
        assert!(pr.contains(r#""type":"peer.resumed""#));
        assert!(pr.contains(r#""seat":"B""#));
        assert!(pr.contains(r#""connRef""#));
    }
}
