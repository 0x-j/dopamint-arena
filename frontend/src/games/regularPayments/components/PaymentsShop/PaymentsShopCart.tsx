import { Loader2, ShoppingCart, Trash2 } from "lucide-react";
import type { RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { formatGrammarLength, formatMtps } from "../../utils";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";

interface PaymentsShopCartProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
  cartTargetRef?: RefObject<HTMLSpanElement | null>;
}

export function PaymentsShopCart({
  session,
  cartTargetRef,
}: PaymentsShopCartProps) {
  const progressPct = Math.min(
    100,
    (Number(session.paidSoFar) / Number(session.depositBudget)) * 100,
  );

  const paying = session.phase === "paying" || session.phase === "settling";

  return (
    <div className="shrink-0 border-t border-border bg-card/80">
      <div
        className={cn(
          "px-[clamp(10px,2.6cqmin,14px)] py-[clamp(8px,2cqmin,12px)]",
          "space-y-2.5",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              "text-[clamp(12px,3cqmin,15px)]",
            )}
          >
            <span ref={cartTargetRef} className="shrink-0">
              <ShoppingCart className="size-4 text-muted-foreground" />
            </span>

            <span className="truncate text-foreground">
              {`${session.itemCount} ${formatGrammarLength("item", session.itemCount)} · `}
              <span className="wal-mono tabular-nums">
                {formatMtps(session.cartTotal)} MTPS
              </span>
            </span>
          </div>

          <Button
            size="sm"
            disabled={!session.itemCount || session.busy}
            onClick={() => session.payNow()}
          >
            {paying && <Loader2 className="animate-spin" />}

            {(function () {
              switch (session.phase) {
                case "paying":
                  return "Paying";

                case "settling":
                  return "Settling";

                default:
                  return "Pay now";
              }
            })()}
          </Button>
        </div>

        {progressPct ? (
          <div>
            <Progress
              value={progressPct}
              className="h-2 [&_[data-slot=progress-indicator]]:transition-none"
            />

            <p className="wal-mono mt-1.5 text-[clamp(9px,2.2cqmin,11px)] text-muted-foreground">
              {`Paid ${formatMtps(session.paidSoFar)} MTPS`}
            </p>
          </div>
        ) : null}
      </div>

      <ul
        className={cn(
          "px-[clamp(10px,2.6cqmin,14px)] pb-[clamp(6px,1.6cqmin,10px)]",
          "max-h-22 overflow-y-auto",
          "flex flex-col gap-2",
        )}
      >
        {session.cart.map((line) => (
          <li
            key={line.id}
            className={cn(
              "flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5",
            )}
          >
            <span className="text-lg leading-none">{line.emoji}</span>

            <span className="min-w-0 flex-1 truncate text-[clamp(10px,2.6cqmin,12px)] text-foreground">
              {line.qty}× {line.name}
            </span>

            <div className="flex items-center gap-1">
              <span className="wal-mono text-[clamp(10px,2.4cqmin,12px)] text-muted-foreground">
                {formatMtps(line.priceMtps * BigInt(line.qty))} MTPS
              </span>

              <button
                type="button"
                className="shrink-0 rounded-md p-0.5 text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-45"
                disabled={session.busy}
                onClick={() => {
                  if (session.autoMode) session.toggleAutoMode();

                  session.removeFromCart(line.id);
                }}
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
