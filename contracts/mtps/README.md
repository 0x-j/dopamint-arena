# `mtps` — MillionsTPS stake token (MTPS)

_Lightning speed games and apps on Sui._

MTPS is the free stake token for **MillionsTPS** — lightning-speed games and apps on Sui. Players
stake MTPS to fund a game while **gas stays sponsored in SUI**, so a 0-SUI player can play for free.
A single Move module, `mtps::mtps`, defines the coin and its mint authority.

> Design rationale and the decisions behind this package: **[ADR-0023](../../docs/decisions/0023-mtps-token-hardening.md)**
> (builds on [ADR-0010](../../docs/decisions/0010-mtps-stake-token.md)).

## Design at a glance

| Choice | What & why |
| --- | --- |
| **Admin-only mint** | No permissionless faucet. The backend custodies an `AdminCap` and mints each player exactly what they need. Removes the public-mint griefing / u64-brick vector entirely. |
| **No supply cap / kill switch** | Unnecessary once minting is admin-only — the only authority is who holds the cap. |
| **Per-call sanity bound** | `admin_mint` rejects `amount > MAX_MINT_PER_CALL` (10,000,000,000 MTPS). Not an attacker defense — a guardrail bounding a backend bug minting an absurd amount. |
| **0 decimals** | MTPS is indivisible: a 1-token stake is the integer `1`, not `1e9`. Matches whole-token game stakes. **Permanent** — decimals are fixed at creation. |
| **`coin_registry` metadata** | Modern currency standard (replaces deprecated `coin::create_currency`). The `MetadataCap` is **kept**, so symbol/name/icon stay updatable post-deploy. |
| **`AdminCap` is `key`-only** | No `store` → non-transferable after `init`. The **deploy key is the mint key** (see the runbook). |

## Module API (`mtps::mtps`)

| Item | Signature | Notes |
| --- | --- | --- |
| `MTPS` | `public struct MTPS has drop` | One-time witness — guarantees a single `TreasuryCap<MTPS>`. |
| `AdminCap` | `public struct AdminCap has key` | Wraps the `TreasuryCap`. Holding it is the sole permission to mint/burn. |
| `admin_mint` | `public fun admin_mint(cap: &mut AdminCap, amount: u64, recipient: address, ctx: &mut TxContext)` | Mints `amount` MTPS to `recipient`. Aborts `EAmountTooLarge` if `amount > MAX_MINT_PER_CALL`. |
| `burn` | `public fun burn(cap: &mut AdminCap, coin: Coin<MTPS>)` | Burns MTPS back out of supply (AdminCap-only). |

On publish, `init` registers the currency and hands the deployer **both** the `AdminCap` and the
`MetadataCap`.

### Constants & errors

- `DECIMALS = 0` — whole-token, indivisible.
- `MAX_MINT_PER_CALL = 10_000_000_000` — per-call mint ceiling (whole tokens).
- `EAmountTooLarge = 0` — abort code when `admin_mint` exceeds the per-call ceiling.

## Build & test

```bash
cd contracts/mtps
sui move build
sui move test      # 6 tests: happy mint, cap boundary (exact / over), zero mint, metadata-cap, burn
```

## Deploy

The `coin_registry` OTW flow is **two transactions** (publish + a one-time
`finalize_registration`), and the package **must be published by the backend faucet's key**.
Follow the step-by-step **[deploy runbook](../../docs/runbooks/mtps-deploy.md)**.

## Integration notes

- **Coin type**: `<package_id>::mtps::MTPS` — set as `TUNNEL_COIN_TYPE` (backend/SDK) and
  `VITE_MTPS_*` (frontend) after deploy.
- **0 decimals**: amounts are whole tokens end-to-end. A 1-token stake is `1`, not `1_000_000_000`.
- **Updating metadata**: sign a `coin_registry` update with the retained `MetadataCap` — no redeploy
  needed (e.g. to swap the dev icon for a production URL).
