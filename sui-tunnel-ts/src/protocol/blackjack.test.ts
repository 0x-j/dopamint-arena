import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCommitment } from "../core/commitment";
import {
  BlackjackMove,
  BlackjackProtocol,
  BlackjackSlotSecret,
  BlackjackState,
  FIXED_PLAYER_A,
  MIN_BET,
  actorFor,
  deriveRank,
  getDealerParty,
  getPlayerParty,
  blackjackHandValue as handValue,
} from "./blackjack";

const proto = new BlackjackProtocol();
const ctx = { tunnelId: "0xab", initialBalances: { a: 1000n, b: 1000n } };
const fresh = (): BlackjackState => proto.initialState(ctx);

// ---- shared test helpers (used by later tasks too) ----
function secret(valueByte: number, saltByte = valueByte): BlackjackSlotSecret {
  return {
    value: Uint8Array.from([valueByte & 0xff]),
    salt: new Uint8Array(16).fill(saltByte & 0xff),
  };
}
function commitMove(s: BlackjackSlotSecret): BlackjackMove {
  return {
    kind: "commit",
    commitment: computeCommitment(s.value, s.salt),
    localSecret: s,
  };
}
function revealMove(s: BlackjackSlotSecret): BlackjackMove {
  return { kind: "reveal", reveal: s };
}
/** Run one full card draw (both commit, both reveal) on an in-progress draw. */
function doDraw(
  s: BlackjackState,
  sa: BlackjackSlotSecret,
  sb: BlackjackSlotSecret,
): BlackjackState {
  s = proto.applyMove(s, commitMove(sa), "A");
  s = proto.applyMove(s, commitMove(sb), "B");
  s = proto.applyMove(s, revealMove(sa), "A");
  s = proto.applyMove(s, revealMove(sb), "B");
  return s;
}
/** Find a secret pair whose derived rank equals `rank` (for deterministic hands). */
function secretsForRank(
  rank: number,
): [BlackjackSlotSecret, BlackjackSlotSecret] {
  for (let i = 0; i < 1 << 16; i++) {
    const a = secret(i & 0xff, (i >> 4) & 0xff);
    const b = secret((i >> 8) & 0xff, (i >> 12) & 0xff);
    if (deriveRank(a, b) === rank) return [a, b];
  }
  throw new Error(`no secrets found for rank ${rank}`);
}

export {
  commitMove,
  ctx,
  doDraw,
  fresh,
  proto,
  revealMove,
  secret,
  secretsForRank,
};

/** Fixed bet used by the round-playing tests. */
const BET = 100n;
/** Place the next round's bet as the correct player, entering draw_commit. */
function placeBet(s: BlackjackState, amount = BET): BlackjackState {
  const by = getPlayerParty(s.round + 1n);
  return proto.applyMove(s, { kind: "bet", amount }, by);
}

test("deriveRank is deterministic and within 1..13", () => {
  const a = secret(7),
    b = secret(42);
  const r1 = deriveRank(a, b);
  const r2 = deriveRank(a, b);
  assert.equal(r1, r2);
  assert.ok(r1 >= 1 && r1 <= 13, `rank ${r1} out of range`);
});

test("deriveRank depends on both shares (neither can be ignored)", () => {
  // Hold A fixed and vary B: a derivation that ignored B would yield one constant rank.
  const ranksFixedA = new Set<number>();
  for (let i = 0; i < 200; i++)
    ranksFixedA.add(deriveRank(secret(7), secret(i)));
  assert.ok(
    ranksFixedA.size > 1,
    `rank ignores share B: ${ranksFixedA.size} distinct ranks for a fixed A`,
  );
  // Symmetrically, hold B fixed and vary A.
  const ranksFixedB = new Set<number>();
  for (let i = 0; i < 200; i++)
    ranksFixedB.add(deriveRank(secret(i), secret(7)));
  assert.ok(
    ranksFixedB.size > 1,
    `rank ignores share A: ${ranksFixedB.size} distinct ranks for a fixed B`,
  );
});

test("initialState waits at round_over for the first bet", () => {
  const s = fresh();
  assert.equal(s.phase, "round_over");
  assert.equal(s.round, 0n);
  assert.equal(s.bet, 0n);
  assert.equal(s.total, 2000n);
  assert.ok(!proto.isTerminal(s));
});

test("initialState is terminal when neither side can fund MIN_BET", () => {
  const s = proto.initialState({
    tunnelId: "0xab",
    initialBalances: { a: 10n, b: 1000n },
  });
  assert.equal(s.phase, "round_over");
  assert.ok(proto.isTerminal(s));
});

test("getPlayerParty / getDealerParty alternate by round", () => {
  assert.equal(getPlayerParty(1n), "A");
  assert.equal(getDealerParty(1n), "B");
  assert.equal(getPlayerParty(3n), "B");
  assert.equal(getDealerParty(3n), "A");
});

test("both commits advance draw_commit -> draw_reveal", () => {
  let s = placeBet(fresh());
  s = proto.applyMove(s, commitMove(secret(1)), "A");
  assert.equal(s.phase, "draw_commit");
  assert.ok(s.pendingCommitA && !s.pendingCommitB);
  s = proto.applyMove(s, commitMove(secret(2)), "B");
  assert.equal(s.phase, "draw_reveal");
  assert.ok(s.pendingCommitA && s.pendingCommitB);
});

test("a party cannot commit twice for the same card", () => {
  let s = placeBet(fresh());
  s = proto.applyMove(s, commitMove(secret(1)), "A");
  assert.throws(
    () => proto.applyMove(s, commitMove(secret(9)), "A"),
    /already committed/,
  );
});

test("bet from round_over starts the next round in draw_commit", () => {
  const over: BlackjackState = { ...fresh(), phase: "round_over", round: 2n };
  // round 2 just ended → next player is getPlayerParty(3) = "B".
  const s = proto.applyMove(over, { kind: "bet", amount: BET }, "B");
  assert.equal(s.phase, "draw_commit");
  assert.equal(s.round, 3n);
  assert.equal(s.bet, BET);
  assert.deepEqual(s.draw, { forHand: "player", reason: "deal" });
});

test("a non-bet move is rejected in round_over", () => {
  const over: BlackjackState = { ...fresh(), phase: "round_over", round: 2n };
  assert.throws(
    () => proto.applyMove(over, { kind: "hit" }, "B"),
    /expected 'bet'/,
  );
});

test("only the next player may place the bet", () => {
  const over: BlackjackState = { ...fresh(), phase: "round_over", round: 2n };
  // next player is B; A attempting to bet is rejected.
  assert.throws(
    () => proto.applyMove(over, { kind: "bet", amount: BET }, "A"),
    /only the player/,
  );
});

test("opening deal hides the dealer hole: player phase with 2 player + 1 dealer card", () => {
  let s = placeBet(fresh());
  // Three cards dealt: player, player, dealer up-card. The dealer's hole is NOT
  // dealt now — it stays hidden until the player stands (no info edge for the player).
  for (let i = 0; i < 3; i++) {
    assert.equal(
      s.phase,
      "draw_commit",
      `card ${i} should start in draw_commit`,
    );
    s = doDraw(s, secret(i * 2 + 1), secret(i * 2 + 2));
  }
  assert.equal(s.phase, "player");
  assert.equal(s.playerHand.length, 2);
  assert.equal(s.dealerHand.length, 1, "only the dealer's up-card is dealt");
  assert.equal(s.drawCount, 3n);
  assert.equal(s.draw, null);
});

test("the dealer's hole is drawn only after the player stands", () => {
  let s = placeBet(fresh());
  for (let i = 0; i < 3; i++) s = doDraw(s, secret(i * 2 + 1), secret(i * 2 + 2));
  assert.equal(s.phase, "player");
  assert.equal(s.dealerHand.length, 1);
  const player = actorFor(s);
  s = proto.applyMove(s, { kind: "stand" }, player!);
  // The hole card is drawn now (post-stand), not during the deal.
  assert.equal(s.phase, "draw_commit");
  assert.deepEqual(s.draw, { forHand: "dealer", reason: "dealer_auto" });
});

test("a reveal that does not match its commitment is rejected", () => {
  let s = placeBet(fresh());
  s = proto.applyMove(s, commitMove(secret(1)), "A");
  s = proto.applyMove(s, commitMove(secret(2)), "B");
  assert.equal(s.phase, "draw_reveal");
  // Reveal a DIFFERENT secret than A committed.
  assert.throws(
    () => proto.applyMove(s, revealMove(secret(99)), "A"),
    /does not match commitment/,
  );
});

test("encodeState is stable for the same state", () => {
  let s = placeBet(fresh());
  s = doDraw(s, secret(1), secret(2));
  assert.equal(toHex(proto.encodeState(s)), toHex(proto.encodeState(s)));
});

test("encodeState distinguishes states differing in a single field", () => {
  const base = fresh();
  const enc = (s: BlackjackState) => toHex(proto.encodeState(s));
  // Every field the per-card draw machinery added must affect the encoding, or two
  // distinct states could collide to the same co-signed state hash.
  assert.notEqual(enc(base), enc({ ...base, drawCount: base.drawCount + 1n }));
  assert.notEqual(enc(base), enc({ ...base, bet: base.bet + 1n }));
  assert.notEqual(
    enc(base),
    enc({ ...base, playerHand: [...base.playerHand, 10] }),
  );
  assert.notEqual(
    enc(base),
    enc({ ...base, pendingCommitA: new Uint8Array(32).fill(1) }),
  );
  assert.notEqual(
    enc(base),
    enc({ ...base, draw: { forHand: "dealer", reason: "hit" } }),
  );
});

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/** Opening deal with forced cards: player 10+10=20, dealer 5+5=10 (deterministic). */
function dealtToPlayer(): BlackjackState {
  let s = placeBet(fresh());
  const [ta, tb] = secretsForRank(13); // King -> value 10
  const [fa, fb] = secretsForRank(5); // value 5
  s = doDraw(s, ta, tb); // player card 1 = 10
  s = doDraw(s, ta, tb); // player card 2 = 10  (duplicate rank is fine)
  s = doDraw(s, fa, fb); // dealer up-card = 5  -> player phase (hole still hidden)
  return s;
}

test("hit deals one more player card and returns to player phase", () => {
  let s = dealtToPlayer();
  assert.equal(s.phase, "player");
  s = proto.applyMove(s, { kind: "hit" }, "A");
  assert.equal(s.phase, "draw_commit");
  assert.deepEqual(s.draw, { forHand: "player", reason: "hit" });
  // Force the hit card to an Ace (value 11 -> soft, 10+10+11 busts? no: 31 -> aces down -> 21).
  const [aa, ab] = secretsForRank(1);
  s = doDraw(s, aa, ab);
  assert.equal(s.phase, "player"); // 10 + 10 + Ace = 21, not bust
  assert.equal(s.playerHand.length, 3);
});

test("hitting into a bust settles the round to the dealer", () => {
  let s = dealtToPlayer(); // player has 10 + 10 = 20
  s = proto.applyMove(s, { kind: "hit" }, "A");
  const [na, nb] = secretsForRank(5); // value 5 -> 25, bust
  s = doDraw(s, na, nb);
  assert.equal(s.phase, "round_over");
  // Round 1 -> player is A, dealer is B; player busts -> B wins the wager.
  assert.equal(s.balanceB, 1000n + BET);
  assert.equal(s.balanceA, 1000n - BET);
  assert.equal(s.balanceA + s.balanceB, s.total);
});

test("stand kicks off the dealer auto-draw", () => {
  let s = dealtToPlayer();
  s = proto.applyMove(s, { kind: "stand" }, "A");
  assert.equal(s.phase, "draw_commit");
  assert.deepEqual(s.draw, { forHand: "dealer", reason: "dealer_auto" });
});

test("only the player party may hit", () => {
  const s = dealtToPlayer(); // round 1 -> player is A
  assert.throws(
    () => proto.applyMove(s, { kind: "hit" }, "B"),
    /player's \(A\) turn/,
  );
});

/** From a player-phase state, stand and run dealer auto-draws (all forced to `rank`). */
function standAndResolve(
  s: BlackjackState,
  dealerRank: number,
): BlackjackState {
  s = proto.applyMove(s, { kind: "stand" }, "A");
  const [da, db] = secretsForRank(dealerRank);
  let guard = 0;
  while (s.phase !== "round_over") {
    if (guard++ > 100) throw new Error("dealer loop did not terminate");
    s = doDraw(s, da, db);
  }
  return s;
}

test("dealer draws until reaching at least 17, then settles", () => {
  let s = dealtToPlayer(); // player 20, dealer 10
  s = standAndResolve(s, 5); // dealer 10 -> 15 -> 20, stops at >= 17
  assert.equal(s.phase, "round_over");
  assert.ok(handValue(s.dealerHand) >= 17);
});

test("player 20 beats dealer 19 -> player (A) wins", () => {
  let s = dealtToPlayer(); // player 20, dealer 10
  s = standAndResolve(s, 9); // dealer 10 -> 19, stops; 20 > 19 -> A wins
  assert.equal(s.balanceA, 1000n + BET);
  assert.equal(s.balanceB, 1000n - BET);
  assert.equal(s.balanceA + s.balanceB, s.total);
});

test("dealer busts -> player (A) wins", () => {
  let s = placeBet(fresh());
  const [k1, k2] = secretsForRank(13); // value 10
  const [s6a, s6b] = secretsForRank(6); // value 6
  s = doDraw(s, k1, k2); // player 10
  s = doDraw(s, k1, k2); // player 20
  s = doDraw(s, s6a, s6b); // dealer up-card 6
  s = standAndResolve(s, 13); // hole + draws: 6 + 10 + 10 = 26 -> bust -> A wins
  assert.equal(s.phase, "round_over");
  assert.equal(s.balanceA, 1000n + BET);
  assert.equal(s.balanceB, 1000n - BET);
});

test("equal final totals push (no transfer)", () => {
  let s = dealtToPlayer(); // player 20, dealer up-card 5
  s = standAndResolve(s, 5); // dealer 5 + 5 + 5 + 5 = 20; 20 == 20 -> push
  assert.equal(s.phase, "round_over");
  assert.equal(s.balanceA, 1000n);
  assert.equal(s.balanceB, 1000n);
});

test("handValue handles soft aces", () => {
  assert.equal(handValue([11, 11]), 12); // A + A = 12, not 22
  assert.equal(handValue([11, 10]), 21);
  assert.equal(handValue([11, 5, 10]), 16); // ace downgraded
});

test("a party that committed can forfeit the round when the opponent does not", () => {
  let s = placeBet(fresh()); // round 1, draw_commit, deal player card
  s = proto.applyMove(s, commitMove(secret(1)), "A"); // A committed, B has not
  s = proto.applyMove(s, { kind: "forfeit" }, "A"); // A claims B's no-show
  assert.equal(s.phase, "round_over");
  assert.equal(s.balanceA, 1000n + BET);
  assert.equal(s.balanceB, 1000n - BET);
});

test("forfeit is rejected when the opponent does not owe the pending step", () => {
  let s = placeBet(fresh());
  // Neither has committed -> A has not done its part, cannot claim.
  assert.throws(
    () => proto.applyMove(s, { kind: "forfeit" }, "A"),
    /opponent does not owe/,
  );
});

test("forfeit works in the reveal phase too", () => {
  let s = placeBet(fresh());
  s = proto.applyMove(s, commitMove(secret(1)), "A");
  s = proto.applyMove(s, commitMove(secret(2)), "B"); // -> draw_reveal
  s = proto.applyMove(s, revealMove(secret(1)), "A"); // A revealed, B has not
  s = proto.applyMove(s, { kind: "forfeit" }, "A");
  assert.equal(s.phase, "round_over");
  assert.equal(s.balanceA, 1000n + BET);
});

/** Which party owes the next move in the current phase, or null if none/terminal. */
function owed(s: BlackjackState): "A" | "B" | null {
  if (proto.isTerminal(s)) return null;
  switch (s.phase) {
    case "round_over":
      return getPlayerParty(s.round + 1n);
    case "draw_commit":
      return !s.pendingCommitA ? "A" : !s.pendingCommitB ? "B" : null;
    case "draw_reveal":
      return !s.pendingRevealA ? "A" : !s.pendingRevealB ? "B" : null;
    case "player":
      return getPlayerParty(s.round);
  }
}

test("randomMove drives a full game to a terminal state with conserved balances", () => {
  let s = fresh();
  let rngState = 12345;
  const rng = () => {
    // deterministic LCG so the test is reproducible
    rngState = (1103515245 * rngState + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };
  let steps = 0;
  while (!proto.isTerminal(s) && steps < 200000) {
    const by = owed(s);
    if (!by) break;
    const move = proto.randomMove(s, by, rng);
    assert.ok(
      move,
      `randomMove returned null for owed party ${by} in ${s.phase}`,
    );
    s = proto.applyMove(s, move, by);
    steps++;
  }
  assert.ok(proto.isTerminal(s));
  assert.equal(s.balanceA + s.balanceB, s.total);
  assert.ok(s.balanceA >= 0n && s.balanceB >= 0n);
});

test("a bet below MIN_BET is rejected", () => {
  const s = fresh();
  const by = getPlayerParty(s.round + 1n);
  assert.throws(
    () => proto.applyMove(s, { kind: "bet", amount: MIN_BET - 1n }, by),
    /bet must be in/,
  );
});

test("a bet above maxBet is rejected", () => {
  const s = proto.initialState({
    tunnelId: "0xab",
    initialBalances: { a: 300n, b: 1000n },
  });
  const by = getPlayerParty(s.round + 1n);
  // maxBet = min(300, 1000) = 300; betting 301 is rejected.
  assert.throws(
    () => proto.applyMove(s, { kind: "bet", amount: 301n }, by),
    /bet must be in/,
  );
});

test("settlement transfers exactly the chosen bet", () => {
  // Player 20 vs dealer 19, bet 250 -> player (A) wins 250.
  let s = proto.initialState({
    tunnelId: "0xab",
    initialBalances: { a: 1000n, b: 1000n },
  });
  s = placeBet(s, 250n);
  const [k1, k2] = secretsForRank(13); // value 10
  const [n9a, n9b] = secretsForRank(9); // value 9
  s = doDraw(s, k1, k2); // player 10
  s = doDraw(s, k1, k2); // player 20
  s = doDraw(s, n9a, n9b); // dealer up-card 9
  s = standAndResolve(s, 10); // hole: 9 + 10 = 19; 20 > 19 -> A wins
  assert.equal(s.balanceA, 1250n);
  assert.equal(s.balanceB, 750n);
  assert.equal(s.balanceA + s.balanceB, s.total);
});

test("the game is terminal once neither side can fund MIN_BET", () => {
  // a = 20 (< MIN_BET 25) -> no fundable bet -> terminal at round_over.
  const s = proto.initialState({
    tunnelId: "0xab",
    initialBalances: { a: 20n, b: 1000n },
  });
  assert.equal(s.phase, "round_over");
  assert.ok(proto.isTerminal(s));
  const by = getPlayerParty(s.round + 1n);
  assert.throws(
    () => proto.applyMove(s, { kind: "bet", amount: MIN_BET }, by),
    /game over/,
  );
});

test("randomMove offers a MIN_BET bet for the next player only", () => {
  const s = fresh();
  const player = getPlayerParty(s.round + 1n);
  const dealer = getDealerParty(s.round + 1n);
  assert.deepEqual(proto.randomMove(s, player, Math.random), {
    kind: "bet",
    amount: MIN_BET,
  });
  assert.equal(proto.randomMove(s, dealer, Math.random), null);
});

test("FIXED_PLAYER_A pins the player to seat A across rounds", () => {
  const pinned = new BlackjackProtocol(FIXED_PLAYER_A);
  // Round 3 would normally make B the player (getPlayerParty(3) === "B"); pinned keeps A.
  const over: BlackjackState = { ...fresh(), phase: "round_over", round: 2n };
  // With pinning, the next player is A — A may bet, B may not.
  const s = pinned.applyMove(over, { kind: "bet", amount: 100n }, "A");
  assert.equal(s.phase, "draw_commit");
  assert.equal(s.round, 3n);
  assert.throws(
    () => pinned.applyMove(over, { kind: "bet", amount: 100n }, "B"),
    /only the player/,
  );
});

test("default protocol still rotates (B is the player on round 3)", () => {
  const over: BlackjackState = { ...fresh(), phase: "round_over", round: 2n };
  // default proto: getPlayerParty(3) === "B"
  assert.throws(
    () => proto.applyMove(over, { kind: "bet", amount: 100n }, "A"),
    /only the player/,
  );
  const s = proto.applyMove(over, { kind: "bet", amount: 100n }, "B");
  assert.equal(s.round, 3n);
});

test("FIXED_PLAYER_A makes the pinned player win settle to A", () => {
  // Player (pinned A) 20 vs dealer 19 on round 3 (where default rotation would flip to B).
  const pinned = new BlackjackProtocol(FIXED_PLAYER_A);
  let s: BlackjackState = { ...fresh(), phase: "round_over", round: 2n };
  s = pinned.applyMove(s, { kind: "bet", amount: 100n }, "A"); // round 3, player A pinned
  const [k1, k2] = secretsForRank(13); // 10
  const [f5a, f5b] = secretsForRank(5); // 5
  s = doDraw(s, k1, k2); // A 10
  s = doDraw(s, k1, k2); // A 20
  s = doDraw(s, f5a, f5b); // dealer up-card 5
  s = pinned.applyMove(s, { kind: "stand" }, "A");
  const [n9a, n9b] = secretsForRank(9);
  let guard = 0;
  while (s.phase !== "round_over") {
    if (guard++ > 50) throw new Error("loop");
    s = pinned.applyMove(s, commitMove(n9a), "A");
    s = pinned.applyMove(s, commitMove(n9b), "B");
    s = pinned.applyMove(s, revealMove(n9a), "A");
    s = pinned.applyMove(s, revealMove(n9b), "B");
  }
  // A is the player and won; A gains the bet even though default rotation says B is player on round 3.
  assert.equal(s.balanceA, 1100n);
  assert.equal(s.balanceB, 900n);
});

test("actorFor reports who owes the next move across phases", () => {
  // round_over -> next player (default rotation, round 0 -> player A)
  assert.equal(actorFor(fresh()), "A");
  // draw_commit -> whoever has not committed
  let s = placeBet(fresh()); // draw_commit
  assert.equal(actorFor(s), "A");
  s = proto.applyMove(s, commitMove(secret(1)), "A");
  assert.equal(actorFor(s), "B");
  s = proto.applyMove(s, commitMove(secret(2)), "B"); // -> draw_reveal
  assert.equal(actorFor(s), "A");
  s = proto.applyMove(s, revealMove(secret(1)), "A");
  assert.equal(actorFor(s), "B");
});

test("actorFor honors a playerPartyFor override in the player phase", () => {
  const pinned = new BlackjackProtocol(FIXED_PLAYER_A);
  let s: BlackjackState = { ...fresh(), phase: "round_over", round: 2n };
  s = pinned.applyMove(s, { kind: "bet", amount: 100n }, "A"); // round 3
  // advance to player phase via the opening deal (2 player + 1 dealer up-card)
  const [k1, k2] = secretsForRank(13);
  s = doDraw(s, k1, k2);
  s = doDraw(s, k1, k2);
  s = doDraw(s, k1, k2);
  assert.equal(s.phase, "player");
  assert.equal(actorFor(s, FIXED_PLAYER_A), "A"); // pinned: A acts on round 3
});

test("replaying the same moves yields identical encodeState", () => {
  const moves: Array<{ move: BlackjackMove; by: "A" | "B" }> = [];
  let s = fresh();
  const record = (move: BlackjackMove, by: "A" | "B") => {
    moves.push({ move, by });
    s = proto.applyMove(s, move, by);
  };
  record({ kind: "bet", amount: BET }, getPlayerParty(s.round + 1n));
  for (let i = 0; i < 3; i++) {
    record(commitMove(secret(i + 1)), "A");
    record(commitMove(secret(i + 50)), "B");
    record(revealMove(secret(i + 1)), "A");
    record(revealMove(secret(i + 50)), "B");
  }
  const encoded1 = Buffer.from(proto.encodeState(s)).toString("hex");
  let r = fresh();
  for (const { move, by } of moves) r = proto.applyMove(r, move, by);
  const encoded2 = Buffer.from(proto.encodeState(r)).toString("hex");
  assert.equal(encoded1, encoded2);
});
