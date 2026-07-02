/**
 * Pure decision helpers for freezing game windows when the wallet disconnects and
 * thawing them when it reconnects. Side-effect-free so the transition logic and
 * window enumeration are unit-testable without React or dapp-kit. The Desktop
 * effect wires these to `disposeWindow` (freeze) and the per-window `resume()`
 * effect (thaw).
 */

/** How the connected-wallet address changed between two renders. */
export type WalletTransition = "none" | "freeze" | "resume" | "switch";

/**
 * Classify a change in the connected wallet address.
 * - `freeze`: had a wallet, now none → stop every game window.
 * - `resume`: had none, now a wallet → thaw (per-window resume re-fires).
 * - `switch`: swapped directly to a different wallet → stop stale sessions, then thaw.
 * - `none`: unchanged.
 */
export function classifyWalletTransition(
  prev: string | undefined,
  next: string | undefined,
): WalletTransition {
  if (prev === next) return "none";
  if (!next) return "freeze";
  if (!prev) return "resume";
  return "switch";
}

/**
 * Every open game-window id across ALL workspaces (tiled + minimized + floating),
 * deduped. A window lives in exactly one store, but ids are unioned defensively.
 * Typed structurally so it need not import Desktop's GridItem/FloatState.
 */
export function collectGameWindowIds(
  layouts: Record<string, ReadonlyArray<{ id: string }>>,
  hiddens: Record<string, Record<string, unknown>>,
  floatings: Record<string, Record<string, { item: { id: string } }>>,
): string[] {
  const ids = new Set<string>();
  for (const items of Object.values(layouts))
    for (const w of items) ids.add(w.id);
  for (const rec of Object.values(hiddens))
    for (const id of Object.keys(rec)) ids.add(id);
  for (const rec of Object.values(floatings))
    for (const f of Object.values(rec)) ids.add(f.item.id);
  return [...ids];
}

/**
 * Whether a window should show the "reconnect wallet" scrim. Only wallet-gated
 * (arena-wired) games do — chat/other windows don't depend on the wallet, so a
 * scrim there would mislead. `arenaGameId` is `undefined` for non-arena modules.
 */
export function frozenScrimVisible(
  frozen: boolean,
  arenaGameId: string | undefined,
): boolean {
  return frozen && arenaGameId != null;
}
