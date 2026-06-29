import { mtps } from "@/onchain/mtps";

/** Shopper (party A) budget locked at Go shop. */
export const DEPOSIT_BUDGET = mtps(10n);

/** Store POS (party B) activation dust — same wallet funds both seats at open. */
export const DEPOSIT_B_DUST = 1n;

/** Full-budget stream tick count (design target ~100 TPS over ~5 s). */
export const TICK_COUNT = 500;

export const MICRO_UNIT = DEPOSIT_BUDGET / BigInt(TICK_COUNT);

/** Target wall-clock duration for a full-budget pay stream (ms). */
export const STREAM_DURATION_MS = 5_000;

/** Pause between cart adds so fly-to-cart animation stays visible. */
export const AUTO_ADD_INTERVAL_MS = 5;

/** Auto-trip cart targets (random pick per round). */
export const AUTO_TARGET_CHOICES = [mtps(8n), mtps(9n), mtps(10n)] as const;
