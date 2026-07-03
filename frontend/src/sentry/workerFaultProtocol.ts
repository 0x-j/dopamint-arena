/**
 * Wire shape for forwarding engine-worker faults to the main thread, where the ONE
 * Sentry client lives (workers only run `registerWebWorker`, which registers debug IDs
 * and forwards unhandled rejections but exposes no capture API). Pure module — no
 * DOM/worker globals — so both ends of the channel and node:test can share it.
 */

/** How the fault was observed; drives Sentry's `mechanism.handled` flag. */
export type WorkerFaultSource = "uncaught" | "handled";

export interface WorkerFaultContext {
  /** `self.name` of the posting worker (e.g. "[pvp-game] w1"). */
  workerName: string;
  source: WorkerFaultSource;
  windowId?: string;
  game?: string;
  matchId?: string;
}

/** Error flattened to clonable fields — postMessage-safe even for exotic throwables. */
export interface WorkerFaultError {
  name: string;
  message: string;
  stack?: string;
}

export interface WorkerFaultMessage {
  __sentryWorkerFault: {
    error: WorkerFaultError;
    context: WorkerFaultContext;
  };
}

export function serializeWorkerFault(
  err: unknown,
  context: WorkerFaultContext,
): WorkerFaultMessage {
  const cause = err instanceof Error ? err : null;
  return {
    __sentryWorkerFault: {
      error: {
        name: cause?.name ?? "Error",
        message: cause ? cause.message : String(err),
        stack: cause?.stack,
      },
      context,
    },
  };
}

/** True only for this channel's messages — never for Comlink RPC frames or the
 *  `_sentryMessage` envelopes the SDK's own `registerWebWorker` posts. */
export function isWorkerFaultMessage(
  data: unknown,
): data is WorkerFaultMessage {
  if (typeof data !== "object" || data === null) return false;
  const fault = (data as { __sentryWorkerFault?: unknown }).__sentryWorkerFault;
  return typeof fault === "object" && fault !== null;
}

/** Rebuild a throwable whose `.stack` is the ORIGINAL worker-side stack, so Sentry's
 *  stack parser (plus the debug IDs registered by `webWorkerIntegration`) symbolicates
 *  worker frames even though the capture happens on the main thread. */
export function deserializeWorkerFault(msg: WorkerFaultMessage): Error {
  const { name, message, stack } = msg.__sentryWorkerFault.error;
  const error = new Error(message);
  error.name = name;
  if (stack) error.stack = stack;
  return error;
}
