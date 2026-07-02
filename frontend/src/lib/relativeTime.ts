/**
 * Human "time ago" for the live feed — makes the wall feel alive vs a static clock. `now` is
 * passed in (not read internally) so it's pure/testable; the component recomputes it each render,
 * and the ~1/s SSE frame re-render keeps the label fresh. A future timestamp (clock skew) reads as
 * "just now" rather than a negative age.
 */
export function formatRelativeTime(timestampMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
