import type {
  BlackjackState,
  BlackjackSlotSecret,
} from "sui-tunnel-ts/protocol/blackjack";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

/**
 * Adopt-proof store for this seat's per-draw commit secret — the blackjack analogue of the poker
 * driver's secret cache.
 *
 * Blackjack mints a fresh secret per card draw and keeps it ONLY in `state.localSecret{A,B}`; the
 * reveal reads it back from there, and the resume-record persist reads it too. But a resync
 * `adoptCheckpoint` swaps in the peer's PUBLIC state, wiping that field — so after a reconnect the
 * seat can't reveal the in-flight draw and the record persists a null secret (the "opponent's turn"
 * stall). This holds the secret the seat minted, keyed by the draw, so it can be re-anchored into
 * state before a reveal and read by the persist — surviving the adopt. Keyed by `(round, drawCount)`
 * so a stale secret from a previous draw is never reused.
 */
export class BlackjackSecretStore {
  private held: { key: string; secret: BlackjackSlotSecret } | null = null;

  constructor(private readonly party: Party) {}

  private static key(s: BlackjackState): string {
    return `${s.round}:${s.drawCount}`;
  }

  /** Remember the secret this seat just committed for the current draw. */
  remember(s: BlackjackState, secret: BlackjackSlotSecret): void {
    this.held = { key: BlackjackSecretStore.key(s), secret };
  }

  /** This seat's secret for the current draw: state if present (warming the store so a later adopt
   *  can't lose it — e.g. a cold-load-restored secret), else the held copy (adopt-proof). */
  own(s: BlackjackState): BlackjackSlotSecret | null {
    const inState = this.party === "A" ? s.localSecretA : s.localSecretB;
    if (inState) {
      this.held = { key: BlackjackSecretStore.key(s), secret: inState };
      return inState;
    }
    return this.held && this.held.key === BlackjackSecretStore.key(s)
      ? this.held.secret
      : null;
  }

  /** Re-anchor the held secret into state so `randomMove`'s reveal reads it after an adopt. */
  anchorInto(s: BlackjackState): void {
    const own = this.own(s);
    if (!own) return;
    if (this.party === "A") s.localSecretA = own;
    else s.localSecretB = own;
  }
}
