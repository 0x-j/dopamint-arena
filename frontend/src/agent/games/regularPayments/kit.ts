import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  PaymentsProtocol,
  type PaymentsState,
  type PaymentMove,
} from "sui-tunnel-ts/protocol/payments";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

/**
 * Regular Payments payer bot (seat A).
 * In the canonical "Regular Payments" flow the user (A) streams a fixed micro-amount
 * to the shop (B) on every step until the purchase target is met. Seat B never initiates.
 * The bot is deliberately simple and stateless — move decision is pure from the public
 * balance + the configured payment amount.
 */
class RegularPaymentsBot implements GameBot<PaymentsState, PaymentMove> {
  private readonly seat: Party;
  private readonly protocol: PaymentsProtocol;
  private readonly paymentAmount: bigint;
  private readonly rng: () => number;

  constructor(
    seat: Party,
    protocol: PaymentsProtocol,
    ctx: BotContext,
    paymentAmount: bigint,
  ) {
    this.seat = seat;
    this.protocol = protocol;
    this.paymentAmount = paymentAmount;
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: PaymentsState): PaymentMove | null {
    // Only the payer (A) initiates micro-payments in the micro-payments model.
    if (this.seat !== "A") return null;

    if (state.balanceA < this.paymentAmount) return null;

    return { from: "A", amount: this.paymentAmount };
  }

  confirm(_state: PaymentsState, _move: PaymentMove): void {
    // No retained memory — decision is derived from public state on each plan() call.
  }

  abort(): void {
    // No resources to release.
  }
}

export function createRegularPaymentsKit(
  paymentAmount: bigint,
): GameKit<PaymentsState, PaymentMove> {
  const protocol = new PaymentsProtocol();

  return {
    id: "regular-payments",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new RegularPaymentsBot(seat, protocol, ctx, paymentAmount),
    defaultStake: paymentAmount * 500n, // representative of a full machine budget
  };
}
