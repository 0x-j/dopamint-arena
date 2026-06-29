import { useEffect, useLayoutEffect, useRef } from "react";
import type { CartFlyItem } from "../../hooks/useCartFly";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";

const FLY_MS = 580;

interface PaymentsShopCartFlyLayerProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
  flies: CartFlyItem[];
  spawnFlyForProduct: (productId: string, emoji: string) => void;
  onFlyEnd: (id: string) => void;
}

function CartFlyEmoji({
  fly,
  onFlyEnd,
}: {
  fly: CartFlyItem;
  onFlyEnd: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const dx = fly.toX - fly.fromX;
    const dy = fly.toY - fly.fromY;

    const anim = el.animate(
      [
        {
          transform: "translate(-50%, -50%) scale(1)",
          opacity: 1,
        },
        {
          transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.35}px)) scale(0.85)`,
          opacity: 1,
          offset: 0.45,
        },
        {
          transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.4)`,
          opacity: 0,
        },
      ],
      {
        duration: FLY_MS,
        easing: "cubic-bezier(0.33, 1, 0.68, 1)",
        fill: "forwards",
      },
    );

    anim.onfinish = () => onFlyEnd(fly.id);
    return () => anim.cancel();
  }, [fly, onFlyEnd]);

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-50 text-[clamp(1.6rem,6cqmin,2rem)] leading-none drop-shadow-sm"
      style={{ left: fly.fromX, top: fly.fromY }}
    >
      {fly.emoji}
    </div>
  );
}

export function PaymentsShopCartFlyLayer({
  session,
  flies,
  spawnFlyForProduct,
  onFlyEnd,
}: PaymentsShopCartFlyLayerProps) {
  const lastFlySeqRef = useRef(0);

  useEffect(() => {
    const cue = session.cartFlyCue;
    if (!cue || cue.seq <= lastFlySeqRef.current) return;

    if (!session.cartTotal) return;

    lastFlySeqRef.current = cue.seq;
    spawnFlyForProduct(cue.productId, cue.emoji);
  }, [session.cartFlyCue, spawnFlyForProduct, session.cartTotal]);

  if (flies.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-50 overflow-hidden">
      {flies.map((fly) => (
        <CartFlyEmoji key={fly.id} fly={fly} onFlyEnd={onFlyEnd} />
      ))}
    </div>
  );
}
