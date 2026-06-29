//! Quantum Poker v2, ported from `sui-tunnel-ts/src/protocol/quantumPoker.ts`.

use std::collections::{BTreeMap, BTreeSet};

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_core::commitment::{combine_reveals, compute_commitment, verify_commitment};
use tunnel_core::crypto::blake2b256;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

pub mod strategy;
pub use strategy::{
    QuantumPokerBotProfile, QuantumPokerDifficulty, QuantumPokerPersona,
    QuantumPokerPersonaStrategy, QuantumPokerStrategy,
};

const DOMAIN: &[u8] = b"sui_tunnel::proto::quantum_poker.v2";
pub const ANTE: u64 = 50;
pub const DEFAULT_HAND_CAP: u64 = 1000;
pub const SLOT_COUNT: usize = 9;
const A_HOLE_SLOTS: [u8; 2] = [0, 1];
const B_HOLE_SLOTS: [u8; 2] = [2, 3];
const FLOP_SLOTS: [u8; 3] = [4, 5, 6];
const TURN_SLOTS: [u8; 1] = [7];
const RIVER_SLOTS: [u8; 1] = [8];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PokerPhase {
    Commit,
    OpenPrivateHoles,
    PreflopBet,
    RevealFlop,
    FlopBet,
    RevealTurn,
    TurnBet,
    RevealRiver,
    RiverBet,
    Showdown,
    HandOver,
    Done,
}

impl PokerPhase {
    fn code(self) -> u8 {
        match self {
            PokerPhase::Commit => 0,
            PokerPhase::OpenPrivateHoles => 1,
            PokerPhase::PreflopBet => 2,
            PokerPhase::RevealFlop => 3,
            PokerPhase::FlopBet => 4,
            PokerPhase::RevealTurn => 5,
            PokerPhase::TurnBet => 6,
            PokerPhase::RevealRiver => 7,
            PokerPhase::RiverBet => 8,
            PokerPhase::Showdown => 9,
            PokerPhase::HandOver => 10,
            PokerPhase::Done => 11,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PokerWinner {
    A,
    B,
    Tie,
}

impl PokerWinner {
    fn code(self) -> u8 {
        match self {
            PokerWinner::A => 1,
            PokerWinner::B => 2,
            PokerWinner::Tie => 3,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResultReason {
    Fold,
    Showdown,
}

impl ResultReason {
    fn code(self) -> u8 {
        match self {
            ResultReason::Fold => 1,
            ResultReason::Showdown => 2,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SlotReveal {
    pub value: Vec<u8>,
    pub salt: Vec<u8>,
}

pub type SlotSecret = SlotReveal;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PokerHandResult {
    pub winner: PokerWinner,
    pub reason: ResultReason,
    pub score_a: Option<u64>,
    pub score_b: Option<u64>,
    pub best_a: Option<Vec<u8>>,
    pub best_b: Option<Vec<u8>>,
    pub burned_a: Vec<u8>,
    pub burned_b: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PokerState {
    pub phase: PokerPhase,
    pub hand_no: u64,
    pub hand_cap: u64,
    pub commit_a: Option<Vec<[u8; 32]>>,
    pub commit_b: Option<Vec<[u8; 32]>>,
    pub reveals_a: Vec<Option<SlotReveal>>,
    pub reveals_b: Vec<Option<SlotReveal>>,
    pub local_secrets_a: Option<Vec<Option<SlotSecret>>>,
    pub local_secrets_b: Option<Vec<Option<SlotSecret>>>,
    pub hole_a: Option<Vec<u8>>,
    pub hole_b: Option<Vec<u8>>,
    pub board: Vec<u8>,
    pub board_slots: Vec<u8>,
    pub board_counters: Vec<u64>,
    pub total_bet_a: u64,
    pub total_bet_b: u64,
    pub street_bet_a: u64,
    pub street_bet_b: u64,
    pub to_act: Seat,
    pub acted_a: bool,
    pub acted_b: bool,
    pub folded_by: Option<Seat>,
    pub shown_a: bool,
    pub shown_b: bool,
    pub shown_hole_a: Option<Vec<u8>>,
    pub shown_hole_b: Option<Vec<u8>>,
    pub winner: Option<PokerWinner>,
    pub last_result: Option<PokerHandResult>,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PokerMove {
    CommitSlots {
        commitments: Vec<[u8; 32]>,
        #[serde(skip_serializing, skip_deserializing, default)]
        local_secrets: Option<Vec<SlotSecret>>,
    },
    RevealSlots {
        slots: Vec<u8>,
        reveals: Vec<SlotReveal>,
    },
    Bet {
        amount: u64,
    },
    Check,
    Call,
    Fold,
    NextHand,
}

#[derive(Clone, Copy, Debug)]
pub struct QuantumPoker {
    hand_cap: u64,
}

impl QuantumPoker {
    pub fn new(hand_cap: u64) -> Self {
        Self { hand_cap }
    }
}

impl Default for QuantumPoker {
    fn default() -> Self {
        Self {
            hand_cap: DEFAULT_HAND_CAP,
        }
    }
}

fn empty_reveals() -> Vec<Option<SlotReveal>> {
    vec![None; SLOT_COUNT]
}

fn reveal_array(state: &PokerState, party: Seat) -> &[Option<SlotReveal>] {
    if party == Seat::A {
        &state.reveals_a
    } else {
        &state.reveals_b
    }
}

fn reveal_array_mut(state: &mut PokerState, party: Seat) -> &mut [Option<SlotReveal>] {
    if party == Seat::A {
        &mut state.reveals_a
    } else {
        &mut state.reveals_b
    }
}

fn commit_array(state: &PokerState, party: Seat) -> Option<&Vec<[u8; 32]>> {
    if party == Seat::A {
        state.commit_a.as_ref()
    } else {
        state.commit_b.as_ref()
    }
}

fn local_secret_array(state: &PokerState, party: Seat) -> Option<&Vec<Option<SlotSecret>>> {
    if party == Seat::A {
        state.local_secrets_a.as_ref()
    } else {
        state.local_secrets_b.as_ref()
    }
}

fn has_revealed(state: &PokerState, party: Seat, slots: &[u8]) -> bool {
    let reveals = reveal_array(state, party);
    slots.iter().all(|&slot| reveals[slot as usize].is_some())
}

pub fn expected_quantum_poker_reveal_slots(
    state: &PokerState,
    by: Seat,
) -> Result<Vec<u8>, String> {
    let missing = |slots: &[u8]| {
        slots
            .iter()
            .copied()
            .filter(|slot| reveal_array(state, by)[*slot as usize].is_none())
            .collect()
    };
    match state.phase {
        PokerPhase::OpenPrivateHoles => Ok(if by == Seat::A {
            missing(&B_HOLE_SLOTS)
        } else {
            missing(&A_HOLE_SLOTS)
        }),
        PokerPhase::RevealFlop => Ok(missing(&FLOP_SLOTS)),
        PokerPhase::RevealTurn => Ok(missing(&TURN_SLOTS)),
        PokerPhase::RevealRiver => Ok(missing(&RIVER_SLOTS)),
        PokerPhase::Showdown => Ok(if by == Seat::A {
            missing(&A_HOLE_SLOTS)
        } else {
            missing(&B_HOLE_SLOTS)
        }),
        _ => Err(format!("no slot reveal legal in phase {:?}", state.phase)),
    }
}

pub fn commit_slot_secrets(secrets: &[SlotSecret]) -> Result<Vec<[u8; 32]>, String> {
    if secrets.len() != SLOT_COUNT {
        return Err(format!("expected {SLOT_COUNT} slot secrets"));
    }
    secrets
        .iter()
        .map(|secret| compute_commitment(&secret.value, &secret.salt))
        .collect()
}

/// Derive a single Quantum Poker card from two slot reveals.
///
/// Per the Quantum Games design, every slot is an *independent sample*: combine both
/// reveals into a 32-byte seed and reduce it modulo 52 — the whitepaper's
/// `Card = Random() mod 52`. This is one hash per card (the `combine_reveals` already
/// required), not a 51-swap Fisher-Yates over a fresh 52-card deck. There is no hidden
/// global deck; board uniqueness is enforced by the caller via `counter`, and the
/// showdown burn rule resolves any hidden/board collisions.
///
/// We reduce the *full* 256-bit seed modulo 52 (big-endian, byte-by-byte Horner fold)
/// so the whole hash contributes its entropy. The residual modulo bias is bounded by
/// `52 / 2^256` (~2^-250) — unobservable — without the extra hash that rejection
/// sampling would cost.
pub fn derive_quantum_card(a: &SlotReveal, b: &SlotReveal, counter: u64) -> u8 {
    let slot_seed = combine_reveals(&a.value, &a.salt, &b.value, &b.salt);
    let seed_bytes = if counter == 0 {
        slot_seed
    } else {
        let mut input = Vec::with_capacity(40);
        input.extend_from_slice(&slot_seed);
        input.extend_from_slice(&u64_to_be_bytes(counter));
        blake2b256(&input)
    };
    let mut acc: u32 = 0;
    for &byte in seed_bytes.iter() {
        acc = (acc * 256 + byte as u32) % 52;
    }
    acc as u8
}

fn same_number_set(a: &[u8], b: &[u8]) -> bool {
    a.iter().copied().collect::<BTreeSet<_>>() == b.iter().copied().collect::<BTreeSet<_>>()
        && a.len() == b.len()
}

fn street_bet(state: &PokerState, by: Seat) -> u64 {
    if by == Seat::A {
        state.street_bet_a
    } else {
        state.street_bet_b
    }
}

fn set_street_bet(state: &mut PokerState, by: Seat, value: u64) {
    if by == Seat::A {
        state.street_bet_a = value;
    } else {
        state.street_bet_b = value;
    }
}

fn total_bet(state: &PokerState, by: Seat) -> u64 {
    if by == Seat::A {
        state.total_bet_a
    } else {
        state.total_bet_b
    }
}

fn add_total_bet(state: &mut PokerState, by: Seat, amount: u64) {
    if by == Seat::A {
        state.total_bet_a += amount;
    } else {
        state.total_bet_b += amount;
    }
}

fn balance(state: &PokerState, by: Seat) -> u64 {
    if by == Seat::A {
        state.balance_a
    } else {
        state.balance_b
    }
}

fn available_for(state: &PokerState, by: Seat) -> u64 {
    let effective = state.balance_a.min(state.balance_b);
    effective.saturating_sub(total_bet(state, by))
}

fn betting_closed(state: &PokerState) -> bool {
    available_for(state, Seat::A) == 0 || available_for(state, Seat::B) == 0
}

fn mark_acted(state: &mut PokerState, by: Seat, acted: bool) {
    if by == Seat::A {
        state.acted_a = acted;
    } else {
        state.acted_b = acted;
    }
}

impl QuantumPoker {
    fn begin_street(&self, state: &mut PokerState, phase: PokerPhase) {
        state.phase = phase;
        state.street_bet_a = 0;
        state.street_bet_b = 0;
        state.to_act = Seat::A;
        state.acted_a = false;
        state.acted_b = false;
    }

    fn post_antes_and_begin_street(&self, state: &mut PokerState) -> Result<(), String> {
        if state.balance_a < ANTE || state.balance_b < ANTE {
            return Err("insufficient balance for ante".into());
        }
        state.total_bet_a = ANTE;
        state.total_bet_b = ANTE;
        self.begin_street(state, PokerPhase::PreflopBet);
        Ok(())
    }

    fn reveal_for_derivation(
        state: &PokerState,
        party: Seat,
        slot: u8,
        allow_local: bool,
    ) -> Option<&SlotReveal> {
        reveal_array(state, party)[slot as usize]
            .as_ref()
            .or_else(|| {
                allow_local
                    .then(|| {
                        local_secret_array(state, party)?
                            .get(slot as usize)?
                            .as_ref()
                    })
                    .flatten()
            })
    }

    fn derive_slot_card(
        state: &PokerState,
        slot: u8,
        counter: u64,
        allow_local: bool,
    ) -> Option<u8> {
        let a = Self::reveal_for_derivation(state, Seat::A, slot, allow_local)?;
        let b = Self::reveal_for_derivation(state, Seat::B, slot, allow_local)?;
        Some(derive_quantum_card(a, b, counter))
    }

    fn derive_unique_board_card(
        &self,
        state: &PokerState,
        slot: u8,
        used: &BTreeSet<u8>,
    ) -> Result<(u8, u64), String> {
        for counter in 0..10_000 {
            let card = Self::derive_slot_card(state, slot, counter, false)
                .ok_or_else(|| format!("board slot {slot} is not revealed"))?;
            if !used.contains(&card) {
                return Ok((card, counter));
            }
        }
        Err("could not derive unique board card".into())
    }

    fn derive_hole_cards(
        &self,
        state: &PokerState,
        owner: Seat,
        allow_local: bool,
    ) -> Option<Vec<u8>> {
        let slots = if owner == Seat::A {
            A_HOLE_SLOTS
        } else {
            B_HOLE_SLOTS
        };
        slots
            .iter()
            .map(|&slot| Self::derive_slot_card(state, slot, 0, allow_local))
            .collect()
    }

    fn try_reveal_board_then_bet(
        &self,
        state: &mut PokerState,
        slots: &[u8],
        next_phase: PokerPhase,
    ) -> Result<(), String> {
        if !has_revealed(state, Seat::A, slots) || !has_revealed(state, Seat::B, slots) {
            return Ok(());
        }
        let mut used: BTreeSet<u8> = state.board.iter().copied().collect();
        for &slot in slots {
            if state.board_slots.contains(&slot) {
                continue;
            }
            let (card, counter) = self.derive_unique_board_card(state, slot, &used)?;
            state.board.push(card);
            state.board_slots.push(slot);
            state.board_counters.push(counter);
            used.insert(card);
        }
        if betting_closed(state) {
            state.phase = match next_phase {
                PokerPhase::FlopBet => PokerPhase::RevealTurn,
                PokerPhase::TurnBet => PokerPhase::RevealRiver,
                _ => PokerPhase::Showdown,
            };
        } else {
            self.begin_street(state, next_phase);
        }
        Ok(())
    }

    fn apply_commit(
        &self,
        state: &PokerState,
        mv: &PokerMove,
        by: Seat,
    ) -> Result<PokerState, String> {
        let PokerMove::CommitSlots {
            commitments,
            local_secrets,
        } = mv
        else {
            return Err("expected commit_slots".into());
        };
        if commitments.len() != SLOT_COUNT {
            return Err(format!("expected {SLOT_COUNT} slot commitments"));
        }
        let secrets = if let Some(secrets) = local_secrets {
            let expected = commit_slot_secrets(secrets)?;
            if expected != *commitments {
                return Err("local secrets do not match commitments".into());
            }
            Some(secrets.iter().cloned().map(Some).collect::<Vec<_>>())
        } else {
            None
        };
        let mut next = state.clone();
        match by {
            Seat::A => {
                if next.commit_a.is_some() {
                    return Err("A already committed".into());
                }
                next.commit_a = Some(commitments.clone());
                if secrets.is_some() {
                    next.local_secrets_a = secrets;
                }
            }
            Seat::B => {
                if next.commit_b.is_some() {
                    return Err("B already committed".into());
                }
                next.commit_b = Some(commitments.clone());
                if secrets.is_some() {
                    next.local_secrets_b = secrets;
                }
            }
        }
        if next.commit_a.is_some() && next.commit_b.is_some() {
            next.phase = PokerPhase::OpenPrivateHoles;
        }
        Ok(next)
    }

    fn apply_reveal_slots(
        &self,
        state: &PokerState,
        mv: &PokerMove,
        by: Seat,
    ) -> Result<PokerState, String> {
        let PokerMove::RevealSlots { slots, reveals } = mv else {
            return Err("expected reveal_slots".into());
        };
        let expected = expected_quantum_poker_reveal_slots(state, by)?;
        if !same_number_set(slots, &expected) {
            return Err("unexpected reveal slots".into());
        }
        if reveals.len() != slots.len() {
            return Err("slots/reveals length mismatch".into());
        }
        let commits = commit_array(state, by).ok_or_else(|| format!("{by:?} has not committed"))?;
        let mut next = state.clone();
        for (slot, reveal) in slots.iter().copied().zip(reveals.iter()) {
            if slot as usize >= SLOT_COUNT {
                return Err(format!("invalid slot {slot}"));
            }
            if reveal_array(&next, by)[slot as usize].is_some() {
                return Err(format!("{by:?} already revealed slot {slot}"));
            }
            if !verify_commitment(&commits[slot as usize], &reveal.value, &reveal.salt) {
                return Err("slot reveal does not match commitment".into());
            }
            reveal_array_mut(&mut next, by)[slot as usize] = Some(reveal.clone());
        }

        match next.phase {
            PokerPhase::OpenPrivateHoles
                if has_revealed(&next, Seat::A, &B_HOLE_SLOTS)
                    && has_revealed(&next, Seat::B, &A_HOLE_SLOTS) =>
            {
                next.hole_a = self.derive_hole_cards(&next, Seat::A, true);
                next.hole_b = self.derive_hole_cards(&next, Seat::B, true);
                self.post_antes_and_begin_street(&mut next)?;
            }
            PokerPhase::OpenPrivateHoles => {}
            PokerPhase::RevealFlop => {
                self.try_reveal_board_then_bet(&mut next, &FLOP_SLOTS, PokerPhase::FlopBet)?;
            }
            PokerPhase::RevealTurn => {
                self.try_reveal_board_then_bet(&mut next, &TURN_SLOTS, PokerPhase::TurnBet)?;
            }
            PokerPhase::RevealRiver => {
                self.try_reveal_board_then_bet(&mut next, &RIVER_SLOTS, PokerPhase::RiverBet)?;
            }
            PokerPhase::Showdown
                if has_revealed(&next, Seat::A, &A_HOLE_SLOTS)
                    && has_revealed(&next, Seat::B, &B_HOLE_SLOTS) =>
            {
                next.shown_a = true;
                next.shown_b = true;
                next.shown_hole_a = self.derive_hole_cards(&next, Seat::A, false);
                next.shown_hole_b = self.derive_hole_cards(&next, Seat::B, false);
                self.resolve_showdown(&mut next)?;
            }
            _ => {}
        }
        Ok(next)
    }

    fn apply_bet(
        &self,
        state: &PokerState,
        mv: &PokerMove,
        by: Seat,
    ) -> Result<PokerState, String> {
        if state.to_act != by {
            return Err(format!("not {by:?}'s turn to act"));
        }
        let mut next = state.clone();
        match mv {
            PokerMove::Check => self.apply_check(&mut next, by)?,
            PokerMove::Bet { amount } => self.apply_bet_or_raise(&mut next, by, *amount)?,
            PokerMove::Call => self.apply_call(&mut next, by)?,
            PokerMove::Fold => {
                next.folded_by = Some(by);
                self.resolve_fold(&mut next);
            }
            _ => return Err("expected betting move".into()),
        }
        Ok(next)
    }

    fn apply_check(&self, state: &mut PokerState, by: Seat) -> Result<(), String> {
        let current_max = state.street_bet_a.max(state.street_bet_b);
        if street_bet(state, by) != current_max {
            return Err("cannot check facing a bet".into());
        }
        mark_acted(state, by, true);
        self.after_bet_action(state)
    }

    fn apply_bet_or_raise(
        &self,
        state: &mut PokerState,
        by: Seat,
        amount: u64,
    ) -> Result<(), String> {
        if amount == 0 {
            return Err("bet amount must be positive".into());
        }
        let current = street_bet(state, by);
        let other = street_bet(state, by.other());
        let next = current + amount;
        if next <= other {
            return Err("bet must raise above opponent".into());
        }
        if amount > available_for(state, by) {
            return Err("bet exceeds the effective stack".into());
        }
        set_street_bet(state, by, next);
        add_total_bet(state, by, amount);
        mark_acted(state, by, true);
        mark_acted(state, by.other(), false);
        state.to_act = by.other();
        Ok(())
    }

    fn apply_call(&self, state: &mut PokerState, by: Seat) -> Result<(), String> {
        let diff = street_bet(state, by.other()).saturating_sub(street_bet(state, by));
        if diff == 0 {
            return Err("nothing to call".into());
        }
        if diff > available_for(state, by) {
            return Err("call exceeds the effective stack".into());
        }
        set_street_bet(state, by, street_bet(state, by) + diff);
        add_total_bet(state, by, diff);
        mark_acted(state, by, true);
        self.after_bet_action(state)
    }

    fn after_bet_action(&self, state: &mut PokerState) -> Result<(), String> {
        if state.street_bet_a == state.street_bet_b && state.acted_a && state.acted_b {
            self.advance_street(state)
        } else {
            state.to_act = state.to_act.other();
            Ok(())
        }
    }

    fn advance_street(&self, state: &mut PokerState) -> Result<(), String> {
        state.phase = match state.phase {
            PokerPhase::PreflopBet => PokerPhase::RevealFlop,
            PokerPhase::FlopBet => PokerPhase::RevealTurn,
            PokerPhase::TurnBet => PokerPhase::RevealRiver,
            PokerPhase::RiverBet => PokerPhase::Showdown,
            _ => return Err(format!("cannot advance from {:?}", state.phase)),
        };
        state.to_act = Seat::A;
        state.acted_a = false;
        state.acted_b = false;
        state.street_bet_a = 0;
        state.street_bet_b = 0;
        Ok(())
    }

    fn contested_amount(state: &PokerState) -> u64 {
        state.total_bet_a.min(state.total_bet_b)
    }

    fn settle(state: &mut PokerState, winner: Seat, amount: u64) {
        match winner {
            Seat::A => {
                let moved = amount.min(state.balance_b);
                state.balance_a += moved;
                state.balance_b -= moved;
            }
            Seat::B => {
                let moved = amount.min(state.balance_a);
                state.balance_b += moved;
                state.balance_a -= moved;
            }
        }
    }

    fn resolve_fold(&self, state: &mut PokerState) {
        let winner_seat = state.folded_by.expect("folded_by set").other();
        Self::settle(state, winner_seat, Self::contested_amount(state));
        let winner = if winner_seat == Seat::A {
            PokerWinner::A
        } else {
            PokerWinner::B
        };
        state.winner = Some(winner);
        state.last_result = Some(PokerHandResult {
            winner,
            reason: ResultReason::Fold,
            score_a: None,
            score_b: None,
            best_a: None,
            best_b: None,
            burned_a: Vec::new(),
            burned_b: Vec::new(),
        });
        state.phase = PokerPhase::HandOver;
    }

    fn resolve_showdown(&self, state: &mut PokerState) -> Result<(), String> {
        let board: BTreeSet<u8> = state.board.iter().copied().collect();
        let shown_a = state.shown_hole_a.clone().ok_or("missing shown A")?;
        let shown_b = state.shown_hole_b.clone().ok_or("missing shown B")?;
        let burned_a: Vec<_> = shown_a
            .iter()
            .copied()
            .filter(|c| board.contains(c))
            .collect();
        let burned_b: Vec<_> = shown_b
            .iter()
            .copied()
            .filter(|c| board.contains(c))
            .collect();
        let live_a: Vec<_> = shown_a.into_iter().filter(|c| !board.contains(c)).collect();
        let live_b: Vec<_> = shown_b.into_iter().filter(|c| !board.contains(c)).collect();
        let mut cards_a = live_a;
        cards_a.extend_from_slice(&state.board);
        let mut cards_b = live_b;
        cards_b.extend_from_slice(&state.board);
        let best_a = best_poker_hand(&cards_a)?;
        let best_b = best_poker_hand(&cards_b)?;
        let winner = if best_a.score > best_b.score {
            PokerWinner::A
        } else if best_b.score > best_a.score {
            PokerWinner::B
        } else {
            PokerWinner::Tie
        };
        match winner {
            PokerWinner::A => Self::settle(state, Seat::A, Self::contested_amount(state)),
            PokerWinner::B => Self::settle(state, Seat::B, Self::contested_amount(state)),
            PokerWinner::Tie => {}
        }
        state.winner = Some(winner);
        state.last_result = Some(PokerHandResult {
            winner,
            reason: ResultReason::Showdown,
            score_a: Some(best_a.score),
            score_b: Some(best_b.score),
            best_a: Some(best_a.cards),
            best_b: Some(best_b.cards),
            burned_a,
            burned_b,
        });
        state.phase = PokerPhase::HandOver;
        Ok(())
    }

    fn apply_next_hand(&self, state: &PokerState, mv: &PokerMove) -> Result<PokerState, String> {
        if !matches!(mv, PokerMove::NextHand) {
            return Err("expected next_hand".into());
        }
        let mut next = state.clone();
        next.hand_no += 1;
        let can_continue =
            next.hand_no < next.hand_cap && next.balance_a >= ANTE && next.balance_b >= ANTE;
        next.commit_a = None;
        next.commit_b = None;
        next.reveals_a = empty_reveals();
        next.reveals_b = empty_reveals();
        next.local_secrets_a = None;
        next.local_secrets_b = None;
        next.hole_a = None;
        next.hole_b = None;
        next.board.clear();
        next.board_slots.clear();
        next.board_counters.clear();
        next.total_bet_a = 0;
        next.total_bet_b = 0;
        next.street_bet_a = 0;
        next.street_bet_b = 0;
        next.to_act = Seat::A;
        next.acted_a = false;
        next.acted_b = false;
        next.folded_by = None;
        next.shown_a = false;
        next.shown_b = false;
        next.shown_hole_a = None;
        next.shown_hole_b = None;
        next.winner = None;
        next.last_result = None;
        next.phase = if can_continue {
            PokerPhase::Commit
        } else {
            PokerPhase::Done
        };
        Ok(next)
    }
}

impl Protocol for QuantumPoker {
    type State = PokerState;
    type Move = PokerMove;

    fn name(&self) -> &str {
        "quantum_poker.v2"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
        PokerState {
            phase: if ctx.initial.a >= ANTE && ctx.initial.b >= ANTE {
                PokerPhase::Commit
            } else {
                PokerPhase::Done
            },
            hand_no: 0,
            hand_cap: self.hand_cap,
            commit_a: None,
            commit_b: None,
            reveals_a: empty_reveals(),
            reveals_b: empty_reveals(),
            local_secrets_a: None,
            local_secrets_b: None,
            hole_a: None,
            hole_b: None,
            board: Vec::new(),
            board_slots: Vec::new(),
            board_counters: Vec::new(),
            total_bet_a: 0,
            total_bet_b: 0,
            street_bet_a: 0,
            street_bet_b: 0,
            to_act: Seat::A,
            acted_a: false,
            acted_b: false,
            folded_by: None,
            shown_a: false,
            shown_b: false,
            shown_hole_a: None,
            shown_hole_b: None,
            winner: None,
            last_result: None,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
            total: ctx.initial.sum(),
        }
    }

    fn apply_move(
        &self,
        state: &Self::State,
        mv: &Self::Move,
        by: Seat,
    ) -> Result<Self::State, ProtocolError> {
        let res = match state.phase {
            PokerPhase::Commit => self.apply_commit(state, mv, by),
            PokerPhase::OpenPrivateHoles
            | PokerPhase::RevealFlop
            | PokerPhase::RevealTurn
            | PokerPhase::RevealRiver
            | PokerPhase::Showdown => self.apply_reveal_slots(state, mv, by),
            PokerPhase::PreflopBet
            | PokerPhase::FlopBet
            | PokerPhase::TurnBet
            | PokerPhase::RiverBet => self.apply_bet(state, mv, by),
            PokerPhase::HandOver => self.apply_next_hand(state, mv),
            PokerPhase::Done => Err("no moves legal in phase done".into()),
        };
        res.map_err(ProtocolError)
    }

    fn encode_state(&self, state: &Self::State) -> Vec<u8> {
        encode_state(state)
    }

    fn balances(&self, state: &Self::State) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, state: &Self::State) -> bool {
        state.phase == PokerPhase::Done
    }

    fn sample_move(
        &self,
        state: &Self::State,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        match state.phase {
            PokerPhase::Commit => {
                if (seat == Seat::A && state.commit_a.is_some())
                    || (seat == Seat::B && state.commit_b.is_some())
                {
                    return None;
                }
                let secrets = random_slot_secrets(rng);
                Some(PokerMove::CommitSlots {
                    commitments: commit_slot_secrets(&secrets).ok()?,
                    local_secrets: Some(secrets),
                })
            }
            PokerPhase::OpenPrivateHoles
            | PokerPhase::RevealFlop
            | PokerPhase::RevealTurn
            | PokerPhase::RevealRiver
            | PokerPhase::Showdown => {
                let slots = expected_quantum_poker_reveal_slots(state, seat).ok()?;
                let secrets = local_secret_array(state, seat)?;
                let reveals: Option<Vec<_>> = slots
                    .iter()
                    .map(|&slot| secrets.get(slot as usize)?.clone())
                    .collect();
                Some(PokerMove::RevealSlots {
                    slots,
                    reveals: reveals?,
                })
            }
            PokerPhase::PreflopBet
            | PokerPhase::FlopBet
            | PokerPhase::TurnBet
            | PokerPhase::RiverBet => {
                if state.to_act != seat {
                    return None;
                }
                let diff = street_bet(state, seat.other()).saturating_sub(street_bet(state, seat));
                if diff > 0 {
                    return Some(if rng() < 0.85 {
                        PokerMove::Call
                    } else {
                        PokerMove::Fold
                    });
                }
                let available = balance(state, seat).saturating_sub(total_bet(state, seat));
                if available > 0 && rng() < 0.35 {
                    let cap = available.min(200);
                    let amount = 1 + (rng() * cap as f64).floor() as u64;
                    return Some(PokerMove::Bet { amount });
                }
                Some(PokerMove::Check)
            }
            PokerPhase::HandOver => (seat == Seat::A).then_some(PokerMove::NextHand),
            PokerPhase::Done => None,
        }
    }
}

fn random_bytes(n: usize, rng: &mut dyn FnMut() -> f64) -> Vec<u8> {
    (0..n).map(|_| (rng() * 256.0) as u8).collect()
}

fn random_slot_secrets(rng: &mut dyn FnMut() -> f64) -> Vec<SlotSecret> {
    (0..SLOT_COUNT)
        .map(|_| SlotSecret {
            value: random_bytes(32, rng),
            salt: random_bytes(16, rng),
        })
        .collect()
}

fn push_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&u64_to_be_bytes(value));
}

fn encode_bytes(out: &mut Vec<u8>, bytes: Option<&[u8]>) {
    let bytes = bytes.unwrap_or(&[]);
    push_u64(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn encode_byte_list(out: &mut Vec<u8>, items: Option<&[[u8; 32]]>) {
    push_u64(out, items.map_or(0, |items| items.len()) as u64);
    if let Some(items) = items {
        for item in items {
            encode_bytes(out, Some(item));
        }
    }
}

fn encode_cards(out: &mut Vec<u8>, cards: Option<&[u8]>) {
    encode_bytes(out, cards);
}

fn encode_numbers(out: &mut Vec<u8>, nums: &[u64]) {
    push_u64(out, nums.len() as u64);
    for &n in nums {
        push_u64(out, n);
    }
}

fn encode_reveal_slots(out: &mut Vec<u8>, slots: &[Option<SlotReveal>]) {
    push_u64(out, slots.len() as u64);
    for reveal in slots {
        if let Some(reveal) = reveal {
            out.push(1);
            encode_bytes(out, Some(&reveal.value));
            encode_bytes(out, Some(&reveal.salt));
        } else {
            out.push(0);
        }
    }
}

pub fn encode_state(state: &PokerState) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(DOMAIN);
    out.push(state.phase.code());
    push_u64(&mut out, state.hand_no);
    push_u64(&mut out, state.hand_cap);
    push_u64(&mut out, state.balance_a);
    push_u64(&mut out, state.balance_b);
    push_u64(&mut out, state.total_bet_a);
    push_u64(&mut out, state.total_bet_b);
    push_u64(&mut out, state.street_bet_a);
    push_u64(&mut out, state.street_bet_b);
    out.extend_from_slice(&[
        if state.to_act == Seat::A { 0 } else { 1 },
        if state.acted_a { 1 } else { 0 },
        if state.acted_b { 1 } else { 0 },
        state
            .folded_by
            .map_or(0, |p| if p == Seat::A { 1 } else { 2 }),
        if state.shown_a { 1 } else { 0 },
        if state.shown_b { 1 } else { 0 },
        state.winner.map_or(0, PokerWinner::code),
        state.last_result.as_ref().map_or(0, |r| r.reason.code()),
    ]);
    encode_byte_list(&mut out, state.commit_a.as_deref());
    encode_byte_list(&mut out, state.commit_b.as_deref());
    encode_reveal_slots(&mut out, &state.reveals_a);
    encode_reveal_slots(&mut out, &state.reveals_b);
    encode_cards(&mut out, Some(&state.board));
    let board_slots: Vec<u64> = state.board_slots.iter().map(|&n| n as u64).collect();
    encode_numbers(&mut out, &board_slots);
    encode_numbers(&mut out, &state.board_counters);
    encode_cards(
        &mut out,
        if state.shown_a {
            state.shown_hole_a.as_deref()
        } else {
            None
        },
    );
    encode_cards(
        &mut out,
        if state.shown_b {
            state.shown_hole_b.as_deref()
        } else {
            None
        },
    );
    push_u64(
        &mut out,
        state
            .last_result
            .as_ref()
            .and_then(|r| r.score_a)
            .unwrap_or(0),
    );
    push_u64(
        &mut out,
        state
            .last_result
            .as_ref()
            .and_then(|r| r.score_b)
            .unwrap_or(0),
    );
    encode_cards(
        &mut out,
        state.last_result.as_ref().and_then(|r| r.best_a.as_deref()),
    );
    encode_cards(
        &mut out,
        state.last_result.as_ref().and_then(|r| r.best_b.as_deref()),
    );
    encode_cards(
        &mut out,
        state.last_result.as_ref().map(|r| r.burned_a.as_slice()),
    );
    encode_cards(
        &mut out,
        state.last_result.as_ref().map(|r| r.burned_b.as_slice()),
    );
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BestHand {
    pub score: u64,
    pub cards: Vec<u8>,
}

fn validate_cards(cards: &[u8]) -> Result<(), String> {
    if cards.iter().any(|&card| card > 51) {
        return Err("card out of range 0..51".into());
    }
    Ok(())
}

pub fn evaluate5(cards: &[u8]) -> Result<u64, String> {
    if cards.len() != 5 {
        return Err("evaluate5 needs exactly 5 cards".into());
    }
    validate_cards(cards)?;
    let mut ranks: Vec<u8> = cards.iter().map(|c| c % 13).collect();
    ranks.sort_by(|a, b| b.cmp(a));
    let suits: Vec<u8> = cards.iter().map(|c| c / 13).collect();
    let flush = suits.iter().all(|suit| *suit == suits[0]);

    let mut counts = BTreeMap::<u8, u8>::new();
    for rank in &ranks {
        *counts.entry(*rank).or_default() += 1;
    }
    let mut groups: Vec<(u8, u8)> = counts
        .into_iter()
        .map(|(rank, count)| (count, rank))
        .collect();
    groups.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));

    let mut distinct = ranks.clone();
    distinct.dedup();
    let mut straight = false;
    let mut straight_high = 0u8;
    if distinct.len() == 5 {
        if distinct[0] - distinct[4] == 4 {
            straight = true;
            straight_high = distinct[0];
        } else if distinct == [12, 3, 2, 1, 0] {
            straight = true;
            straight_high = 3;
        }
    }

    let category = if groups[0].0 == 5 {
        9
    } else if straight && flush {
        8
    } else if groups[0].0 == 4 {
        7
    } else if groups[0].0 == 3 && groups.get(1).is_some_and(|g| g.0 == 2) {
        6
    } else if flush {
        5
    } else if straight {
        4
    } else if groups[0].0 == 3 {
        3
    } else if groups[0].0 == 2 && groups.get(1).is_some_and(|g| g.0 == 2) {
        2
    } else if groups[0].0 == 2 {
        1
    } else {
        0
    };
    let tiebreakers: Vec<u8> = if straight {
        vec![straight_high]
    } else {
        groups.iter().map(|g| g.1).collect()
    };
    let mut score = category;
    for i in 0..5 {
        score = score * 13 + *tiebreakers.get(i).unwrap_or(&0) as u64;
    }
    Ok(score)
}

pub fn best_poker_hand(cards: &[u8]) -> Result<BestHand, String> {
    if cards.len() < 5 {
        return Err("bestPokerHand needs at least 5 cards".into());
    }
    if cards.len() > 7 {
        return Err("bestPokerHand supports at most 7 cards".into());
    }
    validate_cards(cards)?;
    let mut best: Option<BestHand> = None;
    for a in 0..cards.len() - 4 {
        for b in a + 1..cards.len() - 3 {
            for c in b + 1..cards.len() - 2 {
                for d in c + 1..cards.len() - 1 {
                    for e in d + 1..cards.len() {
                        let hand = vec![cards[a], cards[b], cards[c], cards[d], cards[e]];
                        let score = evaluate5(&hand)?;
                        if best.as_ref().map_or(true, |best| score > best.score) {
                            best = Some(BestHand { score, cards: hand });
                        }
                    }
                }
            }
        }
    }
    Ok(best.expect("at least one combination"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> TunnelContext {
        TunnelContext {
            tunnel_id: "0xpoker".into(),
            initial: Balances { a: 1000, b: 1000 },
            seat: Seat::A,
        }
    }

    fn secrets(byte: u8) -> Vec<SlotSecret> {
        (0..SLOT_COUNT)
            .map(|i| SlotSecret {
                value: vec![byte, i as u8],
                salt: vec![byte; 16],
            })
            .collect()
    }

    #[test]
    fn initial_state_and_encoding_use_v2_domain() {
        let protocol = QuantumPoker::default();
        let state = protocol.initial_state(&ctx());
        assert_eq!(protocol.name(), "quantum_poker.v2");
        assert_eq!(state.phase, PokerPhase::Commit);
        assert!(protocol
            .encode_state(&state)
            .starts_with(b"sui_tunnel::proto::quantum_poker.v2"));
    }

    #[test]
    fn commit_reveal_private_holes_posts_antes() {
        let protocol = QuantumPoker::default();
        let mut state = protocol.initial_state(&ctx());
        let a = secrets(1);
        let b = secrets(2);
        state = protocol
            .apply_move(
                &state,
                &PokerMove::CommitSlots {
                    commitments: commit_slot_secrets(&a).unwrap(),
                    local_secrets: Some(a.clone()),
                },
                Seat::A,
            )
            .unwrap();
        state = protocol
            .apply_move(
                &state,
                &PokerMove::CommitSlots {
                    commitments: commit_slot_secrets(&b).unwrap(),
                    local_secrets: Some(b.clone()),
                },
                Seat::B,
            )
            .unwrap();
        assert_eq!(state.phase, PokerPhase::OpenPrivateHoles);
        state = protocol
            .apply_move(
                &state,
                &PokerMove::RevealSlots {
                    slots: vec![2, 3],
                    reveals: vec![a[2].clone(), a[3].clone()],
                },
                Seat::A,
            )
            .unwrap();
        state = protocol
            .apply_move(
                &state,
                &PokerMove::RevealSlots {
                    slots: vec![0, 1],
                    reveals: vec![b[0].clone(), b[1].clone()],
                },
                Seat::B,
            )
            .unwrap();
        assert_eq!(state.phase, PokerPhase::PreflopBet);
        assert_eq!(state.total_bet_a, ANTE);
        assert_eq!(state.total_bet_b, ANTE);
    }

    #[test]
    fn hand_evaluator_orders_flush_above_straight() {
        let straight = evaluate5(&[0, 14, 28, 42, 4]).unwrap();
        let flush = evaluate5(&[0, 2, 4, 6, 8]).unwrap();
        assert!(flush > straight);
    }

    // Locks the single-sample `mod 52` derivation. The same fixed reveal bytes and
    // expected cards appear in the TS `deriveQuantumCard` parity golden test
    // (quantumPoker.test.ts), so any TS/Rust divergence fails one side.
    #[test]
    fn derive_quantum_card_matches_ts_engine_on_fixed_reveals() {
        let a = SlotReveal {
            value: vec![1, 2, 3, 4],
            salt: vec![5, 6, 7, 8],
        };
        let b = SlotReveal {
            value: vec![9, 10, 11],
            salt: vec![12, 13],
        };
        assert_eq!(derive_quantum_card(&a, &b, 0), 50);
        assert_eq!(derive_quantum_card(&a, &b, 1), 1);
        assert_eq!(derive_quantum_card(&a, &b, 2), 18);
    }

    #[test]
    fn derive_quantum_card_stays_within_deck_range() {
        for x in 0..40u8 {
            for y in 0..40u8 {
                let a = SlotReveal {
                    value: vec![x, x.wrapping_add(1)],
                    salt: vec![x; 8],
                };
                let b = SlotReveal {
                    value: vec![y, y.wrapping_add(2)],
                    salt: vec![y; 8],
                };
                assert!(derive_quantum_card(&a, &b, 0) < 52);
            }
        }
    }
}
