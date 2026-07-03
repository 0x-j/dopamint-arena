import {
  createPvpMatchHook,
  type PvpMatch,
  type PvpStatus,
} from "@/pvp/pvpMatchHook";
import type { Role } from "@/pvp/mpClient";
import {
  BombItProtocol,
  type BombItState,
  type BombItMove,
  type BombItAction,
} from "sui-tunnel-ts/protocol/bombIt";
import { deriveView, type BombItView } from "./session-core";
import { makeBombItResumeAdapter } from "./bombItResumeAdapter";
import { engineEnabled } from "@/engine/flag";
import { engineClient } from "@/engine/engineClient";
import { useGameMatch } from "@/engine/react/useGameMatch";
import { useArenaWorkerEntry } from "@/engine/react/useArenaWorkerEntry";
import { useWorkerArenaPlay } from "@/engine/react/useWorkerArenaPlay";
import type { MatchSnapshot } from "@/engine/engineApi";

export type { PvpStatus };

export interface PvpBombIt extends Omit<
  PvpMatch<BombItState, BombItAction, BombItView>,
  "setIntent"
> {
  queueAction: (a: BombItAction) => void;
}

/** Backend arena/`profile_for` id (underscore form of the registry id). Single source of truth for
 *  both the engine's arena consumer (the spec below) and `GameModule.arenaGameId` (index.ts). */
export const BOMB_IT_ARENA_GAME_ID = "bomb_it";

/** @deprecated `?engine=legacy` fallback only (the worker spec in `bombItSpec.ts` is the primary
 *  path): Bomb It's per-seat input is a single action; the engine wraps it into the acting
 *  seat's field. */
const useLegacyMatch = createPvpMatchHook<
  BombItState,
  BombItMove,
  BombItAction,
  BombItView
>({
  game: "bomb-it",
  arenaGameId: BOMB_IT_ARENA_GAME_ID,
  stepMs: 250,
  stake: 10n, // per-seat MTPS (must match bombItSpec.ts)
  makeProtocol: () => new BombItProtocol(),
  deriveView,
  makeResumeAdapter: makeBombItResumeAdapter,
  idleIntent: "stay",
  intentToMove: (role: Role, action) =>
    role === "A" ? { a: action } : { b: action },
  readIntent: (role: Role, move) => (role === "A" ? move?.a : move?.b),
});

function useLegacyBombIt(windowId: string): PvpBombIt {
  const { setIntent, ...rest } = useLegacyMatch(windowId);
  return { ...rest, queueAction: setIntent };
}

/** Worker path (`?engine=worker`): the tunnel client runs in a dedicated Web Worker; this
 *  hook only renders snapshots and forwards commands. */
function useWorkerBombIt(windowId: string): PvpBombIt {
  const snap = useGameMatch(windowId, "bomb-it") as MatchSnapshot<
    BombItView,
    BombItState["winner"]
  >;
  // Arena one-sig auto-enter (ADR-0028): consume this game's fleet allocation + play it in the worker.
  useArenaWorkerEntry({
    windowId,
    gameId: "bomb-it",
    arenaGameId: BOMB_IT_ARENA_GAME_ID,
    isIdle: () => snap.status === "idle",
  });
  const playArena = useWorkerArenaPlay({
    windowId,
    gameId: "bomb-it",
    arenaGameId: BOMB_IT_ARENA_GAME_ID,
    label: "bomb-it",
  });
  return {
    status: snap.status,
    role: snap.role,
    stake: snap.stake,
    auto: snap.auto,
    view: snap.view,
    winner: snap.winner,
    error: snap.error,
    findMatch: () => engineClient.findMatch(windowId, "bomb-it"),
    playArena: () => playArena(),
    toggleAuto: () => engineClient.setAuto(windowId, !snap.auto),
    reset: () => engineClient.reset(windowId),
    // Back/Cancel: the worker tears the match down (release + orphan-cancel); the legacy path
    // publishes a settlement half first, which the worker does automatically on terminal.
    leave: () => engineClient.reset(windowId),
    // Worker interim: same teardown as leave; a true concede needs engine support — follow-up.
    forfeit: () => engineClient.reset(windowId),
    queueAction: (a) => engineClient.submitInput(windowId, a),
  };
}

/** `?engine=worker` selects the worker path; default keeps the main-thread path unchanged.
 *  Bound once at module load so the hook identity is stable per session (rules-of-hooks). */
export const usePvpBombIt: (windowId: string) => PvpBombIt = engineEnabled()
  ? useWorkerBombIt
  : useLegacyBombIt;
