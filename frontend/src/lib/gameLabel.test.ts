import { test } from "node:test";
import assert from "node:assert/strict";

import { gameLabel } from "./gameLabel";

// The live (on-chain) feed carries the backend ARENA id (underscore form), which is not a registry
// module id — so without formatting it renders as a raw slug like "bomb_it". The label must read as
// a name, which is what "game display is not best practice" was reporting.
test("title-cases an underscore arena id so the feed never shows a raw slug", () => {
  assert.equal(gameLabel("bomb_it"), "Bomb It");
  assert.equal(gameLabel("regular_payments"), "Regular Payments");
  assert.equal(gameLabel("quantum_poker"), "Quantum Poker");
});

test("capitalizes a single-word id instead of leaving it lowercase", () => {
  assert.equal(gameLabel("caro"), "Caro");
  assert.equal(gameLabel("blackjack"), "Blackjack");
});

// "ttt" title-cased is "Ttt" — an abbreviation the slug rule can't recover, so it needs an alias.
test("resolves a known abbreviation to a readable name", () => {
  assert.equal(gameLabel("ttt"), "Tic Tac Toe");
});

// PvP rows carry no game (relay path, ADR-0007); a blank cell, never the string "undefined".
test("renders an empty game id as blank", () => {
  assert.equal(gameLabel(""), "");
});
