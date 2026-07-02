import type { RateReport } from "sui-tunnel-ts/telemetry/metrics";

export interface TxnRow {
  /** Stable identity for React keys (feeds prepend/slide). */
  id: number;
  /** Originating game id (registry id) — drives the per-game feed tabs. */
  game: string;
  /**
   * On-chain anchors, present only for rows that settled a transaction.
   * Off-chain activity (e.g. a co-signed round pushed by a live game) has no
   * digest/address, so the feed links them only when set.
   */
  digest?: string;
  address?: string;
  /** True when the connected wallet owns this tunnel — drives the "yours" highlight. */
  mine?: boolean;
  /** Walrus transcript URL, present once a settlement is archived (see the /settle plan). */
  proofUrl?: string;
  time: string;
  /** Raw event time (ms) for a live "N ago" label; absent on rows that only carry a formatted `time`. */
  timestampMs?: number;
  bot: string;
  type: string;
  status: "Success" | "Failed";
  amount: string;
}

export interface DepositRow {
  /** Stable identity for React keys. */
  id: number;
  time: string;
  method: string;
  amount: string;
  status: "Success" | "Failed";
}

/**
 * The shape every stat panel reads. Today it is a static literal
 * (see ../placeholders.ts). The live source — a worker running the off-chain
 * engine and emitting telemetry — will produce this same shape, so the panels
 * are swap-ready without change. `rate` reuses the SDK's RateReport for fidelity.
 */
export interface TelemetrySnapshot {
  rate: RateReport;
  /** Settled on-chain transactions — each carries a digest/address. */
  txns: TxnRow[];
  /**
   * Off-chain activity co-signed inside tunnels but not yet anchored on-chain.
   * These have no digest/address until they settle; the Local feed shows them.
   */
  localTxns: TxnRow[];
  deposits: DepositRow[];
  /** Recent updates/sec samples for the live sparkline. */
  tpsSeries: number[];
  botsRunning: number;
  totalBalance: number;
  successRate: number;
}
