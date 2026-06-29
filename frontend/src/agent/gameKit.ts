import type {
  Protocol,
  Party,
  ProtocolContext,
  Balances,
} from "sui-tunnel-ts/protocol/Protocol";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
import { createTicTacToeKit } from "./games/ticTacToe/kit";
import { createBlackjackKit } from "./games/blackjack/kit";
import { createBattleshipKit } from "./games/battleship/kit";
import { createQuantumPokerKit } from "./games/quantumPoker/kit";
import { createBombItKit } from "./games/bombIt/kit";
import { createChickenCrossKit } from "./games/chickenCross/kit";
import { createWorldCanvasKit } from "./games/worldCanvas/kit";
import { createRegularPaymentsKit } from "./games/regularPayments/kit";
import { createApiCreditsKit } from "./games/apiCredits/kit";
import { defaultStateHash, type StateHash } from "./stateHash";
import { QUANTUM_POKER_STAKE } from "@/games/quantumPoker/constants";
import { MICRO_UNIT } from "@/games/regularPayments/utils/constants";

export type GameId =
  | "tictactoe"
  | "blackjack"
  | "battleship"
  | "quantum-poker"
  | "bomb-it"
  | "chicken-cross"
  | "world-canvas"
  | "regular-payments"
  | "api-credits";
export type { StateHash };
export { defaultStateHash };

export interface BotContext {
  /** Per-seat, seeded, reproducible RNG stream. */
  rngForSeat(seat: Party): () => number;
}

export interface GameKit<S, M> {
  id: GameId;
  /** The real frontend protocol class the human `usePvp*` hook uses. */
  protocol: Protocol<S, M>;
  /** Transport codec for non-JSON-native moves; omitted for JSON-native games. */
  moveCodec?: MoveCodec<M>;
  /** Stable state digest for idempotency checks. */
  stateHash(state: S): StateHash;
  createBot(seat: Party, ctx: BotContext): GameBot<S, M>;
  defaultStake: bigint;
}

export interface GameBot<S, M> {
  /** Purely decide this seat's next move. Null = not my turn / waiting on peer. */
  plan(state: S): M | null;
  /** Advance retained memory AFTER the move has been accepted by the protocol. */
  confirm(state: S, move: M): void;
  /** Teardown after an error or unclean close. */
  abort(): void;
}

export type GameKitRegistry = Record<GameId, GameKit<unknown, unknown>>;

/** Canonical registry of all playable bot kits. */
export const GAME_KITS: GameKitRegistry = {
  tictactoe: createTicTacToeKit(10, 10n),
  blackjack: createBlackjackKit(100n),
  battleship: createBattleshipKit(10n),
  "quantum-poker": createQuantumPokerKit(QUANTUM_POKER_STAKE),
  "regular-payments": createRegularPaymentsKit(MICRO_UNIT),
  "bomb-it": createBombItKit(100n),
  "chicken-cross": createChickenCrossKit(100n),
  "world-canvas": createWorldCanvasKit(100n),
  // Tunnel-based payment workload (client burns credits per call until settled).
  "api-credits": createApiCreditsKit(10n, 100n),
};
