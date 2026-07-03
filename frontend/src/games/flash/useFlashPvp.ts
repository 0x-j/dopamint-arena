import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
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
  depositSeatAMany,
  readCreatedAt,
  type SuiReads,
} from "@/onchain/tunnelTx";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { makeKeypairSponsoredSignExec } from "@/onchain/sponsor";
import {
  ensureMtpsAddressBalance,
  isMtpsAddressBalance,
  isMtpsConfigured,
  MTPS_COIN_TYPE,
} from "@/onchain/mtps";
import {
  allocateArenaBots,
  reportArenaOpened,
  type ArenaAllocation,
} from "@/onchain/arenaEnter";
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
import { flashSpectatorReply } from "./flashReplies";

export const FLASH_ARENA_GAME_ID = "flash";

/** Cadence between the browser bot's auto-sent messages in spectator mode. Flash is strict A/B
 *  alternation, so the real rate is bounded by the relay round-trip; this just paces it watchably. */
const SPECTATOR_AUTO_PACE_MS = 250;

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
  /** Spectator mode: seat A is a self-funded browser bot (no wallet), not the connected user. Set by
   *  the hook when `auto` is on. Routes `start` to the self-funded allocate path and keeps this
   *  session off the shared arena store, so Play and Spectator never contend. */
  spectator = false;
  /** The spectator's self-funded seat-A bot identity — created once, reused across restarts. */
  private spectatorBot: { keypair: Ed25519Keypair; address: string } | null =
    null;

  /** The spectator seat-A bot (created once per session). Its own ephemeral wallet — gas is
   *  sponsored and MTPS is faucet-funded, so it needs no connected wallet (bjBots-style). */
  ensureSpectatorBot(): { keypair: Ed25519Keypair; address: string } {
    if (!this.spectatorBot) {
      const seed = generateKeyPair().secretKey;
      const keypair = Ed25519Keypair.fromSecretKey(seed);
      this.spectatorBot = {
        keypair,
        address: keypair.getPublicKey().toSuiAddress(),
      };
    }
    return this.spectatorBot;
  }

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
    if (this.spectator) return this.startSpectator();
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

  /**
   * Spectator start: the self-funded browser bot (seat A) runs the arena allocate flow ITSELF —
   * no connected wallet, no shared arena store. It reserves a backend bot for seat B, deposits its
   * own seat A (`depositSeatAMany`, gas sponsored + MTPS faucet-funded), reports the join, then wires
   * the relay via the shared `enterArenaMatch`. The backend co-located bot fills seat B; the two then
   * exchange over the relay (moves counted by `relay_to_other`) with the auto-driver typing seat A.
   */
  private startSpectator = async () => {
    const deps = this.deps;
    if (!deps?.account) return; // hook sets a bot account for spectator sessions
    if (!isMtpsConfigured || !isMtpsAddressBalance) {
      this.error = "MTPS address-balance mode is required (VITE_MTPS_* env).";
      this.status = "error";
      this.emit();
      return;
    }
    this.error = null;
    this.status = "joining";
    this.emit();

    try {
      const botAddress = deps.account.address;
      const botSignExec = deps.signExec;
      const reads = deps.client as unknown as SuiReads;
      const eph = generateKeyPair();

      // 1. Reserve a backend bot for seat B (the fleet pre-creates + funds seat B's half).
      const allocs = await allocateArenaBots(
        [{ id: FLASH_ARENA_GAME_ID, userEphPubkey: toHex(eph.publicKey) }],
        botAddress,
        { apiBase: resolveBackendUrl() },
      );
      const alloc = allocs[0];
      if (!alloc) {
        // No free backend bot → offline fallback so the UI still works (no relay, no TPS).
        this.startLocalMatch();
        return;
      }

      // 2. Deposit seat A with the BOT's own sponsored signer (no wallet), funded from MTPS faucet.
      const amount = BigInt(alloc.stakeEach);
      await ensureMtpsAddressBalance({
        client: deps.client as never,
        signExec: botSignExec as never,
        owner: botAddress,
        need: amount,
      });
      await depositSeatAMany({
        reads,
        signExec: botSignExec as never,
        specs: [
          {
            tunnelId: alloc.tunnelId,
            partyA: { address: botAddress, publicKey: eph.publicKey },
            amount,
          },
        ],
        coinType: MTPS_COIN_TYPE,
        stakeFromBalance: { amount, coinType: MTPS_COIN_TYPE },
      });

      // 3. Announce the join so the fleet cues seat B, then wire the relay as seat A.
      await reportArenaOpened(
        [{ matchId: alloc.matchId, tunnelId: alloc.tunnelId }],
        { apiBase: resolveBackendUrl() },
      );
      this.enterArenaMatch(alloc, eph);
    } catch (e) {
      this.fail(e);
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
        // Play (chat) opts the co-located bot into LLM replies; Spectator (bot-vs-bot) stays on the
        // fast offline Markov reply so its throughput isn't gated on the model.
        const match = await mp.joinMatch(allocation.matchId, {
          chatLlm: !this.spectator,
        });
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

/**
 * One session per `sessionKey`, torn down under the real `windowId`. The Play tab and the auto-driven
 * Spectator tab live in the SAME window but need SEPARATE sessions (human chat vs bot-vs-bot), so
 * they pass distinct `sessionKey`s; both register their disposer under `windowId` (what `Desktop.close`
 * knows) with a key derived from the session so neither overwrites the other's teardown.
 */
function getFlashSession(
  windowId: string,
  sessionKey: string,
): FlashPvpSession {
  let session = flashSessions.get(sessionKey);
  if (!session) {
    session = new FlashPvpSession();
    flashSessions.set(sessionKey, session);
    const created = session;
    registerWindowDisposer(windowId, `flash-pvp:${sessionKey}`, () => {
      created.dispose();
      flashSessions.delete(sessionKey);
    });
  }
  return session;
}

/**
 * Drive one flash arena chat for a window.
 *
 * `opts.auto` turns it into the SPECTATOR: the browser bot occupies seat A (the "user" seat) via the
 * exact same allocate flow Play uses — one deposit, then the co-located backend bot is spawned on
 * seat B at `arena.join`. Instead of a human typing, this AUTO-SENDS a canned reply on seat A's turn,
 * so the two bots exchange over the relay and every move counts via `relay_to_other` (like all arena
 * moves). `opts.sessionKey` scopes the session so it never collides with the Play tab's.
 */
export function useFlashPvp(
  windowId: string,
  opts?: { sessionKey?: string; auto?: boolean },
): FlashPvpApi {
  const sessionKey = opts?.sessionKey ?? windowId;
  const auto = opts?.auto ?? false;
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();
  const { report } = useTelemetry();

  const session = getFlashSession(windowId, sessionKey);
  session.spectator = auto;
  if (auto) {
    // Spectator: seat A is a self-funded bot (bjBots-style), NOT the connected wallet. Its own
    // sponsored signer covers the allocate deposit + settle close; gas is sponsored, stake is
    // faucet-funded MTPS — so it runs with no wallet connected.
    const bot = session.ensureSpectatorBot();
    const botSignExec = makeKeypairSponsoredSignExec({
      address: bot.address,
      keypair: bot.keypair,
      client: client as never,
    }) as never;
    session.deps = {
      account: { address: bot.address },
      client,
      signExec: botSignExec,
      sponsoredSignExec: botSignExec,
      report,
    };
  } else {
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
  }

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  // Spectator auto-driver: when it's seat A's turn, auto-send the next canned reply after a short
  // pace. The backend bot (seat B) answers, we re-arm on the resulting state change — strict A/B
  // alternation, so the loop is self-limiting (a missing reply just stalls, never spins). Each send
  // is a real co-signed move over the relay, so it counts toward TPS exactly like a human's.
  useEffect(() => {
    if (
      !auto ||
      snap.status !== "playing" ||
      !canSend(snap.state, snap.selfParty)
    )
      return;
    const count = snap.state?.messageCount ?? 0n;
    const id = setTimeout(
      () => session.send(flashSpectatorReply(count)),
      SPECTATOR_AUTO_PACE_MS,
    );
    return () => clearTimeout(id);
  }, [auto, session, snap.status, snap.state, snap.selfParty]);

  // Cold-load resume: on mount (and once the wallet connects) restore a persisted in-flight chat.
  // Runs BEFORE the arena-entry effect and sets `status = "playing"` synchronously when it finds a
  // record, so a fresh arena entry (gated on `status === "idle"`) never double-enters over it.
  useEffect(() => {
    // Spectator runs a self-funded bot with its own lifecycle (startSpectator) — it neither
    // restores a wallet-scoped resume record nor consumes the shared arena store.
    if (auto) return;
    session.resumeIfActive();
  }, [auto, session, account?.address]);

  // Centralized batched arena entry: the on-connect orchestrator deposited flash's
  // seat A in one batched PTB and published {allocation, keypair} to the arena store.
  // Consume it once and auto-enter the bot match. Spectator sessions opt OUT (they allocate
  // directly via `startSpectator`), so Play and Spectator never contend for the store.
  const arenaEntered = useRef(false);
  useEffect(() => {
    if (auto) return;
    const tryEnter = () =>
      consumeArenaEntry(
        FLASH_ARENA_GAME_ID,
        arenaEntered,
        () => session.getSnapshot().status === "idle",
        (allocation, keypair) => session.enterArenaMatch(allocation, keypair),
      );
    tryEnter();
    return subscribeArena(tryEnter);
  }, [auto, session, snap.status]);

  // A "true new chat": mirror a page reload. `session.reset()` returns the session to idle and drops
  // the settled tunnel's resume record; re-arming `arenaEntered` (which a reload gets fresh) lets the
  // auto-enter effect fire again; and `requestArenaGame` allocates + deposits a brand-new tunnel whose
  // published entry the now-idle, re-armed consumer picks up — landing in a fresh live chat.
  const newChat = useCallback(() => {
    session.reset();
    arenaEntered.current = false;
    // Spectator has no store-published entry to re-consume — Start begins a fresh self-funded match.
    if (auto) return;
    const addr = account?.address;
    if (addr) void requestArenaGame(FLASH_ARENA_GAME_ID, addr);
  }, [auto, session, account?.address]);

  // End chat: settle the current tunnel in the background, clear the UI to idle, and roll straight
  // into a fresh chat — same re-arm + allocate as `newChat`, but it closes the old tunnel first.
  const endChat = useCallback(() => {
    session.settleAndDetach();
    arenaEntered.current = false;
    // Spectator: settle + return to idle (no auto-restart); Start spins up a fresh self-funded match.
    if (auto) return;
    const addr = account?.address;
    if (addr) void requestArenaGame(FLASH_ARENA_GAME_ID, addr);
  }, [auto, session, account?.address]);

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
