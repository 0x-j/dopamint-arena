use tunnel_flash::{Flash, FlashMove};
use tunnel_harness::{Balances, Protocol, Seat, TunnelContext};

fn ctx() -> TunnelContext {
    TunnelContext {
        tunnel_id: "0xab".into(),
        initial: Balances { a: 100, b: 100 },
        seat: Seat::A,
    }
}

#[test]
fn initial_state_conserves_balance() {
    let s = Flash.initial_state(&ctx());
    assert_eq!(s.balance_a + s.balance_b, 200);
    assert_eq!(s.message_count, 0);
}

#[test]
fn apply_move_bumps_count_and_changes_encoding() {
    let s0 = Flash.initial_state(&ctx());
    let s1 = Flash
        .apply_move(
            &s0,
            &FlashMove {
                text: "hello".into(),
            },
            Seat::A,
        )
        .unwrap();
    assert_eq!(s1.message_count, 1);
    assert_ne!(Flash.encode_state(&s0), Flash.encode_state(&s1));
}

#[test]
fn balances_are_conserved_across_play() {
    let mut s = Flash.initial_state(&ctx());
    for i in 0..100 {
        let seat = if i % 2 == 0 { Seat::A } else { Seat::B };
        s = Flash
            .apply_move(
                &s,
                &FlashMove {
                    text: format!("m{i}"),
                },
                seat,
            )
            .unwrap();
        let b = Flash.balances(&s);
        assert_eq!(b.a + b.b, 200);
    }
    assert!(!Flash.is_terminal(&s));
}

// The cap is 1,000,000 and MUST equal the TS `FLASH_MAX_MOVES` (cross-language parity): both sides
// gate `apply_move` on it, and Mode 2 settles + reopens when a cycle reaches it.
#[test]
fn move_cap_is_one_million() {
    assert_eq!(tunnel_flash::FLASH_MAX_MOVES, 1_000_000);
}

#[test]
fn apply_move_allows_last_move_up_to_cap_then_refuses() {
    let mut s = Flash.initial_state(&ctx());
    // count 999,999 -> 1,000,000 is the last allowed message.
    s.message_count = tunnel_flash::FLASH_MAX_MOVES - 1;
    let at_cap = Flash
        .apply_move(
            &s,
            &FlashMove {
                text: "last".into(),
            },
            Seat::A,
        )
        .expect("the millionth move is allowed");
    assert_eq!(at_cap.message_count, tunnel_flash::FLASH_MAX_MOVES);
    // At the cap the next move is refused so the driver settles instead of stepping.
    assert!(Flash
        .apply_move(
            &at_cap,
            &FlashMove {
                text: "over".into()
            },
            Seat::B
        )
        .is_err());
}

#[test]
fn encode_matches_flash_v1_domain() {
    let s = Flash.initial_state(&ctx());
    let bytes = Flash.encode_state(&s);
    assert!(bytes.starts_with(b"sui_tunnel::proto::flash.v1"));
}

#[test]
fn apply_move_rejects_empty_message() {
    let s = Flash.initial_state(&ctx());
    assert!(Flash
        .apply_move(&s, &FlashMove { text: "".into() }, Seat::A)
        .is_err());
}

#[test]
fn apply_move_rejects_over_long_message() {
    let s = Flash.initial_state(&ctx());
    let text = "x".repeat(257);
    assert!(Flash.apply_move(&s, &FlashMove { text }, Seat::A).is_err());
}

#[test]
fn digest_sensitivity_to_sender() {
    let s = Flash.initial_state(&ctx());
    let from_a = Flash
        .apply_move(
            &s,
            &FlashMove {
                text: "same".into(),
            },
            Seat::A,
        )
        .unwrap();
    let from_b = Flash
        .apply_move(
            &s,
            &FlashMove {
                text: "same".into(),
            },
            Seat::B,
        )
        .unwrap();
    assert_ne!(from_a.transcript_digest, from_b.transcript_digest);
}

#[test]
fn digest_sensitivity_to_order() {
    let s = Flash.initial_state(&ctx());
    let s1 = Flash
        .apply_move(
            &s,
            &FlashMove {
                text: "first".into(),
            },
            Seat::A,
        )
        .unwrap();
    let s1 = Flash
        .apply_move(
            &s1,
            &FlashMove {
                text: "second".into(),
            },
            Seat::B,
        )
        .unwrap();

    let s2 = Flash
        .apply_move(
            &s,
            &FlashMove {
                text: "second".into(),
            },
            Seat::B,
        )
        .unwrap();
    let s2 = Flash
        .apply_move(
            &s2,
            &FlashMove {
                text: "first".into(),
            },
            Seat::A,
        )
        .unwrap();

    assert_ne!(s1.transcript_digest, s2.transcript_digest);
}

// Flash never reaches a terminal state, but every message boundary is a complete, co-signed state
// with no move in flight — so the tunnel must always be safe to cooperatively close. This is what
// lets a user-initiated settle wind the co-located bot down gracefully (the default
// `can_gracefully_close` is `is_terminal`, which flash never is).
#[test]
fn every_state_is_a_cooperative_close_boundary() {
    let initial = Flash.initial_state(&ctx());
    assert!(!Flash.is_terminal(&initial), "flash never terminates");
    assert!(
        Flash.can_gracefully_close(&initial),
        "initial state must be closeable"
    );

    let after = Flash
        .apply_move(&initial, &FlashMove { text: "hi".into() }, Seat::A)
        .unwrap();
    assert!(!Flash.is_terminal(&after));
    assert!(
        Flash.can_gracefully_close(&after),
        "a mid-conversation state must be closeable"
    );
}
