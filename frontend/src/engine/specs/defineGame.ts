/**
 * Self-registration for game specs (design §3.1). A `<game>Spec.ts` calls `defineGame(spec)`
 * at module load, so importing that module is the only step needed to register the game — no
 * central edit. `registry.ts` just imports the spec modules for their side-effects.
 *
 * NOTE: this load-time mutation IS the side-effect `registry.ts`'s bare imports depend on — it must
 * not be tree-shaken away (frontend/package.json must keep NO `"sideEffects": false`; see registry.ts).
 *
 * The map + `defineGame` + `getSpec` live HERE, not in `registry.ts`, on purpose: spec modules
 * depend on `defineGame`, and `registry.ts` depends on the spec modules. Keeping the store in a
 * leaf module (depends on nothing game-specific) breaks what would otherwise be a registry↔spec
 * import cycle — under a cycle the `const PVP_SPECS` initializer would be in its temporal dead
 * zone when a spec's top-level `defineGame(...)` runs.
 */
import type { GameSessionSpec } from "../engineApi";

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AnySpec = GameSessionSpec<any, any, any, any, any>;

/** gameId → spec, populated by `defineGame` import side-effects. */
const PVP_SPECS = new Map<string, AnySpec>();

/**
 * Register `spec` under its canonical `game` id and return it unchanged, so a spec module can
 * export and self-register in one statement, e.g.
 * `export const fooSpec = defineGame(makePublicStateSpec({ ... }))`.
 *
 * Throws on a duplicate id: two games claiming one key is a wiring bug, and silently
 * overwriting would route matches to the wrong engine.
 */
export function defineGame<S extends AnySpec>(spec: S): S {
  // Idempotent: Vite HMR can re-execute this module; re-registering the same id is a no-op.
  // Only throw when two DIFFERENT specs claim the same key (genuine wiring bug).
  const existing = PVP_SPECS.get(spec.game);
  if (existing && existing !== spec) {
    throw new Error(`duplicate game spec registered for "${spec.game}"`);
  }
  PVP_SPECS.set(spec.game, spec);
  return spec;
}

/** Look up a registered spec by its canonical game id (called inside the worker). */
export function getSpec(gameId: string): AnySpec | undefined {
  return PVP_SPECS.get(gameId);
}
