import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultAuto, rememberAuto } from "./autoPreference";

// The contract: a fresh page load starts with the player driving their own seat (auto OFF), then
// their last toggle sticks for the next game. These encode WHY the default is OFF and WHY it must
// change once the player opts in — not just the Map mechanics. Each test uses a unique game key so
// the shared module state can't leak between them.

test("a game never played defaults to auto OFF (player drives their seat)", () => {
  assert.equal(defaultAuto("first-time-game"), false);
});

test("after the player turns auto on, new games default ON (sticky opt-in)", () => {
  rememberAuto("opted-in-game", true);
  assert.equal(defaultAuto("opted-in-game"), true);
});

test("after the player turns auto back off, new games default OFF again", () => {
  rememberAuto("toggled-game", true);
  rememberAuto("toggled-game", false);
  assert.equal(defaultAuto("toggled-game"), false);
});

test("one game's choice does not change another game's default", () => {
  rememberAuto("game-a", true);
  assert.equal(defaultAuto("game-b"), false);
});

test("an untoggled arena game defaults to the ON fallback", () => {
  assert.equal(defaultAuto("arena-fresh", true), true);
  assert.equal(defaultAuto("player-driven-fresh"), false);
});

test("an explicit toggle overrides the fallback", () => {
  rememberAuto("arena-opted-out", false);
  assert.equal(defaultAuto("arena-opted-out", true), false);
});
