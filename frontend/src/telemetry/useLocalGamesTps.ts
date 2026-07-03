import { useEffect, useRef, useState } from "react";

import { backendGameKey } from "@/games/backendGameKey";
import { useTelemetry } from "./TelemetryProvider";

const SAMPLE_MS = 1000;

/**
 * The local user's total throughput: for each game window currently open, the SAME rate its
 * header chip shows — the backend's authoritative per-game rate when the stats feed is live
 * (`backend.perGame[key].tps`), else the locally-sampled rate of co-signed updates that game is
 * producing (`getGameTotal` delta / dt). Summed over the DISTINCT open games (so two windows of
 * one game count once), so the headline equals "sum of the game windows' TPS".
 *
 * Returns null when nothing is producing a rate (no open games, or all idle), so the caller hides
 * the metric instead of showing a fabricated zero — mirroring {@link useSampledRate}. This replaces
 * the old local-counter-only aggregate, which read 0 whenever the (removed) self-play wasn't
 * running even though the per-window chips showed backend rates.
 */
export function useLocalGamesTps(): number | null {
  const { backend, getOpenGameIds, getGameTotal } = useTelemetry();
  // Backend snapshot changes ~1/s; hold it in a ref so a new frame doesn't tear down the interval.
  const backendRef = useRef(backend);
  backendRef.current = backend;

  const [rate, setRate] = useState<number | null>(null);
  const prev = useRef<{ totals: Record<string, number>; ms: number }>({
    totals: {},
    ms: Date.now(),
  });

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const dt = Math.max(1, now - prev.current.ms) / 1000;
      const perGame = backendRef.current?.perGame;
      const nextTotals: Record<string, number> = {};
      let sum = 0;
      let any = false;
      for (const gameId of getOpenGameIds()) {
        const backendTps = perGame?.[backendGameKey(gameId)]?.tps;
        if (backendTps != null) {
          // Authoritative backend rate — instantaneous, no sampling needed.
          sum += backendTps;
          any = true;
          continue;
        }
        // Local fallback: delta of this game's co-signed-update counter over the interval.
        const total = getGameTotal(gameId);
        nextTotals[gameId] = total;
        if (total > 0) {
          const prevTotal = prev.current.totals[gameId] ?? total;
          sum += Math.max(0, (total - prevTotal) / dt);
          any = true;
        }
      }
      prev.current = { totals: nextTotals, ms: now };
      setRate(any ? sum : null);
    };
    const id = setInterval(tick, SAMPLE_MS);
    return () => clearInterval(id);
  }, [getOpenGameIds, getGameTotal]);

  return rate;
}
