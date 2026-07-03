use std::sync::Arc;

use crate::responder::{ChatResponder, ChatRole, ChatTurn};
use crate::{reply_for, Flash, FlashMove, FlashState, MAX_MESSAGE_BYTES};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Seat};

/// How many recent turns to forward to the LLM. Bounds the prompt so replies stay fast; older
/// context is dropped rather than growing an unbounded conversation over a million-message tunnel.
const CHAT_CONTEXT_TURNS: usize = 8;

/// Bot reply strategy for flash. When a [`ChatResponder`] is wired (the co-located arena bot in
/// chat mode), it answers with the LLM's reply to the recent plaintext transcript; otherwise, and
/// on any LLM miss, it falls back to a Markov reply seeded by the transcript digest. Either way it
/// speaks only when it is genuinely this seat's turn — one reply per incoming message, then it
/// yields.
pub struct FlashStrategy {
    /// LLM oracle, when chat mode wires one. `None` → pure Markov (bench self-play, offline).
    responder: Option<Arc<dyn ChatResponder>>,
    /// Recent plaintext conversation (oldest→newest), the only view of message text the strategy
    /// keeps — the co-signed state exposes just the folded digest.
    turns: Vec<ChatTurn>,
    /// The reply this seat proposed but has not yet had committed; recorded into `turns` as an
    /// assistant turn once the driver confirms it, so context stays aligned with the transcript.
    pending_reply: Option<String>,
}

impl FlashStrategy {
    /// A Markov-only strategy (no LLM). Used by bench self-play and as the offline fallback.
    pub fn new() -> Self {
        FlashStrategy {
            responder: None,
            turns: Vec::new(),
            pending_reply: None,
        }
    }

    /// A strategy that answers with `responder`'s LLM reply, falling back to Markov on any miss.
    pub fn with_responder(responder: Arc<dyn ChatResponder>) -> Self {
        FlashStrategy {
            responder: Some(responder),
            turns: Vec::new(),
            pending_reply: None,
        }
    }

    /// Append a turn, keeping only the most recent [`CHAT_CONTEXT_TURNS`] so the prompt stays small.
    fn remember(&mut self, role: ChatRole, text: String) {
        self.turns.push(ChatTurn { role, text });
        let overflow = self.turns.len().saturating_sub(CHAT_CONTEXT_TURNS);
        if overflow > 0 {
            self.turns.drain(0..overflow);
        }
    }

    /// The reply text: the LLM's answer (truncated to one frame, non-empty) when available, else
    /// the digest-seeded Markov reply. Kept private so `plan_move` is the single decision point.
    async fn reply(&self, state: &FlashState) -> String {
        if let Some(responder) = &self.responder {
            if let Some(raw) = responder.respond(&self.turns).await {
                let text = truncate_to_frame(&raw);
                if !text.is_empty() {
                    return text;
                }
            }
        }
        reply_for(&state.transcript_digest)
    }
}

impl Default for FlashStrategy {
    fn default() -> Self {
        FlashStrategy::new()
    }
}

/// Truncate a reply to the flash frame limit on a UTF-8 boundary, trimming surrounding whitespace.
/// The LLM has no byte budget, but `apply_move` rejects anything over [`MAX_MESSAGE_BYTES`], so an
/// unbounded reply would abort the match.
fn truncate_to_frame(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() <= MAX_MESSAGE_BYTES {
        return trimmed.to_string();
    }
    let mut end = MAX_MESSAGE_BYTES;
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    trimmed[..end].trim_end().to_string()
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
        let text = self.reply(state).await;
        self.pending_reply = Some(text.clone());
        Some(FlashMove { text })
    }

    /// The peer's (user's) message just committed — record its plaintext as context for the reply
    /// the driver will ask for next.
    fn observe_peer_move(&mut self, mv: &FlashMove) {
        self.remember(ChatRole::User, mv.text.clone());
    }

    /// Our proposed reply committed — fold it into the context as an assistant turn so the next
    /// LLM call sees a coherent back-and-forth.
    fn confirm_move(&mut self, _state: &FlashState) {
        if let Some(text) = self.pending_reply.take() {
            self.remember(ChatRole::Assistant, text);
        }
    }
}
