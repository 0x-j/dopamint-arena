import { describe, it } from "node:test";
import assert from "node:assert";
import { GAME_KITS } from "./gameKit";

describe("GAME_KITS registry", () => {
  it("contains all four game ids", () => {
    assert.ok(GAME_KITS.tictactoe);
    assert.ok(GAME_KITS.blackjack);
    assert.ok(GAME_KITS.battleship);
    assert.ok(GAME_KITS["quantum-poker"]);
    assert.ok(GAME_KITS["regular-payments"]);
  });

  it("exposes the human-hook protocol domains", () => {
    assert.strictEqual(
      GAME_KITS.tictactoe.protocol.name,
      "tic_tac_toe.multi.v1",
    );
    assert.strictEqual(GAME_KITS.blackjack.protocol.name, "blackjack.v2");
    assert.strictEqual(GAME_KITS.battleship.protocol.name, "battleship.v1");
    assert.strictEqual(
      GAME_KITS["quantum-poker"].protocol.name,
      "quantum_poker.v2",
    );
  });

  it("imports cleanly under tsx", () => {
    // If this test file runs, the registry already loaded under tsx.
    assert.strictEqual(typeof GAME_KITS, "object");
  });
});
