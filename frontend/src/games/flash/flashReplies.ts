/**
 * Canned chat lines for the in-browser bot-vs-bot flash spectator.
 *
 * Flash showcases move THROUGHPUT, not conversation — so replies are cheap and deterministic:
 * indexed by the running message count, a given move always renders the same line (stable and
 * unit-testable) while still reading like an alternating chat. Every line is non-empty (the
 * `flash.v1` protocol rejects empty moves) and short (well under the 256-byte per-move wire limit
 * `applyMove` enforces), so a reply never trips a protocol error mid-loop.
 */
export const FLASH_SPECTATOR_CORPUS: readonly string[] = [
  "gm ⚡",
  "still here, still co-signing.",
  "another one on the tunnel.",
  "no gas, no wait — just moves.",
  "your turn.",
  "digest folded, nonce bumped.",
  "off-chain and loving it.",
  "settle later, chat now.",
  "that's the whole point.",
  "one message, one move.",
  "rolling the transcript forward.",
  "let's keep it going.",
  "cheap, fast, verifiable.",
  "co-signed and confirmed.",
  "watch the counter climb.",
  "back to you ⚡",
];

/**
 * The reply for the move at `messageCount`. Deterministic (indexed by count) so the transcript is
 * reproducible and testable; the modulo keeps it in range for an unbounded (up to 1,000,000) loop.
 */
export function flashSpectatorReply(messageCount: bigint): string {
  const n = BigInt(FLASH_SPECTATOR_CORPUS.length);
  const idx = Number(((messageCount % n) + n) % n);
  return FLASH_SPECTATOR_CORPUS[idx];
}
