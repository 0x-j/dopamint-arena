import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiGameCaroProtocol } from "./packages/shared/src/caro/protocol.ts";
import {
  withTopLevelWinner,
  dueCell,
  type MultiTurnState,
} from "./tttCaroPvpCore.ts";

const ctx = { tunnelId: "0x1", initialBalances: { a: 100n, b: 100n } };
const salt = () => new Uint8Array(16);

// A minimal state factory for the pure dueCell tests.
function st(winner: number, turn: "A" | "B"): MultiTurnState {
  return { inner: { winner, turn }, gamesPlayed: 0, maxGames: 10 };
}
const opts = (o: Partial<Parameters<typeof dueCell>[2]> = {}) => ({
  auto: true,
  sessionTerminal: false,
  queuedCell: undefined,
  botPick: () => 42,
  ...o,
});

test("dueCell: session terminal never proposes (the caller settles)", () => {
  assert.equal(dueCell(st(0, "A"), "A", opts({ sessionTerminal: true })), null);
  assert.equal(dueCell(st(1, "A"), "A", opts({ sessionTerminal: true })), null);
});

test("dueCell: between games, only seat A drives the advance", () => {
  assert.equal(dueCell(st(1, "A"), "A", opts()), 0, "A advances with cell 0");
  assert.equal(
    dueCell(st(1, "A"), "B", opts()),
    null,
    "B waits for A's advance",
  );
  assert.equal(
    dueCell(st(2, "B"), "A", opts()),
    0,
    "advance regardless of decided winner",
  );
});

test("dueCell: mid-game proposes only on our turn", () => {
  assert.equal(
    dueCell(st(0, "A"), "A", opts()),
    42,
    "our turn (auto) → bot cell",
  );
  assert.equal(
    dueCell(st(0, "B"), "A", opts()),
    null,
    "opponent's turn → wait",
  );
});

test("dueCell: manual play proposes only a queued human cell", () => {
  assert.equal(
    dueCell(st(0, "A"), "A", opts({ auto: false, queuedCell: 7 })),
    7,
    "queued cell on our turn",
  );
  assert.equal(
    dueCell(st(0, "A"), "A", opts({ auto: false, queuedCell: undefined })),
    null,
    "no queued cell → wait for input",
  );
  assert.equal(
    dueCell(st(0, "B"), "A", opts({ auto: false, queuedCell: 7 })),
    null,
    "queued but not our turn → wait",
  );
});

test("withTopLevelWinner surfaces inner.winner and delegates rules byte-identically", () => {
  const inner = new MultiGameCaroProtocol(10, 3, 0n); // 3x3: 5-in-a-row impossible → fills to a draw
  const wrapped = withTopLevelWinner(inner);

  const s0 = wrapped.initialState(ctx);
  assert.equal(s0.winner, 0, "fresh: top-level winner mirrors inner (0)");
  assert.equal(s0.winner, s0.inner.winner);

  // encodeState/isTerminal/balances delegate to the inner protocol (hash + settle bytes unchanged).
  assert.deepEqual(
    wrapped.encodeState(s0),
    inner.encodeState(inner.initialState(ctx)),
    "encodeState is byte-identical to the unwrapped protocol",
  );
  assert.equal(
    wrapped.isTerminal(s0),
    inner.isTerminal(inner.initialState(ctx)),
  );

  // applyMove keeps the top-level winner in sync with inner.winner after a real move.
  const s1 = wrapped.applyMove(s0, { cell: 0, salt: salt() }, "A");
  assert.equal(s1.winner, s1.inner.winner, "applyMove re-surfaces the winner");
  assert.equal(wrapped.balances(s1).a + wrapped.balances(s1).b, 200n);
});
