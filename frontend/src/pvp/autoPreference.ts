// Per-game "auto" (bot-plays-your-seat) default, kept in memory for the page session.
//
// A game's baseline is the caller's `fallback`: arena (self-playing) games pass `true` so they
// autopilot by default; a player-driven game passes nothing and defaults OFF. Either way the
// player's last explicit toggle this session overrides the baseline and sticks to the next game.
// Never persisted — a fresh page load starts back at the fallback.
//
// Read at each match's fresh-start point (`defaultAuto`); written only when the player toggles
// (`rememberAuto`). One bool per game key (the matchmaking/resume label, e.g. "bomb-it", "caro").
const autoByGame = new Map<string, boolean>();

/**
 * The auto value a new match should start with: the player's last explicit toggle this session, or
 * `fallback` if they haven't toggled. Arena/self-playing games pass `fallback = true` so a fresh
 * load, a resume, or a reload all default to autopilot; player-driven games keep the OFF default.
 */
export function defaultAuto(game: string, fallback = false): boolean {
  return autoByGame.get(game) ?? fallback;
}

/** Record the player's explicit auto choice so the next game this session keeps it. */
export function rememberAuto(game: string, on: boolean): void {
  autoByGame.set(game, on);
}
