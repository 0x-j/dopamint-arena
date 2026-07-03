/**
 * Spec registry wiring. Each game self-registers via `defineGame` at module load (design §3.1),
 * so this module only imports the spec modules for their side-effects. Lookups go through
 * `getSpec`, re-exported here so the worker's import site (`./specs/registry`) stays stable and
 * importing this module guarantees every in-scope spec is registered first.
 *
 * DO NOT tree-shake these imports. They have NO named bindings used here — their whole purpose is
 * the `defineGame(...)` side-effect that runs on module load — so a tree-shaker that drops
 * "unused" side-effectful imports would silently unregister every game (getSpec → undefined →
 * "engine not ready for game"). This relies on frontend/package.json having NO `"sideEffects":
 * false` (it doesn't): that field would mark these modules side-effect-free and license their
 * removal. If you ever add `"sideEffects"`, list the spec modules (or this file) as having effects.
 */
import "@/games/bombIt/bombItSpec";
import "@/games/chickenCross/chickenCrossSpec";
import "@/games/worldCanvas/worldCanvasSpec";
import "@/games/battleship/battleshipSpec";
import "@/games/ticTacToe/tttCaroPvpSpec"; // ttt + caro PvP (defineGame side-effect)
import "@/games/quantumPoker/quantumPokerPvpSpec";
import "@/games/blackjack/blackjackPvpSpec";

export { getSpec } from "./defineGame";
