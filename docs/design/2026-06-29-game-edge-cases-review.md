# Game protocols — unhandled edge cases (review findings)

- **Status**: Findings (pre-fix)
- **Date**: 2026-06-29
- **Scope**: SDK game protocols on `dev-raid` — `quantumPoker`, `ticTacToe` + `caro`/multi-game, `cross` (chicken-cross), `bombIt`, `battleship`, `worldCanvas`. Resume protocol is tracked separately (`2026-06-29-unified-pvp-resume-protocol-design.md`).

This catalogs concrete edge cases the protocols do not handle, grouped by cross-cutting pattern then ranked by severity. Each item lists `file:line`, the failing scenario, and a fix direction. "Verified" = confirmed against the code during review.

## Cross-cutting patterns

The most valuable findings recur across games — fix the pattern, not one instance.

### Pattern A — Seat-A first-mover / positional bias (systemic) — VERIFIED

Several games hardcode seat **A** to act first every game/street with **no alternation**, so the tunnel opener (always party A) gets a structural advantage in every staked multi-round match.

- Poker: `toAct = "A"` at `quantumPoker.ts:416, 567, 786, 903` — every street, every hand (heads-up should alternate the button per hand).
- TTT multi-game: `turn: "A"` reset each sub-game (`ttt/multiGameProtocol.ts:130`).
- Caro multi-game: `turn: "A"` reset each sub-game (`caro/protocol.ts:168`) — first-move advantage on free-style gomoku is large.

**Fix**: alternate the first-actor by hand/sub-game index (e.g. `index % 2`), threaded through `initialState`/reset and the per-street reset.

### Pattern B — Withholding the terminal move → stuck, on-chain-timeout-dependent

A losing seat can withhold the reveal/co-signature that settles a loss, leaving the game with no in-protocol terminal state; recovery falls to the on-chain dispute/force-close path. Already analysed for blackjack (finding F1). Recurs in: poker (loser never reveals at showdown), battleship (`battleship.ts:295` — `finalize()` needs both `revealedA && revealedB`), cross (tie-stall), bombIt (stall-to-draw). Tied to the on-chain `penalty`/`force_close` backstop (see the F1 forfeit work).

### Pattern C — Salt `MIN_SALT_LEN` not enforced at reveal

Commit-reveal `verifyCommitment` accepts any salt length; only the commit builder enforces `>= 16`. A client bypassing the builder can commit/reveal with a low-entropy salt and grind a favorable outcome. Occurs in blackjack, poker (slots), battleship (`battleship.ts:281`). **Fix**: enforce `salt.length >= MIN_SALT_LEN` on the reveal/verify path (or at commit acceptance).

### Pattern D — With-replacement card derivation → impossible hands

Cards are derived independently (no finite deck), so duplicates are possible. Benign for blackjack (value-only), but **breaks poker hand ranking** (see HIGH-3).

## CRITICAL — exploit (VERIFIED)

### C1. Chicken-cross: a seat can control the opponent's chicken
`cross.ts:319` — `applyMove(state, move, _by)` **ignores `_by`** and steps `move.dirA` for chicken[0] and `move.dirB` for chicken[1] regardless of who is acting. `bombIt.ts:535-538` has the per-party integrity guard; `cross` does not.

**Scenario**: in a staked chicken-cross match, party A submits a co-signed update carrying both `dirA` and `dirB`, steering B's chicken into a lethal cell (or across the finish to force the equal-score push), to deny B's win or steal the pot. A valid, settleable state.

**Fix**: copy bombIt's guard — reject a move that carries the non-acting seat's direction; apply only `by`'s direction, default the opponent to "stay".

## HIGH (VERIFIED)

### H1. Seat-A positional bias
Pattern A above. Systemic fairness defect across poker, TTT, caro.

### H2. WorldCanvas — concurrent paint diverges state; staked but always-draws
`worldCanvas.ts:196-203`.
- **Divergence**: each paint folds `(painter, coords)` into an order-dependent `rollingDigest` with no per-cell sequencing/locking. Two seats applying two paints in different orders compute different digests → state hashes diverge → co-sign fails, with no convergence mechanism.
- **No settlement**: `applyMove` never changes `balanceA/balanceB`, so a staked paint duel always settles as a push — the stake is meaningless (no scoring/coverage attribution).

**Fix**: either (a) make canvas non-staked / explicitly collaborative, or (b) add deterministic move sequencing (per-cell order or a single authoritative stream) **and** a scoring/winner rule before treating it as competitive.

### H3. Poker — flush containing a duplicate-rank pair is mis-ranked
`quantumPoker.ts:1194`. With-replacement derivation (Pattern D) can produce a 5-card same-suit hand that also contains a rank pair. The evaluator classifies it as a flush (category 5) and tiebreaks via `groups.map(g => g[1])`, ordering by the **pair rank** instead of descending high card → two such flushes rank incorrectly → wrong showdown winner.

**Fix**: prevent duplicate ranks per hand at derivation (draw without replacement within a hand), or make the flush tiebreak ignore group-count ordering and compare by descending distinct high cards.

## MEDIUM

### M1. Multi-game — no win tracking; match winner undefined at `stake=0`
`ttt/multiGameProtocol.ts:156` (and caro). Constructor defaults `stake=0n`; with `stake=0` the inner stake swap moves nothing, balances stay equal across the series, and no per-game win counter is stored. A best-of-3 where A wins 2–1 settles identically to B winning 3–0 — per-game results are lost and the match has no determinable winner. **Fix**: track per-game wins in state and settle the series by win count (or require a non-zero stake and rely on cumulative balance).

### M2. Chicken-cross — simultaneous double-arrival tie is not terminal
`cross.ts:385`. Both chickens cross on the same tick with equal scores → `winner=null`, but `isTerminal` is `winner !== null || tick >= TICK_CAP` → false. The race stalls, re-entering the push branch every tick until `TICK_CAP`. **Fix**: treat a both-arrived state as terminal (push) immediately.

### M3. Salt not enforced at reveal — Pattern C (blackjack, poker, battleship).

### M4. bombIt — seat-0 positional priority + stall-to-draw dominant
`bombIt.ts:547` resolves seat 0 before seat 1 each tick, so A wins every contested cell. `bombIt.ts:564`: a passive seat that never bombs and dodges reaches `TICK_CAP` as a draw (stake returned) — stalling is the dominant strategy; the "decisive end" is not forced. **Fix**: resolve contested cells symmetrically (or randomize priority deterministically per tick); add aggression pressure / shrinking arena if a decisive end is desired.

### M5. Poker — uncalled all-in overbet not returned on a tie
`quantumPoker.ts:845`. `resolveShowdown` only `settle`s when `winner != "tie"`; `contestedAmount = min(totalBetA, totalBetB)` is computed but unused on a tie. A showdown reached with `totalBetA != totalBetB` (an uncalled overbet) leaves the over-contributor's uncalled chips neither refunded nor awarded. **Fix**: on a tie (and on any settlement), return the uncalled portion `|totalBetA - totalBetB|` to the over-contributor before splitting.

### M6. Battleship — loser refusing the terminal reveal stalls the game
`battleship.ts:295` — Pattern B. No in-protocol decisive state; relies on on-chain timeout.

## LOW / rules-choices

- **Caro overline (≥6) counts as a win** (`caro/board.ts:67`, `>= 5`): free-style gomoku — a rules decision, but unguarded/unconfigurable. If standard Caro/Renju is intended, an overline must not win.
- **No early series termination** (`caro/protocol.ts:193`): a clinched best-of-N still plays all `maxGames`.
- **Draw via `movesCount` not cross-checked against board** (`ticTacToe.ts:78`, caro:80): `movesCount` is tracked separately and (in caro) omitted from `encodeState`, so a resumed state must recompute it; a mismatch mis-calls a draw. Ties into the resume work.
- **Battleship `encodeState` byte-packs the cell index** (`battleship.ts:368`): correct at 10×10 (cells < 256) but no static assert — a >16×16 board or larger fleet silently truncates the signed byte. Add `static_assert BATTLESHIP_CELL_COUNT <= 256 && FLEET_CELLS < 256`.
- **Poker has no minimum-raise rule** (`quantumPoker.ts:732`): 1-chip raises allowed → micro-raise wars / griefing.
- **Poker `next_hand` has no turn/role check** (`quantumPoker.ts:877`): either party (or a replayed message) can advance `handNo`; add a `by`/idempotency guard.
- **Poker `deriveUniqueBoardCard` can throw mid-hand** (`quantumPoker.ts:628`): 10 000-retry cap with no settle fallback → a (vanishingly unlikely) degenerate seed leaves a stuck channel.
- **Cross — water-lane death on the opponent's tick** (`cross.ts:268`) and **`destOf` clamps an illegal move to a no-op** (`cross.ts:188`): tick-parity asymmetric death; no explicit out-of-bounds rejection (unlike bombIt's `canMoveTo`).

## Verified safe (NOT bugs)

- **Caro diagonal win-scan** decomposes to `(r, c)` with independent `inBounds` checks (`caro/board.ts:55`) → does **not** wrap across row boundaries (the classic flat-array gomoku bug). Correct.
- **Poker pot conservation** (`balanceA + balanceB` constant): balances change only in `settle`, clamped to `min(amount, loserBalance)` with `contestedAmount = min(totalBetA, totalBetB)`. Holds.

## Recommended fix order

1. **C1 (cross opponent-control exploit)** — security, real fund theft on a staked game. Smallest fix (copy bombIt's `by` guard).
2. **H1 / Pattern A (seat-A bias)** — fairness across poker/TTT/caro; alternate first-actor by index.
3. **H2 (canvas)** — decide competitive-vs-collaborative; either add sequencing+scoring or mark non-staked.
4. **H3 (poker flush mis-rank)** — correctness at showdown; fix derivation or the flush tiebreak.
5. Pattern C (salt-at-reveal) and the MEDIUM items as a batch.
