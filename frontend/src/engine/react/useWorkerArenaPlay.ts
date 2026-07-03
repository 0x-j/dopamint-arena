/**
 * Worker-path on-demand `playArena` (ADR-0028): the manual "Play" trigger that reserves a fleet bot +
 * pre-created tunnel, deposits seat A in one popup, and joins it IN THE WORKER via
 * {@link engineClient.enterArenaMatch}. Same allocate→join→play flow the connect-time auto-enter
 * ({@link useArenaWorkerEntry}) runs, but user-triggered — the worker mirror of the legacy hooks'
 * {@link runArenaPlay}, routing the resulting allocation to the worker engine instead of a main-thread
 * tunnel. The returned fn accepts an optional per-call setup (e.g. battleship's placements).
 */
import { useCallback } from "react";
import { toHex } from "sui-tunnel-ts/core/bytes";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { runArenaPlay } from "@/onchain/arenaPlay";
import type { StakeStrategy } from "@/onchain/stakeTunnel";
import { engineClient } from "../engineClient";
import type { WorkerArenaEntry } from "../engineApi";

export function useWorkerArenaPlay(opts: {
  windowId: string;
  /** Registry game id → `getSpec` in the worker (e.g. "blackjack", "quantum-poker"). */
  gameId: string;
  /** Arena/backend game id (underscore, e.g. "quantum_poker"). */
  arenaGameId: string;
  /** Deposit label for logs/telemetry. */
  label: string;
  /** Back-compat fallback stake; the deposit prefers the allocation's `stakeEach`. */
  stakePerGame?: bigint;
  /** Default `makeProtocol`/`initSetup` payload; a per-call override (battleship placements) wins. */
  setup?: unknown;
}): (setupOverride?: unknown) => void {
  const account = useCurrentAccount();
  const sponsored = useSponsoredSignExec();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const { windowId, gameId, arenaGameId, label, stakePerGame, setup } = opts;

  return useCallback(
    (setupOverride?: unknown) => {
      const wallet = account?.address;
      if (!wallet) return; // not connected yet — the lobby stays put
      const signExec = async (
        tx: Parameters<typeof signAndExecute>[0]["transaction"],
      ) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      };
      const stake: StakeStrategy = {
        sponsoredSignExec: sponsored.signExec,
        walletSignExec: signExec as never,
        prepareStake: sponsored.prepareStake,
        selectStakeCoin: sponsored.selectStakeCoin,
        ensureStakeBalance: sponsored.ensureStakeBalance,
      };
      void runArenaPlay({
        arenaGameId,
        wallet,
        stake,
        label,
        stakePerGame,
        setBusy: () => {},
        setError: () => {},
        onCaught: (e) =>
          console.warn(`[arena] worker play failed for ${arenaGameId}`, e),
        enter: (allocation, keypair) => {
          const entry: WorkerArenaEntry = {
            matchId: allocation.matchId,
            tunnelId: allocation.tunnelId,
            ephemeralSecretHex: toHex(keypair.secretKey),
            botPubkeyHex: allocation.botEphPubkey,
            botAddress: allocation.botAddress,
            stakeEach: String(allocation.stakeEach),
            setup: setupOverride ?? setup,
          };
          engineClient.enterArenaMatch(windowId, gameId, entry);
        },
      });
    },
    [
      account,
      sponsored,
      signAndExecute,
      windowId,
      gameId,
      arenaGameId,
      label,
      stakePerGame,
      setup,
    ],
  );
}
