//! Canonical protocol ID validation and domain construction.
//!
//! Protocol IDs use dot-separated semantic segments, snake_case within each
//! segment, and a terminal version segment (`.v1`, `.v2`, ...).

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolId(String);

pub const API_CREDITS_V1: &str = "api_credits.v1";
pub const BATTLESHIP_V1: &str = "battleship.v1";
pub const BATTLESHIP_SERIES_V1: &str = "battleship.series.v1";
pub const BLACKJACK_BET_V1: &str = "blackjack.bet.v1";
pub const BLACKJACK_DUEL_V1: &str = "blackjack.duel.v1";
pub const BLACKJACK_V2: &str = "blackjack.v2";
pub const BOMB_IT_V1: &str = "bomb_it.v1";
pub const BOMB_IT_SERIES_V1: &str = "bomb_it.series.v1";
pub const CARO_V1: &str = "caro.v1";
pub const CARO_SERIES_V1: &str = "caro.series.v1";
pub const CHAT_V1: &str = "chat.v1";
pub const CROSS_V1: &str = "cross.v1";
pub const CROSS_SERIES_V1: &str = "cross.series.v1";
pub const FLASH_V1: &str = "flash.v1";
pub const PAYMENTS_V1: &str = "payments.v1";
pub const QUANTUM_POKER_V2: &str = "quantum_poker.v2";
pub const TIC_TAC_TOE_V1: &str = "tic_tac_toe.v1";
pub const TIC_TAC_TOE_SERIES_V1: &str = "tic_tac_toe.series.v1";
pub const WORLD_CANVAS_CELL_V1: &str = "world_canvas.cell.v1";
pub const WORLD_CANVAS_STROKE_V1: &str = "world_canvas.stroke.v1";

pub const PORTED_PROTOCOL_IDS: &[&str] = &[
    API_CREDITS_V1,
    BATTLESHIP_V1,
    BATTLESHIP_SERIES_V1,
    BLACKJACK_BET_V1,
    BLACKJACK_DUEL_V1,
    BLACKJACK_V2,
    BOMB_IT_V1,
    BOMB_IT_SERIES_V1,
    CARO_V1,
    CARO_SERIES_V1,
    CHAT_V1,
    CROSS_V1,
    CROSS_SERIES_V1,
    FLASH_V1,
    PAYMENTS_V1,
    QUANTUM_POKER_V2,
    TIC_TAC_TOE_V1,
    TIC_TAC_TOE_SERIES_V1,
    WORLD_CANVAS_CELL_V1,
    WORLD_CANVAS_STROKE_V1,
];

impl ProtocolId {
    pub fn parse(id: impl Into<String>) -> Result<Self, String> {
        let id = id.into();
        validate_protocol_id(&id)?;
        Ok(Self(id))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn domain(&self) -> Vec<u8> {
        protocol_domain(self.as_str())
    }
}

pub fn protocol_domain(id: &str) -> Vec<u8> {
    let mut out = b"sui_tunnel::proto::".to_vec();
    out.extend_from_slice(id.as_bytes());
    out
}

pub fn validate_protocol_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("protocol id cannot be empty".into());
    }
    if !id.is_ascii() {
        return Err("protocol id must be ascii".into());
    }
    let segments: Vec<_> = id.split('.').collect();
    if segments.len() < 2 {
        return Err("protocol id must include a version segment".into());
    }
    for segment in &segments {
        validate_segment(segment)?;
    }
    let version = segments.last().expect("len checked");
    let Some(digits) = version.strip_prefix('v') else {
        return Err("protocol id must end with .vN".into());
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err("protocol id must end with .vN".into());
    }
    Ok(())
}

fn validate_segment(segment: &str) -> Result<(), String> {
    if segment.is_empty() {
        return Err("protocol id segments cannot be empty".into());
    }
    if segment.starts_with('_') || segment.ends_with('_') || segment.contains("__") {
        return Err(format!("invalid snake_case segment: {segment}"));
    }
    let mut previous_was_underscore = false;
    for b in segment.bytes() {
        let valid = b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_';
        if !valid {
            return Err(format!("invalid snake_case segment: {segment}"));
        }
        if b == b'_' && previous_was_underscore {
            return Err(format!("invalid snake_case segment: {segment}"));
        }
        previous_was_underscore = b == b'_';
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_canonical_protocol_ids() {
        for id in PORTED_PROTOCOL_IDS {
            assert!(validate_protocol_id(id).is_ok(), "{id}");
        }
    }

    #[test]
    fn ported_protocol_ids_are_unique() {
        for (i, a) in PORTED_PROTOCOL_IDS.iter().enumerate() {
            for b in &PORTED_PROTOCOL_IDS[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn rejects_legacy_or_ambiguous_protocol_ids() {
        for id in [
            "",
            "world-canvas-pvp",
            "tic_tac_toe.multi",
            "ticTacToe.v1",
            "world_canvas..v1",
            "world_canvas._cell.v1",
            "world_canvas.cell.v",
        ] {
            assert!(validate_protocol_id(id).is_err(), "{id}");
        }
    }

    #[test]
    fn domain_matches_ts_protocol_domain() {
        let id = ProtocolId::parse("world_canvas.cell.v1").unwrap();
        assert_eq!(
            id.domain(),
            b"sui_tunnel::proto::world_canvas.cell.v1".to_vec()
        );
    }
}
