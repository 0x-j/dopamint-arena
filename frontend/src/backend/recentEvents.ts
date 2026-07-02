import type { TunnelEvent } from "./controlPlane";
import type { TxnRow } from "../panels/types";

/** Stable non-negative int from the tx digest, for React keys (djb2). */
function digestId(digest: string): number {
  let h = 5381;
  for (let i = 0; i < digest.length; i++)
    h = ((h << 5) + h + digest.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Project backend lifecycle events to on-chain feed rows, attributed to the viewer.
 * `mine` marks rows the connected wallet owns — a party, or the funder in self-play (where both
 * parties are ephemerals). On a `mine` row `address` is the viewer's OWN wallet, so they can
 * click through to their account page and confirm their involvement; otherwise it is the tunnel's
 * party. `undefined` (→ `—`) when ownership was never captured. `game` (null → "") lights up the
 * per-game tabs. The pot/amount is intentionally dropped: a live row says "this is your tunnel,"
 * not "you won X" (My-Activity keeps per-move amounts).
 */
export function recentEventsToTxnRows(
  events: TunnelEvent[],
  viewer?: string | null,
): TxnRow[] {
  // Sui addresses are canonical lowercase hex from both the RPC event decode and dapp-kit, but
  // compare case-insensitively so a stray casing/format difference can't silently drop the highlight.
  const v = viewer?.toLowerCase() ?? null;
  return events.map((e) => {
    const mine =
      !!v &&
      (e.partyA?.toLowerCase() === v ||
        e.partyB?.toLowerCase() === v ||
        e.funder?.toLowerCase() === v);
    const address = mine
      ? (viewer ?? undefined)
      : (e.partyA ?? e.partyB ?? e.funder ?? undefined);
    return {
      id: digestId(e.txDigest),
      game: e.game ?? "",
      digest: e.txDigest,
      address,
      mine,
      proofUrl: e.proofUrl ?? undefined,
      timestampMs: e.timestampMs,
      time: new Date(e.timestampMs).toLocaleTimeString("en-GB"),
      bot: "",
      type: e.kind === "settled" ? "Settled" : "Opened",
      status: "Success",
      amount: "",
    };
  });
}
