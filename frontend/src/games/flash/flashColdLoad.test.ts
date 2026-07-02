import test from "node:test";
import assert from "node:assert/strict";
import { restoreInto } from "@/pvp/resumeSession";
import {
  writeResumeRecord,
  flushResumeWrites,
  readResumeRecord,
  toWireCoSigned,
} from "@/pvp/resume";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { makeEndpoint, OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { FlashProtocol, type FlashState } from "sui-tunnel-ts/protocol/flash";
import { makeFlashResumeAdapter } from "./flashResumeAdapter";
import { saveFlashMessages, loadFlashMessages } from "./flashMessageStore";
import type { FlashChatMessage } from "./session-core";

// localStorage fake — resume writes + the message companion touch it inside the test body.
(globalThis as Record<string, unknown>).localStorage = new (class {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
})();

// Cold-load: a chat co-signed a few messages, then the user reloaded. The persisted record must
// rebuild the tunnel at the exact same state, and the message companion must restore the bubbles —
// otherwise "the chat session still remains there" fails.
test("flash cold-load: rebuilt tunnel restores state and chat bubbles", () => {
  const proto = new FlashProtocol();
  const ka = generateKeyPair();
  const kb = generateKeyPair();
  const tid = `0x${"7a".repeat(32)}`;

  // Seat A opens, seat B replies — two co-signed messages.
  const sp = OffchainTunnel.selfPlay(
    proto,
    tid,
    ka as never,
    kb as never,
    "0xA",
    "0xB",
    { a: 1n, b: 1n },
  );
  sp.step("hello", "A");
  sp.step("and spoil the fun", "B");

  const adapter = makeFlashResumeAdapter({});
  const messages: FlashChatMessage[] = [
    { sender: "You", text: "hello" },
    { sender: "Bot", text: "and spoil the fun" },
  ];
  writeResumeRecord({
    matchId: "match-flash",
    tunnelId: tid,
    role: "A",
    game: "flash",
    opponentWallet: "0xB",
    opponentPubkeyHex: toHex(kb.publicKey),
    selfEphemeralSecretHex: toHex(ka.secretKey),
    latestCoSigned: toWireCoSigned(sp.latest!),
    latestState: adapter.serializeState(sp.state as FlashState),
    updatedAt: Date.now(),
  });
  flushResumeWrites();
  saveFlashMessages(tid, messages);

  // Rebuild seat A's tunnel from the record alone (the reload path).
  const backend = defaultBackend();
  const rebuilt = new DistributedTunnel<FlashState, string>(
    proto,
    {
      tunnelId: tid,
      self: makeEndpoint(
        backend,
        "0xA",
        { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey },
        true,
      ),
      opponent: makeEndpoint(
        backend,
        "0xB",
        { publicKey: kb.publicKey, scheme: 0 },
        false,
      ),
      selfParty: "A",
    },
    { send: () => {}, onFrame() {} },
    { a: 1n, b: 1n },
  );
  const record = readResumeRecord(tid);
  assert.ok(record, "resume record was persisted");
  restoreInto(rebuilt as never, record, adapter as never);

  const state = rebuilt.snapshot().state;
  assert.equal(
    state.messageCount,
    sp.state.messageCount,
    "message count restored",
  );
  assert.equal(
    state.lastSender,
    "B",
    "last sender restored (bot replied last)",
  );
  assert.deepEqual(
    Array.from(state.transcriptDigest),
    Array.from(sp.state.transcriptDigest),
    "rolling digest restored byte-for-byte",
  );
  assert.equal(
    rebuilt.snapshot().nonce,
    sp.latest!.update.nonce,
    "nonce restored",
  );

  // The visible chat survives the reload.
  assert.deepEqual(loadFlashMessages(tid), messages);
});
