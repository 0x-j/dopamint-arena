import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../core/bytes";
import { ed25519Address, generateKeyPair } from "../core/crypto";
import { OffchainTunnel, verifyCoSignedUpdate } from "../core/tunnel";
import { mulberry32 } from "../sim/rng";
import { Party } from "./Protocol";
import {
  commitSlotSecrets,
  deriveQuantumCard,
  evaluate5,
  PokerMove,
  PokerState,
  QuantumPokerProtocol,
  QuantumPokerSeatDriver,
  SlotSecret,
} from "./quantumPoker";
import { pokerMoveFromJson, pokerMoveToJson } from "./quantumPokerCodec";

function secrets(base: number): SlotSecret[] {
  return Array.from({ length: 9 }, (_, slot) => ({
    value: Uint8Array.from({ length: 32 }, (_, i) => (base + slot + i) & 0xff),
    salt: Uint8Array.from(
      { length: 16 },
      (_, i) => (base * 3 + slot + i) & 0xff
    ),
  }));
}

function reveal(secrets: SlotSecret[], slots: number[]): PokerMove {
  return {
    kind: "reveal_slots",
    slots,
    reveals: slots.map((slot) => secrets[slot]),
  };
}

test("evaluate5 allows duplicates and ranks Five of a Kind above Straight Flush", () => {
  const fiveKind = evaluate5([0, 13, 26, 39, 0]);
  const straightFlush = evaluate5([8, 9, 10, 11, 12]);
  const quads = evaluate5([0, 13, 26, 39, 1]);
  const pair = evaluate5([0, 13, 28, 42, 9]);
  assert.ok(fiveKind > straightFlush);
  assert.ok(straightFlush > quads);
  assert.ok(quads > pair);
  assert.doesNotThrow(() => evaluate5([0, 0, 28, 42, 9]));
  assert.throws(() => evaluate5([0, 1, 2, 3, 52]), /out of range/);
});

test("commit move keeps local secrets local and serializes commitments only", () => {
  const rng = mulberry32(1);
  const p = new QuantumPokerProtocol();
  const s = p.initialState({
    tunnelId: "0xaa",
    initialBalances: { a: 1000n, b: 1000n },
  });
  const move = p.randomMove!(s, "A", rng);
  assert.ok(move);
  assert.equal(move.kind, "commit_slots");
  assert.equal(move.commitments.length, 9);
  assert.equal(
    move.commitments.every((c) => c.length === 32),
    true
  );
  assert.ok(move.localSecrets, "local engine keeps secrets for later reveals");

  const json = pokerMoveToJson(move);
  assert.equal(Object.hasOwn(json, "localSecrets"), false);
  assert.deepEqual(pokerMoveFromJson(json), {
    kind: "commit_slots",
    commitments: move.commitments,
  });
});

test("slot reveal mismatch is rejected against commitment", () => {
  const p = new QuantumPokerProtocol();
  const a = secrets(10);
  const b = secrets(80);
  let s = p.initialState({
    tunnelId: "0xab",
    initialBalances: { a: 1000n, b: 1000n },
  });
  s = p.applyMove(
    s,
    { kind: "commit_slots", commitments: commitSlotSecrets(a) },
    "A"
  );
  s = p.applyMove(
    s,
    { kind: "commit_slots", commitments: commitSlotSecrets(b) },
    "B"
  );
  assert.equal(s.phase, "open_private_holes");

  const bad = reveal(a, [2, 3]);
  if (bad.kind !== "reveal_slots") throw new Error("bad test move");
  bad.reveals[0] = { ...bad.reveals[0], value: Uint8Array.of(9) };
  assert.throws(() => p.applyMove(s, bad, "A"), /does not match/);

  const s2 = p.applyMove(s, reveal(a, [2, 3]), "A");
  assert.ok(s2.revealsA[2]);
});

test("seat driver can reveal from persisted local secrets after request boundary", () => {
  const p = new QuantumPokerProtocol();
  const a = secrets(30);
  const b = secrets(130);
  let s = p.initialState({
    tunnelId: "0xad",
    initialBalances: { a: 1000n, b: 1000n },
  });
  s = p.applyMove(
    s,
    { kind: "commit_slots", commitments: commitSlotSecrets(a) },
    "A"
  );
  s = p.applyMove(
    s,
    {
      kind: "commit_slots",
      commitments: commitSlotSecrets(b),
      localSecrets: b,
    },
    "B"
  );
  s = p.applyMove(s, reveal(a, [2, 3]), "A");

  const statelessBot = new QuantumPokerSeatDriver("B");
  const move = statelessBot.makeRevealMove(s);
  assert.ok(move);
  assert.equal(move.kind, "reveal_slots");
  assert.deepEqual(move.slots, [0, 1]);
  assert.deepEqual(move.reveals, [b[0], b[1]]);

  s = p.applyMove(s, move, "B");
  assert.equal(s.phase, "preflop_bet");
  assert.ok(statelessBot.knownHoleCards(s));
});

test("manual hand reaches flop with private holes hidden from encoding", () => {
  const p = new QuantumPokerProtocol();
  const a = secrets(20);
  const b = secrets(120);
  let s = p.initialState({
    tunnelId: "0xac",
    initialBalances: { a: 1000n, b: 1000n },
  });
  s = p.applyMove(
    s,
    {
      kind: "commit_slots",
      commitments: commitSlotSecrets(a),
      localSecrets: a,
    },
    "A"
  );
  s = p.applyMove(
    s,
    {
      kind: "commit_slots",
      commitments: commitSlotSecrets(b),
      localSecrets: b,
    },
    "B"
  );
  s = p.applyMove(s, reveal(a, [2, 3]), "A");
  s = p.applyMove(s, reveal(b, [0, 1]), "B");
  assert.equal(s.phase, "preflop_bet");
  assert.ok(s.holeA && s.holeA.length === 2);
  assert.ok(s.holeB && s.holeB.length === 2);
  assert.equal(s.shownHoleA, null);
  assert.equal(
    toHex(p.encodeState(s)).includes(toHex(Uint8Array.from(s.holeA))),
    false
  );

  s = p.applyMove(s, { kind: "check" }, "A");
  s = p.applyMove(s, { kind: "check" }, "B");
  assert.equal(s.phase, "reveal_flop");
  s = p.applyMove(s, reveal(a, [4, 5, 6]), "A");
  s = p.applyMove(s, reveal(b, [4, 5, 6]), "B");
  assert.equal(s.phase, "flop_bet");
  assert.equal(s.board.length, 3);
  assert.equal(new Set(s.board).size, 3);
});

test("deriveQuantumCard is deterministic and counter-sensitive", () => {
  const a = secrets(1)[4];
  const b = secrets(2)[4];
  assert.equal(deriveQuantumCard(a, b), deriveQuantumCard(a, b));
  // Counters 0/1 may collide (1/52); counter 2 reliably differs for these inputs.
  assert.notEqual(deriveQuantumCard(a, b, 0), deriveQuantumCard(a, b, 2));
});

// Locks the single-sample `mod 52` derivation to exact values. The same fixed reveal
// bytes and expected cards appear in the Rust `derive_quantum_card` parity test, so any
// divergence between the TS and Rust engines fails one side.
test("deriveQuantumCard matches the Rust engine on fixed reveals (parity golden)", () => {
  const a = { value: Uint8Array.from([1, 2, 3, 4]), salt: Uint8Array.from([5, 6, 7, 8]) };
  const b = { value: Uint8Array.from([9, 10, 11]), salt: Uint8Array.from([12, 13]) };
  assert.equal(deriveQuantumCard(a, b, 0), 50);
  assert.equal(deriveQuantumCard(a, b, 1), 1);
  assert.equal(deriveQuantumCard(a, b, 2), 18);
});

test("deriveQuantumCard stays within 0..51 across many inputs", () => {
  for (let x = 0; x < 40; x++) {
    for (let y = 0; y < 40; y++) {
      const card = deriveQuantumCard(secrets(x)[x % 9], secrets(y)[y % 9]);
      assert.ok(card >= 0 && card <= 51, `card ${card} out of range`);
    }
  }
});

test("uneven all-in caps the big stack at the effective stack and stays callable", () => {
  const p = new QuantumPokerProtocol();
  const a = secrets(40);
  const b = secrets(140);
  // Seat B is the short stack (200) vs seat A (1000) — the effective stack is 200.
  let s = p.initialState({
    tunnelId: "0xae",
    initialBalances: { a: 1000n, b: 200n },
  });
  s = p.applyMove(
    s,
    {
      kind: "commit_slots",
      commitments: commitSlotSecrets(a),
      localSecrets: a,
    },
    "A"
  );
  s = p.applyMove(
    s,
    {
      kind: "commit_slots",
      commitments: commitSlotSecrets(b),
      localSecrets: b,
    },
    "B"
  );
  s = p.applyMove(s, reveal(a, [2, 3]), "A");
  s = p.applyMove(s, reveal(b, [0, 1]), "B");
  assert.equal(s.phase, "preflop_bet");
  assert.equal(s.toAct, "A");

  // Effective stack 200 − ante 50 = 150 wagerable. The big stack cannot put in more than the
  // short stack can ever match.
  assert.throws(
    () => p.applyMove(s, { kind: "bet", amount: 151n }, "A"),
    /effective stack/
  );

  // A goes all-in for the effective stack; the short stack can still CALL it — never forced to fold.
  s = p.applyMove(s, { kind: "bet", amount: 150n }, "A");
  assert.equal(s.totalBetA, 200n);
  s = p.applyMove(s, { kind: "call" }, "B");
  assert.equal(s.totalBetB, 200n);
  assert.equal(s.foldedBy, null);
  // The surplus (A's other 800) never entered the pot; the stacks stay conserved.
  assert.equal(s.balanceA + s.balanceB, 1200n);
});

test("full self-play game: balances conserved, five-card board, updates settle", () => {
  const rng = mulberry32(123);
  const a = generateKeyPair();
  const b = generateKeyPair();
  const t = OffchainTunnel.selfPlay(
    new QuantumPokerProtocol(20n),
    "0x" + "44".repeat(32),
    a,
    b,
    ed25519Address(a.publicKey),
    ed25519Address(b.publicKey),
    { a: 10_000n, b: 10_000n }
  );
  const total = t.total;
  let completedShowdownOrFold = false;
  let steps = 0;
  while (steps < 10_000 && t.state.phase !== "done") {
    let moved = false;
    for (const party of ["A", "B"] as Party[]) {
      const m = t.protocol.randomMove!(t.state, party, rng);
      if (m) {
        t.step(m as PokerMove, party);
        moved = true;
        steps++;
        const bal = t.protocol.balances(t.state);
        assert.equal(bal.a + bal.b, total);
        const ps = t.state as PokerState;
        if (ps.phase === "hand_over" && ps.lastResult) {
          completedShowdownOrFold = true;
          if (ps.lastResult.reason === "showdown") {
            assert.equal(ps.board.length, 5);
            assert.equal(new Set(ps.board).size, 5);
          }
        }
        break;
      }
    }
    if (!moved) break;
  }
  assert.ok(completedShowdownOrFold);
  assert.ok(t.latest);
  assert.ok(
    verifyCoSignedUpdate(
      t.latest!,
      { publicKey: t.partyA.publicKey, scheme: t.partyA.scheme },
      { publicKey: t.partyB.publicKey, scheme: t.partyB.scheme }
    )
  );
});

test("split pot (showdown tie) leaves BOTH stacks unchanged — neither loses chips", () => {
  let ties = 0;
  for (let seed = 1; seed <= 400 && ties < 3; seed++) {
    const rng = mulberry32(seed);
    const a = generateKeyPair();
    const b = generateKeyPair();
    const t = OffchainTunnel.selfPlay(
      new QuantumPokerProtocol(50n),
      "0x" + "55".repeat(32),
      a,
      b,
      ed25519Address(a.publicKey),
      ed25519Address(b.publicKey),
      { a: 10_000n, b: 10_000n }
    );
    let preA = (t.state as PokerState).balanceA;
    let preB = (t.state as PokerState).balanceB;
    let handNo = (t.state as PokerState).handNo;
    let steps = 0;
    while (steps < 20_000 && t.state.phase !== "done") {
      const before = t.state as PokerState;
      if (before.handNo !== handNo) {
        handNo = before.handNo; // new hand starting — snapshot the pre-hand stacks
        preA = before.balanceA;
        preB = before.balanceB;
      }
      let moved = false;
      for (const party of ["A", "B"] as Party[]) {
        const m = t.protocol.randomMove!(t.state, party, rng);
        if (m) {
          t.step(m as PokerMove, party);
          steps++;
          moved = true;
          const cur = t.state as PokerState;
          if (cur.phase === "hand_over" && cur.lastResult?.winner === "tie") {
            // The split-pot case the user flagged: on a tie, neither seat should be deducted —
            // both stacks must equal what they held when the hand began.
            assert.equal(cur.balanceA, preA, `tie deducted A (seed ${seed})`);
            assert.equal(cur.balanceB, preB, `tie deducted B (seed ${seed})`);
            ties++;
          }
          break;
        }
      }
      if (!moved) break;
    }
  }
  assert.ok(ties > 0, "no showdown tie sampled — widen the seed range");
});

test("a flush is ranked by its high cards, not by a duplicate-rank pair", () => {
  // Virtual-deck duplicates are legal, so a flush can contain a repeated card.
  // Both hands are hearts (suit 0). The first has high card K (12) with a low
  // pair of 5s; the second's high card is only J (11). The K-high flush must win.
  const kHighFlushWithLowPair = [12, 5, 5, 4, 2];
  const jHighFlush = [11, 8, 6, 4, 2];
  assert.ok(
    evaluate5(kHighFlushWithLowPair) > evaluate5(jHighFlush),
    "K-high flush must beat J-high flush despite the low pair",
  );
});

test("first actor alternates by hand so neither seat keeps a positional edge", () => {
  const p = new QuantumPokerProtocol();
  const commit = (s: PokerState, sec: SlotSecret[], by: Party) =>
    p.applyMove(
      s,
      { kind: "commit_slots", commitments: commitSlotSecrets(sec), localSecrets: sec },
      by,
    );
  const toPreflop = (s: PokerState, a: SlotSecret[], b: SlotSecret[]) => {
    s = commit(s, a, "A");
    s = commit(s, b, "B");
    s = p.applyMove(s, reveal(a, [2, 3]), "A");
    s = p.applyMove(s, reveal(b, [0, 1]), "B");
    return s;
  };

  let s = p.initialState({ tunnelId: "0xalt", initialBalances: { a: 1000n, b: 1000n } });
  s = toPreflop(s, secrets(1), secrets(2));
  assert.equal(s.phase, "preflop_bet");
  assert.equal(s.toAct, "A", "hand 0 (even): A acts first");

  // Finish hand 0 quickly (first actor folds), advance to hand 1.
  s = p.applyMove(s, { kind: "fold" }, "A");
  assert.equal(s.phase, "hand_over");
  s = p.applyMove(s, { kind: "next_hand" }, "A");
  assert.equal(s.handNo, 1n);

  s = toPreflop(s, secrets(3), secrets(4));
  assert.equal(s.phase, "preflop_bet");
  assert.equal(s.toAct, "B", "hand 1 (odd): B acts first — alternated");
});
