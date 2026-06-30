import { setTimeout as sleep } from "node:timers/promises";
import type { OllamaSpeedOptions } from "./config.ts";

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Ollama native /api/chat reply shape (non-streaming).
interface OllamaChatResponse {
  message: { role: string; content: string };
}

const TOPIC_PROMPT =
  "Give me one short, fun conversation topic for two chat bots. Answer with the topic only, no extra text.";

export interface ChatSessionCredentials {
  sessionId: string;
  statsToken: string;
}

export async function registerChatSession(
  backendUrl: string,
  userAddress: string,
): Promise<ChatSessionCredentials> {
  const resp = await fetch(`${backendUrl.replace(/\/+$/, "")}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userAddress,
      game: "chat",
      tunnels: [],
    }),
  });
  if (!resp.ok) {
    throw new Error(`registerChatSession failed: ${resp.status}`);
  }
  return parseChatSessionCredentials(await resp.json());
}

/** Reject a 200 body missing either credential field (e.g. an HTML error page). */
function parseChatSessionCredentials(data: unknown): ChatSessionCredentials {
  const { sessionId, statsToken } = (data ?? {}) as Record<string, unknown>;
  if (
    typeof sessionId !== "string" ||
    typeof statsToken !== "string" ||
    !sessionId ||
    !statsToken
  ) {
    throw new Error(
      `registerChatSession returned malformed credentials: ${JSON.stringify(data)}`,
    );
  }
  return { sessionId, statsToken };
}

export interface RegisterChatSessionRetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Base for exponential backoff; delay is `baseDelayMs * 2 ** (attempt - 1)`. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay. */
  maxDelayMs?: number;
  /** Override the sleep (tests pass a no-op). */
  delay?: (ms: number) => Promise<void>;
}

/**
 * Register a chat session, retrying with exponential backoff. The agent cannot
 * publish transcripts without credentials, so a transient backend blip at
 * startup must not be fatal — surface the failure only after the attempt budget
 * is spent.
 */
export async function registerChatSessionWithRetry(
  backendUrl: string,
  userAddress: string,
  opts: RegisterChatSessionRetryOptions = {},
): Promise<ChatSessionCredentials> {
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;
  const delay = opts.delay ?? ((ms: number) => sleep(ms));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await registerChatSession(backendUrl, userAddress);
    } catch (e) {
      lastError = e;
      if (attempt === attempts) break;
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.warn(
        `[chat-agent] registerChatSession failed (attempt ${attempt}/${attempts}), retrying in ${backoff}ms:`,
        (e as Error)?.message ?? e,
      );
      await delay(backoff);
    }
  }
  throw lastError;
}

/**
 * Generates chat replies by talking to a local Ollama instance directly,
 * skipping the chat backend's proxy hop. Transcript publishing still goes
 * through the backend (`/v1/sessions/:sessionId/chat/live/publish`) — that
 * route is not an LLM call.
 *
 * Tuned for speed over quality: output is capped (`num_predict`), the context
 * window is shrunk (`num_ctx`) so prompt processing is cheaper, and the model
 * is kept resident (`keep_alive`) so rounds don't pay a reload tax.
 */
export class OllamaBackendClient {
  /** Direct Ollama base URL, e.g. http://localhost:11434. */
  readonly ollamaUrl: string;
  /** Chat backend base URL, used only for transcript publishing. */
  readonly backendUrl: string;
  readonly model: string;
  private readonly speed: OllamaSpeedOptions;
  private readonly sessionId: string;
  private readonly statsToken: string;

  constructor(
    ollamaUrl: string,
    backendUrl: string,
    model: string,
    speed: OllamaSpeedOptions,
    sessionId: string,
    statsToken: string,
  ) {
    this.ollamaUrl = ollamaUrl.replace(/\/+$/, "");
    this.backendUrl = backendUrl.replace(/\/+$/, "");
    this.model = model;
    this.speed = speed;
    this.sessionId = sessionId;
    this.statsToken = statsToken;
  }

  /** Non-streaming chat completion; output length is capped by `num_predict`. */
  async chat(messages: OllamaMessage[]): Promise<string> {
    return this.complete(messages, this.speed.numPredict);
  }

  /** One-shot topic generation with a tight token cap. */
  async topic(): Promise<string> {
    const topic = await this.complete(
      [{ role: "user", content: TOPIC_PROMPT }],
      this.speed.topicPredict,
    );
    return topic.trim();
  }

  private async complete(
    messages: OllamaMessage[],
    numPredict: number,
  ): Promise<string> {
    const url = `${this.ollamaUrl}/api/chat`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        options: { num_predict: numPredict, num_ctx: this.speed.numCtx },
        keep_alive: this.speed.keepAlive,
      }),
    });
    if (!resp.ok) {
      throw new Error(`ollama returned ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as OllamaChatResponse;
    return data.message.content;
  }

  async publishTranscript(
    messages: { sender: string; text: string }[],
  ): Promise<void> {
    const url = `${this.backendUrl}/v1/sessions/${this.sessionId}/chat/live/publish`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.statsToken}`,
      },
      body: JSON.stringify({ messages }),
    });
    if (!resp.ok) {
      throw new Error(
        `publish transcript failed: ${resp.status} ${await resp.text()}`,
      );
    }
  }
}
