# MTPS Token Deploy Runbook

Publish the hardened `mtps` coin package (ADR-0023) and bring its metadata online.

The `coin_registry` OTW flow is **two transactions**: `publish` registers the currency object,
and a one-time `finalize_registration` promotes it into the shared registry. Skipping the second
step leaves `admin_mint`/`burn` working but the token's symbol/name/icon **unresolved** in wallets
and explorers.

## Before you begin

> ⚠️ **The deploy key is the mint key.** `AdminCap` is `key`-only and non-transferable: whoever
> signs `publish` receives it and is the *only* address that can ever call `admin_mint`. Publish
> with **the backend faucet's key**, not a personal/CI key. Rotating the key later means a redeploy.

1. Switch the Sui CLI to the target env and confirm the active address is the backend faucet key:
   ```bash
   sui client switch --env testnet
   sui client active-address   # must equal the backend faucet address
   ```
2. Ensure the active address has gas.

## 1. Publish

```bash
cd contracts/mtps
sui client publish --gas-budget 200000000 --json | tee /tmp/mtps-publish.json
```

Capture from the output:

- **`packageId`** — the published package id → `MTPS_PACKAGE_ID`.
- The created **`Currency`** object id (owned by the registry) → `CURRENCY_OBJECT_ID`.
- The created **`AdminCap`** and **`MetadataCap`** object ids (owned by the faucet address).

The coin type is `${MTPS_PACKAGE_ID}::mtps::MTPS`.

## 2. Finalize registration (required, one-time)

Promotes the parked `Currency` into the shared registry so metadata resolves:

```bash
sui client ptb \
  --assign currency @${CURRENCY_OBJECT_ID} \
  --move-call 0x2::coin_registry::finalize_registration "<${MTPS_PACKAGE_ID}::mtps::MTPS>" @0xc currency
```

Verify the metadata (symbol `MTPS`, the favicon icon) now resolves in an explorer or via RPC.

## 3. Update environment ids

Point the apps at the new package (see ADR-0023 follow-ups):

- `VITE_MTPS_*` (frontend). `VITE_MTPS_FAUCET_ID` is **gone** — the shared faucet object no longer
  exists; the frontend faucets via the backend `POST /v1/faucet`.
- `TUNNEL_COIN_TYPE` = `${MTPS_PACKAGE_ID}::mtps::MTPS` (backend/SDK)

## 4. Wire the backend faucet

The faucet endpoints sign `admin_mint` with `SUI_SETTLER_KEY`, which **must be the deploy key** (it
owns the `AdminCap`). Set on the `tunnel-manager`:

- `MTPS_ADMIN_CAP_ID` = the **`AdminCap`** object id captured in step 1. Unset → both faucet routes
  return 503 (disabled).
- `FAUCET_USER_AMOUNT` (default 100000) and `FAUCET_COOLDOWN_SECS` (default 1800) — the public
  faucet's per-pull amount and per-address rate limit.
- `FAUCET_INTERNAL_AMOUNT` (default 1000000, the contract's `MAX_MINT_PER_CALL`) — the internal
  faucet's default mint.
- `FAUCET_ADMIN_TOKEN` — shared bearer secret for `POST /v1/faucet/internal`. Unset → internal
  route disabled (503). **Set it** to use the internal faucet.

Smoke-test after deploy:

```bash
# public faucet (rate-limited): mints FAUCET_USER_AMOUNT MTPS to the address
curl -fsS -X POST "$BACKEND/v1/faucet" -H 'content-type: application/json' \
  -d '{"address":"0x<recipient>"}'
# internal faucet (unlimited): bearer-gated; amount optional
curl -fsS -X POST "$BACKEND/v1/faucet/internal" -H "authorization: Bearer $FAUCET_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"recipient":"0x<recipient>","amount":50000}'
```

A second public pull within the cooldown returns `429` with a `Retry-After` header.

## Updating metadata later

The `MetadataCap` is retained (not burned), so symbol/name/description/icon can be changed
post-deploy without a redeploy — sign the relevant `coin_registry` update call with the
`MetadataCap`. Use this to swap the dev favicon for a production-stable icon URL when promoting
beyond testnet.
