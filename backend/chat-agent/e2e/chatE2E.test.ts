import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { resolve as pathResolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runBotVsBot } from "../src/botVsBot.ts";
import { MpClient, resolveMpWsUrl } from "../src/mpClient.ts";
import {
  OllamaBackendClient,
  registerChatSession,
} from "../src/ollama.ts";

const BACKEND_PORT = 18080;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const WS_URL = `${resolveMpWsUrl(BACKEND_URL)}/v1/mp`;
const SETTLER_KEY = Buffer.from(new Uint8Array(32)).toString("base64");

function startMockOllama(): Promise<{
  server: http.Server;
  url: string;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ message: { role: "assistant", content: "hello" } }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const close = () => {
          server.closeAllConnections?.();
          server.close();
        };
        resolve({ server, url: `http://127.0.0.1:${addr.port}`, close });
      } else {
        reject(new Error("mock ollama address"));
      }
    });
  });
}

function startBackend(ollamaUrl: string): Promise<{ stop: () => void }> {
  return new Promise((res, rej) => {
    const cwd = process.cwd();
    const binary = pathResolve(cwd, "../../target/debug/tunnel-manager");
    console.log("[e2e] starting backend binary:", binary);
    const proc = spawn(binary, [], {
      cwd: pathResolve(cwd, "../.."),
      env: {
        ...process.env,
        TUNNEL_MANAGER_ADDR: `127.0.0.1:${BACKEND_PORT}`,
        OLLAMA_URL: ollamaUrl,
        OLLAMA_MODEL: "qwen2.5:1.5b",
        SUI_RPC_URL: "http://127.0.0.1:9000",
        TUNNEL_PACKAGE_ID: "0x2",
        SUI_SETTLER_KEY: SETTLER_KEY,
        WALRUS_PUBLISHER_URL: "http://127.0.0.1:1",
        WALRUS_AGGREGATOR_URL: "http://127.0.0.1:1",
        RUST_LOG: "warn,tower_http=warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d.toString()));

    const stop = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    };

    const startupTimeout = setTimeout(() => {
      stop();
      rej(new Error(`backend failed to start within 30s: ${stderr}`));
    }, 30_000);

    const check = async () => {
      try {
        const health = await fetch(`${BACKEND_URL}/healthz`);
        if (health.ok) {
          clearTimeout(startupTimeout);
          console.log("[e2e] backend healthy");
          res({ stop });
          return;
        }
      } catch {
        // not up yet
      }
      if (proc.exitCode !== null) {
        clearTimeout(startupTimeout);
        rej(new Error(`backend exited early: ${stderr}`));
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

function subscribeLive(): Promise<{
  messages: { sender: string; text: string }[];
  stop: () => void;
}> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const messages: { sender: string; text: string }[] = [];
    const stop = () => controller.abort();

    fetch(`${BACKEND_URL}/v1/chat/live`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const read = async () => {
          try {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const data = line.replace(/^data:\s*/, "").trim();
              if (!data) continue;
              try {
                const m = JSON.parse(data) as { sender: string; text: string };
                messages.push(m);
              } catch {
                // ignore non-json
              }
            }
            await read();
          } catch {
            // stopped or aborted
          }
        };
        void read();
      })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        reject(e);
      });

    setTimeout(() => resolve({ messages, stop }), 300);
  });
}

test(
  "bot-vs-bot chat end-to-end through the real backend",
  { timeout: 60_000 },
  async () => {
    console.log("[e2e] starting mock ollama");
    const { url: ollamaUrl, close: closeOllama } = await startMockOllama();
    console.log("[e2e] mock ollama at", ollamaUrl);
    let backend: { stop: () => void } | undefined;
    try {
      backend = await startBackend(ollamaUrl);
      console.log("[e2e] backend started");

      const live = await subscribeLive();

      const chatSession = await registerChatSession(
        BACKEND_URL,
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      );
      const ollama = new OllamaBackendClient(
        ollamaUrl,
        BACKEND_URL,
        "qwen2.5:1.5b",
        { numPredict: 64, topicPredict: 24, numCtx: 2048, keepAlive: "30m" },
        chatSession.sessionId,
        chatSession.statsToken,
      );
      const alice = new MpClient(WS_URL, "0xalice");
      const bob = new MpClient(WS_URL, "0xbob");

      let tunnelCounter = 0;
      const tunnelIdProvider = () => {
        tunnelCounter += 1;
        return `0x2::chat::Tunnel-${Date.now()}-${tunnelCounter}`;
      };

      const result = await runBotVsBot({
        alice,
        bob,
        ollama,
        topic: "weather",
        tunnelIdProvider,
        maxMoves: 2,
      });

      console.log("[e2e] runBotVsBot result:", result);
      await sleep(1000);
      live.stop();

      console.log("[e2e] live messages:", live.messages);
      assert.equal(result.messages.length > 0, true, "transcript has messages");
      assert.equal(
        live.messages.length > 0,
        true,
        "SSE delivered at least one message",
      );
      assert.equal(live.messages[0].text, "hello");
    } finally {
      console.log("[e2e] tearing down");
      if (backend) {
        backend.stop();
      }
      closeOllama();
    }
  },
);
