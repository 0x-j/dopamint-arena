import { test } from "node:test";
import assert from "node:assert/strict";
import { liveOnchainTxns, displayUpdatesPerSec } from "./liveMerge";
import type { StatsSnapshot } from "./controlPlane";

const connected: StatsSnapshot = {
  tps: 1_000_000,
  peakTps: 1_000_000,
  totalActions: 0,
  activeTunnels: 0,
  settledTunnels: 0,
  perGame: {},
  recentEvents: [
    {
      tunnelId: "0xt",
      kind: "settled",
      partyA: null,
      partyB: null,
      funder: null,
      game: null,
      partyABalance: 1e9,
      partyBBalance: 1e9,
      transcriptRoot: "ab",
      txDigest: "D",
      timestampMs: 1_750_000_000_000,
      proofUrl: null,
    },
  ],
};

test("connected backend → real onchain rows; empty stays empty", () => {
  assert.equal(liveOnchainTxns(connected, [{ id: 1 } as never]).length, 1);
  const empty = { ...connected, recentEvents: [] };
  assert.deepEqual(liveOnchainTxns(empty, [{ id: 1 } as never]), []);
});

test("disconnected backend → fallback rows", () => {
  const fallback = [{ id: 9 } as never];
  assert.equal(liveOnchainTxns(null, fallback), fallback);
});

test("tps keeps the backend global aggregate when it is higher", () => {
  assert.equal(displayUpdatesPerSec(connected, 12), 1_000_000);
});

test("tps shows local activity when backend is lower or disconnected", () => {
  assert.equal(displayUpdatesPerSec({ ...connected, tps: 0 }, 12), 12);
  assert.equal(displayUpdatesPerSec(null, 12), 12);
});
