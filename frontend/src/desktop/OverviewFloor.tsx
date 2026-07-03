import { ArrowRight } from "lucide-react";

import { get } from "../games/registry";
import type { Workspace } from "../games/types";
import { cn } from "@/lib/utils";
import { CATEGORY_STYLE } from "./categoryStyle";
import { GameContent } from "./GameContent";
import { GameTpsBadge } from "./GameTpsBadge";
import { GameWindow } from "./GameWindow";

/** The game id embedded in a window id (`blackjack#ab12` → `blackjack`). */
const gameOf = (instanceId: string) => instanceId.split("#")[0];

/** Uniform tile height — a real floor window's footprint (TILE.h 5 × rowHeight 72) — so columns
 *  balance by tile count and the tiles read the same size as on a normal floor. */
const TILE_H = "h-[360px]";

/** One window in an overview column, tagged with its OWN category (drives the tile's color). */
export interface OverviewItem {
  id: string;
  ws: Workspace;
}

/** One overview column: a category's heading (label + link to that floor) and the tiles
 *  rendered in it. */
export interface OverviewColumn {
  ws: Workspace;
  label: string;
  items: OverviewItem[];
}

/**
 * The PHONE "All" view: every workspace's open windows under category headings (payments first —
 * see OVERVIEW_GROUPS in Desktop.tsx), as one vertical scroll (the columns collapse to a single
 * one at phone width). The desktop All view is the no-scroll {@link OverviewDashboard} instead.
 *
 * Static tiles (close-only, no drag — floor gestures don't apply to a phone scroll). It mounts the
 * same {@link GameWindow} + {@link GameContent} a floor does, so games keep auto-playing and
 * reporting real per-game TPS. Rendered exclusively (the per-workspace floor is unmounted while
 * this is on screen), so reusing the real window ids never double-mounts a session.
 */
export function OverviewFloor({
  columns,
  closers,
  onOpenWorkspace,
}: {
  columns: OverviewColumn[];
  /** Stable per-category closer, keyed by the window's own workspace — {@link GameContent}
   *  memoizes on it, so a churning closer would re-mount every game each render. */
  closers: Record<Workspace, (id: string) => void>;
  onOpenWorkspace: (ws: Workspace) => void;
}) {
  return (
    <div className="bg-dot-grid h-full overflow-y-auto p-2">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {columns.map((col) => (
          <section key={col.ws} className="flex flex-col gap-2">
            <header className="flex items-center px-0.5 pb-0.5">
              <button
                type="button"
                onClick={() => onOpenWorkspace(col.ws)}
                className="group inline-flex items-center gap-1.5 text-sm font-semibold text-foreground/70 transition-colors hover:text-foreground"
              >
                <span
                  className={cn(
                    "size-2 rounded-full",
                    CATEGORY_STYLE[col.ws].fill,
                  )}
                />
                {col.label}
                <ArrowRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </header>

            {col.items.length === 0 ? (
              <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
                Nothing open in {col.label}
              </div>
            ) : (
              col.items.map((item) => {
                const mod = get(gameOf(item.id));
                if (!mod) return null;
                return (
                  <div key={item.id} className={TILE_H}>
                    <GameWindow
                      title={mod.name}
                      icon={<GameTpsBadge gameId={gameOf(item.id)} />}
                      domId={item.id}
                      category={item.ws}
                      onClose={() => closers[item.ws](item.id)}
                    >
                      <GameContent
                        gameId={gameOf(item.id)}
                        windowId={item.id}
                        onClose={closers[item.ws]}
                      />
                    </GameWindow>
                  </div>
                );
              })
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
