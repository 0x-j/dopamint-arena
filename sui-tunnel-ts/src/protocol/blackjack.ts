/**
 * Blackjack protocol (v2): two-party, dealerless Blackjack over a tunnel with
 * per-card commit-reveal randomness.
 *
 * Party A is the "player", Party B the "dealer" (roles alternate every two rounds). Neither
 * controls the cards: EVERY card is produced by an independent two-party commit-reveal,
 * drawn on demand at the moment that card is dealt. Both commit a fresh secret share,
 * both reveal, then a rank is derived via combineReveals + rejection sampling. Because
 * each card's entropy is independent and revealed only when drawn, no party can predict
 * an undrawn card or bias any card; derivation is deterministic so an on-chain disputer
 * can replay it.
 *
 * Deck: infinite uniform RANK (1..13) with replacement — duplicate ranks are a legal pair,
 * no dedup, no cap on draws. The player chooses a variable bet at the start of each round
 * (soft-ace handValue, dealer draws to 17, clamped settlement otherwise unchanged from v1).
 */

import { concatBytes } from "../core/bytes";
import {
  combineReveals,
  computeCommitment,
  MIN_SALT_LEN,
  verifyCommitment,
} from "../core/commitment";
import { nextU64InRange, seedFromBytes } from "../core/randomness";
import { u64ToBeBytes } from "../core/wire";
import {
  Balances,
  lengthPrefixedConcat,
  otherParty,
  Party,
  Protocol,
  ProtocolContext,
  protocolDomain,
} from "./Protocol";

/** Helper to determine who is the Player based on the round. */
export function getPlayerParty(round: bigint): Party {
  const r = Number(round) - 1;
  return Math.floor(r / 2) % 2 === 0 ? "A" : "B";
}
/** Helper to determine who is the Dealer based on the round. */
export function getDealerParty(round: bigint): Party {
  return getPlayerParty(round) === "A" ? "B" : "A";
}

/** Maps a round number to the seat playing the "player" role (the rest is the dealer). */
export type PlayerPartyFor = (round: bigint) => Party;

/** Pin the player to seat A every round (single-player "vs bot"; the table never inverts). */
export const FIXED_PLAYER_A: PlayerPartyFor = () => "A";

function dealerPartyForWith(
  round: bigint,
  playerPartyFor: PlayerPartyFor,
): Party {
  return playerPartyFor(round) === "A" ? "B" : "A";
}

export const MIN_BET = 25n;
export const ROUND_CAP = 1000n;
const DEALER_STANDS_AT = 17;
const BUST_AT = 21;

export type BlackjackPhase =
  | "draw_commit"
  | "draw_reveal"
  | "player"
  | "round_over";

export interface BlackjackSlotReveal {
  value: Uint8Array;
  salt: Uint8Array;
}
export type BlackjackSlotSecret = BlackjackSlotReveal;

export type DrawReason = "deal" | "hit" | "dealer_auto";
export interface DrawContext {
  forHand: "player" | "dealer";
  reason: DrawReason;
}

export interface BlackjackState {
  phase: BlackjackPhase;
  /** 1-based round counter. */
  round: bigint;
  /** Cards drawn so far this round. */
  drawCount: bigint;
  /** Card values held by the player (Ace stored raw as 11). */
  playerHand: number[];
  dealerHand: number[];
  /** The in-flight card being drawn, or null between draws. */
  draw: DrawContext | null;
  pendingCommitA: Uint8Array | null;
  pendingCommitB: Uint8Array | null;
  pendingRevealA: BlackjackSlotReveal | null;
  pendingRevealB: BlackjackSlotReveal | null;
  /** Local-only seat secrets. NEVER encoded into signed state; the relay codec omits them. */
  localSecretA: BlackjackSlotSecret | null;
  localSecretB: BlackjackSlotSecret | null;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  /** The current round's wager (chosen by the player at round start). */
  bet: bigint;
}

export type BlackjackMove =
  | { kind: "bet"; amount: bigint }
  | {
      kind: "commit";
      commitment: Uint8Array;
      localSecret?: BlackjackSlotSecret;
    }
  | { kind: "reveal"; reveal: BlackjackSlotReveal }
  | { kind: "hit" }
  | { kind: "stand" }
  | { kind: "forfeit" };

const DOMAIN = protocolDomain("blackjack.v2");

const PHASE_CODE: Record<BlackjackPhase, number> = {
  draw_commit: 0,
  draw_reveal: 1,
  player: 2,
  round_over: 3,
};
const FORHAND_CODE: Record<DrawContext["forHand"], number> = {
  player: 0,
  dealer: 1,
};
const REASON_CODE: Record<DrawReason, number> = {
  deal: 0,
  hit: 1,
  dealer_auto: 2,
};

// ============================================
// PURE HELPERS
// ============================================

/** Map a rank (1..13) to its raw blackjack value (Ace = 11 here; reduced later). */
function rankValue(rank: number): number {
  if (rank === 1) return 11;
  if (rank >= 11) return 10;
  return rank;
}

/** Hand total with soft-ace handling: downgrade 11->1 per ace while busting. */
function handValue(hand: number[]): number {
  let total = 0;
  let aces = 0;
  for (const v of hand) {
    total += v;
    if (v === 11) aces++;
  }
  while (total > BUST_AT && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function isBust(hand: number[]): boolean {
  return handValue(hand) > BUST_AT;
}

/**
 * Largest bet both sides can cover this round (the smaller balance). Betting the full
 * stack (all-in) is intentionally permitted; the game just turns terminal afterward if a
 * side drops below MIN_BET.
 */
export function maxBet(s: BlackjackState): bigint {
  return s.balanceA < s.balanceB ? s.balanceA : s.balanceB;
}

function canStartRound(s: BlackjackState): boolean {
  return maxBet(s) >= MIN_BET;
}

/** Exposed for tests/tools: hand total with soft-ace handling. */
export function blackjackHandValue(hand: number[]): number {
  return handValue(hand);
}

/** Derive a rank 1..13 from two reveals (rejection-sampled, unbiased). */
export function deriveRank(
  a: BlackjackSlotReveal,
  b: BlackjackSlotReveal,
): number {
  const seed = seedFromBytes(combineReveals(a.value, a.salt, b.value, b.salt));
  const [v] = nextU64InRange(seed, 0n, 13n);
  return Number(v) + 1;
}

// ============================================
// STATE TRANSITIONS (pure)
// ============================================

/** Begin a fresh draw: clear all pending commit/reveal/secret state, enter draw_commit. */
function beginDraw(s: BlackjackState, ctx: DrawContext): BlackjackState {
  return {
    ...s,
    phase: "draw_commit",
    draw: ctx,
    pendingCommitA: null,
    pendingCommitB: null,
    pendingRevealA: null,
    pendingRevealB: null,
    localSecretA: null,
    localSecretB: null,
  };
}

/** Start a new round and kick off the opening deal (first player card). */
function beginRound(s: BlackjackState): BlackjackState {
  const round = s.round + 1n;
  const base: BlackjackState = {
    ...s,
    round,
    drawCount: 0n,
    playerHand: [],
    dealerHand: [],
  };
  return beginDraw(base, { forHand: "player", reason: "deal" });
}

/** Compare hands and settle (dealer bust / higher value / push). */
function resolveShowdown(
  s: BlackjackState,
  playerPartyFor: PlayerPartyFor,
): BlackjackState {
  const pv = handValue(s.playerHand);
  const dv = handValue(s.dealerHand);
  let winner: Party | null;
  if (isBust(s.dealerHand)) winner = playerPartyFor(s.round);
  else if (pv > dv) winner = playerPartyFor(s.round);
  else if (dv > pv) winner = dealerPartyForWith(s.round, playerPartyFor);
  else winner = null;
  return settle(s, winner);
}

/** Settle the round to `winner` (null = push), clearing draw state. */
function settle(s: BlackjackState, winner: Party | null): BlackjackState {
  let balanceA = s.balanceA;
  let balanceB = s.balanceB;
  if (winner === "A") {
    const amt = s.bet <= balanceB ? s.bet : balanceB;
    balanceA += amt;
    balanceB -= amt;
  } else if (winner === "B") {
    const amt = s.bet <= balanceA ? s.bet : balanceA;
    balanceB += amt;
    balanceA -= amt;
  }
  return {
    ...s,
    phase: "round_over",
    draw: null,
    pendingCommitA: null,
    pendingCommitB: null,
    pendingRevealA: null,
    pendingRevealB: null,
    localSecretA: null,
    localSecretB: null,
    balanceA,
    balanceB,
  };
}

/** Apply a freshly derived rank to the target hand and run the continuation. */
function afterDraw(
  s: BlackjackState,
  rank: number,
  playerPartyFor: PlayerPartyFor,
): BlackjackState {
  const ctx = s.draw!;
  const value = rankValue(rank);
  const playerHand =
    ctx.forHand === "player" ? [...s.playerHand, value] : s.playerHand;
  const dealerHand =
    ctx.forHand === "dealer" ? [...s.dealerHand, value] : s.dealerHand;
  const base: BlackjackState = {
    ...s,
    playerHand,
    dealerHand,
    drawCount: s.drawCount + 1n,
    draw: null,
    pendingCommitA: null,
    pendingCommitB: null,
    pendingRevealA: null,
    pendingRevealB: null,
    localSecretA: null,
    localSecretB: null,
  };

  switch (ctx.reason) {
    case "deal": {
      if (playerHand.length < 2)
        return beginDraw(base, { forHand: "player", reason: "deal" });
      // Deal ONLY the dealer's up-card now; the hole card stays hidden until the
      // player stands (drawn in the dealer_auto run-out). Otherwise the player would
      // see the dealer's full hand before acting — a large information edge, and
      // impossible to hide in two-party commit-reveal if drawn during the deal.
      if (dealerHand.length < 1)
        return beginDraw(base, { forHand: "dealer", reason: "deal" });
      return { ...base, phase: "player" };
    }
    case "hit": {
      if (isBust(playerHand))
        return settle(base, dealerPartyForWith(base.round, playerPartyFor));
      return { ...base, phase: "player" };
    }
    case "dealer_auto": {
      if (handValue(dealerHand) < DEALER_STANDS_AT)
        return beginDraw(base, { forHand: "dealer", reason: "dealer_auto" });
      return resolveShowdown(base, playerPartyFor);
    }
  }
}

/** Record a party's commitment; advance to draw_reveal once both have committed. */
function applyCommit(
  s: BlackjackState,
  move: Extract<BlackjackMove, { kind: "commit" }>,
  by: Party,
): BlackjackState {
  const already = by === "A" ? s.pendingCommitA : s.pendingCommitB;
  if (already) throw new Error(`party ${by} already committed`);
  if (move.commitment.length !== 32)
    throw new Error("commitment must be 32 bytes");
  const commit = move.commitment.slice();
  const secret: BlackjackSlotSecret | null = move.localSecret
    ? {
        value: move.localSecret.value.slice(),
        salt: move.localSecret.salt.slice(),
      }
    : null;
  const next: BlackjackState = {
    ...s,
    pendingCommitA: by === "A" ? commit : s.pendingCommitA,
    pendingCommitB: by === "B" ? commit : s.pendingCommitB,
    localSecretA: by === "A" ? secret : s.localSecretA,
    localSecretB: by === "B" ? secret : s.localSecretB,
  };
  if (next.pendingCommitA && next.pendingCommitB)
    return { ...next, phase: "draw_reveal" };
  return next;
}

/** Verify and record a party's reveal; derive + apply the card once both revealed. */
function applyReveal(
  s: BlackjackState,
  move: Extract<BlackjackMove, { kind: "reveal" }>,
  by: Party,
  playerPartyFor: PlayerPartyFor,
): BlackjackState {
  const already = by === "A" ? s.pendingRevealA : s.pendingRevealB;
  if (already) throw new Error(`party ${by} already revealed`);
  const commit = by === "A" ? s.pendingCommitA : s.pendingCommitB;
  if (!commit) throw new Error(`party ${by} has no commitment to reveal`);
  if (!verifyCommitment(commit, move.reveal.value, move.reveal.salt))
    throw new Error(`reveal does not match commitment for party ${by}`);
  const reveal: BlackjackSlotReveal = {
    value: move.reveal.value.slice(),
    salt: move.reveal.salt.slice(),
  };
  const next: BlackjackState = {
    ...s,
    pendingRevealA: by === "A" ? reveal : s.pendingRevealA,
    pendingRevealB: by === "B" ? reveal : s.pendingRevealB,
  };
  if (next.pendingRevealA && next.pendingRevealB) {
    const rank = deriveRank(next.pendingRevealA, next.pendingRevealB);
    return afterDraw(next, rank, playerPartyFor);
  }
  return next;
}

/** `by` claims the round because the opponent failed to advance the pending draw. */
function claimForfeit(s: BlackjackState, by: Party): BlackjackState {
  const opp = otherParty(by);
  if (s.phase === "draw_commit") {
    const mine = by === "A" ? s.pendingCommitA : s.pendingCommitB;
    const theirs = opp === "A" ? s.pendingCommitA : s.pendingCommitB;
    if (!mine || theirs)
      throw new Error("forfeit not claimable: opponent does not owe a commit");
  } else if (s.phase === "draw_reveal") {
    const mine = by === "A" ? s.pendingRevealA : s.pendingRevealB;
    const theirs = opp === "A" ? s.pendingRevealA : s.pendingRevealB;
    if (!mine || theirs)
      throw new Error("forfeit not claimable: opponent does not owe a reveal");
  } else {
    throw new Error("forfeit only valid during a pending draw");
  }
  return settle(s, by);
}

function randomSecret(rng: () => number): BlackjackSlotSecret {
  const b = () => Math.floor(rng() * 256) & 0xff;
  return {
    value: Uint8Array.from([b()]),
    salt: Uint8Array.from({ length: MIN_SALT_LEN }, b),
  };
}

/** Which seat owes the next move in the current phase (null if none/terminal-ish). */
export function actorFor(
  s: BlackjackState,
  playerPartyFor: PlayerPartyFor = getPlayerParty,
): Party | null {
  switch (s.phase) {
    case "round_over":
      return playerPartyFor(s.round + 1n);
    case "draw_commit":
      return !s.pendingCommitA ? "A" : !s.pendingCommitB ? "B" : null;
    case "draw_reveal":
      return !s.pendingRevealA ? "A" : !s.pendingRevealB ? "B" : null;
    case "player":
      return playerPartyFor(s.round);
  }
}

// ============================================
// PROTOCOL
// ============================================

export class BlackjackProtocol implements Protocol<
  BlackjackState,
  BlackjackMove
> {
  readonly name = "blackjack.v2";

  constructor(
    private readonly playerPartyFor: PlayerPartyFor = getPlayerParty,
  ) {}

  initialState(ctx: ProtocolContext): BlackjackState {
    const base: BlackjackState = {
      phase: "round_over",
      round: 0n,
      drawCount: 0n,
      playerHand: [],
      dealerHand: [],
      draw: null,
      pendingCommitA: null,
      pendingCommitB: null,
      pendingRevealA: null,
      pendingRevealB: null,
      localSecretA: null,
      localSecretB: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
      bet: 0n,
    };
    return base;
  }

  applyMove(
    state: BlackjackState,
    move: BlackjackMove,
    by: Party,
  ): BlackjackState {
    switch (state.phase) {
      case "round_over": {
        if (move.kind !== "bet")
          throw new Error(`expected 'bet' in round_over, got '${move.kind}'`);
        if (this.isTerminal(state))
          throw new Error("game over: no more rounds can be played");
        const nextPlayer = this.playerPartyFor(state.round + 1n);
        if (by !== nextPlayer)
          throw new Error(`only the player (${nextPlayer}) sets the bet`);
        const cap = maxBet(state);
        if (move.amount < MIN_BET || move.amount > cap)
          throw new Error(`bet must be in [${MIN_BET}, ${cap}]`);
        return beginRound({ ...state, bet: move.amount });
      }
      case "draw_commit": {
        if (move.kind === "forfeit") return claimForfeit(state, by);
        if (move.kind !== "commit")
          throw new Error(
            `expected 'commit' in draw_commit, got '${move.kind}'`,
          );
        return applyCommit(state, move, by);
      }
      case "draw_reveal": {
        if (move.kind === "forfeit") return claimForfeit(state, by);
        if (move.kind !== "reveal")
          throw new Error(
            `expected 'reveal' in draw_reveal, got '${move.kind}'`,
          );
        return applyReveal(state, move, by, this.playerPartyFor);
      }
      case "player": {
        const playerParty = this.playerPartyFor(state.round);
        if (by !== playerParty)
          throw new Error(`it is the player's (${playerParty}) turn`);
        if (move.kind === "hit")
          return beginDraw(state, { forHand: "player", reason: "hit" });
        if (move.kind === "stand") {
          // Dealer that is already pat (>= 17) draws nothing — settle immediately.
          if (handValue(state.dealerHand) >= DEALER_STANDS_AT)
            return resolveShowdown(state, this.playerPartyFor);
          return beginDraw(state, { forHand: "dealer", reason: "dealer_auto" });
        }
        throw new Error(
          `expected 'hit' or 'stand' in player phase, got '${move.kind}'`,
        );
      }
      default:
        throw new Error(`phase ${state.phase} not implemented`);
    }
  }

  encodeState(s: BlackjackState): Uint8Array {
    const parts: Uint8Array[] = [
      DOMAIN,
      u64ToBeBytes(s.balanceA),
      u64ToBeBytes(s.balanceB),
      u64ToBeBytes(s.round),
      u64ToBeBytes(s.drawCount),
      new Uint8Array([PHASE_CODE[s.phase]]),
      u64ToBeBytes(s.playerHand.length),
      Uint8Array.from(s.playerHand),
      u64ToBeBytes(s.dealerHand.length),
      Uint8Array.from(s.dealerHand),
      u64ToBeBytes(s.bet),
    ];
    if (s.draw === null) parts.push(new Uint8Array([0xff]));
    else
      parts.push(
        new Uint8Array([
          1,
          FORHAND_CODE[s.draw.forHand],
          REASON_CODE[s.draw.reason],
        ]),
      );
    parts.push(lengthPrefixedConcat([s.pendingCommitA ?? new Uint8Array(0)]));
    parts.push(lengthPrefixedConcat([s.pendingCommitB ?? new Uint8Array(0)]));
    for (const r of [s.pendingRevealA, s.pendingRevealB]) {
      if (r === null) parts.push(new Uint8Array([0]));
      else {
        parts.push(new Uint8Array([1]));
        parts.push(lengthPrefixedConcat([r.value]));
        parts.push(lengthPrefixedConcat([r.salt]));
      }
    }
    return concatBytes(parts);
  }

  balances(s: BlackjackState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: BlackjackState): boolean {
    if (s.round >= ROUND_CAP) return true;
    return s.phase === "round_over" && !canStartRound(s);
  }

  randomMove(
    s: BlackjackState,
    by: Party,
    rng: () => number,
  ): BlackjackMove | null {
    if (this.isTerminal(s)) return null;
    switch (s.phase) {
      case "round_over": {
        const nextPlayer = this.playerPartyFor(s.round + 1n);
        if (by !== nextPlayer) return null;
        if (maxBet(s) < MIN_BET) return null;
        return { kind: "bet", amount: MIN_BET };
      }
      case "draw_commit": {
        const mine = by === "A" ? s.pendingCommitA : s.pendingCommitB;
        if (mine) return null;
        const secret = randomSecret(rng);
        return {
          kind: "commit",
          commitment: computeCommitment(secret.value, secret.salt),
          localSecret: secret,
        };
      }
      case "draw_reveal": {
        const revealed = by === "A" ? s.pendingRevealA : s.pendingRevealB;
        if (revealed) return null;
        const secret = by === "A" ? s.localSecretA : s.localSecretB;
        if (!secret) return null;
        return { kind: "reveal", reveal: secret };
      }
      case "player": {
        if (by !== this.playerPartyFor(s.round)) return null;
        return {
          kind: blackjackHandValue(s.playerHand) < 17 ? "hit" : "stand",
        };
      }
    }
  }
}
