/**
 * Device-capability tiering for the concurrent live-window cap (design §2.1). Each
 * game window runs a dedicated worker — its own V8 isolate (~a few MB of engine bundle) —
 * so the real scaling cost is memory, not CPU (workers are network-blocked at human pace).
 * `maxLiveWindows()` bounds how many worker-windows may be live at once so peak memory stays
 * within the device's budget; offscreen/torn-down windows are reclaimed and don't count.
 *
 * The tier is derived from `navigator.hardwareConcurrency` and, when present,
 * `navigator.deviceMemory` — taking the LOWER of the two implied tiers (a weak CPU must not
 * be masked by lots of RAM, or vice versa). `deviceMemory` is coarse (the API caps the
 * reported value at 8 GiB) and absent in Firefox/Safari, so when it is missing we tier off
 * cores alone (a high-core Firefox/Safari machine can still reach High/Max); only when
 * NEITHER signal is available do we default to Mid.
 */

export type DeviceTier = "low" | "mid" | "high" | "max";

/** Concurrent live worker-windows permitted per tier (design §2.1). */
const LIVE_WINDOW_CAP: Record<DeviceTier, number> = {
  low: 4,
  mid: 8,
  high: 16,
  max: 20, // the realistic ceiling
};

/** Ascending capability order; `lowerTier` picks the more conservative of two tiers. */
const TIER_ORDER: readonly DeviceTier[] = ["low", "mid", "high", "max"];

function lowerTier(a: DeviceTier, b: DeviceTier): DeviceTier {
  return TIER_ORDER.indexOf(a) <= TIER_ORDER.indexOf(b) ? a : b;
}

/** Tier implied by logical CPU count (`navigator.hardwareConcurrency`). */
function tierFromCores(cores: number): DeviceTier {
  if (cores <= 2) return "low";
  if (cores <= 4) return "mid";
  if (cores <= 8) return "high";
  if (cores >= 12) return "max";
  return "high"; // 9–11 cores: above High's ≤8 but below Max's ≥12 threshold
}

/** Tier implied by `navigator.deviceMemory` (GiB; the API caps the reported value at 8). */
function tierFromMemory(gib: number): DeviceTier {
  if (gib <= 2) return "low";
  if (gib <= 4) return "mid";
  if (gib < 8) return "high";
  return "max"; // ≥8 (the API ceiling) — cores decide the top end via lowerTier
}

/** Non-standard (Chromium) navigator field; absent in Firefox/Safari. */
type DeviceMemoryNavigator = Navigator & { deviceMemory?: number };

/**
 * Max concurrent live worker-windows for this device (design §2.1): Low 4 / Mid 8 / High 16 /
 * Max 20. Session-stable, so callers may treat it as constant. With both signals: the lower
 * tier. With only one (e.g. Firefox/Safari, which never report `deviceMemory`): that signal
 * alone. With neither (SSR / locked-down navigator): Mid.
 */
function resolveTier(): DeviceTier {
  if (typeof navigator === "undefined") return "mid";
  const nav = navigator as DeviceMemoryNavigator;
  const cores = nav.hardwareConcurrency;
  const mem = nav.deviceMemory;

  const coresTier: DeviceTier | null =
    cores && cores > 0 ? tierFromCores(cores) : null;
  const memTier: DeviceTier | null =
    typeof mem === "number" && mem > 0 ? tierFromMemory(mem) : null;

  if (coresTier && memTier) return lowerTier(coresTier, memTier);
  // Only one signal present → tier off it alone (don't synthesize a Mid that caps the other).
  return coresTier ?? memTier ?? "mid"; // neither signal → Mid
}

export function maxLiveWindows(): number {
  return LIVE_WINDOW_CAP[resolveTier()];
}

/** Device capacity for the game pickers' hint: the tier, its concurrent live-window cap, and the raw
 *  signals it derived from (either may be null — `deviceMemory` is absent in Firefox/Safari). The cap
 *  is a MEMORY budget for per-window worker isolates (`?enginepool`); the shared hub uses less memory
 *  but a single co-sign thread, so many flat-out auto-games saturate that thread before this cap. */
export function deviceTierInfo(): {
  tier: DeviceTier;
  cap: number;
  cores: number | null;
  memoryGiB: number | null;
} {
  const nav =
    typeof navigator === "undefined"
      ? null
      : (navigator as DeviceMemoryNavigator);
  const tier = resolveTier();
  return {
    tier,
    cap: LIVE_WINDOW_CAP[tier],
    cores: nav?.hardwareConcurrency ?? null,
    memoryGiB: typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null,
  };
}
