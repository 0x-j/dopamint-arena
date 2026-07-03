import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@sentry/react";
import "@mysten/dapp-kit/dist/index.css";
import "./styles/index.css";
import { SuiProviders } from "./providers/SuiProviders";
import { App } from "./App";
import { installWasmCryptoBackend } from "./onchain/wasmEd25519Backend";
import { initSentry } from "./sentry/sentryClient";
import { SentryErrorFallback } from "./sentry/SentryErrorFallback";

// Error monitoring first, so everything after this (wasm backend, providers, render) reports.
initSentry();

// Make libsodium-WASM the default move-signing crypto backend (falls back to @noble until ready).
installWasmCryptoBackend();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary fallback={<SentryErrorFallback />}>
      <SuiProviders>
        <App />
      </SuiProviders>
    </ErrorBoundary>
  </StrictMode>,
);
