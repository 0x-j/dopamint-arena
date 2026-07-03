import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deserializeWorkerFault,
  isWorkerFaultMessage,
  serializeWorkerFault,
} from "./workerFaultProtocol";

test("worker fault round-trips with the original name, message, and stack", () => {
  const boom = new TypeError("hex.startsWith is not a function");
  const msg = serializeWorkerFault(boom, {
    workerName: "[pvp-game] w1",
    source: "handled",
    windowId: "w1",
    game: "battleship",
  });
  assert.equal(isWorkerFaultMessage(msg), true);
  const back = deserializeWorkerFault(msg);
  assert.equal(back.name, "TypeError");
  assert.equal(back.message, "hex.startsWith is not a function");
  assert.equal(back.stack, boom.stack);
});

test("non-Error throwables serialize to their string form without a stack", () => {
  const msg = serializeWorkerFault("socket closed", {
    workerName: "[pvp-socket] shared relay",
    source: "uncaught",
  });
  assert.equal(msg.__sentryWorkerFault.error.name, "Error");
  assert.equal(msg.__sentryWorkerFault.error.message, "socket closed");
  assert.equal(msg.__sentryWorkerFault.error.stack, undefined);
});

test("guard rejects Comlink frames, SDK envelopes, and non-objects", () => {
  // Comlink RPC frame
  assert.equal(
    isWorkerFaultMessage({ id: "c1", type: "APPLY", path: [] }),
    false,
  );
  // The SDK's own registerWebWorker envelope
  assert.equal(
    isWorkerFaultMessage({ _sentryMessage: true, _sentryDebugIds: {} }),
    false,
  );
  assert.equal(isWorkerFaultMessage(null), false);
  assert.equal(isWorkerFaultMessage("snap"), false);
  assert.equal(isWorkerFaultMessage({ __sentryWorkerFault: null }), false);
});
