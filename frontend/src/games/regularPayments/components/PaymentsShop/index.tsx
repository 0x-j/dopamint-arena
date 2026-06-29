import { cn } from "@/lib/utils";
import { useRef } from "react";
import type { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";
import { PaymentsShopCartFlyLayer } from "./PaymentsShopCartFlyLayer";
import { PaymentsShopBody } from "./PaymentsShopBody";
import { PaymentsShopHeader } from "./PaymentsShopHeader";
import { useCartFly } from "../../hooks/useCartFly";
import { PaymentsShopCart } from "./PaymentsShopCart";

interface PaymentsShopProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
}

export function PaymentsShop({ session }: PaymentsShopProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cartTargetRef = useRef<HTMLSpanElement>(null);

  const { flies, spawnFlyForProduct, removeFly } = useCartFly({
    containerRef,
    cartTargetRef,
  });

  return (
    <div
      ref={containerRef}
      className={cn("relative flex h-full min-h-0 flex-col")}
    >
      <PaymentsShopCartFlyLayer
        session={session}
        flies={flies}
        spawnFlyForProduct={spawnFlyForProduct}
        onFlyEnd={removeFly}
      />

      <PaymentsShopHeader session={session} />

      <PaymentsShopBody session={session} />

      <PaymentsShopCart session={session} cartTargetRef={cartTargetRef} />
    </div>
  );
}
