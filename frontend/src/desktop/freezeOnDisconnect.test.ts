import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyWalletTransition,
  collectGameWindowIds,
  frozenScrimVisible,
} from "./freezeOnDisconnect";

test("classifyWalletTransition freezes when the wallet goes away", () => {
  assert.equal(classifyWalletTransition("0xabc", undefined), "freeze");
});

test("classifyWalletTransition resumes when a wallet connects from none", () => {
  assert.equal(classifyWalletTransition(undefined, "0xabc"), "resume");
});

test("classifyWalletTransition reports a direct wallet switch", () => {
  assert.equal(classifyWalletTransition("0xabc", "0xdef"), "switch");
});

test("classifyWalletTransition is none when the address is unchanged", () => {
  assert.equal(classifyWalletTransition("0xabc", "0xabc"), "none");
  assert.equal(classifyWalletTransition(undefined, undefined), "none");
});

test("collectGameWindowIds unions tiled, hidden, and floating windows across workspaces", () => {
  const ids = collectGameWindowIds(
    { games: [{ id: "battleship" }], payment: [], chat: [] },
    { games: { caro: {} }, payment: {}, chat: {} },
    { games: { "ttt#1": { item: { id: "ttt#1" } } }, payment: {}, chat: {} },
  );
  assert.deepEqual(new Set(ids), new Set(["battleship", "caro", "ttt#1"]));
});

test("collectGameWindowIds dedupes an id seen in more than one store", () => {
  const ids = collectGameWindowIds(
    { games: [{ id: "battleship" }] },
    { games: { battleship: {} } },
    {},
  );
  assert.deepEqual(ids, ["battleship"]);
});

test("frozenScrimVisible shows only for wallet-gated games while frozen", () => {
  assert.equal(frozenScrimVisible(true, "battleship"), true);
  assert.equal(frozenScrimVisible(true, undefined), false); // non-arena (e.g. chat)
  assert.equal(frozenScrimVisible(false, "battleship"), false);
});
