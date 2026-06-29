import { mtps } from "@/onchain/mtps";
import type { Product, ProductCategory } from "../types";

/** Micro-pricing for high-volume carts (~500 co-signed ticks at full 10 MTPS budget). */
export const PRICE_LO = mtps(1n) / 100n; // 0.01 MTPS
export const PRICE_HI = mtps(1n) / 50n; // 0.02 MTPS

export const CATEGORIES: { id: ProductCategory; label: string }[] = [
  { id: "fresh", label: "Fresh" },
  { id: "snacks", label: "Snacks" },
  { id: "drinks", label: "Drinks" },
];

export const PRODUCTS: Product[] = [
  // Fresh (6)
  {
    id: "milk",
    category: "fresh",
    name: "Organic Milk 1L",
    priceMtps: PRICE_LO,
    emoji: "🥛",
  },
  {
    id: "bread",
    category: "fresh",
    name: "Wholegrain Bread",
    priceMtps: PRICE_HI,
    emoji: "🍞",
  },
  {
    id: "eggs",
    category: "fresh",
    name: "Free-range Eggs x6",
    priceMtps: PRICE_LO,
    emoji: "🥚",
  },
  {
    id: "banana",
    category: "fresh",
    name: "Banana Bunch",
    priceMtps: PRICE_HI,
    emoji: "🍌",
  },
  {
    id: "apple",
    category: "fresh",
    name: "Honeycrisp Apple",
    priceMtps: PRICE_LO,
    emoji: "🍎",
  },
  {
    id: "spinach",
    category: "fresh",
    name: "Baby Spinach 200g",
    priceMtps: PRICE_HI,
    emoji: "🥬",
  },
  // Snacks (6)
  {
    id: "chips",
    category: "snacks",
    name: "Potato Chips",
    priceMtps: PRICE_LO,
    emoji: "🥔",
  },
  {
    id: "cookies",
    category: "snacks",
    name: "Choco Cookies",
    priceMtps: PRICE_HI,
    emoji: "🍪",
  },
  {
    id: "nuts",
    category: "snacks",
    name: "Mixed Nuts",
    priceMtps: PRICE_LO,
    emoji: "🥜",
  },
  {
    id: "crackers",
    category: "snacks",
    name: "Sea Salt Crackers",
    priceMtps: PRICE_HI,
    emoji: "🧀",
  },
  {
    id: "pretzels",
    category: "snacks",
    name: "Pretzel Sticks",
    priceMtps: PRICE_LO,
    emoji: "🥨",
  },
  {
    id: "gummy",
    category: "snacks",
    name: "Fruit Gummies",
    priceMtps: PRICE_HI,
    emoji: "🍬",
  },
  // Drinks (6)
  {
    id: "water",
    category: "drinks",
    name: "Mineral Water 500ml",
    priceMtps: PRICE_LO,
    emoji: "💧",
  },
  {
    id: "juice",
    category: "drinks",
    name: "Orange Juice",
    priceMtps: PRICE_HI,
    emoji: "🧃",
  },
  {
    id: "coffee",
    category: "drinks",
    name: "Cold Brew Coffee",
    priceMtps: PRICE_LO,
    emoji: "☕",
  },
  {
    id: "tea",
    category: "drinks",
    name: "Green Tea Bottle",
    priceMtps: PRICE_HI,
    emoji: "🍵",
  },
  {
    id: "soda",
    category: "drinks",
    name: "Lemon Soda",
    priceMtps: PRICE_LO,
    emoji: "🥤",
  },
  {
    id: "coconut",
    category: "drinks",
    name: "Coconut Water",
    priceMtps: PRICE_HI,
    emoji: "🥥",
  },
];

export function productsForCategory(category: ProductCategory): Product[] {
  return PRODUCTS.filter((p) => p.category === category);
}
