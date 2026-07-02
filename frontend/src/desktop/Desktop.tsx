import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
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
import {
  GridLayout,
  type GridBreakpoint,
  type GridDragHandleProps,
  type GridItem,
} from "@/components/ui/grid-layout";
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
import { SystemDashboard } from "../panels/SystemDashboard";
import { TpsChart } from "../panels/TpsChart";
import { GameWindow } from "./GameWindow";
import { GameContent } from "./GameContent";
import { FrozenContext } from "./frozenContext";
import {
  classifyWalletTransition,
  collectGameWindowIds,
} from "./freezeOnDisconnect";
import { GameTpsBadge } from "./GameTpsBadge";
import { OverviewFloor, type OverviewGroup } from "./OverviewFloor";
import { MobileFloor } from "./MobileFloor";
import { MobileAddSheet } from "./MobileAddSheet";
import { AddAppDialog } from "./AddAppDialog";
import { WorkspaceTabs } from "./WorkspaceTabs";
import type { MobileSection } from "./AppShell";

type DockSide = "bottom" | "right";

/** One entry per open/hidden window instance. */
type LayerEntry = {
  instanceId: string;
  label: string;
  icon: string;
  image: string;
  hidden: boolean;
};

/** A window popped out of the grid: free-floating, draggable, stackable. */
type FloatState = {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  item: GridItem;
};

// Windows carry an instance id so the same game can open many times: a seeded
// window is just its `gameId`; added duplicates are `gameId#<uuid>`.
const gameOf = (instanceId: string) => instanceId.split("#")[0];
const newInstanceId = (gameId: string) =>
  `${gameId}#${crypto.randomUUID().slice(0, 8)}`;

const clampNum = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/** Returns a copy of `obj` without `id` (or `obj` itself if absent). */
function dropKey<T>(obj: Record<string, T>, id: string): Record<string, T> {
  if (obj[id] == null) return obj;
  const next = { ...obj };
  delete next[id];
  return next;
}

// Every game window opens at the SAME size so the floor reads as one uniform grid
// rather than a patchwork of per-game footprints. minW/minH is the global resize floor:
// 4 cols × 5 rows is the smallest a game stays usable — below it the boards/controls
// collapse (e.g. battleship's two boards stack into a broken sliver at 3 cols / 3 rows),
// so the engine clamps resize there and new windows open at that size.
const TILE = { w: 4, h: 5, minW: 4, minH: 5 } as const;

// Column counts are all multiples of TILE.w (4) so uniform windows always pack into
// full rows: 3 per row on a wide floor, 2 on a tablet-width dock, 1 on a narrow one.
const BREAKPOINTS: GridBreakpoint[] = [
  { minWidth: 0, cols: 4 },
  { minWidth: 640, cols: 8 },
  { minWidth: 1024, cols: 12 },
];

// Tile against the widest breakpoint so auto-arrange fills the full row.
const COLS = Math.max(...BREAKPOINTS.map((b) => b.cols));

/**
 * First-fit pack: drop each window into the first free grid slot, scanning rows
 * top-to-bottom and columns left-to-right. Unlike a plain row-packer this fills
 * holes — e.g. the empty cells to the right of a tall window's lower half — so a
 * newly added or re-arranged window slots into space on an existing row before
 * opening a new row below. Footprints never overlap; each window keeps its size.
 */
function tile(items: GridItem[]): GridItem[] {
  const placed: GridItem[] = [];
  const free = (x: number, y: number, w: number, h: number) =>
    placed.every(
      (p) => x + w <= p.x || x >= p.x + p.w || y + h <= p.y || y >= p.y + p.h,
    );
  return items.map((item) => {
    const w = Math.min(item.w, COLS);
    const h = item.h;
    let x = 0;
    let y = 0;
    search: for (y = 0; ; y++) {
      for (x = 0; x <= COLS - w; x++) {
        if (free(x, y, w, h)) break search;
      }
    }
    const placedItem = { ...item, x, y, w };
    placed.push(placedItem);
    return placedItem;
  });
}

// Edge/corner grab zones for a floating window's free pixel resize.
const FLOAT_HANDLES = [
  { dir: "n", cls: "top-0 right-3 left-3 h-1.5 cursor-ns-resize" },
  { dir: "s", cls: "right-3 bottom-0 left-3 h-1.5 cursor-ns-resize" },
  { dir: "w", cls: "top-3 bottom-3 left-0 w-1.5 cursor-ew-resize" },
  { dir: "e", cls: "top-3 right-0 bottom-3 w-1.5 cursor-ew-resize" },
  { dir: "nw", cls: "top-0 left-0 size-3 cursor-nwse-resize" },
  { dir: "ne", cls: "top-0 right-0 size-3 cursor-nesw-resize" },
  { dir: "sw", cls: "bottom-0 left-0 size-3 cursor-nesw-resize" },
  { dir: "se", cls: "right-0 bottom-0 size-3 cursor-nwse-resize" },
] as const;

// Each workspace (Games / Payment / Chat) is its own window floor with independent
// state, so switching never disturbs another's windows. A floor seeds one tiled
// window per module registered to that workspace.
function seedLayoutFor(workspace: Workspace): GridItem[] {
  return tile(
    listByWorkspace(workspace).map((mod) => ({
      id: mod.id,
      x: 0,
      y: 0,
      ...TILE,
    })),
  );
}
function seedLayouts(): Record<Workspace, GridItem[]> {
  return {
    games: seedLayoutFor("games"),
    payment: seedLayoutFor("payment"),
    chat: seedLayoutFor("chat"),
  };
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
        <SystemDashboard />
        <TpsChart snapshot={snapshot} />
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
        <div className="flex h-full flex-col gap-2 overflow-y-auto">
          <SystemDashboard />
          <TpsChart snapshot={snapshot} />
        </div>
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
      <SystemDashboard />
      <TpsChart snapshot={snapshot} />
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
  // Active-floor slices + setters scoped to it. The setters are stable while `floorWs`
  // holds, so `close` (memoized below) stays stable and per-window memoization survives.
  const layout = layouts[floorWs];
  const hidden = hiddens[floorWs];
  const floating = floatings[floorWs];
  const setLayout = useCallback(
    (action: SetStateAction<GridItem[]>) =>
      setLayouts((prev) => ({
        ...prev,
        [floorWs]:
          typeof action === "function"
            ? (action as (p: GridItem[]) => GridItem[])(prev[floorWs])
            : action,
      })),
    [floorWs, setLayouts],
  );
  const setHidden = useCallback(
    (action: SetStateAction<Record<string, GridItem>>) =>
      setHiddens((prev) => ({
        ...prev,
        [floorWs]:
          typeof action === "function"
            ? (
                action as (
                  p: Record<string, GridItem>,
                ) => Record<string, GridItem>
              )(prev[floorWs])
            : action,
      })),
    [floorWs, setHiddens],
  );
  const setFloating = useCallback(
    (action: SetStateAction<Record<string, FloatState>>) =>
      setFloatings((prev) => ({
        ...prev,
        [floorWs]:
          typeof action === "function"
            ? (
                action as (
                  p: Record<string, FloatState>,
                ) => Record<string, FloatState>
              )(prev[floorWs])
            : action,
      })),
    [floorWs, setFloatings],
  );
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

  // Stable (functional setters only) so GameContent's memo can hold across re-renders.
  const close = useCallback(
    (id: string) => {
      disposeWindow(id); // tear down the game's live session (sockets, timers)
      setLayout((cur) => tile(cur.filter((w) => w.id !== id)));
      setHidden((h) => dropKey(h, id));
      setFloating((f) => dropKey(f, id));
    },
    [setLayout, setHidden, setFloating],
  );

  // Close-by-id scoped to a given workspace (not just the active floor). The overview
  // floor mounts windows from every workspace at once, so its tiles must close into the
  // right floor's stores. Mirrors `close`, keyed by `ws` instead of `floorWs`.
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
  // The overview's groups: every workspace's open windows (tiled + minimized + floating).
  // A window lives in exactly one of the three stores, so concatenating their ids per
  // workspace lists each instance once.
  const idsFor = (ws: Workspace) => [
    ...layouts[ws].map((w) => w.id),
    ...Object.keys(hiddens[ws]),
    ...Object.values(floatings[ws]).map((f) => f.item.id),
  ];
  const overviewGroups: OverviewGroup[] = [
    { ws: "games", label: "Game", ids: idsFor("games"), onClose: closeGames },
    {
      ws: "payment",
      label: "Payment",
      ids: idsFor("payment"),
      onClose: closePayment,
    },
    { ws: "chat", label: "Chat", ids: idsFor("chat"), onClose: closeChat },
  ];

  // Minimize → fly into the dock, hide off the floor (keeping geometry), re-tile.
  const hide = (id: string) => {
    const item = layout.find((w) => w.id === id);
    if (!item) return;
    animateMinimize(id);
    setHidden((h) => ({ ...h, [id]: item }));
    setLayout((cur) => tile(cur.filter((w) => w.id !== id)));
  };

  // Restore from the dock → grid, flying the window back out of its dock tile.
  const show = (id: string) => {
    const item = hidden[id];
    if (!item) return;
    const dockEl = document.querySelector(`[data-dock-item="${id}"]`);
    const from =
      dockEl instanceof HTMLElement ? dockEl.getBoundingClientRect() : null;
    setHidden((h) => dropKey(h, id));
    setLayout((cur) => tile([...cur, item]));
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
    // Fund this game's arena seat on the spot (idempotent + coalesced by the shared batcher). No-op if
    // not arena-wired or no wallet yet — in the latter case the connect-time batch picks it up.
    const arenaId = arenaGameIdForModule(gameId);
    if (arenaId && arenaOwner) void requestArenaGame(arenaId, arenaOwner);
    return id;
  };

  // Open a picked app: add a window to its workspace's floor and switch there. The
  // workspace you came from keeps its windows — nothing resets.
  const openApp = (module: GameModule) => {
    setAddOpen(false);
    const workspace = module.workspace ?? "games";
    const id = addWindowTo(workspace, module.id);
    goToSection(workspace);
    revealWindow(id);
  };

  // One window per workspace module not already on this floor.
  const addAll = () => {
    setLayout((cur) => {
      const present = new Set(cur.map((w) => gameOf(w.id)));
      const adds = listByWorkspace(floorWs)
        .filter((m) => !present.has(m.id))
        .map((m) => ({ id: newInstanceId(m.id), x: 0, y: 0, ...TILE }));
      return tile([...cur, ...adds]);
    });
    // Fund each newly-added arena game (best-effort coalesce; addAll isn't the one-popup connect path).
    if (arenaOwner) {
      const present = new Set(layout.map((w) => gameOf(w.id)));
      for (const m of listByWorkspace(floorWs)) {
        if (present.has(m.id)) continue;
        const arenaId = arenaGameIdForModule(m.id);
        if (arenaId) void requestArenaGame(arenaId, arenaOwner);
      }
    }
  };

  // Tear down every open/hidden/floating window's live session (sockets, timers) —
  // shared by both the Reset-layout and Remove-all confirmations before they clear.
  const disposeAllSessions = () => {
    for (const id of [
      ...layout.map((w) => w.id),
      ...Object.keys(hidden),
      ...Object.keys(floating),
    ]) {
      disposeWindow(id);
    }
  };

  // Reset layout: re-seed this workspace's default floor (its modules, tidy grid).
  const confirmReset = () => {
    disposeAllSessions();
    setLayout(seedLayoutFor(floorWs));
    setHidden({});
    setFloating({});
    setResetOpen(false);
  };

  // Remove all: clear the floor to empty (no re-seed).
  const confirmRemoveAll = () => {
    disposeAllSessions();
    setLayout([]);
    setHidden({});
    setFloating({});
    setRemoveOpen(false);
  };

  // Auto-arrange: reset every window to the uniform tile size and re-pack into a
  // clean grid. Manual resizes are intentionally dropped — a tidy grid is the point.
  const arrange = () => {
    setLayout((cur) => tile(cur.map((w) => ({ ...w, ...TILE }))));
    // The re-packed grid anchors at the top; jump there so the tidy-up is visible.
    requestAnimationFrame(() =>
      document
        .querySelector("[data-floor]")
        ?.scrollTo({ top: 0, behavior: "smooth" }),
    );
  };

  // --- Floating (maximized) windows -------------------------------------
  const focusFloat = (id: string) => {
    floatZ.current += 1;
    const z = floatZ.current;
    setFloating((f) => (f[id] ? { ...f, [id]: { ...f[id], z } } : f));
  };

  // Maximize → pop the window out of the grid into the floating layer.
  const floatWindow = (id: string) => {
    const item = layout.find((w) => w.id === id);
    if (!item || floating[id]) return;
    const fw = window.innerWidth * 0.7;
    const fh = window.innerHeight * 0.7;
    const n = Object.keys(floating).length;
    floatZ.current += 1;
    setFloating((f) => ({
      ...f,
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
        z: floatZ.current,
        item,
      },
    }));
    setLayout((cur) => tile(cur.filter((w) => w.id !== id)));
  };

  // Restore a floating window back into the grid.
  const dockFloat = (id: string) => {
    const st = floating[id];
    if (!st) return;
    setFloating((f) => dropKey(f, id));
    setLayout((cur) => tile([...cur, st.item]));
  };

  // Minimize a floating window straight into the hidden dock (with flight).
  const minimizeFloat = (id: string) => {
    const st = floating[id];
    if (!st) return;
    animateMinimize(id);
    setFloating((f) => dropKey(f, id));
    setHidden((h) => ({ ...h, [id]: st.item }));
  };

  const startFloatDrag = (id: string, e: ReactPointerEvent) => {
    e.preventDefault();
    focusFloat(id);
    const base = floating[id];
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
      setFloating((f) => (f[id] ? { ...f, [id]: { ...f[id], x, y } } : f));
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
  const startFloatResize =
    (id: string, dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw") =>
    (e: ReactPointerEvent) => {
      e.preventDefault();
      focusFloat(id);
      const base = floating[id];
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
      // rAF-coalesce one setState per frame (see startFloatDrag).
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
        setFloating((f) =>
          f[id] ? { ...f, [id]: { ...f[id], x, y, w, h } } : f,
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
  const onFloatKeyDown = (id: string) => (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 40 : 20;
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else return;
    e.preventDefault();
    focusFloat(id);
    setFloating((f) =>
      f[id]
        ? {
            ...f,
            [id]: {
              ...f[id],
              x: clampNum(f[id].x + dx, 0, window.innerWidth - f[id].w),
              y: clampNum(f[id].y + dy, 0, window.innerHeight - f[id].h),
            },
          }
        : f,
    );
  };
  const floatDragProps = (id: string): GridDragHandleProps => ({
    onPointerDown: (e) => startFloatDrag(id, e),
    onKeyDown: onFloatKeyDown(id),
    tabIndex: 0,
    role: "button",
    "aria-label": "Move window. Arrow keys move, shift for bigger steps.",
  });

  // Window instances, labelled with a per-game ordinal when duplicates exist.
  const windows = [
    ...layout.map((w) => ({ instanceId: w.id, hidden: false })),
    ...Object.values(hidden).map((w) => ({ instanceId: w.id, hidden: true })),
  ];
  const totals: Record<string, number> = {};
  for (const w of windows) {
    const g = gameOf(w.instanceId);
    totals[g] = (totals[g] ?? 0) + 1;
  }
  const seen: Record<string, number> = {};
  const layerEntries: LayerEntry[] = windows.map((w) => {
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
  });
  const hiddenEntries = layerEntries.filter((e) => e.hidden);

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

  // Every window (docked + minimized + floating) is rendered by ONE GridLayout so a
  // window changing mode is a style change, not an unmount — gameplay state is never
  // lost on minimize/maximize. Minimized/floating items are detached via styleOverride
  // (excluded from grid math); docked windows still pack among themselves.
  const allWindows: GridItem[] = [
    ...layout,
    ...Object.values(hidden),
    ...Object.values(floating).map((f) => f.item),
  ];
  const styleFor = (item: GridItem): CSSProperties | null => {
    if (hidden[item.id]) return { display: "none" };
    const f = floating[item.id];
    if (f)
      return {
        position: "fixed",
        left: f.x,
        top: f.y,
        width: f.w,
        height: f.h,
        zIndex: f.z,
      };
    return null;
  };

  const floor =
    allWindows.length === 0 ? (
      <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        Nothing open here.
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus /> Add an app
        </Button>
      </div>
    ) : (
      <GridLayout
        layout={allWindows}
        onLayoutChange={(next) =>
          setLayout(next.filter((w) => !hidden[w.id] && !floating[w.id]))
        }
        breakpoints={BREAKPOINTS}
        rowHeight={72}
        styleOverride={styleFor}
        renderItem={(item, handle) => {
          const mod = get(gameOf(item.id));
          if (!mod) return null;
          const fl = floating[item.id];
          const win = (
            <GameWindow
              title={mod.name}
              icon={<GameTpsBadge gameId={gameOf(item.id)} />}
              domId={item.id}
              dragHandleProps={
                fl ? floatDragProps(item.id) : handle.dragHandleProps
              }
              isActive={fl ? true : handle.isActive}
              onMinimize={() => (fl ? minimizeFloat(item.id) : hide(item.id))}
              onMaximize={fl ? undefined : () => floatWindow(item.id)}
              onRestore={fl ? () => dockFloat(item.id) : undefined}
              onClose={() => close(item.id)}
            >
              {/* The game, isolated in a memo so a floor re-render (a sibling drag, a
                  telemetry tick) doesn't re-render this game. */}
              <GameContent
                gameId={gameOf(item.id)}
                windowId={item.id}
                onClose={close}
              />
            </GameWindow>
          );
          // Always wrap identically — float-handles + focus-to-front only when
          // floating — so maximize/minimize is a style change, NOT a remount. That
          // keeps every game's component state alive across the transition, instead
          // of only games that stash it in a windowId store (Battleship). The grid's
          // own resize handles are suppressed for detached items, so no overlap.
          return (
            <div
              className="relative h-full w-full"
              onPointerDown={fl ? () => focusFloat(item.id) : undefined}
            >
              {win}
              {fl &&
                FLOAT_HANDLES.map((hdl) => (
                  <div
                    key={hdl.dir}
                    className={cn("absolute z-10 touch-none", hdl.cls)}
                    onPointerDown={startFloatResize(item.id, hdl.dir)}
                    aria-hidden
                  />
                ))}
            </div>
          );
        }}
      />
    );

  // Floor + its overlays (controls column + the minimized-windows dock). Keyed by
  // workspace so switching tabs mounts that floor's own windows fresh, never bleeding
  // one workspace's grid into another.
  const floorArea = (
    <div key={floorWs} className="relative h-full">
      <div data-floor className="bg-dot-grid h-full overflow-auto p-2">
        {floor}
      </div>
      <MacDock
        entries={hiddenEntries}
        side={macDockSide}
        onShow={show}
        onClose={close}
      />
    </div>
  );

  // The "All" floor swaps in for the per-workspace floor but keeps the same dock/panel
  // chrome around it (it's just another floor, grouped). Rendered exclusively, so games
  // mount once even though their real window ids are reused here.
  const activeFloor =
    section === "all" ? (
      <OverviewFloor groups={overviewGroups} onOpenWorkspace={goToSection} />
    ) : (
      floorArea
    );

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
              <ResizablePanelGroup
                orientation="vertical"
                className="h-full min-h-0"
              >
                <ResizablePanel
                  defaultSize="58%"
                  minSize="20%"
                  className="min-h-0"
                >
                  {activeFloor}
                </ResizablePanel>
                <ResizableHandle>{collapseButton}</ResizableHandle>
                <ResizablePanel
                  panelRef={bottomRef}
                  collapsible
                  collapsedSize="0%"
                  defaultSize="42%"
                  minSize="14%"
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
        <main className="h-full min-h-0">
          <OverviewFloor
            groups={overviewGroups}
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
            onClose={close}
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
