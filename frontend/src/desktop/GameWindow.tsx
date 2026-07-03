import { useEffect, useRef, type ReactNode } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { engineClient } from "@/engine/engineClient";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { GridDragHandleProps } from "@/components/ui/grid-layout";
import type { Workspace } from "../games/types";
import { CATEGORY_STYLE } from "./categoryStyle";

/** Pre-render band (IntersectionObserver `rootMargin`) outside the viewport: a window within this
 *  distance of being revealed keeps painting, so it's already live the instant it scrolls into view —
 *  no catch-up frame. ~one game-window tall: big enough to hide the reveal, small enough that far-off
 *  windows in a many-window "All view" still virtualize (the whole point of ADR-0030). */
const RENDER_PRERENDER_MARGIN = "600px";

/** Small header action; stops pointer-down so it doesn't start a window drag. Muted-gray on the
 *  soft-tinted title bar, so it reads without shouting. */
function HeaderButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClick}
          className={cn(
            "grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
            danger && "hover:bg-destructive/15 hover:text-destructive",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Window chrome for a desktop game: a centered title bar (also the drag handle)
 * with minimize / maximize / close actions that reveal on hover. Minimize hides
 * the window off the floor (managed by the parent); it is re-opened from the
 * floor's Panels menu, not from an in-place collapsed bar. When `onRestore` is
 * given (the window is maximized to fill the floor) the maximize action becomes
 * a restore-down action instead.
 */
export function GameWindow({
  title,
  icon,
  domId,
  category,
  compact = false,
  dragHandleProps,
  isActive = false,
  onMinimize,
  onMaximize,
  onRestore,
  onClose,
  className,
  children,
}: {
  title: string;
  icon?: ReactNode;
  /** Marks the root with `data-window` so the parent can read its rect (minimize flight). */
  domId?: string;
  /** The game's workspace, for the soft category wash on the title bar. Omitted ⇒ neutral chrome. */
  category?: Workspace;
  /** Slim chrome for dense dashboard tiles (the All wall): shorter header, smaller title. */
  compact?: boolean;
  dragHandleProps?: GridDragHandleProps;
  isActive?: boolean;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onRestore?: () => void;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const cat = category ? CATEGORY_STYLE[category] : null;
  // Render virtualization (ADR-0030): report on-screen/off-screen to the engine so an off-screen
  // window (hidden workspace `display:none`, minimized, or scrolled away — all collapse to a single
  // IntersectionObserver signal) keeps its match running in the worker but stops painting. `domId`
  // is the engine window id (WorkspaceFloor passes `item.id` to both `domId` and `windowId`).
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!domId || !el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          engineClient.setWindowVisible(domId, e.isIntersecting);
      },
      // Pre-render a band just outside the viewport (`rootMargin`) so a window is already LIVE by the
      // time it scrolls into view — no visible catch-up frame when the user reveals it. Only windows
      // well off-screen stay virtualized; `threshold: 0` still resumes on the first exposed pixel.
      { threshold: 0, rootMargin: RENDER_PRERENDER_MARGIN },
    );
    obs.observe(el);
    return () => {
      obs.disconnect();
      engineClient.setWindowVisible(domId, true); // unmount: don't strand the slot as hidden
    };
  }, [domId]);

  return (
    <div
      ref={rootRef}
      data-window={domId}
      className={cn(
        "group/window flex h-full min-h-0 w-full flex-col overflow-hidden rounded-none border bg-card shadow-lg transition-shadow",
        isActive
          ? "border-primary shadow-2xl ring-1 ring-primary/30"
          : "border-border",
        className,
      )}
    >
      {/* The title bar carries the category identity QUIETLY — a soft wash of the same hue the
          workspace tabs fill boldly, with normal foreground text. It's repeated chrome across every
          window, so it must not compete with the game; the tabs stay the loud, saturated surface. */}
      <header
        {...dragHandleProps}
        className={cn(
          "relative flex shrink-0 items-center justify-center border-b border-border font-semibold text-foreground",
          compact ? "h-7 px-1.5 text-[11px]" : "h-9 px-2 text-xs",
          cat ? cat.tint : "bg-secondary/40",
          dragHandleProps &&
            "cursor-grab touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
        )}
      >
        <span className="flex max-w-[60%] items-center gap-1.5">
          {icon}
          <span className="truncate">{title}</span>
        </span>

        <div className="absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/window:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
          {onMinimize && (
            <HeaderButton label="Minimize (hide)" onClick={onMinimize}>
              <Minus className="size-3.5" />
            </HeaderButton>
          )}
          {onRestore ? (
            <HeaderButton label="Restore" onClick={onRestore}>
              <Minimize2 className="size-3.5" />
            </HeaderButton>
          ) : (
            onMaximize && (
              <HeaderButton label="Maximize" onClick={onMaximize}>
                <Maximize2 className="size-3.5" />
              </HeaderButton>
            )
          )}
          <HeaderButton label="Close window" onClick={onClose} danger>
            <X className="size-3.5" />
          </HeaderButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}
