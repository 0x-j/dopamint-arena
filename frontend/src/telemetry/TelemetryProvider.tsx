import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { newCounters, rateReport } from "sui-tunnel-ts/telemetry/metrics";
import type { Counters } from "sui-tunnel-ts/telemetry/metrics";
import type { TelemetrySnapshot, TxnRow } from "../panels/types";
import { PLACEHOLDER_SNAPSHOT } from "../placeholders";
import {
  useBackendStats,
  type BackendStatus,
} from "../backend/useBackendStats";
import type { StatsSnapshot } from "../backend/controlPlane";
import { liveOnchainTxns, displayUpdatesPerSec } from "../backend/liveMerge";

const MAX_TXNS = 12;
const MAX_SERIES = 20;
/** Offline-fallback sampling cadence for the TPS sparkline (matches the backend's ~1/s push).
 *  Only used when no backend is connected — see the series effect below. */
const OFFLINE_SAMPLE_MS = 1000;

/** Writer API games call to push their off-chain activity into the live panels. */
export interface TelemetryWriter {
  /** Prepend a transaction row (capped to the most recent MAX_TXNS). */
  pushTxn: (row: TxnRow) => void;
  /** Prepend a My-Activity row (local off-chain move, capped to MAX_TXNS). */
  pushLocalTxn: (row: TxnRow) => void;
  /** Accumulate engine counters from one or more co-signed updates. */
  bumpCounters: (delta: Partial<Counters>) => void;
  /** Tally `n` co-signed state updates — the exact `actionsDelta` this game ships to the
   *  backend heartbeat. The scoped report a game window installs tags these by `gameId`;
   *  it is what feeds the per-game local TPS fallback. No-op outside a game scope. */
  recordActions: (n: number) => void;
  /** Set the number of bots currently running. */
  setActive: (n: number) => void;
}

interface TelemetryContextValue {
  snapshot: TelemetrySnapshot;
  report: TelemetryWriter;
  /** The single SSE aggregate frame, shared so every panel reads the same value (no per-panel
   *  subscription drift). Null while connecting/offline. */
  backend: StatsSnapshot | null;
  status: BackendStatus;
  /** Record `n` co-signed state updates for `gameId` — the same `actionsDelta` the game ships to
   *  the backend heartbeat (tagged by the scoped report each game window installs). Lets the
   *  per-game chip derive a REAL local rate, in the backend's own unit, when its authoritative
   *  `perGame` feed is absent. Self-play only: PvP is relay-counted server-side, so it records
   *  nothing here and shows a local rate only when the backend is connected. */
  recordGameUpdate: (gameId: string, n: number) => void;
  /** Cumulative updates recorded for `gameId`, for the chip's own rate sampling. */
  getGameTotal: (gameId: string) => number;
  /** Cumulative updates across every game, for the aggregate off-chain local-rate display. */
  getGamesTotal: () => number;
}

export const TelemetryContext = createContext<TelemetryContextValue | null>(
  null,
);

export function TelemetryProvider({ children }: { children: ReactNode }) {
  // Feeds start empty (honest "no activity yet") and fill from real play / backend events;
  // the placeholder is only used as the offline-demo fallback (see the snapshot memo below).
  const [txns, setTxns] = useState<TxnRow[]>([]);
  const [localTxns, setLocalTxns] = useState<TxnRow[]>([]);
  const [tpsSeries, setTpsSeries] = useState<number[]>(
    PLACEHOLDER_SNAPSHOT.tpsSeries,
  );
  const [botsRunning, setBotsRunning] = useState<number>(
    PLACEHOLDER_SNAPSHOT.botsRunning,
  );
  const [hasActivity, setHasActivity] = useState(false);
  const { snapshot: backend, status } = useBackendStats();
  // Real connected wallet only (demo's fake address is never an on-chain party) — attributes
  // live rows so the viewer's own opens/closes highlight and self-verify.
  const viewerAddress = useCurrentAccount()?.address ?? null;

  const counters = useRef<Counters>(newCounters());
  const startMs = useRef<number>(Date.now());
  // Monotonic feed-row id owned HERE, not by callers: a game's own counter resets per tunnel,
  // and the feeds are shared across games — caller ids collide and React drops rows by key.
  // Assigning the id on push keeps every row key globally unique. Computed outside the state
  // updater (which must stay pure / may run twice under StrictMode).
  const txnId = useRef(0);

  const pushTxn = useCallback((row: TxnRow) => {
    setHasActivity(true);
    const id = txnId.current++;
    setTxns((cur) => [{ ...row, id }, ...cur].slice(0, MAX_TXNS));
  }, []);

  const pushLocalTxn = useCallback((row: TxnRow) => {
    setHasActivity(true);
    const id = txnId.current++;
    setLocalTxns((cur) => [{ ...row, id }, ...cur].slice(0, MAX_TXNS));
  }, []);

  const bumpCounters = useCallback((delta: Partial<Counters>) => {
    setHasActivity(true);
    const c = counters.current;
    c.updates += delta.updates ?? 0;
    c.signatures += delta.signatures ?? 0;
    c.verifications += delta.verifications ?? 0;
    c.bytes += delta.bytes ?? 0;
    c.tunnelsOpened += delta.tunnelsOpened ?? 0;
    c.tunnelsClosed += delta.tunnelsClosed ?? 0;
    c.disputes += delta.disputes ?? 0;
    c.settlements += delta.settlements ?? 0;
    c.errors += delta.errors ?? 0;
    // No local rate is derived here: the backend is the single authoritative TPS clock
    // (ADR-0002). Self-play reports raw counts via the heartbeat; the backend owns the rate
    // (see docs/guide/adding-a-tunnel-game.md § Reporting TPS). These counters feed only totals and
    // the offline fallback below.
  }, []);

  const setActive = useCallback((n: number) => setBotsRunning(n), []);

  // Per-game cumulative state-update counter — the `actionsDelta` each game heartbeat ships,
  // tagged by the scoped report a game window installs. Only used to derive a local per-game rate
  // for the window TPS chip / aggregate when the authoritative `perGame` feed is absent — it
  // never touches the global counters.
  const perGameTotal = useRef<Record<string, number>>({});
  const recordGameUpdate = useCallback((gameId: string, n: number) => {
    if (n)
      perGameTotal.current[gameId] = (perGameTotal.current[gameId] ?? 0) + n;
  }, []);
  const getGameTotal = useCallback(
    (gameId: string) => perGameTotal.current[gameId] ?? 0,
    [],
  );
  const getGamesTotal = useCallback(
    () => Object.values(perGameTotal.current).reduce((sum, n) => sum + n, 0),
    [],
  );

  // TPS sparkline ← the backend's authoritative rate. The server pushes a pre-summed `tps`
  // ~1/s, so append each fresh snapshot. We never compute a rate from local counters while
  // connected — that is the "don't count TPS locally" contract.
  useEffect(() => {
    if (!backend) return;
    setTpsSeries((cur) => [...cur, Math.round(backend.tps)].slice(-MAX_SERIES));
  }, [backend]);

  // Offline fallback ONLY (no backend to ask): sample the lifetime-average updates/sec so the
  // sparkline still moves during a backend-down self-play run. Never runs while connected.
  useEffect(() => {
    if (status !== "offline" || !hasActivity) return;
    const id = setInterval(() => {
      const elapsed = Math.max(1, Date.now() - startMs.current);
      const ups = rateReport(counters.current, elapsed).updatesPerSec;
      setTpsSeries((cur) => [...cur, Math.round(ups)].slice(-MAX_SERIES));
    }, OFFLINE_SAMPLE_MS);
    return () => clearInterval(id);
  }, [status, hasActivity]);

  const snapshot = useMemo<TelemetrySnapshot>(() => {
    // Reserve the demo placeholder for a genuinely-offline backend with no local play. While
    // connecting or live, show real-or-empty so a refresh never flashes fake data first.
    if (status === "offline" && !hasActivity) return PLACEHOLDER_SNAPSHOT;

    const elapsed = Math.max(1, Date.now() - startMs.current);
    const localRate = rateReport(
      hasActivity ? counters.current : newCounters(),
      elapsed,
    );
    // Headline updates/sec: the backend's authoritative rate when connected, else the local
    // lifetime average as an offline fallback (displayUpdatesPerSec picks).
    return {
      rate: {
        ...localRate,
        updatesPerSec: displayUpdatesPerSec(backend, localRate.updatesPerSec),
      },
      txns: liveOnchainTxns(backend, hasActivity ? txns : [], viewerAddress),
      localTxns: hasActivity ? localTxns : [],
      deposits: PLACEHOLDER_SNAPSHOT.deposits,
      tpsSeries,
      botsRunning,
      totalBalance: PLACEHOLDER_SNAPSHOT.totalBalance,
      successRate:
        localRate.errors === 0
          ? 100
          : (localRate.updates / (localRate.updates + localRate.errors)) * 100,
    };
  }, [
    hasActivity,
    txns,
    localTxns,
    tpsSeries,
    botsRunning,
    backend,
    status,
    viewerAddress,
  ]);

  // Keep `report` stable across snapshot updates so consumers' callbacks that
  // depend on it (e.g. a game's start/reset) don't churn on every counter bump.
  const report = useMemo<TelemetryWriter>(
    // recordActions is a no-op at the root — only the per-game scope (GameTelemetryScope)
    // overrides it to tag the gameId. A game outside a scope simply records no per-game rate.
    () => ({
      pushTxn,
      pushLocalTxn,
      bumpCounters,
      recordActions: () => {},
      setActive,
    }),
    [pushTxn, pushLocalTxn, bumpCounters, setActive],
  );
  const value = useMemo<TelemetryContextValue>(
    () => ({
      snapshot,
      report,
      backend,
      status,
      recordGameUpdate,
      getGameTotal,
      getGamesTotal,
    }),
    [
      snapshot,
      report,
      backend,
      status,
      recordGameUpdate,
      getGameTotal,
      getGamesTotal,
    ],
  );

  return (
    <TelemetryContext.Provider value={value}>
      {children}
    </TelemetryContext.Provider>
  );
}

export function useTelemetry(): TelemetryContextValue {
  const ctx = useContext(TelemetryContext);
  if (!ctx)
    throw new Error("useTelemetry must be used within a TelemetryProvider");
  return ctx;
}
