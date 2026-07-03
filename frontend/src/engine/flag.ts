import { deviceTierInfo } from "./deviceTier";

/** Selects the worker-hosted tunnel client over the legacy main-thread path. DEFAULT-ON everywhere
 *  (dev and production): every game window drives its match through the worker engine unless an
 *  explicit `?engine=legacy` override forces the main-thread path. `?engine=worker` is kept as an
 *  explicit opt-in (e.g. to override a future kill-switch). All 8 games (PvP + solo) now have
 *  worker specs. The legacy main-thread path is DEPRECATED: it survives only as the
 *  `?engine=legacy` escape hatch and will be removed — new game work belongs in a
 *  `GameSessionSpec` (`defineGame`) driven by `useGameMatch`, never in the legacy hooks.
 *  Read once at module load (stable for the session). */
export function engineEnabled(): boolean {
  if (typeof location !== "undefined") {
    const v = new URLSearchParams(location.search).get("engine");
    if (v === "worker") return true;
    if (v === "legacy") return false;
  }
  return true;
}

/** Per-window game worker + one shared SOCKET worker (ADR-0030 Phase 2) instead of the single shared
 *  hub: spreads co-sign across cores + isolates a game's fault to its worker, keeping the one-relay-
 *  socket invariant. AUTO-ON for High/Max device tiers — there the `deviceTier` window cap is a memory
 *  budget that already assumes per-window isolates, and enough cores exist to actually parallelize, so
 *  the pool makes that advertised cap real; Low/Mid stay on the lighter one-worker hub. `?enginepool=1`
 *  forces on, `?enginepool=0` forces off (fallback). Only meaningful when the worker engine is on
 *  ({@link engineEnabled}); a stable per-session value (URL + device tier don't change mid-session). */
export function enginePoolEnabled(): boolean {
  if (typeof location !== "undefined") {
    const v = new URLSearchParams(location.search).get("enginepool");
    if (v === "1") return true;
    if (v === "0") return false;
  }
  const tier = deviceTierInfo().tier;
  return tier === "high" || tier === "max";
}

/** Render virtualization (ADR-0030): pause paint + throttle-up for off-screen windows and stop the
 *  worker emitting their snapshots. TEMPORARILY DEFAULT-OFF while we chase an on-screen freeze (a
 *  window that stays blank though it's visible) — with this off, every live window paints every move
 *  so the raw gameplay flow can be judged on its own. `?rendervirt=1` forces it back on; flip the
 *  default once the freeze is root-caused. Only meaningful with the worker engine ({@link engineEnabled}). */
export function renderVirtualizationEnabled(): boolean {
  if (typeof location !== "undefined") {
    const v = new URLSearchParams(location.search).get("rendervirt");
    if (v === "1") return true;
    if (v === "0") return false;
  }
  return false; // TEMP: off by default while diagnosing the on-screen freeze
}
