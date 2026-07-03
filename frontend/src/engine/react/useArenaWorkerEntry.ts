/**
 * Bridges the main-thread arena store (ADR-0028) to the worker PvP hub. The on-connect orchestrator
 * (`ArenaAutoEnter`) allocates a fleet bot per open game + deposits seat A in one batched PTB, then
 * publishes each game's `{allocation, keypair}` to the arena store. In LEGACY mode each game's hook
 * consumes that entry and `enterArenaMatch`es on the main thread; in WORKER mode this hook does the
 * same, but hands the allocation (pre-opened tunnel + the main-minted ephemeral SECRET) to the worker
 * hub via {@link engineClient.enterArenaMatch}, which joins + plays over the live tunnel. The secret
 * crosses to the worker because the key was necessarily minted on main (its pubkey is baked into the
 * tunnel at allocate); the worker owns it thereafter and co-signs there.
 *
 * One-shot per entry via `enteredRef` + `clearArenaEntry` (inside `consumeArenaEntry`), so a window
 * remount can't re-enter a now-closed match — the same invariant every legacy auto-enter effect runs.
 */
import { useEffect, useRef } from "react";
import { toHex } from "sui-tunnel-ts/core/bytes";
import {
  consumeArenaEntry,
  subscribeArena,
} from "@/onchain/arenaAllocationStore";
import { engineClient } from "../engineClient";
import type { WorkerArenaEntry } from "../engineApi";

export function useArenaWorkerEntry(opts: {
  windowId: string;
  /** Registry game id → `getSpec` in the worker (e.g. "tictactoe", "bomb-it"). */
  gameId: string;
  /** Arena/backend game id → the store key (e.g. "tictactoe", "bomb_it"). */
  arenaGameId: string;
  /** Enter only from idle (the hook owns its own readiness; read live). */
  isIdle: () => boolean;
  /** Optional `makeProtocol`/`initSetup` payload (ttt/caro board size + game cap). */
  setup?: unknown;
}): void {
  const { windowId, gameId, arenaGameId } = opts;
  const enteredRef = useRef(false);
  // Read live so the effect can stay mounted while the caller's idle check + setup change per render.
  const isIdleRef = useRef(opts.isIdle);
  isIdleRef.current = opts.isIdle;
  const setupRef = useRef(opts.setup);
  setupRef.current = opts.setup;

  useEffect(() => {
    const tryEnter = (): void =>
      consumeArenaEntry(
        arenaGameId,
        enteredRef,
        () => isIdleRef.current(),
        (allocation, keypair) => {
          const entry: WorkerArenaEntry = {
            matchId: allocation.matchId,
            tunnelId: allocation.tunnelId,
            ephemeralSecretHex: toHex(keypair.secretKey),
            botPubkeyHex: allocation.botEphPubkey,
            botAddress: allocation.botAddress,
            stakeEach: String(allocation.stakeEach),
            setup: setupRef.current,
          };
          engineClient.enterArenaMatch(windowId, gameId, entry);
        },
      );
    tryEnter(); // the entry may already be in the store (published before this window mounted)
    return subscribeArena(tryEnter);
  }, [windowId, gameId, arenaGameId]);
}
