import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GameIcon } from "../games/GameIcon";
import { listByWorkspace } from "../games/registry";
import type { GameModule, Workspace } from "../games/types";
import { DeviceCapNotice } from "./DeviceCapNotice";

/** Top-to-bottom groups in the picker. Each maps to a workspace; opening any card
 *  switches to that workspace (see `onOpen` in Desktop). */
const GROUPS: { workspace: Workspace; label: string }[] = [
  { workspace: "games", label: "Games" },
  { workspace: "payment", label: "Payment" },
  { workspace: "chat", label: "Chat" },
];

/**
 * The app picker (replaces the old command palette): a responsive dialog that lists
 * every launchable surface grouped Games / Payment / Chat. Selecting a card opens it
 * in its workspace and switches there — it never resets the workspace you came from.
 */
export function AddAppDialog({
  open,
  onOpenChange,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (module: GameModule) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an app</DialogTitle>
          <DialogDescription>
            Open a game, payment, or chat — it lands in its own workspace.
          </DialogDescription>
        </DialogHeader>
        <DeviceCapNotice />
        <div className="-mx-1 flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-1 py-1">
          {GROUPS.map((group) => {
            const modules = listByWorkspace(group.workspace);
            if (modules.length === 0) return null;
            return (
              <section key={group.workspace} className="flex flex-col gap-2">
                <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.label}
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {modules.map((module) => (
                    <button
                      key={module.id}
                      type="button"
                      data-testid={`launch-${module.id}`}
                      onClick={() => onOpen(module)}
                      className="flex items-center gap-2 rounded-lg border border-border bg-card p-2.5 text-left text-sm transition-colors hover:border-primary/50 hover:bg-secondary active:scale-[0.99]"
                    >
                      <GameIcon game={module} className="size-7 shrink-0" />
                      <span className="min-w-0 truncate font-medium">
                        {module.name}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
