/**
 * Self-play driver: turns two known fleets into a stream of protocol moves.
 *
 * The protocol holds only public state, so it cannot produce `commit`/`reveal`
 * moves (those need the secret fleet). In vs-bot mode one process owns BOTH
 * fleets, so this driver computes the next move for whichever seat must act —
 * committing roots, answering shots with truthful reveals + Merkle proofs, and
 * firing the bot's chosen shot (strategy lives in `bot.ts`). The session hook
 * (M1) calls this on a timer and feeds each move to `OffchainTunnel.step`. See
 * ADR 0003.
 */

import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { otherParty } from "sui-tunnel-ts/protocol/Protocol";
import {
  type BattleshipMove,
  BattleshipProtocol,
  type BattleshipState,
  pendingBoardReveal,
} from "../protocol/battleship";
import {
  BOT_CONFIGS,
  type BotDifficulty,
  DEFAULT_BOT_DIFFICULTY,
  pickShot,
} from "./bot";
import {
  CELL_COUNT,
  placeFleetRandom,
  placementsToBoard,
  type Placement,
} from "./fleet";
import {
  type BoardCommitment,
  SALT_BYTES,
  commitBoard,
  proveCell,
} from "./merkle";

/** A player's secret fleet plus its precomputed commitment. */
export interface FleetSecret {
  /** 100-cell 0/1 board. */
  board: Uint8Array;
  /** Per-cell salts (100 × {@link SALT_BYTES} bytes). */
  salts: Uint8Array[];
  commitment: BoardCommitment;
}

export function makeFleetSecret(
  board: Uint8Array,
  salts: Uint8Array[],
): FleetSecret {
  return { board, salts, commitment: commitBoard(board, salts) };
}

/** A randomly-placed fleet plus the placements that produced it — kept so a spectate view can render
 *  the seat's actual ships (sunk-ship + per-ship damage need the placements, not just the board). */
export function randomFleetWithPlacements(rng: () => number): {
  secret: FleetSecret;
  placements: Placement[];
} {
  const placements = placeFleetRandom(rng);
  const board = placementsToBoard(placements);
  const salts = Array.from({ length: CELL_COUNT }, () => {
    const s = new Uint8Array(SALT_BYTES);
    for (let i = 0; i < SALT_BYTES; i++) s[i] = Math.floor(rng() * 256);
    return s;
  });
  return { secret: makeFleetSecret(board, salts), placements };
}

/** A randomly-placed fleet with rng-derived salts — for the bot seat and tests. */
export function randomFleetSecret(rng: () => number): FleetSecret {
  return randomFleetWithPlacements(rng).secret;
}

export interface DrivenMove {
  move: BattleshipMove;
  by: Party;
}

/**
 * The next move for whichever seat must act, or null when the game is over.
 * `secrets` must hold both fleets (vs-bot runs both seats locally). `difficulty`
 * tunes only the bot's shot selection (see `bot.ts`); commits and reveals are
 * forced by the protocol regardless.
 */
export function nextMove(
  state: BattleshipState,
  secrets: { A: FleetSecret; B: FleetSecret },
  rng: () => number,
  difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY,
): DrivenMove | null {
  if (state.winner !== 0 || state.phase === "over") return null;

  if (state.phase === "awaitingCommits") {
    if (state.commitA === null) {
      return {
        move: { type: "commit", root: secrets.A.commitment.root },
        by: "A",
      };
    }
    if (state.commitB === null) {
      return {
        move: { type: "commit", root: secrets.B.commitment.root },
        by: "B",
      };
    }
    return null;
  }

  if (state.phase === "awaitingBoardReveal") {
    const winner = pendingBoardReveal(state);
    if (!winner) return null;
    const secret = secrets[winner];
    return {
      by: winner,
      move: { type: "reveal_board", cells: secret.board, salts: secret.salts },
    };
  }

  // phase === "playing"
  if (state.pendingShot) {
    const defender = otherParty(state.pendingShot.by);
    const cell = state.pendingShot.cell;
    const secret = secrets[defender];
    return {
      by: defender,
      move: {
        type: "reveal",
        cell,
        isShip: secret.board[cell] === 1,
        salt: secret.salts[cell],
        proof: proveCell(secret.commitment, cell),
      },
    };
  }

  return {
    by: state.turn,
    move: {
      type: "shoot",
      cell: pickShot(state, state.turn, rng, BOT_CONFIGS[difficulty]),
    },
  };
}

/**
 * Play an entire game by feeding driver moves through the protocol. Returns the
 * terminal state. Throws if it fails to terminate within `maxMoves` (a bug
 * backstop — random play finishes in a few hundred moves).
 */
export function playToCompletion(
  protocol: BattleshipProtocol,
  initial: BattleshipState,
  secrets: { A: FleetSecret; B: FleetSecret },
  rng: () => number,
  difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY,
  maxMoves = 2000,
): BattleshipState {
  let state = initial;
  for (let i = 0; i < maxMoves; i++) {
    const driven = nextMove(state, secrets, rng, difficulty);
    if (!driven) return state;
    state = protocol.applyMove(state, driven.move, driven.by);
  }
  throw new Error("game did not terminate within maxMoves");
}
