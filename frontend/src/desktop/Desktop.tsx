import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronDown, Eye, Plus, X } from "lucide-react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import "../games"; // register all game modules (side-effect import)
import { get, listByWorkspace, arenaGameIdForModule } from "../games/registry";
import type { GameModule, Workspace } from "../games/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { type GridItem } from "@/components/ui/grid-layout";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { disposeWindow } from "@/lib/windowSessions";
import { flyFromDock, flyToDock } from "@/lib/dockFlight";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { requestArenaGame } from "@/onchain/arenaLazyEntry";
import { LiveTransactionsFeed } from "../panels/LiveTransactionsFeed";
import { LocalTransactionsFeed } from "../panels/LocalTransactionsFeed";
import { NetworkPulse } from "../panels/NetworkPulse";
import { GameWindow } from "./GameWindow";
import { GameContent } from "./GameContent";
import { FrozenContext } from "./frozenContext";
import {
  classifyWalletTransition,
  collectGameWindowIds,
} from "./freezeOnDisconnect";
import { GameTpsBadge } from "./GameTpsBadge";
import {
  OverviewFloor,
  type OverviewColumn,
  type OverviewItem,
} from "./OverviewFloor";
import { OverviewDashboard, type OverviewGroupInfo } from "./OverviewDashboard";
import { WorkspaceFloor } from "./WorkspaceFloor";
import { MobileFloor } from "./MobileFloor";
import { MobileAddSheet } from "./MobileAddSheet";
import { AddAppDialog } from "./AddAppDialog";
import { WorkspaceTabs } from "./WorkspaceTabs";
import type { MobileSection } from "./AppShell";
import {
  TILE,
  clampNum,
  dropKey,
  gameOf,
  newInstanceId,
  tile,
  type FloatState,
} from "./floorGrid";
import { maxLiveWindows } from "@/engine/deviceTier";

type DockSide = "bottom" | "right";

/** One entry per open/hidden window instance. */
type LayerEntry = {
  instanceId: string;
  label: string;
  icon: string;
  image: string;
  hidden: boolean;
};

/** The "All" view's groups, in display order: payments lead (top-left of the desktop dashboard),
 *  then games, then chat. Also the phone All column order and the floor-tools target order. */
const OVERVIEW_GROUPS: { ws: Workspace; label: string }[] = [
  { ws: "payment", label: "Payment" },
  { ws: "games", label: "Game" },
  { ws: "chat", label: "Chat" },
];

// The default floor (a fresh load, or after Reset). Each workspace is its own window floor, so
// switching never disturbs another's windows. Rather than opening EVERY module (which could blow a
// weak device's budget), the seed is curated and sized to the device's live-window cap (deviceTier:
// Basic 4 / Standard 8 / High-end 16 / Max 20): games open in the priority order below; payment +
// chat are each guaranteed a minimum (2 once the cap is over 6, else 1), reserved BEFORE games so
// every category is represented. Chat has a single app, so a 2nd chat seeds a duplicate window.
const SEED_GAMES = [
  "blackjack",
  "quantum-poker",
  "battleship",
  "tic-tac-toe",
  "chicken-cross",
  "bomb-it",
  "world-canvas",
];
const SEED_PAYMENT = [
  "regular-payments",
  "streaming-payment",
  "agent-allowance",
  "api-credits",
];
const SEED_CHAT = ["chat"];

/** Tile a list of gameIds into seed windows; a repeated gameId gets a fresh instance id so one game
 *  can seed more than one window (e.g. a 2nd chat). Unknown ids are dropped. */
function seedItems(gameIds: string[]): GridItem[] {
  const seen = new Set<string>();
  return tile(
    gameIds
      .filter((id) => get(id))
      .map((gid) => {
        const id = seen.has(gid) ? newInstanceId(gid) : gid;
        seen.add(gid);
        return { id, x: 0, y: 0, ...TILE };
      }),
  );
}

/** `count` gameIds from `priority`, padding with the primary (first) app when there are fewer
 *  distinct apps than requested — lets a single-app category (chat) still reach its minimum. */
function pickSeed(priority: string[], count: number): string[] {
  const valid = priority.filter((id) => get(id));
  if (count <= 0 || valid.length === 0) return [];
  return Array.from({ length: count }, (_, i) => valid[i] ?? valid[0]);
}

/** The curated, cap-aware default seed for all three floors. */
function curatedSeed(): Record<Workspace, GridItem[]> {
  const cap = maxLiveWindows();
  const perCategoryMin = cap > 6 ? 2 : 1; // payment & chat guaranteed minimum
  const payment = pickSeed(SEED_PAYMENT, perCategoryMin);
  const chat = pickSeed(SEED_CHAT, perCategoryMin);
  // Games fill whatever the cap leaves after reserving payment + chat — distinct only (no padding),
  // capped to the priority list.
  const gamesBudget = Math.max(0, cap - payment.length - chat.length);
  const games = SEED_GAMES.filter((id) => get(id)).slice(0, gamesBudget);
  return {
    games: seedItems(games),
    payment: seedItems(payment),
    chat: seedItems(chat),
  };
}

function seedLayoutFor(workspace: Workspace): GridItem[] {
  return curatedSeed()[workspace];
}
function seedLayouts(): Record<Workspace, GridItem[]> {
  return curatedSeed();
}
function emptyHidden(): Record<Workspace, Record<string, GridItem>> {
  return { games: {}, payment: {}, chat: {} };
}
function emptyFloating(): Record<Workspace, Record<string, FloatState>> {
  return { games: {}, payment: {}, chat: {} };
}

/**
 * Telemetry dock. `bottom` lays the panels out as a resizable horizontal strip;
 * `right` stacks them vertically as a scrolling rail.
 */
function Dock({ side }: { side: DockSide }) {
  // Subscribe to telemetry HERE, not in ArenaView, so a snapshot tick re-renders only
  // the dock — the game floor (a sibling panel) doesn't read the snapshot and stays put.
  const { snapshot } = useTelemetry();
  if (side === "right") {
    return (
      <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
        <NetworkPulse snapshot={snapshot} className="shrink-0" />
        <LiveTransactionsFeed snapshot={snapshot} className="min-h-72 flex-1" />
        <LocalTransactionsFeed
          snapshot={snapshot}
          className="min-h-72 flex-1"
        />
      </div>
    );
  }
  // Invisible (transparent) handles read as gaps; col-resize cursor is the cue.
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full p-2">
      <ResizablePanel defaultSize="32%" minSize="15%" className="min-w-0">
        {/* ONE merged panel (hero+chart | stats) so the default LOW dock shows everything
            without the old stacked-column scroll. */}
        <NetworkPulse snapshot={snapshot} className="h-full" />
      </ResizablePanel>
      <ResizableHandle className="w-2 bg-transparent transition-colors hover:bg-border" />
      <ResizablePanel defaultSize="34%" minSize="16%" className="min-w-0">
        <LiveTransactionsFeed snapshot={snapshot} className="h-full" />
      </ResizablePanel>
      <ResizableHandle className="w-2 bg-transparent transition-colors hover:bg-border" />
      <ResizablePanel defaultSize="34%" minSize="16%" className="min-w-0">
        <LocalTransactionsFeed snapshot={snapshot} className="h-full" />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/**
 * A macOS-style dock holding minimized windows; click restores, right-click
 * opens show/close, icons magnify on hover. It hugs whichever floor edge is free
 * of the telemetry dock — the right edge, or the bottom when the dock is on the
 * right.
 */
function MacDock({
  entries,
  side,
  onShow,
  onClose,
}: {
  entries: LayerEntry[];
  side: "right" | "bottom";
  onShow: (id: string) => void;
  onClose: (id: string) => void;
}) {
  if (entries.length === 0) return null;
  const vertical = side === "right";
  return (
    <div
      data-mac-dock
      className={cn(
        "absolute z-30 flex gap-2 rounded-2xl border border-border bg-card/80 p-2 shadow-lg backdrop-blur",
        vertical
          ? "top-1/2 right-2 max-h-[80%] -translate-y-1/2 flex-col"
          : "bottom-2 left-1/2 max-w-[90%] -translate-x-1/2 flex-row",
      )}
    >
      {entries.map((e) => (
        <ContextMenu key={e.instanceId}>
          <Tooltip>
            <TooltipTrigger asChild>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  data-dock-item={e.instanceId}
                  onClick={() => onShow(e.instanceId)}
                  aria-label={`Restore ${e.label}`}
                  className={cn(
                    "grid size-11 shrink-0 animate-in place-items-center overflow-hidden rounded-xl border border-border bg-secondary text-xl shadow-sm transition-transform duration-150 ease-out zoom-in-50 hover:scale-125",
                    vertical
                      ? "origin-right hover:-translate-x-1"
                      : "origin-bottom hover:-translate-y-1",
                  )}
                >
                  {e.image ? (
                    <img
                      src={e.image}
                      alt=""
                      aria-hidden
                      draggable={false}
                      className="size-full object-cover"
                    />
                  ) : (
                    <span aria-hidden>{e.icon}</span>
                  )}
                </button>
              </ContextMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side={vertical ? "left" : "top"}>
              {e.label}
            </TooltipContent>
          </Tooltip>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onShow(e.instanceId)}>
              <Eye /> Show
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onClick={() => onClose(e.instanceId)}
            >
              <X /> Close
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}

/** Phone "Live" section: stats + activity merged into one scroll (desktop keeps these
 *  in the persistent bottom dock). Owns its telemetry subscription so a snapshot tick
 *  re-renders only this panel, never the arena floor. */
function MobileLive() {
  const { snapshot } = useTelemetry();
  return (
    <div className="flex flex-col gap-2 p-2">
      <NetworkPulse snapshot={snapshot} />
      <LiveTransactionsFeed snapshot={snapshot} className="min-h-96" />
      <LocalTransactionsFeed snapshot={snapshot} className="min-h-96" />
    </div>
  );
}

/**
 * The arena body (`/`): a draggable/resizable floor of self-playing game windows
 * over a resizable, collapsible telemetry dock (bottom or right). Maximizing pops
 * a window out into a free-floating layer. On phones it renders one section at a
 * time (`section` search param, driven by the shell's bottom tabs). The navbar and
 * tab bar live in AppShell so this view swaps without remounting the chrome.
 */
export function ArenaView() {
  // The connected wallet — adding a game window mid-session funds its arena seat for THIS owner (the
  // connect-time batch in `useArenaAutoEnter` only covered windows already open then).
  const arenaOwner = useCurrentAccount()?.address;
  // Each workspace keeps its own floor (tiled + minimized + floating windows), all held
  // here so switching workspaces — or adding a window to one you're not on — never resets
  // another. v1: per-workspace shape (replaces the old single-floor layout/hidden/floating).
  const [layouts, setLayouts] = useLocalStorageState<
    Record<Workspace, GridItem[]>
  >("mtps.desktop.layouts.v1", seedLayouts);
  const [hiddens, setHiddens] = useLocalStorageState<
    Record<Workspace, Record<string, GridItem>>
  >("mtps.desktop.hiddens.v1", emptyHidden);
  const [floatings, setFloatings] = useLocalStorageState<
    Record<Workspace, Record<string, FloatState>>
  >("mtps.desktop.floatings.v1", emptyFloating);
  const floatZ = useRef(100);
  // Freeze every game session when the wallet disconnects; thaw when it reconnects.
  // `dispose()` (via disposeWindow) closes each game's socket/tunnel but preserves
  // its localStorage resume record, so the per-window resume() effect re-attaches the
  // SAME match on reconnect; windows that can't resume fall to idle where arena
  // auto-enter starts a fresh auto-mode match. Floors are read through a ref so a mere
  // layout change never re-runs the freeze — only an address change does.
  const [frozen, setFrozen] = useState(false);
  const floorsRef = useRef({ layouts, hiddens, floatings });
  floorsRef.current = { layouts, hiddens, floatings };
  const prevOwnerRef = useRef(arenaOwner);
  useEffect(() => {
    const prev = prevOwnerRef.current;
    prevOwnerRef.current = arenaOwner;
    const transition = classifyWalletTransition(prev, arenaOwner);
    if (transition === "none") return;
    if (transition === "freeze" || transition === "switch") {
      const { layouts: l, hiddens: h, floatings: f } = floorsRef.current;
      // Scope to wallet-gated (arena) games — the same set the scrim covers — so a
      // disconnect never tears down chat/payment sessions (which have no resume path).
      for (const id of collectGameWindowIds(l, h, f))
        if (arenaGameIdForModule(gameOf(id))) disposeWindow(id);
    }
    setFrozen(transition === "freeze");
  }, [arenaOwner]);
  const [addOpen, setAddOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  // The active workspace/section is driven by the `section` search param — the desktop
  // tab bar and the phone's bottom tabs both just set it (so refresh keeps the workspace).
  const navigate = useNavigate();
  const section =
    (useSearch({ strict: false }) as { section?: MobileSection }).section ??
    "all";
  // Which floor is on screen. `live`/`explorer` aren't floors, so they fall back to games
  // (the desktop never shows them as a floor; telemetry is the persistent bottom dock).
  const floorWs: Workspace =
    section === "payment" || section === "chat" ? section : "games";
  // The active floor's slices, for the phone floor and the desktop normal floor.
  const layout = layouts[floorWs];
  const hidden = hiddens[floorWs];
  const floating = floatings[floorWs];
  // The workspaces a floor tool (arrange, add-all, reset, remove) acts on: every group
  // when the "All" floor is on screen, otherwise just the floor you're looking at.
  const toolTargets: Workspace[] =
    section === "all" ? OVERVIEW_GROUPS.map((g) => g.ws) : [floorWs];
  const [dockSide, setDockSide] = useLocalStorageState<DockSide>(
    "mtps.desktop.dockSide.v1",
    "bottom",
  );
  // The phone (< lg) renders the same per-workspace floor as the desktop — every
  // window, vertically scrolled — so the breakpoint just reskins one floor instead of
  // tearing background sessions down for a one-game picker.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  // Dock collapse — a no-drag alternative to the resize handle.
  const bottomRef = useRef<PanelImperativeHandle>(null);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);

  const toggleBottom = () => {
    const panel = bottomRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    if (collapsed) panel.expand();
    else panel.collapse();
    setBottomCollapsed(!collapsed);
  };
  const toggleDockSide = () => {
    setDockSide((s) => (s === "bottom" ? "right" : "bottom"));
    setBottomCollapsed(false);
  };
  // The minimized dock hugs whichever floor edge the telemetry dock leaves free.
  const macDockSide: "right" | "bottom" =
    dockSide === "right" ? "bottom" : "right";

  // Animate a window's ghost into the dock, then read its rect (before unmount).
  const animateMinimize = (id: string) => {
    const el = document.querySelector(`[data-window="${id}"]`);
    if (el instanceof HTMLElement) {
      flyToDock(el, get(gameOf(id))?.image ?? "", macDockSide);
    }
  };

  // Close-by-id scoped to a given workspace. Every floor — the normal one and each
  // "All" group — closes into its own stores, so all window ops key on `ws`. Kept a
  // stable identity so GameContent's memo holds (a changing closer re-mounts games).
  const closeInWorkspace = useCallback(
    (ws: Workspace, id: string) => {
      disposeWindow(id);
      setLayouts((prev) => ({
        ...prev,
        [ws]: tile(prev[ws].filter((w) => w.id !== id)),
      }));
      setHiddens((prev) => ({ ...prev, [ws]: dropKey(prev[ws], id) }));
      setFloatings((prev) => ({ ...prev, [ws]: dropKey(prev[ws], id) }));
    },
    [setLayouts, setHiddens, setFloatings],
  );
  // Stable per-workspace closers so the overview tiles' GameContent memo holds across
  // ArenaView re-renders (a changing onClose would re-mount every game each render).
  const closeGames = useCallback(
    (id: string) => closeInWorkspace("games", id),
    [closeInWorkspace],
  );
  const closePayment = useCallback(
    (id: string) => closeInWorkspace("payment", id),
    [closeInWorkspace],
  );
  const closeChat = useCallback(
    (id: string) => closeInWorkspace("chat", id),
    [closeInWorkspace],
  );
  // The active phone floor's closer, picked from the stable per-workspace closers so
  // its identity holds per floor — the mobile floor passes it straight to GameContent,
  // which memoizes on it (a churning closer would re-mount every game each render).
  const closeActiveFloor =
    floorWs === "payment"
      ? closePayment
      : floorWs === "chat"
        ? closeChat
        : closeGames;
  // The overview's groups: every workspace's open windows (tiled + minimized + floating).
  // A window lives in exactly one of the three stores, so concatenating their ids per
  // workspace lists each instance once.
  const idsFor = (ws: Workspace) => [
    ...layouts[ws].map((w) => w.id),
    ...Object.keys(hiddens[ws]),
    ...Object.values(floatings[ws]).map((f) => f.item.id),
  ];
  // The "All" floor's per-category closers, keyed by workspace. Stable (the useCallbacks above),
  // so each overview tile's GameContent memo holds across re-renders.
  const overviewClosers: Record<Workspace, (id: string) => void> = {
    games: closeGames,
    payment: closePayment,
    chat: closeChat,
  };
  // The "All" columns for the PHONE view (stacked into one scroll), each holding only its own
  // category. The desktop All view is the no-scroll OverviewDashboard below instead.
  const buildOverviewColumns = (): OverviewColumn[] =>
    OVERVIEW_GROUPS.map((g) => ({
      ws: g.ws,
      label: g.label,
      items: idsFor(g.ws).map((id) => ({ id, ws: g.ws })),
    }));
  // The desktop "All" dashboard's flat tile order — payments first (top-left), then games, then
  // chat — plus the legend's per-category links.
  const overviewItems: OverviewItem[] = OVERVIEW_GROUPS.flatMap((g) =>
    idsFor(g.ws).map((id) => ({ id, ws: g.ws })),
  );
  const overviewGroupInfos: OverviewGroupInfo[] = OVERVIEW_GROUPS.map((g) => ({
    ws: g.ws,
    label: g.label,
  }));

  // Minimize → fly into the dock, hide off the floor (keeping geometry), re-tile.
  const hideInWorkspace = (ws: Workspace, id: string) => {
    const item = layouts[ws].find((w) => w.id === id);
    if (!item) return;
    animateMinimize(id);
    setHiddens((prev) => ({ ...prev, [ws]: { ...prev[ws], [id]: item } }));
    setLayouts((prev) => ({
      ...prev,
      [ws]: tile(prev[ws].filter((w) => w.id !== id)),
    }));
  };

  // Restore from the dock → grid, flying the window back out of its dock tile.
  const showInWorkspace = (ws: Workspace, id: string) => {
    const item = hiddens[ws][id];
    if (!item) return;
    const dockEl = document.querySelector(`[data-dock-item="${id}"]`);
    const from =
      dockEl instanceof HTMLElement ? dockEl.getBoundingClientRect() : null;
    setHiddens((prev) => ({ ...prev, [ws]: dropKey(prev[ws], id) }));
    setLayouts((prev) => ({ ...prev, [ws]: tile([...prev[ws], item]) }));
    if (from) {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-window="${id}"]`);
        if (el instanceof HTMLElement) {
          flyFromDock(el, get(gameOf(id))?.image ?? "", from);
        }
      });
    }
  };

  // A newly packed window can land below the fold; scroll the floor to bring the
  // given window into view so the user sees where it ended up.
  const revealWindow = (id: string) =>
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-window="${id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );

  // Switch to a section/workspace, mirroring the tab links (all → no param, it's the default).
  const goToSection = (target: MobileSection) =>
    navigate({
      to: "/",
      search: target === "all" ? {} : { section: target },
    });

  // Add a fresh window to a given workspace's floor — duplicates allowed; that floor
  // re-tiles so the new window fills the first free slot. Targets the workspace by key,
  // so it works even when that floor isn't the one on screen.
  const addWindowTo = (workspace: Workspace, gameId: string) => {
    const id = newInstanceId(gameId);
    setLayouts((prev) => ({
      ...prev,
      [workspace]: tile([...prev[workspace], { id, x: 0, y: 0, ...TILE }]),
    }));
    // Fund this game's arena seat on the spot (idempotent per game + coalesced by the shared
    // batcher). No-op if not arena-wired or no wallet yet — in the latter case the connect-time
    // batch picks it up.
    const arenaId = arenaGameIdForModule(gameId);
    if (arenaId && arenaOwner) void requestArenaGame(arenaId, arenaOwner);
    return id;
  };

  // Open a picked app: add a window to its workspace's floor. From a single workspace we
  // switch there so you land on the new window; from the "All" floor we stay put (the
  // window appears in its group) and just scroll it into view.
  const openApp = (module: GameModule) => {
    setAddOpen(false);
    const workspace = module.workspace ?? "games";
    const id = addWindowTo(workspace, module.id);
    if (section !== "all") goToSection(workspace);
    revealWindow(id);
  };

  // One window per module not already open, across every target floor.
  const addAll = () => {
    // Compute the new windows (with instance ids) up front, so we both ADD them and FUND each by its
    // own id — funding by window id is what lets same-game duplicates each reserve their own bot.
    const additions: { ws: Workspace; id: string; moduleId: string }[] = [];
    for (const ws of toolTargets) {
      const present = new Set(layouts[ws].map((w) => gameOf(w.id)));
      for (const m of listByWorkspace(ws))
        if (!present.has(m.id))
          additions.push({ ws, id: newInstanceId(m.id), moduleId: m.id });
    }
    if (additions.length === 0) return;
    setLayouts((prev) => {
      const next = { ...prev };
      for (const ws of toolTargets) {
        const adds = additions
          .filter((a) => a.ws === ws)
          .map((a) => ({ id: a.id, x: 0, y: 0, ...TILE }));
        if (adds.length) next[ws] = tile([...prev[ws], ...adds]);
      }
      return next;
    });
    // Fund each newly-added arena game (best-effort coalesce; addAll isn't the one-popup
    // connect path).
    if (arenaOwner)
      for (const a of additions) {
        const arenaId = arenaGameIdForModule(a.moduleId);
        if (arenaId) void requestArenaGame(arenaId, arenaOwner);
      }
  };

  // Tear down every open/hidden/floating window's live session (sockets, timers) across
  // the target floors — shared by Reset-layout and Remove-all before they clear.
  const disposeAllSessions = () => {
    for (const ws of toolTargets) {
      for (const id of [
        ...layouts[ws].map((w) => w.id),
        ...Object.keys(hiddens[ws]),
        ...Object.keys(floatings[ws]),
      ]) {
        disposeWindow(id);
      }
    }
  };

  // Reset layout: re-seed each target floor's default (its modules, tidy grid).
  const confirmReset = () => {
    disposeAllSessions();
    setLayouts((prev) => {
      const next = { ...prev };
      for (const ws of toolTargets) next[ws] = seedLayoutFor(ws);
      return next;
    });
    setHiddens((prev) => {
      const next = { ...prev };
      for (const ws of toolTargets) next[ws] = {};
      return next;
    });
    setFloatings((prev) => {
      const next = { ...prev };
      for (const ws of toolTargets) next[ws] = {};
      return next;
    });
    setResetOpen(false);
  };

  // Remove all: clear each target floor to empty (no re-seed).
  const confirmRemoveAll = () => {
    disposeAllSessions();
    setLayouts((prev) => {
      const next = { ...prev };
      for (const ws of toolTargets) next[ws] = [];
      return next;
    });
    setHiddens((prev) => {
      const next = { ...prev };
      for (const ws of toolTargets) next[ws] = {};
      return next;
    });
    setFloatings((prev) => {
      const next = { ...prev };
      for (const ws of toolTargets) next[ws] = {};
      return next;
    });
    setRemoveOpen(false);
  };

  // Auto-arrange: reset every window to the uniform tile size and re-pack into a clean
  // grid across the target floors. Manual resizes are intentionally dropped — a tidy grid
  // is the point.
  const arrange = () => {
    setLayouts((prev) => {
      const next = { ...prev };
      for (const ws of toolTargets)
        next[ws] = tile(prev[ws].map((w) => ({ ...w, ...TILE })));
      return next;
    });
    // The re-packed grid anchors at the top; jump there so the tidy-up is visible.
    requestAnimationFrame(() =>
      document
        .querySelector("[data-floor]")
        ?.scrollTo({ top: 0, behavior: "smooth" }),
    );
  };

  // --- Floating (maximized) windows -------------------------------------
  const focusFloatInWorkspace = (ws: Workspace, id: string) => {
    floatZ.current += 1;
    const z = floatZ.current;
    setFloatings((prev) =>
      prev[ws][id]
        ? { ...prev, [ws]: { ...prev[ws], [id]: { ...prev[ws][id], z } } }
        : prev,
    );
  };

  // Maximize → pop the window out of the grid into the floating layer.
  const floatInWorkspace = (ws: Workspace, id: string) => {
    const item = layouts[ws].find((w) => w.id === id);
    if (!item || floatings[ws][id]) return;
    const fw = window.innerWidth * 0.7;
    const fh = window.innerHeight * 0.7;
    const n = Object.keys(floatings[ws]).length;
    floatZ.current += 1;
    const z = floatZ.current;
    setFloatings((prev) => ({
      ...prev,
      [ws]: {
        ...prev[ws],
        [id]: {
          x: clampNum(
            (window.innerWidth - fw) / 2 + n * 28,
            0,
            window.innerWidth - fw,
          ),
          y: clampNum(
            (window.innerHeight - fh) / 2 + n * 28,
            0,
            window.innerHeight - fh,
          ),
          w: fw,
          h: fh,
          z,
          item,
        },
      },
    }));
    setLayouts((prev) => ({
      ...prev,
      [ws]: tile(prev[ws].filter((w) => w.id !== id)),
    }));
  };

  // Restore a floating window back into the grid.
  const dockFloatInWorkspace = (ws: Workspace, id: string) => {
    const st = floatings[ws][id];
    if (!st) return;
    setFloatings((prev) => ({ ...prev, [ws]: dropKey(prev[ws], id) }));
    setLayouts((prev) => ({ ...prev, [ws]: tile([...prev[ws], st.item]) }));
  };

  // Minimize a floating window straight into the hidden dock (with flight).
  const minimizeFloatInWorkspace = (ws: Workspace, id: string) => {
    const st = floatings[ws][id];
    if (!st) return;
    animateMinimize(id);
    setFloatings((prev) => ({ ...prev, [ws]: dropKey(prev[ws], id) }));
    setHiddens((prev) => ({ ...prev, [ws]: { ...prev[ws], [id]: st.item } }));
  };

  const startFloatDragInWorkspace = (
    ws: Workspace,
    id: string,
    e: ReactPointerEvent,
  ) => {
    e.preventDefault();
    focusFloatInWorkspace(ws, id);
    const base = floatings[ws][id];
    if (!base) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const maxX = window.innerWidth - base.w;
    const maxY = window.innerHeight - base.h;
    // rAF-coalesce: one setState per frame, not one per pointermove (high-refresh mice
    // fire faster than the screen paints). The localStorage write is debounced in
    // useLocalStorageState, so the final rest position still persists.
    let raf = 0;
    let last: PointerEvent | null = null;
    const apply = () => {
      raf = 0;
      if (!last) return;
      const x = clampNum(base.x + last.clientX - startX, 0, maxX);
      const y = clampNum(base.y + last.clientY - startY, 0, maxY);
      setFloatings((prev) =>
        prev[ws][id]
          ? { ...prev, [ws]: { ...prev[ws], [id]: { ...prev[ws][id], x, y } } }
          : prev,
      );
    };
    const onMove = (ev: PointerEvent) => {
      last = ev;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onUp = () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Free pixel resize from any edge or corner. Dragging the top/left edges also
  // shifts the window's origin so the opposite edge stays put.
  const startFloatResizeInWorkspace =
    (
      ws: Workspace,
      id: string,
      dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw",
    ) =>
    (e: ReactPointerEvent) => {
      e.preventDefault();
      focusFloatInWorkspace(ws, id);
      const base = floatings[ws][id];
      if (!base) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const left = dir.includes("w");
      const right = dir.includes("e");
      const top = dir.includes("n");
      const bottom = dir.includes("s");
      // Float resize is free pixels, so it has its OWN floor (the grid TILE min only binds
      // tiled windows). Match it to the 4×5-cell floor: 5 rows × 72px rowHeight ≈ 360px tall,
      // and ~480px wide (battleship's two boards go side-by-side at that width) — below this a
      // game's UI collapses.
      const MIN_W = 480;
      const MIN_H = 360;
      // rAF-coalesce one setState per frame (see startFloatDragInWorkspace).
      let raf = 0;
      let last: PointerEvent | null = null;
      const apply = () => {
        raf = 0;
        if (!last) return;
        const dx = last.clientX - startX;
        const dy = last.clientY - startY;
        let { x, y, w, h } = base;
        if (right) w = clampNum(base.w + dx, MIN_W, window.innerWidth - base.x);
        if (left) {
          const edge = base.x + base.w;
          x = clampNum(base.x + dx, 0, edge - MIN_W);
          w = edge - x;
        }
        if (bottom)
          h = clampNum(base.h + dy, MIN_H, window.innerHeight - base.y);
        if (top) {
          const edge = base.y + base.h;
          y = clampNum(base.y + dy, 0, edge - MIN_H);
          h = edge - y;
        }
        setFloatings((prev) =>
          prev[ws][id]
            ? {
                ...prev,
                [ws]: { ...prev[ws], [id]: { ...prev[ws][id], x, y, w, h } },
              }
            : prev,
        );
      };
      const onMove = (ev: PointerEvent) => {
        last = ev;
        if (!raf) raf = requestAnimationFrame(apply);
      };
      const onUp = () => {
        if (raf) cancelAnimationFrame(raf);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
  // Keyboard parity with grid windows: arrows nudge the floating window, shift
  // for bigger steps.
  const onFloatKeyDownInWorkspace =
    (ws: Workspace, id: string) => (e: ReactKeyboardEvent) => {
      const step = e.shiftKey ? 40 : 20;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else return;
      e.preventDefault();
      focusFloatInWorkspace(ws, id);
      setFloatings((prev) =>
        prev[ws][id]
          ? {
              ...prev,
              [ws]: {
                ...prev[ws],
                [id]: {
                  ...prev[ws][id],
                  x: clampNum(
                    prev[ws][id].x + dx,
                    0,
                    window.innerWidth - prev[ws][id].w,
                  ),
                  y: clampNum(
                    prev[ws][id].y + dy,
                    0,
                    window.innerHeight - prev[ws][id].h,
                  ),
                },
              },
            }
          : prev,
      );
    };

  // Replace a workspace's docked layout wholesale (the grid emits the packed set on
  // every drag/resize). Detached windows are filtered out by the floor before this.
  const setLayoutForWorkspace = (ws: Workspace, next: GridItem[]) =>
    setLayouts((prev) => ({ ...prev, [ws]: next }));

  // A workspace's minimized windows as dock entries, labelled with a per-game ordinal
  // when that workspace has duplicates open.
  const hiddenEntriesFor = (ws: Workspace): LayerEntry[] => {
    const wins = [
      ...layouts[ws].map((w) => ({ instanceId: w.id, hidden: false })),
      ...Object.values(hiddens[ws]).map((w) => ({
        instanceId: w.id,
        hidden: true,
      })),
    ];
    const totals: Record<string, number> = {};
    for (const w of wins) {
      const g = gameOf(w.instanceId);
      totals[g] = (totals[g] ?? 0) + 1;
    }
    const seen: Record<string, number> = {};
    return wins
      .map((w) => {
        const g = gameOf(w.instanceId);
        const mod = get(g);
        const n = (seen[g] = (seen[g] ?? 0) + 1);
        return {
          instanceId: w.instanceId,
          label: mod ? (totals[g] > 1 ? `${mod.name} ${n}` : mod.name) : g,
          icon: mod?.icon ?? "🎮",
          image: mod?.image ?? "",
          hidden: w.hidden,
        };
      })
      .filter((e) => e.hidden);
  };

  // The floor's tools now live in the workspace tab bar (top), so the floor stays clear.
  const workspaceTabs = (
    <WorkspaceTabs
      active={section}
      dockSide={dockSide}
      onAdd={() => setAddOpen(true)}
      onArrange={arrange}
      onAddAll={addAll}
      onResetLayout={() => setResetOpen(true)}
      onRemoveAll={() => setRemoveOpen(true)}
      onToggleDock={toggleDockSide}
    />
  );

  // The window-op callbacks a WorkspaceFloor needs, all keyed on the target workspace
  // so the same renderer drives the normal floor and each grouped "All" floor.
  const floorHandlers = {
    onLayoutChange: setLayoutForWorkspace,
    onClose: closeInWorkspace,
    onHide: hideInWorkspace,
    onFloat: floatInWorkspace,
    onDockFloat: dockFloatInWorkspace,
    onMinimizeFloat: minimizeFloatInWorkspace,
    onFocusFloat: focusFloatInWorkspace,
    onFloatDragStart: startFloatDragInWorkspace,
    onFloatResizeStart: startFloatResizeInWorkspace,
    onFloatKeyDown: onFloatKeyDownInWorkspace,
  };

  // Floor + its overlays (the minimized-windows dock). Keyed by workspace so switching
  // tabs mounts that floor's own windows fresh, never bleeding one grid into another.
  const floorArea = (
    <div key={floorWs} className="relative h-full">
      <div data-floor className="bg-dot-grid h-full overflow-auto p-2">
        {idsFor(floorWs).length === 0 ? (
          <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            Nothing open here.
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddOpen(true)}
            >
              <Plus /> Add an app
            </Button>
          </div>
        ) : (
          <WorkspaceFloor
            ws={floorWs}
            layout={layout}
            hidden={hidden}
            floating={floating}
            {...floorHandlers}
          />
        )}
      </div>
      <MacDock
        entries={hiddenEntriesFor(floorWs)}
        side={macDockSide}
        onShow={(id) => showInWorkspace(floorWs, id)}
        onClose={(id) => closeInWorkspace(floorWs, id)}
      />
    </div>
  );

  // The "All" floor: every open window as ONE no-scroll dashboard wall, payments first (top-left),
  // tiles auto-sized to fit the viewport (see OverviewDashboard). Static tiles, so no
  // minimized-window dock. Rendered exclusively (the per-workspace floor is unmounted here), so a
  // game mounts once even though its real window id is reused across views.
  const overviewArea = (
    <OverviewDashboard
      groups={overviewGroupInfos}
      items={overviewItems}
      closers={overviewClosers}
      onOpenWorkspace={goToSection}
      onAdd={() => setAddOpen(true)}
    />
  );

  const activeFloor = section === "all" ? overviewArea : floorArea;

  const collapseRotate =
    dockSide === "bottom"
      ? bottomCollapsed
        ? "rotate-180"
        : ""
      : bottomCollapsed
        ? "rotate-90"
        : "-rotate-90";
  const collapseButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggleBottom}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={bottomCollapsed ? "Expand dock" : "Collapse dock"}
          className={cn(
            "z-50 flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-2 ring-background transition-colors hover:bg-primary/90",
            dockSide === "bottom"
              ? "h-6 w-16 -translate-y-5"
              : "h-16 w-6 -translate-x-5",
          )}
        >
          <ChevronDown
            className={cn("size-4 transition-transform", collapseRotate)}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {bottomCollapsed ? "Expand dock" : "Collapse dock"}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <FrozenContext.Provider value={frozen}>
      {isDesktop ? (
        <div className="flex h-full min-h-0 flex-col">
          {workspaceTabs}
          <div className="min-h-0 flex-1">
            {dockSide === "bottom" ? (
              // The dock opens LOW by default — a fixed pixel height budgeted for ~5 feed rows
              // (compact header + tabs + thead + 5 rows + padding), so the floor keeps most of the
              // viewport while the dock still shows real info. Pixel-sized (not %) so "5 rows"
              // holds on any screen; the floor takes the remainder (no defaultSize). Still fully
              // resizable, and `autoSaveId` persists the user's own size across reloads — expand
              // after a collapse restores it, not some huge default.
              <ResizablePanelGroup
                orientation="vertical"
                autoSave="mtps.desktop.dockLayout.v3"
                className="h-full min-h-0"
              >
                <ResizablePanel minSize="20%" className="min-h-0">
                  {activeFloor}
                </ResizablePanel>
                <ResizableHandle>{collapseButton}</ResizableHandle>
                <ResizablePanel
                  panelRef={bottomRef}
                  collapsible
                  collapsedSize="0%"
                  defaultSize="200px"
                  minSize="120px"
                  className="min-h-0"
                >
                  <Dock side="bottom" />
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              <ResizablePanelGroup
                orientation="horizontal"
                className="h-full min-h-0"
              >
                <ResizablePanel
                  defaultSize="68%"
                  minSize="35%"
                  className="min-w-0"
                >
                  {activeFloor}
                </ResizablePanel>
                <ResizableHandle>{collapseButton}</ResizableHandle>
                <ResizablePanel
                  panelRef={bottomRef}
                  collapsible
                  collapsedSize="0%"
                  defaultSize="32%"
                  minSize="18%"
                  className="min-w-0"
                >
                  <Dock side="right" />
                </ResizablePanel>
              </ResizablePanelGroup>
            )}
          </div>
        </div>
      ) : section === "live" ? (
        <main className="h-full overflow-auto">
          <MobileLive />
        </main>
      ) : section === "all" ? (
        // Phone "All": the category columns collapse into one scroll (a no-scroll wall can't fit a
        // phone), payments first per OVERVIEW_GROUPS.
        <main className="h-full min-h-0">
          <OverviewFloor
            columns={buildOverviewColumns()}
            closers={overviewClosers}
            onOpenWorkspace={goToSection}
          />
        </main>
      ) : (
        // The phone floor: the on-screen workspace's windows scrolled vertically, each
        // auto-playing — the same per-workspace store as the desktop floor. Keyed by
        // `floorWs` so switching tabs mounts that floor's own windows fresh.
        <main className="h-full min-h-0">
          <MobileFloor
            key={floorWs}
            items={layout}
            workspace={floorWs}
            onClose={closeActiveFloor}
            onAdd={() => setAddOpen(true)}
          />
        </main>
      )}

      {isDesktop ? (
        <AddAppDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onOpen={openApp}
        />
      ) : (
        <MobileAddSheet
          open={addOpen}
          onOpenChange={setAddOpen}
          onOpen={openApp}
        />
      )}

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset layout?</DialogTitle>
            <DialogDescription>
              Re-opens all games and restores the default arrangement.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmReset}>Reset layout</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear the floor?</DialogTitle>
            <DialogDescription>
              Removes every open and minimized window.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmRemoveAll}>
              Remove all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </FrozenContext.Provider>
  );
}
