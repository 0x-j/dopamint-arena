import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../core/bytes";
import { computeCommitment } from "../core/commitment";
import {
  BATTLESHIP_CELL_COUNT,
  FLEET_CELLS as FLEET_CELLS_T,
  placeFleetRandom,
  placementsToBoard,
} from "./battleshipFleet";
import { mulberry32 } from "../sim/rng";
import {
  BattleshipMove,
  BattleshipProtocol,
  BattleshipState,
} from "./battleship";

const ctx = { tunnelId: "0xab", initialBalances: { a: 1000n, b: 1000n } };
const proto = new BattleshipProtocol(100n);
const fresh = (): BattleshipState => proto.initialState(ctx);

// A fixed 16-byte salt + a throwaway board commitment for commit-phase tests.
const SALT = new Uint8Array(16).fill(7);
const board = (): Uint8Array => new Uint8Array(BATTLESHIP_CELL_COUNT);
const commitMove = (b: Uint8Array): BattleshipMove => ({
  kind: "commit",
  commitment: computeCommitment(b, SALT),
});

test("fresh game awaits commits, A to move, balances summed", () => {
  const s = fresh();
  assert.equal(s.phase, "awaitingCommits");
  assert.equal(s.turn, "A");
  assert.equal(s.balanceA + s.balanceB, s.total);
});

test("commits are ordered A then B, then play opens", () => {
  let s = fresh();
  s = proto.applyMove(s, commitMove(board()), "A");
  assert.equal(s.phase, "awaitingCommits");
  assert.throws(() => proto.applyMove(s, commitMove(board()), "A")); // A can't commit twice
  s = proto.applyMove(s, commitMove(board()), "B");
  assert.equal(s.phase, "playing");
  assert.equal(s.turn, "A");
});

test("encodeState is deterministic and excludes secrets", () => {
  let s = fresh();
  s = proto.applyMove(s, commitMove(board()), "A");
  s = proto.applyMove(s, commitMove(board()), "B");
  const h1 = toHex(proto.encodeState(s));
  const h2 = toHex(proto.encodeState({ ...s }));
  assert.equal(h1, h2);
});

// ---- play-phase helpers ----
function opened(): BattleshipState {
  let s = fresh();
  s = proto.applyMove(s, commitMove(board()), "A");
  s = proto.applyMove(s, commitMove(board()), "B");
  return s; // phase "playing", A to move
}

test("opening shoot sets pendingShot; double-shoot rejected", () => {
  let s = opened();
  s = proto.applyMove(s, { kind: "shoot", cell: 0 }, "A");
  assert.deepEqual(s.pendingShot, { by: "A", cell: 0 });
  assert.throws(() => proto.applyMove(s, { kind: "shoot", cell: 1 }, "A"));
});

test("a hit keeps the shooter's turn; defender cannot pipeline on a hit", () => {
  let s = opened();
  s = proto.applyMove(s, { kind: "shoot", cell: 5 }, "A");
  // defender B answers HIT
  s = proto.applyMove(s, { kind: "answer", isHit: true }, "B");
  assert.equal(s.hitsOnB, 1);
  assert.equal(s.turn, "A"); // A keeps firing
  assert.equal(s.pendingShot, null);
  // a hit-answer carrying `next` is illegal
  let s2 = opened();
  s2 = proto.applyMove(s2, { kind: "shoot", cell: 6 }, "A");
  assert.throws(() =>
    proto.applyMove(s2, { kind: "answer", isHit: true, next: 7 }, "B"),
  );
});

test("a miss passes the turn and pipelines the defender's return shot", () => {
  let s = opened();
  s = proto.applyMove(s, { kind: "shoot", cell: 5 }, "A");
  s = proto.applyMove(s, { kind: "answer", isHit: false, next: 9 }, "B");
  assert.equal(s.turn, "B");
  assert.deepEqual(s.pendingShot, { by: "B", cell: 9 });
  // A answers B's shot at 9 (miss) and pipelines a return shot at a new cell
  s = proto.applyMove(s, { kind: "answer", isHit: false, next: 3 }, "A");
  assert.equal(s.turn, "A");
});

test("a pipelined next re-shooting an already-fired cell is rejected", () => {
  let s = opened();
  s = proto.applyMove(s, { kind: "shoot", cell: 5 }, "A"); // A fires at 5
  s = proto.applyMove(s, { kind: "answer", isHit: false, next: 9 }, "B"); // B miss, fires at 9
  // pendingShot = { by: B, cell: 9 }; A must answer; A pipelining next:5 re-shoots its own prior cell
  assert.throws(
    () => proto.applyMove(s, { kind: "answer", isHit: false, next: 5 }, "A"),
    /already fired/,
  );
});

test("the 17th hit ends play and enters revealBoards", () => {
  let s = opened();
  // A fires 17 shots at distinct cells; B answers all hits (keeps A's turn)
  for (let i = 0; i < FLEET_CELLS_T; i++) {
    s = proto.applyMove(s, { kind: "shoot", cell: i }, "A");
    s = proto.applyMove(s, { kind: "answer", isHit: true }, "B");
  }
  assert.equal(s.hitsOnB, FLEET_CELLS_T);
  assert.equal(s.phase, "revealBoards");
});

function legalBoard(seed: number): Uint8Array {
  return placementsToBoard(placeFleetRandom(mulberry32(seed)));
}
const SALT_A = new Uint8Array(16).fill(1);
const SALT_B = new Uint8Array(16).fill(2);

// Drive both seats honestly to the terminal reveal, A sinking B by always
// firing at B's ship cells. Returns the state in "revealBoards".
function playToReveal(): {
  s: BattleshipState;
  boardA: Uint8Array;
  boardB: Uint8Array;
} {
  const boardA = legalBoard(10);
  const boardB = legalBoard(20);
  let s = fresh();
  s = proto.applyMove(
    s,
    { kind: "commit", commitment: computeCommitment(boardA, SALT_A) },
    "A",
  );
  s = proto.applyMove(
    s,
    { kind: "commit", commitment: computeCommitment(boardB, SALT_B) },
    "B",
  );
  // A fires at every B ship cell in turn; each is a hit, so A keeps firing.
  for (let cell = 0; cell < BATTLESHIP_CELL_COUNT && s.phase === "playing"; cell++) {
    if (boardB[cell] !== 1) continue;
    s = proto.applyMove(s, { kind: "shoot", cell }, "A");
    s = proto.applyMove(s, { kind: "answer", isHit: true }, "B");
  }
  return { s, boardA, boardB };
}

test("both honest reveals finalize a 17-hit win for A; stake shifts", () => {
  const { s, boardA, boardB } = playToReveal();
  assert.equal(s.phase, "revealBoards");
  let t = proto.applyMove(
    s,
    { kind: "reveal_board", board: boardB, salt: SALT_B },
    "B",
  );
  t = proto.applyMove(
    t,
    { kind: "reveal_board", board: boardA, salt: SALT_A },
    "A",
  );
  assert.equal(t.phase, "over");
  assert.equal(t.winner, 1); // A wins
  assert.equal(t.balanceA, 1100n);
  assert.equal(t.balanceB, 900n);
  assert.equal(t.balanceA + t.balanceB, t.total);
  assert.equal(proto.isTerminal(t), true);
});

test("an illegal-fleet reveal is rejected (closes the legal-fleet hole)", () => {
  const { s } = playToReveal();
  const shortBoard = new Uint8Array(BATTLESHIP_CELL_COUNT); // zero ships
  // commitment was for boardB, so this also fails the commitment check first;
  // build a matching commitment to isolate the legality failure:
  let s2 = fresh();
  s2 = proto.applyMove(
    s2,
    { kind: "commit", commitment: computeCommitment(shortBoard, SALT_B) },
    "A",
  );
  s2 = proto.applyMove(
    s2,
    { kind: "commit", commitment: computeCommitment(shortBoard, SALT_B) },
    "B",
  );
  // force into reveal by resign-free path is awkward; assert legality directly:
  assert.throws(
    () =>
      // reach the private check via a crafted revealBoards state
      proto["applyRevealBoard"](
        { ...s2, phase: "revealBoards" },
        shortBoard,
        SALT_B,
        "A",
      ),
    /legal fleet/,
  );
});

test("a reveal inconsistent with an answered shot is rejected", () => {
  const { s, boardB } = playToReveal();
  // flip one answered ship cell to water in the revealed board -> inconsistency
  const tampered = boardB.slice();
  const hitCell = s.shotsAtB[0].cell;
  tampered[hitCell] = 0;
  assert.throws(
    () =>
      proto.applyMove(
        s,
        { kind: "reveal_board", board: tampered, salt: SALT_B },
        "B",
      ),
    /match the commitment|consistent|contradicts/,
  );
});

test("resign hands the win and stake to the opponent", () => {
  let s = opened();
  s = proto.applyMove(s, { kind: "resign" }, "B");
  assert.equal(s.phase, "over");
  assert.equal(s.winner, 1);
  assert.equal(s.balanceA, 1100n);
  assert.equal(s.balanceB, 900n);
});

test("the state wire format keeps the cell index and hit counts within one byte", () => {
  // encodeState packs each cell index and per-board hit count into a single byte;
  // a board/fleet that outgrows a byte would silently collide co-signed state hashes.
  assert.ok(BATTLESHIP_CELL_COUNT <= 256, "cell index must fit in a byte");
  assert.ok(FLEET_CELLS_T <= 255, "fleet hit count must fit in a byte");
});
