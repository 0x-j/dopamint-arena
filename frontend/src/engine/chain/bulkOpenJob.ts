/**
 * Time-windowed bulk-open job (design §4.1). Workers never sign; they enqueue seat-A open
 * intents through the chain bridge. This main-thread job drains the per-sender queue on a
 * trailing-quiet debounce ({@link BULK_OPEN_QUIET_MS} after the last open, capped at
 * {@link BULK_OPEN_MAX_WINDOW_MS}) and is the single place where many game-window opens are meant to
 * collapse into ONE sponsored PTB — the motivation is the Enoki rate limit (one sponsor+execute pair
 * per batch), not wallet popups (sponsored opens are already popup-free).
 *
 * Each flush composes its window into ONE Programmable Transaction Block via the PvP many-open
 * builder (`openSharedTunnelStakedMany` → `openManySharedSeatA`): N seat-A opens (`create` +
 * `deposit_party_a` + `public_share_object`) sharing ONE summed stake withdrawal, one
 * sponsored+executed tx per flush — so a window of game opens costs one Enoki sponsor pair, not N.
 * This deliberately does NOT reuse the self-play `openAndFundMany` (`create_and_fund`): that funds
 * BOTH seats from one sender (a PvP open funds only seat A; seat B deposits separately) and demuxes
 * created tunnels by party-A address, which here is the shared wallet — identical across the batch.
 * Demux is therefore by each created tunnel's on-chain `party_b.public_key` (the builder owns it).
 *
 * Off the `?engine=worker` flag the job is a transparent pass-through (immediate 1-item flush), so
 * non-worker behaviour is unchanged.
 */
import type { OpenTunnelParams } from "../engineApi";
import { engineEnabled } from "../flag";
import { elog, emark, ENGINE_DEBUG } from "../debug";
import { BatchCommittedError, normalizeSuiAddress } from "@/onchain/tunnelTx";

/**
 * Trailing-quiet debounce (design §4.1). A flush fires once a sender's window has been QUIET for
 * this long — i.e. ~{@link BULK_OPEN_QUIET_MS} after the LAST open arrived, not a fixed tick from
 * the FIRST. The realistic batching case — "open all games at once" on reload — mounts every window
 * within a few hundred ms, so the batch goes quiet (and flushes as ONE PTB) ~{@link BULK_OPEN_QUIET_MS}
 * after the last one, instead of every match waiting a fixed full window. A lone open with nothing
 * joining flushes after the same quiet gap, so a single match starts fast.
 */
export const BULK_OPEN_QUIET_MS = 500;

/** Hard cap (design §4.1): the longest a flush is held from the FIRST intent, so a sustained trickle
 *  of opens (each resetting the quiet timer) still flushes by this deadline rather than never. Bounds
 *  the worst-case "Starting…" latency; far under the old fixed 5 s tick. */
export const BULK_OPEN_MAX_WINDOW_MS = 2000;

export type OpenResult = { tunnelId: string };

/**
 * Rejection for a seat-A open cancelled before its window flushed (orphan-tunnel cancel,
 * design §4.1): the match/window was torn down inside the bulk-open debounce window, so no tunnel
 * should be opened (and no stake consumed) for it. Benign — the awaiting caller is already
 * tearing the session down, so this is an expected cancellation, not a real open failure.
 */
export class OpenCancelledError extends Error {
  constructor(intentId: string) {
    super(
      `bulk-open intent ${intentId} cancelled before flush (match torn down)`,
    );
    this.name = "OpenCancelledError";
  }
}

/**
 * Open a whole window of seat-A intents in ONE PTB (e.g. `openSharedTunnelStakedMany` via the chain
 * bridge). MUST return one result per input intent in INPUT ORDER — `results[i]` is the tunnel for
 * `batch[i]` (the builder demuxes created tunnels by their on-chain `party_b.public_key`). A post-commit demux
 * failure rejects with `BatchCommittedError` so the job can surface it and never retry. */
export type BatchOpen = (batch: OpenTunnelParams[]) => Promise<OpenResult[]>;

export interface BulkOpenJobOptions {
  /** Trailing-quiet gap; flush this long after the last open arrived. Default {@link BULK_OPEN_QUIET_MS}. */
  quietMs?: number;
  /** Hard cap from the first open. Default {@link BULK_OPEN_MAX_WINDOW_MS}. */
  maxWindowMs?: number;
  /** Flag predicate (injectable for tests); defaults to the `?engine=worker` flag. Off → the job
   *  is a transparent pass-through (immediate per-match open), so non-worker behaviour is unchanged. */
  enabled?: () => boolean;
}

interface PendingOpen {
  params: OpenTunnelParams;
  resolve: (result: OpenResult) => void;
  reject: (err: unknown) => void;
  /** Correlates this intent to {@link BulkOpenJob.cancel}; minted by the worker per open so a
   *  match teardown can cancel exactly its own queued open. Absent off the flag (no window). */
  intentId?: string;
}

/** One sender's accumulating window. A Sui tx has a single `sender` and the sponsor guard forces
 *  every stake withdrawal to `WithdrawFrom::Sender`, so cross-sender batching is rejected — the
 *  job shards by sender and each shard becomes (at most) one PTB.
 *
 *  `quietTimer` is reset on every new intent (the trailing debounce); `capTimer` is armed once on
 *  the FIRST intent and never reset (the hard cap). Whichever fires first flushes; flush clears both. */
interface SenderShard {
  pending: PendingOpen[];
  quietTimer: ReturnType<typeof setTimeout> | null;
  capTimer: ReturnType<typeof setTimeout> | null;
}

export class BulkOpenJob {
  private readonly shards = new Map<string, SenderShard>();
  private readonly quietMs: number;
  private readonly maxWindowMs: number;
  private readonly enabled: () => boolean;
  /** Debug counters: PTBs actually signed+executed via Enoki (one per flush) and the total intents
   *  opened across them — so `window.__bulkOpen()` shows that many matches collapsed into FEWER
   *  Enoki sign+execute round-trips (the whole point of batching). */
  private signedPtbs = 0;
  private openedIntents = 0;

  constructor(
    private readonly batchOpen: BatchOpen,
    opts?: BulkOpenJobOptions,
  ) {
    this.quietMs = opts?.quietMs ?? BULK_OPEN_QUIET_MS;
    this.maxWindowMs = opts?.maxWindowMs ?? BULK_OPEN_MAX_WINDOW_MS;
    this.enabled = opts?.enabled ?? engineEnabled;
    // Debug: expose the live per-sender queue at `window.__bulkOpen()` (see inspect()).
    if (ENGINE_DEBUG && typeof window !== "undefined") {
      (window as unknown as { __bulkOpen?: () => unknown }).__bulkOpen = () =>
        this.inspect();
    }
  }

  /** Debug snapshot (call `window.__bulkOpen()` when ENGINE_DEBUG is on): how many PTBs have been
   *  signed via Enoki, how many intents that covered, and the per-sender pending window. */
  inspect(): {
    signedPtbs: number;
    openedIntents: number;
    pending: {
      sender: string;
      pending: number;
      intentIds: (string | undefined)[];
    }[];
  } {
    return {
      signedPtbs: this.signedPtbs,
      openedIntents: this.openedIntents,
      pending: [...this.shards].map(([sender, s]) => ({
        sender,
        pending: s.pending.length,
        intentIds: s.pending.map((p) => p.intentId),
      })),
    };
  }

  /** Enqueue a seat-A open; resolves with the tunnel id once this sender's window flushes. Pass an
   *  `intentId` (the worker mints one per open) to allow {@link cancel}ing it before the flush. Off
   *  the worker flag, opens immediately (no window, not cancellable) so the non-worker path is
   *  unchanged. */
  enqueue(params: OpenTunnelParams, intentId?: string): Promise<OpenResult> {
    // Off the flag: open immediately as a 1-item batch — one PTB, one tunnel, same on-chain shape
    // as a direct open — so the non-worker path keeps its no-window behaviour.
    if (!this.enabled()) return this.batchOpen([params]).then((rs) => rs[0]);
    return new Promise<OpenResult>((resolve, reject) => {
      const sender = senderOf(params);
      const shard = this.shardFor(sender);
      shard.pending.push({ params, resolve, reject, intentId });
      elog("bulkopen", "enqueue", {
        sender: sender.slice(0, 10),
        queued: shard.pending.length,
        intentId,
      });
      // Arm the hard cap once, on the first intent (anchored to it; never reset). It bounds the
      // worst-case hold when opens keep trickling in and resetting the quiet timer below.
      if (shard.capTimer === null) {
        shard.capTimer = setTimeout(() => this.flush(sender), this.maxWindowMs);
      }
      // Trailing debounce: (re)start the quiet timer on EVERY intent, so a flush fires `quietMs`
      // after the LAST open — a near-simultaneous "open all" batch coalesces, a lone open still
      // starts fast, and a steady stream is caught by the cap above.
      if (shard.quietTimer !== null) clearTimeout(shard.quietTimer);
      shard.quietTimer = setTimeout(() => this.flush(sender), this.quietMs);
    });
  }

  /**
   * Orphan-tunnel cancel (design §4.1): drop a still-queued open so a match/window torn down
   * inside the bulk-open window never flushes a tunnel (consuming stake) for a gone match. Removes
   * the intent from its sender shard and rejects its pending promise with {@link OpenCancelledError};
   * if that empties the shard, clears its timers and deletes it so no stray flush fires.
   *
   * No-op if the intent is unknown — it has already been flushed into an in-flight/committed PTB
   * (it left `pending` on flush) and can no longer be cancelled. The awaiting `enqueue` caller still
   * settles/closes that tunnel through its normal terminal path; this must not throw.
   */
  cancel(intentId: string): void {
    for (const [sender, shard] of this.shards) {
      const i = shard.pending.findIndex((p) => p.intentId === intentId);
      if (i === -1) continue;
      const [cancelled] = shard.pending.splice(i, 1);
      elog("bulkopen", "cancel", { intentId, remaining: shard.pending.length });
      cancelled.reject(new OpenCancelledError(intentId));
      if (shard.pending.length === 0) {
        if (shard.quietTimer) clearTimeout(shard.quietTimer);
        if (shard.capTimer) clearTimeout(shard.capTimer);
        this.shards.delete(sender);
      }
      return;
    }
  }

  private shardFor(sender: string): SenderShard {
    let shard = this.shards.get(sender);
    if (!shard) {
      shard = { pending: [], quietTimer: null, capTimer: null };
      this.shards.set(sender, shard);
    }
    return shard;
  }

  /** Detach and open this sender's accumulated window. */
  private flush(sender: string): void {
    const shard = this.shards.get(sender);
    if (!shard || shard.pending.length === 0) return;
    if (shard.quietTimer) clearTimeout(shard.quietTimer);
    if (shard.capTimer) clearTimeout(shard.capTimer);
    const batch = shard.pending;
    this.shards.delete(sender);
    elog("bulkopen", "flush", {
      sender: sender.slice(0, 10),
      batch: batch.length,
    });
    void this.openBatch(batch);
  }

  /**
   * Compose one sender's window into a single PTB via {@link batchOpen} and demux a tunnel id back
   * to each intent by INPUT ORDER (`results[i]` ↔ `batch[i]`).
   *
   * Never-retry rule (design §4.1): `batchOpen` rejects the WHOLE flush on any failure. A
   * `BatchCommittedError` means the PTB committed on-chain but post-commit demux failed — the
   * tunnels exist and stake is consumed, so every intent is rejected and the open is NEVER retried
   * (a retry double-opens and double-consumes stake). Pre-commit rejects (build/sign/sponsor) also
   * surface here; the worker reports the error and the player re-initiates the match.
   */
  private async openBatch(batch: PendingOpen[]): Promise<void> {
    let results: OpenResult[];
    const done = emark("bulkopen", `openBatch n=${batch.length}`);
    // Always-on visibility into each queued PTB sign (inspect how many opens collapse into ONE tx).
    console.log(
      `🧾 [PTB sign] bulk-open · ${batch.length} open(s) → ONE sponsored PTB`,
      batch.map((p) => ({
        game: p.params.label,
        stake: String(p.params.amount),
        partyA: p.params.partyA.address,
        partyB: p.params.partyB.address,
        intentId: p.intentId,
      })),
    );
    try {
      results = await this.batchOpen(batch.map((p) => p.params));
      done();
      this.signedPtbs += 1;
      this.openedIntents += batch.length;
      console.log(
        `✅ [PTB sign] bulk-open OK · PTB #${this.signedPtbs} · ${results.length} tunnel(s) · ${this.openedIntents} opens across ${this.signedPtbs} PTB(s)`,
        results.map((r) => r.tunnelId),
      );
      elog("bulkopen", "PTB signed via Enoki", {
        ptb: this.signedPtbs,
        intentsThisPtb: batch.length,
        intentsTotal: this.openedIntents,
      });
    } catch (err) {
      if (err instanceof BatchCommittedError) {
        console.error(
          "[bulkOpenJob] batch committed but correlation failed — not retrying",
          err,
        );
      }
      for (const p of batch) p.reject(err);
      return;
    }
    if (results.length !== batch.length) {
      // A correct opener returns one ordered id per intent; a mismatch means the post-commit demux
      // is inconsistent. The PTB committed, so reject all (never retry) rather than mis-route ids.
      const err = new BatchCommittedError(
        "unknown",
        new Error(
          `bulkOpenJob: opener returned ${results.length} results for ${batch.length} intents`,
        ),
      );
      console.error(
        "[bulkOpenJob] result/intent count mismatch — not retrying",
        err,
      );
      for (const p of batch) p.reject(err);
      return;
    }
    batch.forEach((p, i) => p.resolve(results[i]));
  }
}

/** Shard key: the PTB sender. A PvP seat-A open's party-A address IS the user's wallet
 *  (pvpMatchHook), which signs/sends the open — normalize it so padding differences don't split
 *  one sender into two shards. */
function senderOf(params: OpenTunnelParams): string {
  return normalizeSuiAddress(params.partyA.address);
}
