import test from "node:test";
import assert from "node:assert/strict";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import type { Transport } from "sui-tunnel-ts/core/distributedTunnel";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { mulberry32 } from "sui-tunnel-ts/sim/rng";
import {
  QuantumPokerProtocol,
  QuantumPokerSeatDriver,
  type PokerState,
  type PokerMove,
  type SlotSecret,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { pokerMoveCodec } from "sui-tunnel-ts/protocol/quantumPokerCodec";
import { rebuildTunnel, restoreInto } from "@/pvp/resumeSession";
import {
  writeResumeRecord,
  flushResumeWrites,
  readResumeRecord,
  clearResumeRecord,
  toWireCoSigned,
} from "@/pvp/resume";
import { makePokerResumeAdapter } from "./pokerResumeAdapter";

// localStorage/window fakes (resume modules touch storage lazily, inside the test body).
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

type PokerSecret = Pick<
  PokerState,
  "localSecretsA" | "localSecretsB" | "holeA" | "holeB"
>;
const readSecret = (s: PokerState): PokerSecret => ({
  localSecretsA: s.localSecretsA,
  localSecretsB: s.localSecretsB,
  holeA: s.holeA,
  holeB: s.holeB,
});
const writeSecret = (s: PokerState, sec: PokerSecret) => {
  s.localSecretsA = sec.localSecretsA;
  s.localSecretsB = sec.localSecretsB;
  s.holeA = sec.holeA;
  s.holeB = sec.holeB;
};

const REVEAL_PHASES = [
  "open_private_holes",
  "reveal_flop",
  "reveal_turn",
  "reveal_river",
  "showdown",
];

function makeLoopback(): { a: Transport; b: Transport } {
  let aCb: ((f: Uint8Array) => void) | null = null;
  let bCb: ((f: Uint8Array) => void) | null = null;
  return {
    a: { send: (f) => bCb?.(f), onFrame: (cb) => (aCb = cb) },
    b: { send: (f) => aCb?.(f), onFrame: (cb) => (bCb = cb) },
  };
}

// A reloaded poker seat rebuilds its tunnel from localStorage and regenerates its next reveal —
// derived from the restored local secrets — byte-identically to a seat restored from the in-memory
// record. The reference uses the pre-JSON secret while the rebuilt seat uses the localStorage
// round-trip, so a non-JSON-safe secret (raw Uint8Array slot value/salt) would corrupt only the
// rebuilt reveal and break parity.
test("poker cold-load: rebuilt seat reveals the next move byte-identically", () => {
  const backend = defaultBackend();
  const keyA = generateKeyPair(),
    keyB = generateKeyPair();
  const tid = `0x${"73".repeat(32)}`;
  const BAL = { a: 10_000n, b: 10_000n };
  const mkProto = () => new QuantumPokerProtocol(4n);

  // Drive a distributed pair through commits/reveals until seat A owes a reveal at a clean checkpoint.
  const loop = makeLoopback();
  const dtA = new DistributedTunnel<PokerState, PokerMove>(
    mkProto(),
    {
      tunnelId: tid,
      self: makeEndpoint(backend, "0xA", keyA, true),
      opponent: makeEndpoint(backend, "0xB", keyB, false),
      selfParty: "A",
      moveCodec: pokerMoveCodec,
    },
    loop.a,
    BAL,
  );
  const dtB = new DistributedTunnel<PokerState, PokerMove>(
    mkProto(),
    {
      tunnelId: tid,
      self: makeEndpoint(backend, "0xB", keyB, true),
      opponent: makeEndpoint(backend, "0xA", keyA, false),
      selfParty: "B",
      moveCodec: pokerMoveCodec,
    },
    loop.b,
    BAL,
  );
  const driverA = new QuantumPokerSeatDriver("A");
  const driverB = new QuantumPokerSeatDriver("B");
  const rng = mulberry32(7);
  let ts = 1n;
  let found = false;
  for (let i = 0; i < 400 && !found; i++) {
    for (const party of ["A", "B"] as const) {
      if (
        party === "A" &&
        dtA.latest &&
        REVEAL_PHASES.includes(dtA.state.phase)
      ) {
        const peek = new QuantumPokerSeatDriver("A").chooseMove(
          dtA.state,
          () => 0.5,
        );
        if (peek && peek.kind === "reveal_slots") {
          found = true;
          break;
        }
      }
      const dt = party === "A" ? dtA : dtB;
      const driver = party === "A" ? driverA : driverB;
      const move = driver.chooseMove(dt.state, rng);
      if (!move) continue;
      dt.propose(move, ts++);
    }
  }
  assert.ok(found, "drove poker to a checkpoint where seat A owes a reveal");

  // Persist seat A's record (public state + JSON-safe secret).
  const capAdapter = makePokerResumeAdapter({
    getSecret: () => readSecret(dtA.state),
    setSecret: () => {},
  });
  const record = {
    matchId: "match-poker",
    tunnelId: tid,
    role: "A" as const,
    game: "quantum-poker",
    opponentWallet: "0xB",
    opponentPubkeyHex: toHex(keyB.publicKey),
    selfEphemeralSecretHex: toHex(keyA.secretKey),
    latestCoSigned: toWireCoSigned(dtA.latest!),
    latestState: capAdapter.serializeState(dtA.state),
    secret: capAdapter.captureSecret!(),
    updatedAt: Date.now(),
  };
  writeResumeRecord(record);
  flushResumeWrites();

  const REVEAL_TS = 999n;

  // Reference: restored from the IN-MEMORY record, proposing A's reveal.
  const refSent: Uint8Array[] = [];
  const refA = new DistributedTunnel<PokerState, PokerMove>(
    mkProto(),
    {
      tunnelId: tid,
      self: makeEndpoint(backend, "0xA", keyA, true),
      opponent: makeEndpoint(backend, "0xB", keyB, false),
      selfParty: "A",
      moveCodec: pokerMoveCodec,
    },
    { send: (b) => refSent.push(b), onFrame() {} },
    BAL,
  );
  restoreInto(
    refA as never,
    record as never,
    makePokerResumeAdapter({
      getSecret: () => readSecret(refA.state),
      setSecret: (sec) => writeSecret(refA.state, sec),
    }) as never,
  );
  const refReveal = new QuantumPokerSeatDriver("A").chooseMove(
    refA.state,
    () => 0.5,
  );
  assert.equal(refReveal?.kind, "reveal_slots");
  refA.propose(refReveal!, REVEAL_TS);

  // Rebuilt: restored from the localStorage round-trip alone, secret applied after rebuild.
  const sent: Uint8Array[] = [];
  let restoredSecret: PokerSecret | null = null;
  const mp = {
    channel: () => ({
      transport: { send: (b: Uint8Array) => sent.push(b), onFrame() {} },
      sendPeer() {},
      onPeer() {},
      addPeerListener() {},
      removePeerListener() {},
    }),
    markActive() {},
  } as never;
  const { tunnel } = rebuildTunnel(
    mp,
    readResumeRecord(tid)!,
    {
      proto: mkProto(),
      moveCodec: pokerMoveCodec,
      adapter: makePokerResumeAdapter({
        getSecret: () => restoredSecret!,
        setSecret: (sec) => {
          restoredSecret = sec;
        },
      }),
    } as never,
    { selfWallet: "0xA" },
  );
  writeSecret(tunnel.state, restoredSecret!);
  const rebReveal = new QuantumPokerSeatDriver("A").chooseMove(
    tunnel.state,
    () => 0.5,
  );
  (tunnel as never as { propose(m: PokerMove, ts: bigint): void }).propose(
    rebReveal!,
    REVEAL_TS,
  );

  assert.ok(refSent.length > 0, "reference seat produced a reveal frame");
  assert.deepEqual(
    Uint8Array.from(sent[0]),
    Uint8Array.from(refSent[0]),
    "rebuilt poker seat reveals byte-identically to the in-memory reference",
  );
  clearResumeRecord(tid);
});

// Regression guard for the field "opponent's turn" poker deadlock (mid-commit reload). A commit_slots
// move carries the seat's private per-slot secrets, but the WIRE codec strips them — the peer must
// never see them. A seat that reloads while its commit is still an unconfirmed pending restores that
// move from the LOCAL resume record; if the record dropped the secrets too, the commit confirms with
// no localSecrets, `state.localSecretsA` stays null, and the seat can never build its reveal
// (`secretsFor` -> null) — it stalls forever showing "opponent's turn". So the resume adapter must
// keep the commit secrets in the LOCAL record even though the wire strips them.
test("poker mid-commit reload: pending commit keeps slot secrets so the draw can still reveal", () => {
  const proto = new QuantumPokerProtocol(4n);
  const state = proto.initialState({
    tunnelId: `0x${"5a".repeat(32)}`,
    initialBalances: { a: 10_000n, b: 10_000n },
  });
  assert.equal(state.phase, "commit");

  const commit = new QuantumPokerSeatDriver("A").chooseMove(
    state,
    mulberry32(3),
  );
  assert.equal(commit?.kind, "commit_slots");
  const minted = (commit as { localSecrets?: (SlotSecret | null)[] })
    .localSecrets;
  assert.ok(
    minted && minted.every((s) => s),
    "a fresh commit mints a full set of slot secrets",
  );

  const adapter = makePokerResumeAdapter({
    getSecret: () => readSecret(state),
    setSecret: () => {},
  });

  // The WIRE codec drops the secrets (the peer must never learn them) — so the record adapter, not
  // the wire, is what has to preserve them across a reload.
  const overWire = pokerMoveCodec.decode(pokerMoveCodec.encode(commit!));
  assert.equal(
    (overWire as { localSecrets?: unknown }).localSecrets ?? null,
    null,
    "wire codec strips commit secrets",
  );

  // The LOCAL resume-record round-trip MUST keep them, byte-for-byte.
  const restored = adapter.deserializeMove(
    adapter.serializeMove!(commit!) as never,
  );
  const restoredSecrets = (restored as { localSecrets?: (SlotSecret | null)[] })
    .localSecrets;
  assert.ok(
    restoredSecrets && restoredSecrets.every((s) => s),
    "resume record keeps the pending commit's slot secrets across reload",
  );
  assert.deepEqual(restoredSecrets, minted);

  // The heal: confirming the restored pending commit repopulates localSecretsA, so the seat's later
  // reveal has the secrets it needs. Without them applyCommit leaves localSecretsA null -> deadlock.
  const confirmed = proto.applyMove(state, restored, "A");
  assert.ok(
    confirmed.localSecretsA && confirmed.localSecretsA.every((s) => s),
    "restored commit repopulates localSecretsA, unblocking the reveal",
  );
});

// Regression guard for the LIVE reconnect "opponent's turn" stall (poker + blackjack shape). On a
// resync, `adoptCheckpoint` swaps in the peer's PUBLIC state, which strips this seat's private slot
// secrets — but the driver still holds them (minted at commit). If they aren't pushed back into the
// adopted state, the persisted resume record captures `null` and the next reveal can never be built
// (`makeRevealMove` -> null -> pend=false forever). `restoreSecretsToState` re-anchors them.
test("poker resync-adopt: driver re-anchors its secret so the record isn't wiped", () => {
  const proto = new QuantumPokerProtocol(4n);
  const s0 = proto.initialState({
    tunnelId: `0x${"5b".repeat(32)}`,
    initialBalances: { a: 10_000n, b: 10_000n },
  });
  const driverA = new QuantumPokerSeatDriver("A");
  const commitA = driverA.makeCommitMove(s0, mulberry32(3)); // mints + caches A's secret
  const commitB = new QuantumPokerSeatDriver("B").makeCommitMove(
    s0,
    mulberry32(9),
  );
  assert.equal(commitA?.kind, "commit_slots");
  const live = proto.applyMove(
    proto.applyMove(s0, commitA!, "A"),
    commitB!,
    "B",
  );
  assert.ok(
    live.commitA && live.localSecretsA,
    "live state holds A's commit + secret",
  );

  // The resync adopt: the peer advertises only PUBLIC state — our secret is stripped.
  const adapter = makePokerResumeAdapter({
    getSecret: () => readSecret(live),
    setSecret: () => {},
  });
  const adopted = adapter.deserializeState(
    adapter.serializeState(live) as never,
  );
  assert.ok(
    !adopted.localSecretsA,
    "adopt swaps in peer public state — our secret is gone",
  );
  // Persisting HERE (the bug) would write a null secret → an unrecoverable cold-load.
  const capBefore = makePokerResumeAdapter({
    getSecret: () => readSecret(adopted),
    setSecret: () => {},
  }).captureSecret!() as { localSecretsA: unknown };
  assert.equal(
    capBefore.localSecretsA,
    null,
    "record would be wiped without the fix",
  );

  // The fix: the driver re-anchors its cached secret into the adopted state.
  driverA.restoreSecretsToState(adopted);
  assert.ok(
    adopted.localSecretsA && adopted.localSecretsA.every((x) => x),
    "secret re-anchored from the driver's cache",
  );
  const capAfter = makePokerResumeAdapter({
    getSecret: () => readSecret(adopted),
    setSecret: () => {},
  }).captureSecret!() as { localSecretsA: unknown[] | null };
  assert.ok(
    capAfter.localSecretsA && capAfter.localSecretsA.every((x) => x),
    "persisted record now keeps the secret across the reconnect",
  );
});
