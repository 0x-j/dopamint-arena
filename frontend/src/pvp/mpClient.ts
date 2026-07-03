// PvP control-plane client for GET /v1/mp (ADR-0004 / spec §4). Opens the WS, authenticates
// the connection by signing the server challenge with the EPHEMERAL key, runs matchmaking,
// and multiplexes two channels over the opaque relay:
//   - engine frames (MOVE/ACK) → the DistributedTunnel `Transport`
//   - peer app messages (ephemeral-key exchange, tunnel id, ready, settle halves)
// The wallet address is only a matchmaking/identity label; security rests on the co-signed
// on-chain artifacts, never on the relay.
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { toHex } from "sui-tunnel-ts/core/bytes";
import type { KeyPair } from "sui-tunnel-ts/core/crypto";
import type { Transport } from "sui-tunnel-ts/core/distributedTunnel";
import { wrapInnerFrameJson } from "sui-tunnel-ts/core/distributedFrame";
import type { WireCoSigned, JsonValue } from "./resume";
import { stringifyWithBigint, parseWithBigint } from "./resume";

export type Role = "A" | "B";

export interface MatchInfo {
  matchId: string;
  role: Role;
  opponentWallet: string;
  game: string;
}

export interface ResumeOkEvent {
  matchId: string;
  role: Role;
  opponentWallet: string;
  game: string;
  peerOnline: boolean;
}
export interface PeerResumedEvent {
  matchId: string;
  seat: Role;
  /** Server-side routing only — the FE ignores its contents. */
  connRef: unknown;
}
export interface PeerDroppedEvent {
  matchId: string;
}

export interface ReconnectConfig {
  baseMs: number;
  maxMs: number;
  jitter: number;
}
const DEFAULT_RECONNECT: ReconnectConfig = {
  baseMs: 500,
  maxMs: 10_000,
  jitter: 0.2,
};

/** Capped exponential backoff with symmetric jitter. `attempt` is 0-based. `rand` ∈ [0,1). */
export function nextBackoffDelay(
  attempt: number,
  cfg: ReconnectConfig,
  rand: () => number,
): number {
  const capped = Math.min(cfg.maxMs, cfg.baseMs * 2 ** attempt);
  const spread = capped * cfg.jitter;
  return Math.round(capped - spread + rand() * spread * 2);
}

interface MpClientOptions {
  WebSocketCtor?: typeof WebSocket;
  reconnect?: ReconnectConfig;
  scheduler?: (fn: () => void, ms: number) => void;
  rand?: () => number;
}

/** A peer message tunneled through the relay (everything that isn't a MOVE/ACK frame). */
export type PeerMessage =
  | { t: "hello"; ephemeralPubkey: string }
  | { t: "open"; tunnelId: string }
  | { t: "ready" }
  | { t: "endMatch"; leaving?: boolean }
  | {
      t: "settleHalf";
      partyABalance: string;
      partyBBalance: string;
      finalNonce: string;
      timestamp: string;
      transcriptRoot: string;
      sig: string;
    }
  | {
      // Bare forfeit intent: the human concedes. The bot sources every settlement field itself
      // (root/timestamp/nonce/forced 0-total balances) and replies on `settleHalf`, so nothing rides
      // in this frame. Distinct tag so a natural-terminal co-sign never mistakes it for the close.
      t: "forfeit";
    }
  | { t: "opened"; tunnelId: string }
  | { t: "settle"; sig: string; root: string }
  | { t: "closed"; digest: string }
  | { t: "stop" }
  | { t: "stake"; amount: number }
  | {
      t: "resync";
      nonce: string;
      hasPending: boolean;
      checkpoint?: WireCoSigned;
      fullState?: JsonValue;
    }
  | { t: "frame"; data: string };

/** Engine transport + a peer-message side channel, both over one match's relay. */
export interface PvpChannel {
  transport: Transport;
  sendPeer(msg: Exclude<PeerMessage, { t: "frame" }>): void;
  onPeer(cb: (msg: Exclude<PeerMessage, { t: "frame" }>) => void): void;
  addPeerListener(
    cb: (msg: Exclude<PeerMessage, { t: "frame" }>) => void,
  ): void;
  removePeerListener(
    cb: (msg: Exclude<PeerMessage, { t: "frame" }>) => void,
  ): void;
}

const te = new TextEncoder();

/** Derive the /v1/mp WS URL from the backend base (empty => same-origin dev proxy). */
export function resolveMpWsUrl(backendUrl: string): string {
  const base =
    backendUrl || (typeof location !== "undefined" ? location.origin : "");
  return base.replace(/^http/, "ws").replace(/\/+$/, "") + "/v1/mp";
}

export class MpClient {
  #ws: WebSocket | null = null;
  readonly #url: string;
  readonly #wallet: string;
  readonly #ephemeral: KeyPair;
  readonly #sign: (msg: Uint8Array) => Uint8Array;
  #connected = false;
  #intentionalClose = false;

  /** Fires when the socket closes UNEXPECTEDLY (relay/connection drop), not on our own
   *  close(). The relay has no rejoin-by-matchId, so a mid-match drop can't be resumed —
   *  consumers use this only to surface a clear "connection lost" state instead of a stall. */
  onClose: (() => void) | null = null;

  // Multiplexing (spec decision #6): route inbound relay frames by matchId, and hand each
  // match.found to the next waiting quickMatch (FIFO). This lets ONE socket run MANY concurrent
  // tunnels — the single-match path is just the degenerate case (one handler, one waiter).
  readonly #relayHandlers = new Map<string, (payload: string) => void>();
  #matchQueue: MatchInfo[] = [];
  #matchWaiters: {
    resolve: (m: MatchInfo) => void;
    reject: (e: Error) => void;
  }[] = [];

  // Reconnect + resume state. The relay-handler map, match queue/waiters, active-match
  // registry, and queued-game list all survive a socket swap so a dropped connection
  // re-attaches transparently.
  #closing = false;
  #reconnectAttempt = 0;
  #activeMatches = new Set<string>();
  #queuedGames: string[] = [];
  readonly #WebSocketCtor: typeof WebSocket;
  readonly #reconnectCfg: ReconnectConfig;
  readonly #schedule: (fn: () => void, ms: number) => void;
  readonly #rand: () => number;
  readonly #resumeOkSubs = new Set<(e: ResumeOkEvent) => void>();
  readonly #peerResumedSubs = new Set<(e: PeerResumedEvent) => void>();
  readonly #peerDroppedSubs = new Set<(e: PeerDroppedEvent) => void>();

  constructor(
    url: string,
    wallet: string,
    ephemeral: KeyPair,
    opts: MpClientOptions = {},
  ) {
    this.#url = url;
    this.#wallet = wallet;
    this.#ephemeral = ephemeral;
    this.#sign = defaultBackend().makeSigner(ephemeral.secretKey!);
    this.#WebSocketCtor = opts.WebSocketCtor ?? WebSocket;
    this.#reconnectCfg = opts.reconnect ?? DEFAULT_RECONNECT;
    this.#schedule =
      opts.scheduler ??
      ((fn, ms) => {
        setTimeout(fn, ms);
      });
    this.#rand = opts.rand ?? Math.random;
  }

  onResumeOk(cb: (e: ResumeOkEvent) => void): () => void {
    this.#resumeOkSubs.add(cb);
    return () => this.#resumeOkSubs.delete(cb);
  }
  onPeerResumed(cb: (e: PeerResumedEvent) => void): () => void {
    this.#peerResumedSubs.add(cb);
    return () => this.#peerResumedSubs.delete(cb);
  }
  onPeerDropped(cb: (e: PeerDroppedEvent) => void): () => void {
    this.#peerDroppedSubs.add(cb);
    return () => this.#peerDroppedSubs.delete(cb);
  }
  /** Register a match so the reconnect loop will `resume` it. */
  markActive(matchId: string): void {
    this.#activeMatches.add(matchId);
  }

  /** Open the socket and complete the challenge→connect handshake. Installs the persistent
   *  onclose handler that drives reconnection. Reconnects reuse #openSocket. */
  connect(): Promise<void> {
    this.#closing = false;
    return this.#openSocket(false);
  }

  /** `isReconnect` re-attaches active matches / re-queues the moment the handshake completes,
   *  synchronously, so a fresh socket carries the resume frames before any further turn. */
  #openSocket(isReconnect: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new this.#WebSocketCtor(this.#url);
      this.#ws = ws;
      let opened = false;
      ws.onmessage = (ev) => {
        const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (m.type === "challenge") {
          const sig = this.#sign(te.encode(m.nonce));
          ws.send(
            JSON.stringify({
              type: "connect",
              wallet: this.#wallet,
              pubkey: toHex(this.#ephemeral.publicKey),
              sig: toHex(sig),
              nonce: m.nonce,
            }),
          );
          this.#connected = true;
          opened = true;
          if (isReconnect) this.#reconnectAttempt = 0;
          // Resume on EVERY connect, not only reconnects: cold-load registers active matches
          // before the first connect, so the opening handshake must carry their resume frames.
          this.#resumeActive();
          resolve();
        } else if (m.type === "match.found") {
          this.#activeMatches.add(m.matchId as string);
          this.#dropQueued(m.game as string);
          this.#deliverMatch({
            matchId: m.matchId as string,
            role: m.role as Role,
            opponentWallet: m.opponentWallet as string,
            game: m.game as string,
          });
        } else if (m.type === "relay") {
          this.#relayHandlers.get(m.matchId as string)?.(m.payload as string);
        } else if (m.type === "resume.ok") {
          this.#activeMatches.add(m.matchId as string);
          this.#emitResumeOk({
            matchId: m.matchId as string,
            role: m.role as Role,
            opponentWallet: m.opponentWallet as string,
            game: m.game as string,
            peerOnline: !!m.peerOnline,
          });
        } else if (m.type === "peer.resumed") {
          this.#emitPeerResumed({
            matchId: m.matchId as string,
            seat: m.seat as Role,
            connRef: m.connRef,
          });
        } else if (m.type === "peer.dropped") {
          this.#emitPeerDropped({ matchId: m.matchId as string });
        } else if (m.type === "queue.timeout") {
          this.#failNextMatch(new Error("queue.timeout"));
        } else if (m.type === "error") {
          if (!this.#connected) reject(new Error(`mp ${m.code}: ${m.message}`));
          else this.#failNextMatch(new Error(`mp ${m.code}: ${m.message}`));
        }
      };
      ws.onerror = () => {
        if (!opened && !this.#connected)
          reject(new Error("mp websocket error"));
      };
      ws.onclose = () => {
        this.#ws = null;
        if (!this.#closing) this.#scheduleReconnect();
      };
    });
  }

  #scheduleReconnect(): void {
    const delay = nextBackoffDelay(
      this.#reconnectAttempt++,
      this.#reconnectCfg,
      this.#rand,
    );
    this.#schedule(() => {
      if (this.#closing) return;
      void this.#openSocket(true).catch(() => this.#scheduleReconnect());
    }, delay);
  }

  /** After any connect handshake, re-attach to every active match and re-queue if only queued. */
  #resumeActive(): void {
    for (const matchId of this.#activeMatches)
      this.#send({ type: "resume", matchId });
    if (this.#activeMatches.size === 0) {
      for (const game of this.#queuedGames)
        this.#send({ type: "queue.join", game });
    }
  }

  #emitResumeOk(e: ResumeOkEvent) {
    this.#resumeOkSubs.forEach((cb) => cb(e));
  }
  #emitPeerResumed(e: PeerResumedEvent) {
    this.#peerResumedSubs.forEach((cb) => cb(e));
  }
  #emitPeerDropped(e: PeerDroppedEvent) {
    this.#peerDroppedSubs.forEach((cb) => cb(e));
  }
  #dropQueued(game: string) {
    const i = this.#queuedGames.indexOf(game);
    if (i >= 0) this.#queuedGames.splice(i, 1);
  }

  #deliverMatch(m: MatchInfo) {
    const w = this.#matchWaiters.shift();
    if (w) w.resolve(m);
    else this.#matchQueue.push(m); // arrived before a waiter; next quickMatch claims it
  }
  #failNextMatch(e: Error) {
    this.#matchWaiters.shift()?.reject(e);
  }

  /** Join a per-game queue; resolves when paired. Safe to call CONCURRENTLY (FIFO-matched) —
   *  this is what lets one agent run many tunnels over one socket. */
  quickMatch(game: string): Promise<MatchInfo> {
    this.#queuedGames.push(game);
    this.#send({ type: "queue.join", game });
    const buffered = this.#matchQueue.shift();
    if (buffered) {
      this.#dropQueued(buffered.game);
      return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) =>
      this.#matchWaiters.push({ resolve, reject }),
    );
  }

  /** Join a pre-allocated arena match by its id (ADR-0027/0028). Unlike [`quickMatch`] (which
   *  matchmakes any opponent for a game), this binds to the ONE bot + tunnel the fleet reserved at
   *  `allocate`. The server replies with `match.found` (party A) once the co-located bot also
   *  binds, so the resolution path is identical — this only changes the request frame.
   *
   *  Never consumes the `#matchQueue` buffer: a buffered `match.found` belongs to a prior
   *  `quickMatch` (a different match id), so stealing it would cross-wire the arena join. The
   *  arena match's own `match.found` arrives after the bot binds and resolves this waiter. */
  joinMatch(matchId: string, opts?: { chatLlm?: boolean }): Promise<MatchInfo> {
    // `chatLlm` opts the co-located bot into LLM replies (flash Play/chat mode only). Omitted for
    // every other game and for flash Spectator, which keep the server's default offline reply.
    const frame: { type: "arena.join"; matchId: string; chatLlm?: boolean } = {
      type: "arena.join",
      matchId,
    };
    if (opts?.chatLlm) frame.chatLlm = true;
    this.#send(frame);
    return new Promise((resolve, reject) =>
      this.#matchWaiters.push({ resolve, reject }),
    );
  }

  /** Build the engine transport + peer side-channel for a paired match; inbound frames route
   *  by matchId so concurrent matches never clobber each other. */
  channel(matchId: string): PvpChannel {
    this.#activeMatches.add(matchId);
    let engineOnFrame: ((bytes: Uint8Array) => void) | null = null;
    // Frames that arrive before the engine wires onFrame (the tunnel is constructed only after
    // on-chain activation, which the peer may finish first — slower with sponsored MTPS
    // funding). Without buffering, the opponent's first MOVE is dropped and never ACKed, leaving
    // the proposer stuck on "a proposal is already awaiting ACK". Buffer, then flush on wire.
    const frameBuffer: Uint8Array[] = [];
    const peerCbs = new Set<
      (msg: Exclude<PeerMessage, { t: "frame" }>) => void
    >();
    this.#relayHandlers.set(matchId, (payload) => {
      // parseWithBigint: peer messages can carry bigint-tagged values (e.g. a resync's fullState
      // balances) — mirror the persistence reviver so the receiver gets real bigints back.
      const o = parseWithBigint(payload) as PeerMessage;
      if (o.t === "frame") {
        const bytes = te.encode(o.data);
        if (engineOnFrame) engineOnFrame(bytes);
        else frameBuffer.push(bytes);
      } else peerCbs.forEach((cb) => cb(o));
    });
    const relaySend = (obj: PeerMessage) =>
      // stringifyWithBigint: a resync's fullState carries bigint balances (balanceA/totalBet…); plain
      // JSON.stringify throws "Do not know how to serialize a BigInt". Tag bigints like persistence does.
      this.#send({ type: "relay", matchId, payload: stringifyWithBigint(obj) });
    return {
      transport: {
        send: (bytes: Uint8Array) => {
          const innerJson = new TextDecoder().decode(bytes);
          this.#send({
            type: "relay",
            matchId,
            payload: wrapInnerFrameJson(innerJson),
          });
        },
        onFrame: (cb) => {
          engineOnFrame = cb;
          // Deliver any frames that arrived before the engine was ready (activation race).
          if (frameBuffer.length) {
            const pending = frameBuffer.splice(0);
            for (const b of pending) cb(b);
          }
        },
      },
      sendPeer: (msg) => relaySend(msg),
      onPeer: (cb) => {
        peerCbs.clear();
        peerCbs.add(cb);
      },
      addPeerListener: (cb) => {
        peerCbs.add(cb);
      },
      removePeerListener: (cb) => {
        peerCbs.delete(cb);
      },
    };
  }

  /** Stop routing frames for a finished match (free its handler) and stop resuming it. */
  releaseMatch(matchId: string) {
    this.#relayHandlers.delete(matchId);
    this.#activeMatches.delete(matchId);
  }

  /** Announce the opened on-chain tunnel id to the backend registry (watchtower). */
  announceTunnel(matchId: string, tunnelId: string) {
    this.#send({ type: "tunnel.opened", matchId, tunnelId });
  }

  close() {
    this.#closing = true;
    this.#ws?.close();
    this.#ws = null;
  }

  #send(obj: unknown) {
    this.#ws?.send(JSON.stringify(obj));
  }
}
