import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import type { CoSignedSettlementWithRoot } from "sui-tunnel-ts/core/tunnel";
import type { KeyPair } from "sui-tunnel-ts/core/crypto";
import { buildForfeitHalf } from "@/pvp/forfeit";
import { clearResumeRecord } from "@/pvp/resume";

/**
 * Co-sign the cooperative close over the PEER's transcript root.
 *
 * In the arena every match is human-vs-co-located-bot, and the bot owns the canonical transcript
 * (streamed to S3, `arena_anchor`). The FE keeps NO transcript of its own — it takes the root the bot
 * emitted in its settle half, signs seat A's half over that exact root, and combines. `combine`
 * re-verifies the peer's signature, so a forged/mismatched half can't produce a close. Funds are
 * unaffected: the chain pays the co-signed `balances` (from our own tunnel state) and only STORES the
 * root; anchoring the bot's root just makes the on-chain commitment match the S3 archive of record.
 *
 * `createdAt` is the on-chain `created_at` both seats sign as the settlement timestamp; nonce is fixed
 * at `onchainNonce = 0` (arena tunnels open fresh, close at nonce 1) exactly as the bot signs.
 */
export function coSignCloseFromPeerRoot<S, M>(
  dt: DistributedTunnel<S, M>,
  createdAt: bigint,
  peerRoot: Uint8Array,
  peerSig: Uint8Array,
): CoSignedSettlementWithRoot {
  const half = dt.buildSettlementHalfWithRoot(createdAt, peerRoot, 0n);
  return dt.combineSettlementWithRoot(half.settlement, half.sigSelf, peerSig);
}

/**
 * Co-sign a FORFEIT close over the peer's transcript root. Sibling of `coSignCloseFromPeerRoot`:
 * that one pays the co-signed game-state balances; this one forces `partyA(human)=0,
 * partyB(bot)=total` — the human concedes the whole pot. The FE keeps no transcript, so the root is
 * the one the bot emitted in its settle half. `combine` re-verifies the bot's signature, so a
 * forged/mismatched half cannot produce a close. `total = a + b` (conserved); nonce is fixed at
 * onchainNonce 0 (arena tunnels open fresh, close at nonce 1), exactly as the bot signs.
 */
export function coSignForfeitFromPeerRoot<S, M>(
  dt: DistributedTunnel<S, M>,
  wallet: string,
  eph: KeyPair,
  createdAt: bigint,
  peerRoot: Uint8Array,
  total: bigint,
  peerSig: Uint8Array,
): CoSignedSettlementWithRoot {
  const { settlement, sig } = buildForfeitHalf({
    tunnelId: dt.tunnelId,
    total,
    wallet,
    eph,
    timestamp: createdAt,
    transcriptRoot: peerRoot,
  });
  return dt.combineSettlementWithRoot(settlement, sig, peerSig);
}

/** How long a forfeit waits for the peer's co-signed `settleHalf` before giving up. The `makeInbox`
 *  waiter / `onPeer` buffer never reject on their own, so a dead or absent peer would otherwise strand
 *  the session in "settling" forever. Bounds the WHOLE pre-submit phase — the `created_at` read too,
 *  not just the peer wait — because a black-holed `getObject` RPC hangs before the peer wait even
 *  starts. On timeout the rejection routes into the caller's `catch` → terminal teardown. */
export const FORFEIT_SETTLE_TIMEOUT_MS = 10_000;

/** The peer's co-signed forfeit half, decoded to raw bytes (callers reading a hex wire frame convert
 *  with `fromHex` first; the `onPeer`-dispatcher games already hold bytes). */
export interface PeerForfeitHalf {
  sig: Uint8Array;
  root: Uint8Array;
}

/**
 * Drive a forfeit cooperative-close to a co-signed settlement, then submit it. Consolidates the
 * money-critical orchestration every arena game shares (a divergent copy strands that game's tunnel):
 * send the bare `{t:"forfeit"}` intent, read `created_at`, await the bot's forced-`(0,total)` half, and
 * co-sign it — ALL bounded by `timeoutMs`, so neither a black-holed `created_at` RPC nor a silent peer
 * can hang the session in "settling". Then (seat A only) submit the close and clear the resume record.
 *
 * The caller keeps what genuinely differs: its fire-once guard and terminal teardown (in its own
 * `finally`), the per-hook peer-wait + `created_at` source, and the submit path (with its backend-down
 * fallback). `total = a + b` (conserved) is computed by the caller from its own protocol handle.
 */
export async function runForfeitClose<S, M>(opts: {
  dt: DistributedTunnel<S, M>;
  wallet: string;
  eph: KeyPair;
  /** Conserved pot `a + b` — the whole of it goes to the bot. */
  total: bigint;
  /** True only for the single submitting seat (A, or the stayer when a peer bailed). */
  submits: boolean;
  /** On-chain `created_at`: a value already held (eager ref) or a reader (bounded by the timeout). */
  createdAt: bigint | (() => Promise<bigint>);
  /** Emit the bare `{t:"forfeit"}` intent to the peer. */
  sendForfeit: () => void;
  /** Await the peer's co-signed half (already decoded to bytes). */
  awaitPeerHalf: () => Promise<PeerForfeitHalf>;
  /** Submit the co-signed close, including the hook's backend-down fallback. Called only when `submits`. */
  submit: (co: CoSignedSettlementWithRoot) => Promise<void>;
  timeoutMs?: number;
}): Promise<void> {
  const co = await Promise.race([
    (async () => {
      const createdAt =
        typeof opts.createdAt === "function"
          ? await opts.createdAt()
          : opts.createdAt;
      opts.sendForfeit();
      const { sig, root } = await opts.awaitPeerHalf();
      return coSignForfeitFromPeerRoot(
        opts.dt,
        opts.wallet,
        opts.eph,
        createdAt,
        root,
        opts.total,
        sig,
      );
    })(),
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error("forfeit: peer did not co-sign in time")),
        opts.timeoutMs ?? FORFEIT_SETTLE_TIMEOUT_MS,
      ),
    ),
  ]);
  if (opts.submits) await opts.submit(co);
  clearResumeRecord(opts.dt.tunnelId);
}
