import { useCallback } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import { get } from "../games/registry";
import type { Workspace } from "../games/types";
import {
  GridLayout,
  type GridDragHandleProps,
  type GridItem,
} from "@/components/ui/grid-layout";
import { cn } from "@/lib/utils";
import { GameWindow } from "./GameWindow";
import { GameContent } from "./GameContent";
import { GameTpsBadge } from "./GameTpsBadge";
import { BREAKPOINTS, ROW_HEIGHT, gameOf, type FloatState } from "./floorGrid";

/** The eight edge/corner grab zones for a floating window's free pixel resize. */
export type FloatResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const FLOAT_HANDLES: { dir: FloatResizeDir; cls: string }[] = [
  { dir: "n", cls: "top-0 right-3 left-3 h-1.5 cursor-ns-resize" },
  { dir: "s", cls: "right-3 bottom-0 left-3 h-1.5 cursor-ns-resize" },
  { dir: "w", cls: "top-3 bottom-3 left-0 w-1.5 cursor-ew-resize" },
  { dir: "e", cls: "top-3 right-0 bottom-3 w-1.5 cursor-ew-resize" },
  { dir: "nw", cls: "top-0 left-0 size-3 cursor-nwse-resize" },
  { dir: "ne", cls: "top-0 right-0 size-3 cursor-nesw-resize" },
  { dir: "sw", cls: "bottom-0 left-0 size-3 cursor-nesw-resize" },
  { dir: "se", cls: "right-0 bottom-0 size-3 cursor-nwse-resize" },
];

/**
 * One workspace's window floor: a draggable/resizable {@link GridLayout} of
 * self-playing game windows, with minimize/maximize/close chrome. Maximized
 * windows render detached (position:fixed) via `styleOverride`; minimized ones
 * are hidden (display:none) but stay mounted, so a mode change is a style change,
 * not an unmount — gameplay state survives.
 *
 * The floor owns no state: every window mutation routes up through a
 * workspace-keyed callback so the same renderer drives both the normal floor
 * (one workspace on screen) and the grouped "All" floor (three stacked at once).
 * `onClose` must be a stable identity per workspace — {@link GameContent} is
 * memoized on it, so a churning closer would re-mount every game each render.
 */
export interface WorkspaceFloorProps {
  ws: Workspace;
  /** Docked (in-grid) windows. */
  layout: GridItem[];
  /** Minimized windows (kept mounted, off the grid). */
  hidden: Record<string, GridItem>;
  /** Maximized (free-floating) windows, keyed by instance id. */
  floating: Record<string, FloatState>;
  onLayoutChange: (ws: Workspace, next: GridItem[]) => void;
  onClose: (ws: Workspace, id: string) => void;
  onHide: (ws: Workspace, id: string) => void;
  onFloat: (ws: Workspace, id: string) => void;
  onDockFloat: (ws: Workspace, id: string) => void;
  onMinimizeFloat: (ws: Workspace, id: string) => void;
  onFocusFloat: (ws: Workspace, id: string) => void;
  onFloatDragStart: (ws: Workspace, id: string, e: ReactPointerEvent) => void;
  onFloatResizeStart: (
    ws: Workspace,
    id: string,
    dir: FloatResizeDir,
  ) => (e: ReactPointerEvent) => void;
  onFloatKeyDown: (
    ws: Workspace,
    id: string,
  ) => (e: ReactKeyboardEvent) => void;
}

export function WorkspaceFloor({
  ws,
  layout,
  hidden,
  floating,
  onLayoutChange,
  onClose,
  onHide,
  onFloat,
  onDockFloat,
  onMinimizeFloat,
  onFocusFloat,
  onFloatDragStart,
  onFloatResizeStart,
  onFloatKeyDown,
}: WorkspaceFloorProps) {
  // Stable per-window closer for GameContent's memo: `ws` is constant for this
  // instance and `onClose` is a stable parent callback, so this identity holds
  // across re-renders (a changing one would re-mount every game each render).
  const close = useCallback((id: string) => onClose(ws, id), [ws, onClose]);

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

  const floatDragProps = (id: string): GridDragHandleProps => ({
    onPointerDown: (e) => onFloatDragStart(ws, id, e),
    onKeyDown: onFloatKeyDown(ws, id),
    tabIndex: 0,
    role: "button",
    "aria-label": "Move window. Arrow keys move, shift for bigger steps.",
  });

  return (
    <GridLayout
      layout={allWindows}
      onLayoutChange={(next) =>
        onLayoutChange(
          ws,
          next.filter((w) => !hidden[w.id] && !floating[w.id]),
        )
      }
      breakpoints={BREAKPOINTS}
      rowHeight={ROW_HEIGHT}
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
            category={ws}
            dragHandleProps={
              fl ? floatDragProps(item.id) : handle.dragHandleProps
            }
            isActive={fl ? true : handle.isActive}
            onMinimize={() =>
              fl ? onMinimizeFloat(ws, item.id) : onHide(ws, item.id)
            }
            onMaximize={fl ? undefined : () => onFloat(ws, item.id)}
            onRestore={fl ? () => onDockFloat(ws, item.id) : undefined}
            onClose={() => onClose(ws, item.id)}
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
        // keeps every game's component state alive across the transition. The grid's
        // own resize handles are suppressed for detached items, so no overlap.
        return (
          <div
            className="relative h-full w-full"
            onPointerDown={fl ? () => onFocusFloat(ws, item.id) : undefined}
          >
            {win}
            {fl &&
              FLOAT_HANDLES.map((hdl) => (
                <div
                  key={hdl.dir}
                  className={cn("absolute z-10 touch-none", hdl.cls)}
                  onPointerDown={onFloatResizeStart(ws, item.id, hdl.dir)}
                  aria-hidden
                />
              ))}
          </div>
        );
      }}
    />
  );
}
