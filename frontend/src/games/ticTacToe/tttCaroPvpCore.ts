/**
 * Pure, React-free core for ttt/caro PvP on the worker engine (§13, STAGE 1 — play/turn logic only).
 * Only TYPE imports; the inner protocol + bot are INJECTED, so this stays unit-testable on its own.
 *
 * WHY THESE TWO PIECES. ttt/caro do NOT fit `makePublicStateSpec`:
 *  1. `makePublicStateSpec` decides whose turn it is from NONCE PARITY (A even, B odd). ttt/caro
 *     ALTERNATE the opening side each game (`seriesOpener`), so parity ≠ turn after game 0. The
 *     mover must be read from `state.inner.turn`. {@link dueCell} encodes that.
 *  2. The worker snapshot reads a TOP-LEVEL `dt.state.winner` (pvpMatchSession), but the multi-game
 *     state nests it at `inner.winner`. {@link withTopLevelWinner} surfaces it while delegating every
 *     rule to the inner protocol, so the co-signed state hash stays byte-identical (same trick as the
 *     solo wrapper).
 *
 * NOT in stage 1 (needs end-to-end browser+backend verification — a bug here loses stake): the
 * winner-submits + requeue settle policy, the windowId-keyed PvP hook, the UI flip, and registration
 * in PVP_SPECS. These specs are therefore built and tested but DELIBERATELY NOT registered/wired.
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

/** The minimal protocol surface the wrapper delegates to (structurally satisfied by the SDK's
 *  `MultiGameTicTacToeProtocol` / `MultiGameCaroProtocol`). */
export interface InnerTurnProtocol<State, Move> {
  readonly name: string;
  initialState(ctx: {
    tunnelId: string;
    initialBalances: { a: bigint; b: bigint };
  }): State;
  applyMove(state: State, move: Move, by: Party): State;
  encodeState(state: State): Uint8Array;
  isTerminal(state: State): boolean;
  balances(state: State): { a: bigint; b: bigint };
  randomMove?(state: State, by: Party, rng: () => number): Move | null;
}

/** The multi-game state shape the engine/snapshot needs (the SDK states satisfy this structurally,
 *  with extra fields like caro's `size`/`lastMove` carried through untouched). */
export interface MultiTurnState {
  inner: { winner: number; turn: Party };
  gamesPlayed: number;
  maxGames: number;
}

/** The inner state with a TOP-LEVEL `winner` mirror, so `dt.state.winner` (pvpMatchSession's
 *  snapshot read) and `GameSessionSpec`'s `State extends { winner }` are both satisfied. */
export type WithWinner<State> = State & { winner: number };

/**
 * Wrap a multi-game protocol so its state carries a top-level numeric `winner` (= `inner.winner`).
 * Every rule delegates to `inner` — `encodeState`/`isTerminal`/`balances`/`applyMove` run on the
 * unwrapped form (the extra top-level field is ignored by the inner protocol), so the on-chain state
 * hash is byte-identical to the canonical protocol. Only the snapshot/type surface changes.
 */
export function withTopLevelWinner<State extends MultiTurnState, Move>(
  inner: InnerTurnProtocol<State, Move>,
): InnerTurnProtocol<WithWinner<State>, Move> {
  const surface = (s: State): WithWinner<State> => ({
    ...s,
    winner: s.inner.winner,
  });
  return {
    name: inner.name,
    initialState: (ctx) => surface(inner.initialState(ctx)),
    applyMove: (s, m, by) => surface(inner.applyMove(s, m, by)),
    encodeState: (s) => inner.encodeState(s),
    isTerminal: (s) => inner.isTerminal(s),
    balances: (s) => inner.balances(s),
    randomMove: inner.randomMove
      ? (s, by, rng) => inner.randomMove!(s, by, rng)
      : undefined,
  };
}

/** Inputs to the turn decision (the controller supplies these from the live tunnel + io). */
export interface DueCellOpts {
  /** Autopilot on for this seat (bot drives) vs. manual (only a queued human cell proposes). */
  auto: boolean;
  /** The whole SESSION is terminal (max games / unfundable) → settle, never propose. */
  sessionTerminal: boolean;
  /** A human-queued cell for this seat (manual play), or undefined. */
  queuedCell: number | undefined;
  /** The seat's bot move for the current inner state (called only when it's our turn, auto). */
  botPick: () => number;
}

/**
 * Decide the cell THIS seat should propose now, or `null` to wait. The single source of ttt/caro's
 * turn rule:
 *  - session terminal → `null` (the caller settles, never proposes);
 *  - inner game decided but session continues → only seat A advances to the next game (any cell is
 *    an "advance" trigger; the protocol resets the board), so A returns 0, B waits;
 *  - inner game live and it's OUR turn → the bot's cell (auto) or the queued human cell (manual,
 *    `null` until one is queued);
 *  - otherwise (opponent's turn) → `null`.
 */
export function dueCell(
  state: MultiTurnState,
  myRole: Party,
  opts: DueCellOpts,
): number | null {
  if (opts.sessionTerminal) return null;
  const inner = state.inner;
  if (inner.winner !== 0) {
    // Inner game decided, session continues: seat A drives the between-game advance.
    return myRole === "A" ? 0 : null;
  }
  if (inner.turn !== myRole) return null; // opponent's turn
  if (opts.auto) return opts.botPick();
  return opts.queuedCell ?? null; // manual: propose only a queued human cell
}

/** A fresh 16-byte commit-reveal salt (ttt/caro `Move` requires one — the protocol hashes it). */
export function freshSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}
