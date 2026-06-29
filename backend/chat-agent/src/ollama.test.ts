import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaBackendClient } from "./ollama.ts";
import type { OllamaSpeedOptions } from "./config.ts";

const SPEED: OllamaSpeedOptions = {
  numPredict: 64,
  topicPredict: 24,
  numCtx: 2048,
  keepAlive: "30m",
};

/** Routes every fetch to `handler`; `body` is the serialized request body. */
function mockFetch(
  handler: (url: string, body: string, init?: RequestInit) => Response,
): void {
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    Promise.resolve(
      handler(url, (init?.body as string | undefined) ?? "", init),
    )) as unknown as typeof fetch;
}

test("chat hits ollama directly with a capped num_predict", async () => {
  let postedUrl = "";
  let postedBody = "";
  mockFetch((url, body) => {
    postedUrl = url;
    postedBody = body;
    return new Response(
      JSON.stringify({ message: { role: "assistant", content: "hi back" } }),
      { status: 200 },
    );
  });
  const client = new OllamaBackendClient(
    "http://localhost:11434/",
    "http://localhost:8080",
    "qwen2.5:1.5b",
    SPEED,
    "sess_test",
    "tok_test",
  );
  const reply = await client.chat([{ role: "user", content: "hi" }]);
  assert.equal(reply, "hi back");
  assert.equal(postedUrl, "http://localhost:11434/api/chat");
  const req = JSON.parse(postedBody);
  assert.equal(req.model, "qwen2.5:1.5b");
  assert.equal(req.stream, false);
  assert.equal(req.options.num_predict, 64);
  assert.equal(req.options.num_ctx, 2048);
  assert.equal(req.keep_alive, "30m");
});

test("topic uses a tight cap and trims whitespace", async () => {
  let postedBody = "";
  mockFetch((_url, body) => {
    postedBody = body;
    return new Response(
      JSON.stringify({
        message: { role: "assistant", content: "  cats vs dogs  \n" },
      }),
      { status: 200 },
    );
  });
  const client = new OllamaBackendClient(
    "http://localhost:11434",
    "http://localhost:8080",
    "qwen2.5:1.5b",
    SPEED,
    "sess_test",
    "tok_test",
  );
  const topic = await client.topic();
  assert.equal(topic, "cats vs dogs");
  assert.ok(JSON.parse(postedBody).options.num_predict <= 24);
});

test("publishTranscript targets the session-scoped backend route", async () => {
  let postedUrl = "";
  let postedHeaders: Record<string, string> = {};
  mockFetch((url, _body, init) => {
    postedUrl = url;
    postedHeaders = (init?.headers as Record<string, string>) ?? {};
    return new Response("{}", { status: 200 });
  });
  const client = new OllamaBackendClient(
    "http://localhost:11434",
    "http://localhost:8080",
    "qwen2.5:1.5b",
    SPEED,
    "sess_test",
    "tok_test",
  );
  await client.publishTranscript([{ sender: "bot-alice", text: "hi" }]);
  assert.equal(
    postedUrl,
    "http://localhost:8080/v1/sessions/sess_test/chat/live/publish",
  );
  assert.equal(postedHeaders["Authorization"], "Bearer tok_test");
});

test("chat surfaces a non-2xx as an error", async () => {
  globalThis.fetch = (() =>
    Promise.resolve(new Response("boom", { status: 500 }))) as unknown as typeof fetch;
  const client = new OllamaBackendClient(
    "http://localhost:11434",
    "http://localhost:8080",
    "qwen2.5:1.5b",
    SPEED,
    "sess_test",
    "tok_test",
  );
  await assert.rejects(() => client.chat([{ role: "user", content: "hi" }]));
});
