// Backend session auth (B5). The FE proves its zkLogin identity ONCE via Enoki and exchanges the
// id_token for a short-lived backend session JWT (`POST /v1/auth/session`), which it attaches as a
// bearer on `/v1/arena/allocate`. The session JWT — not the ~1h Enoki id_token — is the durable
// credential (it survives reloads via localStorage), so a returning player re-authorizes without a
// fresh Enoki round-trip on every allocate. When there is no zkLogin identity (a browser-wallet
// user) or the backend gate is disabled (503, SESSION_JWT_SECRET unset), this yields null and the
// caller allocates unauthenticated — the gate stays off until it is configured.

/** Where the session token persists so it survives a reload (same home as the resume records). */
const STORAGE_KEY = "mtps.arena.session.v1";
/** Re-mint this long before actual expiry, so a token never lapses mid-request. */
const REFRESH_SKEW_MS = 60_000;

interface SessionToken {
  sessionJwt: string;
  address: string;
  /** Wall-clock ms when this token expires (from the backend's `expiresInSecs` at mint time). */
  expEpochMs: number;
}

let cached: SessionToken | null = null;

const backendUrl = (apiBase?: string): string =>
  apiBase ?? import.meta.env?.VITE_BACKEND_URL ?? "";

function ls(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function loadFromStorage(): SessionToken | null {
  const raw = ls()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionToken;
  } catch {
    return null;
  }
}

function isFresh(t: SessionToken | null, nowMs: number): boolean {
  return !!t && t.expEpochMs - REFRESH_SKEW_MS > nowMs;
}

/** Drop the cached session (memory + persisted). Call on wallet disconnect/logout; also forces a
 *  re-mint on the next {@link ensureSessionJwt}. */
export function clearSessionCache(): void {
  cached = null;
  ls()?.removeItem(STORAGE_KEY);
}

/**
 * Return a valid backend session JWT for the current identity, minting one when the cache is empty or
 * near expiry. `getIdToken` yields the fresh Enoki id_token (or null when there is no zkLogin
 * identity). Returns null — and the caller proceeds unauthenticated — when there is no id_token or
 * the backend gate is disabled (503); the backend enforces only once SESSION_JWT_SECRET is set.
 */
export async function ensureSessionJwt(
  getIdToken: () => Promise<string | null>,
  api: { apiBase?: string; fetchFn?: typeof fetch } = {},
  opts: { address?: string; nowMs?: number } = {},
): Promise<string | null> {
  const nowMs = opts.nowMs ?? Date.now();
  const current = cached ?? loadFromStorage();
  // Reuse the cache only when it is unexpired AND belongs to the current address — otherwise a
  // browser that switched accounts within the TTL would send account A's token for account B's
  // allocate, which the backend gate rejects as an address mismatch (a permanent 403).
  const matchesAddress =
    !opts.address ||
    current?.address?.toLowerCase() === opts.address.toLowerCase();
  if (isFresh(current, nowMs) && matchesAddress) {
    cached = current;
    return current!.sessionJwt;
  }

  const idToken = await getIdToken();
  if (!idToken) return null;

  const doFetch = api.fetchFn ?? fetch;
  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = (await doFetch(`${backendUrl(api.apiBase)}/v1/auth/session`, {
      method: "POST",
      // The raw id_token in `zklogin-jwt` (mirroring Enoki's own header) is what the backend verifies.
      headers: { "content-type": "application/json", "zklogin-jwt": idToken },
    })) as never;
  } catch (e) {
    console.warn("[arena] auth session request failed", e);
    return null;
  }

  if (!res.ok) {
    // 503 = gate disabled (SESSION_JWT_SECRET unset) — expected pre-rollout, not worth a warning;
    // anything else is a real failure. Either way allocate proceeds unauthenticated.
    if (res.status !== 503)
      console.warn(`[arena] auth session mint failed: ${res.status}`);
    return null;
  }

  const body = (await res.json()) as {
    sessionJwt: string;
    address: string;
    expiresInSecs: number;
  };
  const token: SessionToken = {
    sessionJwt: body.sessionJwt,
    address: body.address,
    expEpochMs: nowMs + body.expiresInSecs * 1000,
  };
  cached = token;
  ls()?.setItem(STORAGE_KEY, JSON.stringify(token));
  return token.sessionJwt;
}
