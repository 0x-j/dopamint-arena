/**
 * Generic worker-engine controller for public-state games (no hidden secret, JSON moves over
 * the identity codec). It IS the de-dup of `pvp/pvpMatchHook.ts`'s `maybePropose`/`proposePlan`
 * driver + the per-seat intent→move mapping. A public-state game becomes a tiny declaration:
 * `makePublicStateSpec({ game, stake, stepMs, makeProtocol, deriveView, idleIntent,
 * intentToMove, readIntent })` — the same fields `createPvpMatchHook` already takes.
 */
import type { Protocol } from "sui-tunnel-ts/protocol/Protocol";
import type { Role } from "@/pvp/mpClient";
import { proposePlan } from "@/pvp/proposePlan";
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { GameSessionSpec, MatchController, MatchIo } from "./engineApi";

export interface PublicStateConfig<
  State extends { winner: unknown },
  Move,
  Intent,
  View,
> {
  game: string;
  stake: bigint;
  /** Pacing between this seat's proposes (ms). */
  stepMs: number;
  makeProtocol(): Protocol<State, Move>;
  deriveView(state: State): View;
  /** This seat's input when no human intent is pending (a bot "stay"/forward default). */
  idleIntent: Intent;
  intentToMove(role: Role, intent: Intent): Move;
  readIntent(role: Role, move: Move | null): Intent | undefined;
  /** Optional value-based idle check (default: reference-equality to idleIntent). Needed when
   *  idleIntent is an object, e.g. world-canvas's empty `{ cells: [] }`. */
  isIdle?(intent: Intent): boolean;
  /** Full-state + (de)serialization + UI hydration for resume (same fn the legacy hook takes). */
  makeResumeAdapter(onReconciled: () => void): ResumeAdapter<State, Move>;
}

/** Which seat proposes at this nonce: A proposes 0→1, B 1→2, … (port of pvpMatchHook's `turn`). */
function turn(nonce: bigint): "A" | "B" {
  return nonce % 2n === 0n ? "A" : "B";
}

class PublicStateController<
  State extends { winner: unknown },
  Move,
  Intent,
  View,
> implements MatchController<State, Move, void, Intent, View> {
  private intent: Intent;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly io: MatchIo<State, Move>,
    private readonly cfg: PublicStateConfig<State, Move, Intent, View>,
  ) {
    this.intent = cfg.idleIntent;
  }

  initSetup(): void {
    /* public-state: no secret to build */
  }

  onConfirmed(): void {
    this.schedule();
  }

  setAuto(): void {
    this.schedule();
  }

  onInput(intent: Intent): void {
    this.intent = intent;
    // A human input preempts the idle clock; on the opponent's turn it stays queued.
    if (!this.io.auto()) this.schedule();
  }

  deriveView(state: State): View {
    return this.cfg.deriveView(state);
  }

  resumeAdapter(): ResumeAdapter<State, Move> {
    return this.cfg.makeResumeAdapter(() => this.io.emitView());
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private idle(i: Intent): boolean {
    return this.cfg.isIdle ? this.cfg.isIdle(i) : i === this.cfg.idleIntent;
  }

  private schedule(): void {
    const dt = this.io.tunnel();
    const role = this.io.role;
    if (!dt) return;
    const plan = proposePlan({
      myRole: role,
      turnRole: turn(dt.nonce),
      terminal: dt.protocol.isTerminal(dt.state),
      hasPending: dt.displayState !== dt.state,
      auto: this.io.auto(),
      hasInput: !this.io.auto() && !this.idle(this.intent),
      stepMs: this.cfg.stepMs,
    });
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (plan.delayMs === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const d = this.io.tunnel();
      if (!d) return;
      if (d.protocol.isTerminal(d.state)) return;
      if (turn(d.nonce) !== role) return;
      if (d.displayState !== d.state) return; // a proposal is mid-flight
      let intent: Intent;
      if (this.io.auto()) {
        const botMove =
          d.protocol.randomMove?.(d.state, role, Math.random) ?? null;
        intent = this.cfg.readIntent(role, botMove) ?? this.cfg.idleIntent;
      } else {
        intent = this.intent;
        this.intent = this.cfg.idleIntent;
      }
      try {
        d.propose(this.cfg.intentToMove(role, intent), 0n);
        this.io.emitView();
      } catch {
        /* proposal already pending or transient — safe to ignore */
      }
    }, plan.delayMs);
  }
}

export function makePublicStateSpec<
  State extends { winner: unknown },
  Move,
  Intent,
  View,
>(
  cfg: PublicStateConfig<State, Move, Intent, View>,
): GameSessionSpec<State, Move, void, Intent, View> {
  return {
    game: cfg.game,
    stake: cfg.stake,
    stepMs: cfg.stepMs,
    makeProtocol: cfg.makeProtocol,
    createMatch: (io) => new PublicStateController(io, cfg),
  };
}

/**
 * Config for a public-state game that ALSO owns session-local batching state (world-canvas's
 * paint buffer + per-seat `seq` stamping + confirmed-seq trim). The three knobs below are named
 * by design §3.1; their exact shapes are provisional until the helper is implemented.
 */
export interface BatchedPublicStateConfig<
  State extends { winner: unknown },
  Move,
  Intent,
  View,
> extends PublicStateConfig<State, Move, Intent, View> {
  /** Max cells coalesced into one proposed batch (world-canvas `MAX_BATCH_CELLS`). */
  maxBatch: number;
  /** Stamp this seat's next monotonic per-seat `seq` onto a queued intent before it proposes. */
  stampSeq(intent: Intent, nextSeq: number): Intent;
  /** This seat's confirmed-seq high-water read from the view; cells at/below it are folded. */
  trimConfirmed(view: View, role: Role): number;
}

/**
 * TODO(design §3.1/§13): lift world-canvas's session-local paint buffer / per-seat `seq`
 * stamping / confirmed-seq trim (today ~150 lines in usePvpWorldCanvas.ts:141-192, still on
 * main even under the flag) INTO the worker, paired with a new `MatchController.reconcile(view)`
 * hook. Typed-signature stub only — not wired into any spec yet; implementing it requires the
 * `reconcile` hook on the controller contract first.
 */
export function makeBatchedPublicStateSpec<
  State extends { winner: unknown },
  Move,
  Intent,
  View,
>(
  cfg: BatchedPublicStateConfig<State, Move, Intent, View>,
): GameSessionSpec<State, Move, void, Intent, View> {
  void cfg;
  throw new Error(
    "makeBatchedPublicStateSpec: not implemented (design §3.1/§13) — needs MatchController.reconcile",
  );
}
