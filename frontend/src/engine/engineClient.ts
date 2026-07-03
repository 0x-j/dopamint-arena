/**
 * Main-thread manager for the PvP tunnel worker. ONE shared "hub" worker serves ALL windows,
 * multiplexing every match over ONE relay socket (the `tunnel-pvp` worker). PvP windows don't each
 * spawn a worker — they are cheap store slots the hub fans snapshots to, keyed by windowId.
 *
 * Transport is Comlink (design §4): the worker exposes a typed API we `Comlink.wrap`; the bridge
 * and snapshot sinks are `Comlink.proxy`'d so the worker invokes them by reference. `dispose`
 * releases the wrapped API (`Comlink.releaseProxy`) and `terminate()`s the worker.
 */
import * as Comlink from "comlink";
import type {
  EngineConfig,
  GameId,
  MainBridge,
  MatchSnapshot,
  PvpHubApi,
  WorkerArenaEntry,
} from "./engineApi";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { maxLiveWindows } from "./deviceTier";
import { enginePoolEnabled, renderVirtualizationEnabled } from "./flag";
import { resumeIdb } from "./persist/idb";
import { elog } from "./debug";
import { registerEngineWorkerWithSentry } from "@/sentry/workerSentry";
import type { GameWorkerApi } from "./engine.game.worker";

const IDLE_SNAPSHOT: MatchSnapshot = {
  status: "idle",
  role: null,
  auto: true,
  stake: 0,
  view: null,
  winner: null,
  opponentWallet: null,
  tunnelId: null,
  connStatus: "closed",
  error: null,
};

/** A PvP window's store slot (the worker is the shared hub, not per-window). */
interface PvpWindow {
  snap: MatchSnapshot;
  listeners: Set<() => void>;
  /** Render-virtualization gate (ADR-0030): the match always runs in the worker, but a window that
   *  is off-screen (hidden workspace, minimized, scrolled away) stores its latest snapshot without
   *  notifying React — so no reconcile/paint — and is excluded from the shared render budget. */
  visible: boolean;
}

let bridge: MainBridge | null = null;
let config: EngineConfig | null = null;

const pvpWindows = new Map<string, PvpWindow>();

/**
 * Adaptive main-thread render throttle. The worker already coalesces its own snapshots, but with N
 * live windows the main thread still gets N independent streams — and each notify triggers a board
 * re-render. So we decouple "store the latest snapshot" (immediate, keeps getSnapshot fresh) from
 * "notify React" (throttled): a window re-renders at most once per `renderIntervalMs()`, which GROWS
 * with the live-window count so the TOTAL board-render rate stays ≈ constant no matter how many
 * windows are open. A status change (idle→playing→settled) and the trailing edge always notify, so
 * the UI never sticks on a stale frame.
 */
const RENDER_BASE_MS = 40; // single-window cadence (~25fps); ×N windows = the shared budget
const RENDER_MAX_MS = 250; // never starve a window below ~4fps, however many are open
interface SnapThrottle {
  lastNotifyMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastStatus: MatchSnapshot["status"] | null;
}
const snapThrottle = new Map<string, SnapThrottle>();

function renderIntervalMs(): number {
  // Virtualization off: don't throttle-up with window count — every window paints at the base cadence
  // so a single match's move-to-move flow is as smooth as it can be (freeze debug).
  if (!renderVirtualizationEnabled()) return RENDER_BASE_MS;
  // Only VISIBLE windows spend the shared render budget (ADR-0030): off-screen matches keep running
  // in the worker but don't paint, so on-screen boards aren't throttled paying for hidden ones.
  let n = 0;
  for (const w of pvpWindows.values()) if (w.visible) n++;
  return Math.min(RENDER_MAX_MS, Math.max(RENDER_BASE_MS, n * RENDER_BASE_MS));
}

/** Windows with a paint already queued for the next animation frame (virtualization-off path). */
const rafPending = new Set<string>();

/** Coalesce a window's React notify to ONE paint per animation frame (~display refresh, so no
 *  perceptible fps cap) instead of firing on every worker emit — which, with many AUTO games emitting
 *  rapidly, floods the main thread with re-renders and freezes the UI. The match keeps running in the
 *  worker regardless; this only bounds how often the main thread reconciles. */
function scheduleFrameNotify(
  windowId: string,
  listeners: Set<() => void>,
): void {
  if (rafPending.has(windowId)) return;
  rafPending.add(windowId);
  const flush = (): void => {
    rafPending.delete(windowId);
    for (const l of listeners) l();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else flush();
}

/** Store `snap` on the window's slot immediately, then notify its React listeners on the throttled
 *  cadence (leading + trailing). `store` writes the slot; `listeners` are the subscribers. */
function deliverSnapshot(
  windowId: string,
  listeners: Set<() => void>,
  snap: MatchSnapshot,
  store: (s: MatchSnapshot) => void,
): void {
  store(snap);
  // Virtualization OFF (the default): NO visibility gate, NO fps throttle — but coalesce to one paint
  // per animation frame so nothing caps the perceptible frame rate AND a burst of worker emits can't
  // flood React with re-renders (which froze the UI). No on-screen window is ever paused. The gate +
  // count-based throttle below run ONLY under `?rendervirt=1` (many-window mode).
  if (!renderVirtualizationEnabled()) {
    scheduleFrameNotify(windowId, listeners);
    return;
  }
  // Off-screen (ADR-0030): the latest snapshot is stored (getSnapshot stays fresh for the flush on
  // re-show), but skip the React notify entirely — no reconcile, no paint — while the match runs on.
  if (pvpWindows.get(windowId)?.visible === false) return;
  let t = snapThrottle.get(windowId);
  if (!t) {
    t = { lastNotifyMs: 0, timer: null, lastStatus: null };
    snapThrottle.set(windowId, t);
  }
  const throttle = t;
  const fire = (): void => {
    throttle.timer = null;
    throttle.lastNotifyMs = performance.now();
    for (const l of listeners) l();
  };
  const statusChanged = snap.status !== throttle.lastStatus;
  throttle.lastStatus = snap.status;
  const since = performance.now() - throttle.lastNotifyMs;
  const interval = renderIntervalMs();
  if (statusChanged || since >= interval) {
    if (throttle.timer) clearTimeout(throttle.timer);
    fire();
  } else if (throttle.timer === null) {
    throttle.timer = setTimeout(fire, interval - since);
  }
}

function clearSnapThrottle(windowId: string): void {
  const t = snapThrottle.get(windowId);
  if (t?.timer) clearTimeout(t.timer);
  snapThrottle.delete(windowId);
}

/** The single shared PvP hub worker + its wrapped API; null until the first PvP command spawns it. */
let hubWorker: Worker | null = null;
let hubApi: Comlink.Remote<PvpHubApi> | null = null;
let hubWired = false;

/** Called by EngineProvider/useConfigureEngine once the wallet is known. Idempotent, and it
 *  retroactively wires the hub if it spawned BEFORE the bridge was ready. */
export function configureEngine(
  cfg: EngineConfig,
  mainBridge: MainBridge,
): void {
  config = cfg;
  bridge = mainBridge;
  wireHub();
  // Pool lane: hand the (possibly retroactive) config to the socket worker if it already spawned.
  if (socketWorker) socketWorker.postMessage({ type: "config", config: cfg });
}

/** Fire a worker command without awaiting. The engine surfaces failures via the snapshot's
 *  `error` field (not the command's promise), so a rejection here is safe to swallow. */
function fire(p: Promise<unknown>): void {
  void p.catch(() => {});
}

// --- PvP lane: one shared hub worker for all windows ---------------------------------------

function wireHub(): void {
  if (hubWired || !hubApi || !config || !bridge) return;
  const onSnapshot = (windowId: string, snap: MatchSnapshot): void => {
    const w = pvpWindows.get(windowId);
    if (!w) return; // window disposed between the worker's emit and this callback
    deliverSnapshot(windowId, w.listeners, snap, (s) => {
      w.snap = s;
    });
  };
  fire(hubApi.init(config));
  fire(hubApi.attachBridge(Comlink.proxy(bridge)));
  fire(hubApi.subscribe(Comlink.proxy(onSnapshot)));
  hubWired = true;
  elog("client", "wired pvp hub");
}

/** Spawn (once) the shared PvP hub worker. */
function ensureHub(): Comlink.Remote<PvpHubApi> {
  if (hubApi) return hubApi;
  hubWorker = new Worker(new URL("./engine.pvp.worker.ts", import.meta.url), {
    type: "module",
    name: "[pvp-hub] all-pvp-matches",
  });
  registerEngineWorkerWithSentry(hubWorker);
  hubApi = Comlink.wrap<PvpHubApi>(hubWorker);
  hubWired = false;
  elog("client", "spawn pvp hub", { configured: !!(config && bridge) });
  wireHub();
  return hubApi;
}

/** Ensure a PvP window's store slot + its window-close disposer. */
function ensurePvpWindow(windowId: string): PvpWindow {
  let w = pvpWindows.get(windowId);
  if (w) return w;
  w = { snap: IDLE_SNAPSHOT, listeners: new Set(), visible: true };
  pvpWindows.set(windowId, w);
  registerWindowDisposer(windowId, "engine", () => disposeWindow(windowId));
  return w;
}

// --- Pool lane: one shared socket worker + one game worker per window (ADR-0030, ?enginepool) ------
// Opt-in alternative to the shared hub: co-sign runs in a per-window isolate (parallel across cores,
// fault-isolated), while ONE socket worker keeps the single-relay-socket invariant. A game worker's
// `mp` is a RemoteMpClient proxying the narrow relay surface over a private MessagePort to the socket
// worker, so the PvpMatchSession inside runs identically to the hub path.
let socketWorker: Worker | null = null;
const gameWorkers = new Map<
  string,
  { worker: Worker; api: Comlink.Remote<GameWorkerApi> }
>();

/** Spawn (once) the shared socket worker and hand it the config so it opens the one relay socket. */
function ensureSocketWorker(): Worker {
  if (socketWorker) return socketWorker;
  socketWorker = new Worker(new URL("./socket.worker.ts", import.meta.url), {
    type: "module",
    name: "[pvp-socket] shared relay",
  });
  registerEngineWorkerWithSentry(socketWorker);
  if (config) socketWorker.postMessage({ type: "config", config });
  elog("client", "spawn socket worker");
  return socketWorker;
}

/** Spawn (once per window) a game worker, wire its private port to the socket worker, and init its
 *  session. Returns null until `configureEngine` has run (config + bridge ready): the worker MUST be
 *  init'd before any command reaches it (its session reads `config`/`bridge`/`mp`), so — like the hub,
 *  which no-ops uncofigured commands — the caller skips the command rather than driving a bare worker. */
function ensureGameWorker(
  windowId: string,
): Comlink.Remote<GameWorkerApi> | null {
  const existing = gameWorkers.get(windowId);
  if (existing) return existing.api;
  if (!config || !bridge) return null; // not configured yet — don't spawn an un-init'd worker
  const sw = ensureSocketWorker();
  const worker = new Worker(
    new URL("./engine.game.worker.ts", import.meta.url),
    {
      type: "module",
      name: `[pvp-game] ${windowId}`,
    },
  );
  registerEngineWorkerWithSentry(worker);
  const api = Comlink.wrap<GameWorkerApi>(worker);
  gameWorkers.set(windowId, { worker, api });
  // Private channel game worker ↔ socket worker: transfer one end to each side. `windowId` lets the
  // socket worker dispose this host on `detach` (disposeWindow) instead of leaking its subs + port.
  const { port1, port2 } = new MessageChannel();
  sw.postMessage({ type: "attach", windowId }, [port2]);
  const onSnapshot = (snap: MatchSnapshot): void => {
    const w = pvpWindows.get(windowId);
    if (!w) return;
    deliverSnapshot(windowId, w.listeners, snap, (s) => {
      w.snap = s;
    });
  };
  fire(
    api.init(
      config,
      Comlink.proxy(bridge),
      windowId,
      Comlink.transfer(port1, [port1]),
      Comlink.proxy(onSnapshot),
    ),
  );
  return api;
}

/** Push a window's visibility into its worker so it stops EMITTING snapshots while off-screen (Phase-1
 *  `setWindowVisible` already gates the main-thread render; this saves the upstream postMessage too). */
function propagateVisibility(windowId: string, visible: boolean): void {
  // Virtualization off: never tell the worker to stop emitting — the main thread wants every snapshot.
  if (!renderVirtualizationEnabled()) return;
  if (enginePoolEnabled()) {
    const gw = gameWorkers.get(windowId);
    if (gw) fire(gw.api.setVisibility(visible));
  } else if (hubApi) {
    fire(hubApi.setVisibility(windowId, visible));
  }
}

/** Pool resume: mirror the hub — peek IndexedDB first and only spawn a game worker for a window that
 *  actually has a match to resume, so a fresh open sits at its lobby (no worker) until the user plays. */
async function resumePoolWindow(
  windowId: string,
  gameId: GameId,
): Promise<void> {
  let records;
  try {
    records = await resumeIdb.getAllByGame(gameId);
  } catch {
    return;
  }
  if (!records || records.length === 0) return;
  const api = ensureGameWorker(windowId);
  if (api) fire(api.resume(gameId));
}

// --- dispose ------------------------------------------------------------------------------

function disposeWindow(windowId: string): void {
  const w = pvpWindows.get(windowId);
  if (!w) return;
  pvpWindows.delete(windowId);
  clearSnapThrottle(windowId);
  if (enginePoolEnabled()) {
    const gw = gameWorkers.get(windowId);
    if (!gw) return;
    gameWorkers.delete(windowId);
    // Reset the session (releases its matchId from the shared socket), then reclaim the isolate; when
    // the last game worker goes, terminate the shared socket worker so an idle arena holds no socket.
    const finish = (): void => {
      gw.api[Comlink.releaseProxy]();
      gw.worker.terminate();
      // Dispose this window's host in the socket worker (unsub its MpClient events, release its
      // channels, drop its port) so a closed window leaves nothing behind on the shared socket.
      socketWorker?.postMessage({ type: "detach", windowId });
      if (gameWorkers.size === 0 && socketWorker) {
        socketWorker.terminate();
        socketWorker = null;
      }
    };
    gw.api.reset().then(finish, finish);
    return;
  }
  // Tear this window's match down inside the hub (cancels a queued open, releases the matchId from
  // the shared socket, and closes the socket if it was the last session). Then, if no PvP windows
  // remain, terminate the hub worker to reclaim its isolate (re-spawned on the next PvP command).
  const api = hubApi;
  const finishIfEmpty = (): void => {
    if (pvpWindows.size > 0 || !hubWorker) return;
    hubApi?.[Comlink.releaseProxy]();
    hubWorker.terminate();
    hubWorker = null;
    hubApi = null;
    hubWired = false;
  };
  if (api) api.reset(windowId).then(finishIfEmpty, finishIfEmpty);
  else finishIfEmpty();
}

// --- public surface (the React bindings call these) ---------------------------------------

export const engineClient = {
  /** Subscribe to a window's snapshot store (the shared hub fans this window's snapshots here). */
  subscribe(windowId: string, cb: () => void): () => void {
    const w = ensurePvpWindow(windowId);
    w.listeners.add(cb);
    return () => w.listeners.delete(cb);
  },

  getSnapshot(windowId: string): MatchSnapshot {
    return pvpWindows.get(windowId)?.snap ?? IDLE_SNAPSHOT;
  },

  /** Render-virtualization signal from the desktop (ADR-0030): report whether a window is on-screen.
   *  Off-screen keeps the match running in the worker but stops main-thread render; becoming visible
   *  flushes the latest stored snapshot once so the UI catches up. No-op for unknown ids (the store
   *  slot is created by `subscribe` on mount, which runs before the IntersectionObserver's callback). */
  setWindowVisible(windowId: string, visible: boolean): void {
    const w = pvpWindows.get(windowId);
    if (!w || w.visible === visible) return;
    w.visible = visible;
    const t = snapThrottle.get(windowId);
    if (visible) {
      // Reset the throttle clock so this flush is the last notify, then catch the UI up in one paint.
      if (t) {
        if (t.timer) clearTimeout(t.timer);
        t.timer = null;
        t.lastNotifyMs = performance.now();
      }
      for (const l of w.listeners) l();
    } else if (t?.timer) {
      // Cancel a pending trailing notify so a now-hidden window can't re-render off-screen.
      clearTimeout(t.timer);
      t.timer = null;
    }
  },

  /** Live PvP window slots vs the device live-window guideline — surfaced by the perf HUD. The PvP
   *  hub is a single shared isolate, so windows never contend for per-window workers (`atCap` false). */
  liveWindowStats(): { live: number; max: number; atCap: boolean } {
    return { live: pvpWindows.size, max: maxLiveWindows(), atCap: false };
  },

  // PvP commands → shared hub.
  findMatch(windowId: string, gameId: GameId, setup?: unknown): void {
    ensurePvpWindow(windowId);
    if (enginePoolEnabled()) {
      const api = ensureGameWorker(windowId);
      if (api) fire(api.findMatch(gameId, setup));
      return;
    }
    fire(ensureHub().findMatch(windowId, gameId, setup));
  },
  resume(windowId: string, gameId: GameId): void {
    ensurePvpWindow(windowId);
    if (enginePoolEnabled()) {
      void resumePoolWindow(windowId, gameId);
      return;
    }
    fire(ensureHub().resume(windowId, gameId));
  },
  /** Arena entry (ADR-0028): hand the worker a fleet allocation (pre-opened tunnel + main-minted key)
   *  to join + play, instead of quickMatch + open. Funding already happened on main (batched PTB). */
  enterArenaMatch(
    windowId: string,
    gameId: GameId,
    entry: WorkerArenaEntry,
  ): void {
    ensurePvpWindow(windowId);
    if (enginePoolEnabled()) {
      const api = ensureGameWorker(windowId);
      if (api) fire(api.enterArenaMatch(gameId, entry));
      return;
    }
    fire(ensureHub().enterArenaMatch(windowId, gameId, entry));
  },
  submitInput(windowId: string, input: unknown): void {
    if (enginePoolEnabled()) {
      const gw = gameWorkers.get(windowId);
      if (gw) fire(gw.api.submitInput(input));
      return;
    }
    if (hubApi) fire(hubApi.submitInput(windowId, input));
  },
  setAuto(windowId: string, on: boolean): void {
    if (enginePoolEnabled()) {
      const gw = gameWorkers.get(windowId);
      if (gw) fire(gw.api.setAuto(on));
      return;
    }
    if (hubApi) fire(hubApi.setAuto(windowId, on));
  },
  setVisibility(windowId: string, visible: boolean): void {
    propagateVisibility(windowId, visible);
  },
  reset(windowId: string): void {
    if (enginePoolEnabled()) {
      const gw = gameWorkers.get(windowId);
      if (gw) fire(gw.api.reset());
      return;
    }
    if (hubApi) fire(hubApi.reset(windowId));
  },
  /** Terminate a window's match in the hub and reclaim (also auto-run on window close). */
  dispose(windowId: string): void {
    disposeWindow(windowId);
  },
  disposeWindow(windowId: string): void {
    disposeWindow(windowId);
  },
};
