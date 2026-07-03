# Deploy Frontend to Walrus Site

Publish `frontend/` to a [Walrus Site](https://docs.wal.app/walrus-sites/intro.html)
— decentralized static hosting on Sui/Walrus. This is a **second, independent**
deploy target, split from the AWS S3/CloudFront path by branch: `dev-raid` pushes
deploy to AWS ([aws-deploy.md](./aws-deploy.md)), and **`main`** pushes deploy to
Walrus. Both serve the same `dist/` bundle. The GitHub Actions workflow is
`.github/workflows/deploy-frontend-walrus.yml`.

## How it works

- A Walrus Site is a single on-chain **site object** on Sui mainnet whose id is
  stored in `frontend/ws-resources.json`. Every deploy **updates that same
  object**, so the site URL is stable across releases.
- The workflow builds `frontend/` with `pnpm build`, copies `ws-resources.json`
  into `dist/`, and hands `dist/` to the `MystenLabs/walrus-sites` deploy action.
- `CHECK_EXTEND: true` means the deploy only spends WAL on blobs that are new or
  whose storage is expiring — unchanged files are skipped.
- Storage is rented for `EPOCHS: 3` per deploy; re-running before expiry extends
  the affected blobs.

## Before you begin

- A Sui **mainnet** wallet (the deployer) that owns—or will create—the site
  object. It must hold:
  - **SUI** for gas (the workflow sets `gas_budget` to 0.5 SUI per deploy).
  - **WAL** for Walrus storage (blob rent for `EPOCHS: 3`).
- `frontend/ws-resources.json` committed to the repo (bootstrapped once, below).
- The `walrus-mainnet` GitHub Environment populated with the secrets and
  variables in [.github/workflows/README.md](../../.github/workflows/README.md).

## Required tooling (local bootstrap only)

The workflow needs none of this — it's only for the one-time bootstrap and for
local publishing.

- [`walrus`](https://docs.wal.app/usage/setup.html) CLI, configured for mainnet.
- [`site-builder`](https://docs.wal.app/walrus-sites/tutorial-install.html) CLI.
- Sui CLI with a funded mainnet address (`sui client active-address`).
- pnpm (managed by `corepack`; run `corepack enable` if needed) + Node 24 (`.nvmrc`).

## First-time setup: bootstrap `ws-resources.json`

The workflow **updates** an existing site, so the site object must exist and its
id must be committed. Do this once.

1. Build the frontend and publish a fresh site locally:
   ```bash
   cd frontend
   pnpm install --frozen-lockfile
   pnpm build
   # site-builder writes dist/ws-resources.json with the new site's object_id
   site-builder publish --epochs 3 dist
   ```
2. Promote the generated file to the repo root of `frontend/` and add SPA routes:
   ```bash
   cp dist/ws-resources.json ws-resources.json
   ```
   Ensure `routes` maps every path to `index.html` so client-side routes survive
   a hard reload (edit `frontend/ws-resources.json`):
   ```json
   {
     "site_name": "Dopamint Arena",
     "object_id": "0xYOUR_SITE_OBJECT_ID",
     "routes": {
       "/*": "/index.html"
     }
   }
   ```
3. Commit it:
   ```bash
   git add frontend/ws-resources.json
   git commit -m "chore(frontend): add walrus ws-resources.json"
   ```

> `frontend/ws-resources.json` is committed on purpose — it is the site's stable
> identity, not a secret. Without it the workflow fails fast at its validate step
> rather than silently minting a new, orphaned site on every run.

## Configure the `walrus-mainnet` GitHub Environment

Every `VITE_*` value is compiled into the browser bundle, so it is **public** and
belongs in GitHub **Variables**, not Secrets (`frontend/.env.example` documents
these as safe-to-ship identifiers). The only Secret is the wallet keystore.

This build runs on `main` (production) and reads a **`_PROD` variant** of each
variable, falling back to the shared variable used by the `dev-raid` AWS build:
`${{ vars.X_PROD || vars.X }}`. So you only create a `_PROD` variable when the
production value differs from `dev-raid`.

In **Settings → Environments → `walrus-mainnet`**, add:

- **Secret** `SUI_KEYSTORE` — the deployer's Sui keystore JSON array. Keep this
  wallet funded with SUI + WAL on mainnet. (The environment protects this key.)
- **Variable** `SUI_ADDRESS_PROD` — the deployer address that owns the site
  object (falls back to `SUI_ADDRESS`).
- **Variable**s `VITE_BACKEND_URL_PROD` and `VITE_API_URL_PROD` — backend base
  URLs (see the cross-origin caveat below).
- **Variable**s for the mainnet build overrides (same set as `deploy-frontend.yml`,
  suffixed `_PROD`), each falling back to its shared variable when unset:
  `VITE_TUNNEL_PACKAGE_ID_PROD`, `VITE_TTT_PACKAGE_ID_PROD`,
  `VITE_SUI_NETWORK_PROD`, `VITE_SUI_NETWORK_NAME_PROD`, `VITE_ENOKI_API_KEY_PROD`,
  `VITE_GOOGLE_CLIENT_ID_PROD`, `VITE_MTPS_PACKAGE_ID_PROD`,
  `VITE_MTPS_COIN_TYPE_PROD`, `VITE_AGENT_ALLOWANCE_PACKAGE_ID_PROD`,
  `VITE_STREAMING_PAYMENT_PACKAGE_ID_PROD`.

### ⚠️ Cross-origin / https backend caveat

The AWS build leaves `VITE_BACKEND_URL` empty and relies on CloudFront proxying
`/v1/*` (HTTP + the `/v1/mp` WebSocket) to the ALB from the **same origin**. A
Walrus portal (e.g. `https://<name>.wal.app`) is a **different origin** served
over **https**, so:

- `VITE_BACKEND_URL_PROD` / `VITE_API_URL_PROD` must be **real, non-empty**
  URLs pointing at the backend.
- The backend must serve **CORS** headers for the portal origin.
- The backend must expose **`https` + `wss`** endpoints. The dev CloudFront build
  proxies to a plain `http://…elb.amazonaws.com` ALB; pointing the https Walrus
  portal at that raw `http`/`ws` ALB triggers the browser's mixed-content /
  insecure-WebSocket block. Front the backend with TLS (an https API domain)
  before the Walrus deploy is usable end-to-end.

## Deploy

### Via CI (normal path)

- **Automatic**: push to `main` touching `frontend/**` (or the workflow file).
- **Manual**: Actions tab → **Deploy Frontend to Walrus Site** → **Run workflow**.

The `deploy-frontend-walrus` concurrency group serializes runs so two deploys
never mutate the site object at once.

### Locally (from the bootstrap machine)

```bash
cd frontend
pnpm install --frozen-lockfile
pnpm build
cp ws-resources.json dist/ws-resources.json
site-builder --context mainnet update --epochs 3 dist $(jq -r .object_id ws-resources.json)
```

## Verify

1. Read the site object id and resolve the portal URL:
   ```bash
   jq -r .object_id frontend/ws-resources.json
   # Browse https://<b36-of-object-id>.wal.app (site-builder prints the URL on deploy)
   ```
2. Confirm the site serves the SPA shell and survives a deep-link reload:
   ```bash
   curl -fsS "https://<name>.wal.app" | grep -q "<html"
   curl -fsSI "https://<name>.wal.app/some/deep/route"   # 200 via the /* -> index.html route
   ```
3. In the browser console, confirm the app reaches the backend cross-origin
   (no CORS or mixed-content errors) and the game WebSocket connects over `wss`.

## Rollback

Walrus deploys are additive updates to one site object; there is no automatic
revert. To roll back, re-run the deploy from a known-good commit (the workflow
rebuilds `dist/` from that tree and updates the same site object). Keep the AWS
CloudFront path as the fallback origin while validating Walrus.

## Troubleshooting

- **Run fails at "Validate ws-resources.json exists"** — `frontend/ws-resources.json`
  is missing. Bootstrap it (first-time setup above) and commit.
- **`Insufficient WAL` / gas errors** — top up the deployer wallet with WAL
  and/or SUI on mainnet.
- **Blank page or 404 on reload** — the `routes` map is missing `"/*": "/index.html"`;
  re-add it and redeploy.
- **App loads but API calls fail** — the cross-origin/https caveat above: check
  `VITE_BACKEND_URL_PROD`, backend CORS, and that the endpoint is `https`/`wss`.
