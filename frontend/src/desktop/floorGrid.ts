import type { GridBreakpoint, GridItem } from "@/components/ui/grid-layout";

/**
 * Shared grid primitives for the arena floors. Both {@link ArenaView} (window
 * state + tools) and {@link WorkspaceFloor} (the per-workspace renderer) import
 * from here so the normal floor and the grouped "All" floor pack, size, and tile
 * windows identically. Kept dependency-free (only grid-layout types) so neither
 * floor module imports the other.
 */

/** The game id embedded in a window id (`blackjack#ab12` → `blackjack`). */
export const gameOf = (instanceId: string) => instanceId.split("#")[0];

// Windows carry an instance id so the same game can open many times: a seeded
// window is just its `gameId`; added duplicates are `gameId#<uuid>`.
export const newInstanceId = (gameId: string) =>
  `${gameId}#${crypto.randomUUID().slice(0, 8)}`;

export const clampNum = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/** Returns a copy of `obj` without `id` (or `obj` itself if absent). */
export function dropKey<T>(
  obj: Record<string, T>,
  id: string,
): Record<string, T> {
  if (obj[id] == null) return obj;
  const next = { ...obj };
  delete next[id];
  return next;
}

/** A window popped out of the grid: free-floating, draggable, stackable. */
export type FloatState = {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  item: GridItem;
};

// Every game window opens at the SAME size so the floor reads as one uniform grid
// rather than a patchwork of per-game footprints. minW/minH is the global resize floor:
// 4 cols × 5 rows is the smallest a game stays usable — below it the boards/controls
// collapse (e.g. battleship's two boards stack into a broken sliver at 3 cols / 3 rows),
// so the engine clamps resize there and new windows open at that size.
export const TILE = { w: 4, h: 5, minW: 4, minH: 5 } as const;

// Column counts are all multiples of TILE.w (4) so uniform windows always pack into
// full rows: 3 per row on a wide floor, 2 on a tablet-width dock, 1 on a narrow one.
export const BREAKPOINTS: GridBreakpoint[] = [
  { minWidth: 0, cols: 4 },
  { minWidth: 640, cols: 8 },
  { minWidth: 1024, cols: 12 },
];

// Row height in pixels; TILE.h (5) × ROW_HEIGHT (72) ≈ 360px, a game's usable floor.
export const ROW_HEIGHT = 72;

// Tile against the widest breakpoint so auto-arrange fills the full row.
const COLS = Math.max(...BREAKPOINTS.map((b) => b.cols));

/**
 * First-fit pack: drop each window into the first free grid slot, scanning rows
 * top-to-bottom and columns left-to-right. Unlike a plain row-packer this fills
 * holes — e.g. the empty cells to the right of a tall window's lower half — so a
 * newly added or re-arranged window slots into space on an existing row before
 * opening a new row below. Footprints never overlap; each window keeps its size.
 */
export function tile(items: GridItem[]): GridItem[] {
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
