/**
 * Engine debug instrumentation — gated so it costs nothing when off. ON in dev
 * (`import.meta.env.DEV`) or with `?enginedebug` in the page URL. Logs are prefixed
 * `[engine:<scope>]` so the devtools console can filter to just them. Perf timings use
 * `performance.now()`.
 */
const debugFromUrl =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("enginedebug");

export const ENGINE_DEBUG: boolean = debugFromUrl;

const noop = (): void => {};

/** Log a scoped event (no-op when debug is off). Uses `console.log` (not `console.debug`) so it
 *  shows at the default DevTools console level — `console.debug` is hidden unless "Verbose" is on. */
export function elog(scope: string, ...args: unknown[]): void {
  if (ENGINE_DEBUG) console.log(`[engine:${scope}]`, ...args);
}

/** Start a timer; the returned fn logs the elapsed ms with `label`. No-op when debug is off. */
export function emark(scope: string, label: string): () => void {
  if (!ENGINE_DEBUG) return noop;
  const t0 = performance.now();
  return () =>
    console.log(
      `[engine:${scope}] ${label} — ${(performance.now() - t0).toFixed(1)}ms`,
    );
}
