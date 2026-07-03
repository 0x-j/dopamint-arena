import { test } from "node:test";
import assert from "node:assert/strict";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromHex } from "sui-tunnel-ts/core/bytes";

import { mintBotSessionJwt } from "./arenaBotSession.ts";

/** A fetch that records the request body and answers `/v1/auth/session/keypair`. */
function fakeKeypairAuthFetch(opts: {
  status?: number;
  sessionJwt?: string;
  seen?: { body: Record<string, unknown> };
}): typeof fetch {
  return (async (url: string, init?: { body?: string }) => {
    assert.ok(String(url).endsWith("/v1/auth/session/keypair"), `url ${url}`);
    if (opts.seen) opts.seen.body = JSON.parse(init?.body ?? "{}");
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({
        sessionJwt: opts.sessionJwt ?? "bot.sess.jwt",
        address: "0xbot",
        expiresInSecs: 1800,
      }),
    };
  }) as unknown as typeof fetch;
}

test("mintBotSessionJwt sends the bot's address + pubkey and a signature that verifies over the canonical message", async () => {
  const keypair = new Ed25519Keypair();
  const seen = { body: {} as Record<string, unknown> };
  const jwt = await mintBotSessionJwt(keypair, {
    apiBase: "",
    fetchFn: fakeKeypairAuthFetch({ sessionJwt: "bot1", seen }),
  });
  assert.equal(jwt, "bot1", "returns the minted session JWT");

  // The request binds the bot's real identity.
  assert.equal(seen.body.address, keypair.toSuiAddress());
  assert.equal(
    seen.body.publicKey,
    Buffer.from(keypair.getPublicKey().toRawBytes()).toString("hex"),
  );
  assert.equal(typeof seen.body.issuedAtMs, "number");

  // The signature is a genuine ed25519 sig by the bot over `domain\naddress\nissuedAtMs` — the exact
  // bytes the backend rebuilds and verifies.
  const message = new TextEncoder().encode(
    `mtps.arena.session.v1\n${seen.body.address}\n${seen.body.issuedAtMs}`,
  );
  const ok = await keypair
    .getPublicKey()
    .verify(message, fromHex(seen.body.signature as string));
  assert.ok(ok, "backend must be able to verify the bot's self-proof");
});

test("mintBotSessionJwt returns undefined when the gate is disabled (503)", async () => {
  const jwt = await mintBotSessionJwt(new Ed25519Keypair(), {
    apiBase: "",
    fetchFn: fakeKeypairAuthFetch({ status: 503 }),
  });
  assert.equal(jwt, undefined);
});
