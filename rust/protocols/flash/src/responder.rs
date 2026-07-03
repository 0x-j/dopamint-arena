//! The LLM seam for flash chat. `FlashStrategy` holds an optional [`ChatResponder`] and calls it
//! to turn the recent plaintext transcript into the bot's next reply. The trait is object-safe
//! (`Arc<dyn ChatResponder>`) so the app layer can inject an Ollama-backed responder without this
//! protocol crate taking on an HTTP stack. A `None` result means "fall back" — the strategy then
//! uses its offline Markov reply, so a slow or unreachable model never stalls the match.

use std::future::Future;
use std::pin::Pin;

/// Who spoke, from the bot's point of view. Maps onto chat-completion roles: the human on the
/// other seat is [`ChatRole::User`]; the bot's own prior replies are [`ChatRole::Assistant`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatRole {
    User,
    Assistant,
}

/// One turn of the visible conversation, oldest→newest, as the strategy has seen it in plaintext.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatTurn {
    pub role: ChatRole,
    pub text: String,
}

/// The future returned by [`ChatResponder::respond`]. Boxed so the trait stays object-safe without
/// pulling `async-trait` into this crate; borrows `self`/`turns` for the duration of the call.
pub type ChatReply<'a> = Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>>;

/// Async oracle that produces the bot's next reply from the recent transcript. Returns `None` to
/// signal the caller should fall back (model unavailable, timed out, or replied empty).
pub trait ChatResponder: Send + Sync {
    fn respond<'a>(&'a self, turns: &'a [ChatTurn]) -> ChatReply<'a>;
}
