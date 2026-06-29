import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatMtps } from "../../utils";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";

interface PaymentsLobbyProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
}

export function PaymentsLobby({ session }: PaymentsLobbyProps) {
  const disabled = !session.walletConnected || session.phase === "opening";
  const opening = session.phase === "opening";

  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <div className="wal-glow flex w-full max-w-sm flex-col gap-5 rounded-[20px] border border-border bg-card/75 p-6 backdrop-blur-xl">
        <div className="flex flex-col gap-2">
          <p className="wal-eyebrow">Off-chain checkout</p>
          <h1 className="wal-display text-[clamp(1.6rem,6cqmin,2.25rem)] text-foreground">
            Tunnel <span className="wal-gradient-text">Mart</span>
          </h1>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">
          Shop with a budget of{" "}
          <span className="wal-mono text-foreground">
            {formatMtps(session.depositBudget)} MTPS
          </span>
          . Browse the aisles, add items to your cart, and check out with
          instant micro-payments.
        </p>

        {!session.walletConnected && (
          <p className="text-sm text-destructive">
            Connect your wallet to go shopping.
          </p>
        )}

        {session.error && (
          <p className="text-sm text-destructive">{session.error}</p>
        )}

        <Button
          className="w-full"
          size="lg"
          disabled={disabled}
          onClick={session.goShop}
        >
          {opening && <Loader2 className="animate-spin" />}
          {opening ? "Opening tunnel" : "Go shop"}
        </Button>
      </div>
    </div>
  );
}
