/**
 * Quantum Poker: heads-up, dealerless poker over a Sui Tunnel.
 *
 * The hand uses nine independent two-party randomness slots:
 *   0,1 = A holes; 2,3 = B holes; 4,5,6 = flop; 7 = turn; 8 = river.
 *
 * Each slot is a commit-reveal from both parties. A card is derived by combining the
 * two reveals into a seed and reducing it modulo 52 (the whitepaper's
 * `Card = Random() mod 52`) — one hash per card, no shuffle and no hidden dealer deck.
 * Board cards are de-duplicated by re-deriving the slot with a counter; hidden cards
 * may duplicate each other or the board, and hidden cards equal to board cards are
 * burned at showdown.
 */

import { bytesEqual, concatBytes } from "../core/bytes";
import {
  combineReveals,
  computeCommitment,
  verifyCommitment,
} from "../core/commitment";
import { blake2b256 } from "../core/crypto";
import { u64ToBeBytes } from "../core/wire";
import type { Balances, Party, Protocol, ProtocolContext } from "./Protocol";
import { otherParty, protocolDomain } from "./Protocol";

const DOMAIN = protocolDomain("quantum_poker.v2");
const ANTE = 50n;
const DEFAULT_HAND_CAP = 1000n;
const SLOT_COUNT = 9;
const EMPTY = new Uint8Array(0);

const A_HOLE_SLOTS = [0, 1] as const;
const B_HOLE_SLOTS = [2, 3] as const;
const FLOP_SLOTS = [4, 5, 6] as const;
const TURN_SLOTS = [7] as const;
const RIVER_SLOTS = [8] as const;

export type PokerPhase =
  | "commit"
  | "open_private_holes"
  | "preflop_bet"
  | "reveal_flop"
  | "flop_bet"
  | "reveal_turn"
  | "turn_bet"
  | "reveal_river"
  | "river_bet"
  | "showdown"
  | "hand_over"
  | "done";

export type PokerWinner = Party | "tie";

export interface SlotReveal {
  value: Uint8Array;
  salt: Uint8Array;
}

export type SlotSecret = SlotReveal;

export interface PokerHandResult {
  winner: PokerWinner;
  reason: "showdown" | "fold";
  scoreA: number | null;
  scoreB: number | null;
  bestA: number[] | null;
  bestB: number[] | null;
  burnedA: number[];
  burnedB: number[];
}

export interface PokerState {
  phase: PokerPhase;
  handNo: bigint;
  handCap: bigint;

  commitA: Uint8Array[] | null;
  commitB: Uint8Array[] | null;
  revealsA: (SlotReveal | null)[];
  revealsB: (SlotReveal | null)[];

  /** Local-only private state. Never encoded into the signed shared state. */
  localSecretsA: (SlotSecret | null)[] | null;
  /** Local-only private state. Never encoded into the signed shared state. */
  localSecretsB: (SlotSecret | null)[] | null;

  /** Local-only hole knowledge before showdown. Never encoded until shown. */
  holeA: number[] | null;
  /** Local-only hole knowledge before showdown. Never encoded until shown. */
  holeB: number[] | null;

  board: number[];
  boardSlots: number[];
  boardCounters: number[];

  totalBetA: bigint;
  totalBetB: bigint;
  streetBetA: bigint;
  streetBetB: bigint;
  toAct: Party;
  actedA: boolean;
  actedB: boolean;
  foldedBy: Party | null;

  shownA: boolean;
  shownB: boolean;
  shownHoleA: number[] | null;
  shownHoleB: number[] | null;
  winner: PokerWinner | null;
  lastResult: PokerHandResult | null;

  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
}

export type PokerMove =
  | {
      kind: "commit_slots";
      commitments: Uint8Array[];
      /**
       * Local-only seat secrets. A real relay codec MUST omit this field so the
       * counterparty receives only commitments.
       */
      localSecrets?: SlotSecret[];
    }
  | { kind: "reveal_slots"; slots: number[]; reveals: SlotReveal[] }
  | { kind: "bet"; amount: bigint }
  | { kind: "check" }
  | { kind: "call" }
  | { kind: "fold" }
  | { kind: "forfeit" }
  | { kind: "next_hand" };

const PHASE_CODE: Record<PokerPhase, number> = {
  commit: 0,
  open_private_holes: 1,
  preflop_bet: 2,
  reveal_flop: 3,
  flop_bet: 4,
  reveal_turn: 5,
  turn_bet: 6,
  reveal_river: 7,
  river_bet: 8,
  showdown: 9,
  hand_over: 10,
  done: 11,
};

function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function copyReveal(reveal: SlotReveal): SlotReveal {
  return { value: copyBytes(reveal.value), salt: copyBytes(reveal.salt) };
}

function emptyRevealSlots(): (SlotReveal | null)[] {
  return Array.from({ length: SLOT_COUNT }, () => null);
}

function cloneRevealSlots(slots: (SlotReveal | null)[]): (SlotReveal | null)[] {
  return slots.map((r) => (r ? copyReveal(r) : null));
}

function cloneSecretSlots(
  slots: (SlotSecret | null)[] | null
): (SlotSecret | null)[] | null {
  return slots ? slots.map((r) => (r ? copyReveal(r) : null)) : null;
}

function cloneState(s: PokerState): PokerState {
  return {
    ...s,
    commitA: s.commitA ? s.commitA.map(copyBytes) : null,
    commitB: s.commitB ? s.commitB.map(copyBytes) : null,
    revealsA: cloneRevealSlots(s.revealsA),
    revealsB: cloneRevealSlots(s.revealsB),
    localSecretsA: cloneSecretSlots(s.localSecretsA),
    localSecretsB: cloneSecretSlots(s.localSecretsB),
    holeA: s.holeA ? s.holeA.slice() : null,
    holeB: s.holeB ? s.holeB.slice() : null,
    board: s.board.slice(),
    boardSlots: s.boardSlots.slice(),
    boardCounters: s.boardCounters.slice(),
    shownHoleA: s.shownHoleA ? s.shownHoleA.slice() : null,
    shownHoleB: s.shownHoleB ? s.shownHoleB.slice() : null,
    lastResult: s.lastResult
      ? {
          ...s.lastResult,
          bestA: s.lastResult.bestA ? s.lastResult.bestA.slice() : null,
          bestB: s.lastResult.bestB ? s.lastResult.bestB.slice() : null,
          burnedA: s.lastResult.burnedA.slice(),
          burnedB: s.lastResult.burnedB.slice(),
        }
      : null,
  };
}

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new Error(`invalid slot ${slot}`);
  }
}

function sameNumberSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const aa = [...a].sort((x, y) => x - y);
  const bb = [...b].sort((x, y) => x - y);
  return aa.every((v, i) => v === bb[i]);
}

function validateCommitments(commitments: Uint8Array[]): Uint8Array[] {
  if (commitments.length !== SLOT_COUNT) {
    throw new Error(`expected ${SLOT_COUNT} slot commitments`);
  }
  return commitments.map((c, i) => {
    if (c.length !== 32) throw new Error(`commitment ${i} must be 32 bytes`);
    return copyBytes(c);
  });
}

function revealArrayFor(s: PokerState, party: Party): (SlotReveal | null)[] {
  return party === "A" ? s.revealsA : s.revealsB;
}

function localSecretArrayFor(
  s: PokerState,
  party: Party
): (SlotSecret | null)[] | null {
  return party === "A" ? s.localSecretsA : s.localSecretsB;
}

function commitArrayFor(s: PokerState, party: Party): Uint8Array[] | null {
  return party === "A" ? s.commitA : s.commitB;
}

function hasRevealed(
  s: PokerState,
  party: Party,
  slots: readonly number[]
): boolean {
  const reveals = revealArrayFor(s, party);
  return slots.every((slot) => reveals[slot] !== null);
}

export function expectedQuantumPokerRevealSlots(
  s: PokerState,
  by: Party
): number[] {
  const revealIfMissing = (slots: readonly number[]) =>
    slots.filter((slot) => !revealArrayFor(s, by)[slot]);
  switch (s.phase) {
    case "open_private_holes":
      return revealIfMissing(by === "A" ? B_HOLE_SLOTS : A_HOLE_SLOTS);
    case "reveal_flop":
      return revealIfMissing(FLOP_SLOTS);
    case "reveal_turn":
      return revealIfMissing(TURN_SLOTS);
    case "reveal_river":
      return revealIfMissing(RIVER_SLOTS);
    case "showdown":
      return revealIfMissing(by === "A" ? A_HOLE_SLOTS : B_HOLE_SLOTS);
    default:
      throw new Error(`no slot reveal legal in phase ${s.phase}`);
  }
}

function u64(value: bigint | number): Uint8Array {
  return u64ToBeBytes(value);
}

function encodeBytes(bytes: Uint8Array | null): Uint8Array[] {
  const b = bytes ?? EMPTY;
  return [u64(b.length), b];
}

function encodeByteList(items: Uint8Array[] | null): Uint8Array[] {
  const out: Uint8Array[] = [u64(items?.length ?? 0)];
  if (items) {
    for (const item of items) out.push(...encodeBytes(item));
  }
  return out;
}

function encodeCards(cards: number[] | null): Uint8Array[] {
  const b = cards ? Uint8Array.from(cards) : EMPTY;
  return encodeBytes(b);
}

function encodeNumbers(nums: number[]): Uint8Array[] {
  const out: Uint8Array[] = [u64(nums.length)];
  for (const n of nums) out.push(u64(n));
  return out;
}

function encodeRevealSlots(slots: (SlotReveal | null)[]): Uint8Array[] {
  const out: Uint8Array[] = [u64(slots.length)];
  for (const reveal of slots) {
    out.push(Uint8Array.of(reveal ? 1 : 0));
    if (reveal) {
      out.push(...encodeBytes(reveal.value), ...encodeBytes(reveal.salt));
    }
  }
  return out;
}

function winnerCode(winner: PokerWinner | null): number {
  if (winner === "A") return 1;
  if (winner === "B") return 2;
  if (winner === "tie") return 3;
  return 0;
}

function scoreToU64(score: number | null): Uint8Array {
  return u64(score === null ? 0 : BigInt(score));
}

/** Compute the nine public commitments for a party's private slot secrets. */
export function commitSlotSecrets(
  secrets: readonly SlotSecret[]
): Uint8Array[] {
  if (secrets.length !== SLOT_COUNT) {
    throw new Error(`expected ${SLOT_COUNT} slot secrets`);
  }
  return secrets.map((secret) => computeCommitment(secret.value, secret.salt));
}

function validateLocalSecretsForCommit(
  commitments: readonly Uint8Array[],
  secrets: readonly SlotSecret[]
): SlotSecret[] {
  if (secrets.length !== SLOT_COUNT) {
    throw new Error(`expected ${SLOT_COUNT} local slot secrets`);
  }
  const expected = commitSlotSecrets(secrets);
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (!bytesEqual(expected[i], commitments[i])) {
      throw new Error("local secrets do not match commitments");
    }
  }
  return secrets.map(copyReveal);
}

/**
 * Derive a single Quantum Poker card from two slot reveals. Counter 0 is the base
 * slot seed; higher counters are used only to retry board collisions.
 *
 * Per the Quantum Games design, every slot is an *independent sample*: combine both
 * reveals into a 32-byte seed and reduce it modulo 52 — the whitepaper's
 * `Card = Random() mod 52`. This is one hash per card, not a 51-swap Fisher-Yates over
 * a fresh 52-card deck. There is no hidden global deck; board uniqueness is enforced by
 * the caller via `counter`, and the showdown burn rule resolves any hidden/board
 * collisions. We reduce the *full* 256-bit seed modulo 52 (big-endian, byte-by-byte
 * Horner fold) so the whole hash contributes its entropy; the residual modulo bias is
 * bounded by 52 / 2^256 (~2^-250) — unobservable — with no extra hash. Must stay
 * byte-for-byte identical to Rust `derive_quantum_card`.
 */
export function deriveQuantumCard(
  revealA: SlotReveal,
  revealB: SlotReveal,
  counter = 0
): number {
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error(`invalid card derivation counter ${counter}`);
  }
  const slotSeed = combineReveals(
    revealA.value,
    revealA.salt,
    revealB.value,
    revealB.salt
  );
  const seedBytes =
    counter === 0
      ? slotSeed
      : blake2b256(concatBytes([slotSeed, u64ToBeBytes(counter)]));
  let acc = 0;
  for (let i = 0; i < seedBytes.length; i++) acc = (acc * 256 + seedBytes[i]) % 52;
  return acc;
}

export class QuantumPokerProtocol implements Protocol<PokerState, PokerMove> {
  readonly name = "quantum_poker.v2";
  /** `commit_slots` moves carry the slot pre-images — DistributedTunnel must be given a stripping
   *  codec (pokerMoveCodec). Without this the guard would not fire and the identity codec would
   *  relay the hole-card pre-images to the opponent. */
  readonly movesCarrySecrets = true;
  private readonly randomDrivers = new Map<Party, QuantumPokerSeatDriver>();

  constructor(private readonly handCap: bigint = DEFAULT_HAND_CAP) {}

  initialState(ctx: ProtocolContext): PokerState {
    const total = ctx.initialBalances.a + ctx.initialBalances.b;
    return {
      phase:
        ctx.initialBalances.a >= ANTE && ctx.initialBalances.b >= ANTE
          ? "commit"
          : "done",
      handNo: 0n,
      handCap: this.handCap,
      commitA: null,
      commitB: null,
      revealsA: emptyRevealSlots(),
      revealsB: emptyRevealSlots(),
      localSecretsA: null,
      localSecretsB: null,
      holeA: null,
      holeB: null,
      board: [],
      boardSlots: [],
      boardCounters: [],
      totalBetA: 0n,
      totalBetB: 0n,
      streetBetA: 0n,
      streetBetB: 0n,
      toAct: "A",
      actedA: false,
      actedB: false,
      foldedBy: null,
      shownA: false,
      shownB: false,
      shownHoleA: null,
      shownHoleB: null,
      winner: null,
      lastResult: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total,
    };
  }

  applyMove(state: PokerState, move: PokerMove, by: Party): PokerState {
    const s = cloneState(state);
    // A seat that has met every reveal it owes can claim the contested pot when the opponent
    // withholds a reveal it owes (the F1 abandonment gap). Withholding is an implicit fold, so
    // a non-zero create-time `penalty_amount` then backs the on-chain force-close.
    if (move.kind === "forfeit") return this.claimForfeit(s, by);
    switch (s.phase) {
      case "commit":
        return this.applyCommit(s, move, by);
      case "open_private_holes":
      case "reveal_flop":
      case "reveal_turn":
      case "reveal_river":
      case "showdown":
        return this.applyRevealSlots(s, move, by);
      case "preflop_bet":
      case "flop_bet":
      case "turn_bet":
      case "river_bet":
        return this.applyBet(s, move, by);
      case "hand_over":
        return this.applyNextHand(s, move);
      default:
        throw new Error(`no moves legal in phase ${s.phase}`);
    }
  }

  private applyCommit(s: PokerState, move: PokerMove, by: Party): PokerState {
    if (move.kind !== "commit_slots") throw new Error("expected commit_slots");
    const commitments = validateCommitments(move.commitments);
    const localSecrets = move.localSecrets
      ? validateLocalSecretsForCommit(commitments, move.localSecrets)
      : null;

    if (by === "A") {
      if (s.commitA) throw new Error("A already committed");
      s.commitA = commitments;
      if (localSecrets) s.localSecretsA = localSecrets;
    } else {
      if (s.commitB) throw new Error("B already committed");
      s.commitB = commitments;
      if (localSecrets) s.localSecretsB = localSecrets;
    }
    if (s.commitA && s.commitB) s.phase = "open_private_holes";
    return s;
  }

  private applyRevealSlots(
    s: PokerState,
    move: PokerMove,
    by: Party
  ): PokerState {
    if (move.kind !== "reveal_slots") throw new Error("expected reveal_slots");
    const expected = this.expectedRevealSlots(s, by);
    if (!sameNumberSet(move.slots, expected)) {
      throw new Error(
        `expected ${by} to reveal slots ${expected.join(
          ","
        )}, got ${move.slots.join(",")}`
      );
    }
    if (move.reveals.length !== move.slots.length) {
      throw new Error("slots/reveals length mismatch");
    }

    const commits = commitArrayFor(s, by);
    if (!commits) throw new Error(`${by} has not committed`);
    const target = revealArrayFor(s, by);
    for (let i = 0; i < move.slots.length; i++) {
      const slot = move.slots[i];
      assertSlot(slot);
      if (target[slot]) throw new Error(`${by} already revealed slot ${slot}`);
      const reveal = move.reveals[i];
      if (!verifyCommitment(commits[slot], reveal.value, reveal.salt)) {
        throw new Error("slot reveal does not match commitment");
      }
      target[slot] = copyReveal(reveal);
    }

    switch (s.phase) {
      case "open_private_holes":
        if (
          hasRevealed(s, "A", B_HOLE_SLOTS) &&
          hasRevealed(s, "B", A_HOLE_SLOTS)
        ) {
          s.holeA = this.tryDeriveHoleCards(s, "A");
          s.holeB = this.tryDeriveHoleCards(s, "B");
          this.postAntesAndBeginStreet(s, "preflop_bet");
        }
        break;
      case "reveal_flop":
        this.tryRevealBoardThenBet(s, FLOP_SLOTS, "flop_bet");
        break;
      case "reveal_turn":
        this.tryRevealBoardThenBet(s, TURN_SLOTS, "turn_bet");
        break;
      case "reveal_river":
        this.tryRevealBoardThenBet(s, RIVER_SLOTS, "river_bet");
        break;
      case "showdown":
        if (
          hasRevealed(s, "A", A_HOLE_SLOTS) &&
          hasRevealed(s, "B", B_HOLE_SLOTS)
        ) {
          s.shownA = true;
          s.shownB = true;
          s.shownHoleA = this.derivePublicHoleCards(s, "A");
          s.shownHoleB = this.derivePublicHoleCards(s, "B");
          this.resolveShowdown(s);
        }
        break;
    }
    return s;
  }

  private expectedRevealSlots(s: PokerState, by: Party): number[] {
    return expectedQuantumPokerRevealSlots(s, by);
  }

  private postAntesAndBeginStreet(s: PokerState, phase: "preflop_bet"): void {
    if (s.balanceA < ANTE || s.balanceB < ANTE) {
      throw new Error("insufficient balance for ante");
    }
    s.totalBetA = ANTE;
    s.totalBetB = ANTE;
    this.beginStreet(s, phase);
  }

  private beginStreet(
    s: PokerState,
    phase: "preflop_bet" | "flop_bet" | "turn_bet" | "river_bet"
  ): void {
    s.phase = phase;
    s.streetBetA = 0n;
    s.streetBetB = 0n;
    s.toAct = "A";
    s.actedA = false;
    s.actedB = false;
  }

  private tryRevealBoardThenBet(
    s: PokerState,
    slots: readonly number[],
    nextPhase: "flop_bet" | "turn_bet" | "river_bet"
  ): void {
    if (!hasRevealed(s, "A", slots) || !hasRevealed(s, "B", slots)) return;
    const used = new Set(s.board);
    for (const slot of slots) {
      if (s.boardSlots.includes(slot)) continue;
      const { card, counter } = this.deriveUniqueBoardCard(s, slot, used);
      s.board.push(card);
      s.boardSlots.push(slot);
      s.boardCounters.push(counter);
      used.add(card);
    }
    if (this.bettingClosed(s)) {
      // All-in already matched this hand — no more betting; run the board out to showdown.
      s.phase =
        nextPhase === "flop_bet"
          ? "reveal_turn"
          : nextPhase === "turn_bet"
          ? "reveal_river"
          : "showdown";
      return;
    }
    this.beginStreet(s, nextPhase);
  }

  private revealForDerivation(
    s: PokerState,
    party: Party,
    slot: number,
    allowLocal: boolean
  ): SlotReveal | null {
    const publicReveal = revealArrayFor(s, party)[slot];
    if (publicReveal) return publicReveal;
    return allowLocal ? localSecretArrayFor(s, party)?.[slot] ?? null : null;
  }

  private deriveSlotCard(
    s: PokerState,
    slot: number,
    counter: number,
    allowLocal: boolean
  ): number | null {
    const revealA = this.revealForDerivation(s, "A", slot, allowLocal);
    const revealB = this.revealForDerivation(s, "B", slot, allowLocal);
    if (!revealA || !revealB) return null;
    return deriveQuantumCard(revealA, revealB, counter);
  }

  private deriveUniqueBoardCard(
    s: PokerState,
    slot: number,
    used: Set<number>
  ): { card: number; counter: number } {
    for (let counter = 0; counter < 10_000; counter++) {
      const card = this.deriveSlotCard(s, slot, counter, false);
      if (card === null) throw new Error(`board slot ${slot} is not revealed`);
      if (!used.has(card)) return { card, counter };
    }
    throw new Error("could not derive unique board card");
  }

  private tryDeriveHoleCards(s: PokerState, owner: Party): number[] | null {
    const slots = owner === "A" ? A_HOLE_SLOTS : B_HOLE_SLOTS;
    const cards: number[] = [];
    for (const slot of slots) {
      const card = this.deriveSlotCard(s, slot, 0, true);
      if (card === null) return null;
      cards.push(card);
    }
    return cards;
  }

  private derivePublicHoleCards(s: PokerState, owner: Party): number[] {
    const slots = owner === "A" ? A_HOLE_SLOTS : B_HOLE_SLOTS;
    return slots.map((slot) => {
      const card = this.deriveSlotCard(s, slot, 0, false);
      if (card === null) throw new Error(`hole slot ${slot} not public`);
      return card;
    });
  }

  private applyBet(s: PokerState, move: PokerMove, by: Party): PokerState {
    if (s.toAct !== by) throw new Error(`not ${by}'s turn to act`);
    switch (move.kind) {
      case "check":
        this.applyCheck(s, by);
        break;
      case "bet":
        this.applyBetOrRaise(s, by, move.amount);
        break;
      case "call":
        this.applyCall(s, by);
        break;
      case "fold":
        s.foldedBy = by;
        this.resolveFold(s);
        break;
      default:
        throw new Error("expected betting move");
    }
    return s;
  }

  private streetBet(s: PokerState, by: Party): bigint {
    return by === "A" ? s.streetBetA : s.streetBetB;
  }

  private setStreetBet(s: PokerState, by: Party, value: bigint): void {
    if (by === "A") s.streetBetA = value;
    else s.streetBetB = value;
  }

  private totalBet(s: PokerState, by: Party): bigint {
    return by === "A" ? s.totalBetA : s.totalBetB;
  }

  private addTotalBet(s: PokerState, by: Party, amount: bigint): void {
    if (by === "A") s.totalBetA += amount;
    else s.totalBetB += amount;
  }

  private balance(s: PokerState, by: Party): bigint {
    return by === "A" ? s.balanceA : s.balanceB;
  }

  // Heads-up effective stack: neither seat can wager more than the SHORTER stack this hand, so the
  // bigger stack's surplus is unbettable and the shorter stack's all-in stays fully callable (the
  // surplus simply never enters the pot). Clamped at 0 for safety.
  private availableFor(s: PokerState, by: Party): bigint {
    const effectiveStack =
      this.balance(s, "A") < this.balance(s, "B")
        ? this.balance(s, "A")
        : this.balance(s, "B");
    const remaining = effectiveStack - this.totalBet(s, by);
    return remaining > 0n ? remaining : 0n;
  }

  /** True once either seat is all-in: no further betting is possible this hand. */
  private bettingClosed(s: PokerState): boolean {
    return this.availableFor(s, "A") === 0n || this.availableFor(s, "B") === 0n;
  }

  private markActed(s: PokerState, by: Party, acted: boolean): void {
    if (by === "A") s.actedA = acted;
    else s.actedB = acted;
  }

  private applyCheck(s: PokerState, by: Party): void {
    const currentMax =
      s.streetBetA > s.streetBetB ? s.streetBetA : s.streetBetB;
    if (this.streetBet(s, by) !== currentMax) {
      throw new Error("cannot check facing a bet");
    }
    this.markActed(s, by, true);
    this.afterBetAction(s);
  }

  private applyBetOrRaise(s: PokerState, by: Party, amount: bigint): void {
    if (amount <= 0n) throw new Error("bet amount must be positive");
    const current = this.streetBet(s, by);
    const other = this.streetBet(s, otherParty(by));
    const next = current + amount;
    if (next <= other) throw new Error("bet must raise above opponent");
    if (amount > this.availableFor(s, by)) {
      throw new Error("bet exceeds the effective stack");
    }
    this.setStreetBet(s, by, next);
    this.addTotalBet(s, by, amount);
    this.markActed(s, by, true);
    this.markActed(s, otherParty(by), false);
    s.toAct = otherParty(by);
  }

  private applyCall(s: PokerState, by: Party): void {
    const diff = this.streetBet(s, otherParty(by)) - this.streetBet(s, by);
    if (diff <= 0n) throw new Error("nothing to call");
    if (diff > this.availableFor(s, by)) {
      throw new Error("call exceeds the effective stack");
    }
    this.setStreetBet(s, by, this.streetBet(s, by) + diff);
    this.addTotalBet(s, by, diff);
    this.markActed(s, by, true);
    this.afterBetAction(s);
  }

  private afterBetAction(s: PokerState): void {
    const equal = s.streetBetA === s.streetBetB;
    if (equal && s.actedA && s.actedB) {
      this.advanceStreet(s);
      return;
    }
    s.toAct = otherParty(s.toAct);
  }

  private advanceStreet(s: PokerState): void {
    switch (s.phase) {
      case "preflop_bet":
        s.phase = "reveal_flop";
        break;
      case "flop_bet":
        s.phase = "reveal_turn";
        break;
      case "turn_bet":
        s.phase = "reveal_river";
        break;
      case "river_bet":
        s.phase = "showdown";
        break;
      default:
        throw new Error(`cannot advance from ${s.phase}`);
    }
    s.toAct = "A";
    s.actedA = false;
    s.actedB = false;
    s.streetBetA = 0n;
    s.streetBetB = 0n;
  }

  /**
   * `by` claims the contested pot because the opponent withholds a reveal it owes during a
   * reveal phase. `by` must already owe nothing; the opponent must still owe a reveal. Treated
   * as the opponent folding, so the pot, balance clamp, and state encoding match `resolveFold`.
   */
  private claimForfeit(s: PokerState, by: Party): PokerState {
    const opp = otherParty(by);
    let mineOwes: number[];
    let oppOwes: number[];
    try {
      mineOwes = expectedQuantumPokerRevealSlots(s, by);
      oppOwes = expectedQuantumPokerRevealSlots(s, opp);
    } catch {
      throw new Error("forfeit only valid during a pending reveal");
    }
    if (mineOwes.length !== 0)
      throw new Error("forfeit not claimable: you still owe a reveal");
    if (oppOwes.length === 0)
      throw new Error("forfeit not claimable: opponent does not owe a reveal");
    s.foldedBy = opp;
    this.resolveFold(s);
    return s;
  }

  private resolveFold(s: PokerState): void {
    const winner = otherParty(s.foldedBy!);
    this.settle(s, winner, this.contestedAmount(s));
    s.winner = winner;
    s.lastResult = {
      winner,
      reason: "fold",
      scoreA: null,
      scoreB: null,
      bestA: null,
      bestB: null,
      burnedA: [],
      burnedB: [],
    };
    s.phase = "hand_over";
  }

  private resolveShowdown(s: PokerState): void {
    const boardSet = new Set(s.board);
    const burnedA = s.shownHoleA!.filter((card) => boardSet.has(card));
    const burnedB = s.shownHoleB!.filter((card) => boardSet.has(card));
    const liveA = s.shownHoleA!.filter((card) => !boardSet.has(card));
    const liveB = s.shownHoleB!.filter((card) => !boardSet.has(card));
    const bestA = bestPokerHand([...liveA, ...s.board]);
    const bestB = bestPokerHand([...liveB, ...s.board]);
    let winner: PokerWinner = "tie";
    if (bestA.score > bestB.score) winner = "A";
    else if (bestB.score > bestA.score) winner = "B";
    if (winner !== "tie") this.settle(s, winner, this.contestedAmount(s));
    s.winner = winner;
    s.lastResult = {
      winner,
      reason: "showdown",
      scoreA: bestA.score,
      scoreB: bestB.score,
      bestA: bestA.cards,
      bestB: bestB.cards,
      burnedA,
      burnedB,
    };
    s.phase = "hand_over";
  }

  private contestedAmount(s: PokerState): bigint {
    return s.totalBetA < s.totalBetB ? s.totalBetA : s.totalBetB;
  }

  /** Move `amount` from loser to winner, clamped so balances stay non-negative. */
  private settle(s: PokerState, winner: Party, amount: bigint): void {
    const loserBal = winner === "A" ? s.balanceB : s.balanceA;
    const moved = amount < loserBal ? amount : loserBal;
    if (winner === "A") {
      s.balanceA += moved;
      s.balanceB -= moved;
    } else {
      s.balanceB += moved;
      s.balanceA -= moved;
    }
  }

  private applyNextHand(s: PokerState, move: PokerMove): PokerState {
    if (move.kind !== "next_hand") throw new Error("expected next_hand");
    s.handNo += 1n;
    const canContinue =
      s.handNo < s.handCap && s.balanceA >= ANTE && s.balanceB >= ANTE;
    this.resetHandFields(s);
    s.phase = canContinue ? "commit" : "done";
    return s;
  }

  private resetHandFields(s: PokerState): void {
    s.commitA = null;
    s.commitB = null;
    s.revealsA = emptyRevealSlots();
    s.revealsB = emptyRevealSlots();
    s.localSecretsA = null;
    s.localSecretsB = null;
    s.holeA = null;
    s.holeB = null;
    s.board = [];
    s.boardSlots = [];
    s.boardCounters = [];
    s.totalBetA = 0n;
    s.totalBetB = 0n;
    s.streetBetA = 0n;
    s.streetBetB = 0n;
    s.toAct = "A";
    s.actedA = false;
    s.actedB = false;
    s.foldedBy = null;
    s.shownA = false;
    s.shownB = false;
    s.shownHoleA = null;
    s.shownHoleB = null;
    s.winner = null;
    s.lastResult = null;
  }

  encodeState(s: PokerState): Uint8Array {
    const flags = Uint8Array.of(
      s.toAct === "A" ? 0 : 1,
      s.actedA ? 1 : 0,
      s.actedB ? 1 : 0,
      s.foldedBy === null ? 0 : s.foldedBy === "A" ? 1 : 2,
      s.shownA ? 1 : 0,
      s.shownB ? 1 : 0,
      winnerCode(s.winner),
      s.lastResult?.reason === "fold"
        ? 1
        : s.lastResult?.reason === "showdown"
        ? 2
        : 0
    );

    return concatBytes([
      DOMAIN,
      Uint8Array.of(PHASE_CODE[s.phase]),
      u64(s.handNo),
      u64(s.handCap),
      u64(s.balanceA),
      u64(s.balanceB),
      u64(s.totalBetA),
      u64(s.totalBetB),
      u64(s.streetBetA),
      u64(s.streetBetB),
      flags,
      ...encodeByteList(s.commitA),
      ...encodeByteList(s.commitB),
      ...encodeRevealSlots(s.revealsA),
      ...encodeRevealSlots(s.revealsB),
      ...encodeCards(s.board),
      ...encodeNumbers(s.boardSlots),
      ...encodeNumbers(s.boardCounters),
      ...encodeCards(s.shownA ? s.shownHoleA : null),
      ...encodeCards(s.shownB ? s.shownHoleB : null),
      scoreToU64(s.lastResult?.scoreA ?? null),
      scoreToU64(s.lastResult?.scoreB ?? null),
      ...encodeCards(s.lastResult?.bestA ?? null),
      ...encodeCards(s.lastResult?.bestB ?? null),
      ...encodeCards(s.lastResult?.burnedA ?? null),
      ...encodeCards(s.lastResult?.burnedB ?? null),
    ]);
  }

  balances(s: PokerState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: PokerState): boolean {
    return s.phase === "done";
  }

  randomMove(s: PokerState, by: Party, rng: () => number): PokerMove | null {
    let driver = this.randomDrivers.get(by);
    if (!driver) {
      driver = new QuantumPokerSeatDriver(by);
      this.randomDrivers.set(by, driver);
    }
    return driver.chooseMove(s, rng);
  }
}

function randomBytes(n: number, rng: () => number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 256) | 0;
  return out;
}

function randomSlotSecrets(rng: () => number): SlotSecret[] {
  return Array.from({ length: SLOT_COUNT }, () => ({
    value: randomBytes(32, rng),
    salt: randomBytes(16, rng),
  }));
}

function streetBetValue(s: PokerState, by: Party): bigint {
  return by === "A" ? s.streetBetA : s.streetBetB;
}

function totalBetValue(s: PokerState, by: Party): bigint {
  return by === "A" ? s.totalBetA : s.totalBetB;
}

function balanceValue(s: PokerState, by: Party): bigint {
  return by === "A" ? s.balanceA : s.balanceB;
}

function ownHoleSlots(by: Party): readonly number[] {
  return by === "A" ? A_HOLE_SLOTS : B_HOLE_SLOTS;
}

function secretMapKey(handNo: bigint): string {
  return handNo.toString();
}

export class QuantumPokerSeatDriver {
  private readonly secretsByHand = new Map<string, SlotSecret[]>();

  constructor(readonly party: Party) {}

  private secretsFor(state: PokerState): SlotSecret[] | null {
    const key = secretMapKey(state.handNo);
    const cached = this.secretsByHand.get(key);
    if (cached) return cached;

    const localSecrets = localSecretArrayFor(state, this.party);
    if (!localSecrets || localSecrets.some((secret) => !secret)) return null;

    const secrets = localSecrets.map((secret) => copyReveal(secret!));
    this.secretsByHand.set(key, secrets.map(copyReveal));
    return secrets;
  }

  makeCommitMove(state: PokerState, rng: () => number): PokerMove | null {
    const committed = this.party === "A" ? state.commitA : state.commitB;
    if (state.phase !== "commit" || committed) return null;
    const secrets = randomSlotSecrets(rng);
    this.secretsByHand.set(secretMapKey(state.handNo), secrets.map(copyReveal));
    return {
      kind: "commit_slots",
      commitments: commitSlotSecrets(secrets),
      localSecrets: secrets.map(copyReveal),
    };
  }

  makeRevealMove(state: PokerState): PokerMove | null {
    const slots = expectedQuantumPokerRevealSlots(state, this.party);
    if (slots.length === 0) return null;
    const secrets = this.secretsFor(state);
    if (!secrets) return null;
    return {
      kind: "reveal_slots",
      slots,
      reveals: slots.map((slot) => {
        const secret = secrets[slot];
        if (!secret) throw new Error(`missing local secret for slot ${slot}`);
        return copyReveal(secret);
      }),
    };
  }

  knownHoleCards(state: PokerState): number[] | null {
    const secrets = this.secretsFor(state);
    if (!secrets) return null;
    const cards: number[] = [];
    for (const slot of ownHoleSlots(this.party)) {
      const own = secrets[slot];
      const other = revealArrayFor(state, otherParty(this.party))[slot];
      if (!own || !other) return null;
      cards.push(
        this.party === "A"
          ? deriveQuantumCard(own, other)
          : deriveQuantumCard(other, own)
      );
    }
    return cards;
  }

  chooseMove(s: PokerState, rng: () => number): PokerMove | null {
    switch (s.phase) {
      case "commit":
        return this.makeCommitMove(s, rng);
      case "open_private_holes":
      case "reveal_flop":
      case "reveal_turn":
      case "reveal_river":
      case "showdown":
        return this.makeRevealMove(s);
      case "preflop_bet":
      case "flop_bet":
      case "turn_bet":
      case "river_bet": {
        if (s.toAct !== this.party) return null;
        const diff =
          streetBetValue(s, otherParty(this.party)) -
          streetBetValue(s, this.party);
        if (diff > 0n) {
          return rng() < 0.85 ? { kind: "call" } : { kind: "fold" };
        }
        const available =
          balanceValue(s, this.party) - totalBetValue(s, this.party);
        if (available > 0n && rng() < 0.35) {
          const cap = available < 200n ? available : 200n;
          const amount = BigInt(1 + Math.floor(rng() * Number(cap)));
          return { kind: "bet", amount };
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

// ---- Duplicate-aware poker evaluator (higher score = stronger) -----------------

export interface BestHand {
  score: number;
  cards: number[];
}

function validateCards(cards: number[]): void {
  for (const c of cards) {
    if (!Number.isInteger(c) || c < 0 || c > 51) {
      throw new Error(`card out of range 0..51: ${c}`);
    }
  }
}

function combinations5(cards: number[]): number[][] {
  const out: number[][] = [];
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++)
            out.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
  return out;
}

/** Return the best 5-card poker hand from a 5-7-card duplicate-aware pool. */
export function bestPokerHand(cards: number[]): BestHand {
  if (cards.length < 5) throw new Error("bestPokerHand needs at least 5 cards");
  if (cards.length > 7)
    throw new Error("bestPokerHand supports at most 7 cards");
  validateCards(cards);
  let best: BestHand | null = null;
  for (const hand of combinations5(cards)) {
    const score = evaluate5(hand);
    if (!best || score > best.score) best = { score, cards: hand };
  }
  return best!;
}

/** Evaluate a 5-card hand. Exact duplicate cards are legal virtual-deck cards. */
export function evaluate5(cards: number[]): number {
  if (cards.length !== 5) throw new Error("evaluate5 needs exactly 5 cards");
  validateCards(cards);

  const ranks = cards.map((c) => c % 13).sort((a, b) => b - a);
  const suits = cards.map((c) => Math.floor(c / 13));
  const flush = suits.every((su) => su === suits[0]);

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()]
    .map(([rank, count]) => [count, rank] as [number, number])
    .sort((x, y) => (y[0] - x[0] !== 0 ? y[0] - x[0] : y[1] - x[1]));

  const distinct = [...new Set(ranks)].sort((a, b) => b - a);
  let straight = false;
  let straightHigh = -1;
  if (distinct.length === 5) {
    if (distinct[0] - distinct[4] === 4) {
      straight = true;
      straightHigh = distinct[0];
    } else if (
      distinct[0] === 12 &&
      distinct[1] === 3 &&
      distinct[2] === 2 &&
      distinct[3] === 1 &&
      distinct[4] === 0
    ) {
      straight = true;
      straightHigh = 3;
    }
  }

  let category: number;
  if (groups[0][0] === 5) category = 9;
  else if (straight && flush) category = 8;
  else if (groups[0][0] === 4) category = 7;
  else if (groups[0][0] === 3 && groups[1]?.[0] === 2) category = 6;
  else if (flush) category = 5;
  else if (straight) category = 4;
  else if (groups[0][0] === 3) category = 3;
  else if (groups[0][0] === 2 && groups[1]?.[0] === 2) category = 2;
  else if (groups[0][0] === 2) category = 1;
  else category = 0;

  const tb = straight ? [straightHigh] : groups.map((g) => g[1]);
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 13 + (tb[i] ?? 0);
  return score;
}
