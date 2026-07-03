import {
  Gamepad2,
  LayoutDashboard,
  LayoutGrid,
  MessagesSquare,
  PanelBottom,
  PanelRight,
  Plus,
  RotateCcw,
  Trash2,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MobileSection } from "./AppShell";

type DockSide = "bottom" | "right";

/**
 * Desktop workspaces switch from a tab bar at the top of the arena body — chrome
 * INSIDE the `/` route, not the global header. Each tab is just the `section`
 * search param (so refresh / share keeps the workspace); the telemetry dock below
 * stays put across all four. The right side carries the floor's controls — the
 * layout-tools menu and a primary `+ Add` — so the floor itself stays clean. On the
 * "All" floor those controls act on every group at once (see `toolTargets` in
 * Desktop.tsx); on a single workspace they act on just that floor.
 */
// Every tab is a category-filled pill all the time — the colorful bar is the point. The `cat-*`
// fills are CONSTANT (one saturated design-system set that reads on both cream and ink) with a
// subtle same-hue gradient, and cream `cat-foreground` text, so the pills read in both themes with
// no per-theme flip. The ACTIVE tab is set apart by intensity, not an underline: idle pills sit
// dimmed and flat, the active one is full-strength with a `cat-foreground` ring and a lifted shadow.
// `solid` = flat fallback + gradient; class strings are LITERAL so Tailwind's scanner emits them.
const WORKSPACE_TABS: {
  section: MobileSection;
  label: string;
  icon: LucideIcon;
  solid: string;
}[] = [
  // The aggregate "All" floor — every workspace's live windows at once — is the default
  // landing (the bare `/` with no `section` param). Its floor tools act on all groups.
  {
    section: "all",
    label: "All",
    icon: LayoutDashboard,
    solid: "bg-cat-all bg-[image:var(--cat-all-grad)]",
  },
  {
    section: "games",
    label: "Game",
    icon: Gamepad2,
    solid: "bg-cat-game bg-[image:var(--cat-game-grad)]",
  },
  {
    section: "payment",
    label: "Payment",
    icon: Wallet,
    solid: "bg-cat-payment bg-[image:var(--cat-payment-grad)]",
  },
  {
    section: "chat",
    label: "Chat",
    icon: MessagesSquare,
    solid: "bg-cat-chat bg-[image:var(--cat-chat-grad)]",
  },
];

const tabBase =
  "relative inline-flex items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-2.5 text-sm font-semibold text-cat-foreground transition-all";
const tabIdle = "opacity-60 hover:opacity-90";
const tabActive = "shadow-md ring-2 ring-cat-foreground/45";

/** A row action in the layout-tools menu. */
function ToolItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        danger
          ? "text-destructive hover:bg-destructive/10"
          : "text-foreground hover:bg-secondary",
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}

export function WorkspaceTabs({
  active,
  dockSide,
  onAdd,
  onArrange,
  onAddAll,
  onResetLayout,
  onRemoveAll,
  onToggleDock,
}: {
  active: MobileSection;
  dockSide: DockSide;
  onAdd: () => void;
  onArrange: () => void;
  onAddAll: () => void;
  onResetLayout: () => void;
  onRemoveAll: () => void;
  onToggleDock: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const tool = (fn: () => void) => () => {
    fn();
    setToolsOpen(false);
  };
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background/60 px-2 py-1.5 backdrop-blur">
      <nav className="grid flex-1 grid-cols-4 gap-1">
        {WORKSPACE_TABS.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.section;
          return (
            <Link
              key={t.section}
              to="/"
              search={t.section === "all" ? {} : { section: t.section }}
              aria-current={isActive ? "page" : undefined}
              className={cn(tabBase, t.solid, isActive ? tabActive : tabIdle)}
            >
              <Icon className="size-4" />
              {t.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-2">
        <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label="Layout tools"
                  className="size-10 border border-border"
                >
                  <LayoutGrid className="size-5" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>Layout tools</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" side="bottom" className="w-48 p-1">
            <ToolItem
              icon={LayoutGrid}
              label="Auto-arrange"
              onClick={tool(onArrange)}
            />
            <ToolItem icon={Plus} label="Add all" onClick={tool(onAddAll)} />
            <ToolItem
              icon={dockSide === "bottom" ? PanelRight : PanelBottom}
              label={dockSide === "bottom" ? "Dock to right" : "Dock to bottom"}
              onClick={tool(onToggleDock)}
            />
            <ToolItem
              icon={RotateCcw}
              label="Reset layout"
              onClick={tool(onResetLayout)}
            />
            <div className="my-1 border-t border-border" />
            <ToolItem
              icon={Trash2}
              label="Remove all"
              danger
              onClick={tool(onRemoveAll)}
            />
          </PopoverContent>
        </Popover>

        <Button
          size="sm"
          onClick={onAdd}
          aria-label="Add an app"
          data-testid="add-app"
          className="h-10 gap-1.5 px-4 text-sm font-semibold"
        >
          <Plus className="size-5" />
          Add
        </Button>
      </div>
    </div>
  );
}
