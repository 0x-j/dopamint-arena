use tunnel_flash::{Flash, FlashMove, FlashStrategy};
use tunnel_harness::{Balances, MoveStrategy, MoveStrategyContext, Protocol, Seat, TunnelContext};

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
async fn strategy_is_deterministic_for_same_state() {
    let state = Flash.initial_state(&ctx());
    let mut strategy_a = FlashStrategy::new();
    let mut strategy_b = FlashStrategy::new();
    let mv_a = strategy_a.plan_move(&state, Seat::A, &strategy_ctx()).await;
    let mv_b = strategy_b.plan_move(&state, Seat::A, &strategy_ctx()).await;
    assert_eq!(mv_a, mv_b);
}
