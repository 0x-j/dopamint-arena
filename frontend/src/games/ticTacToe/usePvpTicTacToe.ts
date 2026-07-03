/**
 * Adapter that lets the ttt/caro mini-app's `PvpScene` (which consumes `PvpTttView`) drive PvP
 * through the SHARED worker PvP hub when the flag is on — the PvP sibling of `useTttBotGame`. The
 * DEFAULT path stays the bespoke main-thread `usePvpTicTacToe` (`app/hooks/usePvpTicTacToe`),
 * untouched, so `?engine=legacy` keeps the proven winner-submit close.
 *
 * Under the worker path the match runs in the hub (`engine.pvp.worker.ts`) over the composite
 * matchmaking queue (`tictactoe:ttt` / `tictactoe:caro:N`) and settles via the engine's generic
 * `cp.settle`. Fields the worker snapshot doesn't surface — the SUI balance (gated away by
 * `isMtpsConfigured`), tx digests, and the per-game history list — are stubbed; `PvpScene` guards
 * each (`games.length`, optional digest props), so the core game renders + plays. NEEDS browser +
 * backend E2E verification (does the bot join the queue; does cp.settle land for these tunnels).
 *
 * Bound once at module load (rules-of-hooks): one of two hooks, stable per session.
 */
import { useEffect, useRef, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { engineEnabled } from "@/engine/flag";
import { engineClient } from "@/engine/engineClient";
import { useGameMatch } from "@/engine/react/useGameMatch";
import { useArenaWorkerEntry } from "@/engine/react/useArenaWorkerEntry";
import { useWorkerArenaPlay } from "@/engine/react/useWorkerArenaPlay";
import type { MatchSnapshot } from "@/engine/engineApi";
import {
  usePvpTicTacToe as useLegacyPvp,
  CARO_ARENA_GAME_ID,
  TIC_TAC_TOE_ARENA_GAME_ID,
} from "./app/hooks/usePvpTicTacToe";
import type {
  PvpTttView,
  PvpPhase,
  Variant,
} from "./app/hooks/usePvpTicTacToe";
import type { TurnGameView, TurnGameSetup } from "./tttCaroPvpSpec";

export type { PvpTttView, Variant };

const PHASE: Record<MatchSnapshot["status"], PvpPhase> = {
  idle: "idle",
  matching: "queuing",
  funding: "funding",
  playing: "playing",
  settling: "settling",
  settled: "done",
  error: "error",
};

/** Worker path: shape the hub's PvP snapshot into the `PvpTttView` the mini-app already renders. */
function useWorkerPvp(
  windowId: string,
  variant: Variant,
  boardSize: number,
): PvpTttView {
  const gameId = variant === "caro" ? "caro" : "tictactoe";
  const account = useCurrentAccount();
  const snap = useGameMatch(windowId, gameId) as MatchSnapshot<TurnGameView>;
  const v = snap.view;
  const phase = PHASE[snap.status] ?? "idle";
  const role = snap.role;
  const winner = v?.winner ?? 0;
  const turn = v?.turn ?? null;

  // Cumulative score: the snapshot only carries the CURRENT game's winner, so tally each decided
  // game once (keyed by gamesPlayed). Best-effort — a coalesced flush can skip a just-decided frame;
  // a worker-side score in the snapshot would be exact (follow-up).
  const [score, setScore] = useState({ x: 0, o: 0, draws: 0 });
  const lastScored = useRef(-1);
  useEffect(() => {
    if (!v || v.winner === 0) return;
    if (v.gamesPlayed === lastScored.current) return;
    lastScored.current = v.gamesPlayed;
    setScore((s) =>
      v.winner === 1
        ? { ...s, x: s.x + 1 }
        : v.winner === 2
          ? { ...s, o: s.o + 1 }
          : { ...s, draws: s.draws + 1 },
    );
  }, [v?.winner, v?.gamesPlayed, v]);
  useEffect(() => {
    if (phase === "idle" || phase === "queuing") {
      lastScored.current = -1;
      setScore({ x: 0, o: 0, draws: 0 });
    }
  }, [phase]);

  const setup: TurnGameSetup = variant === "caro" ? { boardSize } : {};
  // Arena one-sig auto-enter (ADR-0028): consume this variant's fleet allocation from the store and
  // join it in the worker — the window comes alive vs a bot on wallet-connect, no "Find match" click.
  // Keyed by the variant's arena id (caro vs tic_tac_toe) so the right window claims the right entry.
  useArenaWorkerEntry({
    windowId,
    gameId,
    arenaGameId:
      variant === "caro" ? CARO_ARENA_GAME_ID : TIC_TAC_TOE_ARENA_GAME_ID,
    isIdle: () => snap.status === "idle",
    setup,
  });
  const start = () => engineClient.findMatch(windowId, gameId, setup);
  const playArena = useWorkerArenaPlay({
    windowId,
    gameId,
    arenaGameId:
      variant === "caro" ? CARO_ARENA_GAME_ID : TIC_TAC_TOE_ARENA_GAME_ID,
    label: gameId,
    setup,
  });

  return {
    phase,
    error: snap.error,
    role,
    variant,
    board: v?.board ?? [],
    size: v?.size ?? boardSize,
    lastMove: -1,
    turn,
    winner,
    myMark: role === "A" ? 1 : role === "B" ? 2 : 0,
    isMyTurn:
      phase === "playing" && winner === 0 && turn != null && turn === role,
    innerOver: winner !== 0,
    terminal: !!v && v.gamesPlayed + 1 >= v.maxGames && winner !== 0,
    score,
    games: [],
    currentGame: (v?.gamesPlayed ?? 0) + 1,
    auto: snap.auto,
    address: account?.address ?? "",
    balance: 0n, // MTPS mode (isMtpsConfigured) gates this off; gas is sponsored.
    stake: BigInt(snap.stake), // per-seat stake from the worker snapshot (forfeit-dialog copy)
    digests: {},
    queue: start,
    play: (cell: number) => engineClient.submitInput(windowId, cell),
    next: () => {}, // worker auto-advances games within the multi-game tunnel
    // Worker interim: teardown; the legacy hook's true concede needs engine support — follow-up.
    forfeit: () => engineClient.reset(windowId),
    setAuto: (on: boolean) => engineClient.setAuto(windowId, on),
    playArena: () => playArena(),
    leave: () => engineClient.reset(windowId),
    requeue: start,
  };
}

/** @deprecated `?engine=legacy` fallback only: adapts the bespoke main-thread PvP hook
 *  (windowId unused). The worker path above is the primary engine. */
function useLegacyPvpAdapter(
  _windowId: string,
  variant: Variant,
  boardSize: number,
): PvpTttView {
  return useLegacyPvp(variant, boardSize);
}

/** The worker path routes ttt/caro PvP through the shared hub; `?engine=legacy` keeps the bespoke
 *  hook. Selected once at module load (rules-of-hooks: a stable hook per session). */
export const usePvpTicTacToe: (
  windowId: string,
  variant: Variant,
  boardSize: number,
) => PvpTttView = engineEnabled() ? useWorkerPvp : useLegacyPvpAdapter;
