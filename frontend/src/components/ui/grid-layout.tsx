import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  bottom,
  clamp,
  compact,
  fitToColumns,
  type GridItem,
  type GridLayout as GridLayoutValue,
  moveItem,
  resizeItem,
} from "./grid-layout-engine";

export type { GridItem, GridLayoutValue };

/** Props spread onto whatever element should start a drag (e.g. a title bar). */
export interface GridDragHandleProps {
  onPointerDown: (e: ReactPointerEvent) => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  tabIndex: number;
  role: "button";
  "aria-label": string;
}

export interface GridItemHandle {
  /** Spread onto the drag handle element. */
  dragHandleProps: GridDragHandleProps;
  /** True while this item is being dragged or resized. */
  isActive: boolean;
  /** True when this item is rendered detached (see `styleOverride`): it's positioned
   *  by the caller, kept out of grid flow, and has no grid drag/resize wired. */
  detached: boolean;
}

/** A responsive rule: at container widths ≥ `minWidth`, use `cols` columns. */
export interface GridBreakpoint {
  minWidth: number;
  cols: number;
}

export interface GridLayoutProps {
  /** Controlled layout in grid units. */
  layout: GridLayoutValue;
  onLayoutChange: (next: GridLayoutValue) => void;
  /** Renders each item's content; receives the drag-handle props to wire up. */
  renderItem: (item: GridItem, handle: GridItemHandle) => ReactNode;
  /** Fixed column count. Ignored when `breakpoints` is set. */
  cols?: number;
  /** Width-driven column counts; the layout refits when the active count changes. */
  breakpoints?: GridBreakpoint[];
  rowHeight?: number;
  gap?: number;
  className?: string;
  /**
   * Per-item escape hatch: return a style to render that item DETACHED — absolutely
   * positioned by you (e.g. a floating window) or hidden (`display:none` for a
   * minimized one) — instead of in the grid. Detached items stay mounted but are
   * excluded from grid layout math and get no grid drag/resize. Return null to keep
   * an item in the grid. This lets a window minimize/float without unmounting.
   */
  styleOverride?: (item: GridItem) => CSSProperties | null;
  /** Fired when an item is brought to front (pointer-down / drag / resize / arrow) —
   *  i.e. the user just focused it. Lets the caller track the active window. */
  onActivate?: (id: string) => void;
}

/** Live pixel override for the item under the cursor (bypasses cell snapping). */
type LiveState = {
  id: string;
  mode: "drag" | "resize";
  dx: number;
  dy: number;
  w: number;
  h: number;
};

type Box = Pick<GridItem, "x" | "y" | "w" | "h">;

const FRAME_TRANSITION =
  "left .18s cubic-bezier(.2,.8,.2,1), top .18s cubic-bezier(.2,.8,.2,1), width .18s cubic-bezier(.2,.8,.2,1), height .18s cubic-bezier(.2,.8,.2,1), transform .18s cubic-bezier(.2,.8,.2,1)";

/**
 * A draggable + resizable grid of items, react-grid-layout style, owned in-repo.
 *
 * For a smooth feel the active item follows the cursor pixel-precisely via a GPU
 * `transform` (drag) or a live pixel size (resize) with transitions off, while a
 * placeholder marks the snapped target and neighbours reflow with transitions.
 * On release the item eases into its settled cell. Pointer moves are
 * rAF-throttled. Arrow keys move a focused item; shift+arrows resize it.
 */
export function GridLayout({
  layout,
  onLayoutChange,
  renderItem,
  cols = 12,
  breakpoints,
  rowHeight = 64,
  gap = 10,
  className,
  styleOverride,
  onActivate,
}: GridLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [live, setLive] = useState<LiveState | null>(null);
  const [placeholder, setPlaceholder] = useState<Box | null>(null);
  // Off until the grid has mounted, measured its width, and settled its column fit once — so windows
  // appear IN PLACE on mount (and on every tab-switch remount) instead of sliding in from the
  // unmeasured (width 0 ⇒ default-cols) layout. Flipped on after two frames; drags and real resizes
  // still animate via FRAME_TRANSITION.
  const [settled, setSettled] = useState(false);

  // Mirror the latest layout so window event handlers never read a stale closure.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Detached items (floating/minimized) stay mounted but are positioned by the
  // caller and kept OUT of grid math — docked items still pack among themselves.
  const overrideRef = useRef(styleOverride);
  overrideRef.current = styleOverride;
  const isDetached = (item: GridItem) => overrideRef.current?.(item) != null;
  const dockedOnly = (arr: GridItem[]) => arr.filter((i) => !isDetached(i));
  /** Re-attach detached items (unchanged) after running grid math on the docked subset. */
  const mergeDetached = (dockedNext: GridItem[]) => [
    ...dockedNext,
    ...layoutRef.current.filter((i) => isDetached(i)),
  ];
  const gridItems = layout.filter((i) => !isDetached(i));

  // Active column count: the widest breakpoint whose minWidth fits the container.
  const activeCols = useMemo(() => {
    if (!breakpoints?.length || !width) return cols;
    let chosen = cols;
    for (const bp of [...breakpoints].sort((a, b) => a.minWidth - b.minWidth)) {
      if (width >= bp.minWidth) chosen = bp.cols;
    }
    return chosen;
  }, [breakpoints, width, cols]);

  // When the breakpoint changes the column count, refit the layout to it.
  const lastColsRef = useRef(activeCols);
  useEffect(() => {
    if (lastColsRef.current === activeCols) return;
    lastColsRef.current = activeCols;
    onLayoutChange(
      mergeDetached(fitToColumns(dockedOnly(layoutRef.current), activeCols)),
    );
  }, [activeCols, onLayoutChange]);

  // z-order: interacting with a window raises it above its neighbours.
  const [zOrder, setZOrder] = useState<Record<string, number>>({});
  const zCounter = useRef(10);
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const bringToFront = useCallback((id: string) => {
    zCounter.current += 1;
    const next = zCounter.current;
    setZOrder((prev) => ({ ...prev, [id]: next }));
    onActivateRef.current?.(id);
  }, []);

  // Measure container width before paint, then track it responsively.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Enable the settle transition only after the first paint + the post-measure column refit have
  // landed (two frames), so the initial layout doesn't animate in.
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setSettled(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  const unitWidth = width / activeCols;
  const pixelBox = (box: Box): CSSProperties => ({
    left: box.x * unitWidth + gap / 2,
    top: box.y * rowHeight + gap / 2,
    width: box.w * unitWidth - gap,
    height: box.h * rowHeight - gap,
  });
  const canvasHeight = (bottom(gridItems) + 1) * rowHeight;

  const startInteraction = useCallback(
    (
      e: ReactPointerEvent,
      id: string,
      mode: "drag" | "resize",
      axis: "both" | "x" | "y" = "both",
    ) => {
      if (e.button !== 0) return;
      const it = layoutRef.current.find((i) => i.id === id);
      if (!it || it.static || isDetached(it)) return;
      e.preventDefault();
      e.stopPropagation();
      bringToFront(id);

      const unit = (containerRef.current?.clientWidth ?? width) / activeCols;
      const startX = e.clientX;
      const startY = e.clientY;
      const origin = { x: it.x, y: it.y, w: it.w, h: it.h };
      const originLeft = origin.x * unit + gap / 2;
      const originTop = origin.y * rowHeight + gap / 2;
      const minW = it.minW ?? 1;
      const minH = it.minH ?? 1;
      let ph: Box = { ...origin };

      setPlaceholder(ph);
      setLive({
        id,
        mode,
        dx: 0,
        dy: 0,
        w: origin.w * unit - gap,
        h: origin.h * rowHeight - gap,
      });

      let raf = 0;
      let lastEvent: PointerEvent = e.nativeEvent;

      const apply = () => {
        raf = 0;
        const dxPx = lastEvent.clientX - startX;
        const dyPx = lastEvent.clientY - startY;

        if (mode === "drag") {
          const tCol = clamp(
            origin.x + Math.round(dxPx / unit),
            0,
            activeCols - origin.w,
          );
          const tRow = Math.max(0, origin.y + Math.round(dyPx / rowHeight));
          if (tCol !== ph.x || tRow !== ph.y) {
            const next = moveItem(
              dockedOnly(layoutRef.current),
              id,
              tCol,
              tRow,
              activeCols,
            );
            onLayoutChange(mergeDetached(next));
            const landed = next.find((i) => i.id === id);
            if (landed)
              ph = { x: landed.x, y: landed.y, w: landed.w, h: landed.h };
            setPlaceholder(ph);
          }
          const snapLeft = ph.x * unit + gap / 2;
          const snapTop = ph.y * rowHeight + gap / 2;
          setLive({
            id,
            mode,
            dx: originLeft + dxPx - snapLeft,
            dy: originTop + dyPx - snapTop,
            w: 0,
            h: 0,
          });
        } else {
          // Edge handles constrain one axis; the corner resizes both.
          const tW =
            axis === "y"
              ? origin.w
              : clamp(
                  origin.w + Math.round(dxPx / unit),
                  minW,
                  activeCols - origin.x,
                );
          const tH =
            axis === "x"
              ? origin.h
              : Math.max(minH, origin.h + Math.round(dyPx / rowHeight));
          if (tW !== ph.w || tH !== ph.h) {
            const next = resizeItem(
              dockedOnly(layoutRef.current),
              id,
              tW,
              tH,
              activeCols,
            );
            onLayoutChange(mergeDetached(next));
            const resized = next.find((i) => i.id === id);
            if (resized)
              ph = { x: resized.x, y: resized.y, w: resized.w, h: resized.h };
            setPlaceholder(ph);
          }
          const liveW =
            axis === "y"
              ? origin.w * unit - gap
              : clamp(
                  origin.w * unit - gap + dxPx,
                  minW * unit - gap,
                  (activeCols - origin.x) * unit - gap,
                );
          const liveH =
            axis === "x"
              ? origin.h * rowHeight - gap
              : Math.max(
                  minH * rowHeight - gap,
                  origin.h * rowHeight - gap + dyPx,
                );
          setLive({ id, mode, dx: 0, dy: 0, w: liveW, h: liveH });
        }
      };

      const onMove = (ev: PointerEvent) => {
        lastEvent = ev;
        if (!raf) raf = requestAnimationFrame(apply);
      };
      const onUp = () => {
        if (raf) cancelAnimationFrame(raf);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setLive(null);
        setPlaceholder(null);
        // Float everything up to close the gaps the interaction opened; the
        // active frame eases from its free pixel position into the settled cell.
        onLayoutChange(mergeDetached(compact(dockedOnly(layoutRef.current))));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [activeCols, bringToFront, gap, onLayoutChange, rowHeight, width],
  );

  const onHandleKeyDown = useCallback(
    (e: ReactKeyboardEvent, id: string) => {
      const it = layoutRef.current.find((i) => i.id === id);
      if (!it || it.static || isDetached(it)) return;
      const resize = e.shiftKey;
      const apply = (dx: number, dy: number) =>
        mergeDetached(
          resize
            ? resizeItem(
                dockedOnly(layoutRef.current),
                id,
                it.w + dx,
                it.h + dy,
                activeCols,
              )
            : moveItem(
                dockedOnly(layoutRef.current),
                id,
                it.x + dx,
                it.y + dy,
                activeCols,
              ),
        );

      let next: GridLayoutValue | null = null;
      switch (e.key) {
        case "ArrowLeft":
          next = apply(-1, 0);
          break;
        case "ArrowRight":
          next = apply(1, 0);
          break;
        case "ArrowUp":
          next = apply(0, -1);
          break;
        case "ArrowDown":
          next = apply(0, 1);
          break;
        default:
          return;
      }
      e.preventDefault();
      bringToFront(id);
      onLayoutChange(next);
    },
    [activeCols, bringToFront, onLayoutChange],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full select-none", className)}
      style={{
        height: canvasHeight,
        backgroundImage: live
          ? "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)"
          : undefined,
        backgroundSize: live ? `${unitWidth}px ${rowHeight}px` : undefined,
      }}
    >
      {placeholder && (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-none border-2 border-dashed border-primary/60 bg-primary/10 transition-all duration-150 ease-out"
          style={{ ...pixelBox(placeholder), zIndex: 0 }}
        />
      )}

      {layout.map((item) => {
        // Detached (floating/minimized): caller positions it via styleOverride; it
        // stays mounted but is out of grid flow, with no grid drag/resize.
        const override = styleOverride?.(item) ?? null;
        const detached = override != null;
        const isActive = !detached && live?.id === item.id;
        let style: CSSProperties;
        if (detached) {
          style = { zIndex: zOrder[item.id] ?? 1, ...override };
        } else {
          style = {
            ...pixelBox(item),
            zIndex: zOrder[item.id] ?? 1,
            transform: "translate3d(0,0,0)",
            transition: isActive || !settled ? "none" : FRAME_TRANSITION,
          };
          if (isActive && live) {
            if (live.mode === "drag") {
              // A subtle lift while dragging gives the window a "picked up" feel; it
              // eases back to scale(1) on release via FRAME_TRANSITION.
              style.transform = `translate3d(${live.dx}px, ${live.dy}px, 0) scale(1.02)`;
              style.willChange = "transform";
            } else {
              style.width = live.w;
              style.height = live.h;
              style.willChange = "width, height";
            }
          }
        }

        const handle: GridItemHandle = {
          isActive: !!isActive,
          detached,
          dragHandleProps: {
            onPointerDown: (e) => startInteraction(e, item.id, "drag"),
            onKeyDown: (e) => onHandleKeyDown(e, item.id),
            tabIndex: 0,
            role: "button",
            "aria-label":
              "Move window. Arrow keys move, shift plus arrows resize.",
          },
        };

        return (
          <div
            key={item.id}
            className={detached ? undefined : "absolute"}
            style={style}
            onPointerDown={detached ? undefined : () => bringToFront(item.id)}
          >
            {renderItem(item, handle)}
            {!item.static && !detached && (
              <>
                {/* Right edge → width only. Insets clear the corner so the two
                    handles never overlap (which would flicker the resize cursor). */}
                <div
                  className="absolute top-1 right-0 bottom-8 w-3.5 cursor-ew-resize touch-none"
                  onPointerDown={(e) =>
                    startInteraction(e, item.id, "resize", "x")
                  }
                  aria-hidden
                />
                {/* Bottom edge → height only. */}
                <div
                  className="absolute right-8 bottom-0 left-1 h-3.5 cursor-ns-resize touch-none"
                  onPointerDown={(e) =>
                    startInteraction(e, item.id, "resize", "y")
                  }
                  aria-hidden
                />
                {/* Corner → both axes. A roomy 32px grab zone, glyph hugging the corner. */}
                <div
                  className="absolute right-0 bottom-0 grid size-8 place-items-end p-1.5 cursor-nwse-resize touch-none text-muted-foreground/50 transition-colors hover:text-primary"
                  onPointerDown={(e) =>
                    startInteraction(e, item.id, "resize", "both")
                  }
                  aria-hidden
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M11 4 L4 11 M11 8 L8 11"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface GridWindowProps {
  title: ReactNode;
  icon?: ReactNode;
  dragHandleProps: GridDragHandleProps;
  isActive?: boolean;
  onClose?: () => void;
  className?: string;
  children: ReactNode;
}

/** Standard window chrome for a {@link GridLayout} item: draggable title bar + body. */
export function GridWindow({
  title,
  icon,
  dragHandleProps,
  isActive = false,
  onClose,
  className,
  children,
}: GridWindowProps) {
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card shadow-lg transition-shadow",
        isActive
          ? "border-primary shadow-2xl ring-1 ring-primary/30"
          : "border-border",
        className,
      )}
    >
      <div
        {...dragHandleProps}
        className="flex shrink-0 cursor-grab touch-none items-center justify-between gap-2 border-b border-border bg-secondary/50 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      >
        <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-foreground">
          {icon}
          <span className="truncate">{title}</span>
        </span>
        {onClose && (
          <button
            type="button"
            aria-label="Close window"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </div>
  );
}
