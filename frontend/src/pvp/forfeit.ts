// Build + sign the human's forfeit settlement half: forced balances (human=0, bot=total) so the
// cooperative close hands the whole pot to the bot. Under #180 the `transcriptRoot` is the BOT's root
// (from its settle half) — the FE keeps no transcript. Reuses the SDK's canonical serializer + the
// per-game ephemeral signer, byte-identical to what the bot co-signs and the Move contract verifies —
// no SDK edit. Caller combines (DistributedTunnel.combineSettlementWithRoot) and submits /settle.
import type { KeyPair } from "sui-tunnel-ts/core/crypto";
import {
  serializeSettlementWithRoot,
  type SettlementWithRoot,
} from "sui-tunnel-ts/core/wire";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";

export function buildForfeitHalf(opts: {
  tunnelId: string;
  /** a + b (conserved) — the whole pot goes to the bot. */
  total: bigint;
  /** Human wallet (party A address). */
  wallet: string;
  /** Per-game ephemeral baked into the tunnel at allocate — co-signs the half. */
  eph: KeyPair;
  /** On-chain created_at (ms); both halves MUST commit to equal timestamp bytes. */
  timestamp: bigint;
  /** 32-byte root the BOT emitted in its settle half; the bot signs the same root. */
  transcriptRoot: Uint8Array;
  /** On-chain nonce (0 for a freshly funded arena tunnel → finalNonce 1). */
  onchainNonce?: bigint;
}): { settlement: SettlementWithRoot; sig: Uint8Array } {
  if (opts.transcriptRoot.length !== 32) {
    throw new Error("transcriptRoot must be 32 bytes");
  }
  const settlement: SettlementWithRoot = {
    tunnelId: opts.tunnelId,
    partyABalance: 0n,
    partyBBalance: opts.total,
    finalNonce: (opts.onchainNonce ?? 0n) + 1n,
    timestamp: opts.timestamp,
    transcriptRoot: opts.transcriptRoot,
  };
  const endpoint = makeEndpoint(defaultBackend(), opts.wallet, opts.eph, true);
  const sig = endpoint.sign!(serializeSettlementWithRoot(settlement));
  return { settlement, sig };
}
