// Gas-sponsored open/fund via the backend settler (ADR-0009). The settler wraps the user's PTB
// in SIP-58 gas owned by the settler and dry-runs it; the user co-signs the SAME bytes and the
// pair is submitted together. The settler pays gas; the stake stays the user's own coin.
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { resolveBackendUrl } from "@/backend/controlPlane";
import type { SignExec } from "./tunnelTx";

/** PTB sign/execute traces fire on EVERY sponsored tx — the Regular Payments auto-burst can emit many
 *  per second, and DevTools retains every logged line (blocking GC → heap growth → long GC pauses →
 *  the tab hangs / "Aw, Snap!"). Off by default; enable with `?ptbdebug` to trace sponsorship. */
const PTB_LOG =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("ptbdebug");

/** dapp-kit's `useSignTransaction` mutateAsync shape: signs a tx, returns the user signature. */
export type WalletSignTransaction = (input: {
  transaction: Transaction;
}) => Promise<{ signature: string; bytes: string }>;

/** The execute surface we need from the app's Sui client (its v1-compat JSON-RPC client). The
 *  same client also resolves inputs for `tx.build` below (passed through structurally). */
export interface SponsorSuiClient {
  executeTransactionBlock(input: {
    transactionBlock: string;
    signature: string[];
    options?: { showEffects?: boolean; showObjectChanges?: boolean };
    requestType?: string;
  }): Promise<{
    digest: string;
    effects?: { status?: { status?: string; error?: string } };
  }>;
}

interface SponsorResponse {
  /** Which gas source sponsored the tx (ADR-0014) — selects the execution path below. */
  provider: "enoki" | "settler";
  /** Base64 of the sponsored tx the user signs (settler-wrapped, or Enoki's sponsored bytes). */
  txBytes: string;
  /** Settler only: the settler's gas signature, submitted alongside the user's sender signature. */
  sponsorSignature?: string;
  /** Enoki only: the sponsored-tx handle, redeemed via POST /v1/sponsor/execute with the signature. */
  digest?: string;
}

/**
 * A {@link SignExec} that routes the open/fund tx through the backend gas sponsor instead of
 * paying gas from the wallet. Build the PTB KIND → `POST /v1/sponsor` (settler wraps it in its
 * own SIP-58 gas + dry-runs) → user signs the returned bytes → submit with both signatures.
 *
 * Drop-in for the dapp-kit `signAndExecuteTransaction` SignExec: same `(tx) => { digest }` shape,
 * so the open/fund callers don't change. The PTB must fund its stake from a user coin (not the
 * gas coin) — with sponsor gas there is no gas coin to split.
 */
// Process-wide serialization of the sponsor flow. The settler sponsors every tx with its SINGLE
// SIP-58 gas object, so two sponsored txs in flight at once both pin that object's version and the
// network rejects the slower one as a stale-object/equivocation. The legacy main-thread solo path
// never hit this because all its opens coalesce into ONE sponsored tx per render tick; the worker
// path issues each window's open independently (spread over seconds), so they overlap. Funnelling
// every sponsor→sign→execute through one queue means request N+1's `/v1/sponsor` only runs after N
// committed — so it always sees the gas object's fresh version. This touches only the rare
// per-tunnel open/settle txs; off-chain hop play never sponsors, so move throughput is unaffected.
let sponsorQueue: Promise<unknown> = Promise.resolve();
let sponsorInFlight = 0;
function serializeSponsoredFlow<T>(run: () => Promise<T>): Promise<T> {
  sponsorInFlight += 1;
  if (sponsorInFlight > 1) {
    // Debug-level: concurrent sponsored txs ARE contending the settler's single gas object here; the
    // queue is what serializes them so the slower one doesn't equivocate.
    console.debug(`[sponsor-serialize] queued behind ${sponsorInFlight - 1}`);
  }
  // `.then(run, run)` runs regardless of the prior slot's outcome; the tail swallows errors so one
  // failed sponsor doesn't reject the chain and wedge every later open.
  const result = sponsorQueue.then(run, run);
  sponsorQueue = result
    .then(() => new Promise((r) => setTimeout(r, 1500)))
    .catch(() => {})
    .then(
      () => {
        sponsorInFlight -= 1;
      },
      () => {
        sponsorInFlight -= 1;
      },
    );
  return result;
}

function runSponsoredFlow(opts: {
  tx: Transaction;
  sender: string;
  client: SponsorSuiClient;
  signSponsoredBytes: (txBytes: string) => Promise<string>;
}): Promise<{ digest: string }> {
  return serializeSponsoredFlow(() => runSponsoredFlowOnce(opts));
}

/**
 * Core gas-sponsor flow, shared by every signer kind: build the PTB KIND → `POST /v1/sponsor` (the
 * settler wraps it in its own SIP-58 gas + dry-runs) → the sender signs the settler-returned bytes
 * (via `signSponsoredBytes`) → submit with both signatures. Signer kinds differ ONLY in step 3.
 * Always reached through {@link serializeSponsoredFlow} so the settler's single gas object is never
 * pinned by two in-flight txs at once.
 *
 * CRITICAL: the sender must sign the EXACT bytes the settler returned — never a rebuild. A SIP-58
 * sponsored tx carries the settler's address-balance gas with an empty `gas_payment.objects`;
 * re-running `Transaction.build` would try to resolve gas coins for the (coin-less) sender and fail
 * with a cryptic RPC "Invalid params". So `signSponsoredBytes` receives the raw base64 bytes.
 */
async function runSponsoredFlowOnce(opts: {
  tx: Transaction;
  sender: string;
  client: SponsorSuiClient;
  signSponsoredBytes: (txBytes: string) => Promise<string>;
}): Promise<{ digest: string }> {
  const root = resolveBackendUrl();
  // 1) Serialize only the PTB — the settler supplies the gas, and sets the sender, itself.
  let kindBytes: Uint8Array;
  try {
    kindBytes = await opts.tx.build({
      client: opts.client as never,
      onlyTransactionKind: true,
    });
  } catch (e) {
    // Label the failing step: a build-time error (e.g. a malformed object id / move target from an
    // empty env id) is otherwise a bare RPC "Invalid params" with no hint of where it came from.
    throw new Error(
      `sponsor: build PTB kind failed: ${String((e as Error)?.message ?? e)}`,
    );
  }
  // 2) Sponsor: the settler wraps it in settler-owned gas and rejects (422) anything it won't pay for.
  const res = await fetch(`${root}/v1/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sender: opts.sender,
      txKindBytes: toBase64(kindBytes),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`sponsor request failed (${res.status}): ${detail}`);
  }
  const { provider, txBytes, sponsorSignature, digest } =
    (await res.json()) as SponsorResponse;
  if (PTB_LOG)
    console.log(
      `✍️ [PTB sign] sponsor · sender ${opts.sender.slice(0, 12)}… · provider=${provider} · ${kindBytes.length}b PTB kind`,
    );
  // 3) The sender signs the sponsor-returned bytes (sender authorization). Same for both providers.
  let userSignature: string;
  try {
    userSignature = await opts.signSponsoredBytes(txBytes);
  } catch (e) {
    throw new Error(
      `sponsor: sign sponsored bytes failed: ${String((e as Error)?.message ?? e)}`,
    );
  }
  // 4) Execute — the two providers submit differently:
  //  - enoki owns the gas AND executes: hand it our signature via /v1/sponsor/execute. We can NOT
  //    fall back to the settler here — the signed bytes commit to Enoki's gas owner; the outer
  //    withSponsorFallback (sender-pays, fresh tx) stays the last resort.
  if (provider === "enoki") {
    if (!digest) throw new Error("sponsor: enoki response missing digest");
    let execRes: Response;
    try {
      execRes = await fetch(`${root}/v1/sponsor/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digest, signature: userSignature }),
      });
    } catch (e) {
      throw new Error(
        `sponsor: enoki execute request failed: ${String((e as Error)?.message ?? e)}`,
      );
    }
    if (!execRes.ok) {
      const detail = await execRes.text().catch(() => "");
      throw new Error(`enoki execute failed (${execRes.status}): ${detail}`);
    }
    const executed = (await execRes.json()) as { digest: string };
    if (PTB_LOG)
      console.log(`✅ [PTB sign] enoki executed · digest ${executed.digest}`);
    return { digest: executed.digest };
  }

  //  - settler: WE submit the bytes with BOTH sigs (sender + settler gas) to the node.
  if (!sponsorSignature) {
    throw new Error("sponsor: settler response missing sponsorSignature");
  }
  let result: Awaited<ReturnType<SponsorSuiClient["executeTransactionBlock"]>>;
  try {
    result = await opts.client.executeTransactionBlock({
      transactionBlock: txBytes,
      signature: [userSignature, sponsorSignature],
      options: { showEffects: true, showObjectChanges: true },
      requestType: "WaitForLocalExecution",
    });
  } catch (e) {
    throw new Error(
      `sponsor: executeTransactionBlock failed: ${String((e as Error)?.message ?? e)}`,
    );
  }
  // Surface an on-chain failure (e.g. the faucet aborted) loudly, instead of a later "no coin".
  const status = result.effects?.status?.status;
  if (status && status !== "success") {
    throw new Error(
      `sponsored transaction failed on-chain: ${result.effects?.status?.error ?? status}`,
    );
  }
  if (PTB_LOG)
    console.log(`✅ [PTB sign] settler executed · digest ${result.digest}`);
  return { digest: result.digest };
}

export function makeSponsoredSignExec(opts: {
  sender: string;
  client: SponsorSuiClient;
  signTransaction: WalletSignTransaction;
}): SignExec {
  return (tx: Transaction) =>
    runSponsoredFlow({
      tx,
      sender: opts.sender,
      client: opts.client,
      signSponsoredBytes: async (txBytes) => {
        // dapp-kit signs the bytes handed to it; guard against a re-serialization mismatch (if the
        // wallet rebuilt to different bytes, the signature pair would be invalid on-chain).
        const { signature, bytes } = await opts.signTransaction({
          transaction: Transaction.from(fromBase64(txBytes)),
        });
        if (bytes !== txBytes) {
          throw new Error(
            "sponsored transaction bytes changed during wallet signing",
          );
        }
        return signature;
      },
    });
}

/** A local keypair's signer surface — signs raw tx bytes (e.g. a `@mysten/sui` `Ed25519Keypair`). */
export interface KeypairSigner {
  signTransaction(
    bytes: Uint8Array,
  ): Promise<{ signature: string; bytes: string }>;
}

/**
 * Sponsored {@link SignExec} for a LOCAL keypair (not a connected wallet) — e.g. the autonomous
 * bot identities in bot-vs-bot mode. Same sponsor protocol as {@link makeSponsoredSignExec}: the
 * settler wraps the PTB in its own gas, the keypair co-signs the SAME bytes, both are submitted —
 * so the keypair's account needs ZERO SUI (it only signs; the settler pays gas).
 */
export function makeKeypairSponsoredSignExec(opts: {
  address: string;
  keypair: KeypairSigner;
  client: SponsorSuiClient;
}): SignExec {
  return (tx: Transaction) =>
    runSponsoredFlow({
      tx,
      sender: opts.address,
      client: opts.client,
      // Sign the settler-returned bytes DIRECTLY — the keypair signs raw tx bytes, so there is no
      // rebuild to mis-resolve the (settler-owned, address-balance) gas.
      signSponsoredBytes: async (txBytes) => {
        const { signature } = await opts.keypair.signTransaction(
          fromBase64(txBytes),
        );
        return signature;
      },
    });
}

/**
 * Run the gas-sponsored path; if it throws — sponsor endpoint down/rejected, or no stake coin —
 * fall back to `senderPays` (the wallet paying its own gas). Mirrors the close path's
 * `/settle`→wallet fallback, so a sponsor outage doesn't block funded wallets.
 *
 * Caveat: the fallback only succeeds if the wallet holds SUI for gas. A fresh sponsored-only
 * account (e.g. a 0-SUI zkLogin login) has none, so for it the fallback fails too — sponsorship is
 * the only path. The sponsored attempt throws BEFORE any on-chain effect (the tx never executes on
 * sponsor failure), so retrying sender-pays opens a fresh tunnel with no double-spend.
 */
export async function withSponsorFallback<T>(
  sponsored: () => Promise<T>,
  senderPays: () => Promise<T>,
  label = "open/fund",
): Promise<T> {
  try {
    return await sponsored();
  } catch (sponsorErr) {
    console.warn(
      `[sponsor] ${label}: sponsor failed, falling back to sender-pays`,
      sponsorErr,
    );
    try {
      return await senderPays();
    } catch (payErr) {
      // Surface BOTH causes: a 0-SUI player can't sender-pay, so the bare "no SUI coin" would hide
      // the real reason the sponsored path failed (the only path that can work for them).
      throw new Error(
        `${label}: sponsored path failed [${String((sponsorErr as Error)?.message ?? sponsorErr)}]; sender-pays fallback failed [${String((payErr as Error)?.message ?? payErr)}]`,
      );
    }
  }
}

/** A coin the wallet owns: id + MIST balance, as returned by `getCoins`. */
export interface OwnedCoin {
  coinObjectId: string;
  balance: string;
}

/**
 * Pick a user-owned `Coin<SUI>` with at least `minAmount` MIST to fund a stake when gas is
 * sponsored — the stake can't come from the gas coin in a SIP-58 sponsored tx. Throws if no
 * single coin is large enough (a fresh 0-SUI zkLogin account still needs stake funds; gas-only).
 */
export async function selectStakeCoin(
  getCoins: (owner: string) => Promise<OwnedCoin[]>,
  owner: string,
  minAmount: bigint,
): Promise<string> {
  const coins = await getCoins(owner);
  const enough = coins.find((c) => BigInt(c.balance) >= minAmount);
  if (!enough) {
    throw new Error(
      `no SUI coin >= ${minAmount} MIST to fund the stake (gas is sponsored, the stake is not)`,
    );
  }
  return enough.coinObjectId;
}
