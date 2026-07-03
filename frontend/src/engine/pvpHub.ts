/**
 * The shared PvP hub (M1: ONE relay socket for all PvP windows). Owns a single {@link MpClient}
 * — one WebSocket — and a {@link PvpMatchSession} per game window, multiplexed by matchId. The
 * dedicated `engine.pvp.worker.ts` `Comlink.expose`s this; `engineClient` routes every PvP window's
 * commands here keyed by `windowId`, and the hub fans each match's snapshots back tagged by window.
 *
 * Why one socket: PvP play is RTT-bound, so the per-window CPU isolation that matters for solo
 * self-play buys little here, while many auto-PvP windows each holding a socket pressures the relay.
 * The connection ephemeral authenticates the socket only; each match still mints its OWN tunnel
 * ephemeral inside the session, so matches stay cryptographically independent over the shared wire.
 */
import { MpClient } from "@/pvp/mpClient";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { elog } from "./debug";
import { resumeIdb } from "./persist/idb";
import { captureWorkerException } from "@/sentry/workerSentry";
import { PvpMatchSession } from "./pvpMatchSession";
import type {
  ConnStatus,
  EngineConfig,
  GameId,
  GameSessionSpec,
  MainBridge,
  MatchSnapshot,
  WorkerArenaEntry,
} from "./engineApi";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySpec = GameSessionSpec<any, any, any, any, any>;

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

export class PvpHub {
  private config: EngineConfig | null = null;
  private bridge: MainBridge | null = null;
  private onSnapshot: ((windowId: string, snap: MatchSnapshot) => void) | null =
    null;

  /** The one shared socket; null until the first match opens it, and again after the last closes. */
  private mp: MpClient | null = null;
  /** Memoizes an in-flight connect so concurrent first matches share ONE socket open. */
  private connecting: Promise<MpClient> | null = null;
  /** Shared socket lifecycle, surfaced into every session's snapshot (design §7). */
  private connStatus: ConnStatus = "closed";

  private readonly sessions = new Map<string, PvpMatchSession>();

  constructor(
    private readonly getSpec: (gameId: GameId) => AnySpec | undefined,
  ) {}

  init(config: EngineConfig): void {
    this.config = config;
  }

  attachBridge(bridge: MainBridge): void {
    this.bridge = bridge;
  }

  subscribe(onSnapshot: (windowId: string, snap: MatchSnapshot) => void): void {
    this.onSnapshot = onSnapshot;
  }

  /** Lazily open the shared socket (memoized). The connection ephemeral is for socket auth only —
   *  each match mints its own tunnel ephemeral. Re-throws on connect failure and clears the memo so
   *  a later command can retry. */
  private ensureSocket(): Promise<MpClient> {
    if (this.mp) return Promise.resolve(this.mp);
    if (this.connecting) return this.connecting;
    const config = this.config;
    if (!config) return Promise.reject(new Error("pvp hub not configured"));
    const attempt = (async () => {
      const connEph = generateKeyPair();
      const mp = new MpClient(config.mpWsUrl, config.wallet, connEph);
      this.connStatus = "connecting";
      this.emitAllConn();
      // The relay has no rejoin-by-matchId, but MpClient auto-reconnects and re-resumes active
      // matches; reflect that as reconnecting → open across ALL sessions on the shared socket.
      mp.onClose = () => {
        this.connStatus = "reconnecting";
        this.emitAllConn();
      };
      mp.onResumeOk(() => {
        this.connStatus = "open";
        this.emitAllConn();
      });
      await mp.connect();
      this.connStatus = "open";
      this.mp = mp;
      this.connecting = null;
      this.emitAllConn();
      elog("pvphub", "socket open", { sessions: this.sessions.size });
      return mp;
    })();
    this.connecting = attempt.catch((e) => {
      this.connecting = null;
      this.connStatus = "closed";
      throw e;
    });
    return this.connecting;
  }

  private emitAllConn(): void {
    for (const s of this.sessions.values()) s.refreshConn();
  }

  private session(windowId: string, mp: MpClient): PvpMatchSession {
    let s = this.sessions.get(windowId);
    if (s) return s;
    s = new PvpMatchSession({
      windowId,
      mp,
      config: this.config!,
      bridge: this.bridge!,
      getSpec: this.getSpec,
      emit: (snap) => this.onSnapshot?.(windowId, snap),
      connStatus: () => this.connStatus,
    });
    this.sessions.set(windowId, s);
    return s;
  }

  private failWindow(windowId: string, e: unknown): void {
    // The snapshot only carries the message; this keeps the stack (forwarded to Sentry).
    captureWorkerException(e, { windowId });
    this.onSnapshot?.(windowId, {
      ...IDLE_SNAPSHOT,
      status: "error",
      error: String((e as Error)?.message ?? e),
    });
  }

  async findMatch(
    windowId: string,
    gameId: GameId,
    setup?: unknown,
  ): Promise<void> {
    if (!this.config || !this.bridge) {
      this.failWindow(windowId, new Error("pvp hub not configured"));
      return;
    }
    let mp: MpClient;
    try {
      mp = await this.ensureSocket();
    } catch (e) {
      this.failWindow(windowId, e);
      return;
    }
    await this.session(windowId, mp).findMatch(gameId, setup);
  }

  async enterArenaMatch(
    windowId: string,
    gameId: GameId,
    entry: WorkerArenaEntry,
  ): Promise<void> {
    if (!this.config || !this.bridge) {
      this.failWindow(windowId, new Error("pvp hub not configured"));
      return;
    }
    let mp: MpClient;
    try {
      mp = await this.ensureSocket();
    } catch (e) {
      this.failWindow(windowId, e);
      return;
    }
    await this.session(windowId, mp).enterArena(gameId, entry);
  }

  async resume(windowId: string, gameId: GameId): Promise<void> {
    if (!this.config || !this.bridge) return;
    // Peek IndexedDB before opening the socket: a fresh cold load of every PvP window would otherwise
    // open the relay needlessly (no persisted match → nothing to resume). This is cheap (~1ms) and
    // avoids waking the relay connection for idle windows.
    let records;
    try {
      records = await resumeIdb.getAllByGame(gameId);
    } catch {
      return;
    }
    if (!records || records.length === 0) return;
    let mp: MpClient;
    try {
      mp = await this.ensureSocket();
    } catch {
      return; // no live socket → nothing to resume onto; a later findMatch retries
    }
    await this.session(windowId, mp).resume(gameId);
  }

  submitInput(windowId: string, input: unknown): void {
    this.sessions.get(windowId)?.submitInput(input);
  }

  setAuto(windowId: string, on: boolean): void {
    this.sessions.get(windowId)?.setAuto(on);
  }

  setVisibility(windowId: string, visible: boolean): void {
    this.sessions.get(windowId)?.setVisibility(visible);
  }

  /** Tear ONE window's match down and release its matchId from the shared socket. When the last
   *  session goes, close the socket so an idle arena holds no relay connection. */
  async reset(windowId: string): Promise<void> {
    const s = this.sessions.get(windowId);
    if (!s) return;
    await s.reset();
    this.sessions.delete(windowId);
    if (this.sessions.size === 0) {
      this.mp?.close();
      this.mp = null;
      this.connecting = null;
      this.connStatus = "closed";
      elog("pvphub", "socket closed (no sessions)");
    }
  }
}
