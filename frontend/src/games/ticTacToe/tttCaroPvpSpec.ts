/**
 * ttt/caro PvP worker specs (§13, STAGE 1 — play path; reuses {@link tttCaroPvpCore}). Builds a
 * real {@link GameSessionSpec} for each: the turn-from-state controller, the parameterized protocol
 * (board size + game cap via `setup`), the composite matchmaking key, and the bot.
 *
 * STAGE 2: registered in `PVP_SPECS` (via `defineGame`) and wired through the worker PvP hub by the
 * windowId-keyed `usePvpTicTacToeWorker` adapter. The match settles via the engine's generic
 * `cp.settle` (backend, settler-sponsored) — the same path the 4 in-scope PvP games use — not the
 * legacy winner-submit close. Per-game stake SHIFT is 0n (money-neutral); the funded per-seat stake
 * is the locked bank. NEEDS end-to-end verification: matchmaking against the bot on the composite
 * queue (`tictactoe:ttt` / `tictactoe:caro:N`) and the settle, which can't be checked headless.
 */
import { defineGame } from "@/engine/specs/defineGame";
import {
  MultiGameTicTacToeProtocol,
  type MultiGameTicTacToeState,
  type MultiGameTicTacToeMove,
} from "@ttt/shared/ttt/multiGameProtocol";
import {
  MultiGameCaroProtocol,
  type MultiGameCaroState,
  type MultiGameCaroMove,
  pickCaroMove,
  caroMoveCodec,
  tttMoveCodec,
} from "@ttt/shared";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
import type {
  GameSessionSpec,
  MatchController,
  MatchIo,
} from "@/engine/engineApi";
import {
  dueCell,
  freshSalt,
  withTopLevelWinner,
  type InnerTurnProtocol,
  type MultiTurnState,
  type WithWinner,
} from "./tttCaroPvpCore";

/** Optional setup payload (the `findMatch(setup)` arg): board size + game cap. */
export interface TurnGameSetup {
  boardSize?: number;
  maxGames?: number;
}

/** Render-ready PvP view (numeric winner, like the snapshot's top-level read). */
export interface TurnGameView {
  board: number[];
  size: number;
  turn: Party;
  winner: number;
  gamesPlayed: number;
  maxGames: number;
}

/** Per-game wiring the generic controller/factory needs. */
interface TurnGameCfg<State extends MultiTurnState, Move> {
  game: string;
  stake: bigint;
  /** Build the inner (unwrapped) protocol from setup; the factory wraps it for the top-level winner. */
  makeInner(setup: TurnGameSetup | undefined): InnerTurnProtocol<State, Move>;
  /** Composite matchmaking-queue key (mirrors the legacy `tictactoe:*` keys). */
  matchmakingKey(setup: TurnGameSetup | undefined): string;
  /** This seat's bot cell for the current state (called only when it's our turn). */
  botCell(state: WithWinner<State>, role: Party): number;
  deriveView(state: WithWinner<State>): TurnGameView;
  /** Wire codec matching the fleet bot's frame encoding. Without it the tunnel serializes moves as
   *  raw JSON and the Rust bot rejects the frame ("malformed frame: expected a string"). */
  moveCodec: MoveCodec<Move>;
}

/**
 * The turn-based MatchController: on every confirmed update (and on input / auto-toggle) it proposes
 * the DUE cell — `dueCell` reads whose turn it is from `state.inner.turn`, so it stays correct across
 * the per-game opener alternation that breaks the nonce-parity assumption of `makePublicStateSpec`.
 */
class TurnGamePvpController<
  State extends MultiTurnState,
  Move,
> implements MatchController<
  WithWinner<State>,
  Move,
  TurnGameSetup,
  number,
  TurnGameView
> {
  private queued: number | undefined;

  constructor(
    private readonly io: MatchIo<WithWinner<State>, Move>,
    private readonly cfg: TurnGameCfg<State, Move>,
  ) {}

  initSetup(): void {
    /* public-state: no secret; the board size is consumed by makeProtocol(setup), not here. */
  }

  onConfirmed(): void {
    this.proposeDue();
  }

  onInput(cell: number): void {
    this.queued = cell;
    this.proposeDue();
  }

  setAuto(): void {
    this.proposeDue();
  }

  deriveView(state: WithWinner<State>): TurnGameView {
    return this.cfg.deriveView(state);
  }

  dispose(): void {
    /* event-driven: no timers to clear */
  }

  private proposeDue(): void {
    const dt = this.io.tunnel();
    if (!dt) return;
    if (dt.displayState !== dt.state) return; // a proposal is mid-flight
    const cell = dueCell(dt.state, this.io.role, {
      auto: this.io.auto(),
      sessionTerminal: dt.protocol.isTerminal(dt.state),
      queuedCell: this.queued,
      botPick: () => this.cfg.botCell(dt.state, this.io.role),
    });
    if (cell === null) return;
    this.queued = undefined;
    try {
      dt.propose({ cell, salt: freshSalt() } as unknown as Move, 0n);
      this.io.emitView();
    } catch {
      /* proposal already pending or transient — safe to ignore */
    }
  }
}

function makeTurnGamePvpSpec<State extends MultiTurnState, Move>(
  cfg: TurnGameCfg<State, Move>,
): GameSessionSpec<
  WithWinner<State>,
  Move,
  TurnGameSetup,
  number,
  TurnGameView
> {
  return {
    game: cfg.game,
    stake: cfg.stake,
    makeProtocol: (setup) =>
      withTopLevelWinner(cfg.makeInner(setup as TurnGameSetup)),
    matchmakingKey: (setup) => cfg.matchmakingKey(setup as TurnGameSetup),
    moveCodec: cfg.moveCodec,
    createMatch: (io) => new TurnGamePvpController(io, cfg),
  };
}

// --- per-game wiring -------------------------------------------------------

// FE↔Rust parity: the fleet bot drives a SERIES of max_games=1 with per-seat stake=1 and a canonical
// 15×15 board (rust/fleet/core play_match.rs). These are baked into caro/ttt `encodeState`, so any
// drift breaks co-signing with a `state_hash mismatch`. Keep them equal to the bot's.
const TTT_GAMES = 1;
const TTT_STAKE = 1n;
const CARO_GAMES = 1;
const CARO_DEFAULT_BOARD = 15;
const CARO_STAKE = 1n;

function deriveView<
  S extends MultiTurnState & { inner: { board: number[]; size?: number } },
>(state: WithWinner<S>): TurnGameView {
  return {
    board: [...state.inner.board],
    size: state.inner.size ?? Math.round(Math.sqrt(state.inner.board.length)),
    turn: state.inner.turn,
    winner: state.winner,
    gamesPlayed: state.gamesPlayed,
    maxGames: state.maxGames,
  };
}

/** Tic-Tac-Toe PvP (3×3). Bot moves come from the protocol's own `randomMove`. */
export const tttPvpSpec = defineGame(
  makeTurnGamePvpSpec<MultiGameTicTacToeState, MultiGameTicTacToeMove>({
    game: "tictactoe",
    stake: TTT_STAKE,
    makeInner: (setup) =>
      new MultiGameTicTacToeProtocol(
        setup?.maxGames ?? TTT_GAMES,
        TTT_STAKE,
      ) as unknown as InnerTurnProtocol<
        MultiGameTicTacToeState,
        MultiGameTicTacToeMove
      >,
    matchmakingKey: () => "tictactoe:ttt",
    moveCodec: tttMoveCodec as unknown as MoveCodec<MultiGameTicTacToeMove>,
    botCell: (state, role) => {
      const mg = new MultiGameTicTacToeProtocol(state.maxGames, 0n);
      const m = mg.randomMove(state, role, Math.random);
      return m ? m.cell : state.inner.board.findIndex((c) => c === 0);
    },
    deriveView: (s) => deriveView(s),
  }),
);

/** Caro PvP (board size from setup, default 15). Bot moves come from the `pickCaroMove` heuristic. */
export const caroPvpSpec = defineGame(
  makeTurnGamePvpSpec<MultiGameCaroState, MultiGameCaroMove>({
    game: "caro",
    stake: CARO_STAKE,
    makeInner: (setup) =>
      new MultiGameCaroProtocol(
        setup?.maxGames ?? CARO_GAMES,
        setup?.boardSize ?? CARO_DEFAULT_BOARD,
        CARO_STAKE,
      ) as unknown as InnerTurnProtocol<MultiGameCaroState, MultiGameCaroMove>,
    matchmakingKey: (setup) =>
      `tictactoe:caro:${setup?.boardSize ?? CARO_DEFAULT_BOARD}`,
    moveCodec: caroMoveCodec as unknown as MoveCodec<MultiGameCaroMove>,
    botCell: (state, role) =>
      pickCaroMove(state.inner, role, Math.random, "strong"),
    deriveView: (s) => deriveView(s),
  }),
);
