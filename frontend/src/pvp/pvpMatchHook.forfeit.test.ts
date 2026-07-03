import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { buildForfeitHalf } from "@/pvp/forfeit";
import { coSignForfeitFromPeerRoot } from "@/pvp/settleClose";
import { coSignedToSettleBody } from "@/backend/settleRequest";
import {
  PvpSession,
  type PvpMatchSpec,
  type PvpStatus,
} from "@/pvp/pvpMatchHook";
import type { PvpChannel, PeerMessage, Role } from "@/pvp/mpClient";
import {
  writeResumeRecord,
  flushResumeWrites,
  readResumeRecord,
  type ResumeRecord,
  type WireCoSigned,
} from "@/pvp/resume";

// Locks the wire the forfeit path signs: forced (0, total), finalNonce 1. Full orchestration
// (below) drives `PvpSession.forfeit()` itself, not just this builder.
//
// Uses real 32-byte hex addresses (mirroring forfeit.test.ts) rather than placeholder strings like
// "0xt"/"0xh" — serializeSettlementWithRoot's addressToBytes32 rejects anything shorter.
test("forfeit half zeroes the human and gives the bot the pot", () => {
  const eph = generateKeyPair();
  const { settlement } = buildForfeitHalf({
    tunnelId: `0x${"11".repeat(32)}`,
    total: 2n,
    wallet: `0x${"22".repeat(32)}`,
    eph,
    timestamp: 1n,
    transcriptRoot: new Uint8Array(32),
  });
  assert.equal(settlement.partyABalance, 0n);
  assert.equal(settlement.partyBBalance, 2n);
});

// ============================================================================================
// PvpSession.forfeit() orchestration — the coverage gap the Task 5 review flagged: the test above
// only re-exercises buildForfeitHalf, never the session method that wires it into a live match.
//
// `PvpSession` is exported (see pvpMatchHook.ts) SOLELY so this test can construct one directly and
// drive `forfeit()` against hand-built mocks, bypassing `activateSession`'s full matchmaking/
// on-chain wiring (which needs a wallet, a socket, and a funded tunnel). The private fields
// `forfeit()` reads (`dt`/`channel`/`waitPeer`/`selfEph`/`role`/`status`/`settleFired`) are poked
// through `peek()` — a type-only bypass of TS's compile-time `private`, not a production API change.
// ============================================================================================

// localStorage/window fakes so `clearResumeRecord`/`writeResumeRecord` (real, unmocked) have
// somewhere to write under plain Node — mirrors tttColdLoad.test.ts's shim exactly.
(globalThis as Record<string, unknown>).localStorage = new (class {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
})();
(globalThis as Record<string, unknown>).window = { addEventListener() {} };

type FState = { winner: null };
type FMove = { kind: "noop" };

const BAL = { a: 1000n, b: 1000n };
// A minimal stand-in Protocol: forfeit() only ever reads `dt.protocol.balances(dt.state)`.
// `as never` (mirrors settleClose.test.ts) sidesteps a full structural Protocol<State,Move> match.
const proto = {
  name: "forfeit-orchestration-test",
  initialState: () => ({}),
  applyMove: (s: unknown) => s,
  encodeState: () => new Uint8Array(),
  balances: () => BAL,
  isTerminal: () => false,
} as never;

const noopTransport = { send: () => {}, onFrame: () => {} };

function makeSpec(): PvpMatchSpec<FState, FMove, null, null> {
  return {
    game: "forfeit-orchestration-test",
    stepMs: 1000,
    stake: 1000n,
    makeProtocol: () => proto,
    deriveView: () => null,
    makeResumeAdapter: () => {
      throw new Error("makeResumeAdapter is not exercised by forfeit()");
    },
    idleIntent: null,
    intentToMove: () => ({ kind: "noop" }),
    readIntent: () => undefined,
  };
}

/** A fresh human-seat tunnel + the bot's per-match key, mirroring settleClose.test.ts's `pair()`. */
function makeRig() {
  const backend = defaultBackend();
  const wallet = "0xa";
  const botWallet = "0xb";
  const ephSelf = generateKeyPair();
  const keyB = generateKeyPair();
  const tunnelId = "0x7";
  const dt = new DistributedTunnel<FState, FMove>(
    proto,
    {
      tunnelId,
      self: makeEndpoint(backend, wallet, ephSelf, true),
      opponent: makeEndpoint(
        backend,
        botWallet,
        { publicKey: keyB.publicKey, scheme: ephSelf.scheme },
        false,
      ),
      selfParty: "A",
    },
    noopTransport,
    BAL,
  );
  return { dt, wallet, botWallet, ephSelf, keyB, tunnelId };
}

function makeChannel(): { channel: PvpChannel; sent: PeerMessage[] } {
  const sent: PeerMessage[] = [];
  const channel: PvpChannel = {
    transport: noopTransport as unknown as PvpChannel["transport"],
    sendPeer: (msg) => {
      sent.push(msg);
    },
    onPeer: () => {},
    addPeerListener: () => {},
    removePeerListener: () => {},
  };
  return { channel, sent };
}

/** `waitPeer("settleHalf")` stand-in: resolves with `reply`, or (mode "never") hangs forever like a
 *  dead bot — exercising forfeit()'s own `FORFEIT_SETTLE_TIMEOUT_MS` race. */
function makeWaitPeer(
  reply: { sig: string; transcriptRoot: string } | "never",
) {
  return <T>(tag: string): Promise<T> => {
    assert.equal(
      tag,
      "settleHalf",
      "forfeit() only ever waits on the settleHalf tag",
    );
    if (reply === "never") return new Promise<T>(() => {});
    return Promise.resolve(reply as unknown as T);
  };
}

function fakeDeps(wallet: string, createdAt: string) {
  return {
    account: { address: wallet },
    client: {
      getObject: async () => ({
        data: { content: { fields: { created_at: createdAt } } },
      }),
    },
    signExec: async () => {
      throw new Error("signExec must not be called on the happy path");
    },
    sponsoredSignExec: async () => {
      throw new Error("sponsoredSignExec must not be called on the happy path");
    },
    selectStakeCoin: async () => {
      throw new Error("selectStakeCoin is not used by forfeit()");
    },
    prepareStake: async () => {
      throw new Error("prepareStake is not used by forfeit()");
    },
    ensureStakeBalance: async () => {
      throw new Error("ensureStakeBalance is not used by forfeit()");
    },
  };
}

function dummyWireCoSigned(tunnelId: string): WireCoSigned {
  return {
    update: {
      tunnelId,
      stateHash: "00".repeat(32),
      nonce: "0",
      timestamp: "0",
      partyABalance: "1000",
      partyBBalance: "1000",
    },
    sigA: "00".repeat(64),
    sigB: "00".repeat(64),
  };
}

/** Intercepts the `/settle` POST `getControlPlaneClient().settle` issues; anything else throws
 *  (so a happy-path test never silently falls through to the real network or the wallet-close
 *  fallback). Restore the real global `fetch` in a `finally`. */
function installFetchMock(onSettle: (url: string, body: Uint8Array) => void) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/settle")) {
      onSettle(url, init?.body as Uint8Array);
      return {
        ok: true,
        json: async () => ({
          txDigest: "0xdigest",
          walrusBlobId: "blob",
          proofUrl: "https://proof.example/1",
        }),
      } as Response;
    }
    throw new Error(`forfeit orchestration test: unexpected fetch ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Type-only bypass of TS's compile-time `private` so the test can wire the session's per-match
 *  handles directly — see the file-header comment. Not a production visibility change. */
interface SessionPeek<S extends { winner: unknown }, M> {
  dt: DistributedTunnel<S, M> | null;
  channel: PvpChannel | null;
  waitPeer: (<T>(t: string) => Promise<T>) | null;
  selfEph: KeyPair | null;
  role: Role | null;
  status: PvpStatus;
  settleFired: boolean;
}
function peek<S extends { winner: unknown }, M, I, V>(
  session: PvpSession<S, M, I, V>,
): SessionPeek<S, M> {
  return session as unknown as SessionPeek<S, M>;
}

test("forfeit(): sends a bare forfeit frame, submits an empty-body co-signed close, clears the resume record", async () => {
  const { dt, wallet, botWallet, ephSelf, keyB, tunnelId } = makeRig();
  const { channel, sent } = makeChannel();
  const root = new Uint8Array(32).fill(9);
  const total = 2000n;
  const createdAt = 1000n;
  const { sig: botSig } = buildForfeitHalf({
    tunnelId,
    total,
    wallet: botWallet,
    eph: keyB,
    timestamp: createdAt,
    transcriptRoot: root,
  });
  const waitPeer = makeWaitPeer({
    sig: toHex(botSig),
    transcriptRoot: toHex(root),
  });

  writeResumeRecord({
    matchId: "match-forfeit-1",
    tunnelId,
    role: "A",
    game: "forfeit-orchestration-test",
    opponentWallet: botWallet,
    opponentPubkeyHex: toHex(keyB.publicKey),
    selfEphemeralSecretHex: toHex(ephSelf.secretKey),
    latestCoSigned: dummyWireCoSigned(tunnelId),
    latestState: null,
    updatedAt: Date.now(),
  } satisfies ResumeRecord);
  flushResumeWrites();
  assert.ok(
    readResumeRecord(tunnelId),
    "the resume record is present before forfeit()",
  );

  let capturedBody: Uint8Array | null = null;
  const restoreFetch = installFetchMock((_url, body) => {
    capturedBody = body;
  });
  try {
    const session = new PvpSession(makeSpec());
    session.deps = fakeDeps(wallet, createdAt.toString());
    const p = peek(session);
    p.dt = dt;
    p.channel = channel;
    p.waitPeer = waitPeer;
    p.selfEph = ephSelf;
    p.role = "A";
    p.status = "playing";
    p.settleFired = false;

    session.forfeit();
    // The shared guard flips synchronously, before any await — see the dedicated guard test below.
    assert.equal(p.settleFired, true);

    await waitFor(() => session.getSnapshot().status === "idle", 2000);

    assert.deepEqual(
      sent,
      [{ t: "forfeit" }],
      'forfeit() sends exactly one bare {t:"forfeit"} frame, before anything else',
    );
    assert.ok(capturedBody, "the co-signed close was submitted to the backend");

    // Independently reproduce what forfeit() must have signed+submitted (ed25519 is deterministic,
    // so the SAME inputs byte-identically reproduce its output) and compare wire bytes directly —
    // proving the empty-body wire (coSignedToSettleBody(co, [])), not just that *something* posted.
    const expectedCo = coSignForfeitFromPeerRoot(
      dt,
      wallet,
      ephSelf,
      createdAt,
      root,
      total,
      botSig,
    );
    const expectedBody = coSignedToSettleBody(expectedCo, []);
    assert.deepEqual(
      capturedBody,
      expectedBody,
      "submits coSignedToSettleBody(co, []) — the bot owns the transcript, the FE keeps none",
    );

    assert.equal(
      readResumeRecord(tunnelId),
      null,
      "the resume record is cleared once the close is submitted",
    );
  } finally {
    restoreFetch();
  }
});

test("forfeit(): the settleFired guard fires once, making it mutually exclusive with a natural-terminal settle", async () => {
  const { dt, wallet, botWallet, ephSelf, keyB, tunnelId } = makeRig();
  const { channel, sent } = makeChannel();
  const root = new Uint8Array(32).fill(3);
  const { sig: botSig } = buildForfeitHalf({
    tunnelId,
    total: 2000n,
    wallet: botWallet,
    eph: keyB,
    timestamp: 1n,
    transcriptRoot: root,
  });
  const waitPeer = makeWaitPeer({
    sig: toHex(botSig),
    transcriptRoot: toHex(root),
  });
  const restoreFetch = installFetchMock(() => {});
  try {
    const session = new PvpSession(makeSpec());
    session.deps = fakeDeps(wallet, "1");
    const p = peek(session);
    p.dt = dt;
    p.channel = channel;
    p.waitPeer = waitPeer;
    p.selfEph = ephSelf;
    p.role = "A";
    p.status = "playing";

    // Direction 1: a natural-terminal settle (triggerSettle) already tripped the SHARED guard —
    // forfeit() must be a pure no-op (no frame sent), not fall back to leave().
    p.settleFired = true;
    session.forfeit();
    assert.deepEqual(
      sent,
      [],
      "forfeit() sends nothing once the shared settleFired guard is already tripped",
    );

    // Direction 2: forfeit() itself trips the guard SYNCHRONOUSLY on entry (before its first await),
    // so a same-tick triggerSettle racing right behind it would see it already set and skip too —
    // exactly one close either way this race resolves.
    p.settleFired = false;
    session.forfeit();
    assert.equal(
      p.settleFired,
      true,
      "forfeit() arms the shared guard synchronously on entry",
    );
    // The bare frame ships after an internal `await readCreatedAt(...)`, not synchronously — wait
    // for it before racing the second call, or the assertion below would just be checking too early.
    await waitFor(() => sent.length > 0, 2000);
    session.forfeit(); // a second forfeit() call, guard already tripped by the first
    assert.deepEqual(
      sent,
      [{ t: "forfeit" }],
      "a second forfeit() call adds no further frame — fire-once",
    );

    await waitFor(() => session.getSnapshot().status === "idle", 2000);
  } finally {
    restoreFetch();
  }
});

test("forfeit(): a black-holed created_at RPC times out into reset (the hang is before the peer wait)", async () => {
  const { dt, wallet, ephSelf } = makeRig();
  const { channel, sent } = makeChannel();
  // waitPeer would answer instantly, but forfeit() never reaches it: the `created_at` getObject
  // black-holes (socket open, no response, no error). This is Theodore's exact regression — the read
  // ran BEFORE the timeout armed, so a silent RPC stranded the session in "settling" forever.
  const waitPeer = makeWaitPeer({
    sig: "00".repeat(64),
    transcriptRoot: "00".repeat(32),
  });
  const restoreFetch = installFetchMock(() => {
    throw new Error(
      "settle must never be reached when created_at never resolves",
    );
  });
  try {
    const session = new PvpSession(makeSpec());
    session.deps = {
      ...fakeDeps(wallet, "1"),
      client: { getObject: () => new Promise(() => {}) },
    };
    const p = peek(session);
    p.dt = dt;
    p.channel = channel;
    p.waitPeer = waitPeer;
    p.selfEph = ephSelf;
    p.role = "A";
    p.status = "playing";
    p.settleFired = false;

    session.forfeit();
    // runForfeitClose now bounds the WHOLE pre-submit body (created_at read included), so even with
    // no peer wait ever reached, the 10s timeout rejects → catch → reset. FORFEIT_SETTLE_TIMEOUT_MS
    // is 10s; poll above it so a genuine regression (the old hang) fails loudly, not silently.
    await waitFor(() => session.getSnapshot().status === "idle", 15_000);
    assert.equal(
      session.getSnapshot().status,
      "idle",
      "the created_at hang is bounded by the forfeit timeout, not left in settling",
    );
    assert.deepEqual(
      sent,
      [],
      "the forfeit frame is never sent — the read hangs before it, and is now bounded",
    );
  } finally {
    restoreFetch();
  }
});

test("forfeit(): a peer that never co-signs times out into reset instead of hanging", async () => {
  const { dt, wallet, ephSelf } = makeRig();
  const { channel, sent } = makeChannel();
  const waitPeer = makeWaitPeer("never");
  const restoreFetch = installFetchMock(() => {
    throw new Error("settle must never be reached when the peer never answers");
  });
  try {
    const session = new PvpSession(makeSpec());
    session.deps = fakeDeps(wallet, "1");
    const p = peek(session);
    p.dt = dt;
    p.channel = channel;
    p.waitPeer = waitPeer;
    p.selfEph = ephSelf;
    p.role = "A";
    p.status = "playing";
    p.settleFired = false;

    session.forfeit();
    // The bare frame ships after an internal `await readCreatedAt(...)`, not synchronously.
    await waitFor(() => sent.length > 0, 2000);
    assert.deepEqual(
      sent,
      [{ t: "forfeit" }],
      "the forfeit frame is sent before the settleHalf wait that then times out",
    );

    // FORFEIT_SETTLE_TIMEOUT_MS is 10s; bound the poll well above that so a genuine regression
    // (a hang) fails the test loudly instead of the test itself hanging forever.
    await waitFor(() => session.getSnapshot().status === "idle", 15_000);
    assert.equal(
      session.getSnapshot().status,
      "idle",
      "the timeout resets to the lobby, not a hang",
    );
  } finally {
    restoreFetch();
  }
});
