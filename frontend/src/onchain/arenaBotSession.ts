// Non-zkLogin arena session for a walletless bot (the flash spectator seat-A bot). The bot signs a
// short, time-bounded message with its own ed25519 key; the backend (`POST /v1/auth/session/keypair`)
// verifies the signature AND that the key derives to the claimed address, then mints a session JWT
// bound to it — the B5 arena-gate credential for a caller with no zkLogin identity. Returns
// `undefined` when the gate is off (503) or the mint fails, so the caller allocates unauthenticated,
// exactly like the zkLogin path.
import { toHex } from "sui-tunnel-ts/core/bytes";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

/** Domain prefix of the signed message. MUST match the backend's `KEYPAIR_SESSION_DOMAIN`. */
const SESSION_MESSAGE_DOMAIN = "mtps.arena.session.v1";

/** The exact bytes the bot signs — MUST equal the backend's `keypair_session_message` byte-for-byte. */
function keypairSessionMessage(
  address: string,
  issuedAtMs: number,
): Uint8Array {
  return new TextEncoder().encode(
    `${SESSION_MESSAGE_DOMAIN}\n${address}\n${issuedAtMs}`,
  );
}

const backendUrl = (apiBase?: string): string =>
  apiBase ?? import.meta.env?.VITE_BACKEND_URL ?? "";

/** Mint a session JWT for `keypair`'s own Sui address via a self-signed proof. `undefined` when the
 *  gate is disabled (503) or the proof is rejected — the caller then allocates unauthenticated. */
export async function mintBotSessionJwt(
  keypair: Ed25519Keypair,
  api: { apiBase?: string; fetchFn?: typeof fetch } = {},
): Promise<string | undefined> {
  const address = keypair.toSuiAddress();
  const issuedAtMs = Date.now();
  const signature = await keypair.sign(
    keypairSessionMessage(address, issuedAtMs),
  );
  const doFetch = api.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${backendUrl(api.apiBase)}/v1/auth/session/keypair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address,
        publicKey: toHex(keypair.getPublicKey().toRawBytes()),
        signature: toHex(signature),
        issuedAtMs,
      }),
    });
  } catch (e) {
    console.warn("[arena] bot session request failed", e);
    return undefined;
  }
  if (!res.ok) {
    // 503 = gate off (expected pre-rollout); anything else is a real failure. Either way the caller
    // allocates unauthenticated.
    if (res.status !== 503)
      console.warn(`[arena] bot session mint failed: ${res.status}`);
    return undefined;
  }
  const body = (await res.json()) as { sessionJwt: string };
  return body.sessionJwt;
}
