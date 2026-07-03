import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";

import {
  setArenaEntry,
  getArenaEntry,
  arenaEntryCount,
  consumeArenaEntry,
  clearArenaEntry,
} from "./arenaAllocationStore.ts";
import type { ArenaAllocation } from "./arenaEnter.ts";

function mkEntry(game: string) {
  const allocation: ArenaAllocation = {
    game,
    matchId: "m",
    tunnelId: "0xt",
    botEphPubkey: "aa",
    botAddress: "0xbot",
    stakeEach: 100,
  };
  return { allocation, keypair: generateKeyPair() };
}

/** Run `fn` with `Date.now` pinned to `t` (the store stamps + sweeps by wall clock). Restores always. */
function at<T>(t: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => t;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test("getArenaEntry sweeps an entry no window consumed within the TTL (closed in the allocate→consume gap)", () => {
  at(1_000, () => setArenaEntry("sweep-peek", mkEntry("sweep-peek")));
  // Still within the TTL → the entry is live (a window slow by tens of seconds still claims it).
  at(1_000 + 30_000, () =>
    assert.ok(getArenaEntry("sweep-peek"), "fresh entry survives within TTL"),
  );
  // Past the TTL (bot reservation already expired backend-side) → swept, not handed to a remount.
  at(1_000 + 90_001, () =>
    assert.equal(
      getArenaEntry("sweep-peek"),
      undefined,
      "stale entry is dropped",
    ),
  );
  assert.equal(arenaEntryCount("sweep-peek"), 0);
});

test("consumeArenaEntry never enters a match whose reservation expired, and leaves the one-shot untripped", () => {
  at(0, () => setArenaEntry("sweep-consume", mkEntry("sweep-consume")));
  let entered = false;
  const oneShot = { current: false };
  at(90_001, () =>
    consumeArenaEntry(
      "sweep-consume",
      oneShot,
      () => true,
      () => {
        entered = true;
      },
    ),
  );
  assert.equal(entered, false, "stale entry is not consumed");
  assert.equal(
    oneShot.current,
    false,
    "one-shot stays untripped so a fresh entry can still enter later",
  );
});

test("consumeArenaEntry within the TTL enters once and leaves a sibling window's entry queued", () => {
  at(0, () => {
    setArenaEntry("live", mkEntry("live"));
    setArenaEntry("live", mkEntry("live")); // two same-game windows → two bots
  });
  const consumed: unknown[] = [];
  at(5_000, () => {
    consumeArenaEntry(
      "live",
      { current: false },
      () => true,
      (_a, k) => consumed.push(k),
    );
    assert.equal(consumed.length, 1, "one bot consumed");
    assert.equal(
      arenaEntryCount("live"),
      1,
      "the sibling window's entry is still queued",
    );
  });
  clearArenaEntry("live");
});
