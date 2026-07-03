/**
 * Battleship protocol: a two-party staked game over a tunnel, with hidden fleets.
 *
 * Unlike TicTacToe, the co-signed state is PUBLIC ONLY — board commitments and
 * revealed shot results — never the secret fleets. `encodeState` therefore
 * hashes the same bytes on both clients even though each holds a different
 * secret board. Fairness comes from commit-reveal: each side commits a Merkle
 * root at placement, and every shot is answered by a `reveal` whose Merkle proof
 * is verified here against that root, so a peer cannot advance state with a lie.
 * See ADR 0003.
 *
 * Flow: A commits, B commits (phase -> playing), then players alternate
 * shoot/reveal. A shot sets `pendingShot`; the defender's matching `reveal`
 * records the hit/miss and passes the turn. A player loses when all
 * {@link FLEET_CELLS} of their cells have been revealed as hits; `stake` then
 * shifts loser -> winner (clamped), keeping balances summed to the locked total.
 */

import {
  bytesEqual,
  concatBytes,
  fromHex,
  toHex,
} from "sui-tunnel-ts/core/bytes";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
import { u64ToBeBytes } from "sui-tunnel-ts/core/wire";
import {
  Balances,
  Party,
  Protocol,
  ProtocolContext,
  lengthPrefixedConcat,
  otherParty,
  protocolDomain,
} from "sui-tunnel-ts/protocol/Protocol";
import { CELL_COUNT, FLEET_CELLS, isLegalBoard } from "../engine/fleet";
import { SALT_BYTES, commitBoard, verifyCell } from "../engine/merkle";

/** Winner codes: 0 none, 1 A, 2 B. (Battleship has no draw.) */
export type Winner = 0 | 1 | 2;
export type Phase =
  | "awaitingCommits"
  | "playing"
  | "awaitingBoardReveal"
  | "over";

export interface ShotResult {
  cell: number;
  isHit: boolean;
}

export interface BattleshipState {
  phase: Phase;
  /** Whose turn it is to fire. A always fires first. */
  turn: Party;
  /** A fired shot awaiting the defender's reveal, or null between turns. */
  pendingShot: { by: Party; cell: number } | null;
  /** 32-byte Merkle roots; null until that party has committed its fleet. */
  commitA: Uint8Array | null;
  commitB: Uint8Array | null;
  /** Shots fired at A's board (by B), and at B's board (by A), in order. */
  shotsAtA: ShotResult[];
  shotsAtB: ShotResult[];
  /** Confirmed hits on each fleet; a player loses at FLEET_CELLS. */
  hitsOnA: number;
  hitsOnB: number;
  winner: Winner;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  /** Amount shifted loser -> winner on a decisive result. */
  stake: bigint;
}

export type BattleshipMove =
  | { type: "commit"; root: Uint8Array }
  | { type: "shoot"; cell: number }
  | {
      type: "reveal";
      cell: number;
      isShip: boolean;
      salt: Uint8Array;
      proof: Uint8Array[];
    }
  // Terminal proof: the party that sank the opponent reveals its OWN full board so
  // the protocol can re-derive the commitment and check the fleet is legal.
  | { type: "reveal_board"; cells: Uint8Array; salts: Uint8Array[] };

const DOMAIN = protocolDomain("battleship.v1");
const COMMIT_BYTES = 32;

const PHASE_CODE: Record<Phase, number> = {
  awaitingCommits: 0,
  playing: 1,
  over: 2,
  awaitingBoardReveal: 3,
};

function commitFor(state: BattleshipState, party: Party): Uint8Array | null {
  return party === "A" ? state.commitA : state.commitB;
}

/**
 * The seat that must reveal its board to finalize a win, or null when no reveal is
 * owed. The prospective winner is whoever sank the opponent's whole fleet; gating
 * on its OWN board's legality is what blocks an unsinkable all-water commitment.
 */
export function pendingBoardReveal(state: BattleshipState): Party | null {
  if (state.phase !== "awaitingBoardReveal") return null;
  if (state.hitsOnB === FLEET_CELLS) return "A";
  if (state.hitsOnA === FLEET_CELLS) return "B";
  return null;
}

/** Move `stake` from the loser to the winner, clamped so a balance never goes negative. */
function shiftStake(
  state: BattleshipState,
  winner: Winner,
): { balanceA: bigint; balanceB: bigint } {
  let { balanceA, balanceB } = state;
  if (winner === 0) return { balanceA, balanceB };
  const loserBal = winner === 1 ? balanceB : balanceA;
  const shift = state.stake < loserBal ? state.stake : loserBal;
  if (winner === 1) {
    balanceA += shift;
    balanceB -= shift;
  } else {
    balanceA -= shift;
    balanceB += shift;
  }
  return { balanceA, balanceB };
}

/** Shots already fired at `defender`'s board. */
function shotsAt(state: BattleshipState, defender: Party): ShotResult[] {
  return defender === "A" ? state.shotsAtA : state.shotsAtB;
}

export class BattleshipProtocol implements Protocol<
  BattleshipState,
  BattleshipMove
> {
  readonly name = "battleship.v1";

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
    switch (move.type) {
      case "commit":
        return this.applyCommit(state, move.root, by);
      case "shoot":
        return this.applyShoot(state, move.cell, by);
      case "reveal":
        return this.applyReveal(state, move, by);
      case "reveal_board":
        return this.applyRevealBoard(state, move, by);
      default: {
        const exhaustive: never = move;
        throw new Error(`unknown move: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private applyCommit(
    state: BattleshipState,
    root: Uint8Array,
    by: Party,
  ): BattleshipState {
    if (state.phase !== "awaitingCommits")
      throw new Error("commits are closed");
    if (root.length !== COMMIT_BYTES) {
      throw new Error(`commitment must be ${COMMIT_BYTES} bytes`);
    }
    // Commits are ordered A then B, matching the co-sign one-proposal-at-a-time model.
    if (state.commitA === null) {
      if (by !== "A") throw new Error("A commits first");
    } else if (state.commitB === null) {
      if (by !== "B") throw new Error("B commits second");
    } else {
      throw new Error("both fleets already committed");
    }

    const next: BattleshipState = {
      ...state,
      commitA: by === "A" ? root.slice() : state.commitA,
      commitB: by === "B" ? root.slice() : state.commitB,
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
    if (state.pendingShot)
      throw new Error("awaiting the previous shot's reveal");
    if (by !== state.turn) throw new Error(`not ${by}'s turn`);
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) {
      throw new Error(`cell out of range: ${cell}`);
    }
    const defender = otherParty(by);
    if (shotsAt(state, defender).some((s) => s.cell === cell)) {
      throw new Error(`already fired at cell ${cell}`);
    }
    return { ...state, pendingShot: { by, cell } };
  }

  private applyReveal(
    state: BattleshipState,
    move: Extract<BattleshipMove, { type: "reveal" }>,
    by: Party,
  ): BattleshipState {
    const pending = state.pendingShot;
    if (state.phase !== "playing" || !pending)
      throw new Error("no shot to reveal");
    // The defender (the party that was shot at) reveals their own cell.
    if (by !== otherParty(pending.by))
      throw new Error("only the defender reveals");
    if (move.cell !== pending.cell)
      throw new Error("reveal must answer the pending shot");
    if (move.salt.length !== SALT_BYTES) throw new Error("bad salt length");

    const commit = commitFor(state, by);
    if (!commit) throw new Error("defender has not committed");
    if (!verifyCell(commit, move.cell, move.isShip, move.salt, move.proof)) {
      throw new Error("reveal proof does not match the committed board");
    }

    const result: ShotResult = { cell: move.cell, isHit: move.isShip };
    const shotsAtA = by === "A" ? [...state.shotsAtA, result] : state.shotsAtA;
    const shotsAtB = by === "B" ? [...state.shotsAtB, result] : state.shotsAtB;
    const hitsOnA =
      by === "A" && move.isShip ? state.hitsOnA + 1 : state.hitsOnA;
    const hitsOnB =
      by === "B" && move.isShip ? state.hitsOnB + 1 : state.hitsOnB;

    // Sinking a fleet no longer decides the game: the prospective winner must reveal
    // a legal board matching its commitment (applyRevealBoard) before the stake moves.
    // Until then balances stay even, so a stalled/illegal winner can never profit.
    const fleetDestroyed = hitsOnB === FLEET_CELLS || hitsOnA === FLEET_CELLS;

    return {
      ...state,
      shotsAtA,
      shotsAtB,
      hitsOnA,
      hitsOnB,
      phase: fleetDestroyed ? "awaitingBoardReveal" : "playing",
      // Clear the pending shot. On a normal reveal the defender fires next; on the
      // sinking reveal the prospective winner owes the board reveal, so turn is theirs.
      pendingShot: null,
      turn: fleetDestroyed ? otherParty(by) : by,
    };
  }

  private applyRevealBoard(
    state: BattleshipState,
    move: Extract<BattleshipMove, { type: "reveal_board" }>,
    by: Party,
  ): BattleshipState {
    const winnerSeat = pendingBoardReveal(state);
    if (!winnerSeat) throw new Error("no board reveal is due");
    if (by !== winnerSeat)
      throw new Error("only the prospective winner reveals its board");
    if (move.cells.length !== CELL_COUNT)
      throw new Error(`board must be ${CELL_COUNT} cells`);
    if (move.salts.length !== CELL_COUNT)
      throw new Error(`need ${CELL_COUNT} salts`);

    const commit = commitFor(state, by)!;
    const root = commitBoard(move.cells, move.salts).root;
    if (!bytesEqual(root, commit))
      throw new Error("revealed board does not match the commitment");

    // The win stands only if the winner's own committed fleet is legal; an illegal
    // fleet (e.g. all-water to be unsinkable) forfeits the stake to the opponent.
    const winner: Winner = isLegalBoard(move.cells)
      ? winnerSeat === "A"
        ? 1
        : 2
      : winnerSeat === "A"
        ? 2
        : 1;
    const { balanceA, balanceB } = shiftStake(state, winner);
    return { ...state, winner, balanceA, balanceB, phase: "over" };
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
      state.winner,
    );
    const shotBytes = (shots: ShotResult[]): Uint8Array => {
      const out = new Uint8Array(shots.length * 2);
      for (let i = 0; i < shots.length; i++) {
        out[i * 2] = shots[i].cell;
        out[i * 2 + 1] = shots[i].isHit ? 1 : 0;
      }
      return out;
    };
    const empty = new Uint8Array(0);
    return concatBytes([
      DOMAIN,
      fixed,
      // Length-prefixed so the variable-length parts have unambiguous boundaries.
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
    return state.winner !== 0;
  }

  /**
   * Only the secret-free `shoot` move can be produced from public state. `commit`
   * and `reveal` require the fleet secrets the protocol deliberately does not
   * hold, so self-play is driven by the session (which owns both fleets), not by
   * this method. Returns null when it is not `by`'s turn to fire. See ADR 0003.
   */
  randomMove(
    state: BattleshipState,
    by: Party,
    rng: () => number,
  ): BattleshipMove | null {
    if (state.phase !== "playing" || state.pendingShot || by !== state.turn) {
      return null;
    }
    const fired = new Set(shotsAt(state, otherParty(by)).map((s) => s.cell));
    const open: number[] = [];
    for (let cell = 0; cell < CELL_COUNT; cell++)
      if (!fired.has(cell)) open.push(cell);
    if (open.length === 0) return null;
    const idx = Math.min(open.length - 1, Math.floor(rng() * open.length));
    return { type: "shoot", cell: open[idx] };
  }
}

/** A move byte-field that MAY arrive hex-encoded (an FE peer, or a `wire_hex` bot field) OR as a raw
 *  JSON byte array. The Rust bot serializes `reveal_board`'s `cells: Vec<u8>` / `salts: Vec<[u8;32]>`
 *  WITHOUT the `wire_hex` attribute its other move fields carry, so they land as `[0,1,…]` rather than
 *  `"0x…"`. Tolerating both keeps the terminal board reveal from throwing (`hex.startsWith is not a
 *  function`) inside the frame decode — a throw that in the worker kills the whole frame pump. */
function hexOrBytes(v: string | number[] | undefined): Uint8Array {
  if (v == null) return new Uint8Array();
  return typeof v === "string" ? fromHex(v) : Uint8Array.from(v);
}

/**
 * Move (de)serializer for the PvP relay. The frame envelope is JSON, which can't
 * carry the move's binary fields (commit root, salt, Merkle proof) — those are
 * hex-encoded here and restored on the far side. Pass as the tunnel's `moveCodec`.
 */
export const battleshipMoveCodec: MoveCodec<BattleshipMove> = {
  encode(m) {
    if (m.type === "commit") return { type: "commit", root: toHex(m.root) };
    if (m.type === "shoot") return { type: "shoot", cell: m.cell };
    if (m.type === "reveal_board")
      return {
        type: "reveal_board",
        cells: toHex(m.cells),
        salts: m.salts.map(toHex),
      };
    return {
      type: "reveal",
      cell: m.cell,
      isShip: m.isShip,
      salt: toHex(m.salt),
      proof: m.proof.map(toHex),
    };
  },
  decode(j) {
    const o = j as {
      type: string;
      root?: string;
      cell?: number;
      isShip?: boolean;
      salt?: string;
      proof?: string[];
      cells?: string | number[];
      salts?: (string | number[])[];
    };
    if (o.type === "commit") return { type: "commit", root: fromHex(o.root!) };
    if (o.type === "shoot") return { type: "shoot", cell: o.cell! };
    if (o.type === "reveal")
      return {
        type: "reveal",
        cell: o.cell!,
        isShip: o.isShip!,
        salt: fromHex(o.salt!),
        proof: (o.proof ?? []).map(fromHex),
      };
    if (o.type === "reveal_board")
      return {
        type: "reveal_board",
        cells: hexOrBytes(o.cells),
        salts: (o.salts ?? []).map(hexOrBytes),
      };
    throw new Error(`unknown battleship move: ${o.type}`);
  },
};
