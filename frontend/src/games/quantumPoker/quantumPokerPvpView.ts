/**
 * Render-ready PvP view for Quantum Poker — the snapshot the worker's
 * `PokerPvpController.deriveView` produces and the UI adapter maps into the legacy
 * `PvpQuantumPoker` shape. All fields are plain / structured-cloneable (bigints serialise
 * natively via Comlink's `transfer`).
 *
 * Why a separate file: avoids a cycle between the spec (worker-only) and the
 * React adapter (main-only); both import this leaf module.
 */
import type { PokerState } from "sui-tunnel-ts/protocol/quantumPoker";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

/** Legal betting actions for the UI buttons (mirrors the legacy `PvpPokerLegal`). */
export interface PokerPvpLegal {
  canCheck: boolean;
  canCall: boolean;
  callAmount: bigint;
  canBet: boolean;
  minBet: bigint;
  maxBet: bigint;
}

/** The snapshot the PvP hub's worker emits for a Quantum Poker match. */
export interface PokerPvpView {
  /** The full public state (the `QuantumPokerTable` component reads almost every field). */
  state: PokerState;
  /** This seat's two hole cards (populated after `open_private_holes` reveal). */
  myHole: number[] | null;
  /** True when it's this seat's BETTING turn (a UI action phase). */
  myTurnToBet: boolean;
  /** Legal actions when `myTurnToBet`; null otherwise. */
  legal: PokerPvpLegal | null;
  /** This seat asked to end early (stop dealing after the current hand). */
  endRequested: boolean;
}

/** Derive the `PokerPvpLegal` from public state for `self`. */
export function derivePokerLegal(s: PokerState, self: Party): PokerPvpLegal {
  const other: Party = self === "A" ? "B" : "A";
  const myStreet = self === "A" ? s.streetBetA : s.streetBetB;
  const oppStreet = other === "A" ? s.streetBetA : s.streetBetB;
  const diff = oppStreet > myStreet ? oppStreet - myStreet : 0n;
  const effStack = s.balanceA < s.balanceB ? s.balanceA : s.balanceB;
  const myTotal = self === "A" ? s.totalBetA : s.totalBetB;
  const available = effStack - myTotal > 0n ? effStack - myTotal : 0n;
  const minBet = (diff > 0n ? diff : 0n) + 1n;
  return {
    canCheck: diff === 0n,
    canCall: diff > 0n && available >= diff,
    callAmount: diff,
    canBet: available >= minBet,
    minBet,
    maxBet: available,
  };
}
