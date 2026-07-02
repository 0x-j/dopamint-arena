import type { StatsSnapshot } from "./controlPlane";
import type { TxnRow } from "../panels/types";
import { recentEventsToTxnRows } from "./recentEvents";

/** On-chain feed rows: real backend settlements when connected (empty stays empty — the
 *  honesty rule), else the disconnected fallback (local/placeholder). */
export function liveOnchainTxns(
  backend: StatsSnapshot | null,
  fallback: TxnRow[],
  viewer?: string | null,
): TxnRow[] {
  if (!backend) return fallback;
  return recentEventsToTxnRows(backend.recentEvents ?? [], viewer);
}

/** Displayed updates/sec: live local activity should remain visible even while the
 *  backend aggregate SSE feed is connected but idle for this client. */
export function displayUpdatesPerSec(
  backend: StatsSnapshot | null,
  localUps: number,
): number {
  return backend ? Math.max(backend.tps, localUps) : localUps;
}
