export type Screen = "lobby" | "shop" | "thankYou";

export type ProductCategory = "fresh" | "snacks" | "drinks";

export type SessionPhase =
  | "idle"
  | "opening"
  | "shopping"
  | "paying"
  | "settling"
  | "error";

export interface Product {
  id: string;
  category: ProductCategory;
  name: string;
  priceMtps: bigint;
  emoji: string;
}

export interface CartLine extends Product {
  qty: number;
}

/** UI-only signal: cart line added — drives fly-to-cart animation (manual or auto). */
export interface CartFlyCue {
  seq: number;
  productId: string;
  emoji: string;
}
