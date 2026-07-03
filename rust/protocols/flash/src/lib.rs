//! Flash protocol (`flash.v1`): two-party message transcript over a tunnel,
//! one message per move. Fixed-size rolling-digest state; nominal stake, no
//! value movement; move count capped at 1,000,000 (`FLASH_MAX_MOVES`).

pub mod responder;
pub mod strategy;
pub use responder::{ChatReply, ChatResponder, ChatRole, ChatTurn};
pub use strategy::FlashStrategy;

use markov_str::MarkovChain;
use std::sync::{Arc, OnceLock};
use tunnel_core::codec::u64_to_be_bytes;
use tunnel_core::crypto::blake2b256;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

const DOMAIN: &[u8] = b"sui_tunnel::proto::flash.v1";
pub(crate) const MAX_MESSAGE_BYTES: usize = 256;

#[derive(Clone, Debug)]
pub struct FlashState {
    pub transcript_digest: [u8; 32],
    pub message_count: u64,
    pub last_sender: Option<Seat>,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlashMove {
    pub text: String,
}

impl serde::Serialize for FlashMove {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.text)
    }
}
impl<'de> serde::Deserialize<'de> for FlashMove {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = <String as serde::Deserialize>::deserialize(d)?;
        Ok(FlashMove { text })
    }
}

/// Move cap: at 1,000,000 messages the tunnel settles and a fresh one opens. MUST stay in lockstep
/// with the TS `FLASH_MAX_MOVES` (cross-language parity) — both sides gate `apply_move` on it.
pub const FLASH_MAX_MOVES: u64 = 1_000_000;

#[derive(Clone, Copy, Debug)]
pub struct Flash;

fn party_byte(s: Seat) -> u8 {
    match s {
        Seat::A => 0x01,
        Seat::B => 0x02,
    }
}

/// Rolling fold: digest_n = blake2b256(digest_{n-1} || delta).
fn fold(prev: &[u8; 32], delta: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(prev.len() + delta.len());
    buf.extend_from_slice(prev);
    buf.extend_from_slice(delta);
    blake2b256(&buf)
}

impl Protocol for Flash {
    type State = FlashState;
    type Move = FlashMove;

    fn name(&self) -> &str {
        "flash.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> FlashState {
        FlashState {
            transcript_digest: [0u8; 32],
            message_count: 0,
            last_sender: None,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
            total: ctx.initial.a + ctx.initial.b,
        }
    }

    fn apply_move(
        &self,
        state: &FlashState,
        mv: &FlashMove,
        by: Seat,
    ) -> Result<FlashState, ProtocolError> {
        if state.message_count >= FLASH_MAX_MOVES {
            return Err(ProtocolError("flash: message cap reached".into()));
        }
        let bytes = mv.text.as_bytes();
        if bytes.is_empty() {
            return Err(ProtocolError("flash: message must be non-empty".into()));
        }
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(ProtocolError("flash: message too long".into()));
        }
        let mut delta = Vec::with_capacity(1 + 8 + bytes.len());
        delta.push(party_byte(by));
        delta.extend_from_slice(&u64_to_be_bytes(bytes.len() as u64));
        delta.extend_from_slice(bytes);
        let transcript_digest = fold(&state.transcript_digest, &blake2b256(&delta));
        Ok(FlashState {
            transcript_digest,
            message_count: state.message_count + 1,
            last_sender: Some(by),
            balance_a: state.balance_a,
            balance_b: state.balance_b,
            total: state.total,
        })
    }

    fn encode_state(&self, state: &FlashState) -> Vec<u8> {
        let mut out = Vec::with_capacity(DOMAIN.len() + 32 + 8 * 3);
        out.extend_from_slice(DOMAIN);
        out.extend_from_slice(&state.transcript_digest);
        out.extend_from_slice(&u64_to_be_bytes(state.message_count));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_a));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_b));
        out
    }

    fn balances(&self, state: &FlashState) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, _state: &FlashState) -> bool {
        false
    }

    /// Every flash state is a complete, co-signed message boundary with no move in flight, so the
    /// tunnel is always safe to cooperatively close. Flash never terminates, so the default
    /// (`is_terminal`) would keep it permanently un-closeable and block a user-initiated settle from
    /// gracefully winding the co-located bot down.
    fn can_gracefully_close(&self, _state: &FlashState) -> bool {
        true
    }

    fn sample_move(
        &self,
        state: &FlashState,
        _seat: Seat,
        _rng: &mut dyn FnMut() -> f64,
    ) -> Option<FlashMove> {
        Some(FlashMove {
            text: reply_for(&state.transcript_digest),
        })
    }
}

/// A process-wide trained Markov chain shared by all FlashStrategy instances.
/// Built once from the embedded corpus; replies are ~µs.
fn shared_chain() -> Arc<MarkovChain> {
    static CHAIN: OnceLock<Arc<MarkovChain>> = OnceLock::new();
    CHAIN
        .get_or_init(|| {
            let regex = regex::Regex::new(markov_str::WORD_REGEX).expect("built-in word regex");
            let mut chain = MarkovChain::with_capacity(2, 65_536, regex);
            chain.add_text(include_str!("corpus.txt"));
            Arc::new(chain)
        })
        .clone()
}

/// Generate a short, varied, state-coupled reply. The RNG is seeded from the
/// transcript digest so the reply is a pure function of the conversation state
/// (it changes as messages arrive — the trait exposes only the hashed state,
/// not message text). Kept here so the loop and the strategy share one path.
pub fn reply_for(digest: &[u8; 32]) -> String {
    use rand::SeedableRng;
    let seed = u64::from_be_bytes(digest[..8].try_into().unwrap());
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let chain = shared_chain();
    let mut text = String::new();
    for word in chain.iter(80, &mut rng) {
        let extra = if text.is_empty() {
            word.len()
        } else {
            word.len() + 1
        };
        if text.len() + extra > MAX_MESSAGE_BYTES {
            break;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(word);
    }
    if text.trim().is_empty() {
        "msg".to_string()
    } else {
        text
    }
}
