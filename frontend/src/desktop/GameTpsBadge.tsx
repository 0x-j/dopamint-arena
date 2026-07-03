import { useCallback } from "react";

import { backendGameKey } from "@/games/backendGameKey";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { useSampledRate } from "@/telemetry/useSampledRate";
import { fmtTps } from "@/lib/formatTps";
import { cn } from "@/lib/utils";

/**
 * Per-game throughput chip for the window header. The number is REAL, never mocked:
 *   - while the backend stats feed is live, the backend's authoritative per-game rate
 *     (`StatsSnapshot.perGame[gameKey].tps`, ADR-0002 — the backend owns the rate);
 *   - otherwise, the local rate of co-signed state updates this window is producing, sampled from
 *     the per-game counter its scoped report fills (the worker match feeds it each move — see
 *     `useGameMatch`). Zero while a window is idle (no match advancing), so nothing shows.
 *
 * Renders nothing until there is real activity to show, so the header never displays a
 * placeholder — only a game that is actually doing work gets a chip.
 */
export function GameTpsBadge({
  gameId,
  className,
}: {
  gameId: string;
  className?: string;
}) {
  const { backend, getGameTotal } = useTelemetry();
  const backendTps = backend?.perGame?.[backendGameKey(gameId)]?.tps;
  // Local fallback: instantaneous state-updates/sec from this game's counter (authoritative
  // backend rate wins when present).
  const localTps = useSampledRate(
    useCallback(() => getGameTotal(gameId), [getGameTotal, gameId]),
  );

  const tps = backendTps ?? localTps;
  if (tps == null) return null;

  // The primary-violet chip reads cleanly on the window's soft category-tinted title bar.
  return (
    <span
      title="Your TPS (tx/s)"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-primary",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-1.5 animate-pulse rounded-full bg-primary"
      />
      {fmtTps(tps)} TPS
    </span>
  );
}
