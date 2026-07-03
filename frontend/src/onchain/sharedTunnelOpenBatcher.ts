// One process-wide batcher so every game window's open coalesces into a single flush. The wallet
// deps change as the account connects, so the singleton reads them lazily from a module ref that
// the arena / session hooks refresh each render.
import {
  TunnelOpenBatcher,
  type BatcherDeps,
  type TunnelOpenRequest,
} from "./tunnelOpenBatcher";

let currentDeps: BatcherDeps | null = null;
// Coalescing window. The worker/arena opens arrive spread over ~1-2s — each game window reaches the
// chain bridge to call `requestTunnelOpen` independently — so the 30ms default flushed each ALONE
// (`openSingle`), firing a separate sponsored tx per game that then equivocates on the shared gas
// object. A wider window lets those spread opens still coalesce into ONE `openAndFundMany` PTB (one
// sponsored tx). Startup cost: a window shows "funding" up to this long before its (coalesced) open
// lands — fine for the arena floor.
const OPEN_COALESCE_MS = 2000;
const batcher = new TunnelOpenBatcher(() => currentDeps, {
  flushDelayMs: OPEN_COALESCE_MS,
});

/** Refresh the wallet-bound deps the next flush will use. Call each render with the latest signer. */
export function configureSharedBatcher(deps: BatcherDeps | null): void {
  currentDeps = deps;
}

/** Enroll a tunnel open in the shared coalescing flush. */
export function requestTunnelOpen(req: TunnelOpenRequest): Promise<string> {
  return batcher.request(req);
}
