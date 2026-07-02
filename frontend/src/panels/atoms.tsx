/** Small shared bits used across the telemetry panels. */
import { Check, X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { truncateMiddle } from "@/lib/suivision";

/**
 * Transaction status as a filled badge: a solid green ✓ on success, a solid red
 * ✗ on failure. The glyph uses `text-background` so it stays legible on both the
 * light (dark-green/red) and dark (mint/salmon) success/destructive fills.
 */
export function StatusIcon({ status }: { status: "Success" | "Failed" }) {
  const ok = status === "Success";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={status}
          className={cn(
            "grid size-4 place-items-center rounded-full text-background",
            ok ? "bg-success" : "bg-destructive",
          )}
        >
          {ok ? (
            <Check className="size-2.5" strokeWidth={3.5} />
          ) : (
            <X className="size-2.5" strokeWidth={3.5} />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{status}</TooltipContent>
    </Tooltip>
  );
}

/** A truncated hash/address linking to its SuiVision page. */
export function HashLink({
  value,
  href,
  label,
}: {
  value: string;
  href: string;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="wal-mono text-[11px] text-foreground/80 transition-colors hover:text-primary hover:underline"
        >
          {truncateMiddle(value)}
        </a>
      </TooltipTrigger>
      <TooltipContent>Open {label} in SuiVision</TooltipContent>
    </Tooltip>
  );
}

/** Pulsing "LIVE" indicator: the backend SSE feed is connected and pushing frames. */
export function LiveBadge() {
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-success">
      <span className="size-1.5 animate-pulse rounded-full bg-success" />
      LIVE
    </span>
  );
}

/** Muted "Offline" indicator: no live backend frame yet (connecting or backend down). */
export function OfflineBadge() {
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
      <span className="size-1.5 rounded-full bg-muted-foreground" />
      Offline
    </span>
  );
}

/** Signed currency string: success for credits, destructive for debits. */
export function Amount({ value }: { value: string }) {
  const negative = value.trim().startsWith("-");
  return (
    <span className={negative ? "text-destructive" : "text-success"}>
      {value}
    </span>
  );
}
