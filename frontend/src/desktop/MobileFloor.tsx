import { Plus } from "lucide-react";

import { get } from "../games/registry";
import type { Workspace } from "../games/types";
import type { GridItem } from "@/components/ui/grid-layout";
import { Button } from "@/components/ui/button";
import { GameWindow } from "./GameWindow";
import { GameContent } from "./GameContent";
import { GameTpsBadge } from "./GameTpsBadge";

const WORKSPACE_LABEL: Record<Workspace, string> = {
  games: "Games",
  payment: "Payments",
  chat: "Chat",
};

/** The game id embedded in a window id (`blackjack#ab12` → `blackjack`). */
const gameOf = (instanceId: string) => instanceId.split("#")[0];

/**
 * The phone floor (< lg) for one workspace: every window of that floor stacked as a
 * vertical scroll, each auto-playing on mount exactly like the desktop floor. Both
 * breakpoints read the same per-workspace `layout`, so the phone just reskins the
 * desktop floor rather than running a separate one-game picker.
 *
 * Each card reuses the desktop {@link GameWindow} chrome with only a close action —
 * no drag/minimize/maximize (those are floor gestures that don't apply to a phone
 * scroll). "Add game" opens the picker sheet; closing a card tears its session down.
 */
export function MobileFloor({
  items,
  workspace,
  onClose,
  onAdd,
}: {
  items: GridItem[];
  workspace: Workspace;
  onClose: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="bg-dot-grid flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-4 pb-2">
        <div className="flex min-w-0 flex-col">
          <span className="wal-eyebrow text-muted-foreground">
            MillionsTPS · {workspace}
          </span>
          <h1 className="wal-display text-xl">{WORKSPACE_LABEL[workspace]}</h1>
        </div>
        <Button
          size="sm"
          onClick={onAdd}
          data-testid="mobile-add-game"
          className="h-9 shrink-0 gap-1.5 px-3 text-sm font-semibold"
        >
          <Plus className="size-4" /> Add game
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No games open on this floor.
          </p>
          <Button onClick={onAdd} className="gap-1.5">
            <Plus className="size-4" /> Add game
          </Button>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
          {items.map((item) => {
            const mod = get(gameOf(item.id));
            if (!mod) return null;
            return (
              <li key={item.id} className="h-[78vh] min-h-[480px]">
                <GameWindow
                  title={mod.name}
                  icon={<GameTpsBadge gameId={gameOf(item.id)} />}
                  domId={item.id}
                  category={workspace}
                  onClose={() => onClose(item.id)}
                >
                  <GameContent
                    gameId={gameOf(item.id)}
                    windowId={item.id}
                    onClose={onClose}
                  />
                </GameWindow>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
