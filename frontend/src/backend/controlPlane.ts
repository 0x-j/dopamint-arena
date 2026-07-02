// Control-plane client for the tunnel-manager backend (ADR-0002). The backend is the
// stats/settlement spine and is NEVER in the per-move loop — so register/heartbeat
// failures are logged by callers and must not block local play.
//
// Wire contract (ADR-0002): base path /v1, JSON, camelCase. u64 values (nonce,
// balances, timestamp) travel as decimal strings; 32-byte values as 0x-hex.

export interface TunnelRef {
  tunnelId: string;
  partyA: string;
  partyB: string;
}

export interface RegisterSessionResult {
  sessionId: string;
  statsToken: string;
}

/** Coarse, aggregated throughput report — one call per ~window, never per move. */
export interface Heartbeat {
  tunnelId: string;
  nonce: string;
  actionsDelta: number;
  windowMs: number;
}

/** Mirrors the backend `TunnelEventKind` (serde lowercase). */
export type TunnelEventKind = "opened" | "settled";

/**
 * One settlement-projection row from the backend (ADR-0005). camelCase per ADR-0002; u64 balances
 * arrive as JSON numbers, `Option<_>` as nullable. `proofUrl`/`transcriptRoot` are present only
 * once a close is archived (the /settle plan); explorer-only rows omit them.
 */
export interface TunnelEvent {
  tunnelId: string;
  kind: TunnelEventKind;
  /** On-chain parties (from TunnelCreated); null when ownership was not captured. */
  partyA: string | null;
  partyB: string | null;
  /** Open tx sender (funding wallet) — identifies the owner in self-play (both parties ephemeral). */
  funder: string | null;
  /** Game id joined from the session registry; null for PvP/unknown. */
  game: string | null;
  partyABalance: number | null;
  partyBBalance: number | null;
  transcriptRoot: string | null;
  txDigest: string;
  timestampMs: number;
  proofUrl: string | null;
}

/** Proof links returned after the settler submits close_cooperative_with_root + Walrus archive. */
export interface SettleResult {
  txDigest: string;
  walrusBlobId: string;
  proofUrl: string;
}

/** Per-game slice of the live aggregate feed. Field names match the backend's serde. */
export interface GameStats {
  tps: number;
  tunnels: number;
  total_actions?: number;
}

/** One server-sent aggregate snapshot from GET /v1/stats/live. */
export interface StatsSnapshot {
  tps: number;
  peakTps: number;
  totalActions: number;
  activeTunnels: number;
  settledTunnels: number;
  perGame: Record<string, GameStats>;
  /** Newest-first ring of recent lifecycle rows; absent on frames before the backend emits any. */
  recentEvents?: TunnelEvent[];
}

export interface ControlPlaneClient {
  registerSession(input: {
    userAddress: string;
    game: string;
    tunnels: TunnelRef[];
  }): Promise<RegisterSessionResult>;
  sendHeartbeat(
    sessionId: string,
    statsToken: string,
    heartbeat: Heartbeat,
  ): Promise<void>;
  /** Route a cooperative close through the backend: the settler dry-runs + submits
   *  close_cooperative_with_root (anchoring the transcript root), archives the transcript to
   *  Walrus, and returns the proof links. `body` is the v2 binary settle blob (octet-stream),
   *  POSTed verbatim and archived to Walrus byte-identical. Authorization is the co-signed
   *  settlement encoded in `body` (ADR-0007) — no session token. */
  settle(tunnelId: string, body: Uint8Array): Promise<SettleResult>;
  /** Subscribe to the live aggregate SSE feed; returns an unsubscribe fn. */
  openStatsStream(handlers: StatsStreamHandlers): () => void;
  /** Seed the TPS graph with derived (ts, tps) points from the explorer — either a trailing
   *  `window` (seconds, ending now) or an absolute `from`/`to` epoch-second range. The server
   *  bounds the range to retention and downsamples it, so the result is always render-sized. */
  fetchStatsHistory(
    query: StatsHistoryQuery,
  ): Promise<{ t: number; v: number }[]>;
}

/** {@link ControlPlaneClient.fetchStatsHistory} argument: a trailing window or an absolute range. */
export type StatsHistoryQuery =
  | { window: number }
  | { from: number; to: number };

/** Callbacks for {@link ControlPlaneClient.openStatsStream}. `onError` fires when the SSE
 *  connection fails (e.g. backend unreachable), letting the UI tell "connecting" apart from
 *  "offline" instead of treating both as a null snapshot. */
export interface StatsStreamHandlers {
  onSnapshot: (snapshot: StatsSnapshot) => void;
  onError?: () => void;
}

class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

async function failIfNotOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  // The backend returns { error: { code, message } } on failure (ADR-0002).
  let detail = res.statusText;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) detail = body.error.message;
  } catch {
    // non-JSON body; keep statusText
  }
  throw new ControlPlaneError(
    res.status,
    `${what} failed: ${res.status} ${detail}`,
  );
}

export function createControlPlaneClient(baseUrl: string): ControlPlaneClient {
  const root = baseUrl.replace(/\/+$/, "");

  return {
    async registerSession(input) {
      const res = await fetch(`${root}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      await failIfNotOk(res, "registerSession");
      return (await res.json()) as RegisterSessionResult;
    },

    async sendHeartbeat(sessionId, statsToken, heartbeat) {
      const res = await fetch(`${root}/v1/sessions/${sessionId}/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${statsToken}`,
        },
        body: JSON.stringify(heartbeat),
      });
      await failIfNotOk(res, "sendHeartbeat");
    },

    async settle(tunnelId, body) {
      const res = await fetch(`${root}/v1/tunnels/${tunnelId}/settle`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        // TS 5.7 types Uint8Array as Uint8Array<ArrayBufferLike>, which the DOM BodyInit union
        // no longer accepts directly; the bytes are a valid fetch body at runtime, sent verbatim.
        body: body as BodyInit,
      });
      await failIfNotOk(res, "settle");
      return (await res.json()) as SettleResult;
    },

    openStatsStream(handlers) {
      const source = new EventSource(`${root}/v1/stats/live`);
      source.onmessage = (ev) => {
        try {
          handlers.onSnapshot(JSON.parse(ev.data) as StatsSnapshot);
        } catch {
          // ignore malformed frames; the feed is best-effort
        }
      };
      source.onerror = () => handlers.onError?.();
      return () => source.close();
    },

    async fetchStatsHistory(query) {
      const qs =
        "window" in query
          ? `window=${query.window}`
          : `from=${query.from}&to=${query.to}`;
      const res = await fetch(`${root}/v1/stats/history?${qs}`);
      await failIfNotOk(res, "fetchStatsHistory");
      const body = (await res.json()) as {
        points: { t: string; v: number }[];
      };
      return body.points.map((p) => ({ t: Number(p.t), v: p.v }));
    },
  };
}

/**
 * Resolve the backend base URL. Empty (the default) means same-origin: dev proxies /v1 to
 * the ALB via vite.config.ts, and prod routes /v1 to the ALB via the CloudFront `/v1/*`
 * behavior — so the browser only ever issues same-origin requests. Set VITE_BACKEND_URL to
 * an absolute URL only for a split-origin backend on its own https host (then CORS applies).
 */
export function resolveBackendUrl(): string {
  return import.meta.env?.VITE_BACKEND_URL ?? "";
}

let cachedClient: ControlPlaneClient | undefined;

/** Browser singleton shared across game modules. Per-call failures are caught by callers —
 *  the backend is the stats/settlement spine, never the per-move loop, so it can't block play. */
export function getControlPlaneClient(): ControlPlaneClient {
  if (!cachedClient)
    cachedClient = createControlPlaneClient(resolveBackendUrl());
  return cachedClient;
}
