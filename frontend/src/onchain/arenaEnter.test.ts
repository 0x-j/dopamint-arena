import { test } from "node:test";
import assert from "node:assert/strict";
import { toHex } from "@mysten/sui/utils";

import { enterArena, allocateArenaBots } from "./arenaEnter.ts";
import { setArenaIdTokenProvider, clearSessionCache } from "./authSession.ts";
import type { TunnelOpenRequest } from "./tunnelOpenBatcher.ts";

const BOT_EPH = "aa".repeat(32); // 32-byte ephemeral pubkey, hex
const BOT_ADDR = "0xbot";
const TUNNEL = "0xtunnel1"; // the tunnel the fleet pre-opened + funded seat B for (ADR-0025)
const USER_EPH = new Uint8Array(32).fill(7); // the user's per-game ephemeral key

/** A fetch that routes the two arena endpoints, recording each request body. Allocate returns the
 *  fleet-pre-opened `tunnelId` the user will deposit into. */
function fakeFetch(captured: {
  allocate?: unknown;
  opened?: unknown;
}): typeof fetch {
  return (async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (String(url).endsWith("/v1/arena/allocate")) {
      captured.allocate = body;
      return {
        ok: true,
        json: async () => ({
          allocations: [
            {
              game: "blackjack",
              matchId: "m1",
              tunnelId: TUNNEL,
              botEphPubkey: BOT_EPH,
              botAddress: BOT_ADDR,
            },
          ],
        }),
      };
    }
    if (String(url).endsWith("/v1/arena/opened")) {
      captured.opened = body;
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
}

test("allocateArenaBots posts {userAddress, games:[{id,userEphPubkey}]} and returns allocations with tunnelId", async () => {
  const captured: { allocate?: unknown } = {};
  const allocs = await allocateArenaBots(
    [{ id: "blackjack", userEphPubkey: "ab12" }],
    "0xuser",
    { apiBase: "", fetchFn: fakeFetch(captured) },
  );
  assert.deepEqual(captured.allocate, {
    userAddress: "0xuser",
    games: [{ id: "blackjack", userEphPubkey: "ab12" }],
  });
  assert.equal(allocs.length, 1);
  assert.equal(
    allocs[0].tunnelId,
    TUNNEL,
    "allocate returns the pre-opened tunnel",
  );
  assert.equal(allocs[0].botAddress, BOT_ADDR);
  assert.equal(allocs[0].botEphPubkey, BOT_EPH);
});

test("enterArena sends the user eph pubkey, deposits seat A into the pre-opened tunnel, reports joined", async () => {
  const captured: { allocate?: unknown; opened?: unknown } = {};
  const opens: TunnelOpenRequest[] = [];

  const opened = await enterArena({
    games: ["blackjack"],
    userAddress: "0xuser",
    stakePerGame: 100n,
    apiBase: "",
    fetchFn: fakeFetch(captured),
    makeUserParty: async () => ({ address: "0xuser", publicKey: USER_EPH }),
    open: async (req) => {
      opens.push(req);
      return req.tunnelId!; // a deposit resolves with the tunnel it funded
    },
  });

  // The user's per-game ephemeral pubkey reaches allocate (so the fleet bakes it into the tunnel
  // at create) — the load-bearing change of ADR-0025's open mechanics.
  assert.deepEqual(captured.allocate, {
    userAddress: "0xuser",
    games: [{ id: "blackjack", userEphPubkey: toHex(USER_EPH) }],
  });

  // Exactly one DEPOSIT (not an open) into the fleet-pre-opened tunnel, seat-A stake, party B = bot.
  assert.equal(opens.length, 1);
  assert.equal(
    opens[0].mode,
    "deposit",
    "the user joins by depositing, not creating",
  );
  assert.equal(opens[0].tunnelId, TUNNEL);
  assert.equal(opens[0].aAmount, 100n);
  assert.equal(opens[0].partyB.address, BOT_ADDR);
  assert.equal(
    toHex(opens[0].partyB.publicKey),
    BOT_EPH,
    "party B's pk is the bot's ephemeral pubkey",
  );

  // The user-joined cue is reported so the bot starts playing.
  assert.deepEqual(captured.opened, {
    allocations: [{ matchId: "m1", tunnelId: TUNNEL }],
  });

  assert.deepEqual(opened, [
    {
      game: "blackjack",
      matchId: "m1",
      tunnelId: TUNNEL,
      botAddress: BOT_ADDR,
      botEphPubkey: BOT_EPH,
      depositDigest: undefined,
    },
  ]);
});

// Regression (B5): the on-demand allocate paths (per-game Play, lazy add-a-game) pass no explicit
// `getIdToken`. Without a fallback they hit the enabled auth gate tokenless → 401. `enterArena` must
// mint + attach a session JWT from the process-wide provider the wallet layer registers on connect,
// so authentication is uniform across ALL allocate paths, not only the connect-time batch.
test("enterArena authenticates via the registered id_token provider when no explicit getIdToken is passed", async () => {
  clearSessionCache();
  const captured: { allocateAuth?: string; mintIdToken?: string } = {};
  const fetchFn = (async (
    url: string,
    init?: { body?: string; headers?: Record<string, string> },
  ) => {
    const u = String(url);
    if (u.endsWith("/v1/auth/session")) {
      captured.mintIdToken = init?.headers?.["zklogin-jwt"];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionJwt: "SESSION_JWT_123",
          address: "0xuser",
          expiresInSecs: 1800,
        }),
      };
    }
    if (u.endsWith("/v1/arena/allocate")) {
      captured.allocateAuth = init?.headers?.authorization;
      return {
        ok: true,
        json: async () => ({
          allocations: [
            {
              game: "blackjack",
              matchId: "m1",
              tunnelId: TUNNEL,
              botEphPubkey: BOT_EPH,
              botAddress: BOT_ADDR,
            },
          ],
        }),
      };
    }
    if (u.endsWith("/v1/arena/opened"))
      return { ok: true, json: async () => ({}) };
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;

  setArenaIdTokenProvider(async () => "USER_ID_TOKEN");
  try {
    await enterArena({
      games: ["blackjack"],
      userAddress: "0xuser",
      stakePerGame: 100n,
      apiBase: "",
      fetchFn,
      makeUserParty: async () => ({ address: "0xuser", publicKey: USER_EPH }),
      open: async (req) => req.tunnelId!,
    });
  } finally {
    setArenaIdTokenProvider(null);
    clearSessionCache();
  }

  assert.equal(
    captured.mintIdToken,
    "USER_ID_TOKEN",
    "the registered provider's id_token is exchanged at /v1/auth/session",
  );
  assert.equal(
    captured.allocateAuth,
    "Bearer SESSION_JWT_123",
    "the minted session JWT is attached to allocate — no caller threaded getIdToken",
  );
});

test("enterArena surfaces the deposit digest via onDepositDigest and the returned allocation", async () => {
  const captured: { allocate?: unknown; opened?: unknown } = {};
  const digests: Array<{ game: string; digest: string }> = [];

  const opened = await enterArena({
    games: ["blackjack"],
    userAddress: "0xuser",
    stakePerGame: 100n,
    apiBase: "",
    fetchFn: fakeFetch(captured),
    makeUserParty: async () => ({ address: "0xuser", publicKey: USER_EPH }),
    open: async (req) => {
      req.onDigest?.("0xdepositdigest");
      return req.tunnelId!;
    },
  });

  assert.equal(opened.length, 1);
  assert.equal(
    opened[0].depositDigest,
    "0xdepositdigest",
    "allocation carries the deposit digest",
  );
  assert.deepEqual(digests, []);

  // Also verify the explicit callback path.
  await enterArena({
    games: ["blackjack"],
    userAddress: "0xuser",
    stakePerGame: 100n,
    apiBase: "",
    fetchFn: fakeFetch(captured),
    makeUserParty: async () => ({ address: "0xuser", publicKey: USER_EPH }),
    open: async (req) => {
      req.onDigest?.("0xexplicitdigest");
      return req.tunnelId!;
    },
    onDepositDigest: (game, digest) => digests.push({ game, digest }),
  });

  assert.deepEqual(digests, [
    { game: "blackjack", digest: "0xexplicitdigest" },
  ]);
});
