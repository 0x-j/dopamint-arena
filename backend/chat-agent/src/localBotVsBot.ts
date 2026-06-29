// Local dev helper: runs bot-vs-bot rounds against a local backend using the real
// local Ollama, publishing each transcript to /v1/sessions/:sessionId/chat/live/publish so the frontend
// Spectator tab can display the conversation. Not part of the shipped agent —
// safe to delete after manual testing.
import { MpClient, resolveMpWsUrl } from "./mpClient.ts";
import {
  OllamaBackendClient,
  registerChatSession,
} from "./ollama.ts";
import { runBotVsBot } from "./botVsBot.ts";
import { setTimeout as sleep } from "node:timers/promises";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:18080";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.CHAT_OLLAMA_MODEL ?? "qwen2.5:1.5b";
const WS_URL = `${resolveMpWsUrl(BACKEND_URL)}/v1/mp`;

const chatSession = await registerChatSession(
  BACKEND_URL,
  "0x0000000000000000000000000000000000000000000000000000000000000000",
);
const ollama = new OllamaBackendClient(
  OLLAMA_URL,
  BACKEND_URL,
  MODEL,
  {
    numPredict: 64,
    topicPredict: 24,
    numCtx: 2048,
    keepAlive: "30m",
  },
  chatSession.sessionId,
  chatSession.statsToken,
);

let n = 0;
const tunnelIdProvider = () => `0x2::chat::Tunnel-${Date.now()}-${++n}`;

console.log("[local-botvsbot] backend:", BACKEND_URL, "| ollama:", OLLAMA_URL);
while (true) {
  try {
    const alice = new MpClient(WS_URL, `0xalice-${n}`);
    const bob = new MpClient(WS_URL, `0xbob-${n}`);
    const topic = await ollama.topic();
    console.log("[local-botvsbot] round", n, "topic:", topic.trim());
    const result = await runBotVsBot({
      alice,
      bob,
      ollama,
      topic,
      tunnelIdProvider,
      maxMoves: 6,
    });
    console.log(
      "[local-botvsbot] published",
      result.messages.length,
      "msgs:",
      result.messages.map((m) => `${m.sender}: ${m.text}`).join(" | "),
    );
  } catch (e) {
    console.error("[local-botvsbot] round failed:", (e as Error)?.message ?? e);
  }
  await sleep(4000);
}
