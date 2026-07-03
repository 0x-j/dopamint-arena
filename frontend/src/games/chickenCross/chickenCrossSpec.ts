/**
 * Chicken Cross as a worker-engine spec (public-state). Per-seat input is a hop direction;
 * idle is `undefined` (no hop this tick). The generic public-state controller drives it.
 */
import { makePublicStateSpec } from "@/engine/publicStateSpec";
import { defineGame } from "@/engine/specs/defineGame";
import {
  CrossProtocol,
  type CrossState,
  type CrossMove,
  type CrossDir,
} from "sui-tunnel-ts/protocol/cross";
import { deriveView, type CrossView } from "./session-core";
import { makeCrossResumeAdapter } from "./crossResumeAdapter";

export const chickenCrossSpec = defineGame(
  makePublicStateSpec<CrossState, CrossMove, CrossDir | undefined, CrossView>({
    game: "chicken-cross",
    stake: 10n, // per-seat MTPS (0-decimal; cheap so 100k faucet covers ~10k matches)
    stepMs: 300,
    makeProtocol: () => new CrossProtocol(),
    deriveView,
    idleIntent: undefined,
    intentToMove: (role, dir) => (role === "A" ? { dirA: dir } : { dirB: dir }),
    readIntent: (role, move) => (role === "A" ? move?.dirA : move?.dirB),
    makeResumeAdapter: makeCrossResumeAdapter,
  }),
);
