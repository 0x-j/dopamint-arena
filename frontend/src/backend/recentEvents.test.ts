import { test } from "node:test";
import assert from "node:assert/strict";
import { recentEventsToTxnRows } from "./recentEvents";
import type { TunnelEvent } from "./controlPlane";

const settled: TunnelEvent = {
  tunnelId: "0xabcdef0123456789",
  kind: "settled",
  partyA: null,
  partyB: null,
  funder: null,
  game: null,
  partyABalance: 1_500_000_000, // 1.5 SUI in MIST
  partyBBalance: 500_000_000, //   0.5 SUI in MIST
  transcriptRoot: "deadbeef",
  txDigest: "DiGeSt",
  timestampMs: 1_750_000_000_000,
  proofUrl: "https://agg/v1/blobs/abc",
};

test("maps a settled event to an on-chain TxnRow", () => {
  const [row] = recentEventsToTxnRows([settled]);
  assert.equal(row.digest, "DiGeSt");
  assert.equal(row.proofUrl, "https://agg/v1/blobs/abc");
  assert.equal(row.game, ""); // null game → no false per-game attribution
  assert.equal(row.type, "Settled");
  assert.equal(row.status, "Success");
});

test("opened event maps to an Opened row", () => {
  const opened: TunnelEvent = {
    ...settled,
    kind: "opened",
    partyABalance: null,
    partyBBalance: null,
  };
  const [row] = recentEventsToTxnRows([opened]);
  assert.equal(row.type, "Opened");
});

test("stable id per digest", () => {
  const [a] = recentEventsToTxnRows([settled]);
  const [b] = recentEventsToTxnRows([settled]);
  assert.equal(a.id, b.id);
});

test("no viewer → nothing is mine, ADDRESS falls back to a party", () => {
  const e: TunnelEvent = {
    ...settled,
    partyA: "0xA",
    partyB: "0xB",
    funder: "0xA",
  };
  const [row] = recentEventsToTxnRows([e]);
  assert.equal(row.mine, false);
  assert.equal(row.address, "0xA");
});

test("PvP: viewer is partyA → mine, and ADDRESS shows the viewer's OWN wallet to self-verify", () => {
  const e: TunnelEvent = {
    ...settled,
    partyA: "0xME",
    partyB: "0xOPP",
    funder: "0xME",
    game: "ticTacToe",
  };
  const [row] = recentEventsToTxnRows([e], "0xME");
  assert.equal(row.mine, true);
  assert.equal(row.address, "0xME"); // option A: own address, clickable to your account page
  assert.equal(row.game, "ticTacToe");
});

test("self-play: viewer is the funder (parties are ephemeral bots) → mine, ADDRESS is the funding wallet", () => {
  const e: TunnelEvent = {
    ...settled,
    kind: "opened",
    partyA: "0xBOT1",
    partyB: "0xBOT2",
    funder: "0xME",
    game: "blackjack",
    partyABalance: null,
    partyBBalance: null,
  };
  const [row] = recentEventsToTxnRows([e], "0xME");
  assert.equal(row.mine, true);
  assert.equal(row.address, "0xME");
});

test("someone else's tunnel → not mine, ADDRESS shows the tunnel's party", () => {
  const e: TunnelEvent = {
    ...settled,
    partyA: "0xX",
    partyB: "0xY",
    funder: "0xX",
  };
  const [row] = recentEventsToTxnRows([e], "0xME");
  assert.equal(row.mine, false);
  assert.equal(row.address, "0xX");
});

test("uncaptured ownership → ADDRESS undefined (—), not mine", () => {
  const [row] = recentEventsToTxnRows([settled], "0xME"); // partyA/B/funder all null
  assert.equal(row.address, undefined);
  assert.equal(row.mine, false);
});

test("highlight is case-insensitive so a casing mismatch never silently drops it", () => {
  const e: TunnelEvent = {
    ...settled,
    partyA: "0xAbCdEf",
    partyB: "0xOPP",
    funder: "0xAbCdEf",
  };
  const [row] = recentEventsToTxnRows([e], "0xabcdef"); // lower-case viewer, mixed-case party
  assert.equal(row.mine, true);
});
