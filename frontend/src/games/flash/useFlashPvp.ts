import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { FlashProtocol, type FlashState } from "sui-tunnel-ts/protocol/flash";
import { registerWindowDisposer } from "@/lib/windowSessions";
import {
  MpClient,
  resolveMpWsUrl,
  type PvpChannel,
  type Role,
} from "@/pvp/mpClient";
import { resolveBackendUrl } from "@/backend/controlPlane";
import {
  closeCooperativeWithRoot,
  readCreatedAt,
  type SuiReads,
} from "@/onchain/tunnelTx";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { isMtpsConfigured, MTPS_COIN_TYPE } from "@/onchain/mtps";
import { allocateArenaBots, type ArenaAllocation } from "@/onchain/arenaEnter";
import {
  consumeArenaEntry,
  subscribeArena,
} from "@/onchain/arenaAllocationStore";
import { settleViaBackend } from "@/backend/settle";
import { requestArenaGame } from "@/onchain/arenaLazyEntry";
import {
  attachResume,
  restoreInto,
  type ResumeIdentity,
} from "@/pvp/resumeSession";
import {
  clearResumeRecord,
  evictExpiredRecords,
  keypairFromSecretHex,
  listActiveTunnels,
  readResumeRecord,
} from "@/pvp/resume";
import { makeFlashResumeAdapter } from "./flashResumeAdapter";
import {
  clearFlashMessages,
  loadFlashMessages,
  saveFlashMessages,
} from "./flashMessageStore";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import type { TelemetryWriter } from "@/telemetry/TelemetryProvider";
import {
  canSend,
  makeMove,
  messageFromMove,
  localBotReply,
  type FlashChatMessage,
  type FlashSessionStatus,
} from "./session-core";

export const FLASH_ARENA_GAME_ID = "flash";

const STAKE = 1n;
const LOCAL_REPLY_DELAY_MS = 500;

type FlashTunnel = DistributedTunnel<FlashState, string>;

export interface FlashPvpApi {
  status: FlashSessionStatus;
  messages: FlashChatMessage[];
  error: string | null;
  state: FlashState | null;
  selfParty: Role;
  send: (text: string) => void;
  start: () => void;
  /** End chat: settle the current tunnel in the background and immediately clear the old chat and
   *  drop into a fresh new one — no lingering "settled" screen. */
  endChat: () => void;
  endMatch: () => void;
  reset: () => void;
  /** A true fresh start: tear the session down and allocate a brand-new tunnel, exactly as a page
   *  reload would. `reset` alone only returns to idle; this also re-arms the one-shot arena guard. */
  newChat: () => void;
}

interface FlashSnapshot {
  status: FlashSessionStatus;
  messages: FlashChatMessage[];
  error: string | null;
  state: FlashState | null;
  selfParty: Role;
}

interface FlashDeps {
  account: { address: string } | null;
  client: unknown;
  signExec: (tx: never) => Promise<{ digest: string }>;
  sponsoredSignExec: (tx: never) => Promise<{ digest: string }>;
  report: TelemetryWriter;
}

/** Buffer peer messages so a waiter never misses one that arrived early. */
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

/**
 * A flash arena session — matchmaking socket, tunnel, transcript — kept OUT of
 * React so the window can be minimized/reflowed without dropping the bot. The
 * component subscribes; only an explicit window close disposes it.
 */
class FlashPvpSession {
  deps: FlashDeps | null = null;

  private status: FlashSessionStatus = "idle";
  private messages: FlashChatMessage[] = [];
  private error: string | null = null;
  private selfParty: Role = "A";
  private snap: FlashSnapshot = {
    status: "idle",
    messages: [],
    error: null,
    state: null,
    selfParty: "A",
  };
  private listeners = new Set<() => void>();

  private mp: MpClient | null = null;
  private dt: FlashTunnel | null = null;
  private channel: PvpChannel | null = null;
  private settleHandler: ((publishOnly: boolean) => void) | null = null;
  private detachResume: (() => void) | null = null;
  private lastOpponentNonce = 0n;
  private isLocal = false;
  private localState: FlashState | null = null;
  private txnId = 0;
  /** Guards the once-per-mount cold-load resume attempt. */
  private resumeTried = false;

  /** Persist the visible chat alongside the resume record so a reload keeps the bubbles. */
  private persistMessages() {
    if (this.dt) saveFlashMessages(this.dt.tunnelId, this.messages);
  }

  /** Drop this tunnel's resume record + messages so a settled/abandoned chat can't be restored. */
  private evictResume(tunnelId: string | undefined) {
    this.detachResume?.();
    this.detachResume = null;
    if (tunnelId) {
      clearResumeRecord(tunnelId);
      clearFlashMessages(tunnelId);
    }
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): FlashSnapshot => this.snap;

  private emit() {
    this.snap = {
      status: this.status,
      messages: this.messages,
      error: this.error,
      // `displayState` folds in our own not-yet-confirmed move, so turn-gating in the UI matches
      // the `canSend(dt.displayState, …)` guard `send` uses: the input disables the instant we
      // propose and re-enables only once the bot's reply is confirmed.
      state: this.dt?.displayState ?? this.localState ?? null,
      selfParty: this.selfParty,
    };
    for (const l of this.listeners) l();
  }

  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  reset = () => {
    // New Chat: this session is done — drop its resume record + persisted chat so cold-load can't
    // restore it and the arena allocates a fresh tunnel next time.
    this.evictResume(this.dt?.tunnelId);
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.channel = null;
    this.settleHandler = null;
    this.lastOpponentNonce = 0n;
    this.selfParty = "A";
    this.isLocal = false;
    this.localState = null;
    this.txnId = 0;
    this.status = "idle";
    this.messages = [];
    this.error = null;
    this.emit();
  };

  /** Start a chat. First try the real arena; if no bot is available locally,
   *  fall back to an in-browser local protocol session so the UI works offline. */
  start = async () => {
    const deps = this.deps;
    if (!deps?.account) {
      this.error = "connect a wallet first";
      this.status = "error";
      this.emit();
      return;
    }
    this.error = null;
    this.status = "joining";
    this.emit();

    try {
      const eph = generateKeyPair();
      const allocs = await allocateArenaBots(
        [{ id: FLASH_ARENA_GAME_ID, userEphPubkey: toHex(eph.publicKey) }],
        deps.account.address,
        { apiBase: resolveBackendUrl() },
      );
      if (allocs.length === 0) {
        // No backend bot available → local protocol session.
        this.startLocalMatch();
        return;
      }
      // Real arena path: requestArenaGame deposits seat A and publishes the entry;
      // the arena-store consumer below calls enterArenaMatch.
      void requestArenaGame(FLASH_ARENA_GAME_ID, deps.account.address).catch(
        (e) => {
          this.error = String((e as Error)?.message ?? e);
          this.status = "error";
          this.emit();
        },
      );
    } catch (e) {
      this.error = String((e as Error)?.message ?? e);
      this.status = "error";
      this.emit();
    }
  };

  /** In-browser fallback: a real FlashProtocol session with a local bot. */
  private startLocalMatch = () => {
    const proto = new FlashProtocol();
    this.localState = proto.initialState({
      tunnelId: "local",
      initialBalances: { a: STAKE, b: STAKE },
    });
    this.isLocal = true;
    this.selfParty = "A";
    this.status = "playing";
    this.emit();
  };

  /** End chat: fire the cooperative close in the BACKGROUND (it owns its captured mp/dt/channel and
   *  closes them when done), then DETACH this session — clearing the UI to idle WITHOUT closing the
   *  mp — so the caller can start a fresh chat instantly instead of lingering on a "settled" screen. */
  settleAndDetach = () => {
    const oldTunnelId = this.dt?.tunnelId;
    if (
      !this.isLocal &&
      this.settleHandler &&
      (this.status === "playing" || this.status === "settling")
    ) {
      this.settleHandler(false); // resolves to a cooperative close in the background
    }
    this.detachResume?.(); // stop the old tunnel's resume listeners
    // Drop the old tunnel's resume record now so a reload during the background settle can't restore
    // a closing tunnel (the settle clears it again on completion — a harmless double clear).
    if (oldTunnelId) {
      clearResumeRecord(oldTunnelId);
      clearFlashMessages(oldTunnelId);
    }
    // Detach, NOT dispose: the in-flight settle still needs the live mp connection, so null the refs
    // here without closing mp — the settle closes it on completion.
    this.dt = null;
    this.channel = null;
    this.mp = null;
    this.settleHandler = null;
    this.detachResume = null;
    this.lastOpponentNonce = 0n;
    this.selfParty = "A";
    this.isLocal = false;
    this.localState = null;
    this.status = "idle";
    this.messages = [];
    this.error = null;
    this.emit();
  };

  /** Publish this seat's settlement half and stop, without waiting for the peer.
   *  Use this for a non-blocking "Back/Leave" action; the staying seat or grace
   *  path will finalize the close on-chain. */
  endMatch = () => {
    if (this.isLocal && this.status === "playing") {
      this.status = "settled";
      this.emit();
      return;
    }
    if (
      this.settleHandler &&
      (this.status === "playing" || this.status === "settling")
    ) {
      this.settleHandler(true);
    }
  };

  dispose = () => {
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.channel = null;
    this.listeners.clear();
  };

  /** Tap incoming engine frames to capture the opponent's plain-text replies. */
  private tapOpponentMove(frameJson: unknown) {
    const frame = frameJson as Record<string, unknown>;
    if (
      typeof frameJson !== "object" ||
      frameJson === null ||
      frame.kind !== "move" ||
      frame.by === this.selfParty ||
      typeof frame.move !== "string" ||
      typeof frame.nonce !== "string"
    ) {
      return;
    }
    const nonce = BigInt(frame.nonce);
    if (nonce <= this.lastOpponentNonce) return;
    this.lastOpponentNonce = nonce;
    this.messages = [...this.messages, messageFromMove(frame.move, false)];
    this.emit();
    this.persistMessages();
  }

  private makeTappedTransport(
    base: PvpChannel["transport"],
  ): PvpChannel["transport"] {
    return {
      send: (bytes: Uint8Array) => base.send(bytes),
      onFrame: (cb: (bytes: Uint8Array) => void) => {
        base.onFrame((bytes) => {
          try {
            this.tapOpponentMove(JSON.parse(new TextDecoder().decode(bytes)));
          } catch {
            /* ignore non-tap frames */
          }
          cb(bytes);
        });
      },
    };
  }

  private activateSession(
    mp: MpClient,
    channel: PvpChannel,
    dt: FlashTunnel,
    waitPeer: ReturnType<typeof makeInbox>,
    identity: ResumeIdentity,
  ) {
    this.dt = dt;
    this.channel = channel;
    const deps = this.deps!;
    const signExec = deps.signExec;
    const sponsoredSignExec = deps.sponsoredSignExec;
    const reads = deps.client as unknown as SuiReads;
    const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
    const proto = new FlashProtocol();
    const transcript = new Transcript(dt.tunnelId);
    let settling = false;

    const triggerSettle = async (publishOnly: boolean) => {
      if (settling) return;
      settling = true;
      this.status = "settling";
      this.emit();
      try {
        const createdAt = await readCreatedAt(reads, dt.tunnelId);
        const root = transcript.root();
        const half = dt.buildSettlementHalfWithRoot(createdAt, root, 0n);
        // Trigger the co-located bot's graceful cooperative settle (the shared `PeerMsg::Stop` path):
        // the bot winds its driver down and emits its own `settleHalf`, which we combine below. Flash
        // is always at a safe close boundary (`can_gracefully_close`), so this settles immediately.
        channel.sendPeer({ t: "stop" });
        if (publishOnly) {
          mp.close();
          return;
        }
        const other = await waitPeer<{
          sig: string;
          transcriptRoot: string;
        }>("settleHalf");
        if (other.transcriptRoot !== toHex(root)) {
          throw new Error(
            "settlement transcript-root mismatch between parties",
          );
        }
        const co = dt.combineSettlementWithRoot(
          half.settlement,
          half.sigSelf,
          fromHex(other.sig),
        );
        // Submit the cooperative close (flash no longer records anything to My Activity).
        await settleViaBackend({
          tunnelId: dt.tunnelId,
          settlement: co,
          transcript: transcript.rawEntries(),
          label: "flash",
          fallbackClose: () =>
            closeCooperativeWithRoot({
              signExec: (isMtpsConfigured
                ? sponsoredSignExec
                : signExec) as never,
              tunnelId: dt.tunnelId,
              settlement: co,
              coinType,
            }),
        });
        // Cooperative close landed. This runs DETACHED (End chat already cleared the UI and started a
        // fresh chat), so only clean up THIS tunnel's connection + dead resume record — never touch
        // the live session's `this.*` state, which now belongs to the new chat.
        clearResumeRecord(dt.tunnelId);
        clearFlashMessages(dt.tunnelId);
        mp.close();
      } catch (e) {
        console.warn("[flash] background settle failed", e);
        mp.close();
      }
    };
    this.settleHandler = triggerSettle;

    dt.onConfirmed = (u) => {
      transcript.append(u);
      const st = dt.state;
      // Refresh the snapshot on every confirmed transition so the UI re-gates the input as the
      // turn flips. Without this, the last emit before the bot's reply is the pre-apply tap (still
      // our turn), leaving the input stuck disabled after the first exchange.
      this.emit();
      if (proto.isTerminal(st) && !settling) {
        void triggerSettle(false);
      }
    };

    // Resume wiring: persist the co-signed tunnel state on every confirmed/proposed move and run the
    // resync handshake when the relay reconnects. Called AFTER `dt.onConfirmed` is set so
    // `attachResume` chains (not clobbers) our confirm handler.
    this.detachResume?.();
    this.detachResume = attachResume({
      mp,
      channel,
      tunnel: dt,
      adapter: makeFlashResumeAdapter({ onReconciled: () => this.emit() }),
      identity,
    });
  }

  /** Build a flash `DistributedTunnel` over the TAPPED transport (so the opponent's plain-text
   *  replies surface as bubbles — `CoSignedUpdate` carries no move text). Shared by fresh arena
   *  entry and cold-load resume so both render bot replies identically. */
  private buildFlashTunnel(args: {
    wallet: string;
    ephemeral: KeyPair;
    opponentWallet: string;
    opponentPubkey: Uint8Array;
    tunnelId: string;
    role: Role;
    channel: PvpChannel;
  }): FlashTunnel {
    const backend = defaultBackend();
    const self = makeEndpoint(backend, args.wallet, args.ephemeral, true);
    const opp = makeEndpoint(
      backend,
      args.opponentWallet,
      { publicKey: args.opponentPubkey, scheme: args.ephemeral.scheme },
      false,
    );
    return new DistributedTunnel<FlashState, string>(
      new FlashProtocol(),
      { tunnelId: args.tunnelId, self, opponent: opp, selfParty: args.role },
      this.makeTappedTransport(args.channel.transport),
      { a: STAKE, b: STAKE },
    );
  }

  /**
   * Cold-load: if a non-terminal flash tunnel was persisted (the user reloaded mid-chat), rebuild it
   * with the message tap intact, restore the visible chat, and resume playing. The co-located bot is
   * parked server-side across the reload, so `attachResume`'s resync (fired on reconnect) replays any
   * frames we missed. Runs once from the hook mount; a no-op if there's nothing to resume or no
   * wallet yet. Synchronous through `status = "playing"` (only `mp.connect()` is async) so it wins the
   * race with a fresh arena entry, which is gated on `status === "idle"`.
   */
  resumeIfActive = () => {
    if (this.resumeTried || this.status !== "idle") return;
    const deps = this.deps;
    if (!deps?.account) return; // wallet not ready; the mount effect re-runs when it connects
    this.resumeTried = true;
    const wallet = deps.account.address;
    try {
      evictExpiredRecords();
      const proto = new FlashProtocol();
      const adapter = makeFlashResumeAdapter({
        onReconciled: () => this.emit(),
      });
      const record = listActiveTunnels()
        .map((id) => readResumeRecord(id))
        .find(
          (r): r is NonNullable<typeof r> =>
            !!r &&
            r.game === FLASH_ARENA_GAME_ID &&
            !!r.selfEphemeralSecretHex &&
            !proto.isTerminal(adapter.deserializeState(r.latestState)),
        );
      if (!record) return;

      this.error = null;
      // The `find` predicate above guarantees this is present.
      const secretHex = record.selfEphemeralSecretHex as string;
      const ephemeral = keypairFromSecretHex(secretHex);
      const mp = new MpClient(
        resolveMpWsUrl(resolveBackendUrl()),
        wallet,
        ephemeral,
      );
      this.mp = mp;
      const channel = mp.channel(record.matchId);
      const waitPeer = makeInbox(channel);
      const dt = this.buildFlashTunnel({
        wallet,
        ephemeral,
        opponentWallet: record.opponentWallet,
        opponentPubkey: fromHex(record.opponentPubkeyHex),
        tunnelId: record.tunnelId,
        role: record.role,
        channel,
      });
      // Seat the rebuilt tunnel at the persisted checkpoint (verify-on-adopt) + re-seat any pending.
      restoreInto(dt, record, adapter);
      // The loaded history already covers every opponent message up to the checkpoint, so ignore
      // replays at or below it — only genuinely new opponent moves become fresh bubbles.
      this.lastOpponentNonce = dt.snapshot().nonce;
      this.selfParty = record.role;
      this.messages = loadFlashMessages(record.tunnelId);
      this.activateSession(mp, channel, dt, waitPeer, {
        matchId: record.matchId,
        tunnelId: record.tunnelId,
        role: record.role,
        game: FLASH_ARENA_GAME_ID,
        opponentWallet: record.opponentWallet,
        opponentPubkeyHex: record.opponentPubkeyHex,
        selfEphemeralSecretHex: secretHex,
      });
      this.status = "playing";
      this.emit();
      void mp.connect().catch((e) => this.fail(e));
    } catch {
      // Unrestorable → drop the mp and stay idle so the user gets a clean fresh chat.
      this.mp?.close();
      this.mp = null;
    }
  };

  /**
   * Arena entry (ADR-0028): join a pre-allocated match whose tunnel the fleet already
   * created + funded seat B for. Seat A is deposited by the batched `enterArena` PTB, so
   * no funding happens here — we just wire the relay + engine over the live tunnel.
   */
  enterArenaMatch = (allocation: ArenaAllocation, eph: KeyPair) => {
    const deps = this.deps;
    if (!deps?.account) {
      this.error = "connect a wallet first";
      this.status = "error";
      this.emit();
      return;
    }
    const wallet = deps.account.address;

    void (async () => {
      try {
        this.error = null;
        this.status = "joining";
        this.emit();
        const ephemeral = eph;
        const mp = new MpClient(
          resolveMpWsUrl(resolveBackendUrl()),
          wallet,
          ephemeral,
        );
        this.mp = mp;
        await mp.connect();
        const match = await mp.joinMatch(allocation.matchId);
        this.selfParty = match.role;
        this.emit();

        const channel = mp.channel(match.matchId);
        const waitPeer = makeInbox(channel);

        channel.sendPeer({
          t: "hello",
          ephemeralPubkey: toHex(ephemeral.publicKey),
        });
        const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
        const oppPub = fromHex(hello.ephemeralPubkey);

        const dt = this.buildFlashTunnel({
          wallet,
          ephemeral,
          opponentWallet: match.opponentWallet,
          opponentPubkey: oppPub,
          tunnelId: allocation.tunnelId,
          role: match.role,
          channel,
        });
        this.activateSession(mp, channel, dt, waitPeer, {
          matchId: match.matchId,
          tunnelId: allocation.tunnelId,
          role: match.role,
          game: FLASH_ARENA_GAME_ID,
          opponentWallet: match.opponentWallet,
          opponentPubkeyHex: hello.ephemeralPubkey,
          selfEphemeralSecretHex: toHex(ephemeral.secretKey),
        });

        this.status = "playing";
        this.emit();
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  send = (text: string) => {
    if (this.status !== "playing") return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Local fallback: drive the FlashProtocol directly in the browser.
    if (this.isLocal && this.localState) {
      const proto = new FlashProtocol();
      try {
        this.localState = proto.applyMove(
          this.localState,
          makeMove(trimmed),
          this.selfParty,
        );
        this.messages = [...this.messages, messageFromMove(trimmed, true)];
        this.emit();
        setTimeout(() => {
          if (!this.localState) return;
          const replyText = localBotReply(trimmed);
          this.localState = proto.applyMove(
            this.localState,
            makeMove(replyText),
            "B",
          );
          this.messages = [...this.messages, messageFromMove(replyText, false)];
          this.emit();
        }, LOCAL_REPLY_DELAY_MS);
      } catch (e) {
        this.fail(e);
      }
      return;
    }

    const dt = this.dt;
    if (!dt) return;
    // displayState includes our own pending move, so this correctly disables
    // the input until the opponent replies.
    if (!canSend(dt.displayState, this.selfParty)) return;
    try {
      dt.propose(makeMove(trimmed), 0n);
      this.messages = [...this.messages, messageFromMove(trimmed, true)];
      this.emit();
      this.persistMessages();
    } catch (e) {
      this.fail(e);
    }
  };
}

const flashSessions = new Map<string, FlashPvpSession>();

function getFlashSession(windowId: string): FlashPvpSession {
  let session = flashSessions.get(windowId);
  if (!session) {
    session = new FlashPvpSession();
    flashSessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "flash-pvp", () => {
      created.dispose();
      flashSessions.delete(windowId);
    });
  }
  return session;
}

export function useFlashPvp(windowId: string): FlashPvpApi {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();
  const { report } = useTelemetry();

  const session = getFlashSession(windowId);
  session.deps = {
    account,
    client,
    signExec: (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never,
    sponsoredSignExec: sponsored.signExec as never,
    report,
  };

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  // Cold-load resume: on mount (and once the wallet connects) restore a persisted in-flight chat.
  // Runs BEFORE the arena-entry effect and sets `status = "playing"` synchronously when it finds a
  // record, so a fresh arena entry (gated on `status === "idle"`) never double-enters over it.
  useEffect(() => {
    session.resumeIfActive();
  }, [session, account?.address]);

  // Centralized batched arena entry: the on-connect orchestrator deposited flash's
  // seat A in one batched PTB and published {allocation, keypair} to the arena store.
  // Consume it once and auto-enter the bot match.
  const arenaEntered = useRef(false);
  useEffect(() => {
    const tryEnter = () =>
      consumeArenaEntry(
        FLASH_ARENA_GAME_ID,
        arenaEntered,
        () => session.getSnapshot().status === "idle",
        (allocation, keypair) => session.enterArenaMatch(allocation, keypair),
      );
    tryEnter();
    return subscribeArena(tryEnter);
  }, [session, snap.status]);

  // A "true new chat": mirror a page reload. `session.reset()` returns the session to idle and drops
  // the settled tunnel's resume record; re-arming `arenaEntered` (which a reload gets fresh) lets the
  // auto-enter effect fire again; and `requestArenaGame` allocates + deposits a brand-new tunnel whose
  // published entry the now-idle, re-armed consumer picks up — landing in a fresh live chat.
  const newChat = useCallback(() => {
    session.reset();
    arenaEntered.current = false;
    const addr = account?.address;
    if (addr) void requestArenaGame(FLASH_ARENA_GAME_ID, addr);
  }, [session, account?.address]);

  // End chat: settle the current tunnel in the background, clear the UI to idle, and roll straight
  // into a fresh chat — same re-arm + allocate as `newChat`, but it closes the old tunnel first.
  const endChat = useCallback(() => {
    session.settleAndDetach();
    arenaEntered.current = false;
    const addr = account?.address;
    if (addr) void requestArenaGame(FLASH_ARENA_GAME_ID, addr);
  }, [session, account?.address]);

  return {
    status: snap.status,
    messages: snap.messages,
    error: snap.error,
    state: snap.state,
    selfParty: snap.selfParty,
    send: session.send,
    start: session.start,
    endChat,
    endMatch: session.endMatch,
    reset: session.reset,
    newChat,
  };
}
