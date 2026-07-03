// frontend/src/games/ticTacToe/packages/client/src/hooks/usePvpTicTacToe.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  core,
  bytesToHex,
  hexToBytes,
  generateSalt,
  type protocols,
} from "sui-tunnel-ts";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { settleViaBackend } from "@/backend/settle";
import { defaultAuto, rememberAuto } from "@/pvp/autoPreference";
import { coSignCloseFromPeerRoot } from "@/pvp/settleClose";
import {
  MultiGameTicTacToeProtocol,
  MultiGameCaroProtocol,
  tttMoveCodec,
  caroMoveCodec,
  optimalMoves,
  CELL_EMPTY,
  CELL_SERVER,
  CELL_PLAYER,
  pickCaroMove,
} from "@ttt/shared";
import { getSuiClient } from "@/games/ticTacToe/app/lib/bots";
import {
  getOrCreateEphemeral,
  balanceOf,
  type PvpEphemeral,
} from "@/games/ticTacToe/app/lib/pvpIdentity";
import { useCustomWallet } from "@/games/ticTacToe/app/contexts/CustomWallet";
import {
  buildCreateAndShareTx,
  buildDepositTx,
  buildCloseWithRootTx,
  parseTunnelId,
} from "@/games/ticTacToe/app/lib/pvpOnchain";
import {
  MpClient,
  resolveMpWsUrl,
  type MatchInfo,
  type PeerMessage,
  type PvpChannel,
} from "@/pvp/mpClient";
import { attachResume, resumeActiveTunnels } from "@/pvp/resumeSession";
import { RESUME_WATCHDOG_MS } from "@/pvp/resumeWatchdog";
import {
  raiseDisputeUnilateral,
  submitRebuildingOnStale,
} from "@/onchain/tunnelTx";
import {
  installResumePersistence,
  evictExpiredRecords,
  readResumeRecord,
  clearResumeRecord,
  hasResumableMatch,
  flushResumeWrites,
} from "@/pvp/resume";
import { makeTttResumeAdapter } from "@/games/ticTacToe/app/lib/tttResumeAdapter";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { withSponsorFallback } from "@/onchain/sponsor";
import {
  MTPS_COIN_TYPE,
  isMtpsAddressBalance,
  isMtpsConfigured,
} from "@/onchain/mtps";
import type { KeyPair } from "sui-tunnel-ts/core/crypto";
import type { ArenaAllocation } from "@/onchain/arenaEnter";
import {
  consumeArenaEntry,
  subscribeArena,
} from "@/onchain/arenaAllocationStore";
import { requestArenaGame } from "@/onchain/arenaLazyEntry";
import { runArenaPlay } from "@/onchain/arenaPlay";
import type { StakeStrategy } from "@/onchain/stakeTunnel";

export type Variant = "ttt" | "caro";

/** Backend arena/`profile_for` ids for the two variants this hook drives. Single source of truth for
 *  the arena-store consumer (below) and each variant's `GameModule.arenaGameId`. */
export const TIC_TAC_TOE_ARENA_GAME_ID = "tic_tac_toe";
export const CARO_ARENA_GAME_ID = "caro";
/** This hook instance's arena id, by variant. */
function arenaGameIdFor(variant: Variant): string {
  return variant === "caro" ? CARO_ARENA_GAME_ID : TIC_TAC_TOE_ARENA_GAME_ID;
}

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
// Per-seat deposit and per-game stake, mode-scaled. In MTPS mode (production path) both are
// 1 MTPS (0 decimals; ADR-0023), so an abandoner forfeits exactly one deposit. In the SUI dev
// fallback the per-game stake (SUI_PER_SEAT = 1 MIST) is much smaller than the deposited bankroll.
const MTPS_PER_SEAT = 1n;
const SUI_PER_SEAT = 1n;
const BANKROLL = 1000n; // SUI-fallback MIST deposited per seat
// MTPS mode (ADR-0023): bankroll deposited per seat — 1 MTPS (0 decimals → whole token).
const MTPS_BANKROLL = 1n;
// One game per tunnel: the match settles on-chain as soon as the game is decided (the winner
// submits the close — see finishSettle), then players re-queue for the next game. A higher cap
// would batch many games into a single end-of-session settle instead.
const MAX_GAMES = 1;
// Flat-out auto pacing: propose the next move/advance on the next tick (a 0ms setTimeout still
// defers, which breaks re-entrant propose and lets the confirmed-update sync run first).
const AUTO_MOVE_MS = 0;
const NEXT_MS = 150; // pause before auto-requeuing the next match (flat-out: just enough to glimpse)
// Settle: we wait for the co-located bot's half (the bot owns the transcript and sends its half
// unconditionally at its terminal). Give up after this timeout so a truly lost peer recovers (auto
// re-queues) instead of stranding the table forever.
const SETTLE_TIMEOUT_MS = 12000;

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

export interface GameResult {
  game: number;
  winner: 1 | 2 | 3;
} // 1 X, 2 O, 3 draw

// Minimal shared shape of both multi-game states (caro adds size/lastMove).
type InnerState = {
  board: number[];
  turn: "A" | "B";
  winner: number;
  balanceA: bigint;
  balanceB: bigint;
  size?: number;
  lastMove?: number;
};
type AnyState = { inner: InnerState; gamesPlayed: number; maxGames: number };
type CellMove = { cell: number; salt: Uint8Array };

export interface PvpTttView {
  phase: PvpPhase;
  error: string | null;
  role: "A" | "B" | null; // A = X (opener), B = O
  variant: Variant;
  board: number[];
  size: number;
  lastMove: number;
  turn: "A" | "B" | null;
  winner: number; // current game: 0 none | 1 X | 2 O | 3 draw
  myMark: 0 | 1 | 2; // 1 if I'm X, 2 if I'm O
  isMyTurn: boolean;
  innerOver: boolean; // current game finished (between games)
  terminal: boolean; // session terminal → auto-settle
  score: { x: number; o: number; draws: number };
  games: GameResult[];
  currentGame: number; // gamesPlayed + 1
  auto: boolean;
  address: string; // the connected zkLogin wallet (this seat's on-chain party)
  balance: bigint; // the connected wallet's SUI balance (MIST)
  digests: { create?: string; deposit?: string; close?: string };
  queue: () => void;
  /** On-demand arena entry: reserve a server bot for this variant and play it now. */
  playArena: () => void;
  play: (cell: number) => void;
  next: () => void;
  stop: () => void;
  setAuto: (on: boolean) => void;
  leave: () => void;
  /** After a per-game settle: clear the closed match + resume record and find a new match. */
  requeue: () => void;
}

// Perfect 3×3 move via @ttt/shared minimax (maps protocol marks 1/2 to CELL_SERVER/CELL_PLAYER).
function tttBestCell(inner: InnerState, by: "A" | "B"): number {
  const mark = by === "A" ? 1 : 2;
  const board = inner.board.map((v) =>
    v === 0 ? CELL_EMPTY : v === mark ? CELL_SERVER : CELL_PLAYER,
  );
  return optimalMoves(board, CELL_SERVER)[0];
}

export function usePvpTicTacToe(
  variant: Variant,
  boardSize: number,
): PvpTttView {
  const client = useMemo<SuiJsonRpcClient>(() => getSuiClient(), []);
  const eph = useMemo<PvpEphemeral>(() => getOrCreateEphemeral(), []);
  const wallet = useCustomWallet();
  const walletRef = useRef(wallet);
  walletRef.current = wallet; // read the latest wallet inside stable callbacks without re-creating them
  // Backend gas sponsor (ADR-0009/0010): open + deposit route through the settler so a 0-SUI
  // zkLogin player stakes faucet-minted MTPS and pays no gas. Read inside stable callbacks
  // via a ref. (The close stays sender-pays as a fallback to the backend /settle route.)
  const sponsored = useSponsoredSignExec();
  const sponsoredRef = useRef(sponsored);
  sponsoredRef.current = sponsored;
  // Stake magnitude matches the per-seat deposit: one loss = one deposit shift.
  const scaledStake = isMtpsConfigured ? MTPS_PER_SEAT : SUI_PER_SEAT;
  const proto = useMemo(
    () =>
      (variant === "caro"
        ? new MultiGameCaroProtocol(MAX_GAMES, boardSize, scaledStake)
        : new MultiGameTicTacToeProtocol(
            MAX_GAMES,
            scaledStake,
          )) as unknown as protocols.Protocol<AnyState, CellMove>,
    // isMtpsConfigured is a build-time constant (evaluated once at bundle load), so scaledStake
    // is fixed for the lifetime of the app and never changes across renders — safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [variant, boardSize],
  );

  const [phase, setPhase] = useState<PvpPhase>("idle");
  // Latest phase, readable inside stable callbacks (the arena-store subscriber) without stale closures.
  const phaseRef = useRef<PvpPhase>("idle");
  phaseRef.current = phase;
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"A" | "B" | null>(null);
  const [state, setState] = useState<AnyState | null>(null);
  const [games, setGames] = useState<GameResult[]>([]);
  // `score` is the authoritative cumulative tally; `games` below is capped at the last 50 entries
  // for display, so after 50 games the two intentionally diverge — do NOT re-derive score from games.
  const [score, setScore] = useState({ x: 0, o: 0, draws: 0 });
  // Arena games autopilot by default (fallback true) so a resume/reload keeps playing; your
  // explicit toggle still sticks for the session. See autoPreference.
  const [auto, setAutoState] = useState(() => defaultAuto(variant, true));
  const [balance, setBalance] = useState<bigint>(0n);
  const [digests, setDigests] = useState<{
    create?: string;
    deposit?: string;
    close?: string;
  }>({});

  const mpRef = useRef<MpClient | null>(null);
  const channelRef = useRef<PvpChannel | null>(null);
  const resumeRetryRef = useRef(0);
  const tunnelRef = useRef<core.DistributedTunnel<AnyState, CellMove> | null>(
    null,
  );
  const roleRef = useRef<"A" | "B" | null>(null);
  const autoRef = useRef(defaultAuto(variant, true));
  const autoKickedRef = useRef(false);
  const arenaEnteredRef = useRef(false);
  const detachResumeRef = useRef<(() => void) | null>(null);
  const createdAtRef = useRef<bigint>(0n);
  const matchIdRef = useRef<string>("");
  const settledRef = useRef(false);
  const stoppingRef = useRef(false);
  const onMatchRef = useRef<
    ((mp: MpClient, m: MatchInfo) => Promise<void>) | undefined
  >(undefined);
  // Latest `requeue`, called from finishSettle's recovery path (defined later — use a ref to dodge
  // the declaration-order / dependency cycle, mirroring onMatchRef).
  const requeueRef = useRef<(() => void) | null>(null);
  const openedResolveRef = useRef<((id: string) => void) | null>(null);
  const settleResolveRef = useRef<
    ((val: { sig: Uint8Array; root: Uint8Array }) => void) | null
  >(null);
  const bufferedSettleRef = useRef<{
    sig: Uint8Array;
    root: Uint8Array;
  } | null>(null);
  const helloResolveRef = useRef<((pub: string) => void) | null>(null);
  const bufferedHelloRef = useRef<string | null>(null);

  const refreshBalance = useCallback(async () => {
    const addr = walletRef.current.address;
    setBalance(addr ? await balanceOf(client, addr) : 0n);
  }, [client]);
  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance, wallet.address]);

  // The connected zkLogin wallet signs + pays gas (sender-pays, no Enoki sponsorship) so the
  // deposit splits from the wallet's own coin. We then fetch the tx for objectChanges/effects.
  const submit = useCallback(
    async (tx: any) => {
      const digest = await walletRef.current.executeTransaction({ tx });
      const res = await client.getTransactionBlock({
        digest,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success")
        throw new Error(res.effects?.status?.error ?? "tx failed");
      return res;
    },
    [client],
  );

  // Gas-sponsored submit (ADR-0009): the settler wraps the tx in its own SIP-58 gas, the wallet
  // co-signs, both are submitted — so a 0-SUI player pays nothing. The sponsored signExec returns
  // only a digest, so (as in the bot flows) we fetch the block separately for objectChanges.
  const submitSponsored = useCallback(
    async (tx: any) => {
      const { digest } = await sponsoredRef.current.signExec(tx);
      await client.waitForTransaction({ digest });
      const res = await client.getTransactionBlock({
        digest,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success")
        throw new Error(res.effects?.status?.error ?? "tx failed");
      return res;
    },
    [client],
  );

  const finishSettle = useCallback(
    async (
      t: core.DistributedTunnel<AnyState, CellMove>,
      channel: PvpChannel,
      _matchId: string,
    ) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setPhase("settling");
      try {
        // Wait for the co-located bot's half. The FE keeps NO transcript, so we sign seat A's half
        // over the ROOT the bot supplied and submit a header-only body (the bot owns the canonical
        // transcript, archived to S3). Reject after SETTLE_TIMEOUT_MS so the catch below can recover
        // (auto re-queues) instead of stranding "settling" on a lost peer.
        const other =
          bufferedSettleRef.current ??
          (await new Promise<{ sig: Uint8Array; root: Uint8Array }>(
            (resolve, reject) => {
              const to = setTimeout(() => {
                settleResolveRef.current = null;
                reject(new Error("settle handshake timed out"));
              }, SETTLE_TIMEOUT_MS);
              settleResolveRef.current = (v) => {
                clearTimeout(to);
                resolve(v);
              };
            },
          ));
        bufferedSettleRef.current = null;
        const coSigned = coSignCloseFromPeerRoot(
          t,
          createdAtRef.current,
          other.root,
          other.sig,
        );
        // Single submitter = seat A — unified with every other game and the fleet bot, which
        // co-signs the `settleHalf` and never submits the close itself. The payout is fixed by the
        // co-signed balances regardless of which seat sends the backend tx.
        if (roleRef.current === "A") {
          const closeDigest = await settleViaBackend({
            tunnelId: t.tunnelId,
            settlement: coSigned as any,
            transcript: [],
            label: "tictactoe",
            fallbackClose: async () => {
              // Close pays in the same coin the tunnel was funded in (MTPS vs SUI). In MTPS
              // mode the player holds 0 SUI (gas is sponsored), so the close must route through the
              // gas sponsor too — a wallet-signed close would throw and strand the staked MTPS.
              const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
              const res = await (isMtpsConfigured ? submitSponsored : submit)(
                buildCloseWithRootTx(t.tunnelId, coSigned, coinType),
              );
              return res.digest;
            },
          });
          // Record the close + signal the opponent on BOTH paths (backend digest or fallback).
          if (closeDigest) {
            setDigests((d) => ({ ...d, close: closeDigest }));
            channel.sendPeer({ t: "closed", digest: closeDigest });
          }
        }
        await refreshBalance();
        // The tunnel is now closed on-chain (per-game match). Drop its resume record so it can't be
        // restored and hijack the next match (the auto-requeue / Find New Match both re-queue).
        clearResumeRecord(t.tunnelId);
        setPhase("done");
      } catch (e) {
        // Settle handshake/close failed (dropped peer half, root mismatch, close error). Don't
        // strand the table at "settling": in auto, abandon this game and find a new match (the
        // on-chain 1h grace floor still protects the stake); manual surfaces it so the player can
        // Leave / retry.
        console.error("[ttt pvp] settle failed:", e);
        settledRef.current = false;
        settleResolveRef.current = null;
        if (autoRef.current) {
          requeueRef.current?.();
        } else {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      }
    },
    [submit, submitSponsored, refreshBalance],
  );

  // Wire the per-move loop + resume onto a freshly built/rebuilt tunnel. Shared by the live
  // (onMatch) and cold-load (queue) paths so both get identical onConfirmed + attachResume wiring.
  const activateTttSession = useCallback(
    (
      mp: MpClient,
      channel: PvpChannel,
      t: core.DistributedTunnel<AnyState, CellMove>,
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
      // Single source of the seat role for BOTH the match and resume paths. The resume path
      // (reconnect / reload of an active match) skips onMatch, so without setting it here roleRef
      // stays null → myMark 0 → the view shows "◯ (O)" for both seats. A = X, B = O.
      roleRef.current = info.role;
      setRole(info.role);
      let lastLoggedGame = 0;
      const onAdvance = () => {
        const st = t.state;
        setState({ ...st, inner: { ...st.inner } });
        // Log each completed game once (winner is set on the inner game just before the advance).
        const gameNo = st.gamesPlayed + 1;
        if (st.inner.winner !== 0 && gameNo > lastLoggedGame) {
          const w = st.inner.winner as 1 | 2 | 3;
          setGames((prev) => [...prev, { game: gameNo, winner: w }].slice(-50));
          setScore((prev) => ({
            x: prev.x + (w === 1 ? 1 : 0),
            o: prev.o + (w === 2 ? 1 : 0),
            draws: prev.draws + (w === 3 ? 1 : 0),
          }));
          lastLoggedGame = gameNo;
        }
        if (stoppingRef.current) return;
        if (proto.isTerminal(st)) {
          void finishSettle(t, channel, info.matchId);
          return;
        }
        if (st.inner.winner !== 0) {
          // Between games: only X (A) drives the advance (avoids a double-advance race).
          if (info.role === "A" && autoRef.current)
            setTimeout(() => {
              try {
                t.propose(
                  { cell: 0, salt: generateSalt(16) },
                  BigInt(Date.now()),
                );
              } catch {
                /* raced */
              }
            }, AUTO_MOVE_MS);
        } else if (st.inner.turn === info.role && autoRef.current) {
          const cell = (() => {
            const empties = st.inner.board
              .map((v, i) => (v === 0 ? i : -1))
              .filter((i) => i >= 0);
            return empties[Math.floor(Math.random() * empties.length)];
          })();
          setTimeout(() => {
            try {
              t.propose({ cell, salt: generateSalt(16) }, BigInt(Date.now()));
            } catch {
              /* not my turn / in flight */
            }
          }, AUTO_MOVE_MS);
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
        adapter: makeTttResumeAdapter<AnyState, CellMove>(() => onAdvance()),
        identity: {
          matchId: info.matchId,
          tunnelId: t.tunnelId,
          role: info.role,
          game: variant,
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
      setState({ ...t.state, inner: { ...t.state.inner } });
      onAdvance();
    },
    [proto, submit, variant, finishSettle],
  );

  // Rebuild + attach a persisted in-flight match for this variant on `mp`. Returns true if one was
  // resumed (the caller must NOT quickMatch), false if there was nothing to restore. Shared by the
  // manual queue() (resume-or-quickMatch) and the mount effect (resume-only) so both seat the tunnel
  // identically. Does NOT connect — the caller owns that.
  const tryResume = useCallback(
    (mp: MpClient): boolean => {
      const selfWallet = walletRef.current.address;
      if (!selfWallet) {
        return false;
      }
      installResumePersistence();
      const restored = resumeActiveTunnels<AnyState, CellMove>(
        mp,
        variant,
        {
          proto,
          adapter: makeTttResumeAdapter<AnyState, CellMove>(() => {}),
          // Mirror onMatch: without the variant codec the resumed tunnel falls back to
          // identityMoveCodec, which cannot encode the Uint8Array salt — a reloaded
          // staked match would then stall on the first move.
          moveCodec:
            variant === "caro"
              ? (caroMoveCodec as never)
              : (tttMoveCodec as never),
        },
        { selfWallet },
      );
      if (restored.length === 0) {
        return false;
      }

      const { tunnel, channel } = restored[0]; // one active match per game in practice
      const rec = readResumeRecord(tunnel.tunnelId)!;
      activateTttSession(mp, channel, tunnel, {
        matchId: rec.matchId,
        role: rec.role,
        opponentWallet: rec.opponentWallet,
        opponentPubkeyHex: rec.opponentPubkeyHex,
        selfEphemeralSecretHex: rec.selfEphemeralSecretHex!,
      });
      // Resume watchdog (like battleship): if `resume.ok` never arrives — the co-located bot exited
      // past its grace, or a cross-instance reconnect the resync can't reach — don't hang on a dead
      // match. Clear the record and return to idle so the user falls through to a fresh game instead
      // of a frozen board.
      let resumed = false;
      const unsubResumeOk = mp.onResumeOk(() => {
        resumed = true;
      });
      setTimeout(() => {
        unsubResumeOk();
        if (!resumed && mpRef.current === mp) {
          clearResumeRecord(tunnel.tunnelId);
          mp.close();
          mpRef.current = null;
          setPhase("idle");
        }
      }, RESUME_WATCHDOG_MS);
      return true;
    },
    [variant, proto, activateTttSession],
  );

  const queue = useCallback(
    (opts?: { keepAuto?: boolean }) => {
      void (async () => {
        const w = walletRef.current;
        if (!w.isConnected || !w.address) {
          setError("Connect your wallet on the main menu first");
          setPhase("error");
          return;
        }
        setError(null);
        setPhase("connecting");
        settledRef.current = false;
        stoppingRef.current = false;
        setGames([]);
        setScore({ x: 0, o: 0, draws: 0 });
        autoKickedRef.current = false;
        // Fresh queue resets Auto to the session default (ON the first time, else your last
        // toggle); auto-requeue passes keepAuto so the Auto loop survives across per-game matches.
        if (!opts?.keepAuto) {
          autoRef.current = defaultAuto(variant, true);
          setAutoState(autoRef.current);
        }
        bufferedSettleRef.current = null;
        bufferedHelloRef.current = null;
        openedResolveRef.current = null;
        settleResolveRef.current = null;
        helloResolveRef.current = null;
        try {
          const mp = new MpClient(
            resolveMpWsUrl(MP_URL),
            w.address,
            eph.coreKey,
          );
          mpRef.current = mp;
          // Cold-load: before joining a queue, rebuild any persisted in-flight match for this
          // variant and re-attach to it. The opening handshake then carries resume{matchId}.
          if (tryResume(mp)) {
            try {
              await mp.connect();
              return; // skip quickMatch — we are continuing an in-flight match
            } catch (connErr) {
              // Resume connect failed — commonly a 2nd socket for this wallet racing the relay's
              // routing right after a freeze/reconnect closed the old one. Don't nuke the resume
              // record on the first failure: close the raced socket, wait for the relay to clean up
              // the old session, and retry WITH the record so the next attempt can still resume.
              // Only clear the record after exhausting retries (the match is truly gone).

              const resumedTid = tunnelRef.current?.tunnelId;
              mp.close();
              mpRef.current = null;
              tunnelRef.current = null;
              const attempt = resumeRetryRef.current;
              if (attempt < 2) {
                resumeRetryRef.current = attempt + 1;
                await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
                queue(opts);
                return;
              }
              resumeRetryRef.current = 0;
              // Exhausted retries — the match is unreachable. Clear the stale record, request a
              // fresh arena allocation (the batch already ran and skipped this game), and return to
              // idle so the arena-entry subscriber can pick up the new allocation.
              if (resumedTid) clearResumeRecord(resumedTid);

              setPhase("idle");
              arenaEnteredRef.current = false;
              const w = walletRef.current;
              if (w.address)
                requestArenaGame(arenaGameIdFor(variant), w.address);
              return;
            }
          }
          await mp.connect();
          setPhase("queuing");
          // The queue key encodes the variant (+ board size for caro) so only players who chose the
          // SAME setup match — otherwise the two seats would run incompatible protocols and diverge.
          const m = await mp.quickMatch(
            variant === "caro"
              ? `tictactoe:caro:${boardSize}`
              : "tictactoe:ttt",
          );
          await onMatchRef.current?.(mp, m);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      })();
    },
    [eph, variant, boardSize, tryResume],
  );

  // Cold-load entry: on mount (once the wallet is known), rebuild any persisted in-flight match for
  // this variant and jump straight into it — no "Play" click. Resume-only: it never falls through to
  // a fresh quickMatch, so a stale/terminal record just drops back to the menu. Idempotent (no-ops if
  // already connected or nothing to restore); mirrors the arena-entry effect below.
  const resume = useCallback(() => {
    if (mpRef.current) return;
    const w = walletRef.current;
    const selfWallet = w.address;
    if (!w.isConnected || !selfWallet) return;
    const hasMatch = hasResumableMatch(variant);
    if (!hasMatch) return;
    // Route cold-load resume through queue(): its resume branch (tryResume) restores the in-flight
    // match WITH the connect-error recovery, and a stale/terminal record falls through to a fresh
    // match instead of stranding at the lobby. The hasResumableMatch guard keeps a FRESH load on
    // the arena-entry path (no auto public-queue join).
    queue();
  }, [variant, queue, wallet.address]);
  useEffect(() => {
    resume();
  }, [resume]);

  const onMatch = useCallback(
    async (mp: MpClient, m: MatchInfo) => {
      try {
        const w = walletRef.current;
        if (!w.address) throw new Error("wallet disconnected");
        const selfWallet = w.address; // narrowed (the deferred shareTx closure widens w.address back)
        matchIdRef.current = m.matchId;
        roleRef.current = m.role;
        setRole(m.role);
        // One channel per match: both the engine transport and the peer side-channel come from it.
        const channel = mp.channel(m.matchId);
        channelRef.current = channel;
        // Peer-channel dispatcher: hello pubkey, opened tunnelId, settle half, closed digest, stop.
        channel.onPeer((mm: Exclude<PeerMessage, { t: "frame" }>) => {
          if (mm.t === "hello") {
            const pub = String(mm.ephemeralPubkey);
            if (helloResolveRef.current) helloResolveRef.current(pub);
            else bufferedHelloRef.current = pub;
          } else if (mm.t === "opened")
            openedResolveRef.current?.(String(mm.tunnelId));
          else if (mm.t === "settleHalf") {
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
        // hello carries the single pubkey (no attestation): capture synchronously, buffer races.
        channel.sendPeer({ t: "hello", ephemeralPubkey: eph.pubkeyHex });

        const oppPubHex =
          bufferedHelloRef.current ??
          (await new Promise<string>((res) => {
            helloResolveRef.current = res;
          }));
        // Opponent's move-signer pubkey. Their on-chain party is m.opponentWallet (matchmaker-reported,
        // self-asserted in v1); the two are deliberately unrelated keys, so there's no address derivation.
        const oppPubkey = hexToBytes(oppPubHex);

        // MTPS mode (ADR-0010): stake faucet-minted MTPS with gas sponsored — a 0-SUI
        // player plays free. SUI fallback (env unset): sender-pays SUI stake. The bankroll, coin
        // type, and the off-chain init balances all follow this choice so deposits reconcile.
        const mtpsOn = isMtpsConfigured;
        const coinType = mtpsOn ? MTPS_COIN_TYPE : undefined;
        const bankroll = mtpsOn ? MTPS_BANKROLL : BANKROLL;

        // Roles: A = X (opener), B = O. X opens the tunnel registering partyA = self, partyB = opponent.
        // Party address = the zkLogin wallet (receives funds); party public_key = the ephemeral signer.
        // The share tx carries no stake (each seat deposits its own), so it's gas-sponsored in
        // MTPS mode (with a sender-pays fallback), or plain sender-pays in SUI mode.
        let tunnelId: string;
        if (m.role === "A") {
          setPhase("opening");
          const shareTx = () =>
            buildCreateAndShareTx(
              { walletAddress: selfWallet, publicKey: eph.coreKey.publicKey }, // partyA = X (self)
              { walletAddress: m.opponentWallet, publicKey: oppPubkey }, // partyB = O (opponent)
              // Abandonment penalty = scaledStake (mode-scaled). In MTPS mode this equals the
              // per-seat deposit, so an abandoner forfeits exactly one deposit at force-close (F1).
              // In the SUI dev fallback the stake (1 MIST) is nominal, not deposit-sized.
              scaledStake,
              coinType, // open Tunnel<MTPS> so the seat deposits type-match
            );
          const res = mtpsOn
            ? await withSponsorFallback(
                () => submitSponsored(shareTx()),
                () => submit(shareTx()),
                "tictactoe open",
              )
            : await submit(shareTx());
          const id = parseTunnelId(res.objectChanges);
          if (!id) throw new Error("no tunnelId");
          tunnelId = id;
          setDigests((d) => ({ ...d, create: res.digest }));
          mp.announceTunnel(m.matchId, tunnelId);
          channel.sendPeer({ t: "opened", tunnelId });
        } else {
          setPhase("opening");
          tunnelId = await new Promise<string>((resolve) => {
            openedResolveRef.current = resolve;
          });
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

        // Each seat funds its own deposit. MTPS: split from a faucet-minted coin via the gas
        // sponsor (with a sender-pays SUI fallback); SUI fallback: split from the wallet gas coin.
        setPhase("funding");
        const dep = mtpsOn
          ? await withSponsorFallback(
              async () => {
                // ADR-0013: withdraw this seat's deposit from the wallet's address balance. Retry
                // (rebuild) through checkpoint-settlement lag rather than fall through to the
                // sender-pays branch (which can't help an address-balance stake).
                if (isMtpsAddressBalance) {
                  await sponsoredRef.current.ensureStakeBalance(bankroll);
                  return submitRebuildingOnStale(
                    () =>
                      buildDepositTx(tunnelId, bankroll, {
                        coinType,
                        stakeFromBalance: {
                          amount: bankroll,
                          coinType: MTPS_COIN_TYPE,
                        },
                      }),
                    submitSponsored,
                    "tictactoe deposit",
                  );
                }
                return submitSponsored(
                  buildDepositTx(tunnelId, bankroll, {
                    coinType,
                    stakeCoinId:
                      await sponsoredRef.current.prepareStake(bankroll),
                  }),
                );
              },
              async () =>
                submit(
                  buildDepositTx(tunnelId, bankroll, {
                    stakeCoinId:
                      await sponsoredRef.current.selectStakeCoin(bankroll),
                  }),
                ),
              "tictactoe deposit",
            )
          : await submit(buildDepositTx(tunnelId, bankroll));
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
        const t = new core.DistributedTunnel<AnyState, CellMove>(
          proto,
          {
            tunnelId,
            self: core.makeEndpoint(
              backend,
              w.address,
              {
                publicKey: eph.coreKey.publicKey,
                scheme: 0,
                secretKey: eph.coreKey.secretKey,
              },
              true,
            ),
            opponent: core.makeEndpoint(
              backend,
              m.opponentWallet,
              { publicKey: oppPubkey, scheme: 0 },
              false,
            ),
            selfParty: m.role,
            // Encode salt (Uint8Array) as hex so it survives JSON frame round-trip.
            moveCodec:
              variant === "caro"
                ? (caroMoveCodec as never)
                : (tttMoveCodec as never),
          },
          channel.transport,
          { a: bankroll, b: bankroll },
        );

        activateTttSession(mp, channel, t, {
          matchId: m.matchId,
          role: m.role,
          opponentWallet: m.opponentWallet,
          opponentPubkeyHex: oppPubHex,
          selfEphemeralSecretHex: bytesToHex(eph.coreKey.secretKey),
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
      eph,
      variant,
      finishSettle,
      activateTttSession,
    ],
  );
  onMatchRef.current = onMatch;

  // Arena entry (ADR-0028): join a pre-allocated match whose tunnel the fleet already created + funded
  // seat B for. This seat (always A) deposits nothing (batched by the caller's `enterArena`) and the
  // bot/auto plays it — only the relay + engine are wired over the live tunnel. No "ready" wait: the
  // fleet bot enters its loop the instant its tunnel opens and the relay buffers our first frame.
  // `arenaEph` is the SAME per-game key baked into the tunnel at allocate (a different key rejects every
  // co-signature). Variant-aware: ttt and caro share this hook, picking protocol + moveCodec by variant.
  const enterArenaMatch = useCallback(
    (allocation: ArenaAllocation, arenaEph: KeyPair) => {
      const w = walletRef.current;
      if (!w.address) {
        setError("connect a wallet first");
        setPhase("error");
        return;
      }
      const selfWallet = w.address;
      setError(null);
      setPhase("connecting");
      // Arena entry: this seat starts on autopilot vs the fleet bot; the player toggles Auto off to take over.
      autoRef.current = true;
      setAutoState(true);
      stoppingRef.current = false;
      bufferedHelloRef.current = null;
      bufferedSettleRef.current = null;
      helloResolveRef.current = null;
      settleResolveRef.current = null;
      openedResolveRef.current = null;
      void (async () => {
        try {
          installResumePersistence();
          evictExpiredRecords();
          const mp = new MpClient(resolveMpWsUrl(MP_URL), selfWallet, arenaEph);
          mpRef.current = mp;
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
          channel.sendPeer({
            t: "hello",
            ephemeralPubkey: bytesToHex(arenaEph.publicKey),
          });
          const oppPubHex =
            bufferedHelloRef.current ??
            (await new Promise<string>((res) => {
              helloResolveRef.current = res;
            }));
          const oppPubkey = hexToBytes(oppPubHex);

          // Seat A was deposited by the batched `enterArena` PTB and seat B by the fleet at allocate —
          // the tunnel is live, so build the engine over the pre-created tunnelId (no funding here).
          const obj = await client.getObject({
            id: allocation.tunnelId,
            options: { showContent: true },
          });
          const fields = (
            obj.data?.content as
              | { fields?: Record<string, unknown> }
              | undefined
          )?.fields;
          createdAtRef.current = BigInt(
            (fields?.created_at as string | undefined) ?? 0,
          );
          const bankroll = BigInt(allocation.stakeEach);

          const backend = core.defaultBackend();
          const t = new core.DistributedTunnel<AnyState, CellMove>(
            proto,
            {
              tunnelId: allocation.tunnelId,
              self: core.makeEndpoint(
                backend,
                selfWallet,
                {
                  publicKey: arenaEph.publicKey,
                  scheme: 0,
                  secretKey: arenaEph.secretKey,
                },
                true,
              ),
              opponent: core.makeEndpoint(
                backend,
                m.opponentWallet,
                { publicKey: oppPubkey, scheme: 0 },
                false,
              ),
              selfParty: m.role,
              moveCodec:
                variant === "caro"
                  ? (caroMoveCodec as never)
                  : (tttMoveCodec as never),
            },
            channel.transport,
            { a: bankroll, b: bankroll },
          );
          activateTttSession(mp, channel, t, {
            matchId: m.matchId,
            role: m.role,
            opponentWallet: m.opponentWallet,
            opponentPubkeyHex: oppPubHex,
            selfEphemeralSecretHex: bytesToHex(arenaEph.secretKey),
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      })();
    },
    [client, proto, variant, finishSettle, activateTttSession],
  );
  const enterArenaMatchRef = useRef(enterArenaMatch);
  enterArenaMatchRef.current = enterArenaMatch;

  // On-demand arena entry (ADR-0028): the "Play" trigger for a ttt/caro window the connect-time batch
  // didn't allocate. Reserve a bot for THIS variant + deposit seat A in one wallet popup, then hand off
  // to enterArenaMatch — the same path the store-consumer auto-enter uses. Sets `funding` first so the
  // window shows progress instead of a dead lobby.
  const playArena = useCallback(() => {
    void (async () => {
      const w = walletRef.current;
      if (!w.isConnected || !w.address) {
        setError("Connect your wallet on the main menu first");
        setPhase("error");
        return;
      }
      const walletSignExec = async (tx: never) => {
        const digest = await walletRef.current.executeTransaction({ tx });
        return { digest };
      };
      const stakeStrategy: StakeStrategy = {
        sponsoredSignExec: sponsoredRef.current.signExec,
        walletSignExec: walletSignExec as never,
        prepareStake: sponsoredRef.current.prepareStake,
        selectStakeCoin: sponsoredRef.current.selectStakeCoin,
        ensureStakeBalance: sponsoredRef.current.ensureStakeBalance,
      };
      await runArenaPlay({
        arenaGameId: arenaGameIdFor(variant),
        wallet: w.address,
        stake: stakeStrategy,
        label: variant,
        stakePerGame: scaledStake,
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
  }, [variant, scaledStake, enterArenaMatch]);

  // Centralized batched entry (ADR-0028): the on-connect orchestrator deposited this variant's seat A
  // in the one batched PTB and published {allocation, keypair} to the arena store. Consume it once and
  // auto-enter — the window comes alive without a "Find match" click. Only from idle; `clearArenaEntry`
  // consumes it. Keyed by the variant's arena id (ttt vs caro), so the right window claims the right entry.

  useEffect(() => {
    const arenaId = arenaGameIdFor(variant);
    const tryEnter = () => {
      const isIdle = phaseRef.current === "idle";
      consumeArenaEntry(
        arenaId,
        arenaEnteredRef,
        () => phaseRef.current === "idle",
        (...args) => {
          enterArenaMatchRef.current(...args);
        },
      );
    };
    tryEnter();
    return subscribeArena(tryEnter);
  }, [variant]);

  const play = useCallback((cell: number) => {
    const t = tunnelRef.current;
    if (!t) return;
    const st = t.state;
    if (st.inner.winner !== 0 || st.inner.turn !== roleRef.current) return; // not my turn / between games
    if (t.displayState !== st) return; // a proposal is already awaiting its ACK (e.g. a re-seated resume move)
    try {
      t.propose({ cell, salt: generateSalt(16) }, BigInt(Date.now()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const next = useCallback(() => {
    const t = tunnelRef.current;
    if (!t) return;
    if (
      roleRef.current !== "A" ||
      t.state.inner.winner === 0 ||
      proto.isTerminal(t.state)
    )
      return; // X advances between games
    if (t.displayState !== t.state) return; // a proposal is already awaiting its ACK
    try {
      t.propose({ cell: 0, salt: generateSalt(16) }, BigInt(Date.now()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [proto]);

  const stop = useCallback(() => {
    const t = tunnelRef.current;
    const channel = channelRef.current;
    if (!t || !channel) return;
    if (t.state.inner.winner === 0) return; // settle cleanly between games
    stoppingRef.current = true;
    channel.sendPeer({ t: "stop" });
    void finishSettle(t, channel, matchIdRef.current);
  }, [finishSettle]);

  const setAuto = useCallback(
    (on: boolean) => {
      autoRef.current = on;
      setAutoState(on);
      rememberAuto(variant, on);
      const t = tunnelRef.current;
      if (!on || !t || stoppingRef.current || proto.isTerminal(t.state)) return;
      const st = t.state;
      if (st.inner.winner !== 0) {
        if (roleRef.current === "A")
          setTimeout(() => {
            try {
              t.propose(
                { cell: 0, salt: generateSalt(16) },
                BigInt(Date.now()),
              );
            } catch {
              /* ignore */
            }
          }, AUTO_MOVE_MS);
      } else if (st.inner.turn === roleRef.current) {
        const cell = (() => {
          const empties = st.inner.board
            .map((v, i) => (v === 0 ? i : -1))
            .filter((i) => i >= 0);
          return empties[Math.floor(Math.random() * empties.length)];
        })();
        setTimeout(() => {
          try {
            t.propose({ cell, salt: generateSalt(16) }, BigInt(Date.now()));
          } catch {
            /* ignore */
          }
        }, AUTO_MOVE_MS);
      }
    },
    [proto, variant],
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

  // Tear down the current match: detach resume, drop its resume record (a closed/abandoned tunnel
  // must never be restored — it would hijack the next match), close the transport, and clear
  // match state. keepAuto preserves the Auto toggle so an auto loop survives a per-game requeue;
  // a full leave clears it.
  const teardownMatch = useCallback(
    (keepAuto: boolean) => {
      detachResumeRef.current?.();
      detachResumeRef.current = null;
      const tid = tunnelRef.current?.tunnelId;
      if (tid) clearResumeRecord(tid);
      mpRef.current?.close();
      mpRef.current = null;
      channelRef.current = null;
      tunnelRef.current = null;
      setState(null);
      setRole(null);
      setDigests({});
      setGames([]);
      setScore({ x: 0, o: 0, draws: 0 });
      settledRef.current = false;
      stoppingRef.current = false;
      autoKickedRef.current = false;
      if (!keepAuto) {
        autoRef.current = defaultAuto(variant, true);
        setAutoState(autoRef.current);
      }
      openedResolveRef.current = null;
      settleResolveRef.current = null;
      bufferedSettleRef.current = null;
      helloResolveRef.current = null;
      bufferedHelloRef.current = null;
    },
    [variant],
  );

  const leave = useCallback(() => {
    // Back: tear down and return to the lobby. The FE has no half to publish (the bot owns the
    // transcript and only settles at its own terminal), so leaving relies on the bot's terminal /
    // the 1h on-chain grace as the settlement floor rather than pushing a co-signed half.
    teardownMatch(false);
    setPhase("idle");
  }, [teardownMatch]);

  // Find a new match after a per-game settle. Reuse the SAME socket (the relay runs many matches
  // per connection): release the settled match and re-quickMatch in place. Tearing the socket
  // down and reconnecting (a 2nd socket for the same wallet) raced the relay's routing and left
  // the next match's moves un-ACKed. Falls back to a full queue() if the socket is gone.
  const requeue = useCallback(() => {
    const mp = mpRef.current;
    if (!mp) {
      queue({ keepAuto: true });
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
    setGames([]);
    setScore({ x: 0, o: 0, draws: 0 });
    settledRef.current = false;
    stoppingRef.current = false;
    autoKickedRef.current = false;
    openedResolveRef.current = null;
    settleResolveRef.current = null;
    bufferedSettleRef.current = null;
    helloResolveRef.current = null;
    bufferedHelloRef.current = null;
    setError(null);
    // Keep Auto + the open socket; just join the queue again.
    setPhase("queuing");
    void (async () => {
      try {
        const m = await mp.quickMatch(
          variant === "caro" ? `tictactoe:caro:${boardSize}` : "tictactoe:ttt",
        );
        await onMatchRef.current?.(mp, m);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [queue, variant, boardSize]);

  // Keep the ref finishSettle's recovery path calls in sync with the latest requeue.
  useEffect(() => {
    requeueRef.current = requeue;
  }, [requeue]);

  // After a per-game match settles ("done"), always auto-find the next match — these are
  // self-playing arena games (parity with poker); an explicit Leave() → "idle" stops the loop.
  // Auto only governs whether the bot or you plays the match, not whether one is found. A short
  // pause lets the result show before re-queuing.
  useEffect(() => {
    if (phase !== "done") return;
    const id = setTimeout(() => requeue(), NEXT_MS);
    return () => clearTimeout(id);
  }, [phase, requeue]);

  // Register the pagehide/visibility flush and evict stale records once, on mount.
  useEffect(() => {
    installResumePersistence();
    evictExpiredRecords();
  }, []);

  useEffect(
    () => () => {
      flushResumeWrites();
      detachResumeRef.current?.();
      mpRef.current?.close();
    },
    [],
  );

  const s = state;
  const inner = s?.inner ?? null;
  const winner = inner ? inner.winner : 0;
  const myMark: 0 | 1 | 2 =
    roleRef.current === "A" ? 1 : roleRef.current === "B" ? 2 : 0;
  const isMyTurn =
    !!inner &&
    inner.winner === 0 &&
    inner.turn === roleRef.current &&
    phase === "playing";
  return {
    phase,
    error,
    role: roleRef.current,
    variant,
    board: inner ? inner.board : [],
    size: inner ? (inner.size ?? 3) : variant === "caro" ? boardSize : 3,
    lastMove: inner ? (inner.lastMove ?? -1) : -1,
    turn: inner ? inner.turn : null,
    winner,
    myMark,
    isMyTurn,
    innerOver: !!inner && inner.winner !== 0,
    terminal: s ? proto.isTerminal(s) : false,
    score,
    games,
    currentGame: s ? s.gamesPlayed + 1 : 0,
    auto,
    address: wallet.address ?? "",
    balance,
    digests,
    queue,
    playArena,
    play,
    next,
    stop,
    setAuto,
    leave,
    requeue,
  };
}
