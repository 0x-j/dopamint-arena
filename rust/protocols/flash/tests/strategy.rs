use std::sync::{Arc, Mutex};

use tunnel_flash::{ChatReply, ChatResponder, ChatRole, ChatTurn, Flash, FlashMove, FlashStrategy};
use tunnel_harness::{Balances, MoveStrategy, MoveStrategyContext, Protocol, Seat, TunnelContext};

/// Shared log of every conversation the responder was handed, for asserting forwarded context.
type SeenTurns = Arc<Mutex<Vec<Vec<ChatTurn>>>>;

/// A responder that returns a canned line and records every conversation it was handed, so tests
/// can assert both what the bot says and what context it forwards to the LLM.
struct FakeResponder {
    reply: Option<String>,
    seen: SeenTurns,
}

impl FakeResponder {
    fn returning(reply: Option<&str>) -> (Arc<Self>, SeenTurns) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let responder = Arc::new(FakeResponder {
            reply: reply.map(str::to_string),
            seen: Arc::clone(&seen),
        });
        (responder, seen)
    }
}

impl ChatResponder for FakeResponder {
    fn respond<'a>(&'a self, turns: &'a [ChatTurn]) -> ChatReply<'a> {
        Box::pin(async move {
            self.seen.lock().unwrap().push(turns.to_vec());
            self.reply.clone()
        })
    }
}

/// Drive one user message through a seat-B bot and return its reply text.
async fn bot_reply_to(bot: &mut FlashStrategy, user_text: &str) -> String {
    let initial = Flash.initial_state(&ctx());
    let user = FlashMove {
        text: user_text.into(),
    };
    let after_user = Flash
        .apply_move(&initial, &user, Seat::A)
        .expect("user move applies");
    bot.observe_peer_move(&user);
    let reply = bot
        .plan_move(&after_user, Seat::B, &strategy_ctx())
        .await
        .expect("bot replies");
    // Mirror the driver: the bot's own move commits, then `confirm_move` fires.
    let after_bot = Flash
        .apply_move(&after_user, &reply, Seat::B)
        .expect("bot move applies");
    bot.confirm_move(&after_bot);
    reply.text
}

fn ctx() -> TunnelContext {
    TunnelContext {
        tunnel_id: "0xab".into(),
        initial: Balances { a: 100, b: 100 },
        seat: Seat::A,
    }
}

fn strategy_ctx() -> MoveStrategyContext {
    MoveStrategyContext {
        tunnel_id: "0xab".into(),
        seat: Seat::A,
    }
}

#[tokio::test]
async fn strategy_produces_legal_move() {
    let state = Flash.initial_state(&ctx());
    let mut strategy = FlashStrategy::new();
    let mv = strategy
        .plan_move(&state, Seat::A, &strategy_ctx())
        .await
        .expect("strategy returns a move");
    assert!(!mv.text.is_empty());
    assert!(mv.text.len() <= 256);
    assert!(Flash.apply_move(&state, &mv, Seat::A).is_ok());
}

#[tokio::test]
async fn bot_waits_for_user_then_replies_once() {
    // Seat B is the co-located arena bot. It must not open the conversation, must answer exactly
    // once after the user (seat A) speaks, and must then wait again — no self-driven monologue.
    let initial = Flash.initial_state(&ctx());
    let mut bot = FlashStrategy::new();

    // Nobody has spoken yet: the bot (seat B) stays silent so the user opens.
    assert!(
        bot.plan_move(&initial, Seat::B, &strategy_ctx())
            .await
            .is_none(),
        "bot must wait for the user's first message"
    );

    // The user (seat A) sends a message; now it is the bot's turn to reply.
    let user_msg = FlashMove {
        text: "hello".into(),
    };
    let after_user = Flash
        .apply_move(&initial, &user_msg, Seat::A)
        .expect("user move applies");
    let reply = bot
        .plan_move(&after_user, Seat::B, &strategy_ctx())
        .await
        .expect("bot replies to the user's message");

    // After its own reply, the bot yields and waits for the next incoming message.
    let after_bot = Flash
        .apply_move(&after_user, &reply, Seat::B)
        .expect("bot move applies");
    assert!(
        bot.plan_move(&after_bot, Seat::B, &strategy_ctx())
            .await
            .is_none(),
        "bot must wait after replying — exactly one reply per incoming message"
    );
}

#[tokio::test]
async fn bot_replies_with_the_llm_response_when_a_responder_is_wired() {
    let (responder, _seen) = FakeResponder::returning(Some("beep boop, fascinating!"));
    let mut bot = FlashStrategy::with_responder(responder);
    assert_eq!(
        bot_reply_to(&mut bot, "hello there").await,
        "beep boop, fascinating!"
    );
}

#[tokio::test]
async fn bot_truncates_an_overlong_llm_reply_to_one_flash_frame() {
    let long = "x".repeat(1000);
    let (responder, _seen) = FakeResponder::returning(Some(&long));
    let mut bot = FlashStrategy::with_responder(responder);
    let reply = bot_reply_to(&mut bot, "say a lot").await;
    assert!(!reply.is_empty());
    assert!(
        reply.len() <= 256,
        "reply must fit one flash frame, got {}",
        reply.len()
    );
    // The truncated reply must still be an applicable move.
    let state = Flash.initial_state(&ctx());
    assert!(Flash
        .apply_move(&state, &FlashMove { text: reply }, Seat::B)
        .is_ok());
}

#[tokio::test]
async fn bot_truncates_on_a_utf8_boundary() {
    // 200 × 2-byte 'é' = 400 bytes; a byte-count cut at 256 would land mid-char and panic/produce
    // invalid UTF-8. The bot must cut on a char boundary.
    let (responder, _seen) = FakeResponder::returning(Some(&"é".repeat(200)));
    let mut bot = FlashStrategy::with_responder(responder);
    let reply = bot_reply_to(&mut bot, "accents please").await;
    assert!(reply.len() <= 256);
    assert!(reply.chars().all(|c| c == 'é'), "no mangled partial char");
}

#[tokio::test]
async fn bot_falls_back_to_markov_when_the_responder_declines() {
    // A responder returning None (model down/slow/empty) must not stall the bot: it falls back to
    // the offline digest-seeded Markov reply — exactly what a responder-less bot produces.
    let (responder, _seen) = FakeResponder::returning(None);
    let mut with = FlashStrategy::with_responder(responder);
    let mut without = FlashStrategy::new();
    assert_eq!(
        bot_reply_to(&mut with, "hello").await,
        bot_reply_to(&mut without, "hello").await,
    );
}

#[tokio::test]
async fn bot_forwards_the_recent_transcript_to_the_responder() {
    // The responder must receive the plaintext turns in order and tagged by role: the user's
    // messages as `User`, the bot's own prior reply as `Assistant`.
    let (responder, seen) = FakeResponder::returning(Some("second reply"));
    let mut bot = FlashStrategy::with_responder(responder);
    bot_reply_to(&mut bot, "hi bot").await;
    bot_reply_to(&mut bot, "how are you").await;

    let calls = seen.lock().unwrap();
    let last = calls.last().expect("responder was called");
    assert_eq!(
        *last,
        vec![
            ChatTurn {
                role: ChatRole::User,
                text: "hi bot".into()
            },
            ChatTurn {
                role: ChatRole::Assistant,
                text: "second reply".into()
            },
            ChatTurn {
                role: ChatRole::User,
                text: "how are you".into()
            },
        ],
        "conversation is forwarded oldest→newest with correct roles"
    );
}

#[tokio::test]
async fn strategy_is_deterministic_for_same_state() {
    let state = Flash.initial_state(&ctx());
    let mut strategy_a = FlashStrategy::new();
    let mut strategy_b = FlashStrategy::new();
    let mv_a = strategy_a.plan_move(&state, Seat::A, &strategy_ctx()).await;
    let mv_b = strategy_b.plan_move(&state, Seat::A, &strategy_ctx()).await;
    assert_eq!(mv_a, mv_b);
}
