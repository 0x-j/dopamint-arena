/**
 * Generic PvP-match engine shared by every symmetric, public-seed, turn-alternating tunnel game
 * (bomb-it, chicken-cross). It owns the entire control plane — matchmaking over the relay, the
 * on-chain funding handshake + stake, the per-tick propose loop with an auto-bot/human seat, the
 * out-of-React session kept alive across window remounts, warm/cold resume, cooperative settle, and
 * the 1h grace floor. A game supplies only a `PvpMatchSpec`: its protocol, view, resume adapter, and
 * how a per-seat "intent" maps to a `Move`. The previous per-game hooks were ~600-line copies of
 * this body; collapsing them here makes relay/staking/auto-mode parity hold by construction.
 *
 * Scope: public-state, no-hidden-secret games (ADR-0010) with JSON-native moves — they ride the
 * relay with the identity codec, no per-game move (de)serializer. Hidden-info games (battleship/
 * poker) are a richer superset (binary moves + secret hooks) and are NOT driven by this engine.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
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
import type { Protocol } from "sui-tunnel-ts/protocol/Protocol";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { defaultAuto, rememberAuto } from "@/pvp/autoPreference";
import {
  MpClient,
  resolveMpWsUrl,
  type PvpChannel,
  type Role,
} from "@/pvp/mpClient";
import { proposePlan } from "@/pvp/proposePlan";
import {
  resumeWatchdogShouldArm,
  RESUME_WATCHDOG_MS,
} from "@/pvp/resumeWatchdog";
import { coSignCloseFromPeerRoot } from "@/pvp/settleClose";
import {
  getControlPlaneClient,
  resolveBackendUrl,
} from "@/backend/controlPlane";
import {
  closeCooperativeWithRoot,
  openAndFundSharedTunnel,
  raiseDisputeUnilateral,
  readCreatedAt,
} from "@/onchain/tunnelTx";
import {
  openSharedTunnelStaked,
  depositStakeStaked,
  type StakeStrategy,
} from "@/onchain/stakeTunnel";
import type { ArenaAllocation } from "@/onchain/arenaEnter";
import { runArenaPlay } from "@/onchain/arenaPlay";
import {
  consumeArenaEntry,
  subscribeArena,
} from "@/onchain/arenaAllocationStore";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { coSignedToSettleBody } from "@/backend/settleRequest";
import {
  attachResume,
  resumeActiveTunnels,
  type ResumeAdapter,
} from "@/pvp/resumeSession";
import {
  installResumePersistence,
  evictExpiredRecords,
  readResumeRecord,
  listActiveTunnels,
  clearResumeRecord,
} from "@/pvp/resume";

export type PvpStatus =
  | "idle"
  | "matching"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

/**
 * The per-game knowledge the engine needs. Every field is a real point of variation between two
 * games whose control flow is otherwise identical.
 *
 * @typeParam State  protocol state; must carry a `winner` the board reads.
 * @typeParam Move   protocol move; JSON-native (carried over the relay with the identity codec).
 * @typeParam Intent a single seat's per-tick input (a direction, an action) before it becomes a Move.
 * @typeParam View   the flattened, render-ready snapshot the board consumes.
 */
export interface PvpMatchSpec<
  State extends { winner: unknown },
  Move,
  Intent,
  View,
> {
  /** Matchmaking + resume key (e.g. "bomb-it"); also the window-disposer/log label. */
  game: string;
  /** Pacing between this seat's proposes (ms). */
  stepMs: number;
  /** Per-seat stake locked on-chain (MIST). */
  stake: bigint;
  makeProtocol: () => Protocol<State, Move>;
  deriveView: (displayState: State) => View;
  makeResumeAdapter: (onReconciled: () => void) => ResumeAdapter<State, Move>;
  /** The seat's input when no human intent is pending (a bot "stay"/forward default). */
  idleIntent: Intent;
  /** Wrap a seat's intent into a co-signable Move for that role. */
  intentToMove: (role: Role, intent: Intent) => Move;
  /** Read this seat's intent out of a bot-proposed Move (undefined ⇒ apply `idleIntent`). */
  readIntent: (role: Role, move: Move | null) => Intent | undefined;
  /** The backend arena/`profile_for` id (underscore form, e.g. `bomb_it`) when this game is wired
   *  into the co-located fleet. Set ⇒ `usePvpMatch` consumes the centralized batched-entry store for
   *  this game and auto-`enterArenaMatch`es on connect (no "Play" click). Must equal the game's
   *  `GameModule.arenaGameId`. Absent ⇒ this game isn't in the arena batch and the consumer no-ops. */
  arenaGameId?: string;
}

/** The hook's reactive surface. Game wrappers rename `setIntent` to their domain control. */
export interface PvpMatch<State extends { winner: unknown }, Intent, View> {
  status: PvpStatus;
  role: Role | null;
  /** Per-seat stake (MIST); surfaced in the outcome banner as the on-chain payout. */
  stake: number;
  /** Auto mode for YOUR seat: on = a bot plays it for you; off = you play. OFF on a fresh page load,
   *  then sticky to your last toggle (see autoPreference). The opponent toggles their own seat
   *  independently — both off = human-vs-human, both on = bot-vs-bot. */
  auto: boolean;
  view: View | null;
  winner: State["winner"];
  error: string | null;
  /** Join the public queue; paired with the next player who also clicks Find Match. */
  findMatch: () => void;
  /** On-demand arena entry: reserve a server bot for THIS game and play it now (arena-wired games).
   *  The Play trigger when the connect-time batch didn't allocate this window. */
  playArena: () => void;
  /** Queue this seat's next intent (consumed on the next propose; resets to idle after). */
  setIntent: (intent: Intent) => void;
  toggleAuto: () => void;
  reset: () => void;
  /** Back / leave mid-match: publish this seat's settlement half, then return to the lobby. Unlike
   *  `reset` (a bare disconnect), this settles — the staying seat / grace path submits the close. */
  leave: () => void;
}

interface PvpDeps {
  account: { address: string } | null;
  client: unknown;
  /** Wallet sender-pays signer — the SUI-fallback funding path and the non-MTPS close. */
  signExec: (tx: never) => Promise<{ digest: string }>;
  /** Backend-gas-sponsored signer (ADR-0009) — the open/fund path, so a 0-SUI player pays nothing. */
  sponsoredSignExec: (tx: never) => Promise<{ digest: string }>;
  /** Pick a user SUI coin to fund this seat's stake (SUI fallback; gas is sponsored, stake is not). */
  selectStakeCoin: (minAmount: bigint) => Promise<string>;
  /** MTPS stake: faucet (invisibly, sponsored) if short, then return a stake coin id (ADR-0010). */
  prepareStake: (minAmount: bigint) => Promise<string>;
  /** ADR-0013: ensure the player's MTPS address balance covers the stake. No-op once funded. */
  ensureStakeBalance: (minAmount: bigint) => Promise<void>;
}

interface PvpSnapshot<State extends { winner: unknown }, View> {
  status: PvpStatus;
  role: Role | null;
  stake: number;
  auto: boolean;
  view: View | null;
  winner: State["winner"];
  error: string | null;
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

/** Which seat proposes at this nonce: A proposes nonce 0→1, B 1→2, A 2→3, … */
function turn(nonce: bigint): Role {
  return nonce % 2n === 0n ? "A" : "B";
}

/**
 * A PvP match's whole session — matchmaking socket, tunnel, bot timer — kept OUT of React so a
 * minimized or reflowed window stays CONNECTED in the background instead of dropping the opponent.
 * The component subscribes; only an explicit window close disposes it. See `lib/windowSessions`.
 */
class PvpSession<State extends { winner: unknown }, Move, Intent, View> {
  deps: PvpDeps | null = null;

  private status: PvpStatus = "idle";
  private role: Role | null = null;
  private auto: boolean; // set from defaultAuto(game) in the constructor (OFF on fresh load, then sticky)
  private view: View | null = null;
  private winner: State["winner"] = null as State["winner"];
  private error: string | null = null;
  private snap: PvpSnapshot<State, View>;
  private listeners = new Set<() => void>();

  private mp: MpClient | null = null;
  private dt: DistributedTunnel<State, Move> | null = null;
  private detachResume: (() => void) | null = null;
  private proposeTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeWatchdog: ReturnType<typeof setTimeout> | null = null;
  private intent: Intent;
  /** Set per live match to `settle(publishOnly)`; lets `leave()` publish a half outside `onConfirmed`. */
  private settleNow: ((publishOnly: boolean) => void) | null = null;
  /** True between `leave()` and teardown, so the publish-only settle returns to the lobby once sent. */
  private leaving = false;

  constructor(private readonly spec: PvpMatchSpec<State, Move, Intent, View>) {
    this.intent = spec.idleIntent;
    // Arena (self-playing) games autopilot by default so a resume/reload keeps playing; a
    // player-driven game (no arenaGameId) defaults OFF. An explicit toggle still overrides.
    this.auto = defaultAuto(spec.game, !!spec.arenaGameId);
    this.snap = {
      status: "idle",
      role: null,
      stake: Number(spec.stake),
      auto: this.auto,
      view: null,
      winner: null as State["winner"],
      error: null,
    };
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): PvpSnapshot<State, View> => this.snap;

  private emit() {
    this.snap = {
      status: this.status,
      role: this.role,
      stake: Number(this.spec.stake),
      auto: this.auto,
      view: this.view,
      winner: this.winner,
      error: this.error,
    };
    for (const l of this.listeners) l();
  }

  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  private sync = () => {
    if (this.dt) {
      this.view = this.spec.deriveView(this.dt.displayState);
      this.winner = this.dt.state.winner;
    }
    this.emit();
  };

  /**
   * (Re)schedule this seat's next propose. A bot/idle seat is paced by `stepMs`; a manual seat
   * with real queued input proposes immediately (`proposePlan`), so a keypress isn't taxed by the
   * bot-watchability clock. Always cancels any stale timer first — when the turn flips or a
   * proposal is mid-flight the plan is "don't propose", and a scheduled idle tick must be dropped.
   * A pending proposal is read off the tunnel: `displayState` is ahead of `state` only while one
   * awaits its ACK.
   */
  private maybePropose = () => {
    const dt = this.dt;
    const myRole = this.role;
    if (!dt || !myRole) return;

    const plan = proposePlan({
      myRole,
      turnRole: turn(dt.nonce),
      terminal: dt.protocol.isTerminal(dt.state),
      hasPending: dt.displayState !== dt.state,
      auto: this.auto,
      hasInput: !this.auto && this.intent !== this.spec.idleIntent,
      stepMs: this.spec.stepMs,
    });

    if (this.proposeTimer !== null) {
      clearTimeout(this.proposeTimer);
      this.proposeTimer = null;
    }
    if (plan.delayMs === null) return;

    this.proposeTimer = setTimeout(() => {
      this.proposeTimer = null;
      const dtNow = this.dt;
      const myRoleNow = this.role;
      if (!dtNow || !myRoleNow) return;
      if (dtNow.protocol.isTerminal(dtNow.state)) return;
      if (turn(dtNow.nonce) !== myRoleNow) return;
      if (dtNow.displayState !== dtNow.state) return; // a proposal is mid-flight

      // Auto → a bot proposes this seat's move; manual → your queued intent (idle once consumed).
      let intent: Intent;
      if (this.auto) {
        const botMove =
          dtNow.protocol.randomMove?.(dtNow.state, myRoleNow, Math.random) ??
          null;
        intent =
          this.spec.readIntent(myRoleNow, botMove) ?? this.spec.idleIntent;
      } else {
        intent = this.intent;
        this.intent = this.spec.idleIntent;
      }
      try {
        dtNow.propose(this.spec.intentToMove(myRoleNow, intent), 0n);
        // Render the move NOW from the optimistic `displayState` instead of waiting a full ACK
        // round-trip — this is what makes manual play feel responsive (the tunnel already holds
        // the locally-applied, already-signed next state).
        this.sync();
      } catch {
        // Proposal already pending or other transient error — safe to ignore here.
      }
    }, plan.delayMs);
  };

  reset = () => {
    if (this.proposeTimer !== null) {
      clearTimeout(this.proposeTimer);
      this.proposeTimer = null;
    }
    this.clearResumeWatchdog();
    this.detachResume?.();
    this.detachResume = null;
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.role = null;
    this.intent = this.spec.idleIntent;
    this.auto = defaultAuto(this.spec.game, !!this.spec.arenaGameId);
    this.winner = null as State["winner"];
    this.status = "idle";
    this.view = null;
    this.error = null;
    this.settleNow = null;
    this.leaving = false;
    this.emit();
  };

  /** Back / leave: publish our signed settlement half, then return to the lobby. The staying seat (or
   *  the 1h grace path) submits the cooperative close — so leaving never blocks on a peer that won't
   *  co-sign an early end (the fleet bot only settles at its own terminal). With no live match
   *  (idle/funding/settled/error) it just resets. */
  leave = () => {
    if (
      this.settleNow &&
      (this.status === "playing" || this.status === "settling")
    ) {
      this.leaving = true;
      this.settleNow(true); // publishOnly → emit our half, then reset() to the lobby on resolve
    } else {
      this.reset();
    }
  };

  dispose = () => {
    if (this.proposeTimer !== null) {
      clearTimeout(this.proposeTimer);
      this.proposeTimer = null;
    }
    this.clearResumeWatchdog();
    this.detachResume?.();
    this.detachResume = null;
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.listeners.clear();
  };

  private makeAdapter() {
    return this.spec.makeResumeAdapter(() => this.sync());
  }

  // Wire the per-move loop + resume onto a freshly built/rebuilt tunnel. Shared by the live
  // (findMatch) and cold-load (resume) paths. The readiness handshake and the opening
  // maybePropose stay with the caller — a resuming peer is mid-game and never re-sends "ready".
  private activateSession(
    mp: MpClient,
    channel: PvpChannel,
    dt: DistributedTunnel<State, Move>,
    waitPeer: ReturnType<typeof makeInbox>,
    info: {
      matchId: string;
      role: Role;
      opponentWallet: string;
      opponentPubkeyHex: string;
      selfEphemeralSecretHex: string;
    },
  ) {
    // Bind the live tunnel for sync()/maybePropose()/the board. BOTH callers route through here,
    // so set it here — the resume() cold-load path doesn't set it otherwise, which left a resumed
    // match with a null `dt` (no view → stuck loading, the propose loop never schedules).
    this.dt = dt;
    const deps = this.deps!;
    const signExec = deps.signExec;
    const sponsoredSignExec = deps.sponsoredSignExec;
    const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
    const reads = deps.client as unknown as Parameters<
      typeof openAndFundSharedTunnel
    >[0]["reads"];
    const proto = this.spec.makeProtocol();
    let settling = false;
    // One cooperative close, guarded to fire once. A natural terminal waits for the bot's settle half
    // and submits over the bot's root; `publishOnly` (leaver/Back) has nothing to publish — the bot
    // owns the transcript and settles at its own terminal — so it just returns to the lobby. Stored on
    // `settleNow` so `leave()` can drive it from outside this closure.
    const triggerSettle = (publishOnly: boolean) => {
      if (settling) return;
      settling = true;
      this.status = "settling";
      this.emit();
      void settle(
        dt,
        info.role,
        waitPeer,
        reads,
        signExec as never,
        sponsoredSignExec as never,
        dt.tunnelId,
        getControlPlaneClient(),
        this.spec.game,
        coinType,
        publishOnly,
      ).then(
        () => {
          this.status = "settled";
          this.emit();
          // Leaver: our half is on the wire — return to the lobby (the staying seat / grace submits).
          if (this.leaving) this.reset();
        },
        (e) => {
          // Never trap a leaver on a failed publish — drop to the lobby; grace is the settlement floor.
          if (this.leaving) this.reset();
          else this.fail(e);
        },
      );
    };
    this.settleNow = triggerSettle;
    dt.onConfirmed = () => {
      this.sync();
      this.maybePropose();
      if (proto.isTerminal(dt.state)) triggerSettle(false);
    };

    this.detachResume?.();
    this.detachResume = attachResume({
      mp,
      channel,
      tunnel: dt,
      adapter: this.makeAdapter(),
      identity: {
        matchId: info.matchId,
        tunnelId: dt.tunnelId,
        role: info.role,
        game: this.spec.game,
        opponentWallet: info.opponentWallet,
        opponentPubkeyHex: info.opponentPubkeyHex,
        selfEphemeralSecretHex: info.selfEphemeralSecretHex,
      },
      // Settlement floor: after the 1h grace, settle from the held checkpoint.
      onGraceExpired: (latest) => {
        if (latest)
          void raiseDisputeUnilateral({
            signExec: signExec as never,
            tunnelId: dt.tunnelId,
            update: latest,
            role: info.role,
          });
      },
    });

    this.status = "playing";
    this.sync();
  }

  // Cold-load entry: on mount, rebuild any persisted in-flight match for this game and re-attach.
  resume = () => {
    if (this.mp) return; // already in a live or resumed session
    const deps = this.deps;
    if (!deps?.account) return; // wallet not ready yet; the mount effect retries
    installResumePersistence();
    evictExpiredRecords();
    const wallet = deps.account.address;
    const resumable = listActiveTunnels()
      .map((id) => readResumeRecord(id))
      .some((r) => r?.game === this.spec.game);
    if (!resumable) return; // nothing to resume → don't open a socket
    void (async () => {
      try {
        const ephemeral: KeyPair = generateKeyPair();
        const mp = new MpClient(
          resolveMpWsUrl(resolveBackendUrl()),
          wallet,
          ephemeral,
        );
        this.mp = mp;
        const restored = resumeActiveTunnels<State, Move>(
          mp,
          this.spec.game,
          {
            proto: this.spec.makeProtocol(),
            adapter: this.makeAdapter(),
          },
          { selfWallet: wallet },
        );
        if (restored.length === 0) {
          this.mp = null;
          mp.close();
          return;
        }
        const { tunnel, channel } = restored[0];
        const rec = readResumeRecord(tunnel.tunnelId)!;
        this.role = rec.role;
        const waitPeer = makeInbox(channel);
        this.activateSession(mp, channel, tunnel, waitPeer, {
          matchId: rec.matchId,
          role: rec.role,
          opponentWallet: rec.opponentWallet,
          opponentPubkeyHex: rec.opponentPubkeyHex,
          selfEphemeralSecretHex: rec.selfEphemeralSecretHex!,
        });
        await mp.connect(); // opening handshake carries resume{matchId}
        // A restored in-flight move is re-delivered by attachResume's resume handler (shared by all
        // hooks), so no explicit resendPending is needed here.
        try {
          this.maybePropose(); // kick a due move
        } catch {
          /* a move is already in flight — the resync handshake converges it */
        }
        this.sync();
        this.armResumeWatchdog(tunnel);
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  /** After a resume, guard against a peer that never answers (bot exited past its grace, or a
   *  cross-instance reconnect where our resync can't reach it). Arm ONLY when we're waiting on the
   *  peer — a re-sent pending, or it's their turn; a clean same-turn resume already succeeded, so
   *  arming there would tear down a healthy match. Disarm on the first confirmed frame (the peer is
   *  alive and replying). On timeout, drop the record and reset to idle so a fresh match can allocate
   *  — never eagerly dispute, which could attack a still-live channel; the old tunnel's stake is
   *  reclaimed by the existing on-chain grace. */
  private armResumeWatchdog(tunnel: DistributedTunnel<State, Move>) {
    const snap = tunnel.snapshot();
    const waitingOnPeer = resumeWatchdogShouldArm(
      snap.pending !== null,
      turn(tunnel.nonce) !== this.role,
    );
    if (!waitingOnPeer) return;
    this.clearResumeWatchdog();
    const prevConfirmed = tunnel.onConfirmed;
    tunnel.onConfirmed = (u) => {
      this.clearResumeWatchdog();
      tunnel.onConfirmed = prevConfirmed;
      prevConfirmed?.(u);
    };
    const tunnelId = tunnel.tunnelId;
    this.resumeWatchdog = setTimeout(() => {
      this.resumeWatchdog = null;
      clearResumeRecord(tunnelId);
      this.reset();
    }, RESUME_WATCHDOG_MS);
  }

  private clearResumeWatchdog() {
    if (this.resumeWatchdog !== null) {
      clearTimeout(this.resumeWatchdog);
      this.resumeWatchdog = null;
    }
  }

  findMatch = () => {
    const deps = this.deps;
    if (!deps?.account) {
      this.error = "connect a wallet first";
      this.status = "error";
      this.emit();
      return;
    }
    const wallet = deps.account.address;
    installResumePersistence();
    evictExpiredRecords();
    const signExec = deps.signExec;
    const reads = deps.client as unknown as Parameters<
      typeof openAndFundSharedTunnel
    >[0]["reads"];

    void (async () => {
      try {
        this.error = null;
        this.status = "matching";
        this.emit();
        const ephemeral: KeyPair = generateKeyPair();
        const mp = new MpClient(
          resolveMpWsUrl(resolveBackendUrl()),
          wallet,
          ephemeral,
        );
        this.mp = mp;
        await mp.connect();
        const match = await mp.quickMatch(this.spec.game);
        this.role = match.role;
        this.emit();

        const channel = mp.channel(match.matchId);
        const waitPeer = makeInbox(channel);

        // 1) exchange ephemeral pubkeys (wallet is only the matchmaking label).
        channel.sendPeer({
          t: "hello",
          ephemeralPubkey: toHex(ephemeral.publicKey),
        });
        const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
        const oppPub = fromHex(hello.ephemeralPubkey);

        // 2) fund on-chain, gas-sponsored. MTPS path (ADR-0010): faucet the stake invisibly
        //    (settler pays gas) so a 0-SUI player plays free; SUI path (MTPS env unset):
        //    sponsored stake with a sender-pays fallback (ADR-0009). Seat A opens + announces; B deposits.
        this.status = "funding";
        this.emit();
        const stake: StakeStrategy = {
          sponsoredSignExec: deps.sponsoredSignExec as never,
          walletSignExec: signExec as never,
          prepareStake: deps.prepareStake,
          selectStakeCoin: deps.selectStakeCoin,
          ensureStakeBalance: deps.ensureStakeBalance,
        };
        let tunnelId: string;
        if (match.role === "A") {
          tunnelId = await openSharedTunnelStaked({
            reads,
            partyA: { address: wallet, publicKey: ephemeral.publicKey },
            partyB: { address: match.opponentWallet, publicKey: oppPub },
            amount: this.spec.stake,
            label: this.spec.game,
            ...stake,
          });
          mp.announceTunnel(match.matchId, tunnelId);
          channel.sendPeer({ t: "open", tunnelId });
        } else {
          const open = await waitPeer<{ tunnelId: string }>("open");
          tunnelId = open.tunnelId;
          await depositStakeStaked({
            tunnelId,
            amount: this.spec.stake,
            label: this.spec.game,
            ...stake,
          });
        }

        // 3) build the distributed engine over the relay transport. Moves are JSON-native, so
        //    the tunnel carries them with its identity codec (no per-game (de)serializer).
        const backend = defaultBackend();
        const self = makeEndpoint(backend, wallet, ephemeral, true);
        const opp = makeEndpoint(
          backend,
          match.opponentWallet,
          { publicKey: oppPub, scheme: ephemeral.scheme },
          false,
        );
        const dt = new DistributedTunnel<State, Move>(
          this.spec.makeProtocol(),
          {
            tunnelId,
            self,
            opponent: opp,
            selfParty: match.role,
          },
          channel.transport,
          { a: this.spec.stake, b: this.spec.stake },
        );
        this.dt = dt;
        this.activateSession(mp, channel, dt, waitPeer, {
          matchId: match.matchId,
          role: match.role,
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
        this.maybePropose();
        this.sync();
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  /**
   * Arena entry (ADR-0028): join a pre-allocated match whose tunnel the fleet already created +
   * funded seat B for, so this seat (always A) only wires the relay + engine over the already-funded
   * tunnel — no matchmaking, no open, no deposit (the deposit was batched by the caller's `enterArena`,
   * one wallet popup). The bot (seat B) auto-plays via the same propose loop + auto toggle as a human
   * peer. Unlike `findMatch`'s role-A path, there is NO "ready" wait: the fleet bot enters its loop the
   * instant its tunnel opens and the relay buffers our first frame, so waiting on a "ready" it never
   * sends would hang seat A forever. `allocation` comes from `POST /v1/arena/allocate`; `eph` is the
   * SAME per-game key baked into the tunnel at allocate (a mismatched key rejects every co-signature).
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
    installResumePersistence();
    evictExpiredRecords();
    // Arena entry: this seat starts on autopilot vs the fleet bot; the player toggles Auto off to take
    // over. Forced ON per entry (like battleship), regardless of the session's last toggle.
    this.auto = true;

    void (async () => {
      try {
        this.error = null;
        this.status = "matching";
        this.emit();
        const ephemeral = eph;
        const mp = new MpClient(
          resolveMpWsUrl(resolveBackendUrl()),
          wallet,
          ephemeral,
        );
        this.mp = mp;
        await mp.connect();
        // Join the ONE pre-allocated match (not matchmaking); role is always A — the fleet bound the
        // bot as seat B at allocate. The server replies match.found once the bot also binds.
        const match = await mp.joinMatch(allocation.matchId);
        this.role = match.role;
        this.emit();

        const channel = mp.channel(match.matchId);
        const waitPeer = makeInbox(channel);

        // Exchange ephemeral pubkeys (the bot's was baked into the tunnel at create, but the relay
        // handshake still carries it so both sides know the co-signing key).
        channel.sendPeer({
          t: "hello",
          ephemeralPubkey: toHex(ephemeral.publicKey),
        });
        const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
        const oppPub = fromHex(hello.ephemeralPubkey);

        // Seat A was deposited by the batched `enterArena` PTB and seat B by the fleet at allocate, so
        // the tunnel is already live — build the engine over the pre-created tunnelId (no funding here).
        const backend = defaultBackend();
        const self = makeEndpoint(backend, wallet, ephemeral, true);
        const opp = makeEndpoint(
          backend,
          match.opponentWallet,
          { publicKey: oppPub, scheme: ephemeral.scheme },
          false,
        );
        const dt = new DistributedTunnel<State, Move>(
          this.spec.makeProtocol(),
          {
            tunnelId: allocation.tunnelId,
            self,
            opponent: opp,
            selfParty: match.role,
          },
          channel.transport,
          { a: this.spec.stake, b: this.spec.stake },
        );
        this.dt = dt;
        this.activateSession(mp, channel, dt, waitPeer, {
          matchId: match.matchId,
          role: match.role,
          opponentWallet: match.opponentWallet,
          opponentPubkeyHex: toHex(oppPub),
          selfEphemeralSecretHex: toHex(ephemeral.secretKey),
        });

        // No "ready" handshake with the fleet bot (see the doc above). Start the loop immediately.
        this.maybePropose();
        this.sync();
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  /**
   * On-demand arena entry: the "Play" trigger for an arena-wired game whose window the connect-time
   * batch did NOT allocate (opened mid-session, or its entry was consumed/finished). Reserves one bot
   * for THIS game + deposits seat A in a single wallet popup (`runArenaPlay`), then hands off to
   * `enterArenaMatch` — the same path the store-consumer auto-enter uses. Sets `funding` first so the
   * window shows progress instead of a dead lobby. No-op if the game isn't arena-wired.
   */
  playArena = () => {
    const deps = this.deps;
    if (!deps?.account) {
      this.error = "connect a wallet first";
      this.status = "error";
      this.emit();
      return;
    }
    const arenaGameId = this.spec.arenaGameId;
    if (!arenaGameId) return; // not in the co-located fleet — nothing to allocate
    const wallet = deps.account.address;
    installResumePersistence();
    evictExpiredRecords();

    const stake: StakeStrategy = {
      sponsoredSignExec: deps.sponsoredSignExec as never,
      walletSignExec: deps.signExec as never,
      prepareStake: deps.prepareStake,
      selectStakeCoin: deps.selectStakeCoin,
      ensureStakeBalance: deps.ensureStakeBalance,
    };
    void runArenaPlay({
      arenaGameId,
      wallet,
      stake,
      label: this.spec.game,
      stakePerGame: this.spec.stake,
      setBusy: () => {
        this.error = null;
        this.status = "funding";
        this.emit();
      },
      setError: (msg) => {
        this.error = msg;
        this.status = "error";
        this.emit();
      },
      onCaught: (e) => this.fail(e),
      enter: this.enterArenaMatch,
    });
  };

  setIntent = (intent: Intent) => {
    this.intent = intent;
    // A human keypress preempts the idle pacing clock: try to propose at once on our turn
    // (no-op while it's the opponent's turn or a proposal is mid-flight — the intent stays
    // queued and fires the moment our turn returns).
    if (!this.auto) this.maybePropose();
  };

  toggleAuto = () => {
    this.auto = !this.auto;
    rememberAuto(this.spec.game, this.auto);
    this.intent = this.spec.idleIntent;
    this.emit();
  };
}

/**
 * Build a React hook that drives this game's PvP matches. Sessions live in a module-level map keyed
 * by `windowId` (one map per game, since each game calls this once) so a window can minimize/reflow
 * without dropping the opponent; the window-close disposer tears the session down.
 */
export function createPvpMatchHook<
  State extends { winner: unknown },
  Move,
  Intent,
  View,
>(
  spec: PvpMatchSpec<State, Move, Intent, View>,
): (windowId: string) => PvpMatch<State, Intent, View> {
  const sessions = new Map<string, PvpSession<State, Move, Intent, View>>();

  function getSession(windowId: string): PvpSession<State, Move, Intent, View> {
    let session = sessions.get(windowId);
    if (!session) {
      session = new PvpSession(spec);
      sessions.set(windowId, session);
      const created = session;
      registerWindowDisposer(windowId, `${spec.game}-pvp`, () => {
        created.dispose();
        sessions.delete(windowId);
      });
    }
    return session;
  }

  return function usePvpMatch(windowId: string): PvpMatch<State, Intent, View> {
    const account = useCurrentAccount();
    const client = useSuiClient();
    const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
    const sponsored = useSponsoredSignExec();

    const session = getSession(windowId);
    session.deps = {
      account,
      client,
      signExec: (async (
        tx: Parameters<typeof signAndExecute>[0]["transaction"],
      ) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      }) as never,
      // Open/fund routes through the backend gas sponsor (ADR-0009); the close keeps signExec
      // above unless MTPS mode, where settle() swaps in the sponsored signer.
      sponsoredSignExec: sponsored.signExec as never,
      selectStakeCoin: sponsored.selectStakeCoin,
      prepareStake: sponsored.prepareStake,
      ensureStakeBalance: sponsored.ensureStakeBalance,
    };

    // Cold-load: once the wallet is known, re-attach to any persisted in-flight match. resume()
    // is idempotent (no-ops if already connected or nothing to restore).
    useEffect(() => {
      session.resume();
    }, [session, account?.address]);

    const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

    // Centralized batched entry (ADR-0028): the arena orchestrator deposited this game's seat A (at
    // connect, or when its window was added) and published {allocation, keypair} to the arena store.
    // Consume it once and auto-`enterArenaMatch` — the window comes alive without a "Play" click. Only
    // for arena-wired games (spec.arenaGameId set), only from idle (never clobbers a resumed match);
    // `clearArenaEntry` consumes the entry so a window remount can't re-enter a closed match.
    const arenaEntered = useRef(false);
    useEffect(() => {
      const arenaGameId = spec.arenaGameId;
      if (!arenaGameId) return;
      const tryEnter = () =>
        consumeArenaEntry(
          arenaGameId,
          arenaEntered,
          () => session.getSnapshot().status === "idle",
          (allocation, keypair) => session.enterArenaMatch(allocation, keypair),
        );
      tryEnter();
      return subscribeArena(tryEnter);
    }, [session, snap.status]);

    return {
      status: snap.status,
      role: snap.role,
      stake: snap.stake,
      auto: snap.auto,
      view: snap.view,
      winner: snap.winner,
      error: snap.error,
      findMatch: session.findMatch,
      playArena: session.playArena,
      setIntent: session.setIntent,
      toggleAuto: session.toggleAuto,
      reset: session.reset,
      leave: session.leave,
    };
  };
}

/**
 * Wait for the co-located bot's settlement half, sign seat A's half over the root the bot supplied,
 * and submit the close via the backend /settle (header-only body; the bot's canonical transcript is
 * archived to S3). The FE keeps NO transcript — every arena match is human-vs-bot, so the bot owns the
 * root and funds ride on the co-signed balances, not the root (see `coSignCloseFromPeerRoot`).
 * Fallback: wallet-submitted close_cooperative_with_root (backend down).
 */
async function settle<State, Move>(
  dt: DistributedTunnel<State, Move>,
  role: Role,
  waitPeer: <T>(t: string) => Promise<T>,
  reads: Parameters<typeof readCreatedAt>[0],
  signExec: Parameters<typeof closeCooperativeWithRoot>[0]["signExec"],
  // In MTPS mode the player holds 0 SUI, so a wallet-signed close would throw and strand the
  // staked MTPS — the fallback close must use the sponsored signer there.
  sponsoredSignExec: Parameters<typeof closeCooperativeWithRoot>[0]["signExec"],
  tunnelId: string,
  cp: ReturnType<typeof getControlPlaneClient>,
  game: string,
  coinType: string | undefined,
  // Leaver (Back): the FE has no half to publish (the bot owns the transcript and only settles at its
  // own terminal), so just return to the lobby — the bot's terminal / on-chain grace is the floor.
  publishOnly = false,
): Promise<void> {
  if (publishOnly) return;
  const createdAt = await readCreatedAt(reads, tunnelId);
  const other = await waitPeer<{ sig: string; transcriptRoot: string }>(
    "settleHalf",
  );
  const co = coSignCloseFromPeerRoot(
    dt,
    createdAt,
    fromHex(other.transcriptRoot),
    fromHex(other.sig),
  );
  if (role !== "A") return; // single submitter, mirrors the cooperative-close pattern
  try {
    await cp.settle(tunnelId, coSignedToSettleBody(co, []));
  } catch (e) {
    console.error(
      `[${game}] backend settle failed; falling back to wallet close:`,
      e,
    );
    await closeCooperativeWithRoot({
      signExec: isMtpsConfigured ? sponsoredSignExec : signExec,
      tunnelId,
      settlement: co,
      coinType,
    });
  }
}
