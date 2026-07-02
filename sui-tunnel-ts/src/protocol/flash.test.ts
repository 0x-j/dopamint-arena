import { test } from "node:test";
import assert from "node:assert/strict";
import { FlashProtocol, FLASH_MAX_MOVES } from "./flash";
import { toHex } from "../core/bytes";

const proto = new FlashProtocol();
const ctx = { tunnelId: "0xab", initialBalances: { a: 100n, b: 100n } };

test("initialState sets balances from ctx and zero digest", () => {
  const s = proto.initialState(ctx);
  assert.equal(s.messageCount, 0n);
  assert.equal(s.lastSender, null);
  assert.equal(s.balanceA, 100n);
  assert.equal(s.balanceB, 100n);
  assert.equal(s.total, 200n);
  assert.equal(s.transcriptDigest.length, 32);
  assert.equal(toHex(s.transcriptDigest), "00".repeat(32));
});

test("applyMove folds text into the digest and bumps the count", () => {
  const s0 = proto.initialState(ctx);
  const s1 = proto.applyMove(s0, "hello", "A");
  assert.equal(s1.messageCount, 1n);
  assert.equal(s1.lastSender, "A");
  assert.notEqual(toHex(s1.transcriptDigest), toHex(s0.transcriptDigest));
});

test("encodeState is deterministic and changes with state", () => {
  const s0 = proto.initialState(ctx);
  const s1 = proto.applyMove(s0, "hello", "A");
  assert.equal(toHex(proto.encodeState(s0)), toHex(proto.encodeState(s0)));
  assert.notEqual(toHex(proto.encodeState(s0)), toHex(proto.encodeState(s1)));
});

test("balances are conserved across random play", () => {
  let s = proto.initialState(ctx);
  const rng = (() => {
    let x = 0.42;
    return () => (x = (x * 9301 + 49297) % 233280) / 233280;
  })();
  for (let i = 0; i < 100; i++) {
    const by = i % 2 === 0 ? "A" : "B";
    const m = proto.randomMove!(s, by, rng);
    s = proto.applyMove(s, m, by);
    const bal = proto.balances(s);
    assert.equal(bal.a + bal.b, 200n);
  }
  assert.equal(proto.isTerminal(s), false);
});

test("applyMove is pure (does not mutate input state)", () => {
  const s = proto.initialState(ctx);
  const before = toHex(s.transcriptDigest);
  proto.applyMove(s, "hello", "A");
  assert.equal(s.messageCount, 0n);
  assert.equal(s.balanceA, 100n);
  assert.equal(s.balanceB, 100n);
  assert.equal(toHex(s.transcriptDigest), before);
});

test("digest is order- and sender-sensitive", () => {
  const s = proto.initialState(ctx);
  const ab = proto.applyMove(s, "x", "A");
  const ba = proto.applyMove(s, "x", "B");
  // same text, different sender -> different digest
  assert.notEqual(toHex(ab.transcriptDigest), toHex(ba.transcriptDigest));
  // same first message, different second -> different digest (order matters)
  const ab1 = proto.applyMove(ab, "y", "B");
  const ab2 = proto.applyMove(ab, "z", "B");
  assert.notEqual(toHex(ab1.transcriptDigest), toHex(ab2.transcriptDigest));
});

test("the move cap is one million", () => {
  assert.equal(FLASH_MAX_MOVES, 1_000_000n);
});

test("applyMove allows the last move up to the cap but refuses at it", () => {
  const proto = new FlashProtocol();
  // The (1,000,000)th message is the last allowed: count 999,999 -> 1,000,000.
  const belowCap = proto.initialState(ctx);
  belowCap.messageCount = FLASH_MAX_MOVES - 1n;
  const atCap = proto.applyMove(belowCap, "last", "A");
  assert.equal(atCap.messageCount, FLASH_MAX_MOVES);
  // At the cap, the next move is refused so the driver settles + reopens instead.
  assert.throws(() => proto.applyMove(atCap, "over", "B"), /cap reached/);
});

test("applyMove rejects empty text", () => {
  const s = proto.initialState(ctx);
  assert.throws(() => proto.applyMove(s, "", "A"));
});

test("applyMove rejects text > 256 bytes", () => {
  const s = proto.initialState(ctx);
  assert.throws(() => proto.applyMove(s, "x".repeat(257), "A"), /too long/);
});
