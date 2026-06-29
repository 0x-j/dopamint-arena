import { describe, it } from "node:test";
import assert from "node:assert";
import {
  PaymentsProtocol,
  type PaymentsState,
  type PaymentMove,
} from "sui-tunnel-ts/protocol/payments";
import { createRegularPaymentsKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";
import { defaultStateHash } from "@/agent/stateHash";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("regularPayments kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "rp-1",
    initialBalances: { a: 100n, b: 100n },
  };

  const MICRO = 5n; // fixed micro amount for these tests

  it("uses the payments.v1 protocol domain and correct id", () => {
    const kit = createRegularPaymentsKit(MICRO);
    assert.strictEqual(kit.id, "regular-payments");
    assert.strictEqual(kit.protocol.name, "payments.v1");
  });

  it("payer bot (A) proposes the fixed micro payment when it has balance", () => {
    const kit = createRegularPaymentsKit(MICRO);
    const state = kit.protocol.initialState(ctx);
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(2) });

    const moveA = botA.plan(state);
    const moveB = botB.plan(state);

    assert.deepStrictEqual(moveA, { from: "A", amount: MICRO });
    assert.strictEqual(moveB, null);
  });

  it("shop bot (B) never proposes (unidirectional micro-payments flow)", () => {
    const kit = createRegularPaymentsKit(MICRO);
    const state = kit.protocol.initialState(ctx);
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(7) });
    assert.strictEqual(botB.plan(state), null);
  });

  it("drives multiple fixed micro-payments with conserved balances and monotonic count", () => {
    const kit = createRegularPaymentsKit(MICRO);
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(2) });

    let state: PaymentsState = kit.protocol.initialState(ctx);
    const steps = 7;

    for (let i = 0; i < steps; i++) {
      const move = botA.plan(state);
      assert.ok(move, `expected payer move at step ${i}`);
      assert.strictEqual(move.from, "A");
      assert.strictEqual(move.amount, MICRO);

      // Shop never proposes
      assert.strictEqual(botB.plan(state), null);

      const next = kit.protocol.applyMove(state, move, "A");
      botA.confirm(state, move);

      const bals = kit.protocol.balances(next);
      assert.strictEqual(
        bals.a + bals.b,
        ctx.initialBalances.a + ctx.initialBalances.b,
      );

      state = next;
    }

    assert.strictEqual(state.count, BigInt(steps));
  });

  it("plan is deterministic and idempotent on the same state", () => {
    const kit = createRegularPaymentsKit(MICRO);
    const state = kit.protocol.initialState(ctx);
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(42) });

    const m1 = botA.plan(state);
    const m2 = botA.plan(state);
    const m3 = botA.plan(state);

    assert.deepStrictEqual(m1, m2);
    assert.deepStrictEqual(m1, m3);
  });

  it("stops proposing when payer has insufficient balance", () => {
    const kit = createRegularPaymentsKit(50n);
    // Force a state where A has less than the payment amount
    const lowState: PaymentsState = {
      balanceA: 10n,
      balanceB: 90n,
      total: 100n,
      count: 0n,
    };

    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    assert.strictEqual(botA.plan(lowState), null);
  });
});
