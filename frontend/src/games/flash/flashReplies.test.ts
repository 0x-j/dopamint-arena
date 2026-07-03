import test from "node:test";
import assert from "node:assert/strict";

import { FLASH_SPECTATOR_CORPUS, flashSpectatorReply } from "./flashReplies";

test("every corpus line is a valid flash move (non-empty, under the 256-byte wire limit)", () => {
  const enc = new TextEncoder();
  assert.ok(FLASH_SPECTATOR_CORPUS.length > 0, "corpus is non-empty");
  for (const line of FLASH_SPECTATOR_CORPUS) {
    const bytes = enc.encode(line);
    assert.ok(bytes.length > 0, `"${line}" is non-empty`);
    assert.ok(bytes.length <= 256, `"${line}" fits one flash frame`);
  }
});

test("reply is deterministic by message count and cycles through the corpus", () => {
  const n = FLASH_SPECTATOR_CORPUS.length;
  // Same count → same line (reproducible transcript).
  assert.equal(flashSpectatorReply(3n), flashSpectatorReply(3n));
  // Indexed by count, wrapping at the corpus length.
  assert.equal(flashSpectatorReply(0n), FLASH_SPECTATOR_CORPUS[0]);
  assert.equal(flashSpectatorReply(BigInt(n)), FLASH_SPECTATOR_CORPUS[0]);
  assert.equal(flashSpectatorReply(BigInt(n + 1)), FLASH_SPECTATOR_CORPUS[1]);
  // Stays in range far into an unbounded loop (up to the 1,000,000 cap).
  assert.equal(
    flashSpectatorReply(999_999n),
    FLASH_SPECTATOR_CORPUS[999_999 % n],
  );
});
