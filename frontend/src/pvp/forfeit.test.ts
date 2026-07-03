import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { serializeSettlementWithRoot } from "sui-tunnel-ts/core/wire";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { buildForfeitHalf } from "./forfeit.ts";

test("buildForfeitHalf forces human=0, bot=total and self-verifies", () => {
  const eph = generateKeyPair();
  const wallet = `0x${"00".repeat(32)}`;
  const total = 200n;
  const root = new Uint8Array(32).fill(7);
  const { settlement, sig } = buildForfeitHalf({
    tunnelId: `0x${"11".repeat(32)}`,
    total,
    wallet,
    eph,
    timestamp: 42n,
    transcriptRoot: root,
  });
  assert.equal(settlement.partyABalance, 0n);
  assert.equal(settlement.partyBBalance, total);
  assert.equal(settlement.finalNonce, 1n);
  assert.equal(settlement.timestamp, 42n);
  const ep = makeEndpoint(defaultBackend(), wallet, eph, true);
  assert.ok(ep.verify(serializeSettlementWithRoot(settlement), sig));
});

test("buildForfeitHalf rejects a non-32-byte root", () => {
  const eph = generateKeyPair();
  assert.throws(() =>
    buildForfeitHalf({
      tunnelId: `0x${"22".repeat(32)}`,
      total: 2n,
      wallet: `0x${"11".repeat(32)}`,
      eph,
      timestamp: 1n,
      transcriptRoot: new Uint8Array(31),
    }),
  );
});

// Cross-language golden: pins serializeSettlementWithRoot's (0, total) forfeit split byte-for-byte
// against the Rust side (backend/tunnel-manager/src/fleet/arena_anchor.rs, same tunnel id/values).
// The bytes-given-a-root are unchanged from a normal close — this specifically locks the forced
// (partyABalance=0, partyBBalance=total) split so the two languages never silently diverge.
test("serializeSettlementWithRoot forfeit golden matches the pinned Rust vector", () => {
  const bytes = serializeSettlementWithRoot({
    tunnelId: `0x${"00".repeat(31)}07`,
    partyABalance: 0n,
    partyBBalance: 2000n,
    finalNonce: 1n,
    timestamp: 42n,
    transcriptRoot: new Uint8Array(32).fill(9),
  });
  assert.equal(bytes.length, 121);
  assert.equal(
    Buffer.from(bytes).toString("hex"),
    "7375695f74756e6e656c3a3a736574746c656d656e745f76320000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000007d00000000000000001000000000000002a0909090909090909090909090909090909090909090909090909090909090909",
  );
});
