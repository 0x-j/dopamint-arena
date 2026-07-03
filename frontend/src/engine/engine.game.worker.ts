/**
 * Per-window GAME worker (ADR-0030, Phase 2). Hosts exactly ONE {@link PvpMatchSession}; `engineClient`
 * spawns one of these per PvP window so co-signing spreads across cores and a game's fault is isolated
 * to its own isolate. Its relay client is a {@link RemoteMpClient} over a `MessagePort` to the shared
 * socket worker (transferred in via `init`), so the session — which only touches the narrow
 * {@link RelayClient} surface — runs UNCHANGED from the shared-hub path.
 */
import * as Comlink from "comlink";
import { PvpMatchSession } from "./pvpMatchSession";
import { RemoteMpClient } from "./pool/remoteMpClient";
import { getSpec } from "./specs/registry";
import { elog } from "./debug";
import type { BridgePort } from "./pool/socketBridge";
import { initWorkerSentry } from "@/sentry/workerSentry";
import type {
  EngineConfig,
  GameId,
  MainBridge,
  MatchSnapshot,
  WorkerArenaEntry,
} from "./engineApi";

// Before Comlink.expose: Sentry must be wired on both sides before either listens.
initWorkerSentry();

let session: PvpMatchSession | null = null;
let remoteMp: RemoteMpClient | null = null;
let config: EngineConfig | null = null;
let bridge: MainBridge | null = null;
let emit: ((snap: MatchSnapshot) => void) | null = null;
let windowId = "";

function ensureSession(): PvpMatchSession {
  if (session) return session;
  session = new PvpMatchSession({
    windowId,
    mp: remoteMp!,
    config: config!,
    bridge: bridge!,
    getSpec,
    emit: (snap) => emit?.(snap),
    connStatus: () => remoteMp?.connStatus() ?? "closed",
  });
  return session;
}

/** Per-window command surface (the hub's, minus the windowId — this worker owns one window). `init`
 *  receives the transferred socket-worker port + Comlink-proxied bridge/snapshot sink from main. */
export interface GameWorkerApi {
  init(
    cfg: EngineConfig,
    br: MainBridge,
    wid: string,
    socketPort: MessagePort,
    onSnapshot: (snap: MatchSnapshot) => void,
  ): void;
  findMatch(gameId: GameId, setup?: unknown): void;
  enterArenaMatch(gameId: GameId, entry: WorkerArenaEntry): void;
  resume(gameId: GameId): void;
  submitInput(input: unknown): void;
  setAuto(on: boolean): void;
  setVisibility(visible: boolean): void;
  reset(): Promise<void>;
}

const api: GameWorkerApi = {
  init(cfg, br, wid, socketPort, onSnapshot) {
    config = cfg;
    bridge = br;
    windowId = wid;
    emit = onSnapshot;
    remoteMp = new RemoteMpClient(socketPort as unknown as BridgePort);
    remoteMp.onConn(() => session?.refreshConn());
  },
  findMatch: (gameId, setup) => void ensureSession().findMatch(gameId, setup),
  enterArenaMatch: (gameId, entry) =>
    void ensureSession().enterArena(gameId, entry),
  resume: (gameId) => void ensureSession().resume(gameId),
  submitInput: (input) => session?.submitInput(input),
  setAuto: (on) => session?.setAuto(on),
  setVisibility: (visible) => session?.setVisibility(visible),
  reset: async () => {
    // Discard the session after teardown so the next findMatch builds a fresh one (the hub path
    // recreates its session per match too); the RemoteMpClient + its socket port are reused.
    await session?.reset();
    session = null;
  },
};

Comlink.expose(api);
elog("worker", "pvp-game booted", typeof self !== "undefined" ? self.name : "");
