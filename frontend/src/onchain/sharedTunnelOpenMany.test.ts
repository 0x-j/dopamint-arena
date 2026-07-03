import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PACKAGE_ID = "0x2";
process.env.SUI_NETWORK = "testnet";

import { openManySharedSeatA, BatchCommittedError } from "./tunnelTx.ts";
import { Transaction } from "@mysten/sui/transactions";

const COIN = "0xabc::mtps::MTPS";
const pk = (b: number) => new Uint8Array(32).fill(b);
const party = (address: string, b: number) => ({ address, publicKey: pk(b) });

const created = (objectId: string) => ({
  type: "created",
  objectType: `0xpkg::tunnel::Tunnel<${COIN}>`,
  objectId,
});

/** Reads stub: getTransactionBlock yields the created tunnels (in the given order), and getObject
 *  returns each tunnel's on-chain `party_b.public_key` as the RPC number[] form (32 bytes of one
 *  value) so the opener can demux by party-B pubkey. */
const readsWith = (
  partyBByteById: Record<string, number>,
  objectChanges: unknown[],
) =>
  ({
    waitForTransaction: async () => {},
    getTransactionBlock: async () => ({ objectChanges }),
    getObject: async ({ id }: { id: string }) => ({
      data: {
        content: {
          fields: {
            party_b: {
              fields: { public_key: Array(32).fill(partyBByteById[id]) },
            },
          },
        },
      },
    }),
  }) as unknown as Parameters<typeof openManySharedSeatA>[0]["reads"];

test("openManySharedSeatA builds ONE PTB and demuxes by party-B pubkey, NOT objectChanges order", async () => {
  let signExecCalls = 0;
  let built: Transaction | null = null;
  // objectChanges deliberately REVERSED vs spec order — a correct demux keys on party-B, not order.
  const reads = readsWith({ "0xtunnel0": 0xb0, "0xtunnel1": 0xb1 }, [
    created("0xtunnel1"),
    created("0xtunnel0"),
  ]);

  const ids = await openManySharedSeatA({
    reads,
    signExec: async (tx) => {
      built = tx;
      signExecCalls += 1;
      return { digest: "0xd" };
    },
    coinType: COIN,
    stakeFromBalance: { amount: 30n, coinType: COIN },
    specs: [
      {
        partyA: party("0xa11ce", 0xa0),
        partyB: party("0xb0b0", 0xb0),
        amount: 10n,
      },
      {
        partyA: party("0xa11ce", 0xa0),
        partyB: party("0xb1b1", 0xb1),
        amount: 20n,
      },
    ],
  });

  assert.equal(
    signExecCalls,
    1,
    "exactly one signExec (one PTB) for two opens",
  );
  assert.deepEqual(
    ids,
    ["0xtunnel0", "0xtunnel1"],
    "ids returned in SPEC ORDER, demuxed by party-B pubkey despite reversed objectChanges",
  );
  assert.ok(built, "a transaction was built");
});

test("openManySharedSeatA single-spec flush returns the one id", async () => {
  const reads = readsWith({ "0xsolo": 0xb0 }, [created("0xsolo")]);
  const ids = await openManySharedSeatA({
    reads,
    signExec: async () => ({ digest: "0xd" }),
    coinType: COIN,
    stakeCoinId: "0xstake",
    specs: [
      {
        partyA: party("0xa11ce", 0xa0),
        partyB: party("0xb0b0", 0xb0),
        amount: 10n,
      },
    ],
  });
  assert.deepEqual(ids, ["0xsolo"]);
});

test("openManySharedSeatA rejects BatchCommittedError when the created count mismatches", async () => {
  const THE_DIGEST = "0xcommitted";
  // Two specs but only one created tunnel: a post-commit failure — the tx already landed.
  const reads = readsWith({ "0xonly": 0xb0 }, [created("0xonly")]);

  let caught: unknown;
  try {
    await openManySharedSeatA({
      reads,
      signExec: async () => ({ digest: THE_DIGEST }),
      coinType: COIN,
      stakeFromBalance: { amount: 30n, coinType: COIN },
      specs: [
        {
          partyA: party("0xa11ce", 0xa0),
          partyB: party("0xb0b0", 0xb0),
          amount: 10n,
        },
        {
          partyA: party("0xa11ce", 0xa0),
          partyB: party("0xb1b1", 0xb1),
          amount: 20n,
        },
      ],
    });
    assert.fail("expected openManySharedSeatA to throw");
  } catch (e) {
    caught = e;
  }
  assert.ok(
    caught instanceof BatchCommittedError,
    `expected BatchCommittedError, got ${(caught as Error)?.constructor?.name}`,
  );
  assert.equal((caught as BatchCommittedError).digest, THE_DIGEST);
});

test("openManySharedSeatA rejects duplicate party-B pubkeys across created tunnels (no silent mis-route)", async () => {
  const THE_DIGEST = "0xdup";
  // Both created tunnels report the SAME party-B pubkey (e.g. an opponent reusing one ephemeral key
  // across two coincident matches in this flush). The count matches, but the positional demux would
  // collapse them to one id — the guard must fail loud (committed: never retry), not mis-route stake.
  const reads = readsWith({ "0xtunnelX": 0xb0, "0xtunnelY": 0xb0 }, [
    created("0xtunnelX"),
    created("0xtunnelY"),
  ]);

  let caught: unknown;
  try {
    await openManySharedSeatA({
      reads,
      signExec: async () => ({ digest: THE_DIGEST }),
      coinType: COIN,
      stakeFromBalance: { amount: 30n, coinType: COIN },
      specs: [
        {
          partyA: party("0xa11ce", 0xa0),
          partyB: party("0xb0b0", 0xb0),
          amount: 10n,
        },
        {
          partyA: party("0xa11ce", 0xa0),
          partyB: party("0xb1b1", 0xb1),
          amount: 20n,
        },
      ],
    });
    assert.fail(
      "expected openManySharedSeatA to throw on duplicate party-B pubkey",
    );
  } catch (e) {
    caught = e;
  }
  assert.ok(
    caught instanceof BatchCommittedError,
    `expected BatchCommittedError, got ${(caught as Error)?.constructor?.name}`,
  );
  assert.equal((caught as BatchCommittedError).digest, THE_DIGEST);
});
