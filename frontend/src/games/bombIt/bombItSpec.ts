/**
 * Bomb It as a worker-engine spec (public-state, no secret). Same declaration the
 * main-thread `createPvpMatchHook` takes — the generic public-state controller does the rest.
 */
import { makePublicStateSpec } from "@/engine/publicStateSpec";
import { defineGame } from "@/engine/specs/defineGame";
import {
  BombItProtocol,
  type BombItState,
  type BombItMove,
  type BombItAction,
} from "sui-tunnel-ts/protocol/bombIt";
import { deriveView, type BombItView } from "./session-core";
import { makeBombItResumeAdapter } from "./bombItResumeAdapter";

export const bombItSpec = defineGame(
  makePublicStateSpec<BombItState, BombItMove, BombItAction, BombItView>({
    game: "bomb-it",
    stake: 10n, // per-seat MTPS (0-decimal; cheap so 100k faucet covers ~10k matches)
    stepMs: 250,
    makeProtocol: () => new BombItProtocol(),
    deriveView,
    idleIntent: "stay",
    intentToMove: (role, action) =>
      role === "A" ? { a: action } : { b: action },
    readIntent: (role, move) => (role === "A" ? move?.a : move?.b),
    makeResumeAdapter: makeBombItResumeAdapter,
  }),
);
