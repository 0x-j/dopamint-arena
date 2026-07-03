import { settleViaBackend } from "@/backend/settle";
import { BET_OPTIONS, bjBetMove } from "@/games/blackjack/app/lib/bjBet";
import { getSuiClient } from "@/games/blackjack/app/lib/bjBots";
import { handValue as bjCardsHandValue } from "@/games/blackjack/app/lib/bjCards";
import { getOrCreateEphemeral } from "@/games/blackjack/app/lib/bjPvpIdentity";
import {
  buildCloseWithRootTx,
  buildCreateAndShareTx,
  buildDepositTx,
  parseTunnelId,
} from "@/games/blackjack/app/lib/bjPvpOnchain";
import { makeBlackjackResumeAdapter } from "@/games/blackjack/blackjackResumeAdapter";
import { BlackjackSecretStore } from "@/games/blackjack/blackjackSecretStore";
import {
  consumeArenaEntry,
  subscribeArena,
} from "@/onchain/arenaAllocationStore";
import type { ArenaAllocation } from "@/onchain/arenaEnter";
import {
  MTPS_COIN_TYPE,
  isMtpsAddressBalance,
  isMtpsConfigured,
} from "@/onchain/mtps";
import { withSponsorFallback } from "@/onchain/sponsor";
import {
  raiseDisputeUnilateral,
  submitRebuildingOnStale,
} from "@/onchain/tunnelTx";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { defaultAuto, rememberAuto } from "@/pvp/autoPreference";
import {
  MpClient,
  resolveMpWsUrl,
  type MatchInfo,
  type PeerMessage,
  type PvpChannel,
} from "@/pvp/mpClient";
import {
  clearResumeRecord,
  evictExpiredRecords,
  installResumePersistence,
  readResumeRecord,
  hasResumableMatch,
  flushResumeWrites,
} from "@/pvp/resume";
import { attachResume, resumeActiveTunnels } from "@/pvp/resumeSession";
import { coSignCloseFromPeerRoot } from "@/pvp/settleClose";
import { requestArenaGame } from "@/onchain/arenaLazyEntry";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bytesToHex, core, hexToBytes } from "sui-tunnel-ts";
import type { KeyPair } from "sui-tunnel-ts/core/crypto";
import {
  BlackjackProtocol,
  MIN_BET,
  actorFor,
  getDealerParty,
  getPlayerParty,
  secureCommitMove,
  maxBet as tableMaxBet,
  type BlackjackMove,
  type BlackjackState,
} from "sui-tunnel-ts/protocol/blackjack";
import { blackjackMoveCodec } from "sui-tunnel-ts/protocol/blackjackCodec";
import { runArenaPlay } from "@/onchain/arenaPlay";
import type { StakeStrategy } from "@/onchain/stakeTunnel";

/** Backend arena/`profile_for` id (= the FE registry id; single token, same both ways). Single source
 *  of truth for the arena-store consumer (below) and `GameModule.arenaGameId` (index.ts). */
export const BLACKJACK_ARENA_GAME_ID = "blackjack";

// MP relay base (resolveMpWsUrl appends /v1/mp). Prefer an explicit VITE_MP_URL; otherwise derive
// from the backend base, and when that's empty (same-origin production build) from the page
// origin. Never hardcode localhost — a deployed https site would try ws://127.0.0.1 and fail.
const MP_URL =
  import.meta.env.VITE_MP_URL ||
  (
    import.meta.env.VITE_BACKEND_URL ||
    (typeof location !== "undefined"
      ? location.origin
      : "http://127.0.0.1:8080")
  ).replace(/^http/, "ws");
/** Fixed buy-in (bankroll) deposited on-chain per seat — whole MTPS (0-decimal; ADR-0023), shown
 *  1:1 as chips. Arena play deposits the backend's `allocation.stakeEach` (the single source of
 *  truth); this is the self-play/queue stake and the on-demand back-compat fallback. The bet
 *  protocol caps each round at min(both balances). */
const DEFAULT_STAKE = 100n;
const BOT_MOVE_MS = 700; // player auto-bot move cadence
const NEXT_MS = 900; // pause before auto-dealing the next round
const DEFAULT_BET = Number(MIN_BET); // auto's starting bet until the player picks one

/** Pacing for auto-driven commit/reveal plumbing moves (ms). */
const PLUMBING_MS = 120;
// Flat-out auto pacing: in-match auto moves/rounds fire on the next tick (0ms still defers, so the
// confirmed-update sync runs first); the inter-match requeue keeps a short glimpse. Manual play
// still uses BOT_MOVE_MS / NEXT_MS / PLUMBING_MS above.
const AUTO_MOVE_MS = 0;
const AUTO_REQUEUE_MS = 150;

export type PvpPhase =
  | "idle"
  | "connecting"
  | "queuing"
  | "opening"
  | "funding"
  | "playing"
  | "settling"
  | "done"
  | "error";

export interface RoundResult {
  round: number;
  outcome: "win" | "lose" | "push"; // from the PLAYER's perspective
  playerSum: number;
  dealerSum: number;
}

export interface PvpView {
  phase: PvpPhase;
  error: string | null;
  role: "A" | "B" | null; // A = player (draws), B = dealer (host/auto)
  isDealer: boolean;
  playerHand: number[];
  dealerHand: number[]; // dealer hole card hidden until the dealer's turn / round over
  playerSum: number;
  dealerSum: number;
  balancePlayer: bigint; // balance of the seat currently playing the "Player" role
  balanceDealer: bigint; // balance of the seat currently playing the "Dealer" role
  myBalance: bigint; // my persistent balance
  oppBalance: bigint; // opponent's persistent balance
  round: number;
  gamePhase: "draw_commit" | "draw_reveal" | "player" | "round_over" | null;
  myTurn: boolean; // I'm the player and it's the player's turn (Hit/Stand)
  inRoundOver: boolean; // round resolved — can Next / Stop
  terminal: boolean; // round cap or a side can't fund — forces an auto-settle
  outOfChips: "player" | "dealer" | null; // a side can't cover the minimum bet → forced settle
  currentBet: bigint; // the bet locked for the round in progress (0 between rounds before betting)
  tableMax: bigint; // largest bet both sides can cover this round
  betOptions: number[]; // chip denominations the player may bet now (filtered to ≤ tableMax)
  rounds: RoundResult[];
  auto: boolean;
  walletAddress: string;
  walletBalance: bigint;
  digests: { create?: string; deposit?: string; close?: string };
  fund: () => void;
  queue: () => void;
  /** On-demand arena entry: reserve a server bot for this game and play it now. */
  playArena: () => void;
  hit: () => void;
  stand: () => void;
  bet: (amount: number) => void; // player places the next round's bet (deals the round)
  stop: () => void;
  setAuto: (on: boolean) => void;
  leave: () => void;
}

export function usePvpBlackjack(): PvpView {
  const client = useMemo<SuiJsonRpcClient>(() => getSuiClient(), []);
  const account = useCurrentAccount();
  const walletAddress = account?.address ?? "";
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();
  const proto = useMemo(() => new BlackjackProtocol(), []);

  const [phase, setPhase] = useState<PvpPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"A" | "B" | null>(null);
  const [state, setState] = useState<BlackjackState | null>(null);
  const [rounds, setRounds] = useState<RoundResult[]>([]);
  // Arena games autopilot by default (fallback true) so a resume/reload keeps playing; your
  // explicit toggle still sticks for the session. See autoPreference.
  const [auto, setAutoState] = useState(() => defaultAuto("blackjack", true));
  const [walletBalance, setWalletBalance] = useState<bigint>(0n);
  const [digests, setDigests] = useState<{
    create?: string;
    deposit?: string;
    close?: string;
  }>({});

  const mpRef = useRef<MpClient | null>(null);
  const channelRef = useRef<PvpChannel | null>(null);
  const detachResumeRef = useRef<(() => void) | null>(null);
  const resumeRetryRef = useRef(0);
  const arenaEnteredRef = useRef(false);
  const tunnelRef = useRef<core.DistributedTunnel<
    BlackjackState,
    BlackjackMove
  > | null>(null);
  const roleRef = useRef<"A" | "B" | null>(null);
  // Adopt-proof store for this seat's per-draw commit secret (blackjack keeps it only in state, which
  // a resync adopt wipes) — see blackjackSecretStore.
  const secretStoreRef = useRef<BlackjackSecretStore | null>(null);
  const autoRef = useRef(defaultAuto("blackjack", true));
  // Points at the latest requeue() so finishSettle (defined earlier) can recover on a settle throw.
  const requeueRef = useRef<(() => void) | null>(null);
  const autoKickedRef = useRef(false);
  const lastBetRef = useRef<number>(DEFAULT_BET); // remembered bet for auto rounds; set on every player bet
  const createdAtRef = useRef<bigint>(0n);
  const matchIdRef = useRef<string>("");
  const settledRef = useRef(false);
  const stoppingRef = useRef(false);
  const onMatchRef =
    useRef<(mp: MpClient, m: MatchInfo) => Promise<void>>(undefined);
  const openedResolveRef = useRef<((id: string) => void) | null>(null);
  // The bot (party B) has no on-chain create delay, so its `opened` can arrive BEFORE party A arms
  // its await — buffer it like hello/stake/settle, or the tunnel never builds and every button
  // (manual bet AND auto) silently no-ops on the `!t` guard. (arena_anchor.rs "T14" note.)
  const bufferedOpenedRef = useRef<string | null>(null);
  const settleResolveRef = useRef<
    ((val: { sig: Uint8Array; root: Uint8Array }) => void) | null
  >(null);
  const bufferedSettleRef = useRef<{
    sig: Uint8Array;
    root: Uint8Array;
  } | null>(null);
  const stakeResolveRef = useRef<((amount: bigint) => void) | null>(null);
  const bufferedStakeRef = useRef<bigint | null>(null);
  const helloResolveRef = useRef<((pub: string) => void) | null>(null);
  const bufferedHelloRef = useRef<string | null>(null);

  const refreshBalance = useCallback(async () => {
    try {
      const b = await client.getBalance({ owner: walletAddress });
      setWalletBalance(BigInt(b.totalBalance));
    } catch {
      /* ignore */
    }
  }, [client, walletAddress]);
  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  // Register the pagehide/visibility flush and evict stale resume records once, on mount.
  useEffect(() => {
    installResumePersistence();
    evictExpiredRecords();
  }, []);

  const submit = useCallback(
    async (tx: any) => {
      const { digest } = await signAndExecute({ transaction: tx });
      const res = await client.waitForTransaction({
        digest,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success")
        throw new Error(res.effects?.status?.error ?? "tx failed");
      return res;
    },
    [client, signAndExecute],
  );

  // Sponsored submit (ADR-0009/0010): route the open/deposit tx through the backend gas sponsor —
  // the settler pays gas, the stake stays a MTPS coin. signExec returns only a digest, so we
  // re-read the receipt (object changes + status) for the same downstream handling as `submit`.
  const submitSponsored = useCallback(
    async (tx: any) => {
      const { digest } = await sponsored.signExec(tx);
      const res = await client.waitForTransaction({
        digest,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success")
        throw new Error(res.effects?.status?.error ?? "tx failed");
      return res;
    },
    [client, sponsored],
  );

  const fund = useCallback(() => {
    void (async () => {
      if (!walletAddress) {
        setError("Connect a wallet on the menu first");
        return;
      }
      try {
        const { requestSuiFromFaucetV2, getFaucetHost } =
          await import("@mysten/sui/faucet");
        await requestSuiFromFaucetV2({
          host: getFaucetHost("testnet"),
          recipient: walletAddress,
        });
        for (let i = 0; i < 8; i++) {
          await refreshBalance();
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [walletAddress, refreshBalance]);

  const finishSettle = useCallback(
    async (
      t: core.DistributedTunnel<BlackjackState, BlackjackMove>,
      channel: PvpChannel,
      _matchId: string,
    ) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setPhase("settling");
      // Wait for the co-located bot's settlement half; the FE keeps NO transcript, so we sign seat A's
      // half over the ROOT the bot supplied and submit a header-only body (the bot owns the canonical
      // transcript, archived to S3). Funds ride on the co-signed balances, not the root.
      const other =
        bufferedSettleRef.current ??
        (await new Promise<{ sig: Uint8Array; root: Uint8Array }>((res) => {
          settleResolveRef.current = res;
        }));
      const coSigned = coSignCloseFromPeerRoot(
        t,
        createdAtRef.current,
        other.root,
        other.sig,
      );
      // Single submitter = seat A — unified with every other game and the fleet bot, which co-signs
      // the `settleHalf` and never submits. In the arena the human is always A; the bot (dealer/B)
      // can't submit. Payout is fixed by the co-signed balances regardless of who sends the tx.
      if (roleRef.current === "A") {
        const closeDigest = await settleViaBackend({
          tunnelId: t.tunnelId,
          settlement: coSigned as any,
          transcript: [],
          label: "blackjack",
          fallbackClose: async () => {
            // Wallet-close fallback needs the tunnel's coin type (MTPS when configured); the
            // /settle path above already sponsored the close server-side. In MTPS mode the dealer
            // holds 0 SUI (gas is sponsored), so the close must route through the gas sponsor too — a
            // wallet-signed close would throw and strand the staked MTPS.
            const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
            const res = await (isMtpsConfigured ? submitSponsored : submit)(
              buildCloseWithRootTx(t.tunnelId, coSigned, coinType),
            );
            return res.digest;
          },
        });
        // Record the close + signal the opponent on BOTH paths (backend digest or fallback digest).
        if (closeDigest) {
          setDigests((d) => ({ ...d, close: closeDigest }));
          channel.sendPeer({ t: "closed", digest: closeDigest });
        }
      }
      await refreshBalance();
      // The tunnel is now closed on-chain; its resume record is dead — drop it so it can't be
      // restored and hijack the next match (resumeActiveTunnels would otherwise glue the next
      // queue to this peerless tunnel, leaving moves un-ACKed).
      clearResumeRecord(t.tunnelId);
      setPhase("done");
    },
    [submit, submitSponsored, refreshBalance],
  );

  // Wire the per-round loop + resume onto a freshly built/rebuilt tunnel. Shared by the live
  // (onMatch) and cold-load (queue) paths so both get identical onConfirmed + attachResume wiring.
  const activateSession = useCallback(
    (
      mp: MpClient,
      channel: PvpChannel,
      t: core.DistributedTunnel<BlackjackState, BlackjackMove>,
      info: {
        matchId: string;
        role: "A" | "B";
        opponentWallet: string;
        opponentPubkeyHex: string;
        selfEphemeralSecretHex: string;
      },
    ) => {
      tunnelRef.current = t;
      channelRef.current = channel;
      secretStoreRef.current = new BlackjackSecretStore(info.role);
      // Warm the store from the (possibly cold-load-restored) state so an adopt before the next
      // commit can't lose the in-flight draw secret.
      secretStoreRef.current.own(t.state);
      // Per-round log: record the player's (party A) result's updates.
      let lastLoggedRound = 0;
      // Initialize from the live checkpoint so the first delta is correct for both the live
      // and cold-load paths (a rebuilt tunnel resumes mid-game, not from the starting stake).
      let lastBalanceA = Number(t.state.balanceA);
      const onAdvance = () => {
        const st = t.state;
        // Re-anchor our draw secret into state first: a resync adopt wiped it, but the reveal
        // (`randomMove`) reads it back from state, so restore it from the adopt-proof store.
        secretStoreRef.current?.anchorInto(st);
        setState({ ...st });
        if (st.phase === "round_over" && Number(st.round) > lastLoggedRound) {
          const balA = Number(st.balanceA);
          const delta = balA - lastBalanceA;
          const outcome: RoundResult["outcome"] =
            delta > 0 ? "win" : delta < 0 ? "lose" : "push";
          const rr: RoundResult = {
            round: Number(st.round),
            outcome,
            playerSum: bjCardsHandValue(st.playerHand),
            dealerSum: bjCardsHandValue(st.dealerHand),
          };
          setRounds((prev) => [...prev, rr].slice(-30));
          lastLoggedRound = Number(st.round);
          lastBalanceA = balA;
        }
        if (stoppingRef.current) return; // a stop/settle is in progress
        if (proto.isTerminal(st)) {
          // On a settle throw, don't strand at "settling" — recover into the next match (these
          // arena games self-play); the on-chain grace floor still protects the stake.
          finishSettle(t, channel, info.matchId).catch((e) => {
            console.error("[blackjack pvp] settle failed:", e);
            requeueRef.current?.();
          });
          return;
        }
        const owed = actorFor(st, getPlayerParty); // PvP: default rotation
        if (!owed) return;
        // Plumbing (commit/reveal) is ALWAYS auto-driven by this seat when it owes it.
        if (
          (st.phase === "draw_commit" || st.phase === "draw_reveal") &&
          owed === info.role
        ) {
          // Commit secrets must come from the CSPRNG (salts are revealed publicly).
          const mv =
            st.phase === "draw_commit"
              ? secureCommitMove(core.randomBytes)
              : proto.randomMove(st, info.role, Math.random); // reveal only discloses the stored secret
          if (mv)
            setTimeout(
              () => {
                try {
                  t.propose(mv, BigInt(Date.now()));
                  if (mv.kind === "commit" && mv.localSecret)
                    secretStoreRef.current?.remember(t.state, mv.localSecret);
                } catch {
                  /* in flight */
                }
              },
              autoRef.current ? AUTO_MOVE_MS : PLUMBING_MS,
            );
          return;
        }
        // Bet: only the next player bets; auto reuses the remembered bet.
        if (
          st.phase === "round_over" &&
          owed === info.role &&
          autoRef.current
        ) {
          const mv = bjBetMove(lastBetRef.current ?? Number(MIN_BET), st);
          setTimeout(
            () => {
              try {
                t.propose(mv, BigInt(Date.now()));
              } catch {
                /* raced / in flight */
              }
            },
            autoRef.current ? AUTO_MOVE_MS : NEXT_MS,
          );
          return;
        }
        // Player hit/stand: auto mode lets the bot play this seat.
        if (st.phase === "player" && owed === info.role && autoRef.current) {
          const mv = proto.randomMove(st, info.role, Math.random);
          if (mv)
            setTimeout(
              () => {
                try {
                  t.propose(mv, BigInt(Date.now()));
                } catch {
                  /* not my turn / in flight */
                }
              },
              autoRef.current ? AUTO_MOVE_MS : BOT_MOVE_MS,
            );
        }
      };
      t.onConfirmed = () => {
        onAdvance();
      };
      // Resume wiring: persist on confirm + run the resync handshake on reconnect.
      detachResumeRef.current?.();
      detachResumeRef.current = attachResume({
        mp,
        channel,
        tunnel: t,
        adapter: makeBlackjackResumeAdapter({
          getSecret: () => {
            // Persist from the adopt-proof store, NOT the raw state field: a resync adopt wipes
            // `state.localSecret`, so reading state here records a null secret and a cold-load can't
            // reveal. `own` returns the held draw secret when state was stripped.
            const own = secretStoreRef.current?.own(t.state) ?? null;
            return {
              localSecretA: info.role === "A" ? own : t.state.localSecretA,
              localSecretB: info.role === "B" ? own : t.state.localSecretB,
            };
          },
          setSecret: (sec) => {
            t.state.localSecretA = sec.localSecretA;
            t.state.localSecretB = sec.localSecretB;
          },
          onReconciled: () => onAdvance(),
        }),
        identity: {
          matchId: info.matchId,
          tunnelId: t.tunnelId,
          role: info.role,
          game: "blackjack",
          opponentWallet: info.opponentWallet,
          opponentPubkeyHex: info.opponentPubkeyHex,
          selfEphemeralSecretHex: info.selfEphemeralSecretHex,
        },
        // Settlement floor: after the 1h grace, settle from the held checkpoint.
        onGraceExpired: (latest) => {
          if (latest)
            void raiseDisputeUnilateral({
              signExec: submit,
              tunnelId: t.tunnelId,
              update: latest,
              role: info.role,
            });
        },
      });
      setPhase("playing");
      setState({ ...t.state });
      onAdvance(); // kick off (deal already dealt round 1 -> player phase)
    },
    [proto, submit, finishSettle],
  );

  // Rebuild + attach a persisted in-flight blackjack match on `mp`. Returns true if one was resumed
  // (the caller must NOT quickMatch), false if there was nothing to restore. Shared by the manual
  // queue() (resume-or-quickMatch) and the mount effect (resume-only) so both seat the tunnel
  // identically. Does NOT connect — the caller owns that.
  const tryResume = useCallback(
    (mp: MpClient): boolean => {
      installResumePersistence();
      // The rebuild's `restoreSecret` fires synchronously inside `resumeActiveTunnels`; capture the
      // persisted hidden secret here, then re-inject it into the rebuilt tunnel state below.
      // Explicit annotation keeps TS from narrowing the closure-mutated `let` to `never`.
      let restoredSecret: {
        localSecretA: BlackjackState["localSecretA"];
        localSecretB: BlackjackState["localSecretB"];
      } | null = null;
      const restored = resumeActiveTunnels<BlackjackState, BlackjackMove>(
        mp,
        "blackjack",
        {
          proto,
          moveCodec: blackjackMoveCodec,
          adapter: makeBlackjackResumeAdapter({
            getSecret: () => ({ localSecretA: null, localSecretB: null }),
            setSecret: (sec) => {
              restoredSecret = sec;
            },
            onReconciled: () => {},
          }),
        },
        { selfWallet: walletAddress },
      );
      if (restored.length === 0) return false;
      const { tunnel, channel } = restored[0];
      // Re-inject the restored secret into the rebuilt tunnel state; without this the reveal
      // after resume reads a null secret and stalls.
      const secret = restoredSecret as {
        localSecretA: BlackjackState["localSecretA"];
        localSecretB: BlackjackState["localSecretB"];
      } | null;
      if (secret) {
        tunnel.state.localSecretA = secret.localSecretA;
        tunnel.state.localSecretB = secret.localSecretB;
      }
      const rec = readResumeRecord(tunnel.tunnelId)!;
      matchIdRef.current = rec.matchId;
      roleRef.current = rec.role;
      setRole(rec.role);
      activateSession(mp, channel, tunnel, {
        matchId: rec.matchId,
        role: rec.role,
        opponentWallet: rec.opponentWallet,
        opponentPubkeyHex: rec.opponentPubkeyHex,
        selfEphemeralSecretHex: rec.selfEphemeralSecretHex!,
      });
      return true;
    },
    [walletAddress, proto, activateSession],
  );

  const queue = useCallback(() => {
    void (async () => {
      if (!walletAddress) {
        setError("Connect a wallet on the menu first");
        setPhase("error");
        return;
      }
      setError(null);
      setPhase("connecting");
      settledRef.current = false;
      stoppingRef.current = false;
      setRounds([]);
      autoKickedRef.current = false;
      // Fresh match resets Auto to the session default (ON the first time, else your last toggle).
      autoRef.current = defaultAuto("blackjack", true);
      setAutoState(autoRef.current);
      bufferedSettleRef.current = null;
      bufferedStakeRef.current = null;
      bufferedHelloRef.current = null;
      openedResolveRef.current = null;
      bufferedOpenedRef.current = null;
      settleResolveRef.current = null;
      stakeResolveRef.current = null;
      helloResolveRef.current = null;
      try {
        const connEph = core.generateKeyPair();
        const mp = new MpClient(resolveMpWsUrl(MP_URL), walletAddress, connEph);
        mpRef.current = mp;
        // Cold-load: rebuild any persisted in-flight blackjack match before joining a queue.
        if (tryResume(mp)) {
          try {
            await mp.connect();
          } catch (connErr) {
            // Resume connect failed — commonly a 2nd socket for this wallet racing the relay's
            // routing right after a freeze/reconnect. Preserve the resume record and retry with
            // backoff so the relay can clean up the old session. Only clear after exhausting retries.

            const resumedTid = tunnelRef.current?.tunnelId;
            mp.close();
            mpRef.current = null;
            tunnelRef.current = null;
            const attempt = resumeRetryRef.current;
            if (attempt < 2) {
              resumeRetryRef.current = attempt + 1;
              await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
              queue();
              return;
            }
            resumeRetryRef.current = 0;
            if (resumedTid) clearResumeRecord(resumedTid);

            setPhase("idle");
            arenaEnteredRef.current = false;
            if (walletAddress)
              requestArenaGame(BLACKJACK_ARENA_GAME_ID, walletAddress);
            return;
          }
          // Resume watchdog (mirrors the shared kit's armResumeWatchdog): the auto-kick fires
          // before connect on this path, so if it's our turn the proposal is dropped; and if the
          // co-located bot exited past its grace, nothing re-kicks. Rather than hang at "playing",
          // drop the record and requeue a fresh match. Disarms on the first confirmed frame.
          {
            const resumed = tunnelRef.current;
            if (resumed) {
              let answered = false;
              const prevConfirmed = resumed.onConfirmed;
              resumed.onConfirmed = (u) => {
                answered = true;
                resumed.onConfirmed = prevConfirmed;
                prevConfirmed?.(u);
              };
              setTimeout(() => {
                if (answered || mpRef.current !== mp) return;
                clearResumeRecord(resumed.tunnelId);
                requeueRef.current?.();
              }, 10_000);
            }
          }
          return; // skip quickMatch — continuing an in-flight match
        }
        await mp.connect();
        setPhase("queuing");
        const m = await mp.quickMatch("blackjack");
        await onMatchRef.current?.(mp, m);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [walletAddress, tryResume]);

  // Cold-load entry: on mount (once the wallet is known), rebuild any persisted in-flight blackjack
  // match and jump straight into it — no "Play" click. Resume-only: it never falls through to a fresh
  // quickMatch, so a stale/terminal record just drops back to the menu. Idempotent (no-ops if already
  // connected or nothing to restore); mirrors the arena-entry effect below.
  const resume = useCallback(() => {
    if (mpRef.current) return;
    if (!walletAddress) return;
    if (!hasResumableMatch("blackjack")) return;
    // Route cold-load resume through queue(): its resume branch (tryResume) restores the in-flight
    // match WITH the connect-error recovery + resume watchdog, and a stale/terminal record falls
    // through to a fresh match instead of stranding at the lobby. The hasResumableMatch guard keeps
    // a FRESH load on the arena-entry path (no auto public-queue join).
    queue();
  }, [walletAddress, queue]);
  useEffect(() => {
    resume();
  }, [resume]);

  const onMatch = useCallback(
    async (mp: MpClient, m: MatchInfo) => {
      try {
        matchIdRef.current = m.matchId;
        roleRef.current = m.role;
        setRole(m.role);
        // One channel per match: both the engine transport and the peer side-channel come from it.
        const channel = mp.channel(m.matchId);
        channelRef.current = channel;
        // Peer-channel dispatcher: hello pubkey, opened tunnelId, settle half, stake, closed, stop.
        channel.onPeer((mm: Exclude<PeerMessage, { t: "frame" }>) => {
          if (mm.t === "hello") {
            const pub = String(mm.ephemeralPubkey);
            if (helloResolveRef.current) helloResolveRef.current(pub);
            else bufferedHelloRef.current = pub;
          } else if (mm.t === "opened") {
            const id = String(mm.tunnelId);
            if (openedResolveRef.current) openedResolveRef.current(id);
            else bufferedOpenedRef.current = id;
          } else if (mm.t === "settleHalf") {
            const sig = hexToBytes(String(mm.sig));
            const rt = hexToBytes(String(mm.transcriptRoot));
            if (settleResolveRef.current)
              settleResolveRef.current({ sig, root: rt });
            else bufferedSettleRef.current = { sig, root: rt };
          } else if (mm.t === "stake") {
            const amt = BigInt(Math.floor(Number(mm.amount)));
            if (stakeResolveRef.current) stakeResolveRef.current(amt);
            else bufferedStakeRef.current = amt;
          } else if (mm.t === "closed")
            setDigests((d) => ({ ...d, close: String(mm.digest) }));
          else if (mm.t === "stop") {
            stoppingRef.current = true;
            if (tunnelRef.current)
              void finishSettle(tunnelRef.current, channel, m.matchId);
          }
        });

        // The per-match tunnel signing key is keyed by matchId (NOT the connection key).
        const myEph = await getOrCreateEphemeral(m.matchId);
        // hello carries the single move-signer pubkey (no attestation): buffer races.
        channel.sendPeer({ t: "hello", ephemeralPubkey: myEph.pubkeyHex });
        const oppHello =
          bufferedHelloRef.current ??
          (await new Promise<string>((res) => {
            helloResolveRef.current = res;
          }));
        // Opponent's move-signer pubkey. Their on-chain party is m.opponentWallet (self-asserted
        // in v1); the two are deliberately unrelated keys, so there's no address derivation.
        const oppEphPubkey = hexToBytes(oppHello);

        // Exchange chosen buy-ins so both seats agree on the (possibly asymmetric) starting balances.
        const myStake = DEFAULT_STAKE;
        channel.sendPeer({ t: "stake", amount: Number(myStake) });
        const oppStake =
          bufferedStakeRef.current ??
          (await new Promise<bigint>((res) => {
            stakeResolveRef.current = res;
          }));
        // Party A is always the player, party B the dealer — independent of who deposits which buy-in.
        const stakeA = m.role === "A" ? myStake : oppStake; // player's buy-in
        const stakeB = m.role === "B" ? myStake : oppStake; // dealer's buy-in
        const penalty = stakeA < stakeB ? stakeA : stakeB; // unused on cooperative close; keep ≤ both deposits

        // MTPS path (ADR-0010): open/fund sponsored, staking the faucet token; SUI path keeps a
        // sender-pays fallback. `coinType` also threads into the wallet-close fallback (the backend
        // /settle close is sponsored server-side).
        const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;

        // Roles: A = player (party A), B = dealer (party B). The DEALER (role B) opens the tunnel
        // and registers partyA = the player (the opponent), partyB = the dealer (self).
        let tunnelId: string;
        if (m.role === "B") {
          setPhase("opening");
          const openA = {
            walletAddress: m.opponentWallet,
            ephemeralPubkey: oppEphPubkey,
          }; // partyA = player
          const openB = {
            walletAddress,
            ephemeralPubkey: myEph.coreKey.publicKey,
          }; // partyB = dealer (self)
          // create_and_share carries no coin (penalty is a parameter, deposits come later), so it's
          // identical sponsored or sender-pays — route it sponsored when MTPS for a 0-SUI dealer.
          const res = isMtpsConfigured
            ? await submitSponsored(
                buildCreateAndShareTx(openA, openB, penalty, coinType),
              )
            : await submit(buildCreateAndShareTx(openA, openB, penalty));
          const id = parseTunnelId(res.objectChanges);
          if (!id) throw new Error("no tunnelId");
          tunnelId = id;
          setDigests((d) => ({ ...d, create: res.digest }));
          mp.announceTunnel(m.matchId, tunnelId);
          channel.sendPeer({ t: "opened", tunnelId });
        } else {
          setPhase("opening");
          tunnelId =
            bufferedOpenedRef.current ??
            (await new Promise<string>((resolve) => {
              openedResolveRef.current = resolve;
            }));
        }

        const obj = await client.getObject({
          id: tunnelId,
          options: { showContent: true },
        });
        const fields = (
          obj.data?.content as { fields?: Record<string, unknown> } | undefined
        )?.fields;
        createdAtRef.current = BigInt(
          (fields?.created_at as string | undefined) ?? 0,
        );

        setPhase("funding");
        // MTPS: deposit this seat's buy-in from a faucet-minted MTPS coin, sponsored (the
        // faucet itself needs the sponsor, so no sender-pays fallback). SUI: sponsored stake with a
        // sender-pays fallback (ADR-0009).
        // ADR-0013: withdraw this seat's buy-in from the wallet's address balance (top up first).
        // Retry (rebuild) through checkpoint-settlement lag instead of erroring out.
        if (isMtpsConfigured && isMtpsAddressBalance)
          await sponsored.ensureStakeBalance(myStake);
        const dep = !isMtpsConfigured
          ? await withSponsorFallback(
              async () =>
                submitSponsored(
                  buildDepositTx(tunnelId, myStake, {
                    stakeCoinId: await sponsored.selectStakeCoin(myStake),
                  }),
                ),
              () => submit(buildDepositTx(tunnelId, myStake)),
              "blackjack pvp deposit",
            )
          : isMtpsAddressBalance
            ? await submitRebuildingOnStale(
                () =>
                  buildDepositTx(tunnelId, myStake, {
                    coinType,
                    stakeFromBalance: {
                      amount: myStake,
                      coinType: MTPS_COIN_TYPE,
                    },
                  }),
                submitSponsored,
                "blackjack pvp deposit",
              )
            : await submitSponsored(
                buildDepositTx(tunnelId, myStake, {
                  coinType,
                  stakeCoinId: await sponsored.prepareStake(myStake),
                }),
              );
        setDigests((d) => ({ ...d, deposit: dep.digest }));
        let activated = false;
        for (let i = 0; i < 40; i++) {
          const o = await client.getObject({
            id: tunnelId,
            options: { showContent: true },
          });
          const f = (
            o.data?.content as { fields?: Record<string, unknown> } | undefined
          )?.fields;
          if (
            Number(f?.status ?? 0) >= 1 &&
            BigInt((f?.party_a_deposit as string) ?? 0) > 0n &&
            BigInt((f?.party_b_deposit as string) ?? 0) > 0n
          ) {
            activated = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (!activated)
          throw new Error(
            "tunnel did not activate (opponent may not have funded)",
          );

        const backend = core.defaultBackend();
        const t = new core.DistributedTunnel<BlackjackState, BlackjackMove>(
          proto,
          {
            tunnelId,
            self: core.makeEndpoint(
              backend,
              walletAddress,
              {
                publicKey: myEph.coreKey.publicKey,
                scheme: 0,
                secretKey: myEph.coreKey.secretKey,
              },
              true,
            ),
            opponent: core.makeEndpoint(
              backend,
              m.opponentWallet,
              { publicKey: oppEphPubkey, scheme: 0 },
              false,
            ),
            selfParty: m.role, // A = player, B = dealer
            moveCodec: blackjackMoveCodec,
          },
          channel.transport,
          { a: stakeA, b: stakeB },
        );
        tunnelRef.current = t;

        activateSession(mp, channel, t, {
          matchId: m.matchId,
          role: m.role,
          opponentWallet: m.opponentWallet,
          opponentPubkeyHex: oppHello,
          selfEphemeralSecretHex: bytesToHex(myEph.coreKey.secretKey),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [
      client,
      proto,
      submit,
      submitSponsored,
      sponsored,
      walletAddress,
      finishSettle,
      activateSession,
    ],
  );
  onMatchRef.current = onMatch;

  // Arena entry (ADR-0028): join a pre-allocated match whose tunnel the fleet already created + funded
  // seat B for. This seat is always A (the player); seat A was deposited by the batched `enterArena`
  // PTB, so there is NO create/deposit/stake-exchange here — only the relay + engine wiring over the
  // live tunnel. The bot (seat B = dealer, and the rotated player on alternate rounds) drives its own
  // moves via BlackjackV2Strategy. No "ready" wait: the bot enters its loop the instant its tunnel
  // opens and the relay buffers our first frame. `eph` is the SAME per-game key baked at allocate.
  const enterArenaMatch = useCallback(
    (allocation: ArenaAllocation, eph: KeyPair) => {
      if (!walletAddress) {
        setError("Connect a wallet on the menu first");
        setPhase("error");
        return;
      }
      setError(null);
      setPhase("connecting");
      settledRef.current = false;
      stoppingRef.current = false;
      setRounds([]);
      autoKickedRef.current = false;
      // Arena entry: this seat starts on autopilot vs the fleet bot; the player toggles Auto off to take over.
      autoRef.current = true;
      setAutoState(true);
      bufferedSettleRef.current = null;
      bufferedHelloRef.current = null;
      openedResolveRef.current = null;
      bufferedOpenedRef.current = null;
      settleResolveRef.current = null;
      helloResolveRef.current = null;
      void (async () => {
        try {
          const connEph = core.generateKeyPair();
          const mp = new MpClient(
            resolveMpWsUrl(MP_URL),
            walletAddress,
            connEph,
          );
          mpRef.current = mp;
          installResumePersistence();
          await mp.connect();
          // Join the ONE pre-allocated match (role A); the fleet bound the bot as seat B at allocate.
          const m = await mp.joinMatch(allocation.matchId);
          matchIdRef.current = m.matchId;
          roleRef.current = m.role;
          setRole(m.role);
          const channel = mp.channel(m.matchId);
          channelRef.current = channel;
          channel.onPeer((mm: Exclude<PeerMessage, { t: "frame" }>) => {
            if (mm.t === "hello") {
              const pub = String(mm.ephemeralPubkey);
              if (helloResolveRef.current) helloResolveRef.current(pub);
              else bufferedHelloRef.current = pub;
            } else if (mm.t === "settleHalf") {
              const sig = hexToBytes(String(mm.sig));
              const rt = hexToBytes(String(mm.transcriptRoot));
              if (settleResolveRef.current)
                settleResolveRef.current({ sig, root: rt });
              else bufferedSettleRef.current = { sig, root: rt };
            } else if (mm.t === "closed")
              setDigests((d) => ({ ...d, close: String(mm.digest) }));
            else if (mm.t === "stop") {
              stoppingRef.current = true;
              if (tunnelRef.current)
                void finishSettle(tunnelRef.current, channel, m.matchId);
            }
          });

          // The per-game ephemeral key baked into the tunnel at allocate co-signs every move — using a
          // different key would reject every signature. hello carries it; the bot's was baked as B.
          channel.sendPeer({
            t: "hello",
            ephemeralPubkey: bytesToHex(eph.publicKey),
          });
          const oppHello =
            bufferedHelloRef.current ??
            (await new Promise<string>((res) => {
              helloResolveRef.current = res;
            }));
          const oppEphPubkey = hexToBytes(oppHello);

          // No create/deposit: the fleet pre-created the tunnel + funded seat B, and seat A was funded
          // by the batched `enterArena` PTB. Both seats stake the fixed arena buy-in (allocation).
          const stake = BigInt(allocation.stakeEach);
          // `created_at` is only needed at settle (see finishSettle / leave). Fetching it HERE blocks
          // the tunnel build on a Sui RPC, and under RPC load that stalls the whole match — the bet
          // can never fire because `tunnelRef` never gets set (this is why blackjack "never" started
          // while poker, which reads it lazily, did). Build the engine now; populate created_at in the
          // background below so settle still has it.
          const backend = core.defaultBackend();
          const t = new core.DistributedTunnel<BlackjackState, BlackjackMove>(
            proto,
            {
              tunnelId: allocation.tunnelId,
              self: core.makeEndpoint(
                backend,
                walletAddress,
                {
                  publicKey: eph.publicKey,
                  scheme: 0,
                  secretKey: eph.secretKey,
                },
                true,
              ),
              opponent: core.makeEndpoint(
                backend,
                m.opponentWallet,
                { publicKey: oppEphPubkey, scheme: 0 },
                false,
              ),
              selfParty: m.role, // A = player
              moveCodec: blackjackMoveCodec,
            },
            channel.transport,
            { a: stake, b: stake },
          );
          tunnelRef.current = t;

          activateSession(mp, channel, t, {
            matchId: m.matchId,
            role: m.role,
            opponentWallet: m.opponentWallet,
            opponentPubkeyHex: oppHello,
            selfEphemeralSecretHex: bytesToHex(eph.secretKey),
          });

          // Fetch created_at for settle WITHOUT blocking play (the game is already live above). Settle
          // happens seconds later, so this resolves in time; if the RPC is slow the match still plays.
          void client
            .getObject({
              id: allocation.tunnelId,
              options: { showContent: true },
            })
            .then((obj) => {
              const fields = (
                obj.data?.content as
                  | { fields?: Record<string, unknown> }
                  | undefined
              )?.fields;
              createdAtRef.current = BigInt(
                (fields?.created_at as string | undefined) ?? 0,
              );
            })
            .catch(() => {});
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      })();
    },
    [walletAddress, proto, client, activateSession, finishSettle],
  );

  // On-demand arena entry (ADR-0028): the "Play" trigger for a blackjack window the connect-time batch
  // didn't allocate (opened mid-session, or its entry was consumed/finished). Reserve a bot + deposit
  // seat A in one wallet popup, then hand off to enterArenaMatch — the same path the store-consumer
  // auto-enter uses. Sets `funding` first so the window shows progress instead of a dead lobby.
  const playArena = useCallback(() => {
    void (async () => {
      if (!walletAddress) {
        setError("Connect a wallet on the menu first");
        setPhase("error");
        return;
      }
      const signExec = async (
        tx: Parameters<typeof signAndExecute>[0]["transaction"],
      ) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      };
      const stakeStrategy: StakeStrategy = {
        sponsoredSignExec: sponsored.signExec,
        walletSignExec: signExec as never,
        prepareStake: sponsored.prepareStake,
        selectStakeCoin: sponsored.selectStakeCoin,
        ensureStakeBalance: sponsored.ensureStakeBalance,
      };
      await runArenaPlay({
        arenaGameId: BLACKJACK_ARENA_GAME_ID,
        wallet: walletAddress,
        stake: stakeStrategy,
        label: "blackjack",
        stakePerGame: DEFAULT_STAKE,
        setBusy: () => {
          setError(null);
          setPhase("funding");
        },
        setError: (msg) => {
          setError(msg);
          setPhase("error");
        },
        onCaught: (e) => {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        },
        enter: enterArenaMatch,
      });
    })();
  }, [walletAddress, signAndExecute, sponsored, enterArenaMatch]);

  // Centralized batched entry (ADR-0028): the on-connect orchestrator deposited blackjack's seat A in
  // the one batched PTB and published {allocation, keypair} to the arena store. Consume it once and
  // auto-enter — the window comes alive without a "Find match" click. Only from idle (never clobbers a
  // live/resumed match); `clearArenaEntry` consumes it so a remount can't re-enter a closed match.

  useEffect(() => {
    const tryEnter = () =>
      consumeArenaEntry(
        BLACKJACK_ARENA_GAME_ID,
        arenaEnteredRef,
        () => phase === "idle",
        enterArenaMatch,
      );
    tryEnter();
    return subscribeArena(tryEnter);
  }, [enterArenaMatch, phase]);

  // Player Hit/Stand (only the player, only on the player's turn).
  const proposePlayer = useCallback((action: "hit" | "stand") => {
    const t = tunnelRef.current;
    if (!t) return;
    if (
      roleRef.current !== getPlayerParty(t.state.round) ||
      t.state.phase !== "player" ||
      t.displayState !== t.state // a proposal is already awaiting its ACK (e.g. a re-seated resume move)
    )
      return;
    try {
      t.propose({ kind: action }, BigInt(Date.now()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const hit = useCallback(() => proposePlayer("hit"), [proposePlayer]);
  const stand = useCallback(() => proposePlayer("stand"), [proposePlayer]);

  // Place the bet for the next round (player only; the bet deals the round). round_over, not terminal.
  const bet = useCallback(
    (amount: number) => {
      const t = tunnelRef.current;
      if (!t) return;
      if (
        roleRef.current !== getPlayerParty(t.state.round + 1n) ||
        t.state.phase !== "round_over" ||
        proto.isTerminal(t.state) ||
        t.displayState !== t.state // a proposal is already awaiting its ACK
      )
        return;
      lastBetRef.current = amount; // remember it so auto reuses this stake next round
      try {
        t.propose(bjBetMove(amount, t.state), BigInt(Date.now()));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [proto],
  );

  // Stop & settle the tunnel from a round boundary (either seat). Co-signed; the dealer closes.
  const stop = useCallback(() => {
    const t = tunnelRef.current;
    const channel = channelRef.current;
    if (!t || !channel) return;
    if (t.state.phase !== "round_over") return; // settle cleanly between rounds
    stoppingRef.current = true;
    channel.sendPeer({ t: "stop" });
    void finishSettle(t, channel, matchIdRef.current);
  }, [finishSettle]);

  const setAuto = useCallback(
    (on: boolean) => {
      autoRef.current = on;
      setAutoState(on);
      rememberAuto("blackjack", on);
      const t = tunnelRef.current;
      if (!on || !t || stoppingRef.current || proto.isTerminal(t.state)) return;
      // Resume auto from the current state.
      const st = t.state;
      const owed = actorFor(st, getPlayerParty);
      if (!owed || owed !== roleRef.current) return;
      if (st.phase === "draw_commit" || st.phase === "draw_reveal") {
        // Commit secrets must come from the CSPRNG (salts are revealed publicly).
        const mv =
          st.phase === "draw_commit"
            ? secureCommitMove(core.randomBytes)
            : proto.randomMove(st, roleRef.current, Math.random);
        if (mv)
          setTimeout(() => {
            try {
              t.propose(mv, BigInt(Date.now()));
              if (mv.kind === "commit" && mv.localSecret)
                secretStoreRef.current?.remember(t.state, mv.localSecret);
            } catch {
              /* ignore */
            }
          }, 50);
      } else if (st.phase === "player") {
        const mv = proto.randomMove(st, roleRef.current, Math.random);
        if (mv)
          setTimeout(
            () => {
              try {
                t.propose(mv, BigInt(Date.now()));
              } catch {
                /* ignore */
              }
            },
            autoRef.current ? AUTO_MOVE_MS : BOT_MOVE_MS,
          );
      } else if (st.phase === "round_over") {
        const mv = bjBetMove(lastBetRef.current ?? Number(MIN_BET), st);
        setTimeout(
          () => {
            try {
              t.propose(mv, BigInt(Date.now()));
            } catch {
              /* ignore */
            }
          },
          autoRef.current ? AUTO_MOVE_MS : NEXT_MS,
        );
      }
    },
    [proto],
  );

  // If Auto is enabled when the match becomes playable, kick the resume once (the move loop
  // otherwise only schedules auto AFTER a confirmed move, so the first move needs this). Covers a
  // player who ticks Auto on before play; Auto is OFF by default on a fresh load.
  useEffect(() => {
    if (autoKickedRef.current) return;
    if (phase === "playing" && tunnelRef.current && autoRef.current) {
      autoKickedRef.current = true;
      setAuto(true);
    }
  }, [phase, setAuto]);

  // Auto-settle the moment the table goes terminal — a side can't cover the minimum bet (out of
  // chips) or the round cap is hit. The inline onAdvance check handles the common path; this
  // declarative net also covers cases where it was skipped (a stop already in flight, or the
  // terminal state arriving via a resume rather than a fresh confirmed move). settledRef makes
  // the call idempotent, so it never double-settles.
  useEffect(() => {
    if (phase !== "playing" || stoppingRef.current || settledRef.current)
      return;
    const t = tunnelRef.current;
    const ch = channelRef.current;
    if (!t || !ch || !proto.isTerminal(t.state)) return;
    void finishSettle(t, ch, matchIdRef.current);
  }, [phase, state, proto, finishSettle]);

  const leave = useCallback(() => {
    // Back: abandon this match and return to the lobby. The FE has no half to publish (the bot owns
    // the transcript and only settles at its own terminal), so leaving relies on the bot's terminal /
    // the 1h on-chain grace as the settlement floor rather than pushing a co-signed half.
    detachResumeRef.current?.();
    detachResumeRef.current = null;
    // Explicit leave = abandon this match: drop its resume record so it can't hijack the next
    // PvP entry (resumeActiveTunnels would otherwise restore this now-peerless tunnel and skip
    // matchmaking). Reconnect-after-reload never calls leave, so legitimate resume still works.
    const tid = tunnelRef.current?.tunnelId;
    if (tid) clearResumeRecord(tid);
    mpRef.current?.close();
    mpRef.current = null;
    channelRef.current = null;
    tunnelRef.current = null;
    setPhase("idle");
    setState(null);
    setRole(null);
    setDigests({});
    setRounds([]);
    settledRef.current = false;
    stoppingRef.current = false;
    autoKickedRef.current = false;
    autoRef.current = defaultAuto("blackjack", true);
    setAutoState(autoRef.current);
    openedResolveRef.current = null;
    bufferedOpenedRef.current = null;
    settleResolveRef.current = null;
    bufferedSettleRef.current = null;
    stakeResolveRef.current = null;
    bufferedStakeRef.current = null;
    helloResolveRef.current = null;
    bufferedHelloRef.current = null;
  }, []);

  // Find a new match after a settle, reusing the SAME socket (the relay runs many matches per
  // connection): release the settled match and re-quickMatch in place — keeping Auto on so the
  // next match auto-plays (DEFAULT_STAKE carries over). Falls back to a full
  // queue() if the socket is gone.
  const requeue = useCallback(() => {
    const mp = mpRef.current;
    if (!mp) {
      queue();
      return;
    }
    detachResumeRef.current?.();
    detachResumeRef.current = null;
    const tid = tunnelRef.current?.tunnelId;
    if (tid) clearResumeRecord(tid); // closed tunnel: never restore it
    if (matchIdRef.current) mp.releaseMatch(matchIdRef.current);
    channelRef.current = null;
    tunnelRef.current = null;
    setState(null);
    setRole(null);
    setDigests({});
    setRounds([]);
    settledRef.current = false;
    stoppingRef.current = false;
    autoKickedRef.current = false;
    openedResolveRef.current = null;
    bufferedOpenedRef.current = null;
    settleResolveRef.current = null;
    bufferedSettleRef.current = null;
    stakeResolveRef.current = null;
    bufferedStakeRef.current = null;
    helloResolveRef.current = null;
    bufferedHelloRef.current = null;
    setError(null);
    // Keep Auto + the open socket; just join the queue again.
    setPhase("queuing");
    void (async () => {
      try {
        const m = await mp.quickMatch("blackjack");
        await onMatchRef.current?.(mp, m);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [queue]);

  useEffect(() => {
    requeueRef.current = requeue;
  }, [requeue]);

  // After a match settles ("done"), always auto-find the next match — these are self-playing
  // arena games (parity with poker); an explicit Leave() → "idle" stops the loop. Auto only
  // governs whether the bot or you plays, not whether one is found. A short pause lets the result
  // show before re-queuing.
  useEffect(() => {
    if (phase !== "done") return;
    const id = setTimeout(() => requeue(), AUTO_REQUEUE_MS);
    return () => clearTimeout(id);
  }, [phase, requeue]);

  useEffect(
    () => () => {
      flushResumeWrites();
      detachResumeRef.current?.();
      mpRef.current?.close();
    },
    [],
  );

  const s = state;
  const isDealer = s
    ? roleRef.current ===
      getDealerParty(s.phase === "round_over" ? s.round + 1n : s.round)
    : roleRef.current === "B";
  const gamePhase = s ? s.phase : null;
  const playerHand = s ? s.playerHand : [];
  // Hide the dealer's hole card during the player's turn (revealed once the dealer acts / round ends).
  const dealerHand = s
    ? s.phase === "player"
      ? s.dealerHand.slice(0, 1)
      : s.dealerHand
    : [];
  const terminal = s ? proto.isTerminal(s) : false;
  const myTurn =
    !!s && s.phase === "player" && roleRef.current === getPlayerParty(s.round);
  const inRoundOver = !!s && s.phase === "round_over";
  // Which side (if any) can no longer cover even the minimum bet — this forces the auto-settle.
  const outOfChips: "player" | "dealer" | null = s
    ? s.balanceA < MIN_BET
      ? "player"
      : s.balanceB < MIN_BET
        ? "dealer"
        : null
    : null;
  // Bet controls: the table max is the poorer side's balance; offer chip buttons that fit.
  const tableMax = s ? tableMaxBet(s) : 0n;
  const betOptions = BET_OPTIONS.filter((v) => BigInt(v) <= tableMax);
  const currentBet = s ? s.bet : 0n;

  return {
    phase,
    error,
    role,
    isDealer,
    playerHand,
    dealerHand,
    playerSum: bjCardsHandValue(playerHand),
    dealerSum:
      s && s.phase !== "player"
        ? bjCardsHandValue(s.dealerHand)
        : bjCardsHandValue(dealerHand),
    balancePlayer: s
      ? getPlayerParty(s.round || 1n) === "A"
        ? s.balanceA
        : s.balanceB
      : 0n,
    balanceDealer: s
      ? getDealerParty(s.round || 1n) === "A"
        ? s.balanceA
        : s.balanceB
      : 0n,
    myBalance: s ? (roleRef.current === "A" ? s.balanceA : s.balanceB) : 0n,
    oppBalance: s ? (roleRef.current === "A" ? s.balanceB : s.balanceA) : 0n,
    round: s ? Number(s.round) : 0,
    gamePhase,
    myTurn,
    inRoundOver,
    terminal,
    outOfChips,
    currentBet,
    tableMax,
    betOptions,
    rounds,
    auto,
    walletAddress,
    walletBalance,
    digests,
    fund,
    queue,
    playArena,
    hit,
    stand,
    bet,
    stop,
    setAuto,
    leave,
  };
}
