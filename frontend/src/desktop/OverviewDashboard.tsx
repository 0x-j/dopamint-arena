import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Plus } from "lucide-react";

import { get } from "../games/registry";
import type { Workspace } from "../games/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CATEGORY_STYLE } from "./categoryStyle";
import { GameContent } from "./GameContent";
import { GameTpsBadge } from "./GameTpsBadge";
import { GameWindow } from "./GameWindow";
import { gameOf } from "./floorGrid";
import type { OverviewItem } from "./OverviewFloor";

/** Natural layout size a tile's body renders at before scaling — at the 480×360 floor below which
 *  game UIs collapse (see the float-resize MIN_W/MIN_H rationale in Desktop.tsx). A tile narrower
 *  than this renders the game at 480 wide and CSS-scales it down, so even a small tile shows a
 *  usable, correctly-proportioned live game instead of a broken squeezed one. */
const BASE_W = 480;
const BASE_H = 360;
const GAP = 8;
/** Compact window-header height (px), excluded from the body when scoring tile scale. */
const HEADER_PX = 28;

/** The column count that maximizes each tile's render scale: for every candidate column count,
 *  size the resulting tile and score it by how large the natural 480×360 body would paint inside
 *  it — the best grid is the one whose tiles show the biggest game. */
function bestCols(n: number, w: number, h: number): number {
  let best = 1;
  let bestScale = -Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tileW = (w - GAP * (cols - 1)) / cols;
    const tileH = (h - GAP * (rows - 1)) / rows;
    if (tileW <= 0 || tileH <= 0) continue;
    const scale = Math.min(tileW / BASE_W, (tileH - HEADER_PX) / BASE_H);
    if (scale > bestScale) {
      bestScale = scale;
      best = cols;
    }
  }
  return best;
}

/** Renders the game at its natural ≥480px-wide layout and CSS-scales it to fill the tile body.
 *  Scale is capped at 1 — a roomy tile just gets the normal responsive layout, never a blurry
 *  upscale. Pointer events keep working through the transform (browsers hit-test scaled trees). */
function ScaledBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setBox({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = box ? Math.min(1, box.w / BASE_W) : 1;
  return (
    <div ref={ref} className="h-full w-full overflow-hidden">
      {box && box.w > 0 && box.h > 0 && (
        <div
          style={{
            width: box.w / scale,
            height: box.h / scale,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** One legend entry: a category's dot + label, linking to its workspace. */
export interface OverviewGroupInfo {
  ws: Workspace;
  label: string;
}

/**
 * The desktop "All" view: every open window — payments first (top-left), then games, then chat —
 * as ONE no-scroll dashboard wall. The grid picks the column count that maximizes tile size for
 * the current floor area, and each tile scales its game down from a natural ≥480px layout
 * ({@link ScaledBody}), so everything fits the viewport at once and still reads as a live game.
 * Compact window chrome (slim header, close-only) keeps the wall dense; category identity comes
 * from each tile's own color. A slim legend row up top carries the per-category links.
 *
 * Static tiles (no drag) — the per-workspace tabs keep the full draggable floor. It mounts the
 * same {@link GameWindow} + {@link GameContent} a floor does, rendered exclusively (the
 * per-workspace floor is unmounted while this is on screen), so reusing the real window ids never
 * double-mounts a session. The phone All view is {@link OverviewFloor} (one scrolled column).
 */
export function OverviewDashboard({
  groups,
  items,
  closers,
  onOpenWorkspace,
  onAdd,
}: {
  groups: OverviewGroupInfo[];
  items: OverviewItem[];
  /** Stable per-category closer, keyed by the window's own workspace — {@link GameContent}
   *  memoizes on it, so a churning closer would re-mount every game each render. */
  closers: Record<Workspace, (id: string) => void>;
  onOpenWorkspace: (ws: Workspace) => void;
  onAdd: () => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    setArea({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(([entry]) => {
      setArea({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols =
    area && items.length ? bestCols(items.length, area.w, area.h) : 1;

  return (
    <div className="bg-dot-grid flex h-full min-h-0 flex-col gap-2 p-2">
      <header className="flex shrink-0 items-center gap-4 px-0.5">
        {groups.map((g) => (
          <button
            key={g.ws}
            type="button"
            onClick={() => onOpenWorkspace(g.ws)}
            className="group inline-flex items-center gap-1.5 text-xs font-semibold text-foreground/70 transition-colors hover:text-foreground"
          >
            <span
              className={cn("size-2 rounded-full", CATEGORY_STYLE[g.ws].fill)}
            />
            {g.label}
            <ArrowRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}
      </header>

      {items.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          Nothing open anywhere.
          <Button variant="outline" size="sm" onClick={onAdd}>
            <Plus /> Add an app
          </Button>
        </div>
      ) : (
        <div ref={gridRef} className="min-h-0 flex-1">
          {area && (
            <div
              className="grid h-full w-full"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridAutoRows: "minmax(0, 1fr)",
                gap: GAP,
              }}
            >
              {items.map((item) => {
                const mod = get(gameOf(item.id));
                if (!mod) return null;
                return (
                  <div key={item.id} className="min-h-0 min-w-0">
                    <GameWindow
                      compact
                      title={mod.name}
                      icon={<GameTpsBadge gameId={gameOf(item.id)} />}
                      domId={item.id}
                      category={item.ws}
                      onClose={() => closers[item.ws](item.id)}
                    >
                      <ScaledBody>
                        <GameContent
                          gameId={gameOf(item.id)}
                          windowId={item.id}
                          onClose={closers[item.ws]}
                        />
                      </ScaledBody>
                    </GameWindow>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
