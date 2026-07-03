# GitHub Actions workflows

Automation for building, testing, and deploying **dopamint-arena**.

| Workflow                     | Purpose                                                        | Trigger                                    |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `ci.yml`                     | Lint, typecheck, and test the TS SDK + frontend               | PRs and pushes                             |
| `test.yml`                   | Move (`sui move test`) + SDK tests                            | PRs and pushes                             |
| `deploy-frontend.yml`        | Deploy `frontend/` to **AWS** S3/CloudFront                   | push to `dev-raid` (`frontend/**`)         |
| `deploy-frontend-walrus.yml` | Deploy `frontend/` to a **Walrus Site** (decentralized) | push to `main` (`frontend/**`) + manual    |
| `deploy-backend.yml`         | Deploy the backend                                            | see file                                   |
| `deploy-infra.yml`           | Provision infrastructure                                      | see file                                   |

The two frontend deploys are **independent targets**, split by branch:
`deploy-frontend.yml` publishes to AWS on **`dev-raid`** (same-origin `/v1` proxy
via CloudFront), `deploy-frontend-walrus.yml` publishes the same `dist/` to Walrus
on **`main`** (production). The Walrus build is cross-origin to the backend — see
the caveats below.

### Public config lives in Variables, not Secrets

Every `VITE_*` value is compiled into the browser bundle, so it is **public by
construction** (package ids, RPC URLs, the Enoki/Google public client ids — see
`frontend/.env.example`). Both frontend workflows read these from GitHub
**Variables** (`vars.*`). The only real **Secret** is `SUI_KEYSTORE` (the Walrus
deployer's mainnet wallet key).

Config is selected **by branch**:

- On **`main`** the build reads the **`_PROD` variant** of each variable —
  `deploy-frontend-walrus.yml` (main-only) always does this; `deploy-frontend.yml`
  does it only when dispatched on `main`.
- On **`dev-raid`** `deploy-frontend.yml` reads the **shared** (non-`_PROD`) variable.

Both fall back to the shared variable when a `_PROD` variant is unset
(`${{ github.ref_name == 'main' && vars.X_PROD || vars.X }}`), so you add a
`X_PROD` variable **only when** a production value differs from `dev-raid`
(e.g. mainnet package ids, a mainnet RPC URL, the https backend).

## `deploy-frontend-walrus.yml`

Publishes `frontend/` to a Walrus Site on Sui **mainnet**. Full runbook:
[docs/runbooks/walrus-deploy.md](../../docs/runbooks/walrus-deploy.md).

**Triggers**

- Push to `main` touching `frontend/**` or the workflow file.
- Manual `workflow_dispatch` (Actions tab → **Run workflow**).

**What it does**

- ✅ Updates the existing site (URL preserved via `frontend/ws-resources.json`).
- ✅ `CHECK_EXTEND: true` — only pays WAL for changed/expiring blobs.
- ✅ Fails fast if `frontend/ws-resources.json` is missing (won't mint a stray site).
- ✅ Portal `wal.app`, `gas_budget` 500M MIST (0.5 SUI) per deploy.

### GitHub Environment: `walrus-mainnet`

Config is scoped to a GitHub Environment named `walrus-mainnet`
(Settings → Environments) so the mainnet wallet key sits behind environment
protection rules. Create it and add the entries below before the first run.

**Secret** (the only one)

- `SUI_KEYSTORE` — Sui keystore JSON array for the deployer address. This wallet
  pays SUI gas and WAL storage, so keep it funded on mainnet.

**Variables** — production build config (`_PROD` variant, falls back to the
shared variable used by `deploy-frontend.yml`). Set a `_PROD` variable only when
the production value differs from `dev-raid`:

- `SUI_ADDRESS_PROD` — deployer Sui address that owns the site object (matches
  `SUI_KEYSTORE`); falls back to `SUI_ADDRESS`.
- `VITE_BACKEND_URL_PROD` — backend base URL the browser calls **cross-origin**
  from the Walrus portal. Unlike the AWS build (which leaves `VITE_BACKEND_URL`
  empty for a same-origin CloudFront `/v1` proxy), the Walrus portal is a
  different origin, so this must be a real URL and the backend must serve CORS.
- `VITE_API_URL_PROD` — stats/live base URL (same host as above).
- `VITE_TUNNEL_PACKAGE_ID_PROD`, `VITE_TTT_PACKAGE_ID_PROD`,
  `VITE_SUI_NETWORK_PROD`, `VITE_SUI_NETWORK_NAME_PROD`, `VITE_ENOKI_API_KEY_PROD`,
  `VITE_GOOGLE_CLIENT_ID_PROD`, `VITE_MTPS_PACKAGE_ID_PROD`,
  `VITE_MTPS_COIN_TYPE_PROD`, `VITE_AGENT_ALLOWANCE_PACKAGE_ID_PROD`,
  `VITE_STREAMING_PAYMENT_PACKAGE_ID_PROD` — mainnet overrides for the build
  config. Any left unset fall back to the shared `VITE_*` variable.

> ⚠️ **HTTPS / wss caveat.** Walrus portals serve over **https**, which blocks
> insecure `ws://` and mixed http content. The backend behind
> `VITE_BACKEND_URL_PROD` must expose **`https` + `wss`** endpoints, not the raw
> `http` ALB used by the dev CloudFront build. See the runbook.

## Bootstrap `frontend/ws-resources.json`

The workflow **updates** an existing site; it needs the site's object id. Create
`frontend/ws-resources.json` once, then commit it.

### Option 1 — publish locally first (recommended)

```bash
cd frontend
pnpm install --frozen-lockfile
pnpm build
# site-builder writes dist/ws-resources.json with the new site's object_id
site-builder publish --epochs 3 dist
cp dist/ws-resources.json ws-resources.json
git add ws-resources.json
git commit -m "chore(frontend): add walrus ws-resources.json"
```

### Option 2 — write it by hand (existing site)

```json
{
  "site_name": "Dopamint Arena",
  "object_id": "0xYOUR_SITE_OBJECT_ID",
  "routes": {
    "/*": "/index.html"
  }
}
```

`routes` serves `index.html` for every path so client-side (SPA) routes survive
a hard reload instead of 404-ing.

## Testing without a push

1. Actions tab → **Deploy Frontend to Walrus Site**.
2. **Run workflow** → pick a branch → **Run workflow**.

Ensure `frontend/ws-resources.json` exists first, or the run fails at the
validate step by design.
