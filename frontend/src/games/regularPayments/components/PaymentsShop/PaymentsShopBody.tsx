import { cn } from "@/lib/utils";
import { CATEGORIES, productsForCategory } from "../../utils/catalog";
import { formatMtps } from "../../utils";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";

interface PaymentsShopBodyProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
}

export function PaymentsShopBody({ session }: PaymentsShopBodyProps) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 space-y-5 overflow-y-auto",
        "p-[clamp(8px,2.4cqmin,14px)]",
      )}
    >
      {CATEGORIES.map((cat) => (
        <section key={cat.id}>
          <h2 className="wal-mono mb-2.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            {cat.label}
          </h2>

          <div className="grid grid-cols-4 gap-2.5">
            {productsForCategory(cat.id).map((product) => (
              <button
                key={product.id}
                data-product-id={product.id}
                onClick={() => {
                  // stop Auto mode when click manually
                  if (session.autoMode) session.toggleAutoMode();

                  session.addToCart(product);
                }}
                disabled={session.busy || product.priceMtps > session.balanceA}
                className={cn(
                  "flex flex-col items-center rounded-xl border border-border bg-card p-3 text-center",
                  "transition-colors hover:bg-secondary/80",
                  "disabled:pointer-events-none disabled:opacity-45",
                )}
              >
                <span
                  data-product-emoji
                  className="text-[clamp(1.6rem,6cqmin,2rem)] leading-none"
                >
                  {product.emoji}
                </span>

                <span className="mt-1.5 text-[clamp(11px,2.8cqmin,14px)] font-medium leading-tight text-foreground">
                  {product.name}
                </span>

                <span className="wal-mono mt-0.5 text-[clamp(10px,2.4cqmin,12px)] text-muted-foreground">
                  {formatMtps(product.priceMtps)} MTPS
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
