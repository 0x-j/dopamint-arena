/**
 * Builds the per-user `MainBridge` (chain ops only — resume persistence is worker-owned, §5/§6)
 * from dapp-kit hooks and hands it to `engineClient` once the wallet is known. Use the
 * `useConfigureEngine` hook directly inside
 * a worker-path game hook, or mount `<EngineProvider>` above such windows. Renders no DOM.
 */
import { useEffect, type ReactNode } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { resolveBackendUrl } from "@/backend/controlPlane";
import { resolveMpWsUrl } from "@/pvp/mpClient";
import { configureEngine } from "../engineClient";
import { makeChainBridge } from "../bridge/chainBridge";

/** Configure the engine bridge once the wallet is ready (idempotent across renders). */
export function useConfigureEngine(): void {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();

  useEffect(() => {
    if (!account) return;
    const signExec = (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never;
    const chain = makeChainBridge({
      reads: client as never,
      signExec,
      sponsoredSignExec: sponsored.signExec as never,
      selectStakeCoin: sponsored.selectStakeCoin,
      prepareStake: sponsored.prepareStake,
      ensureStakeBalance: sponsored.ensureStakeBalance,
    });
    // Resolve the relay WS URL HERE (main), not in the worker: a worker's self.location is the
    // worker-script URL, so a same-origin fallback there points at the wrong origin (design §1).
    const backendUrl = resolveBackendUrl();
    configureEngine(
      {
        backendUrl,
        mpWsUrl: resolveMpWsUrl(backendUrl),
        wallet: account.address,
      },
      chain,
    );
  }, [account?.address, client, signAndExecute, sponsored]);
}

export function EngineProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  useConfigureEngine();
  return children;
}
