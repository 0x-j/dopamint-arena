/**
 * Game-worker-side proxy of the socket worker's {@link MpClient} (ADR-0030, Phase 2). Implements
 * EXACTLY the surface {@link PvpMatchSession} uses — `quickMatch` / `joinMatch` / `channel` /
 * `announceTunnel` / `releaseMatch` / `resumeMatch` — by forwarding over a private `MessagePort`;
 * the socket worker holds the real socket and demuxes inbound frames back by matchId. Because the
 * session touches nothing else, it runs unchanged with a `RemoteMpClient` in place of the shared one.
 */
import type {
  PvpChannel,
  MatchInfo,
  RelayClient,
  ResumeOkEvent,
  PeerResumedEvent,
  PeerDroppedEvent,
} from "@/pvp/mpClient";
import type { ConnStatus } from "@/engine/engineApi";
import type {
  BridgePort,
  BridgeEvent,
  BridgeRequest,
  SidePeerMessage,
} from "./socketBridge";

type PeerCb = (msg: SidePeerMessage) => void;

/** Per-match receive state on the game side: the engine's frame sink (once wired) plus a buffer for
 *  frames that land before it, mirroring `MpClient.channel`'s activation-race buffer one hop out. */
interface RemoteChannel {
  onFrame: ((bytes: Uint8Array) => void) | null;
  frameBuffer: Uint8Array[];
  peerCbs: Set<PeerCb>;
}

export class RemoteMpClient implements RelayClient {
  #reqId = 0;
  readonly #waiters = new Map<
    number,
    { resolve: (m: MatchInfo) => void; reject: (e: Error) => void }
  >();
  readonly #channels = new Map<string, RemoteChannel>();
  /** Shared socket lifecycle, pushed from the socket worker's `conn` broadcasts (design §7). The
   *  session reads this via its `connStatus` getter; `#onConn` lets the worker `refreshConn` on change. */
  #connStatus: ConnStatus = "connecting";
  #onConn: (() => void) | null = null;
  readonly #resumeOkCbs = new Set<(e: ResumeOkEvent) => void>();
  readonly #peerResumedCbs = new Set<(e: PeerResumedEvent) => void>();
  readonly #peerDroppedCbs = new Set<(e: PeerDroppedEvent) => void>();

  constructor(private readonly port: BridgePort) {
    port.onmessage = (ev) => this.#onEvent(ev.data as BridgeEvent);
  }

  connStatus(): ConnStatus {
    return this.#connStatus;
  }

  /** Notified when the shared socket's status changes (the game worker calls `session.refreshConn`). */
  onConn(cb: () => void): void {
    this.#onConn = cb;
  }

  #post(req: BridgeRequest): void {
    this.port.postMessage(req);
  }

  #onEvent(e: BridgeEvent): void {
    switch (e.k) {
      case "matchOk": {
        const w = this.#waiters.get(e.reqId);
        if (w) {
          this.#waiters.delete(e.reqId);
          w.resolve(e.match);
        }
        return;
      }
      case "matchErr": {
        const w = this.#waiters.get(e.reqId);
        if (w) {
          this.#waiters.delete(e.reqId);
          w.reject(new Error(e.error));
        }
        return;
      }
      case "frame": {
        const ch = this.#channels.get(e.matchId);
        if (!ch) return;
        if (ch.onFrame) ch.onFrame(e.bytes);
        else ch.frameBuffer.push(e.bytes);
        return;
      }
      case "peer": {
        this.#channels.get(e.matchId)?.peerCbs.forEach((cb) => cb(e.msg));
        return;
      }
      case "conn":
        this.#connStatus = e.status;
        this.#onConn?.();
        return;
      case "resumeOk":
        this.#resumeOkCbs.forEach((cb) => cb(e.e));
        return;
      case "peerResumed":
        this.#peerResumedCbs.forEach((cb) => cb(e.e));
        return;
      case "peerDropped":
        this.#peerDroppedCbs.forEach((cb) => cb(e.e));
        return;
    }
  }

  quickMatch(game: string): Promise<MatchInfo> {
    const reqId = ++this.#reqId;
    const p = new Promise<MatchInfo>((resolve, reject) =>
      this.#waiters.set(reqId, { resolve, reject }),
    );
    this.#post({ k: "quickMatch", reqId, game });
    return p;
  }

  joinMatch(matchId: string): Promise<MatchInfo> {
    const reqId = ++this.#reqId;
    const p = new Promise<MatchInfo>((resolve, reject) =>
      this.#waiters.set(reqId, { resolve, reject }),
    );
    this.#post({ k: "joinMatch", reqId, matchId });
    return p;
  }

  channel(matchId: string): PvpChannel {
    let ch = this.#channels.get(matchId);
    if (!ch) {
      ch = { onFrame: null, frameBuffer: [], peerCbs: new Set() };
      this.#channels.set(matchId, ch);
    }
    const chan = ch;
    // Ask the socket worker to route this match's inbound frames/peer to our port (idempotent — the
    // socket also wires routing eagerly on match delivery, so frames can't drop in the hop's window).
    this.#post({ k: "openChannel", matchId });
    return {
      transport: {
        send: (bytes) => this.#post({ k: "sendFrame", matchId, bytes }),
        onFrame: (cb) => {
          chan.onFrame = cb;
          if (chan.frameBuffer.length) {
            const pending = chan.frameBuffer.splice(0);
            for (const b of pending) cb(b);
          }
        },
      },
      sendPeer: (msg) => this.#post({ k: "sendPeer", matchId, msg }),
      onPeer: (cb) => {
        chan.peerCbs.clear();
        chan.peerCbs.add(cb);
      },
      addPeerListener: (cb) => {
        chan.peerCbs.add(cb);
      },
      removePeerListener: (cb) => {
        chan.peerCbs.delete(cb);
      },
    };
  }

  announceTunnel(matchId: string, tunnelId: string): void {
    this.#post({ k: "announce", matchId, tunnelId });
  }

  releaseMatch(matchId: string): void {
    this.#post({ k: "release", matchId });
    this.#channels.delete(matchId);
  }

  resumeMatch(matchId: string): void {
    this.#post({ k: "resume", matchId });
  }

  markActive(matchId: string): void {
    this.#post({ k: "markActive", matchId });
  }

  onResumeOk(cb: (e: ResumeOkEvent) => void): () => void {
    this.#resumeOkCbs.add(cb);
    return () => this.#resumeOkCbs.delete(cb);
  }

  onPeerResumed(cb: (e: PeerResumedEvent) => void): () => void {
    this.#peerResumedCbs.add(cb);
    return () => this.#peerResumedCbs.delete(cb);
  }

  onPeerDropped(cb: (e: PeerDroppedEvent) => void): () => void {
    this.#peerDroppedCbs.add(cb);
    return () => this.#peerDroppedCbs.delete(cb);
  }
}
