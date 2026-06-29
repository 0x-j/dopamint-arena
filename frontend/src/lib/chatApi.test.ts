import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ChatApiClient } from "./chatApi.ts";

test("chat returns assistant text (backend path)", async () => {
  const fetch = mock.fn(
    async () =>
      ({
        ok: true,
        json: async () => ({ content: "hello" }),
      }) as Response,
  );
  const client = new ChatApiClient(
    "http://localhost:8080",
    fetch as never,
    null,
    "sess_123",
    "tok",
  );
  const answer = await client.chat([{ role: "user", content: "hi" }]);
  assert.equal(answer, "hello");
});

test("chat sends Authorization header (backend path)", async () => {
  let authHeader = "";
  let url = "";
  const fetch = mock.fn(
    async (_url: string, init: { headers: Record<string, string> }) => {
      url = _url;
      authHeader = init.headers.Authorization;
      return {
        ok: true,
        json: async () => ({ content: "hello" }),
      } as Response;
    },
  );
  const client = new ChatApiClient(
    "http://localhost:8080",
    fetch as never,
    null,
    "sess_123",
    "tok",
  );
  await client.chat([{ role: "user", content: "hi" }]);
  assert.equal(url, "http://localhost:8080/v1/sessions/sess_123/chat");
  assert.equal(authHeader, "Bearer tok");
});

test("topic returns topic string (backend path)", async () => {
  const fetch = mock.fn(
    async () =>
      ({
        ok: true,
        json: async () => ({ topic: "weather" }),
      }) as Response,
  );
  const client = new ChatApiClient(
    "http://localhost:8080",
    fetch as never,
    null,
    "sess_123",
    "tok",
  );
  const topic = await client.topic();
  assert.equal(topic, "weather");
});

test("topic sends Authorization header (backend path)", async () => {
  let authHeader = "";
  let url = "";
  const fetch = mock.fn(
    async (_url: string, init?: { headers: Record<string, string> }) => {
      url = _url;
      authHeader = init?.headers.Authorization ?? "";
      return {
        ok: true,
        json: async () => ({ topic: "weather" }),
      } as Response;
    },
  );
  const client = new ChatApiClient(
    "http://localhost:8080",
    fetch as never,
    null,
    "sess_123",
    "tok",
  );
  await client.topic();
  assert.equal(url, "http://localhost:8080/v1/sessions/sess_123/chat/topic");
  assert.equal(authHeader, "Bearer tok");
});

test("chat calls ollama directly when configured", async () => {
  let calledUrl = "";
  let body: {
    model?: string;
    stream?: boolean;
    options?: { num_predict?: number };
  } = {};
  const fetch = mock.fn(async (url: string, init: { body: string }) => {
    calledUrl = url;
    body = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ message: { content: "hi back" } }),
    } as Response;
  });
  const client = new ChatApiClient("http://localhost:8080", fetch as never, {
    url: "http://ollama-host/",
    model: "qwen2.5:1.5b",
  });
  const answer = await client.chat([{ role: "user", content: "hi" }]);
  assert.equal(answer, "hi back");
  assert.equal(calledUrl, "http://ollama-host/api/chat");
  assert.equal(body.model, "qwen2.5:1.5b");
  assert.equal(body.stream, false);
  assert.equal(body.options?.num_predict, 64);
});

test("topic calls ollama directly and trims", async () => {
  let calledUrl = "";
  const fetch = mock.fn(async (url: string) => {
    calledUrl = url;
    return {
      ok: true,
      json: async () => ({ message: { content: "  cats vs dogs  " } }),
    } as Response;
  });
  const client = new ChatApiClient("http://localhost:8080", fetch as never, {
    url: "http://ollama-host",
    model: "qwen2.5:1.5b",
  });
  const topic = await client.topic();
  assert.equal(topic, "cats vs dogs");
  assert.equal(calledUrl, "http://ollama-host/api/chat");
});
