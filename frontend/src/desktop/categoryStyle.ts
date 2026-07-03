import type { Workspace } from "../games/types";

/**
 * Per-category (workspace) identity styling, as Tailwind utilities off the registered `cat-*`
 * theme colors (see the `--cat-*` block in styles/index.css). The fills are CONSTANT across themes
 * (one saturated set that reads on both cream and ink), so anything ON a fill uses the constant
 * cream `text-cat-foreground`. Each fill is a flat color layered under a subtle same-hue gradient
 * (`--cat-*-grad`) — the flat class is the graceful fallback if `color-mix` is unavailable; the same
 * fill doubles as the category dot on a neutral surface. Class strings are LITERAL so Tailwind's
 * scanner emits them.
 *
 * Category → color: Game = pink, Payment = mint, Chat = blue (the aurora accent triad).
 */
export interface CategoryStyle {
  label: string;
  /** Bold fill (flat fallback + gradient) for a NAV surface (the workspace tab pills, category dot);
   *  pair text with `text-cat-foreground`. */
  fill: string;
  /** Soft category wash for repeated chrome (game-window title bars) — quiet identity that doesn't
   *  compete with the game; pair with normal `text-foreground`. */
  tint: string;
}

export const CATEGORY_STYLE: Record<Workspace, CategoryStyle> = {
  games: {
    label: "Game",
    fill: "bg-cat-game bg-[image:var(--cat-game-grad)]",
    tint: "bg-cat-game/15",
  },
  payment: {
    label: "Payment",
    fill: "bg-cat-payment bg-[image:var(--cat-payment-grad)]",
    tint: "bg-cat-payment/15",
  },
  chat: {
    label: "Chat",
    fill: "bg-cat-chat bg-[image:var(--cat-chat-grad)]",
    tint: "bg-cat-chat/15",
  },
};
