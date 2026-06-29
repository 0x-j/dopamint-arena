# Regular Payments — Coding Patterns & Principles

> **Status:** Active  
> **Date:** 2026-06-28  
> **Scope:** Coding standards for the `regularPayments` package (and general frontend apps).

These rules govern all Regular Payments implementation to maintain a clean architecture and a consistent aesthetic. 

---

## 1. Props & State Management (Pass Objects)

Pass state objects or context bags directly into components rather than spreading them out into many individual props. This keeps component signatures clean and prevents "prop drilling" boilerplate.

**Good:**
```tsx
<PaymentsShop session={session} />
```

**Bad:**
```tsx
<PaymentsShop
  category={session.category}
  onCategory={session.setCategory}
  cart={session.cart}
  cartTotal={session.cartTotal}
  itemCount={session.itemCount}
  // ... too many props
/>
```

---

## 2. Package Layout

Follow a strict order of concern when organizing logic:

```
frontend/src/games/regularPayments/
├── index.ts                 # register({ id: "regular-payments", ... })
├── types/
│   └── index.ts             # Screen, Product, CartLine, SessionPhase, ...
├── utils/
│   ├── catalog.ts
│   ├── formatMtps.ts
│   └── sessionCore.ts
├── hooks/
│   └── useRegularPaymentsSession.ts
└── components/
    ├── PaymentsWindow/
    │   └── index.tsx        # .sketch root + SketchDefs from ../sketch
    ├── PaymentsLobby/
    │   └── index.tsx
    ├── Category/
    │   └── index.tsx        # sketch-btn + cn()
    ├── ProductCard/
    │   └── index.tsx        # sketch-panel + Tailwind layout
    ├── PaymentsShop/
    │   ├── index.tsx        # composes header + body + cart
    │   ├── PaymentsShopHeader.tsx
    │   ├── PaymentsShopBody.tsx
    │   └── PaymentsShopCart.tsx
    └── PaymentsThankYou/
        └── index.tsx
```

**Order of concern:** `utils` → `hooks` → `components` → `types` (types may be imported everywhere).

---

## 3. Styling & Sketch Skin

Match the arena hand-drawn look (Blackjack / Chicken Cross / World Canvas). 

### 3.1 Component Decisions
- **No per-game `.css` files unless strictly necessary.** Styling is Tailwind `className` + shared sketch utilities from `frontend/src/games/sketch/`.
- Add a local `.css` file only for **global keyframes** or animations that Tailwind cannot express.
- Do not add `role`, `aria-label`, `type`, etc. unless required for behavior.
- Use `sketch-btn` variants for buttons (not shadcn `Button`).

### 3.2 Sketch Theme Rules
- **Root:** Use `className="sketch"` on the window shell (provides Gochi Hand font + paper texture).
- **Filter:** Render `<SketchDefs />` (imported from `games/sketch`) once in the root. Do not duplicate it.
- **Palette:** Rely on CSS variables provided by `.sketch` (`--sketch-ink`, `--sketch-accent`, `--sketch-felt`).

### 3.3 Tailwind + `cn()`
Merge sketch utilities, Tailwind layout, and conditional modifiers with `cn()` from `@/lib/utils`.

**Good:**
```tsx
className={cn("sketch-btn", active && "sketch-btn--go")}
```

**Bad (Do not do this):**
```tsx
className={`sketch-btn ${active ? "sketch-btn--go" : ""}`}
```

---

## 4. TypeScript Patterns

### 4.1 Prefer `interface` over `type`
Use **`interface`** for every object shape and component props bag.

**Good:**
```typescript
export interface Product {
  id: string;
  name: string;
}

interface ProductCardProps {
  product: Product;
}
```

### 4.2 When to use `type`
Use `type` only for unions, literal unions, or utility compositions that interfaces cannot express.
```typescript
export type Screen = "lobby" | "shop" | "thankYou";
export type ProductCategory = "fresh" | "snacks" | "drinks";
```
