import { ArrowLeft, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatMtps } from "../../utils";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";

interface PaymentsShopHeaderProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
}

export function PaymentsShopHeader({ session }: PaymentsShopHeaderProps) {
  return (
    <header
      className={cn(
        "shrink-0 space-y-4 border-b border-border",
        "px-[clamp(8px,2.4cqmin,14px)] py-[clamp(8px,2cqmin,12px)]",
      )}
    >
      <div className="flex justify-end">
        <Button
          variant={session.autoMode ? "default" : "outline"}
          size="sm"
          onClick={session.toggleAutoMode}
        >
          {session.autoMode && <Zap className="size-3" />}

          {session.autoMode ? "Auto mode ON" : "Auto mode OFF"}
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={session.busy}
          onClick={session.goLobby}
        >
          <ArrowLeft />
          Back
        </Button>

        <span className="wal-mono text-[clamp(10px,2.4cqmin,12px)] text-muted-foreground">
          {`Budget ${formatMtps(session.depositBudget)} MTPS`}
        </span>
      </div>
    </header>
  );
}
