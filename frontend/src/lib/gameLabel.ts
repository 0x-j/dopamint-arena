import { get } from "@/games/registry";

/**
 * Readable label for a transaction-feed row's game id.
 *
 * The two feeds use different id conventions: the live on-chain feed carries the backend ARENA id
 * (underscore, e.g. `bomb_it`, `caro`), while the local "My Activity" feed carries the kebab MODULE
 * id (e.g. `quantum-poker`). Prefer a registered module's own name when the id is one; otherwise
 * title-case the slug so an arena id never renders as a raw underscore string.
 */
export function gameLabel(gameId: string): string {
  if (!gameId) return "";
  const alias = GAME_LABEL_ALIASES[gameId];
  if (alias) return alias;
  return get(gameId)?.name ?? titleCaseSlug(gameId);
}

/** Ids whose slug can't be recovered by title-casing alone (abbreviations). */
const GAME_LABEL_ALIASES: Record<string, string> = {
  ttt: "Tic Tac Toe",
};

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
