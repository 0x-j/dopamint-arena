/**
 * The shared SOCKET worker (ADR-0030, Phase 2). Owns the ONE relay {@link MpClient} — a single
 * WebSocket for every PvP window — while each game runs in its own game worker. `engineClient` posts
 * `{type:"config"}` once, then `{type:"attach", windowId}` transferring one end of a `MessageChannel`
 * per game worker; each port gets a {@link SocketHost} that bridges that worker's {@link RemoteMpClient}
 * to the shared socket. `{type:"detach", windowId}` on window close disposes that host + drops its port
 * — otherwise its global MpClient event subs leak and `broadcastConn` keeps posting to a dead port.
 * Socket lifecycle is broadcast to every LIVE port so each session reflects drop/resume.
 *
 * Not a Comlink worker: it speaks the raw {@link BridgePort} protocol (frames/peer are hot-path and
 * want no proxy overhead), so it uses `self.onmessage` directly to receive config + transferred ports.
 */
import { MpClient } from "@/pvp/mpClient";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { SocketHost } from "./pool/socketHost";
import { initWorkerSentry } from "@/sentry/workerSentry";
import type { BridgePort } from "./pool/socketBridge";
import type { ConnStatus, EngineConfig } from "./engineApi";

// Before the self.onmessage assignment: Sentry wired before this side starts listening.
initWorkerSentry();

let cfg: EngineConfig | null = null;
let ready: Promise<MpClient> | null = null;
let connStatus: ConnStatus = "closed";
/** One entry per LIVE game worker (removed on detach) — the single source of ports, so a closed
 *  window leaves nothing behind. `host` is null until the socket connects and the host binds. */
const hosts = new Map<string, { port: MessagePort; host: SocketHost | null }>();

function broadcastConn(): void {
  for (const { port } of hosts.values())
    port.postMessage({ k: "conn", status: connStatus });
}

/** Open the one shared socket (memoized). The connection ephemeral authenticates the socket only —
 *  each match still mints its own tunnel ephemeral inside its game worker's session. */
function ensureSocket(config: EngineConfig): Promise<MpClient> {
  if (ready) return ready;
  const client = new MpClient(config.mpWsUrl, config.wallet, generateKeyPair());
  connStatus = "connecting";
  broadcastConn();
  client.onClose = () => {
    connStatus = "reconnecting";
    broadcastConn();
  };
  client.onResumeOk(() => {
    connStatus = "open";
    broadcastConn();
  });
  ready = client.connect().then(() => {
    connStatus = "open";
    broadcastConn();
    return client;
  });
  return ready;
}

/** Drop a closed game worker's host: dispose it (unsub its MpClient events + release its channels)
 *  and forget its port. Idempotent; safe if the host hasn't bound yet (attach raced detach). */
function detach(windowId: string): void {
  const entry = hosts.get(windowId);
  if (!entry) return;
  hosts.delete(windowId);
  entry.host?.dispose();
  try {
    entry.port.close();
  } catch {
    /* already gone */
  }
}

self.onmessage = (ev: MessageEvent): void => {
  const m = ev.data as {
    type?: string;
    config?: EngineConfig;
    windowId?: string;
  };
  if (m?.type === "config") {
    cfg = m.config ?? null;
    if (cfg) void ensureSocket(cfg);
    return;
  }
  if (m?.type === "attach") {
    const port = ev.ports[0];
    if (!port || !cfg || !m.windowId) return;
    const windowId = m.windowId;
    const entry: { port: MessagePort; host: SocketHost | null } = {
      port,
      host: null,
    };
    hosts.set(windowId, entry);
    // Tell the newcomer the current status right away; then bind its host once the socket is up. The
    // port buffers the game worker's early requests until SocketHost sets onmessage, so none are lost.
    port.postMessage({ k: "conn", status: connStatus });
    void ensureSocket(cfg).then((client) => {
      if (hosts.get(windowId) !== entry) return; // detached before the socket came up
      entry.host = new SocketHost(client, port as unknown as BridgePort);
    });
    return;
  }
  if (m?.type === "detach") {
    if (m.windowId) detach(m.windowId);
    return;
  }
};
