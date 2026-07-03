import { otherParty } from "./Protocol";
import type { Party } from "./Protocol";
import {
  bestPokerHand,
  type PokerMove,
  type PokerState,
  QuantumPokerSeatDriver,
} from "./quantumPoker";

export type QuantumPokerPersona =
  | "tight"
  | "loose"
  | "aggressive"
  | "passive"
  | "balanced";

export type QuantumPokerDifficulty = "easy" | "normal" | "hard" | "adaptive";

export interface QuantumPokerBotProfile {
  name: string;
  persona: QuantumPokerPersona;
  difficulty?: QuantumPokerDifficulty;
  adaptiveModifier?: number;
}

interface StrategyTuning {
  callThreshold: number;
  raiseThreshold: number;
  semiBluffThreshold: number;
}

interface StrengthProfile {
  strength: number;
  potOdds: number;
  pressure: number;
  pot: bigint;
  callAmount: bigint;
  available: bigint;
  preflop: boolean;
  river: boolean;
  premiumValue: boolean;
  strongDraw: boolean;
}

export const NARI_PROFILE: QuantumPokerBotProfile = {
  name: "Nari",
  persona: "tight",
  difficulty: "adaptive",
};

export const JULES_PROFILE: QuantumPokerBotProfile = {
  name: "Jules",
  persona: "loose",
  difficulty: "adaptive",
};

export const DEFAULT_QUANTUM_POKER_BOT_PROFILES: readonly QuantumPokerBotProfile[] =
  [
    NARI_PROFILE,
    JULES_PROFILE,
    { name: "Mika", persona: "aggressive", difficulty: "adaptive" },
    { name: "Sol", persona: "passive", difficulty: "adaptive" },
    { name: "Vale", persona: "balanced", difficulty: "adaptive" },
    { name: "Kai", persona: "balanced", difficulty: "adaptive" },
  ];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function ownStreetBet(s: PokerState, by: Party): bigint {
  return by === "A" ? s.streetBetA : s.streetBetB;
}

function ownTotalBet(s: PokerState, by: Party): bigint {
  return by === "A" ? s.totalBetA : s.totalBetB;
}

function ownBalance(s: PokerState, by: Party): bigint {
  return by === "A" ? s.balanceA : s.balanceB;
}

function amountRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  return Number(numerator) / Number(denominator);
}

function rankValue(card: number): number {
  return (card % 13) + 2;
}

function suited(a: number, b: number): boolean {
  return Math.floor(a / 13) === Math.floor(b / 13);
}

function preflopStrength(holes: number[]): number {
  if (holes.length < 2) return 0.42;
  const high = Math.max(rankValue(holes[0]), rankValue(holes[1]));
  const low = Math.min(rankValue(holes[0]), rankValue(holes[1]));
  const gap = high - low;
  const isSuited = suited(holes[0], holes[1]);
  const suitedBoost = isSuited ? 0.045 : 0;

  if (high === low) return clamp01(0.42 + high / 28);
  if (high === 14) {
    const aceStrength =
      low >= 13
        ? 0.78
        : low === 12
        ? 0.68
        : low === 11
        ? 0.62
        : low === 10
        ? 0.56
        : 0.32 + low / 45;
    return clamp01(aceStrength + suitedBoost);
  }
  if (high === 13 && low >= 10) {
    return clamp01(
      (low === 12 ? 0.66 : low === 11 ? 0.59 : 0.52) + suitedBoost
    );
  }
  if (high === 12 && low >= 10) {
    return clamp01((low === 11 ? 0.57 : 0.49) + suitedBoost);
  }

  const connector =
    gap === 1 ? 0.08 : gap === 2 ? 0.04 : Math.max(-0.16, -gap * 0.022);
  return clamp01(0.24 + high / 62 + low / 82 + connector + suitedBoost);
}

function postflopStrength(holes: number[], board: number[]): number {
  const liveHoles = holes.filter((card) => !board.includes(card));
  const pool = [...liveHoles, ...board];
  if (pool.length < 5) return preflopStrength(holes);

  const best = bestPokerHand(pool.slice(0, 7));
  const category = Math.floor(best.score / 13 ** 5);
  const categoryStrength = category / 9;
  const highCardLift = liveHoles.some((card) => rankValue(card) >= 12)
    ? 0.04
    : 0;
  return clamp01(categoryStrength * 0.86 + highCardLift);
}

function estimateStrongDraw(holes: number[], board: number[]): boolean {
  if (board.length < 3 || board.length >= 5) return false;
  const liveHoles = holes.filter((card) => !board.includes(card));
  const cards = [...liveHoles, ...board];
  const suits = new Map<number, number>();
  for (const card of cards) {
    const suit = Math.floor(card / 13);
    suits.set(suit, (suits.get(suit) ?? 0) + 1);
  }
  if ([...suits.values()].some((count) => count >= 4)) return true;

  const ranks = new Set(cards.map(rankValue));
  if (ranks.has(14)) ranks.add(1);
  for (let start = 1; start <= 10; start++) {
    let present = 0;
    for (let value = start; value < start + 5; value++) {
      if (ranks.has(value)) present++;
    }
    if (present >= 4) return true;
  }
  return false;
}

function difficultyStrategyTuning(
  difficulty: QuantumPokerDifficulty,
  adaptiveModifier: number
): StrategyTuning {
  switch (difficulty) {
    case "easy":
      return {
        callThreshold: 0.05,
        raiseThreshold: 0.08,
        semiBluffThreshold: 0.08,
      };
    case "hard":
      return {
        callThreshold: -0.035,
        raiseThreshold: -0.035,
        semiBluffThreshold: -0.035,
      };
    case "adaptive":
      return {
        callThreshold: adaptiveModifier * -0.012,
        raiseThreshold: adaptiveModifier * -0.014,
        semiBluffThreshold: adaptiveModifier * -0.014,
      };
    case "normal":
      return { callThreshold: 0, raiseThreshold: 0, semiBluffThreshold: 0 };
  }
}

function personaStrategyTuning(persona: QuantumPokerPersona): StrategyTuning {
  switch (persona) {
    case "aggressive":
      return {
        callThreshold: -0.01,
        raiseThreshold: -0.025,
        semiBluffThreshold: -0.02,
      };
    case "loose":
      return {
        callThreshold: -0.03,
        raiseThreshold: -0.005,
        semiBluffThreshold: -0.005,
      };
    case "passive":
      return {
        callThreshold: -0.005,
        raiseThreshold: 0.035,
        semiBluffThreshold: 0.04,
      };
    case "tight":
      return {
        callThreshold: 0.025,
        raiseThreshold: 0.025,
        semiBluffThreshold: 0.03,
      };
    case "balanced":
      return { callThreshold: 0, raiseThreshold: 0, semiBluffThreshold: 0 };
  }
}

export function resolveQuantumPokerStrategyTuning(
  profile: QuantumPokerBotProfile
): StrategyTuning {
  const difficulty = difficultyStrategyTuning(
    profile.difficulty ?? "adaptive",
    profile.adaptiveModifier ?? 0
  );
  const persona = personaStrategyTuning(profile.persona);
  return {
    callThreshold: difficulty.callThreshold + persona.callThreshold,
    raiseThreshold: difficulty.raiseThreshold + persona.raiseThreshold,
    semiBluffThreshold:
      difficulty.semiBluffThreshold + persona.semiBluffThreshold,
  };
}

function estimateStrengthProfile(
  state: PokerState,
  party: Party,
  holes: number[] | null
): StrengthProfile {
  const own = ownStreetBet(state, party);
  const other = ownStreetBet(state, otherParty(party));
  const callAmount = other > own ? other - own : 0n;
  // Effective stack: the protocol caps bets at the shorter balance (heads-up), so the surplus
  // of the larger stack is unbettable. Mirror `QuantumPokerProtocol.availableFor`.
  const effectiveStack = state.balanceA < state.balanceB ? state.balanceA : state.balanceB;
  const available = effectiveStack - ownTotalBet(state, party);
  const pot = state.totalBetA + state.totalBetB;
  const safeHoles = holes ?? [];
  const preflop = state.board.length < 3;
  const river = state.board.length >= 5;
  const strength = preflop
    ? preflopStrength(safeHoles)
    : postflopStrength(safeHoles, state.board);
  const strongDraw = estimateStrongDraw(safeHoles, state.board);

  return {
    strength,
    potOdds: amountRatio(callAmount, pot + callAmount),
    pressure: amountRatio(callAmount, available + callAmount),
    pot,
    callAmount,
    available,
    preflop,
    river,
    premiumValue: preflop
      ? strength >= 0.84
      : strength >= (river ? 0.62 : 0.58),
    strongDraw,
  };
}

function shouldCall(
  profile: StrengthProfile,
  tuning: StrategyTuning,
  roll: number
): boolean {
  if (profile.callAmount <= 0n) return false;
  if (profile.callAmount > profile.available) return false;
  if (!profile.preflop && profile.strongDraw) {
    const drawEquity = profile.river ? 0 : 0.18;
    if (profile.potOdds <= drawEquity - tuning.callThreshold + roll * 0.015) {
      return true;
    }
  }
  const threshold = profile.river
    ? profile.potOdds +
      0.08 +
      profile.pressure * 0.16 +
      tuning.callThreshold -
      roll * 0.025
    : profile.preflop
    ? 0.38 + profile.pressure * 0.5 + tuning.callThreshold - roll * 0.035
    : profile.potOdds +
      0.055 +
      profile.pressure * 0.08 +
      tuning.callThreshold -
      roll * 0.025;
  return profile.strength >= threshold;
}

function shouldBet(
  profile: StrengthProfile,
  tuning: StrategyTuning,
  roll: number
): boolean {
  if (profile.available <= 0n) return false;
  if (profile.preflop) {
    return profile.strength >= 0.72 + tuning.raiseThreshold - roll * 0.025;
  }
  // Riskier: value-bet a wider range (was 0.34 / 0.42-river) and semi-bluff draws sooner (was 0.52),
  // so a > 50%-equity hand keeps betting instead of checking — more off-chain action per street.
  const valueThreshold = profile.river ? 0.38 : 0.3;
  const valueBet =
    profile.strength >= valueThreshold + tuning.raiseThreshold - roll * 0.02;
  const semiBluff =
    profile.strongDraw &&
    profile.strength >= 0.48 + tuning.semiBluffThreshold - roll * 0.02;
  return valueBet || semiBluff;
}

function betAmount(profile: StrengthProfile): bigint {
  const pot = profile.pot > 0n ? profile.pot : 100n;
  // Riskier sizing: a made hand with > 50% equity bets bigger to build the pot — more co-signed
  // call/raise rounds → more off-chain tx. Premium overbets; draws stay pot-controlled. The deep
  // 5000 stake (QUANTUM_POKER_STAKE) absorbs the extra variance without an early all-in.
  const fraction = profile.premiumValue
    ? 0.9
    : profile.strength >= 0.5
    ? 0.7
    : profile.strongDraw
    ? 0.45
    : 0.5;
  const target = BigInt(Math.max(50, Math.floor(Number(pot) * fraction)));
  const capped = target < profile.available ? target : profile.available;
  return capped > 0n ? capped : 0n;
}

export class QuantumPokerPersonaDriver extends QuantumPokerSeatDriver {
  readonly profile: QuantumPokerBotProfile;

  constructor(party: Party, profile: QuantumPokerBotProfile) {
    super(party);
    this.profile = profile;
  }

  override chooseMove(state: PokerState, rng: () => number): PokerMove | null {
    switch (state.phase) {
      case "commit":
        return this.makeCommitMove(state, rng);
      case "open_private_holes":
      case "reveal_flop":
      case "reveal_turn":
      case "reveal_river":
      case "showdown":
        return this.makeRevealMove(state);
      case "preflop_bet":
      case "flop_bet":
      case "turn_bet":
      case "river_bet": {
        if (state.toAct !== this.party) return null;
        const tuning = resolveQuantumPokerStrategyTuning(this.profile);
        const strength = estimateStrengthProfile(
          state,
          this.party,
          this.knownHoleCards(state)
        );
        const roll = rng();
        if (strength.callAmount > 0n) {
          return shouldCall(strength, tuning, roll)
            ? { kind: "call" }
            : { kind: "fold" };
        }
        if (shouldBet(strength, tuning, roll)) {
          const amount = betAmount(strength);
          if (amount > 0n) return { kind: "bet", amount };
        }
        return { kind: "check" };
      }
      case "hand_over":
        return this.party === "A" ? { kind: "next_hand" } : null;
      default:
        return null;
    }
  }
}
