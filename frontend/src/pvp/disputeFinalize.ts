/**
 * Cold-resume dispute finalization — the second half of the unilateral settlement floor. When a
 * resumed match's peer stays gone past the on-chain grace, `attachResume`'s `onGraceExpired` calls
 * `raise_dispute` and stamps `disputedAt` on the record. That opens an on-chain timeout window that
 * ONLY the dispute raiser (this wallet) can finalize via `force_close_after_timeout`. Nothing else
 * closes it — the backend settle worker only handles cooperative closes, and the contract forbids a
 * non-raiser from force-closing — so if we never come back the stake sits locked in `STATUS_DISPUTED`.
 *
 * So on every cold resume we sweep the game's records and finalize any dispute whose window has
 * elapsed. This is a pure decision (which tunnelIds are ready to force-close) so both the worker
 * session and the main-thread hook share ONE maturity rule and it stays unit-testable.
 */
import type { ResumeRecord } from "./resume";

/** How long after we raised a dispute before we attempt `force_close`. The contract's timeout is
 *  measured from the disputed state's on-chain timestamp, which is always ≤ `disputedAt` (we raise
 *  after signing that state), so waiting this long from `disputedAt` guarantees the on-chain deadline
 *  has passed. The 10-min margin absorbs browser↔chain clock skew; a still-early attempt just reverts
 *  (`ETimeoutNotReached`) and retries on the next resume, so this only trades a rare wasted tx. */
export const DISPUTE_FINALIZE_AFTER_MS = 24 * 60 * 60 * 1000 + 10 * 60 * 1000;

/** The tunnelIds of records whose raised dispute is old enough to `force_close` now. A record with no
 *  `disputedAt` is a normal in-flight match (rebuilt, not finalized); a disputed-but-too-young record
 *  is left untouched for a later resume. `now` is injected so the rule is deterministic to test. */
export function disputesToFinalize(
  records: readonly ResumeRecord[],
  now: number,
): string[] {
  return records
    .filter(
      (r) =>
        r.disputedAt != null && now - r.disputedAt >= DISPUTE_FINALIZE_AFTER_MS,
    )
    .map((r) => r.tunnelId);
}

/** Whether a record should be REBUILT as a live match on cold resume: every non-disputed record. A
 *  disputed one is on-chain `STATUS_DISPUTED` — rebuilding it would drive a channel that can no longer
 *  advance; it's handled by {@link disputesToFinalize} instead. */
export function isRebuildable(record: ResumeRecord): boolean {
  return record.disputedAt == null;
}
