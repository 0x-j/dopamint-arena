import { useCallback, useRef, useState } from "react";

export interface CartFlyItem {
  id: string;
  emoji: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

interface UseCartFlyOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  cartTargetRef: React.RefObject<HTMLElement | null>;
}

export function useCartFly({ containerRef, cartTargetRef }: UseCartFlyOptions) {
  const [flies, setFlies] = useState<CartFlyItem[]>([]);
  const nextId = useRef(0);

  function centerInContainer(
    el: HTMLElement,
    container: HTMLElement,
  ): { x: number; y: number } {
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      x: elRect.left + elRect.width / 2 - containerRect.left,
      y: elRect.top + elRect.height / 2 - containerRect.top,
    };
  }

  const pushFly = useCallback(
    (emoji: string, sourceEl: HTMLElement | null) => {
      const container = containerRef.current;
      const cartTarget = cartTargetRef.current;
      if (!container || !cartTarget || !sourceEl) return;

      const from = centerInContainer(sourceEl, container);
      const to = centerInContainer(cartTarget, container);

      const id = `cart-fly-${nextId.current++}`;
      setFlies((prev) => [
        ...prev,
        { id, emoji, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y },
      ]);
    },
    [containerRef, cartTargetRef],
  );

  /** Resolve product card in the shop grid — works for click and auto-loop adds. */
  const spawnFlyForProduct = useCallback(
    (productId: string, emoji: string) => {
      const container = containerRef.current;
      if (!container) return;

      const sourceEl = container.querySelector<HTMLElement>(
        `[data-product-id="${productId}"] [data-product-emoji]`,
      );

      pushFly(emoji, sourceEl);
    },
    [containerRef, pushFly],
  );

  const removeFly = useCallback((id: string) => {
    setFlies((prev) => prev.filter((f) => f.id !== id));
  }, []);

  return {
    flies,
    spawnFlyForProduct,
    removeFly,
  };
}
