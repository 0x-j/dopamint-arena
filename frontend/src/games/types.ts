import type { ComponentType } from "react";

/** The arena workspace a module belongs to. The desktop tab bar and the Add dialog
 *  group modules by this; `games` is the multi-window floor, `payment`/`chat` are
 *  focused single-surface views. */
export type Workspace = "games" | "payment" | "chat";

/** Props a game's `Window` component receives (distinct from the GameWindow chrome). */
export interface GameWindowProps {
  windowId: string;
  onClose: () => void;
}

/**
 * A pluggable game. Adding one = create a folder under games/, implement a
 * `Window` component, and call `register()` (see games/microPayments for the
 * reference template). The catalog lists modules and launching renders `Window`
 * inside the desktop window chrome — no edits to Desktop/Catalog/panels needed.
 */
export interface GameModule {
  /** Stable kebab-case id, unique across the registry. */
  id: string;
  name: string;
  /** One-line pitch shown under the name in the mobile game picker. */
  description?: string;
  /** Short glyph/emoji — fallback when the logo image is unavailable. */
  icon: string;
  /** Logo image path (served from public/, e.g. `/games/blackjack.png`). */
  image: string;
  Window: ComponentType<GameWindowProps>;
  /** When false, the module is registered (so `get()` can render it — e.g. as a
   *  default floating widget) but hidden from the catalog `list()` (picker, mobile
   *  list, filter tabs, seed). Defaults to true. */
  catalog?: boolean;
  /** Which arena workspace this module opens in. Defaults to `games` (the window
   *  floor). `payment`/`chat` route the Add dialog to their focused workspace view. */
  workspace?: Workspace;
  /** The backend arena/`profile_for` id(s) (underscore form, e.g. `quantum_poker`) when this game is
   *  wired into the co-located fleet. Set ONLY for games with a working Rust↔TS parity + fleet
   *  profile + FE arena consumer; the centralized batched entry enumerates these to deposit every
   *  game's seat A in ONE PTB. Absent ⇒ not in the arena batch yet. An ARRAY when one module hosts
   *  multiple protocols (e.g. tic-tac-toe + caro share one window) — all are allocated; the window
   *  consumes whichever variant it's currently showing. */
  arenaGameId?: string | string[];
  // Window size is uniform across games — the desktop opens every window at the same
  // tile size (see TILE in desktop/floorGrid.ts), so games no longer declare their own footprint.
  // Deferred until games drive the engine:
  //   protocolFactory?: () => Protocol<unknown, unknown>;  // from sui-tunnel-ts
}
