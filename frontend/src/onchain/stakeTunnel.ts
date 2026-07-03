// Sponsored MTPS staking for the shared-tunnel PvP lane (ADR-0009/0010). The seat-A open and
// seat-B deposit each carried the same "MTPS → sponsored + faucet-minted stake; SUI fallback →
// sponsored stake with a sender-pays fallback" branch in every PvP game hook; these two helpers
// centralize it so a fix to the funding strategy lands once, not in five files.
import {
  openAndFundSharedTunnel,
  openManySharedSeatA,
  openAndFundSelfPlay,
  depositStake,
  type SignExec,
} from "./tunnelTx";
import { withSponsorFallback } from "./sponsor";
import { MTPS_COIN_TYPE, isMtpsAddressBalance, isMtpsConfigured } from "./mtps";

type SharedReads = Parameters<typeof openAndFundSharedTunnel>[0]["reads"];
type SharedParty = Parameters<typeof openAndFundSharedTunnel>[0]["partyA"];

/** The signers + stake-coin pickers a seat needs to fund its stake. */
export interface StakeStrategy {
  /** Backend-gas-sponsored signer (settler pays gas). */
  sponsoredSignExec: SignExec;
  /** Wallet sender-pays signer — the SUI-fallback path only. */
  walletSignExec: SignExec;
  /** A user MTPS coin >= the amount (faucets + polls on a cold-start miss). */
  prepareStake: (min: bigint) => Promise<string>;
  /** A user SUI coin >= the amount (SUI fallback, MTPS env unset). */
  selectStakeCoin: (min: bigint) => Promise<string>;
  /** ADR-0013: ensure the player's MTPS address balance covers the stake (address-balance
   *  path). No-op once topped up. */
  ensureStakeBalance: (min: bigint) => Promise<void>;
}

/**
 * Seat A: open + share the tunnel and fund this seat. Returns the new tunnel id.
 *
 * Opens with `penaltyAmount = amount` (the per-seat buy-in), the blackjack-PvP model: a seat that
 * abandons a match it is losing — withholding the co-signature/reveal that would settle the win —
 * forfeits its whole stake at `force_close_after_timeout`, so the honest seat is made whole on-chain.
 * Without it (`penaltyAmount = 0`) the game-blind force-close pays the stale EVEN state and the
 * abandoner keeps its stake (review finding F1). Covers all staked PvP games on this lane
 * (poker, chicken-cross, bomb-it, battleship).
 */
export async function openSharedTunnelStaked(
  opts: StakeStrategy & {
    reads: SharedReads;
    partyA: SharedParty;
    partyB: SharedParty;
    amount: bigint;
    label: string;
  },
): Promise<string> {
  const { reads, partyA, partyB, amount } = opts;
  if (isMtpsConfigured) {
    if (isMtpsAddressBalance) {
      // ADR-0013: withdraw seat A's stake from the player's address balance — concurrent opens
      // across games don't equivocate. Top up the balance first (no-op once funded).
      await opts.ensureStakeBalance(amount);
      return openAndFundSharedTunnel({
        reads,
        signExec: opts.sponsoredSignExec,
        partyA,
        partyB,
        amount,
        penaltyAmount: amount,
        coinType: MTPS_COIN_TYPE,
        stakeFromBalance: { amount, coinType: MTPS_COIN_TYPE },
      });
    }
    return openAndFundSharedTunnel({
      reads,
      signExec: opts.sponsoredSignExec,
      partyA,
      partyB,
      amount,
      penaltyAmount: amount,
      coinType: MTPS_COIN_TYPE,
      stakeCoinId: await opts.prepareStake(amount),
    });
  }
  return withSponsorFallback(
    async () =>
      openAndFundSharedTunnel({
        reads,
        signExec: opts.sponsoredSignExec,
        partyA,
        partyB,
        amount,
        penaltyAmount: amount,
        stakeCoinId: await opts.selectStakeCoin(amount),
      }),
    () =>
      openAndFundSharedTunnel({
        reads,
        signExec: opts.walletSignExec,
        partyA,
        partyB,
        amount,
        penaltyAmount: amount,
      }),
    `${opts.label} open/fund`,
  );
}

/** One match's seat-A open in a batched flush: both seats, this match's per-seat stake, and a label. */
export interface SharedStakedOpenSpec {
  partyA: SharedParty;
  partyB: SharedParty;
  amount: bigint;
  label: string;
}

/**
 * Batched seat A: open + share + fund seat A for N matches in ONE sponsored PTB, returning each
 * match's tunnel id in SPEC ORDER (the i-th id is the i-th spec's tunnel). The batched analogue of
 * {@link openSharedTunnelStaked}: same funding-strategy branch (MTPS address-balance → MTPS coin →
 * SUI sponsored-with-wallet-fallback) and the same `penaltyAmount = amount` per seat (the
 * abandonment-forfeit model — see {@link openSharedTunnelStaked}), but the whole batch draws ONE
 * summed stake withdrawal so a flush costs ONE Enoki sponsor+execute pair (design §4.1).
 *
 * Demux is by each created tunnel's on-chain `party_b.public_key` inside {@link openManySharedSeatA}
 * (objectChanges order is unspecified); a post-commit demux failure surfaces as `BatchCommittedError`
 * — the tunnels exist and stake is consumed, so callers MUST NOT retry. A 1-spec call builds the same
 * PTB shape as `openSharedTunnelStaked` (one create + seat-A deposit + share, one withdrawal), so the
 * lone-flush / single-match path stays correct.
 */
export async function openSharedTunnelStakedMany(
  opts: StakeStrategy & {
    reads: SharedReads;
    specs: SharedStakedOpenSpec[];
  },
): Promise<string[]> {
  const { reads, specs } = opts;
  const total = specs.reduce((sum, s) => sum + s.amount, 0n);
  const seatSpecs = specs.map((s) => ({
    partyA: s.partyA,
    partyB: s.partyB,
    amount: s.amount,
    penaltyAmount: s.amount,
  }));
  if (isMtpsConfigured) {
    if (isMtpsAddressBalance) {
      // ADR-0013: withdraw the WHOLE batch's stake (summed) from the player's address balance in one
      // shot — concurrent opens across games don't equivocate. Top up first (no-op once funded).
      await opts.ensureStakeBalance(total);
      return openManySharedSeatA({
        reads,
        signExec: opts.sponsoredSignExec,
        specs: seatSpecs,
        coinType: MTPS_COIN_TYPE,
        stakeFromBalance: { amount: total, coinType: MTPS_COIN_TYPE },
      });
    }
    return openManySharedSeatA({
      reads,
      signExec: opts.sponsoredSignExec,
      specs: seatSpecs,
      coinType: MTPS_COIN_TYPE,
      stakeCoinId: await opts.prepareStake(total),
    });
  }
  return withSponsorFallback(
    async () =>
      openManySharedSeatA({
        reads,
        signExec: opts.sponsoredSignExec,
        specs: seatSpecs,
        stakeCoinId: await opts.selectStakeCoin(total),
      }),
    () =>
      openManySharedSeatA({
        reads,
        signExec: opts.walletSignExec,
        specs: seatSpecs,
      }),
    `pvp many-open (${specs.length})`,
  );
}

/**
 * Self-play: open + fund BOTH ephemeral-bot seats from one wallet in ONE signature. The self-play
 * analogue of {@link openSharedTunnelStaked} — same funding-strategy branch (MTPS address-balance →
 * MTPS coin → SUI sponsored-with-wallet-fallback) so a fix lands once — but it funds both seats via
 * `create_and_fund` (the existing {@link openAndFundSelfPlay} tx) instead of seat A only. No penalty
 * is set: both seats are the same player's bots, so there is no opponent to make whole on abandon.
 */
export async function openSelfPlayStaked(
  opts: StakeStrategy & {
    reads: SharedReads;
    partyA: SharedParty;
    partyB: SharedParty;
    aAmount: bigint;
    bAmount: bigint;
    label: string;
  },
): Promise<string> {
  const { reads, partyA, partyB, aAmount, bAmount } = opts;
  const total = aAmount + bAmount;
  if (isMtpsConfigured) {
    if (isMtpsAddressBalance) {
      // ADR-0013: withdraw both seats' stake (summed) from the player's address balance — concurrent
      // opens across games don't equivocate. Top up first (no-op once funded).
      await opts.ensureStakeBalance(total);
      return openAndFundSelfPlay({
        reads,
        signExec: opts.sponsoredSignExec,
        partyA,
        partyB,
        aAmount,
        bAmount,
        coinType: MTPS_COIN_TYPE,
        stakeFromBalance: { amount: total, coinType: MTPS_COIN_TYPE },
      });
    }
    return openAndFundSelfPlay({
      reads,
      signExec: opts.sponsoredSignExec,
      partyA,
      partyB,
      aAmount,
      bAmount,
      coinType: MTPS_COIN_TYPE,
      stakeCoinId: await opts.prepareStake(total),
    });
  }
  return withSponsorFallback(
    async () =>
      openAndFundSelfPlay({
        reads,
        signExec: opts.sponsoredSignExec,
        partyA,
        partyB,
        aAmount,
        bAmount,
        stakeCoinId: await opts.selectStakeCoin(total),
      }),
    () =>
      openAndFundSelfPlay({
        reads,
        signExec: opts.walletSignExec,
        partyA,
        partyB,
        aAmount,
        bAmount,
      }),
    `${opts.label} self-play open/fund`,
  );
}

/** Seat B: deposit this seat's stake into an already-open shared tunnel. */
export async function depositStakeStaked(
  opts: StakeStrategy & { tunnelId: string; amount: bigint; label: string },
): Promise<void> {
  const { tunnelId, amount } = opts;
  if (isMtpsConfigured) {
    if (isMtpsAddressBalance) {
      await opts.ensureStakeBalance(amount);
      await depositStake({
        signExec: opts.sponsoredSignExec,
        tunnelId,
        amount,
        coinType: MTPS_COIN_TYPE,
        stakeFromBalance: { amount, coinType: MTPS_COIN_TYPE },
      });
      return;
    }
    await depositStake({
      signExec: opts.sponsoredSignExec,
      tunnelId,
      amount,
      coinType: MTPS_COIN_TYPE,
      stakeCoinId: await opts.prepareStake(amount),
    });
    return;
  }
  await withSponsorFallback(
    async () =>
      depositStake({
        signExec: opts.sponsoredSignExec,
        tunnelId,
        amount,
        stakeCoinId: await opts.selectStakeCoin(amount),
      }),
    () => depositStake({ signExec: opts.walletSignExec, tunnelId, amount }),
    `${opts.label} deposit`,
  );
}
