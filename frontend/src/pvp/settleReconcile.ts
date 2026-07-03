/**
 * Settle-time transcript-root reconciliation. A seat that cold-resumed or resync-adopted cannot
 * reproduce the full update history (adopt jumps nonces; a reload starts a fresh transcript), so
 * the two parties' transcript roots legitimately diverge at cooperative close. The root only
 * anchors the OPTIONAL Walrus proof — funds ride on the co-signed balances/finalNonce — so the
 * partial-transcript seat can safely re-sign over the peer's root (the peer kept the full history)
 * and close without a proof, instead of hard-failing the whole settlement.
 */

/** The co-signed settlement fields a `settleHalf` peer message carries (wire strings). */
export interface SettleHalfWire {
  partyABalance: string;
  partyBBalance: string;
  finalNonce: string;
  timestamp: string;
  transcriptRoot: string;
}

/** The locally built settlement's outcome fields (pre-serialization bigints). */
export interface SettleOutcome {
  partyABalance: bigint;
  partyBBalance: bigint;
  finalNonce: bigint;
  timestamp: bigint;
}

/**
 * True when the peer's half agrees on the money — balances, finalNonce, timestamp — and differs
 * ONLY by transcript root. That is the resume-safe divergence: adopt the peer's root and settle
 * prooflessly. Any other difference is a genuine state divergence; the caller must NOT sign it
 * (fall through to the dispute floor instead).
 */
export function peerHalfMatchesOutcome(
  ours: SettleOutcome,
  theirs: SettleHalfWire,
): boolean {
  return (
    theirs.partyABalance === ours.partyABalance.toString() &&
    theirs.partyBBalance === ours.partyBBalance.toString() &&
    theirs.finalNonce === ours.finalNonce.toString() &&
    theirs.timestamp === ours.timestamp.toString()
  );
}
