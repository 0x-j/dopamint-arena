use crate::{reply_for, Flash, FlashMove, FlashState};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Seat};

/// Bot reply strategy for flash. Answers with a Markov reply seeded by the current
/// transcript digest, but only when it is genuinely this seat's turn — one reply per
/// incoming message, then it yields. Stateless beyond the protocol state it receives.
#[derive(Clone, Copy, Debug)]
pub struct FlashStrategy;

impl FlashStrategy {
    pub fn new() -> Self {
        FlashStrategy
    }
}

impl Default for FlashStrategy {
    fn default() -> Self {
        FlashStrategy::new()
    }
}

impl MoveStrategy<Flash> for FlashStrategy {
    async fn plan_move(
        &mut self,
        state: &FlashState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<FlashMove> {
        // Strict one-for-one alternation: whoever did NOT send the last message sends the next
        // one, and seat A opens the conversation. Returning `None` parks the driver in its
        // receiver arm to wait for the opponent. In the co-located arena the bot is seat B, so it
        // stays silent until the user (seat A) speaks, then answers exactly once per incoming
        // message — never a self-driven monologue. In bench self-play both seats run this strategy,
        // so having seat A open keeps the alternation from deadlocking.
        let our_turn = match state.last_sender {
            None => seat == Seat::A,
            Some(last) => last != seat,
        };
        if !our_turn {
            return None;
        }
        let text = reply_for(&state.transcript_digest);
        Some(FlashMove { text })
    }
}
