import test from "node:test";
import assert from "node:assert/strict";
import { FlashProtocol } from "sui-tunnel-ts/protocol/flash";
import { makeFlashResumeAdapter } from "./flashResumeAdapter";

// The resume record is JSON in localStorage, so the adapter must survive a real JSON round-trip:
// bigints → strings, the digest Uint8Array → a number array, and back — byte-for-byte.
test("flash resume adapter round-trips state through JSON", () => {
  const proto = new FlashProtocol();
  let state = proto.initialState({
    tunnelId: "0x1",
    initialBalances: { a: 1n, b: 1n },
  });
  state = proto.applyMove(state, "hello", "A");
  state = proto.applyMove(state, "hi there", "B");

  const adapter = makeFlashResumeAdapter({});
  const wire = JSON.parse(JSON.stringify(adapter.serializeState(state)));
  const restored = adapter.deserializeState(wire);

  assert.deepEqual(
    Array.from(restored.transcriptDigest),
    Array.from(state.transcriptDigest),
  );
  assert.equal(restored.messageCount, state.messageCount);
  assert.equal(restored.lastSender, state.lastSender);
  assert.equal(restored.balanceA, state.balanceA);
  assert.equal(restored.balanceB, state.balanceB);
  assert.equal(restored.total, state.total);
});

// Flash has no hidden per-seat secret (unlike battleship's board): the adapter must not define
// secret capture/restore, so nothing seat-private is expected in a record.
test("flash resume adapter carries no hidden secret", () => {
  const adapter = makeFlashResumeAdapter({});
  assert.equal(adapter.captureSecret, undefined);
  assert.equal(adapter.restoreSecret, undefined);
});
