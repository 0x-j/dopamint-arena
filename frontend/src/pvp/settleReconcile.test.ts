import { test } from "node:test";
import assert from "node:assert/strict";
import { peerHalfMatchesOutcome } from "./settleReconcile.ts";

const OURS = {
  partyABalance: 148n,
  partyBBalance: 52n,
  finalNonce: 69n,
  timestamp: 1_700_000_000n,
};

const THEIRS_BASE = {
  partyABalance: "148",
  partyBBalance: "52",
  finalNonce: "69",
  timestamp: "1700000000",
  transcriptRoot: "ab".repeat(32), // differs from ours by construction — that's the case under test
};

test("a peer half that differs only by transcript root is adoptable (resume-safe divergence)", () => {
  assert.equal(peerHalfMatchesOutcome(OURS, THEIRS_BASE), true);
});

test("any money-field divergence is NOT adoptable — falls to the dispute floor", () => {
  assert.equal(
    peerHalfMatchesOutcome(OURS, { ...THEIRS_BASE, partyABalance: "149" }),
    false,
    "balance A differs",
  );
  assert.equal(
    peerHalfMatchesOutcome(OURS, { ...THEIRS_BASE, partyBBalance: "51" }),
    false,
    "balance B differs",
  );
  assert.equal(
    peerHalfMatchesOutcome(OURS, { ...THEIRS_BASE, finalNonce: "70" }),
    false,
    "finalNonce differs",
  );
  assert.equal(
    peerHalfMatchesOutcome(OURS, { ...THEIRS_BASE, timestamp: "1700000001" }),
    false,
    "timestamp differs",
  );
});
