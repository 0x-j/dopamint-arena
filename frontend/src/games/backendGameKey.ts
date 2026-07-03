import { get as getGameModule } from "./registry";

/**
 * The backend keys `perGame` by the `game` string a match registers under, which is NOT always the
 * FE registry id. Two sources of drift:
 *   1. Arena one-sig games count under their underscore `arenaGameId` (e.g. `quantum_poker`) — the
 *      key `routes.rs` seeds into the MatchRecord the relay counts against.
 *   2. Legacy matchmaking games have no `arenaGameId`; tic-tac-toe counts under `tictactoe`.
 * Without bridging both, a per-game rate lookup misses the hyphen registry id and shows nothing.
 */
const BACKEND_GAME_KEY: Record<string, string> = { "tic-tac-toe": "tictactoe" };

/** Resolve a FE registry gameId to the key the backend's `perGame` feed uses. */
export function backendGameKey(gameId: string): string {
  // arenaGameId may be an array when one module hosts multiple protocols (tic-tac-toe + caro); the
  // caller can't tell which variant a window shows, so key off the first (the module's primary).
  const arena = getGameModule(gameId)?.arenaGameId;
  const arenaId = Array.isArray(arena) ? arena[0] : arena;
  return arenaId ?? BACKEND_GAME_KEY[gameId] ?? gameId;
}
