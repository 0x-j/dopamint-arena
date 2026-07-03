/**
 * Both ends of the engine-worker Sentry channel. Design: ONE Sentry client on the main
 * thread; workers forward to it instead of running their own (a second client would
 * double-report every uncaught worker error that also bubbles to `window.onerror`, and
 * would split user/scope/session data).
 *
 * Worker side — `initWorkerSentry` + `captureWorkerException`. The SDK's
 * `registerWebWorker` already ships debug IDs to the parent and forwards unhandled
 * rejections; what it does NOT cover is (a) uncaught sync errors with their full stack
 * (the natively bubbled copy reaching `window.onerror` carries message+line only) and
 * (b) engine faults that are caught and surfaced in-band via `snapshot.error` (they
 * arrive on main as bare strings). Both are forwarded as {@link WorkerFaultMessage}s.
 *
 * Main side — `registerEngineWorkerWithSentry` adopts a freshly spawned worker into the
 * one `webWorkerIntegration` (the SDK forbids creating that integration twice) and
 * captures forwarded faults with the original worker stack + engine tags. Call it right
 * after `new Worker(...)`, before wiring Comlink — the SDK stops propagation of its own
 * envelopes so later listeners never see them, and attaching in the same task as the
 * constructor always beats the worker's first message.
 */
import * as Sentry from "@sentry/react";
import {
  deserializeWorkerFault,
  isWorkerFaultMessage,
  serializeWorkerFault,
  type WorkerFaultContext,
  type WorkerFaultSource,
} from "./workerFaultProtocol";

// --- Worker side ----------------------------------------------------------------------

/** The slice of DedicatedWorkerGlobalScope we touch, typed locally: tsconfig compiles
 *  workers under the DOM lib (no "WebWorker"), so the real type isn't in scope. */
type EngineWorkerScope = Parameters<
  typeof Sentry.registerWebWorker
>[0]["self"] & {
  name?: string;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
};

/** The worker global, or null on the main thread AND under node:test / jsdom (tests
 *  instantiate PvpMatchSession directly — telemetry must be a no-op there). */
function workerScope(): EngineWorkerScope | null {
  if (typeof self === "undefined") return null;
  if (typeof (globalThis as { document?: unknown }).document !== "undefined")
    return null;
  return self as unknown as EngineWorkerScope;
}

/** First statement of every engine-worker entry, before Comlink.expose / onmessage. */
export function initWorkerSentry(): void {
  const scope = workerScope();
  if (!scope) return;
  // Debug IDs for source-map symbolication + unhandled-rejection forwarding (SDK-native).
  Sentry.registerWebWorker({ self: scope });
  scope.addEventListener("error", (event) => {
    const fault = event.error ?? event.message;
    postWorkerFault(scope, fault, "uncaught");
    // Cancel the natively bubbled copy: it reaches window.onerror as message+line only
    // (no stack) and would double-report next to the rich fault forwarded above.
    event.preventDefault();
    console.error(fault);
  });
}

/** Report a fault the engine caught and will surface in-band (snapshot.error): the
 *  in-band path stringifies the error, so this is the only place the stack survives. */
export function captureWorkerException(
  err: unknown,
  context?: Omit<WorkerFaultContext, "workerName" | "source">,
): void {
  const scope = workerScope();
  if (!scope) return;
  postWorkerFault(scope, err, "handled", context);
}

function postWorkerFault(
  scope: EngineWorkerScope,
  err: unknown,
  source: WorkerFaultSource,
  context?: Omit<WorkerFaultContext, "workerName" | "source">,
): void {
  try {
    scope.postMessage(
      serializeWorkerFault(err, {
        workerName: scope.name ?? "worker",
        source,
        ...context,
      }),
    );
  } catch {
    /* telemetry must never break the engine */
  }
}

// --- Main-thread side -----------------------------------------------------------------

type EngineWorkerIntegration = ReturnType<typeof Sentry.webWorkerIntegration>;

/** Adopt a spawned engine worker into the main-thread Sentry client: debug-ID
 *  registration via the singleton WebWorker integration + the fault-channel listener.
 *  No-op when Sentry is disabled (no DSN). */
export function registerEngineWorkerWithSentry(worker: Worker): void {
  const client = Sentry.getClient();
  if (!client) return;
  const integration =
    client.getIntegrationByName<EngineWorkerIntegration>("WebWorker");
  if (integration) integration.addWorker(worker);
  else Sentry.addIntegration(Sentry.webWorkerIntegration({ worker }));
  worker.addEventListener("message", captureForwardedWorkerFault);
}

function captureForwardedWorkerFault(event: MessageEvent): void {
  if (!isWorkerFaultMessage(event.data)) return;
  const { context } = event.data.__sentryWorkerFault;
  const error = deserializeWorkerFault(event.data);
  Sentry.withScope((scope) => {
    scope.setTag("engine.worker", context.workerName);
    if (context.game) scope.setTag("engine.game", context.game);
    scope.setExtras({ windowId: context.windowId, matchId: context.matchId });
    Sentry.captureException(error, {
      mechanism: { handled: context.source === "handled", type: "generic" },
    });
  });
}
