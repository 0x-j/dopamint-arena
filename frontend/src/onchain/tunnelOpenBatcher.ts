// Connect-time coalescing coordinator (ADR-0019). Every self-play window funds its tunnel through
// ONE shared batcher: requests issued in the same connect tick are debounced into a single flush,
// the summed stake is funded once, and one `openAndFundMany` PTB opens them all — so the gas
// sponsor sees ~2 calls per connect instead of one per window. A batch of size 1 is exactly the
// old per-window open. Created tunnels are correlated back to requesters by party-A address.
import {
  openAndFundMany,
  openAndFundSelfPlay,
  depositSeatAMany,
  normalizeSuiAddress,
  BatchCommittedError,
  type PartyOnchain,
  type SignExec,
  type SuiReads,
  type TunnelOpenManySpec,
  type TunnelDepositSeatASpec,
} from "./tunnelTx";
import { withSponsorFallback } from "./sponsor";
import { MTPS_COIN_TYPE, isMtpsAddressBalance, isMtpsConfigured } from "./mtps";

export interface TunnelOpenRequest {
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  aAmount: bigint;
  bAmount: bigint;
  /** What this request builds. `"open"` (default) is self-play — one wallet opens + funds BOTH
   *  seats in one `create_and_fund` (ADR-0019). `"deposit"` is the genuine-two-party arena join
   *  (ADR-0025): the fleet already created the tunnel + funded seat B, so the user only deposits
   *  seat A into the existing `tunnelId` (`partyB`/`bAmount` are unused). */
  mode?: "open" | "deposit";
  /** The fleet-pre-opened tunnel to deposit seat A into. Required for `mode: "deposit"`. */
  tunnelId?: string;
  /** Coin type `T` for the tunnel; defaults per env (MTPS when configured, else SUI). */
  coinType?: string;
  /** ADR-0013: fund the stake from the player's address balance when the env supports it. */
  usesAddressBalance?: boolean;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
  /** Called with the committed PTB digest as soon as the chunk's transaction lands. */
  onDigest?: (digest: string) => void;
}

/** Wallet-bound capabilities the batcher needs at flush time (latest values, read lazily). */
export interface BatcherDeps {
  reads: SuiReads;
  sponsoredSignExec: SignExec;
  signExec: SignExec;
  ensureStakeBalance: (need: bigint) => Promise<void>;
  prepareStake: (need: bigint) => Promise<string>;
  selectStakeCoin: (need: bigint) => Promise<string>;
}

/** Default PTB batch size. ~7 catalog games fit in one PTB; this caps a pathological flood under
 *  the PTB command/argument ceiling (30 deposits ≈ 30 commands, ≫ under the ~1024 ceiling). Larger
 *  flushes chunk into ceil(N / MAX_BATCH) PTBs. Matches the backend open-batch cap. */
const DEFAULT_MAX_BATCH = 30;
const DEFAULT_FLUSH_DELAY_MS = 30;

type FundingMode = "balance" | "mtps-coin" | "sui";

interface Pending {
  req: TunnelOpenRequest;
  resolve: (tunnelId: string) => void;
  reject: (err: unknown) => void;
}

function fundingModeOf(req: TunnelOpenRequest): FundingMode {
  if (!isMtpsConfigured) return "sui";
  if (req.usesAddressBalance && isMtpsAddressBalance) return "balance";
  return "mtps-coin";
}

function coinTypeOf(req: TunnelOpenRequest): string | undefined {
  if (req.coinType) return req.coinType;
  return isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** `onDigest` is only invoked for requests whose tunnel id was successfully correlated to the
 *  batch/single result. If a PTB lands but correlation fails, the digest is not surfaced per-request
 *  (the error path still carries it for diagnostics). */
function requireDigest(digest: string | undefined): string {
  if (!digest) throw new Error("expected digest after open/fund PTB");
  return digest;
}

const specOf = (req: TunnelOpenRequest): TunnelOpenManySpec => ({
  partyA: req.partyA,
  partyB: req.partyB,
  aAmount: req.aAmount,
  bAmount: req.bAmount,
  timeoutMs: req.timeoutMs,
  penaltyAmount: req.penaltyAmount,
});

const depositSpecOf = (req: TunnelOpenRequest): TunnelDepositSeatASpec => {
  if (!req.tunnelId)
    throw new Error("deposit request missing tunnelId (arena join, ADR-0025)");
  return { tunnelId: req.tunnelId, partyA: req.partyA, amount: req.aAmount };
};

/** The stake this request funds: seat A only when depositing into the arena's pre-opened tunnel,
 *  both seats when opening a self-play tunnel. */
const stakeTotalOf = (req: TunnelOpenRequest): bigint =>
  req.mode === "deposit" ? req.aAmount : req.aAmount + req.bAmount;

export class TunnelOpenBatcher {
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxBatch: number;
  private readonly flushDelayMs: number;

  constructor(
    private readonly getDeps: () => BatcherDeps | null,
    opts?: { maxBatch?: number; flushDelayMs?: number },
  ) {
    this.maxBatch = opts?.maxBatch ?? DEFAULT_MAX_BATCH;
    this.flushDelayMs = opts?.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  }

  /** Enroll a tunnel open; resolves with the created tunnel id once the coalesced flush lands. */
  request(req: TunnelOpenRequest): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ req, resolve, reject });
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  private async flush(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;

    const deps = this.getDeps();
    if (!deps) {
      const err = new Error("no wallet connected — cannot open tunnels");
      for (const p of batch) p.reject(err);
      return;
    }

    // Group by funding mode + coin type: each group needs its own stake source, so it is its own
    // PTB stream. In practice the arena runs one mode, so this is usually a single group.
    const groups = new Map<string, Pending[]>();
    for (const p of batch) {
      // Mode joins the key: an arena deposit and a self-play open build different PTBs and sum
      // stakes differently, so they must not share one chunk.
      const key = `${p.req.mode ?? "open"}:${fundingModeOf(p.req)}:${coinTypeOf(p.req) ?? "SUI"}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
    }

    await Promise.all(
      [...groups.values()].map((group) => this.flushGroup(group, deps)),
    );
  }

  private async flushGroup(group: Pending[], deps: BatcherDeps): Promise<void> {
    const mode = fundingModeOf(group[0].req);
    const coinType = coinTypeOf(group[0].req);
    const groupTotal = group.reduce((sum, p) => sum + stakeTotalOf(p.req), 0n);

    // Address-balance mode: top up ONCE for the whole group; each chunk's PTB withdraws its share.
    if (mode === "balance") {
      try {
        await deps.ensureStakeBalance(groupTotal);
      } catch (err) {
        for (const p of group) p.reject(err);
        return;
      }
    }

    const chunks = chunk(group, this.maxBatch);
    if (chunks.length > 1) {
      console.info(
        `[tunnelOpenBatcher] ${group.length} opens > maxBatch ${this.maxBatch} → ${chunks.length} PTBs`,
      );
    }
    await Promise.all(
      chunks.map((c) => this.flushChunk(c, deps, mode, coinType)),
    );
  }

  private async flushChunk(
    chunkPending: Pending[],
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
  ): Promise<void> {
    const deposit = chunkPending[0].req.mode === "deposit";
    const chunkTotal = chunkPending.reduce(
      (s, p) => s + stakeTotalOf(p.req),
      0n,
    );
    try {
      const result = deposit
        ? await this.depositChunk(
            deps,
            mode,
            coinType,
            chunkPending.map((p) => depositSpecOf(p.req)),
            chunkTotal,
          )
        : await this.openChunk(
            deps,
            mode,
            coinType,
            chunkPending.map((p) => specOf(p.req)),
            chunkTotal,
          );
      for (const p of chunkPending) {
        // Deposit mode: the tunnel already exists and its id is the request INPUT, so resolve to it
        // directly. `map` is keyed by party-A ADDRESS, which collides when a batch shares one wallet
        // — the arena case: every game deposits seat A from the same address (only the per-game eph
        // pubkey differs), so the map collapses to a single entry and would hand every game the same
        // (wrong) tunnel, making its co-signed tunnelId disagree with the bot's. Open mode has no id
        // upfront (its tunnels are created by this PTB), so it still resolves via the map.
        const id = deposit
          ? p.req.tunnelId
          : result.map.get(normalizeSuiAddress(p.req.partyA.address));
        // Fire `onDigest` only for a successfully correlated tunnel id, so the activity feed never
        // attributes a batch digest to a request whose tunnel we couldn't resolve.
        if (id) {
          p.resolve(id);
          p.req.onDigest?.(result.digest);
        } else {
          p.reject(
            new Error(`no tunnel matched party-A ${p.req.partyA.address}`),
          );
        }
      }
    } catch (batchErr) {
      // POST-COMMIT failure: the batch PTB already landed on-chain — tunnels exist and stake is
      // consumed. Retrying via single opens would double-open and double-consume stake. Reject all
      // pending requests immediately without any fallback.
      if (batchErr instanceof BatchCommittedError) {
        for (const p of chunkPending) p.reject(batchErr);
        return;
      }
      // PRE-COMMIT failure: atomic PTB rejected before landing (one bad spec aborts the chunk).
      // Fall back to per-request single opens so one failure can't strand its siblings.
      console.warn(
        `[tunnelOpenBatcher] batched open failed (${(batchErr as Error)?.message}); ` +
          `falling back to ${chunkPending.length} single opens`,
      );
      await Promise.all(
        chunkPending.map(async (p) => {
          try {
            const result = deposit
              ? await this.depositSingle(deps, mode, coinType, p.req)
              : await this.openSingle(deps, mode, coinType, p.req);
            const id = result.map.get(
              normalizeSuiAddress(p.req.partyA.address),
            );
            if (id) {
              p.resolve(id);
              p.req.onDigest?.(result.digest);
            } else {
              p.reject(
                new Error(`no tunnel matched party-A ${p.req.partyA.address}`),
              );
            }
          } catch (singleErr) {
            p.reject(singleErr);
          }
        }),
      );
    }
  }

  private async openChunk(
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
    specs: TunnelOpenManySpec[],
    total: bigint,
  ): Promise<{ map: Map<string, string>; digest: string }> {
    let digest: string | undefined;
    const onDigest = (d: string) => {
      digest = d;
    };
    if (mode === "balance") {
      const map = await openAndFundMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeFromBalance: {
          amount: total,
          coinType: coinType ?? MTPS_COIN_TYPE,
        },
        onDigest,
      });
      return { map, digest: requireDigest(digest) };
    }
    if (mode === "mtps-coin") {
      const stakeCoinId = await deps.prepareStake(total);
      const map = await openAndFundMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeCoinId,
        onDigest,
      });
      return { map, digest: requireDigest(digest) };
    }
    // SUI: sponsored open off a user coin, falling back to a wallet-signed gas-funded open.
    // We inline the sponsor fallback here (rather than delegating to withSponsorFallback) so that
    // BatchCommittedError can propagate immediately — if the sponsored PTB already committed,
    // retrying via sender-pays would double-open and double-consume stake.
    let sponsorErr: unknown;
    try {
      const map = await openAndFundMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeCoinId: await deps.selectStakeCoin(total),
        onDigest,
      });
      return { map, digest: requireDigest(digest) };
    } catch (err) {
      if (err instanceof BatchCommittedError) throw err; // committed: never retry
      sponsorErr = err;
    }
    console.warn(
      `[sponsor] batched open/fund: sponsor failed, falling back to sender-pays`,
      sponsorErr,
    );
    digest = undefined;
    try {
      const map = await openAndFundMany({
        reads: deps.reads,
        signExec: deps.signExec,
        specs,
        coinType,
        onDigest,
      });
      return { map, digest: requireDigest(digest) };
    } catch (payErr) {
      if (payErr instanceof BatchCommittedError) throw payErr; // committed: never retry
      throw new Error(
        `batched open/fund: sponsored path failed [${String((sponsorErr as Error)?.message ?? sponsorErr)}]; sender-pays fallback failed [${String((payErr as Error)?.message ?? payErr)}]`,
      );
    }
  }

  /** Arena-join analog of {@link openChunk} (ADR-0025): one PTB depositing seat A into N tunnels
   *  the fleet already opened + funded seat B for, resolved by party-A. Same sponsor → sender-pays
   *  fallback; a committed deposit must never retry (double-deposit). */
  private async depositChunk(
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
    specs: TunnelDepositSeatASpec[],
    total: bigint,
  ): Promise<{ map: Map<string, string>; digest: string }> {
    let digest: string | undefined;
    const onDigest = (d: string) => {
      digest = d;
    };
    if (mode === "balance") {
      const map = await depositSeatAMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeFromBalance: {
          amount: total,
          coinType: coinType ?? MTPS_COIN_TYPE,
        },
        onDigest,
      });
      return { map, digest: requireDigest(digest) };
    }
    if (mode === "mtps-coin") {
      const stakeCoinId = await deps.prepareStake(total);
      const map = await depositSeatAMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeCoinId,
        onDigest,
      });
      return { map, digest: requireDigest(digest) };
    }
    // SUI: sponsored deposit off a user coin, else wallet-signed gas-funded. BatchCommittedError
    // propagates immediately — a committed PTB must never retry (double-deposit).
    let sponsorErr: unknown;
    try {
      const map = await depositSeatAMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeCoinId: await deps.selectStakeCoin(total),
        onDigest,
      });
      return { map, digest: requireDigest(digest) };
    } catch (err) {
      if (err instanceof BatchCommittedError) throw err;
      sponsorErr = err;
    }
    console.warn(
      `[sponsor] arena batched deposit: sponsor failed, falling back to sender-pays`,
      sponsorErr,
    );
    digest = undefined;
    try {
      const map = await depositSeatAMany({
        reads: deps.reads,
        signExec: deps.signExec,
        specs,
        coinType,
        onDigest,
      });
      return { map, digest: requireDigest(digest) };
    } catch (payErr) {
      if (payErr instanceof BatchCommittedError) throw payErr;
      throw new Error(
        `arena batched deposit: sponsored path failed [${String((sponsorErr as Error)?.message ?? sponsorErr)}]; sender-pays fallback failed [${String((payErr as Error)?.message ?? payErr)}]`,
      );
    }
  }

  /** Pre-commit fallback for one arena deposit: a single-spec {@link depositSeatAMany}. */
  private async depositSingle(
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
    req: TunnelOpenRequest,
  ): Promise<{ map: Map<string, string>; digest: string }> {
    return this.depositChunk(
      deps,
      mode,
      coinType,
      [depositSpecOf(req)],
      req.aAmount,
    );
  }

  private async openSingle(
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
    req: TunnelOpenRequest,
  ): Promise<{ map: Map<string, string>; digest: string }> {
    const total = req.aAmount + req.bAmount;
    let digest: string | undefined;
    const onDigest = (d: string) => {
      digest = d;
    };
    const makeMap = (id: string): Map<string, string> => {
      const map = new Map<string, string>();
      map.set(normalizeSuiAddress(req.partyA.address), id);
      return map;
    };
    if (mode === "balance") {
      const id = await openAndFundSelfPlay({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec as never,
        partyA: req.partyA,
        partyB: req.partyB,
        aAmount: req.aAmount,
        bAmount: req.bAmount,
        coinType,
        stakeFromBalance: {
          amount: total,
          coinType: coinType ?? MTPS_COIN_TYPE,
        },
        onDigest,
      });
      return { map: makeMap(id), digest: requireDigest(digest) };
    }
    if (mode === "mtps-coin") {
      const id = await openAndFundSelfPlay({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec as never,
        partyA: req.partyA,
        partyB: req.partyB,
        aAmount: req.aAmount,
        bAmount: req.bAmount,
        coinType,
        stakeCoinId: await deps.prepareStake(total),
        onDigest,
      });
      return { map: makeMap(id), digest: requireDigest(digest) };
    }
    const id = await withSponsorFallback(
      async () =>
        openAndFundSelfPlay({
          reads: deps.reads,
          signExec: deps.sponsoredSignExec as never,
          partyA: req.partyA,
          partyB: req.partyB,
          aAmount: req.aAmount,
          bAmount: req.bAmount,
          stakeCoinId: await deps.selectStakeCoin(total),
          onDigest,
        }),
      () =>
        openAndFundSelfPlay({
          reads: deps.reads,
          signExec: deps.signExec as never,
          partyA: req.partyA,
          partyB: req.partyB,
          aAmount: req.aAmount,
          bAmount: req.bAmount,
          onDigest,
        }),
      "single open/fund fallback",
    );
    return { map: makeMap(id), digest: requireDigest(digest) };
  }
}
