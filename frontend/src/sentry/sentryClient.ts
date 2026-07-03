/**
 * Main-thread Sentry bootstrap — the ONE client for the whole app: React render crashes
 * (ErrorBoundary in main.tsx), global handlers, TanStack Router tracing, replay-on-error,
 * the user-feedback widget, and everything the engine workers forward (workerSentry.ts).
 * No-op when VITE_SENTRY_DSN is unset, so local dev can opt out and node:test stays clean.
 */
import * as Sentry from "@sentry/react";
import { router } from "@/router";

export function initSentry(): void {
  const dsn = import.meta.env?.VITE_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env?.MODE,
    // Release is injected at build time by @sentry/vite-plugin (vite.config.ts).
    integrations: [
      Sentry.tanstackRouterBrowserTracingIntegration(router),
      Sentry.replayIntegration(),
      Sentry.feedbackIntegration({ colorScheme: "system" }),
    ],
    tracesSampleRate: resolveTracesSampleRate(),
    // Replay only when something breaks: arena sessions are long-lived and render-heavy,
    // so always-on session replay would be nearly all cost and no signal.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
  });
}

/** VITE_SENTRY_TRACES_SAMPLE_RATE override (0..1); defaults to tracing everything in dev
 *  and 20% of pageloads/navigations in prod. */
function resolveTracesSampleRate(): number {
  const raw = import.meta.env?.VITE_SENTRY_TRACES_SAMPLE_RATE;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  return import.meta.env?.DEV ? 1.0 : 0.2;
}
