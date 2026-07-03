import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureSessionJwt, clearSessionCache } from "./authSession.ts";

/** A fetch that answers `/v1/auth/session`, recording the request headers + counting calls so the
 *  cache behavior is observable. Returns a mintable session unless `status` is non-2xx. */
function fakeAuthFetch(opts: {
  status?: number;
  sessionJwt?: string;
  expiresInSecs?: number;
  onCall?: (headers: Record<string, string>) => void;
  count?: { n: number };
}): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    if (!String(url).endsWith("/v1/auth/session"))
      throw new Error(`unexpected url ${url}`);
    if (opts.count) opts.count.n++;
    opts.onCall?.(init?.headers ?? {});
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({
        sessionJwt: opts.sessionJwt ?? "sess.jwt.tok",
        address: "0xuser",
        expiresInSecs: opts.expiresInSecs ?? 1800,
      }),
    };
  }) as unknown as typeof fetch;
}

test("ensureSessionJwt mints a session from the id_token, sending it in the zklogin-jwt header", async () => {
  clearSessionCache();
  let sent: Record<string, string> = {};
  const jwt = await ensureSessionJwt(async () => "ID_TOKEN", {
    apiBase: "",
    fetchFn: fakeAuthFetch({ sessionJwt: "sess1", onCall: (h) => (sent = h) }),
  });
  assert.equal(jwt, "sess1");
  assert.equal(
    sent["zklogin-jwt"],
    "ID_TOKEN",
    "the raw Enoki id_token is what the backend verifies",
  );
});

test("ensureSessionJwt caches — a second call within TTL does not re-fetch", async () => {
  clearSessionCache();
  const count = { n: 0 };
  const api = {
    apiBase: "",
    fetchFn: fakeAuthFetch({ sessionJwt: "sessC", count, expiresInSecs: 1800 }),
  };
  const a = await ensureSessionJwt(async () => "ID", api);
  const b = await ensureSessionJwt(async () => "ID", api);
  assert.equal(a, "sessC");
  assert.equal(b, "sessC");
  assert.equal(
    count.n,
    1,
    "the second call is served from cache, not re-minted",
  );
});

test("ensureSessionJwt returns null (and does not call the backend) when there is no id_token", async () => {
  clearSessionCache();
  const count = { n: 0 };
  // A browser-wallet user (no zkLogin) has no id_token; auth is simply unavailable, not an error.
  const jwt = await ensureSessionJwt(async () => null, {
    apiBase: "",
    fetchFn: fakeAuthFetch({ count }),
  });
  assert.equal(jwt, null);
  assert.equal(count.n, 0, "no identity → no auth round-trip");
});

test("ensureSessionJwt returns null when the gate is disabled (503) so allocate proceeds unauthenticated", async () => {
  clearSessionCache();
  const jwt = await ensureSessionJwt(async () => "ID", {
    apiBase: "",
    fetchFn: fakeAuthFetch({ status: 503 }),
  });
  assert.equal(jwt, null);
});

test("ensureSessionJwt re-mints when the current address differs from the cached token's (account switch)", async () => {
  clearSessionCache();
  // A fetch whose returned address tracks `state.address`, so switching accounts changes the mint.
  const state = { address: "0xAAA", count: { n: 0 } };
  const fetchFn = (async () => {
    state.count.n++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        sessionJwt: `sess-${state.address}`,
        address: state.address,
        expiresInSecs: 1800,
      }),
    };
  }) as unknown as typeof fetch;
  const api = { apiBase: "", fetchFn };

  const a = await ensureSessionJwt(async () => "IDA", api, {
    address: "0xAAA",
  });
  assert.equal(a, "sess-0xAAA");
  // Same browser, switch to account B within the fresh TTL: A's token must NOT be reused for B.
  state.address = "0xBBB";
  const b = await ensureSessionJwt(async () => "IDB", api, {
    address: "0xBBB",
  });
  assert.equal(
    state.count.n,
    2,
    "a different address forces a re-mint, not a cache hit",
  );
  assert.equal(b, "sess-0xBBB", "the token returned is the one minted for B");
});

test("clearSessionCache forces a fresh mint on the next call", async () => {
  clearSessionCache();
  const count = { n: 0 };
  const api = {
    apiBase: "",
    fetchFn: fakeAuthFetch({ sessionJwt: "s", count }),
  };
  await ensureSessionJwt(async () => "ID", api);
  clearSessionCache();
  await ensureSessionJwt(async () => "ID", api);
  assert.equal(count.n, 2, "clearing the cache re-mints instead of reusing");
});
