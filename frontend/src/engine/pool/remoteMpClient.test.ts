import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageChannel, type MessagePort } from "node:worker_threads";

import { SocketHost } from "./socketHost";
import { RemoteMpClient } from "./remoteMpClient";
import type { BridgePort } from "./socketBridge";
import type { MpClient } from "@/pvp/mpClient";

/** Adapt a Node worker_threads MessagePort (`.on("message", data)`) to the browser-style BridgePort
 *  (`onmessage = ev => ev.data`) the classes expect, so the SAME implementation runs here and in prod. */
function adapt(port: MessagePort): BridgePort {
  const p: BridgePort = {
    postMessage: (m) => port.postMessage(m),
    onmessage: null,
  };
  port.on("message", (data) => p.onmessage?.({ data }));
  return p;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A stand-in for the real relay `MpClient` that records what was sent and lets the test inject the
 *  inbound frames/peer messages the socket would receive — exercising the bridge without a socket. */
function makeFakeMp() {
  const sentFrames: { matchId: string; bytes: Uint8Array }[] = [];
  const sentPeers: { matchId: string; msg: unknown }[] = [];
  const announced: { matchId: string; tunnelId: string }[] = [];
  const released: string[] = [];
  const resumed: string[] = [];
  const chans = new Map<
    string,
    {
      onFrame: ((b: Uint8Array) => void) | null;
      peers: Set<(m: unknown) => void>;
    }
  >();
  const markedActive: string[] = [];
  const resumeOkCbs = new Set<(e: unknown) => void>();
  const peerResumedCbs = new Set<(e: unknown) => void>();
  const peerDroppedCbs = new Set<(e: unknown) => void>();
  const mp = {
    quickMatch: async (game: string) => ({
      matchId: "m1",
      role: "A" as const,
      opponentWallet: "0xopp",
      game,
    }),
    joinMatch: async (matchId: string) => ({
      matchId,
      role: "A" as const,
      opponentWallet: "0xbot",
      game: "caro",
    }),
    channel: (matchId: string) => {
      const c = {
        onFrame: null as ((b: Uint8Array) => void) | null,
        peers: new Set<(m: unknown) => void>(),
      };
      chans.set(matchId, c);
      return {
        transport: {
          send: (bytes: Uint8Array) => sentFrames.push({ matchId, bytes }),
          onFrame: (cb: (b: Uint8Array) => void) => {
            c.onFrame = cb;
          },
        },
        sendPeer: (msg: unknown) => sentPeers.push({ matchId, msg }),
        onPeer: () => {},
        addPeerListener: (cb: (m: unknown) => void) => c.peers.add(cb),
        removePeerListener: (cb: (m: unknown) => void) => c.peers.delete(cb),
      };
    },
    announceTunnel: (matchId: string, tunnelId: string) =>
      announced.push({ matchId, tunnelId }),
    releaseMatch: (matchId: string) => released.push(matchId),
    resumeMatch: (matchId: string) => resumed.push(matchId),
    markActive: (matchId: string) => markedActive.push(matchId),
    onResumeOk: (cb: (e: unknown) => void) => {
      resumeOkCbs.add(cb);
      return () => resumeOkCbs.delete(cb);
    },
    onPeerResumed: (cb: (e: unknown) => void) => {
      peerResumedCbs.add(cb);
      return () => peerResumedCbs.delete(cb);
    },
    onPeerDropped: (cb: (e: unknown) => void) => {
      peerDroppedCbs.add(cb);
      return () => peerDroppedCbs.delete(cb);
    },
  };
  return {
    mp,
    sentFrames,
    sentPeers,
    announced,
    released,
    resumed,
    markedActive,
    deliverFrame: (matchId: string, bytes: Uint8Array) =>
      chans.get(matchId)?.onFrame?.(bytes),
    deliverPeer: (matchId: string, msg: unknown) =>
      chans.get(matchId)?.peers.forEach((cb) => cb(msg)),
    deliverResumeOk: (e: unknown) => resumeOkCbs.forEach((cb) => cb(e)),
  };
}

test("bridge: quickMatch resolves and frames/peer round-trip verbatim over the port", async () => {
  const { port1, port2 } = new MessageChannel();
  const fake = makeFakeMp();
  new SocketHost(fake.mp as unknown as MpClient, adapt(port1));
  const remote = new RemoteMpClient(adapt(port2));

  const match = await remote.quickMatch("caro");
  assert.equal(match.matchId, "m1");
  assert.equal(match.role, "A");
  assert.equal(match.game, "caro");

  const chan = remote.channel("m1");
  const got: Uint8Array[] = [];
  chan.transport.onFrame((b) => got.push(b));
  const gotPeers: unknown[] = [];
  chan.onPeer((m) => gotPeers.push(m));
  await tick();

  // game → socket: engine frame forwarded byte-for-byte
  chan.transport.send(new Uint8Array([1, 2, 3]));
  await tick();
  assert.deepEqual(
    fake.sentFrames.map((f) => [...f.bytes]),
    [[1, 2, 3]],
  );

  // socket → game: inbound relay frame delivered to the engine sink
  fake.deliverFrame("m1", new Uint8Array([9, 8, 7]));
  await tick();
  assert.deepEqual(
    got.map((b) => [...b]),
    [[9, 8, 7]],
  );

  // peer side-channel both directions
  chan.sendPeer({ t: "ready" });
  await tick();
  assert.deepEqual(fake.sentPeers[0]?.msg, { t: "ready" });
  fake.deliverPeer("m1", { t: "open", tunnelId: "0xabc" });
  await tick();
  assert.deepEqual(gotPeers, [{ t: "open", tunnelId: "0xabc" }]);

  port1.close();
  port2.close();
});

test("bridge: inbound frames buffer until the engine wires onFrame (activation race)", async () => {
  const { port1, port2 } = new MessageChannel();
  const fake = makeFakeMp();
  new SocketHost(fake.mp as unknown as MpClient, adapt(port1));
  const remote = new RemoteMpClient(adapt(port2));

  const match = await remote.joinMatch("mArena");
  assert.equal(match.matchId, "mArena");

  const chan = remote.channel("mArena");
  // A frame lands BEFORE the engine wires its sink — must be buffered, not dropped.
  fake.deliverFrame("mArena", new Uint8Array([5]));
  await tick();

  const got: Uint8Array[] = [];
  chan.transport.onFrame((b) => got.push(b)); // wiring flushes the buffer
  assert.deepEqual(
    got.map((b) => [...b]),
    [[5]],
  );

  port1.close();
  port2.close();
});

test("bridge: announce / release / resume reach the shared MpClient", async () => {
  const { port1, port2 } = new MessageChannel();
  const fake = makeFakeMp();
  new SocketHost(fake.mp as unknown as MpClient, adapt(port1));
  const remote = new RemoteMpClient(adapt(port2));

  remote.announceTunnel("m7", "0xtunnel");
  remote.resumeMatch("m7");
  remote.releaseMatch("m7");
  await tick();

  assert.deepEqual(fake.announced, [{ matchId: "m7", tunnelId: "0xtunnel" }]);
  assert.deepEqual(fake.resumed, ["m7"]);
  assert.deepEqual(fake.released, ["m7"]);

  port1.close();
  port2.close();
});

test("bridge: resume path — markActive forwards, resumeOk routes only to the owning worker", async () => {
  const { port1, port2 } = new MessageChannel();
  const fake = makeFakeMp();
  new SocketHost(fake.mp as unknown as MpClient, adapt(port1));
  const remote = new RemoteMpClient(adapt(port2));

  await remote.joinMatch("mR");
  remote.channel("mR"); // registers the channel (this worker owns mR on the socket side)
  await tick();
  remote.markActive("mR");
  await tick();
  assert.deepEqual(fake.markedActive, ["mR"]);

  const events: { matchId: string }[] = [];
  remote.onResumeOk((e) => events.push(e));
  fake.deliverResumeOk({
    matchId: "mR",
    role: "A",
    opponentWallet: "0x",
    game: "caro",
    peerOnline: true,
  });
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].matchId, "mR");

  // An event for a match this worker does NOT own is filtered out at the socket host.
  fake.deliverResumeOk({
    matchId: "other",
    role: "A",
    opponentWallet: "0x",
    game: "caro",
    peerOnline: true,
  });
  await tick();
  assert.equal(events.length, 1);

  port1.close();
  port2.close();
});

test("SocketHost.dispose unsubscribes its MpClient events + releases its channels (no leak on close)", async () => {
  const { port1, port2 } = new MessageChannel();
  const fake = makeFakeMp();
  const host = new SocketHost(fake.mp as unknown as MpClient, adapt(port1));
  const remote = new RemoteMpClient(adapt(port2));

  await remote.joinMatch("mD");
  remote.channel("mD"); // host now owns match mD (a real relay channel)
  await tick();

  const events: unknown[] = [];
  remote.onResumeOk((e) => events.push(e));

  // Before dispose: a resumeOk for the owned match reaches the game worker.
  fake.deliverResumeOk({
    matchId: "mD",
    role: "A",
    opponentWallet: "0x",
    game: "caro",
    peerOnline: true,
  });
  await tick();
  assert.equal(events.length, 1);

  // Window closed → dispose: releases the owned channel + unsubscribes the global event subs.
  host.dispose();
  assert.deepEqual(fake.released, ["mD"], "dispose releases the owned match");

  // After dispose the SAME event no longer forwards — the sub was removed, so no dead closure leaks
  // on the shared MpClient (it would otherwise fire forever + post to a closed port).
  fake.deliverResumeOk({
    matchId: "mD",
    role: "A",
    opponentWallet: "0x",
    game: "caro",
    peerOnline: true,
  });
  await tick();
  assert.equal(events.length, 1, "no forwarding after dispose");

  port1.close();
  port2.close();
});
