/**
 * Battleship protocol (v2): a two-party staked game over a tunnel with hidden
 * fleets and a SINGLE board-hash commitment (no Merkle tree). Co-signed state is
 * PUBLIC ONLY — each side's board commitment plus the revealed shot results —
 * never the secret board, so two PvP clients holding different boards hash the
 * same bytes. Fairness: each side commits `computeCommitment(board, salt)` once;
 * every shot is answered live with a hit/miss bool; a mandatory terminal
 * `reveal_board` verifies the commitment, that the board is a LEGAL fleet, and
 * that every prior answer is consistent. A lie, an illegal fleet, or a refusal
 * is caught at the reveal and settled via the on-chain dispute + timeout-penalty
 * path. Turn rule: a HIT keeps the shooter's turn; a MISS passes it (and the
 * defender pipelines its return shot in the same `answer`). See the design spec.
 */
import { concatBytes } from "../core/bytes";
import { computeCommitment, verifyCommitment } from "../core/commitment";
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
import { BATTLESHIP_CELL_COUNT, FLEET_CELLS, isLegalBoard } from "./battleshipFleet";

export type BattleshipWinner = 0 | 1 | 2;
export type BattleshipPhase =
  | "awaitingCommits"
  | "playing"
  | "revealBoards"
  | "over";

export interface BattleshipShotResult {
  cell: number;
  isHit: boolean;
}

export interface BattleshipState {
  phase: BattleshipPhase;
  /** Whose turn it is to fire. A fires first; a hit keeps the turn. */
  turn: Party;
  /** A fired shot awaiting the defender's answer, or null between shots. */
  pendingShot: { by: Party; cell: number } | null;
  /** 32-byte board commitments; null until that party commits. */
  commitA: Uint8Array | null;
  commitB: Uint8Array | null;
  /** Shots fired at A's board (by B), and at B's board (by A), in order. */
  shotsAtA: BattleshipShotResult[];
  shotsAtB: BattleshipShotResult[];
  hitsOnA: number;
  hitsOnB: number;
  /** Set once that party's terminal board reveal verifies. */
  revealedA: boolean;
  revealedB: boolean;
  winner: BattleshipWinner;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  /** Amount shifted loser -> winner on a decisive result. */
  stake: bigint;
}

export type BattleshipMove =
  | { kind: "commit"; commitment: Uint8Array }
  | { kind: "shoot"; cell: number }
  | { kind: "answer"; isHit: boolean; next?: number }
  | { kind: "reveal_board"; board: Uint8Array; salt: Uint8Array }
  | { kind: "resign" };

const DOMAIN = protocolDomain("battleship.v2");
const COMMIT_BYTES = 32;

// `encodeState` packs each cell index (and the per-board hit counts) into a single
// byte. That is exact at 10x10 (cells 0..99, fleet 17 hits), but a larger board or
// fleet would silently truncate and collide co-signed state hashes. Fail loudly at
// load instead — the wire format must grow to wider integers before the board does.
if (BATTLESHIP_CELL_COUNT > 256 || FLEET_CELLS > 255) {
  throw new Error(
    `battleship wire format assumes <=256 cells and <=255 fleet hits; ` +
      `got ${BATTLESHIP_CELL_COUNT} cells, ${FLEET_CELLS} fleet cells`,
  );
}

const PHASE_CODE: Record<BattleshipPhase, number> = {
  awaitingCommits: 0,
  playing: 1,
  revealBoards: 2,
  over: 3,
};

function commitFor(s: BattleshipState, p: Party): Uint8Array | null {
  return p === "A" ? s.commitA : s.commitB;
}
/** Shots already fired at `defender`'s board. */
function shotsAt(s: BattleshipState, defender: Party): BattleshipShotResult[] {
  return defender === "A" ? s.shotsAtA : s.shotsAtB;
}
/** Open (un-fired) cells `shooter` may still target on the opponent's board. */
function openCells(s: BattleshipState, shooter: Party): number {
  return BATTLESHIP_CELL_COUNT - shotsAt(s, otherParty(shooter)).length;
}
function assertShootable(
  s: BattleshipState,
  shooter: Party,
  cell: number,
): void {
  if (!Number.isInteger(cell) || cell < 0 || cell >= BATTLESHIP_CELL_COUNT) {
    throw new Error(`cell out of range: ${cell}`);
  }
  if (shotsAt(s, otherParty(shooter)).some((x) => x.cell === cell)) {
    throw new Error(`already fired at cell ${cell}`);
  }
}

export class BattleshipProtocol implements Protocol<
  BattleshipState,
  BattleshipMove
> {
  readonly name = "battleship.v2";
  private readonly defaultStake: bigint;

  constructor(stake: bigint = 100n) {
    if (stake < 0n) throw new Error("stake must be non-negative");
    this.defaultStake = stake;
  }

  initialState(ctx: ProtocolContext): BattleshipState {
    const total = ctx.initialBalances.a + ctx.initialBalances.b;
    const cap =
      ctx.initialBalances.a < ctx.initialBalances.b
        ? ctx.initialBalances.a
        : ctx.initialBalances.b;
    const stake = this.defaultStake < cap ? this.defaultStake : cap;
    return {
      phase: "awaitingCommits",
      turn: "A",
      pendingShot: null,
      commitA: null,
      commitB: null,
      shotsAtA: [],
      shotsAtB: [],
      hitsOnA: 0,
      hitsOnB: 0,
      revealedA: false,
      revealedB: false,
      winner: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total,
      stake,
    };
  }

  applyMove(
    state: BattleshipState,
    move: BattleshipMove,
    by: Party,
  ): BattleshipState {
    if (state.phase === "over" || state.winner !== 0) {
      throw new Error("game already over");
    }
    switch (move.kind) {
      case "commit":
        return this.applyCommit(state, move.commitment, by);
      case "shoot":
        return this.applyShoot(state, move.cell, by);
      case "answer":
        return this.applyAnswer(state, move, by);
      case "reveal_board":
        return this.applyRevealBoard(state, move.board, move.salt, by);
      case "resign":
        return this.settle(state, by === "A" ? 2 : 1);
      default:
        throw new Error(`move not handled yet: ${(move as { kind: string }).kind}`);
    }
  }

  private applyCommit(
    state: BattleshipState,
    commitment: Uint8Array,
    by: Party,
  ): BattleshipState {
    if (state.phase !== "awaitingCommits")
      throw new Error("commits are closed");
    if (commitment.length !== COMMIT_BYTES)
      throw new Error(`commitment must be ${COMMIT_BYTES} bytes`);
    if (state.commitA === null) {
      if (by !== "A") throw new Error("A commits first");
    } else if (state.commitB === null) {
      if (by !== "B") throw new Error("B commits second");
    } else {
      throw new Error("both fleets already committed");
    }
    const next: BattleshipState = {
      ...state,
      commitA: by === "A" ? commitment.slice() : state.commitA,
      commitB: by === "B" ? commitment.slice() : state.commitB,
    };
    if (next.commitA !== null && next.commitB !== null) {
      next.phase = "playing";
      next.turn = "A";
    }
    return next;
  }

  private applyShoot(
    state: BattleshipState,
    cell: number,
    by: Party,
  ): BattleshipState {
    if (state.phase !== "playing") throw new Error("not in the firing phase");
    if (state.pendingShot) throw new Error("awaiting the previous answer");
    if (by !== state.turn) throw new Error(`not ${by}'s turn`);
    assertShootable(state, by, cell);
    return { ...state, pendingShot: { by, cell } };
  }

  private applyAnswer(
    state: BattleshipState,
    move: { isHit: boolean; next?: number },
    by: Party,
  ): BattleshipState {
    const pending = state.pendingShot;
    if (state.phase !== "playing" || !pending)
      throw new Error("no shot to answer");
    const defender = otherParty(pending.by);
    if (by !== defender) throw new Error("only the defender answers");
    if (move.next !== undefined && move.isHit)
      throw new Error("a hit keeps the shooter's turn; defender cannot fire");

    // Record against the DEFENDER's own board.
    const result: BattleshipShotResult = {
      cell: pending.cell,
      isHit: move.isHit,
    };
    const shotsAtA =
      defender === "A" ? [...state.shotsAtA, result] : state.shotsAtA;
    const shotsAtB =
      defender === "B" ? [...state.shotsAtB, result] : state.shotsAtB;
    const hitsOnA =
      defender === "A" && move.isHit ? state.hitsOnA + 1 : state.hitsOnA;
    const hitsOnB =
      defender === "B" && move.isHit ? state.hitsOnB + 1 : state.hitsOnB;

    const next: BattleshipState = {
      ...state,
      shotsAtA,
      shotsAtB,
      hitsOnA,
      hitsOnB,
      pendingShot: null,
    };

    // The shooter sank the defender's fleet -> settle by reveal.
    const defenderHits = defender === "A" ? hitsOnA : hitsOnB;
    if (defenderHits >= FLEET_CELLS) {
      next.phase = "revealBoards";
      return next;
    }

    const shooter = pending.by;
    if (move.isHit) {
      next.turn = shooter; // hit keeps the turn
      if (openCells(next, shooter) === 0) next.phase = "revealBoards";
      return next;
    }
    // miss -> turn passes to the defender
    next.turn = defender;
    if (move.next !== undefined) {
      assertShootable(next, defender, move.next);
      next.pendingShot = { by: defender, cell: move.next };
      return next;
    }
    if (openCells(next, defender) === 0) next.phase = "revealBoards";
    return next;
  }

  private applyRevealBoard(
    state: BattleshipState,
    board: Uint8Array,
    salt: Uint8Array,
    by: Party,
  ): BattleshipState {
    if (state.phase !== "revealBoards")
      throw new Error("not in the reveal phase");
    const already = by === "A" ? state.revealedA : state.revealedB;
    if (already) throw new Error("already revealed");
    const commit = commitFor(state, by);
    if (!commit) throw new Error("party has not committed");
    if (!verifyCommitment(commit, board, salt))
      throw new Error("reveal does not match the commitment");
    if (!isLegalBoard(board))
      throw new Error("revealed board is not a legal fleet");
    for (const shot of shotsAt(state, by)) {
      const isShip = board[shot.cell] === 1;
      if (isShip !== shot.isHit)
        throw new Error(`reveal contradicts answered shot at ${shot.cell}`);
    }
    const next: BattleshipState = {
      ...state,
      revealedA: by === "A" ? true : state.revealedA,
      revealedB: by === "B" ? true : state.revealedB,
    };
    if (next.revealedA && next.revealedB) return this.finalize(next);
    return next;
  }

  /** Decide the winner once BOTH boards are verified legal + consistent. */
  private finalize(state: BattleshipState): BattleshipState {
    let winner: BattleshipWinner;
    const aSunk = state.hitsOnA >= FLEET_CELLS;
    const bSunk = state.hitsOnB >= FLEET_CELLS;
    if (bSunk && !aSunk) winner = 1;
    else if (aSunk && !bSunk) winner = 2;
    else if (state.hitsOnB > state.hitsOnA) winner = 1;
    else if (state.hitsOnA > state.hitsOnB) winner = 2;
    else winner = 0; // push (equal hits at shot-cap)
    return this.settle(state, winner);
  }

  /** Apply a decisive (or push) result: shift `stake` loser -> winner, end. */
  private settle(
    state: BattleshipState,
    winner: BattleshipWinner,
  ): BattleshipState {
    let { balanceA, balanceB } = state;
    if (winner !== 0) {
      const loserBal = winner === 1 ? balanceB : balanceA;
      const shift = state.stake < loserBal ? state.stake : loserBal;
      if (winner === 1) {
        balanceA += shift;
        balanceB -= shift;
      } else {
        balanceA -= shift;
        balanceB += shift;
      }
    }
    return { ...state, winner, balanceA, balanceB, phase: "over" };
  }

  /**
   * Only the secret-free `shoot` move can come from public state (`commit`,
   * `answer`, `reveal_board` all need the fleet the protocol does not hold), so
   * self-play is driven by `battleshipSelfPlay`, not this method. Returns a legal
   * shot when it is `by`'s turn to fire, else null.
   */
  randomMove(
    state: BattleshipState,
    by: Party,
    rng: () => number,
  ): BattleshipMove | null {
    if (state.phase !== "playing" || state.pendingShot || by !== state.turn)
      return null;
    const fired = new Set(shotsAt(state, otherParty(by)).map((x) => x.cell));
    const open: number[] = [];
    for (let cell = 0; cell < BATTLESHIP_CELL_COUNT; cell++)
      if (!fired.has(cell)) open.push(cell);
    if (open.length === 0) return null;
    const idx = Math.min(open.length - 1, Math.floor(rng() * open.length));
    return { kind: "shoot", cell: open[idx] };
  }

  encodeState(state: BattleshipState): Uint8Array {
    const pend = state.pendingShot;
    const fixed = Uint8Array.of(
      PHASE_CODE[state.phase],
      state.turn === "A" ? 0 : 1,
      pend ? 1 : 0,
      pend ? (pend.by === "A" ? 0 : 1) : 0,
      pend ? pend.cell : 0,
      state.hitsOnA,
      state.hitsOnB,
      state.revealedA ? 1 : 0,
      state.revealedB ? 1 : 0,
      state.winner,
    );
    const shotBytes = (shots: BattleshipShotResult[]): Uint8Array => {
      const out = new Uint8Array(shots.length * 2);
      for (let i = 0; i < shots.length; i++) {
        // One byte per cell index — guarded by the load-time invariant above.
        out[i * 2] = shots[i].cell;
        out[i * 2 + 1] = shots[i].isHit ? 1 : 0;
      }
      return out;
    };
    const empty = new Uint8Array(0);
    return concatBytes([
      DOMAIN,
      fixed,
      lengthPrefixedConcat([
        state.commitA ?? empty,
        state.commitB ?? empty,
        shotBytes(state.shotsAtA),
        shotBytes(state.shotsAtB),
      ]),
      u64ToBeBytes(state.balanceA),
      u64ToBeBytes(state.balanceB),
      u64ToBeBytes(state.stake),
    ]);
  }

  balances(state: BattleshipState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: BattleshipState): boolean {
    // "over" is reached only via settle/finalize/resign, so it is the sole
    // terminal signal — including a push (winner 0), which is still settled.
    return state.phase === "over";
  }
}
