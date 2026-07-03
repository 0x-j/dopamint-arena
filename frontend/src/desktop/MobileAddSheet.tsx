import { Dialog as DialogPrimitive } from "radix-ui";

import { GameIcon } from "../games/GameIcon";
import { listByWorkspace } from "../games/registry";
import type { GameModule, Workspace } from "../games/types";
import { DeviceCapNotice } from "./DeviceCapNotice";

/** Top-to-bottom groups in the picker. Each maps to a workspace; opening any card
 *  switches to that workspace (see `onOpen` in Desktop). Mirrors {@link AddAppDialog}. */
const GROUPS: { workspace: Workspace; label: string }[] = [
  { workspace: "games", label: "Games" },
  { workspace: "payment", label: "Payment" },
  { workspace: "chat", label: "Chat" },
];

/**
 * The phone game picker as a bottom sheet — a touch-native counterpart to the
 * desktop {@link AddAppDialog} modal. Shares the same Add state (`open`) and
 * `onOpen` action; the breakpoint just swaps which one renders (see Desktop). It
 * slides up from the screen edge and lists every launchable surface grouped
 * Games / Payment / Chat; tapping a card opens it in its workspace.
 */
export function MobileAddSheet({
  open,
  onOpenChange,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (module: GameModule) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col gap-3 rounded-t-2xl border-t border-border bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl outline-none data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom">
          <div
            aria-hidden
            className="mx-auto h-1.5 w-10 shrink-0 rounded-full bg-border"
          />
          <DialogPrimitive.Title className="text-base font-semibold">
            Add a game
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Open a game, payment, or chat — it lands in its own workspace.
          </DialogPrimitive.Description>
          <DeviceCapNotice />
          <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
            {GROUPS.map((group) => {
              const modules = listByWorkspace(group.workspace);
              if (modules.length === 0) return null;
              return (
                <section key={group.workspace} className="flex flex-col gap-2">
                  <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {group.label}
                  </h3>
                  <div className="grid grid-cols-2 gap-2">
                    {modules.map((module) => (
                      <button
                        key={module.id}
                        type="button"
                        data-testid={`mobile-launch-${module.id}`}
                        onClick={() => onOpen(module)}
                        className="flex items-center gap-2 rounded-xl border border-border bg-card p-3 text-left text-sm transition-colors hover:border-primary/50 hover:bg-secondary active:scale-[0.99]"
                      >
                        <GameIcon game={module} className="size-8 shrink-0" />
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
