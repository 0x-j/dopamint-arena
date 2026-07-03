/**
 * Render-ready PvP view for Blackjack — the snapshot the worker's
 * `BlackjackPvpController.deriveView` produces and the UI adapter maps into the legacy
 * `PvpView` shape. All fields are plain / structured-cloneable.
 *
 * Decoupled from React and worker internals: both sides import this leaf module.
 */
import type { BlackjackState } from "sui-tunnel-ts/protocol/blackjack";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

export interface BlackjackRoundResult {
  round: number;
  outcome: "win" | "lose" | "push";
  playerSum: number;
  dealerSum: number;
}

/** The snapshot the PvP hub's worker emits for a Blackjack match. */
export interface BlackjackPvpView {
  /** Full blackjack protocol state. */
  state: BlackjackState;
  /** This seat's role in the current round ("A" = player seat by default rotation). */
  myRole: Party;
  /** True when I am the player (not dealer) this round. */
  isDealer: boolean;
  /** True when it's my turn to hit/stand (phase=player and I'm the player seat). */
  myTurn: boolean;
  /** Between rounds (can bet / stop). */
  inRoundOver: boolean;
  /** No more rounds possible (auto-settle). */
  terminal: boolean;
  /** Which side ran out of chips (if any). */
  outOfChips: "player" | "dealer" | null;
  /** Current round bet. */
  currentBet: bigint;
  /** Max bet both sides can cover. */
  tableMax: bigint;
  /** Available chip denominations for betting. */
  betOptions: number[];
  /** Per-round results log. */
  rounds: BlackjackRoundResult[];
}
