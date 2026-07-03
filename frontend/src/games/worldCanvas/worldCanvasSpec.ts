/**
 * World Canvas PvP as a worker-engine spec (public-state, batched paint move). idle is an
 * empty run `{ cells: [] }`, so the controller uses a value-based `isIdle` (object identity
 * would treat every empty flush as human input). The paint buffer/seq logic stays in the
 * React hook; the spec just declares the move shape, like the main-thread path.
 */
import { makePublicStateSpec } from "@/engine/publicStateSpec";
import { defineGame } from "@/engine/specs/defineGame";
import {
  WorldCanvasPvpProtocol,
  type PvpCanvasState,
  type PvpPaintMove,
  type PvpCell,
} from "sui-tunnel-ts/protocol/worldCanvasPvp";
import { makeWorldCanvasPvpResumeAdapter } from "./pvpResumeAdapter";

export const worldCanvasSpec = defineGame(
  makePublicStateSpec<PvpCanvasState, PvpPaintMove, PvpPaintMove, PvpCell[]>({
    game: "world-canvas",
    stake: 1n, // 1 MIST per seat — free/draw, each human funds its own seat
    stepMs: 80,
    makeProtocol: () => new WorldCanvasPvpProtocol(),
    deriveView: (s) => s.cells,
    idleIntent: { cells: [] },
    isIdle: (i) => i.cells.length === 0,
    intentToMove: (_role, i) => i,
    readIntent: (_role, m) => m ?? undefined,
    makeResumeAdapter: makeWorldCanvasPvpResumeAdapter,
  }),
);
