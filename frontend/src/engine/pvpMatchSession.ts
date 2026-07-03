/**
 * One PvP match, worker-side — the per-match half of the shared {@link PvpHub} (M1: all PvP
 * windows multiplex over ONE relay socket). Ported from the former single-match `PvpEngine`:
 * the ONLY behavioural changes are that the socket is INJECTED (the hub owns the shared
 * `MpClient`) and teardown `releaseMatch`es this match instead of `close()`-ing the socket.
 *
 * Owns this match's `DistributedTunnel`, ephemeral signing, transcript, resume wiring, and the
 * coalesced snapshot it emits back to its window. Covers findMatch → fund → play → settle, warm
 * reconnect resync (driven by the hub's shared socket), and cold-load resume.
 *
 * Resume records persist in the worker's own IndexedDB (`persist/idb.ts`) — `localStorage` is
 * absent in workers, and keeping records worker-side confines the ephemeral key + game secret to
 * this thread (design §5/§6); they never transit the main heap or the bridge.
 */
import { type RelayClient, type PvpChannel, type Role } from "@/pvp/mpClient";
import {
  generateKeyPair,
  keyPairFromSecret,
  type KeyPair,
} from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import {
  DistributedTunnel,
  type Transport,
} from "sui-tunnel-ts/core/distributedTunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { getControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleBody } from "@/backend/settleRequest";
import { attachResume, rebuildTunnel } from "@/pvp/resumeSession";
import { RESUME_WATCHDOG_MS } from "@/pvp/resumeWatchdog";
import { disputesToFinalize } from "@/pvp/disputeFinalize";
import { peerHalfMatchesOutcome } from "@/pvp/settleReconcile";
import type { ResumeRecord } from "@/pvp/resume";
import { resumeIdb } from "./persist/idb";
import { captureWorkerException } from "@/sentry/workerSentry";
import { elog, emark } from "./debug";
import type {
  ConnStatus,
  EngineConfig,
  EngineStatus,
  GameId,
  GameSessionSpec,
  MainBridge,
  MatchController,
  MatchIo,
  MatchSnapshot,
  WorkerArenaEntry,
} from "./engineApi";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySpec = GameSessionSpec<any, any, any, any, any>;
type AnyController = MatchController<any, any, any, any, any>;
type AnyTunnel = DistributedTunnel<any, any>;

/** Static identity the resume layer + settle need, shared by the live and cold-load paths. */
interface ActivateInfo {
  matchId: string;
  tunnelId: string;
  role: Role;
  game: GameId;
  opponentWallet: string;
  opponentPubkeyHex: string;
  selfEphemeralSecretHex: string;
}

/** What the hub injects into each session: the shared socket, the static wiring, and the sinks
 *  the session reports through. `connStatus` is a getter because the socket lifecycle is shared
 *  (hub-owned) — a drop/resume affects every session at once. */
export interface SessionDeps {
  windowId: string;
  /** The relay client this session drives: the hub's shared `MpClient` (shared-hub path) or the
   *  pool's `RemoteMpClient` over a MessagePort (per-window path). Same narrow surface either way. */
  mp: RelayClient;
  config: EngineConfig;
  bridge: MainBridge;
  getSpec: (gameId: GameId) => AnySpec | undefined;
  /** Push a coalesced snapshot for this window (the hub tags it with `windowId`). */
  emit: (snap: MatchSnapshot) => void;
  /** The shared socket's current lifecycle (hub-tracked). */
  connStatus: () => ConnStatus;
}

/** Buffer peer messages so a waiter never misses one that arrived early (port of makeInbox). */
function makeInbox(channel: PvpChannel) {
  const buf = new Map<string, unknown>();
  const waiters = new Map<string, (m: unknown) => void>();
  channel.onPeer((m) => {
    const w = waiters.get(m.t);
    if (w) {
      waiters.delete(m.t);
      w(m);
    } else {
      buf.set(m.t, m);
    }
  });
  return <T = unknown>(t: string): Promise<T> =>
    new Promise((res) => {
      const b = buf.get(t);
      if (b) {
        buf.delete(t);
        res(b as T);
      } else {
        waiters.set(t, res as (m: unknown) => void);
      }
    });
}

export class PvpMatchSession {
  private spec: AnySpec | null = null;
  private controller: AnyController | null = null;
  private dt: AnyTunnel | null = null;
  private detachResume: (() => void) | null = null;
  /** Peer-timeout guard armed after a cold resume that's waiting on the peer; cleared on the first
   *  confirmed frame or on {@link reset}. Fires {@link armResumeWatchdog}'s drop-to-lobby on timeout. */
  private resumeWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Last frame-fault resync (ms) — debounces a burst of ahead-frames into one {@link guardTransport}. */
  private frameFaultResyncAt = 0;

  private status: EngineStatus = "idle";
  private role: Role | null = null;
  private auto = true;
  private opponentWallet: string | null = null;
  private error: string | null = null;
  /** This match's relay id, set once matched; `reset` releases it from the shared socket. */
  private matchId: string | null = null;
  /** intentId of a seat-A open still queued in the main-thread bulk-open window (design §4.1),
   *  else null. `reset()` cancels it via the bridge so a torn-down match never opens an orphan
   *  tunnel; cleared once the open resolves/rejects. */
  private pendingOpenIntentId: string | null = null;
  /**
   * Concurrency + abort guards (defect #2). `busy` rejects a second findMatch/resume for this same
   * window while one is mid-flight (without it, a resume's async gap let a findMatch fund a second
   * tunnel). `gen` bumps on reset so an in-flight findMatch that already passed an await bails
   * instead of resurrecting a torn-down match (the shared socket is no longer ours to identify by).
   */
  private busy = false;
  private gen = 0;

  constructor(private readonly deps: SessionDeps) {}

  // --- per-session command surface (the hub routes by windowId) ----------------------------

  /** Queue a human input (fire/intent); the controller proposes if it's due. */
  submitInput(input: unknown): void {
    this.controller?.onInput(input);
  }

  /** Toggle autopilot for this seat and re-evaluate whether to propose. */
  setAuto(on: boolean): void {
    this.auto = on;
    this.controller?.setAuto(on);
    this.emit();
  }

  private io(): MatchIo<any, any> {
    return {
      role: this.role as Role,
      tunnel: () => this.dt,
      auto: () => this.auto,
      emitView: () => this.emit(),
    };
  }

  private fail(e: unknown): void {
    // The snapshot only carries the message; this keeps the stack (forwarded to Sentry).
    captureWorkerException(e, {
      windowId: this.deps.windowId,
      game: this.spec?.game,
      matchId: this.matchId ?? undefined,
    });
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  // --- Snapshot coalescing (no rAF in a worker; pause while hidden) ------------------------
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private visible = true;

  private emit(): void {
    this.dirty = true;
    if (!this.visible || this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 40); // ~25fps; the main thread throttles further by live-window count (engineClient)
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const dt = this.dt;
    const view =
      dt && this.controller
        ? this.controller.deriveView(dt.displayState)
        : null;
    const snap: MatchSnapshot = {
      status: this.status,
      role: this.role,
      auto: this.auto,
      stake: this.spec ? Number(this.spec.stake) : 0,
      view,
      winner: dt ? dt.state.winner : null,
      opponentWallet: this.opponentWallet,
      tunnelId: dt ? dt.tunnelId : null,
      // The socket lifecycle is shared across all PvP windows (hub-tracked), so read it lazily.
      connStatus: this.deps.connStatus(),
      error: this.error,
      // Cumulative co-signed updates (the tunnel nonce) so main can feed this window's local TPS.
      moves: dt ? Number(dt.nonce) : 0,
    };
    // Comlink proxy: fire-and-forget (returns a Promise we ignore); coalesced upstream so the
    // per-call RPC cost is negligible (design §7).
    this.deps.emit(snap);
  }

  setVisibility(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      if (this.dirty) this.flush();
    } else if (this.flushTimer !== null) {
      // Drop an already-armed flush so no snapshot posts while hidden; emit() re-arms on show.
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Force a coalesced re-emit — the hub calls this on all sessions when the SHARED socket's
   *  lifecycle changes (drop/reconnect), since `connStatus` is read lazily from the hub. */
  refreshConn(): void {
    this.emit();
  }

  /**
   * Orphan-tunnel cancel (design §4.1): if a seat-A open is still queued in the main-thread
   * bulk-open window, cancel it so this torn-down match never opens a tunnel (and consumes stake).
   * Awaited by `reset()` so the hub can let the cancel land before reclaiming the window. If the
   * intent already flushed into an in-flight PTB the bridge no-ops and `findMatch` bails on its own
   * generation guard — so this never crashes.
   */
  private async cancelPendingOpen(): Promise<void> {
    const intentId = this.pendingOpenIntentId;
    if (!intentId) return;
    this.pendingOpenIntentId = null;
    try {
      await this.deps.bridge.cancelOpen(intentId);
    } catch {
      /* open already resolved — nothing left to cancel */
    }
  }

  async reset(): Promise<void> {
    this.gen += 1; // abort any in-flight findMatch/resume past its next await
    await this.cancelPendingOpen();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirty = false;
    this.clearResumeWatchdog();
    this.detachResume?.();
    this.detachResume = null;
    this.controller?.dispose();
    // Release THIS match from the shared socket — never close the socket (other windows use it).
    if (this.matchId) this.deps.mp.releaseMatch(this.matchId);
    this.matchId = null;
    this.dt = null;
    this.controller = null;
    this.role = null;
    this.auto = true;
    this.opponentWallet = null;
    this.error = null;
    this.status = "idle";
    this.busy = false;
    this.emit();
  }

  async findMatch(gameId: GameId, setup?: unknown): Promise<void> {
    if (this.busy) return; // a findMatch/resume is already in flight for this window (defect #2)
    this.busy = true;
    const myGen = this.gen;
    const config = this.deps.config;
    const spec = this.deps.getSpec(gameId);
    if (!spec) {
      this.busy = false;
      this.fail(new Error(`engine not ready for game '${gameId}'`));
      return;
    }
    this.spec = spec;
    try {
      this.error = null;
      const tMatch = emark("match", `findMatch ${gameId}`);
      this.status = "matching";
      this.emit();

      const ephemeral: KeyPair = generateKeyPair();
      const wallet = config.wallet;
      const mp = this.deps.mp; // shared, already connected by the hub
      // Composite matchmaking key when the spec derives one from setup (ttt/caro board size, §13);
      // else the bare gameId — so the in-scope games queue exactly as before.
      const matchKey = spec.matchmakingKey?.(setup) ?? gameId;
      const match = await mp.quickMatch(matchKey);
      if (this.gen !== myGen) return; // reset during matchmaking
      this.matchId = match.matchId;
      this.role = match.role;
      this.opponentWallet = match.opponentWallet;
      this.emit();
      elog("match", "matched", {
        window: this.deps.windowId,
        role: match.role,
        matchId: match.matchId,
      });

      const channel = mp.channel(match.matchId);
      const waitPeer = makeInbox(channel);

      const controller = spec.createMatch(this.io());
      this.controller = controller;
      controller.initSetup(setup);

      // 1) exchange ephemeral pubkeys (the wallet is only a matchmaking label).
      channel.sendPeer({
        t: "hello",
        ephemeralPubkey: toHex(ephemeral.publicKey),
      });
      const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
      const oppPub = fromHex(hello.ephemeralPubkey);

      // 2) fund on-chain via the bridge (role-asymmetric, interleaved with the relay).
      const bridge = this.deps.bridge;
      this.status = "funding";
      this.emit();
      const tFund = emark("match", `fund ${match.role}`);
      let tunnelId: string;
      if (match.role === "A") {
        // Tag this open so a teardown during the bulk-open window can cancel it (orphan-tunnel
        // cancel, design §4.1) before the job flushes a tunnel for a gone match. The id must be
        // unique across the whole (per-user, cross-window) bulk-open job, hence a UUID.
        const intentId = crypto.randomUUID();
        this.pendingOpenIntentId = intentId;
        const opened = await bridge
          .openTunnel(
            {
              partyA: { address: wallet, publicKey: ephemeral.publicKey },
              partyB: { address: match.opponentWallet, publicKey: oppPub },
              amount: spec.stake,
              label: gameId,
            },
            intentId,
          )
          .finally(() => {
            this.pendingOpenIntentId = null;
          });
        // The open could not be cancelled because it had already flushed into an in-flight PTB
        // (design §4.1). If the session was torn down meanwhile, the tunnel is orphaned (its stake
        // already consumed — the accepted cost of a flushed PTB); just bail rather than resurrect a
        // reset match. Detected via the generation counter (reset() bumps it).
        if (this.gen !== myGen) return;
        tunnelId = opened.tunnelId;
        mp.announceTunnel(match.matchId, tunnelId);
        channel.sendPeer({ t: "open", tunnelId });
      } else {
        const open = await waitPeer<{ tunnelId: string }>("open");
        if (this.gen !== myGen) return;
        tunnelId = open.tunnelId;
        await bridge.depositStake({
          tunnelId,
          amount: spec.stake,
          label: gameId,
        });
        if (this.gen !== myGen) return;
      }
      tFund();

      // 3) build the distributed engine over the relay transport.
      const backend = defaultBackend();
      const self = makeEndpoint(backend, wallet, ephemeral, true);
      const opp = makeEndpoint(
        backend,
        match.opponentWallet,
        { publicKey: oppPub, scheme: ephemeral.scheme },
        false,
      );
      const dt: AnyTunnel = new DistributedTunnel(
        spec.makeProtocol(setup),
        {
          tunnelId,
          self,
          opponent: opp,
          selfParty: match.role,
          moveCodec: spec.moveCodec,
        },
        this.guardTransport(channel.transport),
        { a: spec.stake, b: spec.stake },
      );
      this.dt = dt;
      this.activate(channel, waitPeer, {
        matchId: match.matchId,
        tunnelId,
        role: match.role,
        game: gameId,
        opponentWallet: match.opponentWallet,
        opponentPubkeyHex: toHex(oppPub),
        selfEphemeralSecretHex: toHex(ephemeral.secretKey),
      });

      // 4) readiness handshake before the opening commit can reach the peer.
      if (match.role === "A") {
        await waitPeer("ready");
      } else {
        channel.sendPeer({ t: "ready" });
      }
      if (this.gen !== myGen) return;
      controller.onConfirmed(); // kick the first due move
      tMatch();
      this.emit();
    } catch (e) {
      if (this.gen === myGen) this.fail(e);
    }
  }

  /**
   * Arena entry (ADR-0028): join a fleet-pre-allocated match + wire the engine over its live tunnel —
   * NO matchmaking, NO open. Differs from {@link findMatch} in exactly four ways: (1) the ephemeral
   * key is INJECTED (main-minted + baked into the tunnel at allocate — a fresh one would reject every
   * signature); (2) `joinMatch(matchId)` binds the ONE pre-allocated match (role always A) instead of
   * `quickMatch`; (3) NO funding block — the fleet opened the tunnel + funded seat B and the main
   * thread's batched `enterArena` PTB deposited seat A; (4) NO "ready" handshake — the fleet bot enters
   * its move loop the instant its tunnel opens (the relay buffers our first frame), so waiting on a
   * "ready" it never sends would hang seat A forever. `activate` + settle + resume are shared verbatim.
   */
  async enterArena(gameId: GameId, entry: WorkerArenaEntry): Promise<void> {
    if (this.busy) return; // a findMatch/enterArena/resume is already in flight (defect #2)
    this.busy = true;
    const myGen = this.gen;
    const config = this.deps.config;
    const spec = this.deps.getSpec(gameId);
    if (!spec) {
      this.busy = false;
      this.fail(new Error(`engine not ready for game '${gameId}'`));
      return;
    }
    this.spec = spec;
    try {
      this.error = null;
      const tMatch = emark("match", `enterArena ${gameId}`);
      // The user's per-game ephemeral, rebuilt from the seed the main thread baked into the tunnel.
      const ephemeral: KeyPair = keyPairFromSecret(
        fromHex(entry.ephemeralSecretHex),
      );
      const wallet = config.wallet;
      const mp = this.deps.mp; // shared, already connected by the hub
      const stake = BigInt(entry.stakeEach);
      // Seat A already deposited on main (batched) + seat B by the fleet — jump straight to funding-
      // done state; there is no matchmaking wait for a fleet bot.
      this.status = "funding";
      this.emit();

      // Bind the ONE pre-allocated match (role A); the fleet bound the bot as seat B at allocate.
      const match = await mp.joinMatch(entry.matchId);
      if (this.gen !== myGen) return; // reset during join
      this.matchId = match.matchId;
      this.role = match.role;
      this.opponentWallet = match.opponentWallet;
      this.emit();
      elog("match", "arena joined", {
        window: this.deps.windowId,
        role: match.role,
        matchId: match.matchId,
      });

      const channel = mp.channel(match.matchId);
      const waitPeer = makeInbox(channel);

      const controller = spec.createMatch(this.io());
      this.controller = controller;
      controller.initSetup(entry.setup);

      // Exchange ephemeral pubkeys — the bot's was baked into the tunnel at create, but the relay
      // handshake still carries it so both sides know the co-signing key.
      channel.sendPeer({
        t: "hello",
        ephemeralPubkey: toHex(ephemeral.publicKey),
      });
      const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
      const oppPub = fromHex(hello.ephemeralPubkey);
      if (this.gen !== myGen) return;

      // Build the engine over the fleet-pre-created tunnel (no funding). Balances init to the per-seat
      // stake the fleet + the batched deposit funded — the on-chain reality this settlement must match.
      const backend = defaultBackend();
      const self = makeEndpoint(backend, wallet, ephemeral, true);
      const opp = makeEndpoint(
        backend,
        match.opponentWallet,
        { publicKey: oppPub, scheme: ephemeral.scheme },
        false,
      );
      const dt: AnyTunnel = new DistributedTunnel(
        spec.makeProtocol(entry.setup),
        {
          tunnelId: entry.tunnelId,
          self,
          opponent: opp,
          selfParty: match.role,
          moveCodec: spec.moveCodec,
        },
        this.guardTransport(channel.transport),
        { a: stake, b: stake },
      );
      this.dt = dt;
      this.activate(channel, waitPeer, {
        matchId: match.matchId,
        tunnelId: entry.tunnelId,
        role: match.role,
        game: gameId,
        opponentWallet: match.opponentWallet,
        opponentPubkeyHex: toHex(oppPub),
        selfEphemeralSecretHex: toHex(ephemeral.secretKey),
      });

      // No "ready" wait (see the method doc): the fleet bot is always ready, so kick our first move now.
      if (this.gen !== myGen) return;
      controller.onConfirmed();
      tMatch();
      this.emit();
    } catch (e) {
      if (this.gen === myGen) this.fail(e);
    }
  }

  /** Wrap a relay {@link Transport} so a throw inside the tunnel's frame handler cannot kill the frame
   *  pump. In the worker the pump is one long-lived `RemoteMpClient.port.onmessage` (pool) / socket
   *  `onmessage` — a single uncaught throw stops ALL later frames for this match, silently stranding it
   *  ("opponent's turn" forever). Throws happen when a frame races ahead of our nonce during a resume
   *  reconnect (`DistributedTunnel.onMove` "nonce gap" / `onAck` "unexpected ACK") or a mid-flight
   *  decode fault. We swallow it and re-arm the resync handshake, which reconciles by adopting the
   *  peer's checkpoint rather than replaying the undeliverable frame. The main-thread path self-heals
   *  because each WS message is its own event dispatch; the pool's async MessagePort hop lets the
   *  ahead-frame land before the resync, so we make the recovery explicit. */
  private guardTransport(transport: Transport): Transport {
    return {
      send: (frame) => transport.send(frame),
      onFrame: (cb) =>
        transport.onFrame((frame) => {
          try {
            cb(frame);
          } catch (e) {
            elog("resume", "frame pump threw; resyncing", String(e));
            this.recoverFromFrameFault();
          }
        }),
    };
  }

  /** Re-trigger the resume handshake after a frame-pump fault so the peer re-sends its checkpoint and
   *  we adopt it (`resumeMatch` → `resume.ok` → attachResume's resync). Debounced: a burst of ahead
   *  frames all throw, but must coalesce into a SINGLE resumeMatch. */
  private recoverFromFrameFault(): void {
    const id = this.matchId;
    if (!id) return;
    const now = Date.now();
    if (now - this.frameFaultResyncAt < 500) return;
    this.frameFaultResyncAt = now;
    try {
      this.deps.mp.resumeMatch(id);
    } catch {
      /* socket mid-churn — the hub's connect-time re-attach will resync */
    }
  }

  /** Cold-load: rebuild any persisted in-flight match for this game and re-attach to the shared
   *  socket. The hub guarantees the socket is connected before calling this. */
  async resume(gameId: GameId): Promise<void> {
    if (this.busy) return; // already in a live or resuming session (defect #2)
    this.busy = true;
    const myGen = this.gen;
    const config = this.deps.config;
    const spec = this.deps.getSpec(gameId);
    if (!spec) {
      this.busy = false;
      return;
    }
    this.spec = spec;
    let records: ResumeRecord[];
    try {
      records = await resumeIdb.getAllByGame(gameId);
    } catch {
      this.busy = false;
      return;
    }
    if (records.length === 0 || this.gen !== myGen) {
      this.busy = false;
      return;
    }
    // Dispute floor, step 2: finalize any dispute WE raised whose on-chain timeout has elapsed
    // (force_close to claim), then keep only rebuildable records — a disputed tunnel is STATUS_DISPUTED
    // on-chain and can't resume as a live match. Best-effort: a force_close that reverts (still early,
    // or already closed) is caught and retried on the next resume; the record is dropped either way.
    for (const tunnelId of disputesToFinalize(records, Date.now())) {
      void this.deps.bridge.forceClose({ tunnelId }).catch(() => {});
      void resumeIdb.delete(tunnelId).catch(() => {});
    }
    const live = records.filter((r) => r.disputedAt == null);
    if (live.length === 0) {
      this.busy = false;
      return;
    }
    try {
      const mp = this.deps.mp; // shared, already connected by the hub
      // Most-recently-updated record wins, not lexical tunnelId order (defect #2).
      const rec = [...live].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      // Seat identity FIRST: `io()` snapshots `this.role` when the controller is created, so a
      // controller built before this line would see role=null and mis-seat every restored driver
      // (battleship revealed for the wrong side, poker chose the wrong plumbing — both "resumed"
      // frozen). The live paths already assign role before createMatch; mirror them here.
      this.matchId = rec.matchId;
      this.role = rec.role;
      this.opponentWallet = rec.opponentWallet;
      const controller = spec.createMatch(this.io());
      this.controller = controller;
      const adapter = controller.resumeAdapter?.();
      if (!adapter) {
        this.controller = null;
        this.busy = false;
        return;
      }
      const rebuilt = rebuildTunnel(
        mp,
        rec,
        {
          proto: spec.makeProtocol(),
          moveCodec: spec.moveCodec,
          adapter,
          wrapTransport: (t) => this.guardTransport(t),
        },
        { selfWallet: config.wallet },
      );
      this.dt = rebuilt.tunnel;
      // Re-apply the persisted secret now that `io.tunnel()` resolves: `rebuildTunnel` restored it
      // while `this.dt` was still null, so an adapter whose setSecret writes through the tunnel
      // (poker: `dt.state.localSecrets*`) silently no-opped and the seat could never reveal.
      // Idempotent for adapters that target controller fields instead (battleship, blackjack).
      if (rec.secret !== undefined) adapter.restoreSecret?.(rec.secret);
      this.activate(rebuilt.channel, makeInbox(rebuilt.channel), {
        matchId: rec.matchId,
        tunnelId: rec.tunnelId,
        role: rec.role,
        game: gameId,
        opponentWallet: rec.opponentWallet,
        opponentPubkeyHex: rec.opponentPubkeyHex,
        selfEphemeralSecretHex: rec.selfEphemeralSecretHex ?? "",
      });
      // The shared socket is already open, so send the resume frame explicitly (the connect-time
      // re-attach only covers matches registered before connect — design §5/§6, ADR-0016).
      mp.resumeMatch(rec.matchId);
      try {
        controller.onConfirmed(); // kick a due move
      } catch {
        /* a move is already in flight — the resync handshake converges it */
      }
      this.emit();
      // Bound a resume that's waiting on a peer that may never answer (bot exited past its grace, or a
      // reconnect our resync can't reach): drop to the lobby after RESUME_WATCHDOG_MS instead of sitting
      // frozen in "playing". Parity with pvpMatchHook — the worker path had no such bound before.
      this.armResumeWatchdog();
    } catch {
      try {
        for (const r of records) await resumeIdb.delete(r.tunnelId);
      } catch {
        /* best-effort cleanup */
      }
      void this.reset();
    }
  }

  /** Wire onConfirmed (transcript + drive + settle) + resume persistence/resync. Shared by the
   *  live (findMatch) and cold-load (resume) paths; the caller does the ready handshake. */
  private activate(
    channel: PvpChannel,
    waitPeer: ReturnType<typeof makeInbox>,
    info: ActivateInfo,
  ): void {
    const dt = this.dt as AnyTunnel;
    const controller = this.controller as AnyController;
    const proto = (this.spec as AnySpec).makeProtocol();
    const transcript = new Transcript(dt.tunnelId);
    let settling = false;
    dt.onConfirmed = (u) => {
      // Drive the controller BEFORE emitting: hidden-info games update view-local state
      // (e.g. battleship's lastEnemyShot) in onConfirmed, which the snapshot must reflect.
      transcript.append(u);
      elog("move", "confirmed", {
        game: info.game,
        nonce: dt.nonce.toString(),
      });
      controller.onConfirmed();
      this.emit();
      if (proto.isTerminal(dt.state) && !settling) {
        settling = true;
        this.status = "settling";
        this.emit();
        const tSettle = emark("settle", info.game);
        void this.settle(channel, waitPeer, transcript, info.tunnelId).then(
          () => {
            tSettle();
            controller.onSettled?.();
            this.status = "settled";
            this.emit();
            void resumeIdb.delete(info.tunnelId).catch(() => {});
          },
          (e) => this.fail(e),
        );
      }
    };

    // Resume: persist on confirm/propose (eager write to the worker's own IndexedDB) + run the
    // resync handshake on reconnect. attachResume wraps the onConfirmed set above (preserving it).
    const adapter = controller.resumeAdapter?.();
    if (adapter) {
      this.detachResume?.();
      this.detachResume = attachResume({
        mp: this.deps.mp,
        channel,
        tunnel: dt,
        adapter,
        identity: {
          matchId: info.matchId,
          tunnelId: info.tunnelId,
          role: info.role,
          game: info.game,
          opponentWallet: info.opponentWallet,
          opponentPubkeyHex: info.opponentPubkeyHex,
          selfEphemeralSecretHex: info.selfEphemeralSecretHex,
        },
        persist: (rec) => {
          void resumeIdb.put(rec).catch(() => {});
        },
        // Settlement floor: after attachResume's on-chain grace (the peer dropped and never came back),
        // stake the held checkpoint via `raise_dispute` so the stake is recoverable without a fresh
        // cooperative co-signature. Routed through the bridge — the worker holds no wallet signer. On
        // success, stamp the record disputed so the next cold-resume finalizes it (force_close) once the
        // on-chain timeout elapses. The shorter resume watchdog handles the reload case.
        onGraceExpired: (latest) => {
          if (!latest) return;
          void this.deps.bridge
            .raiseDispute({
              tunnelId: info.tunnelId,
              update: latest,
              role: info.role,
            })
            .then(() => this.markDisputed(info.game, info.tunnelId))
            .catch(() => {});
        },
      });
    }

    this.status = "playing";
    this.emit();
  }

  private async settle(
    channel: PvpChannel,
    waitPeer: ReturnType<typeof makeInbox>,
    transcript: Transcript,
    tunnelId: string,
  ): Promise<void> {
    const dt = this.dt as AnyTunnel;
    const bridge = this.deps.bridge;
    const createdAt = await bridge.readCreatedAt(tunnelId);
    const root = transcript.root();
    const half = dt.buildSettlementHalfWithRoot(createdAt, root, 0n);
    channel.sendPeer({
      t: "settleHalf",
      partyABalance: half.settlement.partyABalance.toString(),
      partyBBalance: half.settlement.partyBBalance.toString(),
      finalNonce: half.settlement.finalNonce.toString(),
      timestamp: half.settlement.timestamp.toString(),
      transcriptRoot: toHex(root),
      sig: toHex(half.sigSelf),
    });
    const other = await waitPeer<
      { sig: string } & Parameters<typeof peerHalfMatchesOutcome>[1]
    >("settleHalf");
    let settlement = half.settlement;
    let sigSelf = half.sigSelf;
    let adoptedPeerRoot = false;
    if (other.transcriptRoot !== toHex(root)) {
      // A cold-resumed / resync-adopted seat cannot reproduce the full transcript (adopt skips
      // updates; a reload starts a fresh one), so roots legitimately diverge here. If the peer
      // agrees on the MONEY, re-sign over THEIR root (they kept the full history) and settle
      // without our proof; only a genuine outcome divergence still fails to the dispute floor.
      if (!peerHalfMatchesOutcome(settlement, other)) {
        throw new Error("settlement diverged between parties (beyond root)");
      }
      elog(
        "settle",
        "transcript root diverged (resumed seat) — adopting peer root",
      );
      const rebuilt = dt.buildSettlementHalfWithRoot(
        createdAt,
        fromHex(other.transcriptRoot),
        0n,
      );
      settlement = rebuilt.settlement;
      sigSelf = rebuilt.sigSelf;
      adoptedPeerRoot = true;
    }
    const co = dt.combineSettlementWithRoot(
      settlement,
      sigSelf,
      fromHex(other.sig),
    );
    if (this.role !== "A") return; // single submitter, mirrors the cooperative-close pattern
    if (adoptedPeerRoot) {
      // Our partial transcript can't prove the peer's root — skip the doomed proof upload and
      // close directly with the dual-signed settlement (the same fallback a failed POST takes).
      await bridge.closeFallback({ tunnelId, settlement: co });
      return;
    }
    try {
      await getControlPlaneClient().settle(
        tunnelId,
        coSignedToSettleBody(co, transcript.rawEntries()),
      );
    } catch {
      await bridge.closeFallback({ tunnelId, settlement: co });
    }
  }

  /** After a cold resume, guard against a peer that never answers. Arm ONLY when we're waiting on the
   *  peer (a re-sent pending move, or it's their turn) — a clean same-turn resume already succeeded, so
   *  arming there would tear down a healthy match. Disarm on the first confirmed frame (the peer is
   *  alive and replying). On timeout, drop the record + reset to the lobby — never eagerly dispute
   *  (that could attack a still-live channel; the stake is reclaimed by the on-chain grace, and if the
   *  peer really is gone the grace floor's {@link MainBridge.raiseDispute} covers it). Mirrors
   *  pvpMatchHook.armResumeWatchdog, but drops the record from THIS worker's IndexedDB. */
  private armResumeWatchdog(): void {
    const dt = this.dt as AnyTunnel | null;
    if (!dt) return;
    // Arm UNCONDITIONALLY (unlike pvpMatchHook's own-turn skip). The hook's `turn(nonce)` heuristic
    // assumes strict A/B alternation, which holds for ttt/caro but not the phase-driven proposers
    // (poker/blackjack) — and a resumed seat that CANNOT move (e.g. a record persisted with a null
    // secret) freezes forever on what looks like its "own" turn. A healthy resume confirms a frame
    // within the window either way (we propose → the bot acks), which disarms below; only a truly
    // dead match pays the drop-to-lobby.
    this.clearResumeWatchdog();
    const prevConfirmed = dt.onConfirmed;
    dt.onConfirmed = (u) => {
      this.clearResumeWatchdog();
      dt.onConfirmed = prevConfirmed;
      prevConfirmed?.(u);
    };
    const tunnelId = dt.tunnelId;
    this.resumeWatchdog = setTimeout(() => {
      this.resumeWatchdog = null;
      void resumeIdb.delete(tunnelId).catch(() => {});
      void this.reset();
    }, RESUME_WATCHDOG_MS);
  }

  private clearResumeWatchdog(): void {
    if (this.resumeWatchdog !== null) {
      clearTimeout(this.resumeWatchdog);
      this.resumeWatchdog = null;
    }
  }

  /** Stamp this match's persisted record as disputed (read-modify-write) so a later cold-resume
   *  finalizes it via {@link disputesToFinalize} + force_close instead of rebuilding a now-disputed
   *  tunnel. Best-effort: the raise already landed on-chain, so the settlement floor holds even if this
   *  marker write fails (the record is at worst rebuilt once and errors out — no stake is lost). */
  private async markDisputed(game: GameId, tunnelId: string): Promise<void> {
    try {
      const recs = await resumeIdb.getAllByGame(game);
      const rec = recs.find((r) => r.tunnelId === tunnelId);
      if (rec) await resumeIdb.put({ ...rec, disputedAt: Date.now() });
    } catch {
      /* best-effort — see the doc comment */
    }
  }
}
