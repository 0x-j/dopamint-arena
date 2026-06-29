export interface ChatApiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LiveMessage {
  sender: string;
  text: string;
}

/**
 * Direct-to-Ollama config. When set, chat/topic bypass the backend proxy and
 * call Ollama directly. `url` is the exposed Ollama base (the ALB routes /api/*
 * to the sidecar): empty = same-origin (prod), a full URL = cross-origin (dev,
 * which requires OLLAMA_ORIGINS on the Ollama side).
 */
export interface OllamaDirectConfig {
  url: string;
  model: string;
  /** Cap on generated tokens (num_predict) for chat replies. Lower = faster. */
  maxTokens?: number;
}

const TOPIC_PROMPT =
  "Give me one short, fun conversation topic for two chat bots. Answer with the topic only, no extra text.";
const DEFAULT_MAX_TOKENS = 64;
const TOPIC_MAX_TOKENS = 24;

export class ChatApiClient {
  private baseUrl: string;
  private ollama: OllamaDirectConfig | null;
  private fetch: typeof globalThis.fetch;
  private sessionId?: string;
  private statsToken?: string;

  constructor(
    baseUrl: string,
    fetchImpl: typeof globalThis.fetch = (url, init) =>
      globalThis.fetch(url, init),
    ollama: OllamaDirectConfig | null = null,
    sessionId?: string,
    statsToken?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.ollama = ollama;
    this.sessionId = sessionId;
    this.statsToken = statsToken;
  }

  setSession(sessionId: string, statsToken: string): void {
    this.sessionId = sessionId;
    this.statsToken = statsToken;
  }

  async chat(messages: ChatApiMessage[]): Promise<string> {
    if (this.ollama) {
      return this.chatViaOllama(
        messages,
        this.ollama.maxTokens ?? DEFAULT_MAX_TOKENS,
      );
    }
    if (!this.sessionId || !this.statsToken) {
      throw new Error("chat session not registered");
    }
    const res = await this.fetch(
      `${this.baseUrl}/v1/sessions/${this.sessionId}/chat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.statsToken}`,
        },
        body: JSON.stringify({ messages }),
      },
    );
    if (!res.ok) throw new Error(`chat failed: ${res.status}`);
    const json = (await res.json()) as { content: string };
    return json.content;
  }

  async topic(): Promise<string> {
    if (this.ollama) {
      const reply = await this.chatViaOllama(
        [{ role: "user", content: TOPIC_PROMPT }],
        TOPIC_MAX_TOKENS,
      );
      return reply.trim();
    }
    if (!this.sessionId || !this.statsToken) {
      throw new Error("chat session not registered");
    }
    const res = await this.fetch(
      `${this.baseUrl}/v1/sessions/${this.sessionId}/chat/topic`,
      {
        headers: { Authorization: `Bearer ${this.statsToken}` },
      },
    );
    if (!res.ok) throw new Error(`topic failed: ${res.status}`);
    const json = (await res.json()) as { topic: string };
    return json.topic;
  }

  private async chatViaOllama(
    messages: ChatApiMessage[],
    maxTokens: number,
  ): Promise<string> {
    const base = this.ollama!.url.replace(/\/+$/, "");
    const res = await this.fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.ollama!.model,
        messages,
        stream: false,
        options: { num_predict: maxTokens },
      }),
    });
    if (!res.ok) throw new Error(`ollama chat failed: ${res.status}`);
    const json = (await res.json()) as { message?: { content?: string } };
    return json.message?.content ?? "";
  }

  subscribeLive(onMessage: (msg: LiveMessage) => void): () => void {
    const url = `${this.baseUrl}/v1/chat/live`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as LiveMessage;
        onMessage(parsed);
      } catch {
        // ignore parse errors
      }
    };
    es.onerror = (e) => {
      console.error("chat live sse error", e);
    };
    return () => es.close();
  }
}

/**
 * Build a ChatApiClient from frontend env. Calls Ollama directly when
 * VITE_OLLAMA_URL is set; otherwise falls back to the backend proxy (current
 * behavior), so nothing breaks until Ollama is exposed.
 */
export function createChatApiClient(
  sessionId?: string,
  statsToken?: string,
): ChatApiClient {
  const ollamaUrl = import.meta.env.VITE_OLLAMA_URL;
  const ollama: OllamaDirectConfig | null = ollamaUrl
    ? {
        url: ollamaUrl,
        model: import.meta.env.VITE_OLLAMA_MODEL ?? "qwen2.5:1.5b",
        ...(import.meta.env.VITE_OLLAMA_MAX_TOKENS
          ? { maxTokens: Number(import.meta.env.VITE_OLLAMA_MAX_TOKENS) }
          : {}),
      }
    : null;
  return new ChatApiClient(
    import.meta.env.VITE_BACKEND_URL ?? "",
    (url, init) => globalThis.fetch(url, init),
    ollama,
    sessionId,
    statsToken,
  );
}
