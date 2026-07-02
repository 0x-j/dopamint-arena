import { test } from "node:test";
import assert from "node:assert/strict";

import { register, moduleIdForGame } from "./registry";
import type { GameModule } from "./types";

// The registry is a module-level singleton shared across test files. Register ONLY fake ids that no
// other test uses, so this can't leak into (or be corrupted by) another file's expectations.
const fake = (id: string, arenaGameId: string | string[]): GameModule =>
  ({ id, name: id, arenaGameId }) as unknown as GameModule;

register(fake("zz-solo", "zz_solo_arena"));
register(fake("zz-multi", ["zz_alpha", "zz_beta"]));

// The live on-chain feed carries the backend ARENA id (underscore); the per-game tabs are keyed by
// MODULE id. Without this resolution, clicking a tab filters `t.game === tab` to nothing.
test("resolves an arena id to its owning module id", () => {
  assert.equal(moduleIdForGame("zz_solo_arena"), "zz-solo");
});

// One module can host several arena protocols (tic-tac-toe + caro); every one resolves to it.
test("resolves any of a module's arena ids to the module id", () => {
  assert.equal(moduleIdForGame("zz_alpha"), "zz-multi");
  assert.equal(moduleIdForGame("zz_beta"), "zz-multi");
});

// The local "My Activity" feed already carries the module id — it must pass through unchanged so
// that feed's (working) tabs keep matching.
test("passes a module id through unchanged", () => {
  assert.equal(moduleIdForGame("zz-solo"), "zz-solo");
});

// An id no module claims resolves to itself: it simply matches no per-game tab (only "All").
test("returns an unknown id unchanged", () => {
  assert.equal(moduleIdForGame("zz_unknown"), "zz_unknown");
});
