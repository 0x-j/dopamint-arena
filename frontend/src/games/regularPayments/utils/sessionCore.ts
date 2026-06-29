/**
 * Pure driver for Regular Payments tunnel steps. No React — unit-tested under tsx.
 * The session hook owns keys, on-chain open/close, pacing, and telemetry.
 */
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import type {
  PaymentMove,
  PaymentsProtocol,
  PaymentsState,
} from "sui-tunnel-ts/protocol/payments";
import type { CartLine, Product } from "../types";

export function addCartLine(cart: CartLine[], product: Product): CartLine[] {
  const idx = cart.findIndex((l) => l.id === product.id);
  if (idx === -1) return [...cart, { ...product, qty: 1 }];
  return cart.map((l, i) => (i === idx ? { ...l, qty: l.qty + 1 } : l));
}

/** Decrement qty by one; drop the line when qty reaches zero. */
export function removeCartLine(
  cart: CartLine[],
  productId: string,
): CartLine[] {
  const idx = cart.findIndex((l) => l.id === productId);
  if (idx === -1) return cart;
  const line = cart[idx];
  if (line.qty <= 1) return cart.filter((_, i) => i !== idx);
  return cart.map((l, i) => (i === idx ? { ...l, qty: l.qty - 1 } : l));
}

export function cartTotal(lines: CartLine[]): bigint {
  return lines.reduce(
    (sum, line) => sum + line.priceMtps * BigInt(line.qty),
    0n,
  );
}

export function verifyMove(
  state: { balanceA: bigint; balanceB: bigint },
  move: { from: string; amount: bigint },
  catalog: Product[],
): { valid: boolean; error?: string } {
  // 1. Basic checks
  if (move.amount <= 0n) {
    return { valid: false, error: "Payment amount must be positive" };
  }

  // 2. Balance constraint checks
  if (move.from === "A" && move.amount > state.balanceA) {
    return {
      valid: false,
      error: "Shopper has insufficient balance in the tunnel",
    };
  }
  if (move.from === "B" && move.amount > state.balanceB) {
    return {
      valid: false,
      error: "Shop has insufficient balance to issue refund",
    };
  }

  // 3. Price validation check
  const isValidPrice = catalog.some((p) => p.priceMtps === move.amount);
  if (!isValidPrice) {
    return {
      valid: false,
      error: "Payment amount does not match any catalog item price",
    };
  }

  return { valid: true };
}
