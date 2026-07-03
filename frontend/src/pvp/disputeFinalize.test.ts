import { test } from "node:test";
import assert from "node:assert/strict";

import {
  disputesToFinalize,
  isRebuildable,
  DISPUTE_FINALIZE_AFTER_MS,
} from "./disputeFinalize.ts";
import type { ResumeRecord } from "./resume.ts";

/** A minimal record; only the fields the dispute sweep reads matter here. */
function rec(tunnelId: string, disputedAt?: number): ResumeRecord {
  return {
    matchId: "m",
    tunnelId,
    role: "A",
    game: "caro",
    opponentWallet: "0xopp",
    opponentPubkeyHex: "aa",
    latestCoSigned: {} as ResumeRecord["latestCoSigned"],
    latestState: null,
    disputedAt,
    updatedAt: 0,
  };
}

test("disputesToFinalize returns only disputes whose on-chain window has elapsed", () => {
  const now = 1_000_000_000_000;
  const records = [
    rec("live"), // not disputed → never finalized
    rec("fresh", now - 1000), // disputed 1s ago → too young
    rec("matured", now - DISPUTE_FINALIZE_AFTER_MS - 1), // past the window → finalize
    rec("exactly", now - DISPUTE_FINALIZE_AFTER_MS), // exactly at the window → finalize
  ];
  assert.deepEqual(disputesToFinalize(records, now), ["matured", "exactly"]);
});

test("disputesToFinalize is empty when nothing is disputed", () => {
  const now = 5_000;
  assert.deepEqual(disputesToFinalize([rec("a"), rec("b")], now), []);
});

test("a still-young dispute is neither finalized nor rebuilt (waits for a later resume)", () => {
  const now = 2_000_000_000_000;
  const young = rec("young", now - 1); // just raised
  assert.deepEqual(disputesToFinalize([young], now), [], "not yet matured");
  assert.equal(
    isRebuildable(young),
    false,
    "and never rebuilt as a live match",
  );
});

test("isRebuildable: only non-disputed records rebuild", () => {
  assert.equal(isRebuildable(rec("plain")), true);
  assert.equal(isRebuildable(rec("disputed", 123)), false);
});
