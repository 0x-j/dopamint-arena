/**
 * Blackjack as a worker-engine PvP `GameSessionSpec` (hidden-info: binary move codec +
 * commit-reveal card draws). Follows `battleshipSpec.ts`'s controller pattern.
 *
 * The controller ports the core plumbing/auto logic from the legacy 1100-line
 * `usePvpBlackjack` hook: `actorFor` determines whose turn it is, the protocol's
 * `randomMove` mints commit secrets and reveals, and manual input queues
 * hit/stand/bet moves. The `BlackjackProtocol`'s `moveCodec` strips secrets from
 * the wire.
 *
 * Stop (settle) is handled via `onInput({ type: "stop" })` — the controller sets a
 * flag, and the engine's generic `isTerminal` check settles the tunnel at the next
 * `round_over` boundary.
 */
import type {
  GameSessionSpec,
  MatchController,
  MatchIo,
} from "@/engine/engineApi";
import { defineGame } from "@/engine/specs/defineGame";
import {
  BlackjackProtocol,
  actorFor,
  getPlayerParty,
  getDealerParty,
  blackjackHandValue as handValue,
  MIN_BET,
  maxBet as tableMaxBet,
  type BlackjackState,
  type BlackjackMove,
} from "sui-tunnel-ts/protocol/blackjack";
import { blackjackMoveCodec } from "sui-tunnel-ts/protocol/blackjackCodec";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { ResumeAdapter } from "@/pvp/resumeSession";
import { makeBlackjackResumeAdapter } from "./blackjackResumeAdapter";
import type {
  BlackjackPvpView,
  BlackjackRoundResult,
} from "./blackjackPvpView";

// --- Constants (match the legacy hook) -----------------------------------------------

const GAME_ID = "blackjack";
/** Per-seat stake (whole MTPS, 0-decimal). */
const DEFAULT_STAKE = 1000n;
/** Chip denominations offered for betting. */
const BET_OPTIONS = [1, 5, 10, 25, 50, 100];
/** Delay before auto-driven plumbing moves (commit/reveal) so the table is watchable. */
const PLUMBING_MS = 120;
/** Delay before auto-bot places a bet for the next round. */
const NEXT_MS = 900;
/** Delay before auto-bot plays hit/stand. */
const BOT_MOVE_MS = 700;

// --- BlackjackPvpController (worker-side MatchController) ----------------------------

/** Blackjack input from the UI. */
type BlackjackInput =
  | { type: "hit" }
  | { type: "stand" }
  | { type: "bet"; amount: number }
  | { type: "stop" };

class BlackjackPvpController implements MatchController<
  BlackjackState,
  BlackjackMove,
  void,
  BlackjackInput,
  BlackjackPvpView
> {
  private readonly proto = new BlackjackProtocol();
  /** Accumulated per-round results for the UI scoreboard. */
  private rounds: BlackjackRoundResult[] = [];
  /** Last balance-A checkpoint for per-round delta. */
  private lastBalanceA = 0n;
  /** Last logged round number. */
  private lastLoggedRound = 0;
  /** Remembered bet amount for auto-play. */
  private lastBet = Number(MIN_BET);
  /** Stop requested — settle at the next round boundary. */
  private stopping = false;
  /** Pending plumbing timer. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly io: MatchIo<BlackjackState, BlackjackMove>) {}

  initSetup(): void {
    const dt = this.io.tunnel();
    if (dt) this.lastBalanceA = dt.state.balanceA;
  }

  onConfirmed(): void {
    this.recordRound();
    if (this.stopping) return; // a stop/settle is in flight
    this.proposeDue();
  }

  onInput(input: BlackjackInput): void {
    if (input.type === "stop") {
      this.stopping = true;
      this.io.emitView();
      return;
    }
    if (input.type === "hit" || input.type === "stand") {
      this.proposePlayer(input.type);
      return;
    }
    if (input.type === "bet") {
      this.proposeBet(input.amount);
    }
  }

  setAuto(): void {
    this.proposeDue();
  }

  deriveView(state: BlackjackState): BlackjackPvpView {
    const role = this.io.role;
    const curRound = state.round || 1n;
    const isDealer =
      role ===
      getDealerParty(
        state.phase === "round_over" ? state.round + 1n : state.round,
      );
    const myTurn =
      state.phase === "player" && role === getPlayerParty(state.round);
    const terminal = this.proto.isTerminal(state);
    const outOfChips: "player" | "dealer" | null =
      state.balanceA < MIN_BET
        ? "player"
        : state.balanceB < MIN_BET
          ? "dealer"
          : null;
    const tableMax = tableMaxBet(state);
    const betOptions = BET_OPTIONS.filter((v) => BigInt(v) <= tableMax);

    return {
      state,
      myRole: role,
      isDealer,
      myTurn,
      inRoundOver: state.phase === "round_over",
      terminal,
      outOfChips,
      currentBet: state.bet,
      tableMax,
      betOptions,
      rounds: this.rounds.slice(-30),
    };
  }

  resumeAdapter(): ResumeAdapter<BlackjackState, BlackjackMove> {
    const io = this.io;
    return makeBlackjackResumeAdapter({
      getSecret: () => {
        const dt = io.tunnel();
        if (!dt) return { localSecretA: null, localSecretB: null };
        return {
          localSecretA: dt.state.localSecretA,
          localSecretB: dt.state.localSecretB,
        };
      },
      setSecret: (sec) => {
        const dt = io.tunnel();
        if (!dt) return;
        dt.state.localSecretA = sec.localSecretA;
        dt.state.localSecretB = sec.localSecretB;
      },
      onReconciled: () => {
        io.emitView();
        this.proposeDue();
      },
    });
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // --- internals ---

  /** Log a round result whenever the state transitions to round_over. */
  private recordRound(): void {
    const dt = this.io.tunnel();
    if (!dt) return;
    const st = dt.state;
    if (st.phase === "round_over" && Number(st.round) > this.lastLoggedRound) {
      const balA = st.balanceA;
      const delta = balA - this.lastBalanceA;
      const outcome: BlackjackRoundResult["outcome"] =
        delta > 0n ? "win" : delta < 0n ? "lose" : "push";
      this.rounds.push({
        round: Number(st.round),
        outcome,
        playerSum: handValue(st.playerHand),
        dealerSum: handValue(st.dealerHand),
      });
      this.lastLoggedRound = Number(st.round);
      this.lastBalanceA = balA;
    }
  }

  /** Propose the due plumbing/auto move based on the current state. */
  private proposeDue(): void {
    const dt = this.io.tunnel();
    if (!dt) return;
    const st = dt.state;
    const role = this.io.role;

    // Who owes the next move?
    const owed = actorFor(st, getPlayerParty);
    if (!owed || owed !== role) return;

    // Plumbing: commit/reveal is ALWAYS auto-driven.
    if (st.phase === "draw_commit" || st.phase === "draw_reveal") {
      const mv = this.proto.randomMove(st, role, Math.random);
      if (mv) {
        const delay = this.io.auto() ? 50 : PLUMBING_MS;
        this.scheduleProposal(mv, delay);
      }
      return;
    }

    // Auto-bet: reuse the remembered bet.
    if (st.phase === "round_over" && this.io.auto()) {
      const mv = this.clampBetMove(this.lastBet, st);
      const delay = this.io.auto() ? 100 : NEXT_MS;
      this.scheduleProposal(mv, delay);
      return;
    }

    // Auto hit/stand: bot plays the player seat.
    if (st.phase === "player" && this.io.auto()) {
      const mv = this.proto.randomMove(st, role, Math.random);
      if (mv) {
        const delay = this.io.auto() ? 50 : BOT_MOVE_MS;
        this.scheduleProposal(mv, delay);
      }
    }
  }

  private scheduleProposal(move: BlackjackMove, delay: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const dt = this.io.tunnel();
      if (!dt) return;
      try {
        dt.propose(move, BigInt(Date.now()));
        this.io.emitView();
      } catch {
        /* proposal already pending or transient */
      }
    }, delay);
  }

  private proposePlayer(action: "hit" | "stand"): void {
    const dt = this.io.tunnel();
    if (!dt) return;
    const role = this.io.role;
    if (role !== getPlayerParty(dt.state.round) || dt.state.phase !== "player")
      return;
    try {
      dt.propose({ kind: action }, BigInt(Date.now()));
      this.io.emitView();
    } catch {
      /* not my turn / in flight */
    }
  }

  private proposeBet(amount: number): void {
    const dt = this.io.tunnel();
    if (!dt) return;
    const role = this.io.role;
    if (
      role !== getPlayerParty(dt.state.round + 1n) ||
      dt.state.phase !== "round_over" ||
      this.proto.isTerminal(dt.state)
    )
      return;
    this.lastBet = amount;
    try {
      dt.propose(this.clampBetMove(amount, dt.state), BigInt(Date.now()));
      this.io.emitView();
    } catch {
      /* already pending */
    }
  }

  private clampBetMove(amount: number, st: BlackjackState): BlackjackMove {
    const cap = tableMaxBet(st);
    const clamped =
      BigInt(amount) > cap
        ? cap
        : BigInt(amount) < MIN_BET
          ? MIN_BET
          : BigInt(amount);
    return { kind: "bet", amount: clamped };
  }
}

// --- Spec registration ---------------------------------------------------------------

/** Blackjack has no per-round `winner` in its state (multi-round; terminal = round cap or balance
 *  exhausted). The engine reads `state.winner` but treats undefined as null. This intersection
 *  satisfies the `GameSessionSpec` constraint without altering the protocol. */
type BlackjackStateWithWinner = BlackjackState & { winner: null };

export const blackjackPvpSpec: GameSessionSpec<
  BlackjackStateWithWinner,
  BlackjackMove,
  void,
  BlackjackInput,
  BlackjackPvpView
> = defineGame({
  game: GAME_ID,
  stake: DEFAULT_STAKE,
  makeProtocol: () => new BlackjackProtocol() as never,
  moveCodec: blackjackMoveCodec as never,
  createMatch: (io) => new BlackjackPvpController(io as never) as never,
});
