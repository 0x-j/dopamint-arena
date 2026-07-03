import test from "node:test";
import assert from "node:assert/strict";
import {
  DistributedTunnel,
  type Transport,
} from "sui-tunnel-ts/core/distributedTunnel";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import {
  QuantumPokerSeatDriver,
  type PokerMove,
  type PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { mulberry32 } from "sui-tunnel-ts/sim/rng";
import { toWireCoSigned } from "@/pvp/resume";
import { rebuildTunnel } from "@/pvp/resumeSession";
import { quantumPokerPvpSpec } from "./quantumPokerPvpSpec";

// Reproduction harness for the worker "stuck at Shuffling · opponent's turn" stall: run the REAL
// spec controller on BOTH seats (B stands in for the fleet bot, which runs the same plumbing) over
// transports that deliver frames ASYNCHRONOUSLY — the pool's MessagePort hop — instead of the
// synchronous re-entrant delivery the legacy main-thread hook gets. If the controller's
// propose/dedupe logic has an ordering hole, the shuffle never completes and nonce stays put.

type Dt = DistributedTunnel<PokerState, PokerMove>;

/** Frames cross on the NEXT macrotask, like a MessagePort — never re-entrantly. */
function makeAsyncLoopback(): { a: Transport; b: Transport } {
  let aCb: ((f: Uint8Array) => void) | null = null;
  let bCb: ((f: Uint8Array) => void) | null = null;
  return {
    a: {
      send: (f) => setImmediate(() => bCb?.(f)),
      onFrame: (cb) => (aCb = cb),
    },
    b: {
      send: (f) => setImmediate(() => aCb?.(f)),
      onFrame: (cb) => (bCb = cb),
    },
  };
}

function buildSeat(
  role: "A" | "B",
  transport: Transport,
  keys: { self: ReturnType<typeof generateKeyPair>; opp: Uint8Array },
  tunnelId: string,
  stake: bigint,
): { dt: Dt; kick: () => void } {
  const backend = defaultBackend();
  const dt: Dt = new DistributedTunnel(
    quantumPokerPvpSpec.makeProtocol(undefined),
    {
      tunnelId,
      self: makeEndpoint(backend, `0x${role}`, keys.self, true),
      opponent: makeEndpoint(
        backend,
        `0x${role === "A" ? "B" : "A"}`,
        { publicKey: keys.opp, scheme: keys.self.scheme },
        false,
      ),
      selfParty: role,
      moveCodec: quantumPokerPvpSpec.moveCodec,
    },
    transport,
    { a: stake, b: stake },
  );
  const controller = quantumPokerPvpSpec.createMatch({
    role,
    tunnel: () => dt,
    auto: () => true,
    emitView: () => {},
  });
  controller.initSetup(undefined);
  // Mirror pvpMatchSession.activateSession: every confirmed update re-drives the controller.
  dt.onConfirmed = () => controller.onConfirmed();
  return { dt, kick: () => controller.onConfirmed() };
}

const drain = () => new Promise<void>((r) => setImmediate(() => r()));

// The stall this pins: the spec once used the solo tuning cap (180) while the fleet bot co-signs
// with 50 — `handCap` is in `encodeState`, so the bot computed a different stateHash for the very
// first commit and silently rejected it. These values are the bot's, from
// rust/fleet/core/src/play_match.rs (QUANTUM_POKER_HAND_CAP / QUANTUM_POKER_ANTE / QUANTUM_POKER).
test("spec protocol matches the fleet bot's poker profile (handCap 50, ante 1)", () => {
  const proto = quantumPokerPvpSpec.makeProtocol(undefined);
  const initial = proto.initialState({
    tunnelId: `0x${"7b".repeat(32)}`,
    initialBalances: { a: 100n, b: 100n }, // the bot profile's stakeEach
  });
  assert.equal(initial.handCap, 50n, "handCap must equal the bot's cap");
  assert.equal(
    quantumPokerPvpSpec.stake,
    100n,
    "stake must equal the bot profile's stakeEach",
  );
});

// Live-reconnect regression (#195, spec port): a resync `adoptCheckpoint` swaps in the peer's
// PUBLIC state, stripping this seat's private slot secrets from `state.localSecrets*`. The spec's
// resume adapter must persist from the driver's adopt-proof cache (`ownSecretsFor`) instead of the
// wiped state field — otherwise the record captures a null secret and every later cold-load is
// unrecoverable (the exact "opponent's turn forever" stall observed live, IndexedDB record with
// localSecretsA: null).
test("adapter persists the driver's secrets even after an adopt strips the state", () => {
  const backend = defaultBackend();
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const tid = `0x${"7d".repeat(32)}`;
  const BAL = { a: 100n, b: 100n };
  let aCb: ((f: Uint8Array) => void) | null = null;
  let bCb: ((f: Uint8Array) => void) | null = null;
  const dtA: Dt = new DistributedTunnel(
    quantumPokerPvpSpec.makeProtocol(undefined),
    {
      tunnelId: tid,
      self: makeEndpoint(backend, "0xA", keyA, true),
      opponent: makeEndpoint(
        backend,
        "0xB",
        { publicKey: keyB.publicKey, scheme: keyA.scheme },
        false,
      ),
      selfParty: "A",
      moveCodec: quantumPokerPvpSpec.moveCodec,
    },
    { send: (f) => bCb?.(f), onFrame: (cb) => (aCb = cb) },
    BAL,
  );
  const dtB: Dt = new DistributedTunnel(
    quantumPokerPvpSpec.makeProtocol(undefined),
    {
      tunnelId: tid,
      self: makeEndpoint(backend, "0xB", keyB, true),
      opponent: makeEndpoint(
        backend,
        "0xA",
        { publicKey: keyA.publicKey, scheme: keyB.scheme },
        false,
      ),
      selfParty: "B",
      moveCodec: quantumPokerPvpSpec.moveCodec,
    },
    { send: (f) => aCb?.(f), onFrame: (cb) => (bCb = cb) },
    BAL,
  );
  void dtB;
  const ctl = quantumPokerPvpSpec.createMatch({
    role: "A",
    tunnel: () => dtA,
    auto: () => true,
    emitView() {},
  });
  ctl.initSetup(undefined);
  ctl.onConfirmed(); // A commits — the driver mints + caches the slot secrets
  assert.ok(dtA.state.localSecretsA, "commit seeded local secrets");

  // Simulate the adopt: the peer's public state has no secrets for this seat.
  dtA.state.localSecretsA = null;
  const adapter = ctl.resumeAdapter!();
  adapter.onReconciled(dtA as never, "adopted" as never);

  const captured = adapter.captureSecret!() as {
    localSecretsA: unknown[] | null;
  };
  assert.ok(
    captured.localSecretsA && captured.localSecretsA.every((s) => s),
    "captureSecret read the driver's adopt-proof cache (was: null → poisoned record + frozen cold-load)",
  );
});

// Cold-resume regression (the "resumed but frozen" stall): rebuild a mid-match seat through the
// SPEC controller exactly as pvpMatchSession.resume() does — seat identity known at createMatch,
// rebuildTunnel restores the checkpoint, the secret is re-applied once io.tunnel() resolves, then
// onConfirmed kicks. The restored seat MUST propose its due reveal; before the fixes it silently
// stalled (driver never built without initSetup + secrets restored into a null tunnel).
test("cold resume: the rebuilt spec controller proposes the due reveal", () => {
  const backend = defaultBackend();
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const tid = `0x${"7c".repeat(32)}`;
  const BAL = { a: 100n, b: 100n };
  const REVEAL_PHASES = [
    "open_private_holes",
    "reveal_flop",
    "reveal_turn",
    "reveal_river",
    "showdown",
  ];

  // Drive a live pair (manual drivers, sync loopback) until seat A owes a reveal at a clean
  // checkpoint — the pokerColdLoad recipe.
  let aCb: ((f: Uint8Array) => void) | null = null;
  let bCb: ((f: Uint8Array) => void) | null = null;
  const dtA: Dt = new DistributedTunnel(
    quantumPokerPvpSpec.makeProtocol(undefined),
    {
      tunnelId: tid,
      self: makeEndpoint(backend, "0xA", keyA, true),
      opponent: makeEndpoint(
        backend,
        "0xB",
        { publicKey: keyB.publicKey, scheme: keyA.scheme },
        false,
      ),
      selfParty: "A",
      moveCodec: quantumPokerPvpSpec.moveCodec,
    },
    { send: (f) => bCb?.(f), onFrame: (cb) => (aCb = cb) },
    BAL,
  );
  const dtB: Dt = new DistributedTunnel(
    quantumPokerPvpSpec.makeProtocol(undefined),
    {
      tunnelId: tid,
      self: makeEndpoint(backend, "0xB", keyB, true),
      opponent: makeEndpoint(
        backend,
        "0xA",
        { publicKey: keyA.publicKey, scheme: keyB.scheme },
        false,
      ),
      selfParty: "B",
      moveCodec: quantumPokerPvpSpec.moveCodec,
    },
    { send: (f) => aCb?.(f), onFrame: (cb) => (bCb = cb) },
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

  // Persist through the SPEC's own adapter, bound to the live tunnel.
  const capCtl = quantumPokerPvpSpec.createMatch({
    role: "A",
    tunnel: () => dtA,
    auto: () => false,
    emitView() {},
  });
  const capAdapter = capCtl.resumeAdapter!();
  const record = {
    matchId: "m-poker",
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

  // Rebuild exactly as pvpMatchSession.resume() does.
  let rebuiltDt: Dt | null = null;
  const ctl = quantumPokerPvpSpec.createMatch({
    role: "A",
    tunnel: () => rebuiltDt,
    auto: () => true,
    emitView() {},
  });
  const adapter = ctl.resumeAdapter!();
  const sent: Uint8Array[] = [];
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
    record as never,
    {
      proto: quantumPokerPvpSpec.makeProtocol(undefined),
      moveCodec: quantumPokerPvpSpec.moveCodec,
      adapter,
    } as never,
    { selfWallet: "0xA" },
  );
  rebuiltDt = tunnel as never;
  adapter.restoreSecret!(record.secret as never); // resume() re-applies once io.tunnel() resolves
  ctl.onConfirmed(); // the resume kick

  assert.ok(
    sent.length > 0,
    "the restored seat proposed its due reveal (was: frozen at 'opponent's turn')",
  );
});

test("worker poker spec completes the shuffle over an async (MessagePort-like) transport", async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const tid = `0x${"7a".repeat(32)}`;
  const loop = makeAsyncLoopback();
  const seatA = buildSeat(
    "A",
    loop.a,
    { self: keyA, opp: keyB.publicKey },
    tid,
    100n,
  );
  const seatB = buildSeat(
    "B",
    loop.b,
    { self: keyB, opp: keyA.publicKey },
    tid,
    100n,
  );

  // Arena kick: both seats start driving on activation (the fleet bot on tunnel-open, us on join).
  seatA.kick();
  seatB.kick();

  // Drain until the first shuffle completes (commitA, commitB, then the hole reveals — nonce ≥ 4)
  // under a hard cap. Move counts per drain vary with the persona bots' RNG, so a fixed drain count
  // flakes; a stalled shuffle still fails — nonce freezes and the cap runs out. NB: don't assert on
  // the final phase — "commit" recurs at every next_hand, so any phase is legal once nonces flow.
  const DRAIN_CAP = 2000;
  let drains = 0;
  while (seatA.dt.nonce < 4n && drains < DRAIN_CAP) {
    await drain();
    drains++;
  }
  assert.ok(
    seatA.dt.nonce >= 4n,
    `shuffle stalled: nonce ${seatA.dt.nonce}, phase ${seatA.dt.state.phase} after ${drains} drains`,
  );
});
