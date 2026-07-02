import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlashState } from "sui-tunnel-ts/protocol/flash";
import { canSend, makeMove, messageFromMove } from "./session-core";

function mockState(lastSender: FlashState["lastSender"]): FlashState {
  return {
    lastSender,
    transcriptDigest: new Uint8Array(32),
    messageCount: 0n,
    balanceA: 0n,
    balanceB: 0n,
    total: 0n,
  };
}

test("canSend: empty state -> A's turn only", () => {
  const empty = mockState(null);
  assert.equal(canSend(empty, "A"), true);
  assert.equal(canSend(empty, "B"), false);
});

test("canSend: after opponent's move it is our turn", () => {
  const afterA = mockState("A");
  assert.equal(canSend(afterA, "B"), true);
  assert.equal(canSend(afterA, "A"), false);
});

test("makeMove + messageFromMove round-trip", () => {
  const m = makeMove("hello");
  assert.equal(typeof m, "string");
  assert.equal(m, "hello");
  assert.equal(messageFromMove("hello", true).sender, "You");
  assert.equal(messageFromMove("hello", false).sender, "Bot");
});
