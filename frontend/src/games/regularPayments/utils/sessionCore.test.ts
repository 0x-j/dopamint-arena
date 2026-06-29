import { test } from "node:test";
import assert from "node:assert/strict";
import { PaymentsProtocol } from "../../../../../sui-tunnel-ts/src/protocol/payments.ts";
import { OffchainTunnel } from "../../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { createParticipant } from "../../../../../sui-tunnel-ts/src/core/keys.ts";
import { mtps } from "../../../onchain/mtps.ts";
import {
  addCartLine,
  cartTotal,
  removeCartLine,
  verifyMove,
} from "./sessionCore.ts";
import {
  DEPOSIT_B_DUST,
  DEPOSIT_BUDGET,
  MICRO_UNIT,
  STREAM_DURATION_MS,
} from "./constants.ts";

function freshPaymentsTunnel() {
  const a = createParticipant("shopper-a");
  const b = createParticipant("shop-pos-b");
  const protocol = new PaymentsProtocol();
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    "0xfeed",
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: DEPOSIT_BUDGET, b: DEPOSIT_B_DUST },
  );
  return { protocol, tunnel };
}

const milk = {
  id: "milk",
  category: "fresh" as const,
  name: "Milk",
  priceMtps: mtps(2n),
  emoji: "🥛",
};

test("addCartLine increments qty for existing product", () => {
  const cart = addCartLine([], milk);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].qty, 1);

  const doubled = addCartLine(cart, milk);
  assert.equal(doubled.length, 1);
  assert.equal(doubled[0].qty, 2);
});

test("removeCartLine decrements qty and drops line at zero", () => {
  let cart = addCartLine([], milk);
  cart = addCartLine(cart, milk);
  assert.equal(cart[0].qty, 2);

  cart = removeCartLine(cart, "milk");
  assert.equal(cart.length, 1);
  assert.equal(cart[0].qty, 1);

  cart = removeCartLine(cart, "milk");
  assert.equal(cart.length, 0);
});

test("cartTotal sums line qty × price", () => {
  const total = cartTotal([
    {
      id: "milk",
      category: "fresh",
      name: "Milk",
      priceMtps: mtps(2n),
      emoji: "🥛",
      qty: 2,
    },
    {
      id: "bread",
      category: "fresh",
      name: "Bread",
      priceMtps: mtps(1n),
      emoji: "🍞",
      qty: 1,
    },
  ]);
  assert.equal(total, mtps(5n));
});

test("verifyMove validates correct/incorrect payment parameters", () => {
  const state = { balanceA: mtps(10n), balanceB: mtps(1n) };
  const catalog = [milk];

  // 1. Happy path: valid shopper payment
  const res1 = verifyMove(
    state,
    { from: "A", amount: milk.priceMtps },
    catalog,
  );
  assert.deepEqual(res1, { valid: true });

  // 2. Insufficient balance shopper
  const res2 = verifyMove(
    { balanceA: mtps(1n), balanceB: mtps(1n) },
    { from: "A", amount: milk.priceMtps },
    catalog,
  );
  assert.equal(res2.valid, false);
  assert.match(res2.error || "", /insufficient balance/i);

  // 3. Insufficient balance refund
  const res3 = verifyMove(
    { balanceA: mtps(10n), balanceB: 0n },
    { from: "B", amount: milk.priceMtps },
    catalog,
  );
  assert.equal(res3.valid, false);
  assert.match(res3.error || "", /insufficient balance/i);

  // 4. Invalid price
  const res4 = verifyMove(state, { from: "A", amount: 99999n }, catalog);
  assert.equal(res4.valid, false);
  assert.match(res4.error || "", /does not match any catalog item price/i);

  // 5. Negative/zero amount
  const res5 = verifyMove(state, { from: "A", amount: 0n }, catalog);
  assert.equal(res5.valid, false);
  assert.match(res5.error || "", /must be positive/i);
});
