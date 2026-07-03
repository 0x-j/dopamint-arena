import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { fileURLToPath, URL } from "node:url";

// Same-origin in dev, mirroring the prod CloudFront `/v1/*` behavior: route /v1 (HTTP +
// the /v1/mp WebSocket) to the ALB so the browser issues same-origin requests. With this,
// VITE_BACKEND_URL stays empty everywhere (prod is same-origin via CloudFront), which also
// sidesteps the https-page→http-ALB mixed-content block on the deployed frontend.
const BACKEND_ALB = "https://relay-dev.millionstps.io";

// The vendored SDK barrel (and its examples) ends with `if (require.main === module) runAllExamples()`
// — a Node "run me directly" guard. Bundling `sui-tunnel-ts` pulls it in, where `require.main`/`module`
// are undefined and would throw. Neutralize the guard to `false` at transform time (so the example
// runner tree-shakes away) INSTEAD of a global `define: { module: "null" }` — that define rewrote
// `module.exports` inside React's CJS files too, making the production (rolldown) build fail with
// hundreds of "X is not exported by react" errors. We never edit the vendored source (re-syncable).
const stripSdkMainGuard = {
  name: "strip-sdk-main-guard",
  transform(code: string, id: string) {
    if (
      id.includes("/sui-tunnel-ts/src/") &&
      code.includes("require.main === module")
    ) {
      return {
        code: code.replaceAll("require.main === module", "false"),
        map: null,
      };
    }
    return null;
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const pkgId =
    env.VITE_TUNNEL_PACKAGE_ID ||
    "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b";
  // Sentry release + debug-ID injection + source-map upload (build-time only). Fully
  // disabled without SENTRY_AUTH_TOKEN, so local/CI builds run as before; the deploy
  // pipeline sets the token. Workers build in their OWN plugin pipeline, so `worker.plugins`
  // gets a fresh instance below — without it, worker stack frames never symbolicate.
  const sentryBuild = (extra?: Parameters<typeof sentryVitePlugin>[0]) =>
    sentryVitePlugin({
      org: "commandoss-gs",
      project: "dopamint-arena",
      authToken: env.SENTRY_AUTH_TOKEN,
      disable: !env.SENTRY_AUTH_TOKEN,
      telemetry: false,
      ...extra,
    });
  return {
    plugins: [
      stripSdkMainGuard,
      react(),
      tailwindcss(),
      // Deletion only here (not in the worker pipeline): this outer bundle closes LAST,
      // after every sub-build's maps — worker maps included — have been uploaded.
      ...sentryBuild({
        sourcemaps: { filesToDeleteAfterUpload: ["dist/**/*.map"] },
      }),
    ],
    worker: {
      // ES format: the sentry plugin can't inject debug IDs into iife worker bundles.
      format: "es" as const,
      plugins: () => [...sentryBuild()],
    },
    build: {
      // "hidden": emit maps for the Sentry upload but strip sourceMappingURL from the
      // served assets (and the upload deletes the .map files from dist afterwards).
      sourcemap: "hidden" as const,
    },
    server: {
      proxy: {
        "/v1": { target: BACKEND_ALB, changeOrigin: true, ws: true },
      },
    },
    // The SDK's onchain config.ts reads these at import time (Node-isms). Inject build-time
    // literals so the tx builders resolve the package id in the browser bundle.
    define: {
      "process.env.PACKAGE_ID": JSON.stringify(pkgId),
      "process.env.SUI_NETWORK": JSON.stringify("testnet"),
      // NB: do NOT `define` a global `module`/`require.main` here — that rewrites `module.exports`
      // inside React's CJS files and breaks the rolldown build. The SDK's `require.main === module`
      // guard is handled by the `stripSdkMainGuard` transform plugin above instead.
    },
    resolve: {
      // The vendored SDK pins an older @mysten/sui in its own node_modules. Force the bundled
      // SDK source to use THIS app's single @mysten/sui (2.18) so its tx builders produce the
      // same Transaction class dapp-kit signs — letting us reuse them instead of duplicating.
      dedupe: ["@mysten/sui", "@mysten/bcs"],
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        // The off-chain engine statically imports node:crypto in crypto-native.ts but
        // falls back to @noble at runtime in the browser. Map node:crypto to a stub so
        // the bundle resolves; the native path is never taken here.
        "node:crypto": fileURLToPath(
          new URL("./src/shims/node-crypto.ts", import.meta.url),
        ),
        "node:worker_threads": fileURLToPath(
          new URL("./src/shims/node-empty.ts", import.meta.url),
        ),
        "node:os": fileURLToPath(
          new URL("./src/shims/node-empty.ts", import.meta.url),
        ),
        "node:path": fileURLToPath(
          new URL("./src/shims/node-empty.ts", import.meta.url),
        ),
        "node:fs/promises": fileURLToPath(
          new URL("./src/shims/node-empty.ts", import.meta.url),
        ),
        // Stub @mysten/sui/client to point to our v1->v2 backward compatibility shim
        "@mysten/sui/client": fileURLToPath(
          new URL("./src/shims/sui-client.ts", import.meta.url),
        ),
        // config.ts calls dotenv.config() at import time; stub it (env via `define`).
        dotenv: fileURLToPath(
          new URL("./src/shims/dotenv.ts", import.meta.url),
        ),
        "sui-tunnel-ts": fileURLToPath(
          new URL("../sui-tunnel-ts/src", import.meta.url),
        ),
        // Point at the package src DIR (not index.ts) so subpath imports like
        // `@ttt/shared/ttt/multiGameProtocol` resolve too — mirroring the `@` alias
        // above and tsconfig's `@ttt/shared/*` mapping. A file target would rewrite
        // subpaths to `.../index.ts/<subpath>` and fail to resolve.
        "@ttt/shared": fileURLToPath(
          new URL("./src/games/ticTacToe/packages/shared/src", import.meta.url),
        ),
      },
    },
  };
});
