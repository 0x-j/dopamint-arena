// On-demand arena allocation for a single game — the "click Play → get me a bot for THIS game now"
// recipe (ADR-0025/0028), shared by every arena game's `playArena`. It is the SSoT the per-game hooks
// call so the eph-key + allocate + seat-A-deposit steps live in one place instead of copy-inlined.
//
// Unlike the connect-time batch (`enterArena` over many games, coalesced into ONE PTB by the shared
// batcher) and the add-a-game lazy path (`requestArenaGame`, which also rides the batcher), a single
// explicit Play is ONE game → ONE deposit → ONE wallet popup: no coalescing needed. So this uses a
// game-local sponsored deposit (`depositStakeStaked`) instead of the shared batcher — the same staked
// primitive `findMatch` uses, so sponsorship + top-up behave identically — and does NOT depend on the
// batcher having been configured on connect.
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { enterArena, type ArenaAllocation } from "@/onchain/arenaEnter";
import { depositStakeStaked, type StakeStrategy } from "@/onchain/stakeTunnel";
import type { TunnelOpenRequest } from "@/onchain/tunnelOpenBatcher";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { resolveBackendUrl } from "@/backend/controlPlane";

/** Reserve one warm fleet bot for `arenaGameId` (the fleet pre-creates the tunnel + funds seat B),
 *  deposit seat A with the caller's stake strategy, and return the live allocation plus the per-game
 *  ephemeral key baked into the tunnel at create — the caller hands both to its `enterArenaMatch` to
 *  wire the relay + engine. Returns `null` when no bot was free (the backend omits it), so the caller
 *  can surface a "try again" lobby state. `stakePerGame` is the back-compat fallback stake; the deposit
 *  prefers the allocation's `stakeEach` (backend SSoT) when present. */
export async function allocateArenaGameForPlay(opts: {
  arenaGameId: string;
  wallet: string;
  stake: StakeStrategy;
  /** Deposit label for logs/telemetry — the game's key (e.g. "quantumPoker"). */
  label: string;
  stakePerGame?: bigint;
}): Promise<{ allocation: ArenaAllocation; keypair: KeyPair } | null> {
  // One ephemeral key: its pubkey is baked into the tunnel as party A at allocate, and the SAME key
  // co-signs every move via `enterArenaMatch` (a different key rejects sigs), so return it to the caller.
  const eph = generateKeyPair();
  // Deposit seat A into the fleet-pre-created tunnel (seat B already funded by the bot).
  const open = async (req: TunnelOpenRequest): Promise<string> => {
    const tunnelId = req.tunnelId;
    if (!tunnelId) throw new Error("arena deposit missing tunnelId");
    await depositStakeStaked({
      tunnelId,
      amount: req.aAmount,
      label: opts.label,
      ...opts.stake,
    });
    return tunnelId;
  };
  const allocations = await enterArena({
    games: [opts.arenaGameId],
    userAddress: opts.wallet,
    stakePerGame: opts.stakePerGame,
    makeUserParty: async () => ({
      address: opts.wallet,
      publicKey: eph.publicKey,
    }),
    open,
    coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
    apiBase: resolveBackendUrl(),
  });
  const allocation = allocations.find((a) => a.game === opts.arenaGameId);
  return allocation ? { allocation, keypair: eph } : null;
}

/** Shared `playArena` recipe: move the caller into its busy state, allocate via
 *  `allocateArenaGameForPlay`, surface "no opponent" through the caller's own error state or a
 *  thrown error through `onCaught`, and otherwise hand the live allocation off to the caller's
 *  `enterArenaMatch`. Every arena game's on-demand Play trigger is this same shape — this is the
 *  single place it lives so a game only supplies its wallet-guard, `StakeStrategy`, and
 *  state-transition closures. */
export async function runArenaPlay(opts: {
  arenaGameId: string;
  wallet: string;
  stake: StakeStrategy;
  label: string;
  stakePerGame?: bigint;
  /** Move the hook into its "funding/allocating" busy state (+ emit). */
  setBusy: () => void;
  /** Surface an error message (+ move to the error state). */
  setError: (msg: string) => void;
  /** Surface a caught throwable exactly as this hook does — the class hooks route it through
   *  `this.fail(e)`, the functional hooks format it inline. Each hook's own formatting is
   *  preserved here rather than centralized, since a rare non-Error throw formats differently
   *  between the two (`fail` keeps a `.message`-bearing non-Error; the inline form stringifies it). */
  onCaught: (e: unknown) => void;
  /** Wire the live allocation into the match (each hook's enterArenaMatch). */
  enter: (allocation: ArenaAllocation, keypair: KeyPair) => void;
}): Promise<void> {
  try {
    opts.setBusy();
    const entry = await allocateArenaGameForPlay({
      arenaGameId: opts.arenaGameId,
      wallet: opts.wallet,
      stake: opts.stake,
      label: opts.label,
      stakePerGame: opts.stakePerGame,
    });
    if (!entry) {
      opts.setError("no opponent available — try again in a moment");
      return;
    }
    opts.enter(entry.allocation, entry.keypair);
  } catch (e) {
    opts.onCaught(e);
  }
}
