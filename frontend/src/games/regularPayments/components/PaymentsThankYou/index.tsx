import { useEffect, useState } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatGrammarLength, formatMtps } from "../../utils";
import type { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";

const AUTO_RETURN_SEC = 3;

interface PaymentsThankYouProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
}

export function PaymentsThankYou({ session }: PaymentsThankYouProps) {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_RETURN_SEC);

  useEffect(() => {
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          session.completeRound();
          return 0;
        }

        return s - 1;
      });
    }, 1000);

    return () => clearInterval(id);
  }, [session.completeRound]);

  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <div className="wal-glow flex w-full max-w-sm flex-col items-center gap-5 rounded-[20px] border border-border bg-card/75 p-6 text-center backdrop-blur-xl">
        <div
          className="flex size-14 items-center justify-center rounded-full border border-border"
          style={{
            background: "color-mix(in oklab, var(--wal-mint) 18%, transparent)",
          }}
        >
          <Check className="size-7 text-(--wal-mint)" />
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="wal-display text-[clamp(1.2rem,4.5cqmin,1.5rem)] text-foreground">
            Thank you for shopping
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Your off-chain payment completed.
          </p>
        </div>

        <p className="wal-mono text-sm tabular-nums text-foreground">
          {`${formatMtps(session.cartTotal)} MTPS · ${session.cart.length} ${formatGrammarLength("line", session.cart.length)}`}
        </p>

        {session.settleUrl && (
          <a
            href={session.settleUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            View settle tx
          </a>
        )}

        <Button className="w-full" size="lg" onClick={session.completeRound}>
          {`Go lobby (${secondsLeft}s)`}
        </Button>
      </div>
    </div>
  );
}
