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
import { coSignCloseFromPeerRoot } from "../../pvp/settleClose";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { defaultAuto, rememberAuto } from "@/pvp/autoPreference";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import type { TelemetryWriter } from "../../telemetry/TelemetryProvider";
import {
  BattleshipProtocol,
  battleshipMoveCodec,
  type BattleshipMove,
  type BattleshipState,
} from "./protocol/battleship";
import {
  MpClient,
  resolveMpWsUrl,
  type PvpChannel,
  type Role,
} from "../../pvp/mpClient";
import {
  getControlPlaneClient,
  resolveBackendUrl,
} from "../../backend/controlPlane";
import {
  closeCooperativeWithRoot,
  openAndFundSharedTunnel,
  raiseDisputeUnilateral,
  readCreatedAt,
} from "../../onchain/tunnelTx";
import { useSponsoredSignExec } from "../../onchain/useSponsoredSignExec";
import {
  openSharedTunnelStaked,
  depositStakeStaked,
  type StakeStrategy,
} from "../../onchain/stakeTunnel";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "../../onchain/mtps";
import { coSignedToSettleBody } from "../../backend/settleRequest";
import { type FleetSecret, makeFleetSecret } from "./engine/selfPlay";
import {
  type Placement,
  placementsToBoard,
  placeFleetRandom,
} from "./engine/fleet";
import { randomSalts } from "./engine/merkle";
import type { ArenaAllocation } from "@/onchain/arenaEnter";
import { runArenaPlay } from "@/onchain/arenaPlay";
import {
  consumeArenaEntry,
  subscribeArena,
} from "@/onchain/arenaAllocationStore";
import { proposeDue, canFireShot } from "./engine/pvpDriver";
import { pickShot, BOT_CONFIGS, DEFAULT_BOT_DIFFICULTY } from "./engine/bot";
import { deriveBattleshipView, type BattleshipView } from "./view";
import { attachResume, resumeActiveTunnels } from "@/pvp/resumeSession";
import { RESUME_WATCHDOG_MS } from "@/pvp/resumeWatchdog";
import {
  installResumePersistence,
  evictExpiredRecords,
  readResumeRecord,
  listActiveTunnels,
  clearResumeRecord,
} from "@/pvp/resume";
import { makeBattleshipResumeAdapter } from "./battleshipResumeAdapter";

/** Backend arena/`profile_for` id (single token, same both ways). Single source of truth for the
 *  arena-store consumer (below) and `GameModule.arenaGameId` (index.ts). */
export const BATTLESHIP_ARENA_GAME_ID = "battleship";

const STAKE_BALANCE = 1n; // locked per seat: 1 MTPS (0 decimals; ADR-0023)
const STAKE_SHIFT = 1n; // winner-take-all: the loser's 1 MTPS stake moves to the winner (0 decimals; ADR-0023)

export type PvpStatus =
  | "idle"
  | "matching"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface BattleshipPvp {
  status: PvpStatus;
  role: Role | null;
  view: BattleshipView | null;
  opponentWallet: string | null;
  error: string | null;
  /** Commit the placed fleet and join matchmaking. */
  findMatch: (placements: Placement[]) => void;
  /** Commit the placed fleet and enter an on-demand arena match vs a server bot. */
  playArena: (placements: Placement[]) => void;
  fire: (cell: number) => void;
  /** True while client-side autopilot fires YOUR shots. Settlement still waits for
   *  the game to end (single-game tunnel); either seat's close finalizes it. */
  auto: boolean;
  /** Toggle autopilot for your seat; flipping it on fires immediately if it's your turn. */
  setAuto: (on: boolean) => void;
  reset: () => void;
  /** Back / Settle: publish this seat's settlement half and stop (status → settled). Unlike `reset`
   *  (a bare disconnect), this settles — the staying seat / grace path submits the close. */
  endMatch: () => void;
}

type BattleshipTunnel = DistributedTunnel<BattleshipState, BattleshipMove>;

interface PvpDeps {
  account: { address: string } | null;
  client: unknown;
  /** Telemetry writer for the "My Activity" feed (one row per finished match). */
  report: TelemetryWriter;
  /** Wallet sender-pays signer — used for the close fallback (close is sponsored via /settle). */
  signExec: (tx: never) => Promise<{ digest: string }>;
  /** Backend-gas-sponsored signer (ADR-0009) — used for the open/fund tx. */
  sponsoredSignExec: (tx: never) => Promise<{ digest: string }>;
  /** Pick a user coin to fund this seat's stake (gas is sponsored, the stake is not). */
  selectStakeCoin: (minAmount: bigint) => Promise<string>;
  /** MTPS stake: faucet (invisibly, sponsored) if short, then return a stake coin id. */
  prepareStake: (minAmount: bigint) => Promise<string>;
  /** ADR-0013: ensure the player's MTPS address balance covers the stake. No-op once funded. */
  ensureStakeBalance: (minAmount: bigint) => Promise<void>;
}

interface PvpSnapshot {
  status: PvpStatus;
  role: Role | null;
  view: BattleshipView | null;
  opponentWallet: string | null;
  error: string | null;
  auto: boolean;
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
 * A PvP match's whole session — matchmaking socket, tunnel, fleet secret — kept
 * OUT of React so a minimized or reflowed window stays CONNECTED in the
 * background instead of dropping the opponent. The component subscribes; only an
 * explicit window close disposes it. See `lib/windowSessions`.
 */
class PvpSession {
  deps: PvpDeps | null = null;

  private status: PvpStatus = "idle";
  private role: Role | null = null;
  private view: BattleshipView | null = null;
  private opponentWallet: string | null = null;
  private error: string | null = null;
  private snap: PvpSnapshot = {
    status: "idle",
    role: null,
    view: null,
    opponentWallet: null,
    error: null,
    auto: defaultAuto("battleship"),
  };
  private listeners = new Set<() => void>();

  private mp: MpClient | null = null;
  private dt: BattleshipTunnel | null = null;
  private secret: FleetSecret | null = null;
  private detachResume: (() => void) | null = null;
  private placements: Placement[] = []; // your fleet layout, for ship-status display
  private lastYourShot: number | null = null;
  private lastEnemyShot: number | null = null;
  // Client-side autopilot: when on, fire YOUR shots automatically (one tunnel = one
  // game in PvP, so the loop doesn't rematch — it just plays this game out).
  private auto = defaultAuto("battleship");
  // Monotonic id for "My Activity" rows pushed per finished match.
  private txnId = 0;
  /** Set per live match to `settle(publishOnly)`; lets `endMatch()` publish a half outside `onConfirmed`. */
  private settleNow: ((publishOnly: boolean) => void) | null = null;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): PvpSnapshot => this.snap;

  private emit() {
    this.snap = {
      status: this.status,
      role: this.role,
      view: this.view,
      opponentWallet: this.opponentWallet,
      error: this.error,
      auto: this.auto,
    };
    for (const l of this.listeners) l();
  }

  /** Autopilot: if it's your turn to fire and autopilot is on, pick + propose a shot
   *  (the bot AI). A no-op otherwise; safe to call after every confirmed update. */
  private autoFireIfDue() {
    if (!this.auto) return;
    const dt = this.dt;
    const r = this.role;
    if (!dt || !r) return;
    const st = dt.state;
    if (
      st.phase !== "playing" ||
      st.pendingShot ||
      st.turn !== r ||
      st.winner !== 0 ||
      dt.displayState !== dt.state // a proposal is already awaiting its ACK (e.g. a re-seated resume shoot)
    )
      return;
    const cell = pickShot(
      st,
      r,
      Math.random,
      BOT_CONFIGS[DEFAULT_BOT_DIFFICULTY],
    );
    this.fire(cell);
  }

  setAuto = (on: boolean) => {
    if (this.auto === on) return;
    this.auto = on;
    rememberAuto("battleship", on);
    this.emit();
    // Flipping autopilot on while it's your turn: fire now.
    if (on) this.autoFireIfDue();
  };
  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }
  private sync = () => {
    if (this.dt && this.secret && this.role) {
      this.view = deriveBattleshipView(
        this.dt.displayState,
        this.placements,
        this.role,
        {
          lastYourShot: this.lastYourShot,
          lastEnemyShot: this.lastEnemyShot,
          onChain: true,
        },
      );
    }
    this.emit();
  };

  reset = () => {
    this.detachResume?.();
    this.detachResume = null;
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.secret = null;
    this.role = null;
    this.lastYourShot = null;
    this.lastEnemyShot = null;
    this.status = "idle";
    this.view = null;
    this.opponentWallet = null;
    this.error = null;
    this.settleNow = null;
    this.emit();
  };

  /** End the match now (Back / Settle button): publish this seat's settlement half, then stop — the
   *  staying seat / 1h grace path submits the cooperative close. Status advances settling→settled, so
   *  the window can either close (Back) or show the settled screen (Settle). No live match ⇒ no-op
   *  (the caller resets). Never blocks on a peer that won't co-sign an early end (the fleet bot). */
  endMatch = () => {
    if (
      this.settleNow &&
      (this.status === "playing" || this.status === "settling")
    ) {
      this.settleNow(true);
    }
  };

  dispose = () => {
    this.detachResume?.();
    this.detachResume = null;
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.secret = null;
    this.listeners.clear();
  };

  private makeAdapter() {
    return makeBattleshipResumeAdapter({
      getSecret: () => this.secret!,
      setSecret: (s) => {
        this.secret = s;
      },
      getPlacements: () => this.placements,
      setPlacements: (p) => {
        this.placements = p;
      },
      onReconciled: () => this.sync(),
    });
  }

  // Wire the per-move loop + resume onto a freshly built/rebuilt tunnel. Shared by the live
  // (findMatch) and cold-load (resume) paths. The readiness handshake and the opening proposeDue
  // stay with the caller — a resuming peer is mid-game and never re-sends "ready".
  private activateSession(
    mp: MpClient,
    channel: PvpChannel,
    dt: BattleshipTunnel,
    waitPeer: ReturnType<typeof makeInbox>,
    info: {
      matchId: string;
      role: Role;
      opponentWallet: string;
      opponentPubkeyHex: string;
      selfEphemeralSecretHex: string;
    },
  ) {
    // Bind the live tunnel for sync()/fire()/autopilot. BOTH callers route through
    // here, so set it here — the resume() path doesn't set it otherwise, which left a
    // resumed match with a null `dt` (no view → stuck at "Setting up…", dead fire).
    this.dt = dt;
    const deps = this.deps!;
    const signExec = deps.signExec;
    const sponsoredSignExec = deps.sponsoredSignExec;
    const reads = deps.client as unknown as Parameters<
      typeof openAndFundSharedTunnel
    >[0]["reads"];
    const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
    const proto = new BattleshipProtocol(STAKE_SHIFT);
    let settling = false;
    // One cooperative close, guarded to fire once. A natural terminal (all ships sunk) does the full
    // half-exchange + submit; `publishOnly` (Back / Settle button) publishes our half and stops, so
    // ending early never blocks on a peer that won't co-sign it (the fleet bot only settles at
    // terminal). Stored on `settleNow` so `endMatch()` can drive the publish-only path.
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
        coinType,
        publishOnly,
      ).then(
        () => {
          this.status = "settled";
          this.emit();
        },
        (e) => this.fail(e),
      );
    };
    this.settleNow = triggerSettle;
    dt.onConfirmed = () => {
      const st = dt.state;
      if (st.pendingShot && st.pendingShot.by !== info.role) {
        this.lastEnemyShot = st.pendingShot.cell;
      }
      this.sync();
      // Drive the ordered commit + defender reveals. Autopilot-fire ONLY when nothing
      // was proposed this tick — a shot sent right after another move races it on the
      // channel and corrupts the frame (relay: "unparseable control message"). When a
      // move was due, the shot follows on the next confirmed tick instead.
      const proposed = proposeDue(dt, info.role, this.secret!);
      if (!proposed) this.autoFireIfDue();
      if (proto.isTerminal(st) && !settling) {
        // One "My Activity" row per finished match, from this seat's perspective.
        const iWon = st.winner === (info.role === "A" ? 1 : 2);
        this.deps?.report.pushLocalTxn({
          id: (this.txnId += 1),
          game: "battleship",
          time: new Date().toLocaleTimeString("en-GB"),
          bot: "You",
          type: iWon ? "PvP Win" : "PvP Loss",
          status: "Success",
          amount: "",
        });
        triggerSettle(false);
      }
    };

    // Resume wiring: persist on confirm + run the resync handshake on reconnect.
    // The fleet secret round-trips only through capture/restore, never the wire.
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
        game: "battleship",
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

  // Cold-load entry: on mount, rebuild any persisted in-flight battleship match and re-attach.
  // The restored secret + placements are hydrated by makeAdapter during rebuildTunnel.
  resume = () => {
    if (this.mp) return; // already in a live or resumed session
    const deps = this.deps;
    if (!deps?.account) return; // wallet not ready yet; the mount effect retries
    installResumePersistence();
    evictExpiredRecords();
    const wallet = deps.account.address;
    const resumable = listActiveTunnels()
      .map((id) => readResumeRecord(id))
      .some((r) => r?.game === "battleship");
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
        const restored = resumeActiveTunnels<BattleshipState, BattleshipMove>(
          mp,
          "battleship",
          {
            proto: new BattleshipProtocol(STAKE_SHIFT),
            moveCodec: battleshipMoveCodec,
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
        this.opponentWallet = rec.opponentWallet;
        const waitPeer = makeInbox(channel);
        this.activateSession(mp, channel, tunnel, waitPeer, {
          matchId: rec.matchId,
          role: rec.role,
          opponentWallet: rec.opponentWallet,
          opponentPubkeyHex: rec.opponentPubkeyHex,
          selfEphemeralSecretHex: rec.selfEphemeralSecretHex!,
        });
        // The relay confirms a re-attach with `resume.ok`. Watch for it; if it never
        // arrives within the grace window, the match is dead (or the backend lacks
        // resume support) — abandon so the user isn't stranded.
        let resumed = false;
        const unsubOk = mp.onResumeOk(() => {
          resumed = true;
        });
        await mp.connect(); // opening handshake carries resume{matchId}
        try {
          proposeDue(tunnel, rec.role, this.secret!); // kick a due reveal/commit
        } catch {
          /* a move is already in flight — the resync handshake converges it */
        }
        this.sync();
        setTimeout(() => {
          unsubOk();
          if (!resumed && this.mp === mp) this.abandonResume(tunnel.tunnelId);
        }, RESUME_WATCHDOG_MS);
      } catch {
        this.abandonResume();
      }
    })();
  };

  /** Tear down a failed/stale resume: drop the persisted record(s) so the next mount
   *  doesn't retry-hang, close the socket, and return to idle (Find Match reachable). */
  private abandonResume(tunnelId?: string) {
    try {
      if (tunnelId) clearResumeRecord(tunnelId);
      else
        for (const id of listActiveTunnels()) {
          if (readResumeRecord(id)?.game === "battleship")
            clearResumeRecord(id);
        }
    } catch {
      /* best-effort cleanup */
    }
    this.detachResume?.();
    this.detachResume = null;
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.secret = null;
    this.role = null;
    this.opponentWallet = null;
    this.status = "idle";
    this.view = null;
    this.error = null;
    this.emit();
  }

  findMatch = (placements: Placement[]) => {
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
    this.placements = placements;
    const secret = makeFleetSecret(
      placementsToBoard(placements),
      randomSalts(),
    );
    this.secret = secret;
    const signExec = deps.signExec;
    const sponsoredSignExec = deps.sponsoredSignExec;
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
        const match = await mp.quickMatch("battleship");
        this.role = match.role;
        this.opponentWallet = match.opponentWallet;
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

        // 2) fund on-chain. MTPS path (ADR-0010): faucet the stake token invisibly (gas-
        //    sponsored) and stake MTPS — settler pays gas, so a 0-SUI player plays free; no
        //    sender-pays fallback (the faucet itself needs the sponsor). SUI path (MTPS env
        //    unset): sponsored SUI stake with a sender-pays fallback (ADR-0009).
        this.status = "funding";
        this.emit();
        const stake: StakeStrategy = {
          sponsoredSignExec: sponsoredSignExec as never,
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
            amount: STAKE_BALANCE,
            label: "battleship",
            ...stake,
          });
          mp.announceTunnel(match.matchId, tunnelId);
          channel.sendPeer({ t: "open", tunnelId });
        } else {
          const open = await waitPeer<{ tunnelId: string }>("open");
          tunnelId = open.tunnelId;
          await depositStakeStaked({
            tunnelId,
            amount: STAKE_BALANCE,
            label: "battleship",
            ...stake,
          });
        }

        // 3) build the distributed engine over the relay transport.
        const proto = new BattleshipProtocol(STAKE_SHIFT);
        const backend = defaultBackend();
        const self = makeEndpoint(backend, wallet, ephemeral, true);
        const opp = makeEndpoint(
          backend,
          match.opponentWallet,
          { publicKey: oppPub, scheme: ephemeral.scheme },
          false,
        );
        const dt = new DistributedTunnel<BattleshipState, BattleshipMove>(
          proto,
          {
            tunnelId,
            self,
            opponent: opp,
            selfParty: match.role,
            moveCodec: battleshipMoveCodec,
          },
          channel.transport,
          { a: STAKE_BALANCE, b: STAKE_BALANCE },
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
        proposeDue(dt, match.role, secret); // kick off the ordered commits
        this.sync();
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  /** Arena entry (ADR-0028): join a pre-allocated match whose tunnel the fleet already created +
   *  funded seat B for. This seat (always A) deposits nothing (batched by the caller's `enterArena` /
   *  `playArena`, one wallet popup). `userPlacements` (arena Play from the placement board) is the
   *  fleet the user placed — they play it manually; when absent (store-consumer auto-enter) a random
   *  fleet is generated on AUTOPILOT (they can toggle Auto off). No "ready" wait: the bot enters its
   *  loop the instant its tunnel opens and the relay buffers our first frame. `eph` is the SAME
   *  per-game key baked into the tunnel at allocate (a different key rejects every co-signature). */
  enterArenaMatch = (
    allocation: ArenaAllocation,
    eph: KeyPair,
    userPlacements?: Placement[],
  ) => {
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
    // User-placed fleet ⇒ play it (Auto per the sticky pref, OFF on a fresh load). No placement ⇒
    // auto-place a random fleet and turn autopilot ON so the window comes alive without ship placement.
    const placements = userPlacements ?? placeFleetRandom(Math.random);
    this.placements = placements;
    const secret = makeFleetSecret(
      placementsToBoard(placements),
      randomSalts(),
    );
    this.secret = secret;
    this.auto = userPlacements ? defaultAuto("battleship") : true;

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
        // Join the ONE pre-allocated match (role A); the fleet bound the bot as seat B at allocate.
        const match = await mp.joinMatch(allocation.matchId);
        this.role = match.role;
        this.opponentWallet = match.opponentWallet;
        this.emit();

        const channel = mp.channel(match.matchId);
        const waitPeer = makeInbox(channel);

        channel.sendPeer({
          t: "hello",
          ephemeralPubkey: toHex(ephemeral.publicKey),
        });
        const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
        const oppPub = fromHex(hello.ephemeralPubkey);

        // Seat A was deposited by the batched `enterArena` PTB and seat B by the fleet at allocate —
        // the tunnel is live, so build the engine over the pre-created tunnelId (no funding here).
        const proto = new BattleshipProtocol(STAKE_SHIFT);
        const backend = defaultBackend();
        const self = makeEndpoint(backend, wallet, ephemeral, true);
        const opp = makeEndpoint(
          backend,
          match.opponentWallet,
          { publicKey: oppPub, scheme: ephemeral.scheme },
          false,
        );
        const dt = new DistributedTunnel<BattleshipState, BattleshipMove>(
          proto,
          {
            tunnelId: allocation.tunnelId,
            self,
            opponent: opp,
            selfParty: match.role,
            moveCodec: battleshipMoveCodec,
          },
          channel.transport,
          { a: STAKE_BALANCE, b: STAKE_BALANCE },
        );
        this.dt = dt;
        this.activateSession(mp, channel, dt, waitPeer, {
          matchId: match.matchId,
          role: match.role,
          opponentWallet: match.opponentWallet,
          opponentPubkeyHex: toHex(oppPub),
          selfEphemeralSecretHex: toHex(ephemeral.secretKey),
        });

        // No "ready" handshake with the fleet bot — kick the ordered commits immediately.
        proposeDue(dt, match.role, secret);
        this.sync();
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  /**
   * On-demand arena entry: the "Play" trigger for a battleship window the connect-time batch didn't
   * allocate. Reserve a bot for battleship + deposit seat A in one wallet popup, then hand off to
   * enterArenaMatch with the fleet the user just placed. Sets `funding` first so the window shows
   * progress instead of a dead placement board.
   */
  playArena = (placements: Placement[]) => {
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

    const stake: StakeStrategy = {
      sponsoredSignExec: deps.sponsoredSignExec as never,
      walletSignExec: deps.signExec as never,
      prepareStake: deps.prepareStake,
      selectStakeCoin: deps.selectStakeCoin,
      ensureStakeBalance: deps.ensureStakeBalance,
    };
    void runArenaPlay({
      arenaGameId: BATTLESHIP_ARENA_GAME_ID,
      wallet,
      stake,
      label: "battleship",
      stakePerGame: STAKE_BALANCE,
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
      enter: (allocation, keypair) =>
        this.enterArenaMatch(allocation, keypair, placements),
    });
  };

  fire = (cell: number) => {
    const dt = this.dt;
    const r = this.role;
    if (!dt || !r) return;
    // `canFireShot` refuses while a proposal still awaits its ACK (`displayState` ahead of `state`):
    // the confirmed state lags an in-flight shoot, so a re-seated pending shoot after cold-load resume
    // would otherwise propose a second one and throw "a proposal is already awaiting ACK".
    if (!canFireShot(dt.state, r, cell, dt.displayState !== dt.state)) return;
    try {
      dt.propose({ type: "shoot", cell }, 0n);
      this.lastYourShot = cell;
      this.sync();
    } catch (e) {
      this.fail(e);
    }
  };
}

const pvpSessions = new Map<string, PvpSession>();

function getPvpSession(windowId: string): PvpSession {
  let session = pvpSessions.get(windowId);
  if (!session) {
    session = new PvpSession();
    pvpSessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "battleship-pvp", () => {
      created.dispose();
      pvpSessions.delete(windowId);
    });
  }
  return session;
}

export function useBattleshipPvp(windowId: string): BattleshipPvp {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();
  const { report } = useTelemetry();

  const session = getPvpSession(windowId);
  session.deps = {
    account,
    client,
    report,
    signExec: (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never,
    // Open/fund routes through the backend gas sponsor (ADR-0009): the settler pays gas, the
    // stake stays the user's own coin. (Close keeps signExec above — it's sponsored via /settle.)
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

  // Centralized batched entry (ADR-0028): the on-connect orchestrator deposited battleship's seat A in
  // the one batched PTB and published {allocation, keypair} to the arena store. Consume it once and
  // auto-enter — the window comes alive (autopilot vs the fleet bot) without a "Find match" click.
  // Only from idle (never clobbers a live/resumed match); `clearArenaEntry` consumes it.
  const arenaEntered = useRef(false);
  useEffect(() => {
    const tryEnter = () =>
      consumeArenaEntry(
        BATTLESHIP_ARENA_GAME_ID,
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
    view: snap.view,
    opponentWallet: snap.opponentWallet,
    error: snap.error,
    findMatch: session.findMatch,
    playArena: session.playArena,
    fire: session.fire,
    auto: snap.auto,
    setAuto: session.setAuto,
    reset: session.reset,
    endMatch: session.endMatch,
  };
}

/**
 * Wait for the co-located bot's settlement half, sign seat A's half over the root the bot supplied,
 * and submit the close via the backend /settle (header-only body; the bot's canonical transcript is
 * archived to S3). The FE keeps NO transcript — every arena match is human-vs-bot, so the bot owns the
 * root and funds ride on the co-signed balances, not the root (see `coSignCloseFromPeerRoot`).
 * Fallback: wallet-submitted close_cooperative_with_root (backend down).
 */
async function settle(
  dt: BattleshipTunnel,
  role: Role,
  waitPeer: <T>(t: string) => Promise<T>,
  reads: Parameters<typeof readCreatedAt>[0],
  signExec: Parameters<typeof closeCooperativeWithRoot>[0]["signExec"],
  // Gas-sponsored signer: the close fallback must use this in MTPS mode, where the player holds
  // 0 SUI and a wallet-signed close would throw and strand the staked MTPS.
  sponsoredSignExec: Parameters<typeof closeCooperativeWithRoot>[0]["signExec"],
  tunnelId: string,
  cp: ReturnType<typeof getControlPlaneClient>,
  coinType: string | undefined,
  // Leaver (Back): the FE has no half to publish (the bot owns the transcript and only settles at its
  // own terminal), so just return — the bot's terminal / on-chain grace is the settlement floor.
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
      "[battleship] backend settle failed; falling back to wallet close:",
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
