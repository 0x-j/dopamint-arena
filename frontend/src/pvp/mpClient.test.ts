import test from "node:test";
import assert from "node:assert/strict";
import { MpClient, nextBackoffDelay } from "./mpClient";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  // test helpers
  open() {
    this.onopen?.();
  }
  recv(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  // drive the challenge so connect() resolves
  handshake() {
    this.open();
    this.recv({ type: "challenge", nonce: "n1" });
  }
}

function mkClient() {
  FakeWebSocket.instances = [];
  const eph = generateKeyPair();
  const mp = new MpClient("ws://x/v1/mp", "0xwallet", eph as never, {
    WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    reconnect: { baseMs: 1, maxMs: 4, jitter: 0 },
    scheduler: (fn) => fn(), // run reconnect synchronously
    rand: () => 0,
  });
  return { mp };
}

test("nextBackoffDelay grows exponentially, caps, and stays within the jitter band", () => {
  const cfg = { baseMs: 500, maxMs: 10_000, jitter: 0.2 };
  assert.equal(
    nextBackoffDelay(0, cfg, () => 0.5),
    500,
  ); // base, mid-jitter == base
  assert.equal(
    nextBackoffDelay(1, cfg, () => 0.5),
    1000,
  );
  assert.equal(
    nextBackoffDelay(10, cfg, () => 0.5),
    10_000,
  ); // capped
  const lo = nextBackoffDelay(2, cfg, () => 0); // 2000 * (1 - 0.2)
  const hi = nextBackoffDelay(2, cfg, () => 1); // 2000 * (1 + 0.2)
  assert.ok(lo >= 1600 && hi <= 2400, `band [${lo}, ${hi}]`);
});

test("unexpected close reconnects, re-runs connect, and resumes each active match", async () => {
  const { mp } = mkClient();
  await connect(mp);
  mp.markActive("m1");
  mp.markActive("m2");
  FakeWebSocket.instances[0].close(); // unexpected drop
  // a new socket was created and re-handshaked by the loop
  const fresh = FakeWebSocket.instances[1];
  assert.ok(fresh, "reconnected with a new socket");
  fresh.handshake();
  const resumes = fresh.sent
    .map((s) => JSON.parse(s))
    .filter((m) => m.type === "resume");
  assert.deepEqual(resumes.map((r) => r.matchId).sort(), ["m1", "m2"]);
});

test("first connect resumes matches registered before connect (cold-load)", async () => {
  const { mp } = mkClient();
  mp.markActive("m1"); // cold-load registers active matches before the first connect
  mp.markActive("m2");
  await connect(mp);
  const resumes = FakeWebSocket.instances[0].sent
    .map((s) => JSON.parse(s))
    .filter((m) => m.type === "resume");
  assert.deepEqual(resumes.map((r) => r.matchId).sort(), ["m1", "m2"]);
});

test("queued-only client re-issues queue.join on reconnect", async () => {
  const { mp } = mkClient();
  await connect(mp);
  void mp.quickMatch("ttt"); // queued, no match yet
  FakeWebSocket.instances[0].close();
  const fresh = FakeWebSocket.instances[1];
  fresh.handshake();
  const joins = fresh.sent
    .map((s) => JSON.parse(s))
    .filter((m) => m.type === "queue.join");
  assert.deepEqual(
    joins.map((j) => j.game),
    ["ttt"],
  );
});

test("joinMatch sends arena.join with the matchId and resolves on its match.found", async () => {
  const { mp } = mkClient();
  await connect(mp);
  const ws = FakeWebSocket.instances[0];
  const got = mp.joinMatch("arena_7");
  // The frame sent is arena.join carrying the matchId (ADR-0027/0028), NOT queue.join.
  const sent = ws.sent.map((s) => JSON.parse(s));
  assert.equal(
    sent.some((m) => m.type === "arena.join" && m.matchId === "arena_7"),
    true,
    "expected an arena.join frame for arena_7",
  );
  // Without the opt-in there is no chatLlm flag (server defaults to the offline reply).
  assert.equal(
    sent.some((m) => m.type === "arena.join" && "chatLlm" in m),
    false,
    "arena.join omits chatLlm unless opted in",
  );
  // The server replies with match.found for the bound match; the waiter resolves with it.
  ws.recv({
    type: "match.found",
    matchId: "arena_7",
    role: "A",
    opponentWallet: "0xbot",
    game: "quantum_poker",
  });
  const info = await got;
  assert.equal(info.matchId, "arena_7");
  assert.equal(info.role, "A");
  assert.equal(info.game, "quantum_poker");
});

test("joinMatch carries chatLlm when opted in (flash chat mode)", async () => {
  const { mp } = mkClient();
  await connect(mp);
  const ws = FakeWebSocket.instances[0];
  void mp.joinMatch("arena_9", { chatLlm: true });
  const sent = ws.sent.map((s) => JSON.parse(s));
  assert.equal(
    sent.some(
      (m) =>
        m.type === "arena.join" &&
        m.matchId === "arena_9" &&
        m.chatLlm === true,
    ),
    true,
    "expected arena.join with chatLlm:true",
  );
});

test("relay handlers and match waiters survive the socket swap", async () => {
  const { mp } = mkClient();
  await connect(mp);
  const ch = mp.channel("m1");
  let got: Uint8Array | null = null;
  ch.transport.onFrame((b) => {
    got = b;
  });
  FakeWebSocket.instances[0].close();
  FakeWebSocket.instances[1].handshake();
  // a relay for m1 still routes to the same handler after reconnect
  FakeWebSocket.instances[1].recv({
    type: "relay",
    matchId: "m1",
    payload: JSON.stringify({ t: "frame", data: "hi" }),
  });
  assert.equal(new TextDecoder().decode(got!), "hi");
});

test("explicit close() does not reconnect", async () => {
  const { mp } = mkClient();
  await connect(mp);
  mp.close();
  assert.equal(
    FakeWebSocket.instances.length,
    1,
    "no new socket after explicit close",
  );
});

test("typed events dispatch resume.ok / peer.resumed / peer.dropped", async () => {
  const { mp } = mkClient();
  await connect(mp);
  const seen: string[] = [];
  mp.onResumeOk((e) => seen.push(`ok:${e.matchId}:${e.peerOnline}`));
  mp.onPeerResumed((e) => seen.push(`res:${e.matchId}:${e.seat}`));
  mp.onPeerDropped((e) => seen.push(`drop:${e.matchId}`));
  const ws = FakeWebSocket.instances[0];
  ws.recv({
    type: "resume.ok",
    matchId: "m1",
    role: "A",
    opponentWallet: "0xb",
    game: "ttt",
    peerOnline: true,
  });
  ws.recv({
    type: "peer.resumed",
    matchId: "m1",
    seat: "B",
    connRef: { x: 1 },
  });
  ws.recv({ type: "peer.dropped", matchId: "m1" });
  assert.deepEqual(seen, ["ok:m1:true", "res:m1:B", "drop:m1"]);
});

test("channel side-channel round-trips a resync carrying bigint fullState", async () => {
  const { mp } = mkClient();
  await connect(mp);
  const ch = mp.channel("m1");
  let got: { fullState?: { balanceA?: unknown } } | null = null;
  ch.onPeer((m) => {
    got = m as never;
  });
  // resync's fullState is opaque adapter state; every game leaves bigint balances in it.
  ch.sendPeer({
    t: "resync",
    nonce: "7",
    hasPending: false,
    fullState: { balanceA: 6100n, balanceB: 3900n },
  } as never);
  const ws = FakeWebSocket.instances[0];
  const relayed = JSON.parse(ws.sent[ws.sent.length - 1]) as {
    type: string;
    matchId: string;
    payload: string;
  };
  assert.equal(relayed.type, "relay");
  // Feed the exact wire payload back: the receiver must revive the bigint, not a tagged object.
  ws.recv({ type: "relay", matchId: "m1", payload: relayed.payload });
  assert.equal(got!.fullState!.balanceA, 6100n);
});

// connect() resolves after the challenge; the FakeWebSocket created synchronously is instances[0].
async function connect(mp: MpClient) {
  const p = mp.connect();
  FakeWebSocket.instances[0].handshake();
  await p;
}
