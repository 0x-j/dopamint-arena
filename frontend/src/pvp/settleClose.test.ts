import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { bytesToHex } from "sui-tunnel-ts";
import {
  coSignCloseFromPeerRoot,
  coSignForfeitFromPeerRoot,
} from "./settleClose";
import { buildForfeitHalf } from "./forfeit";

const BAL = { a: 1000n, b: 1000n };
const proto = {
  name: "settle-close-test",
  initialState: () => ({}),
  applyMove: (s: unknown) => s,
  encodeState: () => new Uint8Array(),
  balances: () => BAL,
  isTerminal: () => false,
} as never;

const noopTransport = { send: () => {}, onFrame: () => {} };

/** A seat-A + seat-B pair whose settlement builders sign over the shared tunnel state. */
function pair() {
  const backend = defaultBackend();
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const dtA = new DistributedTunnel(
    proto,
    {
      tunnelId: "0x7",
      self: makeEndpoint(backend, "0xa", keyA, true),
      opponent: makeEndpoint(backend, "0xb", keyB, false),
      selfParty: "A",
    },
    noopTransport,
    BAL,
  );
  const dtB = new DistributedTunnel(
    proto,
    {
      tunnelId: "0x7",
      self: makeEndpoint(backend, "0xb", keyB, true),
      opponent: makeEndpoint(backend, "0xa", keyA, false),
      selfParty: "B",
    },
    noopTransport,
    BAL,
  );
  return { dtA, dtB, keyA, keyB };
}

// The whole point of "FE trusts the bot's transcript": seat A never computes a root of its own — it
// signs its half over the root the peer (bot) supplied, and the co-signed close anchors THAT root.
test("co-signs the close over the peer's root, not a self-computed one", () => {
  const { dtA, dtB } = pair();
  const peerRoot = new Uint8Array(32).fill(7);
  const peerHalf = dtB.buildSettlementHalfWithRoot(9n, peerRoot, 0n);

  const co = coSignCloseFromPeerRoot(dtA, 9n, peerRoot, peerHalf.sigSelf);

  assert.equal(bytesToHex(co.settlement.transcriptRoot), bytesToHex(peerRoot));
});

// combine must verify the peer's signature — a forged/mismatched half cannot produce a close.
test("rejects a peer half whose signature does not verify", () => {
  const { dtA } = pair();
  const peerRoot = new Uint8Array(32).fill(7);
  const badSig = new Uint8Array(64).fill(1);

  assert.throws(() => coSignCloseFromPeerRoot(dtA, 9n, peerRoot, badSig));
});

// Sibling of the above: a forfeit forces (0, total) instead of the co-signed game-state balances,
// but still anchors the peer's root and still requires a peer signature that verifies against dtA's
// configured opponent key — so the bot's half is signed with the SAME key backing dtB (keyB), exactly
// as dtB.buildSettlementHalfWithRoot does above.
test("coSignForfeitFromPeerRoot forces (0,total) over the peer's root", () => {
  const { dtA, dtB, keyB } = pair();
  const peerRoot = new Uint8Array(32).fill(9);
  const total = 2000n; // a + b

  const { sig: botSig } = buildForfeitHalf({
    tunnelId: dtB.tunnelId,
    total,
    wallet: "0xb",
    eph: keyB,
    timestamp: 9n,
    transcriptRoot: peerRoot,
  });

  const eph = generateKeyPair();
  const co = coSignForfeitFromPeerRoot(
    dtA,
    "0xa",
    eph,
    9n,
    peerRoot,
    total,
    botSig,
  );

  assert.equal(co.settlement.partyABalance, 0n);
  assert.equal(co.settlement.partyBBalance, total);
  assert.equal(bytesToHex(co.settlement.transcriptRoot), bytesToHex(peerRoot));
});

// coSignForfeitFromPeerRoot must also verify the peer's forfeit signature — a forged/mismatched half cannot produce a forfeit.
test("coSignForfeitFromPeerRoot rejects a peer half whose signature does not verify", () => {
  const { dtA } = pair();
  const peerRoot = new Uint8Array(32).fill(9);
  const eph = generateKeyPair();
  const badSig = new Uint8Array(64).fill(1);

  assert.throws(() =>
    coSignForfeitFromPeerRoot(dtA, "0xa", eph, 9n, peerRoot, 2000n, badSig),
  );
});
