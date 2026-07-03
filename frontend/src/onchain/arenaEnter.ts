// Arena one-signature entry (ADR-0025, refining ADR-0023). Connect wallet → generate one ephemeral
// key per game → reserve one warm fleet bot per game, which PRE-CREATES the tunnel + funds seat B →
// deposit seat A into every pre-opened tunnel in ONE batched PTB (the batcher's deposit mode). The
// tunnel activates on that single signature; each game then plays genuine two-party over the relay.
import { fromHex, toHex } from "@mysten/sui/utils";
import { ensureSessionJwt } from "./authSession";
import { requestTunnelOpen } from "./sharedTunnelOpenBatcher";
import type { TunnelOpenRequest } from "./tunnelOpenBatcher";
import type { PartyOnchain } from "./tunnelTx";

/** One game's allocate request (wire shape): the game id plus the user's per-game ephemeral pubkey
 *  (hex), which the fleet bakes into the tunnel as party A's `pk` at create (ADR-0025). */
export interface ArenaGameRequest {
  id: string;
  userEphPubkey: string;
}

/** One reserved bot from `POST /v1/arena/allocate` (wire shape, camelCase). */
export interface ArenaAllocation {
  game: string;
  matchId: string;
  /** The tunnel the fleet pre-created + funded seat B for; the user deposits seat A into it. */
  tunnelId: string;
  /** Tunnel party B's `pk` (verifies the bot's move signatures). */
  botEphPubkey: string;
  /** Tunnel party B's `address` (funds/receives seat B); distinct from the ephemeral pubkey. */
  botAddress: string;
  /** Per-seat stake (smallest MTPS unit) from the game's backend `GameProfile`. The fleet funded
   *  seat B with exactly this; the user's batched deposit funds seat A with the SAME amount, and the
   *  off-chain tunnel inits both balances to it. Single source of truth — the FE never hardcodes it. */
  stakeEach: number;
  /** Digest of the committed seat-A deposit PTB, once the batched open lands. */
  depositDigest?: string;
}

/** One opened arena game: the bot to play, the relay match, and the live tunnel. */
export interface ArenaOpened {
  game: string;
  matchId: string;
  tunnelId: string;
}

/** Mint the user's party A for one game's tunnel: `address` is the connected wallet (funds seat A,
 *  receives winnings); `publicKey` is a fresh per-game ephemeral that co-signs moves. Called BEFORE
 *  allocate (ADR-0025) — the pubkey is sent so the fleet can bake it into the tunnel at create. */
export type MakeUserParty = (game: string) => Promise<PartyOnchain>;

interface ArenaApi {
  /** Backend base URL; "" (same-origin) by default. Mirrors `resolveBackendUrl` in controlPlane. */
  apiBase?: string;
  fetchFn?: typeof fetch;
  /** Backend session JWT (B5) attached as `Authorization: Bearer` on allocate. Omitted when auth is
   *  off or unavailable — the backend gate is disabled until SESSION_JWT_SECRET is set. */
  sessionJwt?: string;
}

const backendUrl = (apiBase?: string): string =>
  apiBase ?? import.meta.env?.VITE_BACKEND_URL ?? "";

/** Reserve one warm fleet bot per game, sending the user's per-game ephemeral pubkey so the fleet
 *  pre-creates each tunnel (party A = user) + funds seat B. Games with no free bot (or whose open
 *  failed) are omitted by the backend, so the caller deposits only what it actually got back. */
export async function allocateArenaBots(
  games: ArenaGameRequest[],
  userAddress: string,
  api: ArenaApi = {},
): Promise<ArenaAllocation[]> {
  const doFetch = api.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (api.sessionJwt) headers.authorization = `Bearer ${api.sessionJwt}`;
  const res = await doFetch(`${backendUrl(api.apiBase)}/v1/arena/allocate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ userAddress, games }),
  });
  if (!res.ok) throw new Error(`arena allocate failed: ${res.status}`);
  const body = (await res.json()) as { allocations: ArenaAllocation[] };
  return body.allocations;
}

/** Tell each reserved bot the user has joined (funded seat A, so its pre-opened tunnel is now
 *  active), the cue to start playing. No-op on empty. */
export async function reportArenaOpened(
  opened: Array<{ matchId: string; tunnelId: string }>,
  api: ArenaApi = {},
): Promise<void> {
  if (opened.length === 0) return;
  const doFetch = api.fetchFn ?? fetch;
  const res = await doFetch(`${backendUrl(api.apiBase)}/v1/arena/opened`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allocations: opened }),
  });
  if (!res.ok) throw new Error(`arena opened failed: ${res.status}`);
}

/**
 * One-signature arena entry (ADR-0025). Generates a per-game ephemeral key, reserves a bot per game
 * (the fleet pre-creates each tunnel + funds seat B), then deposits seat A into every pre-opened
 * tunnel in ONE batched PTB (the batcher's deposit mode coalesces them — one wallet popup), and
 * reports the user joined. `open` and the API are injectable for tests; production uses the shared
 * batcher + live `fetch`.
 *
 * Returns the full [`ArenaAllocation`]s (with the bot's eph pubkey + address + the live tunnelId),
 * not just the opened match ids — the caller needs the bot keys to verify the bot's move signatures
 * when it wires the relay + engine via `enterArenaMatch`.
 */
export async function enterArena(
  opts: {
    games: string[];
    userAddress: string;
    /** Fallback per-seat stake if an allocation omits `stakeEach` (back-compat). Each game's
     *  deposit prefers `allocation.stakeEach` — the backend's single source of truth — so games
     *  with different stakes batch correctly into ONE PTB. */
    stakePerGame?: bigint;
    makeUserParty: MakeUserParty;
    open?: (req: TunnelOpenRequest) => Promise<string>;
    coinType?: string;
    usesAddressBalance?: boolean;
    /** Called with the committed deposit PTB digest for each game once the batched open lands. */
    onDepositDigest?: (game: string, digest: string) => void;
    /** Yields the fresh Enoki id_token to authorize allocate (B5); null for a non-zkLogin wallet.
     *  When set, `enterArena` exchanges it for a session JWT and attaches it to allocate. */
    getIdToken?: () => Promise<string | null>;
  } & ArenaApi,
): Promise<ArenaAllocation[]> {
  // A fresh ephemeral key per game, BEFORE allocate — its pubkey is baked into the tunnel at create.
  // Run key-gen and the (B5) session-JWT mint CONCURRENTLY so the auth round-trip overlaps key
  // generation instead of adding to time-to-play. `sessionJwt` is null when there's no zkLogin
  // identity or the gate is off, and allocate then proceeds unauthenticated. The mint is pinned to
  // `userAddress`, so a token cached for a different account (a same-browser switch) is re-minted.
  const parties = new Map<string, PartyOnchain>();
  const [, sessionJwt] = await Promise.all([
    Promise.all(
      opts.games.map(async (game) => {
        parties.set(game, await opts.makeUserParty(game));
      }),
    ),
    opts.getIdToken
      ? ensureSessionJwt(opts.getIdToken, opts, {
          address: opts.userAddress,
        }).then((t) => t ?? undefined)
      : Promise.resolve(opts.sessionJwt),
  ]);
  const allocations = await allocateArenaBots(
    opts.games.map((game) => ({
      id: game,
      userEphPubkey: toHex(parties.get(game)!.publicKey),
    })),
    opts.userAddress,
    { apiBase: opts.apiBase, fetchFn: opts.fetchFn, sessionJwt },
  );
  const open = opts.open ?? requestTunnelOpen;
  // Deposit seat A into every pre-opened tunnel. The batcher coalesces these into ONE PTB (one
  // wallet popup). Each allocation keeps its server-assigned tunnelId (authoritative) — see the
  // deposit call below for why the batcher's returned id must not be adopted here.
  const live = await Promise.all(
    allocations.map(async (alloc) => {
      const partyA = parties.get(alloc.game)!;
      const partyB: PartyOnchain = {
        address: alloc.botAddress,
        publicKey: fromHex(alloc.botEphPubkey),
      };
      // Per-game stake from the allocation (backend GameProfile) so games with different stakes
      // batch into one PTB; fall back to the caller's flat stake for back-compat.
      const aAmount =
        alloc.stakeEach != null ? BigInt(alloc.stakeEach) : opts.stakePerGame;
      if (aAmount == null)
        throw new Error(
          `arena: no stake for ${alloc.game} (allocation.stakeEach + stakePerGame both unset)`,
        );
      // Deposit seat A into the fleet-pre-created tunnel. `alloc.tunnelId` is authoritative — the
      // deposit goes INTO it and cannot change its id. The batcher resolves deposit-mode requests via
      // the request's input `tunnelId`, NOT its address-keyed map (which collides when a batch shares
      // one party-A address — all arena games use the same wallet — and would cross games onto a
      // single tunnel, making the co-signed `tunnel_id` disagree with the bot's reservation → every
      // move rejected). So the returned id equals `alloc.tunnelId`; capture it plus the deposit digest
      // to thread into the activity feed.
      let depositDigest: string | undefined;
      const tunnelId = await open({
        mode: "deposit",
        tunnelId: alloc.tunnelId,
        partyA,
        partyB,
        aAmount,
        bAmount: 0n, // the fleet already funded seat B; unused in deposit mode
        coinType: opts.coinType,
        usesAddressBalance: opts.usesAddressBalance ?? true,
        onDigest: (digest) => {
          depositDigest = digest;
          opts.onDepositDigest?.(alloc.game, digest);
        },
      });
      return { ...alloc, tunnelId, depositDigest };
    }),
  );
  await reportArenaOpened(
    live.map((o) => ({ matchId: o.matchId, tunnelId: o.tunnelId })),
    opts,
  );
  return live;
}
