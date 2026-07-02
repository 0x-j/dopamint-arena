/**
 * Flash resume adapter. Flash has NO hidden per-seat secret (the whole state is the co-signed
 * rolling digest + balances), so — unlike battleship — there is no `captureSecret`/`restoreSecret`;
 * `serializeState` covers the full state. `FlashMove` is a plain string (JSON-native), so the move
 * (de)serialization defaults to identity. The visible chat transcript is NOT part of the protocol
 * state (the digest is a fold, not the text) and is persisted separately — see `flashMessageStore`.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { FlashState, FlashMove } from "sui-tunnel-ts/protocol/flash";

export function makeFlashResumeAdapter(args: {
  onReconciled?: ResumeAdapter<FlashState, FlashMove>["onReconciled"];
}): ResumeAdapter<FlashState, FlashMove> {
  return {
    // bigints → decimal strings and the digest Uint8Array → a number array so the record is
    // JSON-safe for localStorage; `deserializeState` is the exact inverse.
    serializeState: (s) =>
      ({
        transcriptDigest: Array.from(s.transcriptDigest),
        messageCount: s.messageCount.toString(),
        lastSender: s.lastSender,
        balanceA: s.balanceA.toString(),
        balanceB: s.balanceB.toString(),
        total: s.total.toString(),
      }) as unknown as never,
    deserializeState: (j) => {
      const o = j as Record<string, unknown>;
      return {
        transcriptDigest: Uint8Array.from(o.transcriptDigest as number[]),
        messageCount: BigInt(o.messageCount as string),
        lastSender: (o.lastSender as FlashState["lastSender"]) ?? null,
        balanceA: BigInt(o.balanceA as string),
        balanceB: BigInt(o.balanceB as string),
        total: BigInt(o.total as string),
      } satisfies FlashState;
    },
    onReconciled: args.onReconciled ?? (() => {}),
  };
}
