// Centralized batched arena entry (ADR-0028, the "one PTB → games explode" flow, PR #95 pattern).
// Mounted ONCE inside the wallet provider (renders nothing). On wallet connect it reserves a fleet bot
// and deposits seat A for each arena game whose window is OPEN (per the persisted desktop layout) in a
// SINGLE batched PTB (the shared `TunnelOpenBatcher` coalesces them — one wallet popup), then publishes
// each {allocation, keypair} to the arena store. Each game window's PvP hook reads its entry and
// auto-`enterArenaMatch`es — so the open floor comes alive from one signature, no per-game "Play" click.
// Scoping to open windows avoids funding tunnels + reserving bots for games the user isn't showing.
import { useEffect, useRef } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { list, arenaGameIdForModule } from "@/games/registry";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { configureSharedBatcher } from "@/onchain/sharedTunnelOpenBatcher";
import { enterArena, type MakeUserParty } from "@/onchain/arenaEnter";
import { setArenaEntry } from "@/onchain/arenaAllocationStore";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { resolveBackendUrl } from "@/backend/controlPlane";
import { listActiveTunnels, readResumeRecord } from "@/pvp/resume";
import {
  arenaIdsExcludingResuming,
  resumingGameKeysOf,
} from "@/onchain/arenaAllocationSkip";
import type { PartyOnchain } from "@/onchain/tunnelTx";

/** localStorage key the desktop persists its window layout under (`Desktop.tsx`). */
const LAYOUT_KEY = "mtps.desktop.layouts.v1";

/** Module ids that currently have an open window, read from the persisted desktop layout. Instance
 *  ids (`module#uuid`, for duplicate windows) are stripped to the base module id. Empty ⇒ unknown
 *  (e.g. a brand-new load before the desktop persisted) → the caller falls back to all arena games so
 *  the floor still comes alive. Defensive: any parse error ⇒ empty (treated as unknown). */
function openModuleIds(): Set<string> {
  try {
    if (typeof localStorage === "undefined") return new Set();
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return new Set();
    const layouts = JSON.parse(raw) as Record<string, Array<{ id?: unknown }>>;
    const ids = new Set<string>();
    for (const items of Object.values(layouts)) {
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        if (typeof it?.id === "string") ids.add(it.id.split("#")[0]);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

/** Arena ids to deposit at connect: the DEFAULT (first) arena id of each arena-wired module whose
 *  window is open (per the persisted layout) — so we only fund games the user is actually showing,
 *  not all 8. A multi-protocol module (tic-tac-toe + caro) lists its default variant FIRST (caro), so
 *  only that one is funded, not both. When the open set is unknown (empty localStorage) we fall back
 *  to every arena module's default, so a fresh desktop still comes alive. */
function arenaGameIdsForOpenWindows(): string[] {
  const open = openModuleIds();
  const ids: string[] = [];
  for (const m of list()) {
    if (open.size > 0 && !open.has(m.id)) continue; // scope to open windows once we know them
    const arenaId = arenaGameIdForModule(m.id);
    if (arenaId) ids.push(arenaId);
  }
  // Skip any game the resume flow will restore: on a reload each open window's PvP hook resumes its
  // persisted IN-FLIGHT tunnel, so re-allocating (and depositing a fresh stake into) a second tunnel
  // for the same game would strand that stake in an abandoned match. A FINISHED (terminal) record is
  // excluded from this suppression so a settle+reload allocates a new game instead of stalling on the
  // settled board — resume clears that record, but this read has no protocol to judge terminality, so
  // it trusts the record's stamped flag (keeping allocate and resume consistent order-independently).
  const resumingGameKeys = resumingGameKeysOf(
    listActiveTunnels().map((id) => readResumeRecord(id)),
  );
  return arenaIdsExcludingResuming(ids, resumingGameKeys);
}

export function useArenaAutoEnter(): void {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();
  const owner = account?.address;
  // One batched entry per connected wallet; guard StrictMode/autoConnect double-fire (→ double deposit).
  const entered = useRef<string | null>(null);

  useEffect(() => {
    if (!owner) return;

    const signExec = async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    };
    // Configure the process-wide batcher with this wallet's signer/sponsor UNCONDITIONALLY on connect —
    // BEFORE the open-games guard below. `enterArena`'s default `open` (requestTunnelOpen) coalesces
    // seat-A deposits into ONE PTB (PR #95); the add-a-game lazy path (`requestArenaGame`) rides the
    // same batcher, so it must be configured even when NO arena window was open at connect — else that
    // later deposit flushes with null deps and silently fails.
    configureSharedBatcher({
      reads: client as never,
      sponsoredSignExec: sponsored.signExec,
      signExec: signExec as never,
      prepareStake: sponsored.prepareStake,
      selectStakeCoin: sponsored.selectStakeCoin,
      ensureStakeBalance: sponsored.ensureStakeBalance,
    });

    const games = arenaGameIdsForOpenWindows();
    if (games.length === 0) return;
    if (entered.current === owner) return;
    entered.current = owner;

    // One ephemeral key per game; its pubkey is baked into the tunnel at allocate and the SAME key
    // co-signs moves later (via the store → enterArenaMatch), so stash the full keypair as it's minted.
    const keypairs = new Map<string, KeyPair>();
    const makeUserParty: MakeUserParty = async (game: string) => {
      const eph = generateKeyPair();
      keypairs.set(game, eph);
      const party: PartyOnchain = { address: owner, publicKey: eph.publicKey };
      return party;
    };

    void (async () => {
      try {
        const allocations = await enterArena({
          games,
          userAddress: owner,
          makeUserParty,
          coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
          apiBase: resolveBackendUrl(),
        });
        for (const allocation of allocations) {
          const keypair = keypairs.get(allocation.game);
          if (keypair) setArenaEntry(allocation.game, { allocation, keypair });
        }
      } catch (e) {
        // A failed batch (no free bot, deposit rejected) leaves the store empty — games just show
        // their normal lobby. Re-arm so the user can retry on reconnect.
        console.warn("[arena] batched entry failed", e);
        entered.current = null;
      }
    })();
  }, [owner, client, signAndExecute, sponsored]);
}

/** App-wide mount for the centralized batched arena entry. Render ONCE inside the wallet provider. */
export function ArenaAutoEnter(): null {
  useArenaAutoEnter();
  return null;
}
