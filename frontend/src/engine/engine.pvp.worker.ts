/**
 * Dedicated entry for the SHARED PvP worker (M1: one socket for all PvP windows). A SINGLE instance
 * of this worker is spawned by `engineClient` and `Comlink.expose`s a `PvpHubApi`; every PvP window
 * routes its commands here keyed by `windowId`, and the hub multiplexes them over one `MpClient`.
 */
import * as Comlink from "comlink";
import { PvpHub } from "./pvpHub";
import { getSpec } from "./specs/registry";
import { elog } from "./debug";
import { initWorkerSentry } from "@/sentry/workerSentry";
import type { PvpHubApi } from "./engineApi";

// Before Comlink.expose: Sentry must be wired on both sides before either listens.
initWorkerSentry();

const hub = new PvpHub(getSpec);

const api: PvpHubApi = {
  init: (config) => hub.init(config),
  attachBridge: (bridge) => hub.attachBridge(bridge),
  subscribe: (onSnapshot) => hub.subscribe(onSnapshot),
  findMatch: (windowId, gameId, setup) =>
    hub.findMatch(windowId, gameId, setup),
  enterArenaMatch: (windowId, gameId, entry) =>
    hub.enterArenaMatch(windowId, gameId, entry),
  resume: (windowId, gameId) => hub.resume(windowId, gameId),
  submitInput: (windowId, input) => hub.submitInput(windowId, input),
  setAuto: (windowId, on) => hub.setAuto(windowId, on),
  setVisibility: (windowId, visible) => hub.setVisibility(windowId, visible),
  reset: (windowId) => hub.reset(windowId),
};

Comlink.expose(api);

// Proof this ran in the shared PvP worker thread; `self.name` is set by engineClient (`tunnel-pvp`).
elog("worker", "pvp-hub booted", typeof self !== "undefined" ? self.name : "");
