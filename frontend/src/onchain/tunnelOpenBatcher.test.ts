import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PACKAGE_ID = "0x2";
process.env.SUI_NETWORK = "testnet";
// Force the SUI funding mode (no MTPS env) so the batcher's group key is deterministic in tests.
delete process.env.VITE_MTPS_PACKAGE_ID;
delete process.env.VITE_MTPS_COIN_TYPE;

import {
  TunnelOpenBatcher,
  type BatcherDeps,
  type TunnelOpenRequest,
} from "./tunnelOpenBatcher.ts";
import { normalizeSuiAddress, BatchCommittedError } from "./tunnelTx.ts";

const party = (address: string) => ({ address, publicKey: new Uint8Array(32) });
// A fixed valid 32-byte Sui address for partyB; tests only correlate by partyA so sharing is fine.
const PARTY_B_ADDR =
  "0x000000000000000000000000000000000000000000000000000000000000bb00";
const req = (a: string): TunnelOpenRequest => ({
  partyA: party(a),
  partyB: party(PARTY_B_ADDR),
  aAmount: 500n,
  bAmount: 500n,
});

/**
 * Minimal fake deps for batcher unit tests. The default `getTransactionBlock` returns an empty
 * objectChanges list; tests that need tunnel correlation override it directly. `getObject` echoes
 * `input.id` back as `party_a.address` so deterministic overrides can key tunnels by id.
 */
function fakeDeps(opts: {
  onSign: () => void;
  failOpens?: number;
}): BatcherDeps {
  let opensSoFar = 0;
  return {
    reads: {
      waitForTransaction: async () => {},
      getTransactionBlock: async () => ({ objectChanges: [] }),
      getObject: async (input: { id: string }) => ({
        data: {
          content: {
            fields: {
              party_a: { fields: { address: input.id } },
            },
          },
        },
      }),
    } as unknown as BatcherDeps["reads"],
    sponsoredSignExec: async (_tx) => {
      opensSoFar += 1;
      opts.onSign();
      if (opts.failOpens && opensSoFar <= opts.failOpens) {
        throw new Error("sponsor 422 (test)");
      }
      return { digest: "0xd" + opensSoFar };
    },
    signExec: async () => ({ digest: "0xwallet" }),
    ensureStakeBalance: async () => {},
    prepareStake: async () => "0xcoin",
    selectStakeCoin: async () => "0xcoin",
  } as unknown as BatcherDeps;
}

test("coalesces concurrent requests into ONE signed PTB", async () => {
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1) });
  // make reads echo the three party-As as created tunnels
  (deps.reads as any).getTransactionBlock = async () => ({
    objectChanges: ["0xA", "0xB", "0xC"].map((a) => ({
      type: "created",
      objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
      objectId: "tunnel-for-" + a,
    })),
  });
  (deps.reads as any).getObject = async (i: { id: string }) => ({
    data: {
      content: {
        fields: {
          party_a: { fields: { address: i.id.replace("tunnel-for-", "") } },
        },
      },
    },
  });

  const batcher = new TunnelOpenBatcher(() => deps, {
    flushDelayMs: 0,
    maxBatch: 16,
  });
  const [a, b, c] = await Promise.all([
    batcher.request(req("0xA")),
    batcher.request(req("0xB")),
    batcher.request(req("0xC")),
  ]);
  assert.equal(signs, 1, "three requests → one sponsor call");
  // Tunnel ids come from getTransactionBlock; normalization is in openAndFundMany, not the batcher.
  // The id returned is the raw objectId, not the normalized party-A address.
  assert.ok(
    typeof a === "string" && a.length > 0,
    "a resolved to a non-empty string",
  );
  assert.ok(
    typeof b === "string" && b.length > 0,
    "b resolved to a non-empty string",
  );
  assert.ok(
    typeof c === "string" && c.length > 0,
    "c resolved to a non-empty string",
  );
  // Spot-check correlation: each request gets the tunnel keyed to its party-A
  assert.equal(a, "tunnel-for-0xA");
  assert.equal(b, "tunnel-for-0xB");
  assert.equal(c, "tunnel-for-0xC");
});

test("chunks a batch larger than maxBatch into ceil(N/maxBatch) signed PTBs", async () => {
  // 5 requests at maxBatch 2 → 3 chunks (sizes 2/2/1) → 3 sponsored PTBs.
  // Each chunk's sponsoredSignExec returns a digest that getTransactionBlock maps back to the
  // right tunnels, so all batches succeed without fallback. An unchunked run would sign once (1
  // PTB for all 5) and must fail this test, proving the chunking path was taken.
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1) });

  // fakeDeps sponsoredSignExec returns "0xd1", "0xd2", "0xd3" for calls 1/2/3 respectively.
  // Chunks run concurrently in Promise.all; JS single-thread + microtask FIFO ordering makes
  // the first chunk always sign first, so the digest-to-address mapping is deterministic.
  const digestToAddrs: Record<string, string[]> = {
    "0xd1": ["0x1", "0x2"],
    "0xd2": ["0x3", "0x4"],
    "0xd3": ["0x5"],
  };
  (deps.reads as any).getTransactionBlock = async ({
    digest,
  }: {
    digest: string;
  }) => ({
    objectChanges: (digestToAddrs[digest] ?? []).map((a) => ({
      type: "created",
      objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
      objectId: "tunnel-for-" + a,
    })),
  });
  (deps.reads as any).getObject = async (i: { id: string }) => ({
    data: {
      content: {
        fields: {
          party_a: { fields: { address: i.id.replace("tunnel-for-", "") } },
        },
      },
    },
  });

  const batcher = new TunnelOpenBatcher(() => deps, {
    flushDelayMs: 0,
    maxBatch: 2,
  });
  const reqs = ["0x1", "0x2", "0x3", "0x4", "0x5"].map((a) =>
    batcher.request(req(a)),
  );
  const results = await Promise.all(reqs);
  // One sponsored sign per chunk (3 chunks); no fallback should fire.
  assert.equal(signs, 3, "5 requests at maxBatch 2 → 3 chunks → 3 signed PTBs");
  // All requests resolve to a tunnel id.
  for (const id of results) {
    assert.ok(typeof id === "string" && id.length > 0, "each request resolves");
  }
});

test("falls back to single opens when a chunk's batched PTB fails", async () => {
  // The batch open fails completely (both the sponsored path and the senderPays path throw) so
  // flushChunk's catch block fires and drives per-request single opens. The second sponsored call
  // (in openSingle's withSponsorFallback) succeeds, resolving the request.
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1), failOpens: 1 });
  // Make the batch senderPays path fail too so openChunk throws entirely, triggering the batcher-
  // level fallback (not just the sponsor-level fallback inside withSponsorFallback).
  (deps as any).signExec = async () => {
    throw new Error("wallet rejected (test)");
  };
  (deps.reads as any).getTransactionBlock = async () => ({
    objectChanges: [
      {
        type: "created",
        objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
        objectId: "tunnel-for-0xA",
      },
    ],
  });
  (deps.reads as any).getObject = async () => ({
    data: { content: { fields: { party_a: { fields: { address: "0xA" } } } } },
  });
  const batcher = new TunnelOpenBatcher(() => deps, {
    flushDelayMs: 0,
    maxBatch: 16,
  });
  const id = await batcher.request(req("0xA"));
  assert.ok(
    typeof id === "string" && id.length > 0,
    "request still resolves via fallback",
  );
  assert.ok(signs >= 2, "one failed batch + at least one fallback open");
});

test("rejects all requests with BatchCommittedError on post-commit failure, no fallback", async () => {
  // Proves the PRE- vs POST-commit distinction: when signExec SUCCEEDS (batch committed) but
  // getTransactionBlock returns a wrong tunnel count, openAndFundMany throws BatchCommittedError.
  // flushChunk must propagate it to all pending requests and MUST NOT fire the single-open fallback —
  // the tunnels already exist; a fallback would double-open and double-consume stake.
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1) });
  // Default getTransactionBlock returns [] → count mismatch → BatchCommittedError (post-commit).
  // Leave it as-is (no override) to trigger the mismatch on the batched PTB.

  const batcher = new TunnelOpenBatcher(() => deps, {
    flushDelayMs: 0,
    maxBatch: 16,
  });
  const result = await Promise.allSettled([batcher.request(req("0xA"))]);
  const [settled] = result;

  // The request must reject with BatchCommittedError.
  assert.equal(
    settled.status,
    "rejected",
    "request should reject on post-commit failure",
  );
  const err = (settled as PromiseRejectedResult).reason;
  assert.ok(
    err instanceof BatchCommittedError,
    `expected BatchCommittedError, got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`,
  );
  // Exactly one sign: the batch PTB. No fallback single-open fires.
  assert.equal(
    signs,
    1,
    "only one sign (the committed batch PTB); no fallback opens",
  );
});

test("rejects all pending when no wallet deps are available", async () => {
  const batcher = new TunnelOpenBatcher(() => null, { flushDelayMs: 0 });
  await assert.rejects(() => batcher.request(req("0xA")), /no wallet/i);
});

test("deposit mode funds only seat A and coalesces into one PTB", async () => {
  // The genuine-two-party arena JOIN (ADR-0025): the fleet already created the tunnel + funded
  // seat B, so the user only deposits seat A into the existing tunnel. Proves the deposit path
  // coalesces like self-play, splits only the seat-A stake (Σ amount, never Σ (a+b)), and resolves
  // each request to its own pre-opened tunnel.
  let signs = 0;
  let stakeTotal: bigint | null = null;
  const deps = fakeDeps({ onSign: () => (signs += 1) });
  (deps as any).selectStakeCoin = async (need: bigint) => {
    stakeTotal = need;
    return "0xcoin";
  };

  const depositReq = (a: string, tunnel: string): TunnelOpenRequest => ({
    partyA: party(a),
    partyB: party(PARTY_B_ADDR),
    aAmount: 300n,
    bAmount: 700n, // must be IGNORED in deposit mode (the fleet funded seat B)
    mode: "deposit",
    tunnelId: tunnel,
  });
  const batcher = new TunnelOpenBatcher(() => deps, {
    flushDelayMs: 0,
    maxBatch: 16,
  });
  const [a, b] = await Promise.all([
    batcher.request(depositReq("0xA", "tunnel-A")),
    batcher.request(depositReq("0xB", "tunnel-B")),
  ]);

  assert.equal(signs, 1, "two deposits → one PTB");
  assert.equal(
    stakeTotal,
    600n,
    "deposit mode funds only seat A (2×300), never 2×(300+700)",
  );
  assert.equal(
    a,
    "tunnel-A",
    "each request resolves to its own pre-opened tunnel",
  );
  assert.equal(
    b,
    "tunnel-B",
    "each request resolves to its own pre-opened tunnel",
  );
});

test("deposit mode keeps each tunnel when party-A is SHARED (arena batch)", async () => {
  // Regression for the arena stall: every arena game deposits seat A from the SAME wallet address
  // (only the per-game ephemeral pubkey differs). The deposit result map is keyed by party-A
  // ADDRESS, so a shared address collapses it to one entry — before the fix every request resolved
  // to a single (last) tunnelId, so all-but-one game co-signed the WRONG tunnel_id and the bot
  // rejected its first move ("proposer sig failed"), stalling at "opponent's turn". Each deposit
  // must resolve to its OWN pre-opened tunnel regardless of the shared address.
  const deps = fakeDeps({ onSign: () => {} });
  const WALLET = "0xW";
  const depositReq = (tunnel: string): TunnelOpenRequest => ({
    partyA: party(WALLET), // SAME address for every game in the batch
    partyB: party(PARTY_B_ADDR),
    aAmount: 300n,
    bAmount: 0n,
    mode: "deposit",
    tunnelId: tunnel,
  });
  const batcher = new TunnelOpenBatcher(() => deps, {
    flushDelayMs: 0,
    maxBatch: 16,
  });
  const [poker, battleship, caro] = await Promise.all([
    batcher.request(depositReq("tunnel-poker")),
    batcher.request(depositReq("tunnel-battleship")),
    batcher.request(depositReq("tunnel-caro")),
  ]);

  assert.equal(
    poker,
    "tunnel-poker",
    "poker keeps its own tunnel despite the shared wallet",
  );
  assert.equal(
    battleship,
    "tunnel-battleship",
    "battleship keeps its own tunnel",
  );
  assert.equal(caro, "tunnel-caro", "caro keeps its own tunnel");
});

test("requests arriving within the debounce window share one flush", async () => {
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1) });
  (deps.reads as any).getTransactionBlock = async () => ({
    objectChanges: ["0xA", "0xB"].map((a) => ({
      type: "created",
      objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
      objectId: "tunnel-for-" + a,
    })),
  });
  (deps.reads as any).getObject = async (i: { id: string }) => ({
    data: {
      content: {
        fields: {
          party_a: { fields: { address: i.id.replace("tunnel-for-", "") } },
        },
      },
    },
  });
  const batcher = new TunnelOpenBatcher(() => deps, {
    flushDelayMs: 20,
    maxBatch: 16,
  });
  const p1 = batcher.request(req("0xA"));
  // second request 5ms later — still inside the 20ms debounce → same flush
  await new Promise((r) => setTimeout(r, 5));
  const p2 = batcher.request(req("0xB"));
  await Promise.all([p1, p2]);
  assert.equal(signs, 1, "staggered-but-close requests coalesce into one PTB");
});

test("onDigest is invoked with the batch digest for correlated requests", async () => {
  const digests: string[] = [];
  const deps = fakeDeps({ onSign: () => {} });
  (deps.reads as any).getTransactionBlock = async () => ({
    objectChanges: ["0xA", "0xB"].map((a) => ({
      type: "created",
      objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
      objectId: "tunnel-for-" + a,
    })),
  });
  (deps.reads as any).getObject = async (i: { id: string }) => ({
    data: {
      content: {
        fields: {
          party_a: { fields: { address: i.id.replace("tunnel-for-", "") } },
        },
      },
    },
  });
  const batcher = new TunnelOpenBatcher(() => deps, {
    flushDelayMs: 0,
    maxBatch: 16,
  });
  await Promise.all([
    batcher.request({ ...req("0xA"), onDigest: (d) => digests.push(d) }),
    batcher.request({ ...req("0xB"), onDigest: (d) => digests.push(d) }),
  ]);
  assert.equal(
    digests.length,
    2,
    "onDigest called for both correlated requests",
  );
  assert.ok(
    digests.every((d) => typeof d === "string" && d.length > 0),
    "digests are non-empty strings",
  );
  assert.equal(
    new Set(digests).size,
    1,
    "same batch digest for every correlated request",
  );
});

test("onDigest is not invoked when correlation fails in the batch path", async () => {
  let digests = 0;
  const deps = fakeDeps({ onSign: () => {} });
  // Default getTransactionBlock returns [] → no tunnel can be correlated, so openAndFundMany throws
  // BatchCommittedError and every pending request rejects without onDigest firing.
  const batcher = new TunnelOpenBatcher(() => deps, {
    flushDelayMs: 0,
    maxBatch: 16,
  });
  await assert.rejects(
    () =>
      batcher.request({
        ...req("0xA"),
        onDigest: () => (digests += 1),
      }),
    BatchCommittedError,
  );
  assert.equal(digests, 0, "onDigest skipped when tunnel id is not correlated");
});

test("onDigest is invoked in the single-open fallback path", async () => {
  const digests: string[] = [];
  const deps = fakeDeps({ onSign: () => {}, failOpens: 1 });
  // Make the batch sender-pays path fail too so openChunk throws entirely.
  (deps as any).signExec = async () => {
    throw new Error("wallet rejected (test)");
  };
  (deps.reads as any).getTransactionBlock = async () => ({
    objectChanges: [
      {
        type: "created",
        objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
        objectId: "tunnel-for-0xA",
      },
    ],
  });
  (deps.reads as any).getObject = async () => ({
    data: { content: { fields: { party_a: { fields: { address: "0xA" } } } } },
  });
  const batcher = new TunnelOpenBatcher(() => deps, {
    flushDelayMs: 0,
    maxBatch: 16,
  });
  await batcher.request({
    ...req("0xA"),
    onDigest: (d) => digests.push(d),
  });
  assert.equal(digests.length, 1, "onDigest called in fallback path");
  assert.ok(
    typeof digests[0] === "string" && digests[0].length > 0,
    "fallback digest is a non-empty string",
  );
});
