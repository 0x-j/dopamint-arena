// On-chain tunnel lifecycle via the connected wallet, shared by both lanes:
//  - PvP (ADR-0004): `create_and_share` (address=wallet, public_key=ephemeral) + gated per-seat
//    deposits; cooperative close pays the winner.
//  - Self-play: one wallet funds BOTH ephemeral-bot seats via `create_and_fund` (one signature),
//    plays off-chain, then cooperative close moves the coins.
//
// The PTBs are assembled by the SDK's tx builders (single source of truth for the Move ABI).
// We build with THIS app's @mysten/sui Transaction (which dapp-kit signs); vite `dedupe` makes
// the SDK source resolve to the same @mysten/sui, so the builders append to our Transaction
// directly. The caller supplies sign+execute (dapp-kit) and a Sui client.
import { Transaction } from "@mysten/sui/transactions";
import {
  buildOpenAndFundSeatA as sdkOpenAndFundSeatA,
  buildOpenAndFundMany as sdkOpenAndFundMany,
  buildOpenAndFundOneReturnless as sdkOpenAndFundOneReturnless,
  buildDepositMany as sdkDepositMany,
} from "sui-tunnel-ts/onchain/createAndFund";
import {
  buildDeposit as sdkDeposit,
  buildDepositFromGas as sdkDepositFromGas,
  buildCloseFromSettlement as sdkCloseFromSettlement,
  buildCloseWithRootFromSettlement as sdkCloseWithRootFromSettlement,
  buildRaiseDisputeFromUpdate as sdkRaiseDisputeFromUpdate,
  buildForceClose as sdkForceClose,
} from "sui-tunnel-ts/onchain/txbuilders";
import { SignatureScheme } from "sui-tunnel-ts/core/crypto";
import { toHex } from "sui-tunnel-ts/core/bytes";
import type {
  CoSignedSettlement,
  CoSignedSettlementWithRoot,
  CoSignedUpdate,
} from "sui-tunnel-ts/core/tunnel";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

// The SDK tx builders are the single source of truth for the Move ABI. The SDK pins an older
// @mysten/sui, but vite `dedupe` makes these run against THIS app's Transaction at runtime; the
// casts bridge only the (nominal) compile-time Transaction-class difference — each builder's own
// argument types stay fully type-checked.
const buildOpenAndFundSeatA = sdkOpenAndFundSeatA as unknown as (
  tx: Transaction,
  p: Parameters<typeof sdkOpenAndFundSeatA>[1],
) => void;
const buildDepositFromGas = sdkDepositFromGas as unknown as (
  tx: Transaction,
  p: Parameters<typeof sdkDepositFromGas>[1],
) => void;
const buildDeposit = sdkDeposit as unknown as (
  tx: Transaction,
  p: Parameters<typeof sdkDeposit>[1],
) => void;
const buildDepositMany = sdkDepositMany as unknown as (
  tx: Transaction,
  specs: Parameters<typeof sdkDepositMany>[1],
  opts: Parameters<typeof sdkDepositMany>[2],
) => void;
const buildCloseFromSettlement = sdkCloseFromSettlement as unknown as (
  tx: Transaction,
  tunnelId: string,
  settlement: Parameters<typeof sdkCloseFromSettlement>[2],
  coinType?: string,
) => void;
const buildCloseWithRootFromSettlement =
  sdkCloseWithRootFromSettlement as unknown as (
    tx: Transaction,
    tunnelId: string,
    settlement: Parameters<typeof sdkCloseWithRootFromSettlement>[2],
    coinType?: string,
  ) => void;
const buildOpenAndFundMany = sdkOpenAndFundMany as unknown as (
  tx: Transaction,
  specs: Parameters<typeof sdkOpenAndFundMany>[1],
  opts?: Parameters<typeof sdkOpenAndFundMany>[2],
) => void;
const buildRaiseDisputeFromUpdate = sdkRaiseDisputeFromUpdate as unknown as (
  tx: Transaction,
  tunnelId: string,
  u: CoSignedUpdate,
  raiser: Party,
) => void;
const buildForceClose = sdkForceClose as unknown as (
  tx: Transaction,
  p: { tunnelId: string },
) => void;
const buildOpenAndFundOneReturnless =
  sdkOpenAndFundOneReturnless as unknown as (
    tx: Transaction,
    spec: Parameters<typeof sdkOpenAndFundOneReturnless>[1],
  ) => void;

/** Sign + execute a transaction (e.g. dapp-kit's signAndExecuteTransaction). */
export type SignExec = (tx: Transaction) => Promise<{ digest: string }>;

/** Minimal read surface we need from a Sui client. */
export interface SuiReads {
  waitForTransaction(input: { digest: string }): Promise<unknown>;
  getTransactionBlock(input: {
    digest: string;
    options: { showObjectChanges: boolean };
  }): Promise<{ objectChanges?: unknown }>;
  getObject(input: {
    id: string;
    options: { showContent: boolean };
  }): Promise<{ data?: { content?: { fields?: Record<string, unknown> } } }>;
}

export interface PartyOnchain {
  address: string;
  publicKey: Uint8Array;
}

/** Thrown by openAndFundMany when the batch PTB ALREADY committed on-chain but a post-commit
 *  step (wait/read/correlate) failed. Signals callers MUST NOT retry the open — the tunnels
 *  exist; retrying would double-open and double-consume stake. `digest` identifies the committed tx. */
export class BatchCommittedError extends Error {
  constructor(
    readonly digest: string,
    readonly cause: unknown,
  ) {
    super(
      `batch open committed (digest ${digest}) but post-commit step failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "BatchCommittedError";
  }
}

function findTunnelId(changes: unknown): string | null {
  if (!Array.isArray(changes)) return null;
  for (const c of changes) {
    if (
      c?.type === "created" &&
      typeof c.objectType === "string" &&
      c.objectType.includes("::tunnel::Tunnel")
    ) {
      return c.objectId as string;
    }
  }
  return null;
}

/** Every created `::tunnel::Tunnel` object id in a tx's objectChanges, in change order. The batch
 *  opener reads N ids here (vs {@link findTunnelId}'s single id) and correlates them by party-A. */
export function findAllTunnelIds(changes: unknown): string[] {
  if (!Array.isArray(changes)) return [];
  const ids: string[] = [];
  for (const c of changes) {
    if (
      c?.type === "created" &&
      typeof c.objectType === "string" &&
      c.objectType.includes("::tunnel::Tunnel")
    ) {
      ids.push(c.objectId as string);
    }
  }
  return ids;
}

/** Canonical Sui address: lower-case, `0x`-prefixed, left-padded to 32 bytes. Created-tunnel party
 *  addresses (read from chain) and ephemeral key addresses must be compared in this form, since the
 *  two sources differ in padding. */
export function normalizeSuiAddress(addr: string): string {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** Read a created tunnel's party-A address from its on-chain fields. Used to map batch-opened
 *  tunnels back to their requesters — `objectChanges` order is unspecified, but each tunnel's
 *  party-A (a distinct ephemeral bot key) is a unique key. */
export async function readTunnelPartyA(
  reads: SuiReads,
  tunnelId: string,
): Promise<string> {
  const obj = await reads.getObject({
    id: tunnelId,
    options: { showContent: true },
  });
  const fields = obj.data?.content?.fields as
    | { party_a?: { fields?: { address?: unknown } } }
    | undefined;
  const addr = fields?.party_a?.fields?.address;
  if (typeof addr !== "string") {
    throw new Error(`tunnel ${tunnelId}: missing party_a.address in content`);
  }
  return addr;
}

/** Normalize a Move `vector<u8>` as `getObject` showContent renders it (number[] | base64 | hex)
 *  to lower-case hex without `0x`, matching `toHex`. Returns null if unrecognizable. */
function byteVectorToHex(v: unknown): string | null {
  if (Array.isArray(v)) {
    let h = "";
    for (const n of v) {
      const b = Number(n);
      if (!Number.isInteger(b) || b < 0 || b > 255) return null;
      h += b.toString(16).padStart(2, "0");
    }
    return h.length ? h : null;
  }
  if (typeof v === "string") {
    const s = v.replace(/^0x/i, "");
    if (s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) {
      return s.toLowerCase();
    }
    try {
      const bin = atob(v); // Sui can render a byte vector as base64
      let h = "";
      for (let i = 0; i < bin.length; i++) {
        h += bin.charCodeAt(i).toString(16).padStart(2, "0");
      }
      return h.length ? h : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** A created tunnel's party-B public key (lower-case hex, no `0x`) from its on-chain fields. The
 *  batch opener keys created tunnels by THIS, not by `objectChanges` order (Sui leaves that
 *  unspecified): every tunnel in one flush shares party A (the single sender), but each carries a
 *  distinct per-match opponent ephemeral as party B — the unique correlation key. */
export async function readTunnelPartyB(
  reads: SuiReads,
  tunnelId: string,
): Promise<string> {
  const obj = await reads.getObject({
    id: tunnelId,
    options: { showContent: true },
  });
  const fields = obj.data?.content?.fields as
    | { party_b?: { fields?: { public_key?: unknown } } }
    | undefined;
  const hex = byteVectorToHex(fields?.party_b?.fields?.public_key);
  if (!hex) {
    throw new Error(
      `tunnel ${tunnelId}: missing party_b.public_key in content`,
    );
  }
  return hex;
}

/**
 * Errors a fresh REBUILD can clear: owned-object/gas equivocation. Another tx consumed the same
 * coin/object version first, so this tx's build-time–pinned version is "unavailable for
 * consumption" and the validators reject it as "needs to be rebuilt". This hits when several games
 * fund their stake from the SAME user coin at once — e.g. every game auto-opening its tunnel on a
 * page reload. The reject is pre-commit (nothing executed), so rebuilding against the object's
 * CURRENT version and resubmitting is safe — no double-spend.
 *
 * Deterministic failures (insufficient balance, bad move target) and sponsor-endpoint outages are
 * deliberately NOT matched: the former would loop forever, and the latter must surface so
 * `withSponsorFallback` can switch to the sender-pays path.
 */
function isStaleObjectReject(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return (
    msg.includes("unavailable for consumption") ||
    msg.includes("not available for consumption") ||
    msg.includes("needs to be rebuilt") ||
    msg.includes("objectversionunavailable") ||
    msg.includes("rejected as invalid by more than 1/3") ||
    msg.includes("equivocat")
    // NOTE: "invalid withdraw reservation" / "available amount in account" are NOT matched. With the
    // faucet disabled (stake comes straight from the player's address balance), that error means a
    // genuinely insufficient balance — a permanent failure that must surface FAST, not loop forever
    // every ~5s (the doc above). `ensureMtpsAddressBalance` already waits for any coin-sweep to settle
    // before the open fires, so a checkpoint-lag false-negative is not expected here.
  );
}

const REBUILD_RETRY_MS = 5_000;
const submitSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Submit a freshly-built PTB, retrying FOREVER (~5s apart, jittered) as long as the only failure is
 * a stale-object/equivocation reject a rebuild can clear (see {@link isStaleObjectReject}). The
 * jitter de-syncs games that all reload at once so they don't re-collide on the same coin version
 * every round. `buildTx` is re-invoked per attempt, so each `tx.object(id)` re-resolves to the
 * object's CURRENT version; a rejected tx never commits, so resubmitting can't double-spend. Any
 * other error throws on the first attempt. Returns the committed digest.
 */
export async function submitRebuildingOnStale(
  buildTx: () => Transaction,
  signExec: SignExec,
  label: string,
): Promise<{ digest: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await signExec(buildTx());
    } catch (err) {
      if (!isStaleObjectReject(err)) throw err;
      const wait = REBUILD_RETRY_MS + Math.floor(Math.random() * 1_500);
      console.warn(
        `[tunnelTx] ${label}: stale-object/equivocation reject (attempt ${attempt}); rebuilding in ${wait}ms —`,
        (err as Error)?.message ?? err,
      );
      await submitSleep(wait);
    }
  }
}

/** Stake funded by a withdrawal from the SENDER's SIP-58 address balance (ADR-0013), instead of a
 *  version-pinned `Coin<T>` object. `amount` raw units of `coinType` (the `T`). */
export interface StakeFromBalance {
  amount: bigint;
  coinType: string;
}

/**
 * Build the stake `Coin<T>` by withdrawing from the SENDER's SIP-58 address balance (ADR-0013):
 * `coin::redeem_funds<T>(tx.withdrawal({ amount, type: T }))`. No `tx.object`, so nothing is
 * version-pinned — concurrent opens each draw their own reservation from the one balance and never
 * equivocate. The tx must carry a `ValidDuring` expiration (the sponsor sets it); the backend
 * allowlists this call and refuses any withdrawal that isn't the sender's own.
 */
export function redeemStakeFromBalance(
  tx: Transaction,
  stake: StakeFromBalance,
) {
  const [coin] = tx.moveCall({
    target: "0x2::coin::redeem_funds",
    typeArguments: [stake.coinType],
    arguments: [tx.withdrawal({ amount: stake.amount, type: stake.coinType })],
  });
  return coin;
}

/** The stake `Coin<T>` argument for an open/fund PTB: a SIP-58 address-balance withdrawal
 *  (ADR-0013) if `stakeFromBalance` is set, else the user coin object `stakeCoinId`, else
 *  `undefined` (fund from the gas coin — the non-sponsored path). */
export function stakeCoinArg(
  tx: Transaction,
  opts: { stakeFromBalance?: StakeFromBalance; stakeCoinId?: string },
) {
  if (opts.stakeFromBalance)
    return redeemStakeFromBalance(tx, opts.stakeFromBalance);
  if (opts.stakeCoinId) return tx.object(opts.stakeCoinId);
  return undefined;
}

/**
 * Consume the zero remainder a stake split leaves behind on the address-balance path (ADR-0013).
 * The SDK openers `splitCoins(source, [stakes…])` off the stake source and leave `source`: for an
 * owned coin object that auto-returns, but a `redeem_funds` result `Coin<T>` has no `drop`, so the
 * leftover (zero — we withdraw exactly the stake total) must be destroyed or the PTB is rejected
 * with "Unused ValueWithoutDrop". No-op on the coin-object / gas paths.
 */
export function consumeStakeRemainder(
  tx: Transaction,
  opts: { stakeFromBalance?: StakeFromBalance },
  source: ReturnType<typeof stakeCoinArg>,
): void {
  if (!opts.stakeFromBalance || !source) return;
  tx.moveCall({
    target: "0x2::coin::destroy_zero",
    typeArguments: [opts.stakeFromBalance.coinType],
    arguments: [source],
  });
}

/**
 * Open the shared tunnel AND fund seat A's stake in ONE transaction (one wallet popup for the
 * host) via the SDK's `buildOpenAndFundSeatA`. Returns the shared object id from tx changes.
 * Seat B funds its own seat separately (`depositStake`).
 */
export async function openAndFundSharedTunnel(opts: {
  reads: SuiReads;
  signExec: SignExec;
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  amount: bigint;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
  /** Split seat A's stake from this user coin (gas-sponsored path); else from the gas coin. */
  stakeCoinId?: string;
  /** ADR-0013: fund the stake from the sender's SIP-58 address balance (takes precedence over
   *  `stakeCoinId`) — concurrent opens don't equivocate. Sponsored path only. */
  stakeFromBalance?: StakeFromBalance;
  /** Coin type `T` for the tunnel; defaults to SUI. Pass MTPS to stake the faucet token. */
  coinType?: string;
}): Promise<string> {
  const { digest } = await submitRebuildingOnStale(
    () => {
      const tx = new Transaction();
      const source = stakeCoinArg(tx, opts);
      buildOpenAndFundSeatA(tx, {
        partyA: { ...opts.partyA, signatureType: SignatureScheme.ED25519 },
        partyB: { ...opts.partyB, signatureType: SignatureScheme.ED25519 },
        aAmount: opts.amount,
        timeoutMs: opts.timeoutMs ?? 86_400_000n,
        penaltyAmount: opts.penaltyAmount ?? 0n,
        stakeCoin: source,
        coinType: opts.coinType,
      });
      consumeStakeRemainder(tx, opts, source);
      return tx;
    },
    opts.signExec,
    "openAndFundSharedTunnel",
  );
  await opts.reads.waitForTransaction({ digest });
  const txb = await opts.reads.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });
  const tunnelId = findTunnelId(txb.objectChanges);
  if (!tunnelId) throw new Error("could not find created tunnel id");
  return tunnelId;
}

/** One PvP seat-A open in a batched flush: both parties + this seat's stake (coin's base units).
 *  The whole batch shares ONE sender (party A's wallet) and ONE summed stake withdrawal. */
export interface SharedSeatAOpenSpec {
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  amount: bigint;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
}

/**
 * Open + fund + share N PvP shared tunnels — SEAT A ONLY — in ONE PTB, returning each tunnel id in
 * SPEC ORDER. Per spec it composes the seat-A opener `create` → `deposit_party_a` (gated to the
 * sender = party A's address) → `public_share_object` (SDK `buildOpenAndFundSeatA`), and every
 * spec splits its stake off ONE shared source: a single SIP-58 address-balance withdrawal
 * (`redeem_funds`, ADR-0013) of the summed stake (`WithdrawFrom::Sender`), or one `stakeCoinId`,
 * or the gas coin. This is the Enoki one-sponsor-per-batch path (design §4.1): N opens, ONE
 * sponsored+executed tx, ONE withdrawal.
 *
 * NOT the self-play `openAndFundMany` (`create_and_fund`): this funds seat A ONLY (seat B deposits
 * its own stake later via `depositStake`), and it correlates results to specs differently — see
 * below. Reusing the self-play builder here would pre-fund seat B and double-consume the wallet.
 *
 * DEMUX: every tunnel in one flush shares party A's address (the single sender), so the self-play
 * opener's "key by on-chain party A" trick collapses. Instead each created tunnel is keyed by its
 * on-chain `party_b.public_key` — the per-match opponent ephemeral, freshly generated per match in
 * `PvpEngine.findMatch`, so unique within a flush even against the same opponent. This does NOT rely
 * on `objectChanges` order (which Sui leaves unspecified). Cost: N extra `getObject` reads per flush.
 * Returns tunnel ids in SPEC ORDER; a spec with no matching created tunnel throws (fail-loud — it
 * never mis-routes stake to the wrong match).
 *
 * Stake source MUST cover the summed `amount`s; on the address-balance path `stakeFromBalance.amount`
 * MUST equal that sum (the zero remainder is destroyed). Post-commit failures throw
 * {@link BatchCommittedError}: the N tunnels exist and their stake is consumed, so callers MUST NOT
 * retry — a retry double-opens and double-consumes stake.
 */
export async function openManySharedSeatA(opts: {
  reads: SuiReads;
  signExec: SignExec;
  specs: SharedSeatAOpenSpec[];
  coinType?: string;
  stakeFromBalance?: StakeFromBalance;
  stakeCoinId?: string;
}): Promise<string[]> {
  const { digest } = await submitRebuildingOnStale(
    () => {
      const tx = new Transaction();
      const source = stakeCoinArg(tx, opts);
      for (const s of opts.specs) {
        buildOpenAndFundSeatA(tx, {
          partyA: { ...s.partyA, signatureType: SignatureScheme.ED25519 },
          partyB: { ...s.partyB, signatureType: SignatureScheme.ED25519 },
          aAmount: s.amount,
          timeoutMs: s.timeoutMs ?? 86_400_000n,
          penaltyAmount: s.penaltyAmount ?? 0n,
          // All N seat-A splits draw from the one withdrawal/coin; on the address-balance path the
          // exact-sum source lands at zero and is destroyed by consumeStakeRemainder below.
          stakeCoin: source,
          coinType: opts.coinType,
        });
      }
      consumeStakeRemainder(tx, opts, source);
      return tx;
    },
    opts.signExec,
    "openManySharedSeatA",
  );
  // POST-COMMIT: everything below runs after the PTB has already landed. Any failure here means the
  // N tunnels exist and their stake is consumed — callers must not retry (BatchCommittedError).
  try {
    await opts.reads.waitForTransaction({ digest });
    const txb = await opts.reads.getTransactionBlock({
      digest,
      options: { showObjectChanges: true },
    });
    const ids = findAllTunnelIds(txb.objectChanges);
    if (ids.length !== opts.specs.length) {
      throw new Error(
        `openManySharedSeatA: expected ${opts.specs.length} tunnels, got ${ids.length} (digest ${digest})`,
      );
    }
    // Key by party-B pubkey (objectChanges order is unspecified), then return ids in SPEC ORDER so
    // the caller's positional demux is correct. A spec with no match throws — fail-loud, never
    // mis-route stake.
    const byPartyB = new Map<string, string>();
    for (const id of ids) {
      const partyB = await readTunnelPartyB(opts.reads, id);
      if (byPartyB.has(partyB)) {
        // Two created tunnels share a party-B pubkey (e.g. an opponent that reused one ephemeral
        // key across two coincident matches in this flush). The positional demux below would
        // collapse them and silently mis-route stake — fail loud instead (committed: never retry).
        throw new Error(
          `openManySharedSeatA: duplicate party_b pubkey across created tunnels (digest ${digest})`,
        );
      }
      byPartyB.set(partyB, id);
    }
    return opts.specs.map((s) => {
      const id = byPartyB.get(toHex(s.partyB.publicKey));
      if (!id) {
        throw new Error(
          `openManySharedSeatA: no created tunnel matched a spec's party_b pubkey (digest ${digest})`,
        );
      }
      return id;
    });
  } catch (err) {
    if (err instanceof BatchCommittedError) throw err; // already wrapped, pass through
    throw new BatchCommittedError(digest, err);
  }
}

/**
 * Self-play: open + fund BOTH ephemeral-bot seats from the caller's gas in ONE tx (one wallet
 * signature) via the SDK's `buildOpenAndFundMany` (create_and_fund). Returns the shared object
 * id. The bots co-sign play off-chain; a later cooperative close moves the coins on-chain.
 */
export async function openAndFundSelfPlay(opts: {
  reads: SuiReads;
  signExec: SignExec;
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  aAmount: bigint;
  bAmount: bigint;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
  /** Split BOTH seats' stakes from this user coin (gas-sponsored path); else from the gas coin. */
  stakeCoinId?: string;
  /** ADR-0013: fund BOTH stakes from the sender's SIP-58 address balance (takes precedence over
   *  `stakeCoinId`) — concurrent opens don't equivocate. Sponsored path only. */
  stakeFromBalance?: StakeFromBalance;
  /** Coin type `T` for the tunnels; defaults to SUI. Pass MTPS to stake the faucet token. */
  coinType?: string;
  /** Called with the committed PTB digest as soon as it is known, before waiting for effects. */
  onDigest?: (digest: string) => void;
}): Promise<string> {
  const { digest } = await submitRebuildingOnStale(
    () => {
      const tx = new Transaction();
      const source = stakeCoinArg(tx, opts);
      buildOpenAndFundMany(
        tx,
        [
          {
            partyA: { ...opts.partyA, signatureType: SignatureScheme.ED25519 },
            partyB: { ...opts.partyB, signatureType: SignatureScheme.ED25519 },
            aAmount: opts.aAmount,
            bAmount: opts.bAmount,
            timeoutMs: opts.timeoutMs ?? 86_400_000n,
            penaltyAmount: opts.penaltyAmount ?? 0n,
          },
        ],
        { coinType: opts.coinType, sourceCoin: source },
      );
      consumeStakeRemainder(tx, opts, source);
      return tx;
    },
    opts.signExec,
    "openAndFundSelfPlay",
  );
  opts.onDigest?.(digest);
  await opts.reads.waitForTransaction({ digest });
  const txb = await opts.reads.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });
  const tunnelId = findTunnelId(txb.objectChanges);
  if (!tunnelId) throw new Error("could not find created tunnel id");
  return tunnelId;
}

/** One self-play tunnel's open spec for {@link openAndFundMany}: both ephemeral seats + each
 *  seat's stake (the staked coin's base units). */
export interface TunnelOpenManySpec {
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  aAmount: bigint;
  bAmount: bigint;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
}

/**
 * Open + fund + activate N self-play tunnels in ONE PTB and return each tunnel id keyed by its
 * normalized party-A address. The whole batch is one `splitCoins` of the summed 2N stakes off a
 * single source coin (an address-balance withdrawal of `stakeFromBalance.amount`, or one
 * `stakeCoinId`, or the gas coin), then one `create_and_fund` per spec (SDK `buildOpenAndFundMany`).
 *
 * The stake source MUST cover the sum of all specs' `aAmount + bAmount`; on the address-balance
 * path `stakeFromBalance.amount` MUST equal that sum (the leftover zero coin is destroyed). The
 * caller correlates results by party-A because `objectChanges` order is unspecified.
 */
export async function openAndFundMany(opts: {
  reads: SuiReads;
  signExec: SignExec;
  specs: TunnelOpenManySpec[];
  coinType?: string;
  stakeFromBalance?: StakeFromBalance;
  stakeCoinId?: string;
  /** Called with the committed PTB digest as soon as it is known, before waiting for effects. */
  onDigest?: (digest: string) => void;
}): Promise<Map<string, string>> {
  const { digest } = await submitRebuildingOnStale(
    () => {
      const tx = new Transaction();
      const source = stakeCoinArg(tx, opts);
      buildOpenAndFundMany(
        tx,
        opts.specs.map((s) => ({
          partyA: { ...s.partyA, signatureType: SignatureScheme.ED25519 },
          partyB: { ...s.partyB, signatureType: SignatureScheme.ED25519 },
          aAmount: s.aAmount,
          bAmount: s.bAmount,
          timeoutMs: s.timeoutMs ?? 86_400_000n,
          penaltyAmount: s.penaltyAmount ?? 0n,
        })),
        { coinType: opts.coinType, sourceCoin: source },
      );
      consumeStakeRemainder(tx, opts, source);
      return tx;
    },
    opts.signExec,
    "openAndFundMany",
  );
  opts.onDigest?.(digest);
  // POST-COMMIT: everything below runs after the PTB has already landed on-chain. Any failure here
  // means the N tunnels exist and their stake is consumed — callers must not retry the open.
  try {
    await opts.reads.waitForTransaction({ digest });
    const txb = await opts.reads.getTransactionBlock({
      digest,
      options: { showObjectChanges: true },
    });
    const ids = findAllTunnelIds(txb.objectChanges);
    if (ids.length !== opts.specs.length) {
      throw new Error(
        `openAndFundMany: expected ${opts.specs.length} tunnels, got ${ids.length} (digest ${digest})`,
      );
    }
    const byPartyA = new Map<string, string>();
    for (const id of ids) {
      const partyA = await readTunnelPartyA(opts.reads, id);
      byPartyA.set(normalizeSuiAddress(partyA), id);
    }
    return byPartyA;
  } catch (err) {
    if (err instanceof BatchCommittedError) throw err; // already wrapped, pass through
    throw new BatchCommittedError(digest, err);
  }
}

/** One arena tunnel's seat-A deposit spec for {@link depositSeatAMany}: the existing (fleet-opened,
 *  ADR-0025) tunnel, its party-A wallet (the depositing sender, for result correlation), and seat
 *  A's stake. */
export interface TunnelDepositSeatASpec {
  tunnelId: string;
  partyA: PartyOnchain;
  amount: bigint;
}

/**
 * Arena one-signature JOIN (ADR-0025): deposit ONLY seat A into N tunnels the fleet already created
 * + funded seat B for, in ONE PTB — the tunnel activates on this single signature. The deposit-only
 * analog of the (superseded) seat-A open: there is no `create` here, so nothing is correlated from
 * object changes — each spec already carries its `tunnelId`, returned keyed by normalized party-A so
 * the batcher resolves each request. The summed stake is one source coin (an address-balance
 * withdrawal, one `stakeCoinId`, or the gas coin); `buildDepositMany` splits each `amount` off it.
 * `stakeFromBalance.amount` MUST equal the sum of every spec's `amount`.
 */
export async function depositSeatAMany(opts: {
  reads: SuiReads;
  signExec: SignExec;
  specs: TunnelDepositSeatASpec[];
  coinType?: string;
  stakeFromBalance?: StakeFromBalance;
  stakeCoinId?: string;
  /** Called with the committed PTB digest as soon as it is known, before waiting for effects. */
  onDigest?: (digest: string) => void;
}): Promise<Map<string, string>> {
  const { digest } = await submitRebuildingOnStale(
    () => {
      const tx = new Transaction();
      const source = stakeCoinArg(tx, opts);
      buildDepositMany(
        tx,
        opts.specs.map((s) => ({ tunnelId: s.tunnelId, amount: s.amount })),
        { coinType: opts.coinType, sourceCoin: source },
      );
      consumeStakeRemainder(tx, opts, source);
      return tx;
    },
    opts.signExec,
    "depositSeatAMany",
  );
  opts.onDigest?.(digest);
  // POST-COMMIT: the PTB has landed; the N seat-A deposits are consumed. Any failure below must NOT
  // retry (would double-deposit) — surface it as BatchCommittedError. The tunnel ids are known
  // inputs, so resolution needs no object-change read.
  try {
    await opts.reads.waitForTransaction({ digest });
    const byPartyA = new Map<string, string>();
    for (const s of opts.specs) {
      byPartyA.set(normalizeSuiAddress(s.partyA.address), s.tunnelId);
    }
    return byPartyA;
  } catch (err) {
    if (err instanceof BatchCommittedError) throw err;
    throw new BatchCommittedError(digest, err);
  }
}

/**
 * Self-play open via the returnless `tunnel::create_and_fund` (no ID return; the tunnel id is
 * read from object changes). Same one-signature flow as {@link openAndFundSelfPlay}; used by
 * Quantum Poker, which reads the id from object changes and never chains it in the PTB (its
 * randomness is two-party commit-reveal, so no on-chain id/seed composition is needed).
 */
export async function openAndFundSelfPlayReturnless(opts: {
  reads: SuiReads;
  signExec: SignExec;
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  aAmount: bigint;
  bAmount: bigint;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
}): Promise<string> {
  const { digest } = await submitRebuildingOnStale(
    () => {
      const tx = new Transaction();
      buildOpenAndFundOneReturnless(tx, {
        partyA: { ...opts.partyA, signatureType: SignatureScheme.ED25519 },
        partyB: { ...opts.partyB, signatureType: SignatureScheme.ED25519 },
        aAmount: opts.aAmount,
        bAmount: opts.bAmount,
        timeoutMs: opts.timeoutMs ?? 86_400_000n,
        penaltyAmount: opts.penaltyAmount ?? 0n,
      });
      return tx;
    },
    opts.signExec,
    "openAndFundSelfPlayReturnless",
  );
  await opts.reads.waitForTransaction({ digest });
  const txb = await opts.reads.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });
  const tunnelId = findTunnelId(txb.objectChanges);
  if (!tunnelId) throw new Error("could not find created tunnel id");
  return tunnelId;
}

/** Deposit this seat's stake; the Move routes it by sender address (gated). With `stakeFromBalance`
 *  the stake is withdrawn from the sender's SIP-58 address balance (ADR-0013); with `stakeCoinId`
 *  it is split off that user coin (gas-sponsored path); otherwise off the gas coin. */
export async function depositStake(opts: {
  signExec: SignExec;
  tunnelId: string;
  amount: bigint;
  stakeCoinId?: string;
  /** ADR-0013: deposit from the sender's SIP-58 address balance (takes precedence over
   *  `stakeCoinId`). The withdrawal is the exact `amount`, so no split is needed. */
  stakeFromBalance?: StakeFromBalance;
  /** Coin type `T`; defaults to SUI. Pass MTPS to deposit the faucet token. */
  coinType?: string;
}): Promise<void> {
  await submitRebuildingOnStale(
    () => {
      const tx = new Transaction();
      if (opts.stakeFromBalance) {
        // The address-balance withdrawal already yields exactly `amount` — deposit it directly.
        const coin = redeemStakeFromBalance(tx, opts.stakeFromBalance);
        buildDeposit(tx, {
          tunnelId: opts.tunnelId,
          coin,
          coinType: opts.coinType,
        });
      } else if (opts.stakeCoinId) {
        const [coin] = tx.splitCoins(tx.object(opts.stakeCoinId), [
          tx.pure.u64(opts.amount),
        ]);
        buildDeposit(tx, {
          tunnelId: opts.tunnelId,
          coin,
          coinType: opts.coinType,
        });
      } else {
        buildDepositFromGas(tx, {
          tunnelId: opts.tunnelId,
          amount: opts.amount,
        });
      }
      return tx;
    },
    opts.signExec,
    "depositStake",
  );
}

/** Read the on-chain created_at (ms) — the settlement timestamp must be >= this. */
export async function readCreatedAt(
  reads: SuiReads,
  tunnelId: string,
): Promise<bigint> {
  const obj = await reads.getObject({
    id: tunnelId,
    options: { showContent: true },
  });
  return BigInt((obj.data?.content?.fields?.created_at as string) ?? 0);
}

/** Cooperative close from the dual-signed settlement; pays the winner on-chain. */
export async function closeCooperative(opts: {
  signExec: SignExec;
  tunnelId: string;
  settlement: CoSignedSettlement;
  coinType?: string;
}): Promise<string> {
  const tx = new Transaction();
  buildCloseFromSettlement(tx, opts.tunnelId, opts.settlement, opts.coinType);
  const { digest } = await opts.signExec(tx);
  return digest;
}

/** Root-anchored cooperative close from a dual-signed CoSignedSettlementWithRoot. Anchors the
 *  transcript root on-chain (close_cooperative_with_root). Used as the wallet-submitted fallback
 *  when the backend /settle route is unavailable. */
export async function closeCooperativeWithRoot(opts: {
  signExec: SignExec;
  tunnelId: string;
  settlement: CoSignedSettlementWithRoot;
  coinType?: string;
}): Promise<string> {
  const tx = new Transaction();
  buildCloseWithRootFromSettlement(
    tx,
    opts.tunnelId,
    opts.settlement,
    opts.coinType,
  );
  const { digest } = await opts.signExec(tx);
  return digest;
}

/**
 * Unilateral settlement floor, step 1: stake the latest BOTH-signed checkpoint on-chain via
 * `raise_dispute`, opening the on-chain timeout window. Used when the peer is gone and a fresh
 * cooperative co-signature is unavailable. `force_close` finalizes after `timeout_ms` (24h).
 */
export async function raiseDisputeUnilateral(opts: {
  signExec: SignExec;
  tunnelId: string;
  update: CoSignedUpdate;
  role: Party;
}): Promise<string> {
  const tx = new Transaction();
  buildRaiseDisputeFromUpdate(tx, opts.tunnelId, opts.update, opts.role);
  const { digest } = await opts.signExec(tx);
  return digest;
}

/** Unilateral settlement floor, step 2: finalize the staked dispute after the on-chain timeout. */
export async function forceCloseAfterTimeout(opts: {
  signExec: SignExec;
  tunnelId: string;
}): Promise<string> {
  const tx = new Transaction();
  buildForceClose(tx, { tunnelId: opts.tunnelId });
  const { digest } = await opts.signExec(tx);
  return digest;
}
