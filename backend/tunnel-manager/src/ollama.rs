//! Thin proxy client for a local Ollama instance. The live consumer is [`OllamaClient::reply`]
//! (the flash chat bot, via `flash_responder`); `chat`/`topic` are retained for tests and future
//! chat-v2 routes, hence the module-level dead-code allowance.
#![allow(dead_code)]

use std::time::Duration;

use anyhow::Context;
use serde::{Deserialize, Serialize};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const TOPIC_PROMPT: &str =
    "Give me one short, fun conversation topic for two chat bots. Answer with the topic only, no extra text.";

/// Output-token cap for a chat reply. Flash frames are 256 bytes; a short cap also keeps the bot
/// fast (generation time is roughly linear in tokens produced).
const REPLY_NUM_PREDICT: u32 = 64;

/// Keep the model resident between replies so back-to-back turns skip the cold-load penalty — the
/// single biggest latency win for a live chat loop.
const REPLY_KEEP_ALIVE: &str = "10m";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct OllamaChatRequest<'a> {
    model: &'a str,
    messages: &'a [OllamaMessage],
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: OllamaMessage,
}

/// Cheap to clone — `reqwest::Client` is an `Arc` handle over a shared connection pool, so every
/// clone reuses the same warm connections. The co-located flash bot clones one per match.
#[derive(Debug, Clone)]
pub struct OllamaClient {
    http: reqwest::Client,
    base_url: String,
    model: String,
}

/// Tuning knobs for a low-latency reply. Serialized into Ollama's `options` object.
#[derive(Debug, Serialize)]
struct OllamaOptions {
    num_predict: u32,
    temperature: f32,
}

#[derive(Debug, Serialize)]
struct OllamaReplyRequest<'a> {
    model: &'a str,
    messages: &'a [OllamaMessage],
    stream: bool,
    keep_alive: &'a str,
    options: OllamaOptions,
}

impl OllamaClient {
    pub fn new(base_url: String, model: String) -> anyhow::Result<Self> {
        let url = base_url
            .parse::<reqwest::Url>()
            .context("invalid Ollama base URL")?;
        let base_url = url.as_str().trim_end_matches('/').to_string();
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .context("failed to build reqwest client")?;
        Ok(Self {
            http,
            base_url,
            model,
        })
    }

    /// Non-streaming chat completion. Returns the assistant's text.
    pub async fn chat(&self, messages: &[OllamaMessage]) -> anyhow::Result<String> {
        let url = format!("{}/api/chat", self.base_url);
        let req = OllamaChatRequest {
            model: &self.model,
            messages,
            stream: false,
        };
        let resp: OllamaChatResponse = self
            .http
            .post(&url)
            .json(&req)
            .send()
            .await
            .context("ollama request failed")?
            .error_for_status()
            .context("ollama returned error")?
            .json()
            .await
            .context("ollama returned non-json")?;
        Ok(resp.message.content)
    }

    /// Low-latency chat reply for the live flash bot: caps output length, keeps the model warm, and
    /// reuses the pooled HTTP client. Non-streaming — one flash move carries one whole message.
    pub async fn reply(&self, messages: &[OllamaMessage]) -> anyhow::Result<String> {
        let url = format!("{}/api/chat", self.base_url);
        let req = OllamaReplyRequest {
            model: &self.model,
            messages,
            stream: false,
            keep_alive: REPLY_KEEP_ALIVE,
            options: OllamaOptions {
                num_predict: REPLY_NUM_PREDICT,
                temperature: 0.8,
            },
        };
        let resp: OllamaChatResponse = self
            .http
            .post(&url)
            .json(&req)
            .send()
            .await
            .context("ollama reply request failed")?
            .error_for_status()
            .context("ollama returned error")?
            .json()
            .await
            .context("ollama returned non-json")?;
        Ok(resp.message.content)
    }

    /// Ask Ollama for a short random conversation topic.
    pub async fn topic(&self) -> anyhow::Result<String> {
        let prompt = OllamaMessage {
            role: "user".into(),
            content: TOPIC_PROMPT.into(),
        };
        self.chat(&[prompt]).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn chat_forwards_messages_and_extracts_reply() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "message": { "role": "assistant", "content": "hello back" }
        });
        let expected_req = serde_json::json!({
            "model": "qwen2.5:1.5b",
            "messages": [{ "role": "user", "content": "hi" }],
            "stream": false,
        });
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .and(body_json(expected_req))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let client = OllamaClient::new(server.uri(), "qwen2.5:1.5b".into()).unwrap();
        let reply = client
            .chat(&[OllamaMessage {
                role: "user".into(),
                content: "hi".into(),
            }])
            .await
            .unwrap();
        assert_eq!(reply, "hello back");
    }

    #[tokio::test]
    async fn chat_forwards_messages_with_path_prefix() {
        // MockServer always serves from the root, but we can verify the client
        // builds the correct URL by giving it a path-prefixed base and matching
        // the full path.
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "message": { "role": "assistant", "content": "ok" }
        });
        Mock::given(method("POST"))
            .and(path("/ollama/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let base = format!("{}/ollama/", server.uri());
        let client = OllamaClient::new(base, "qwen2.5:1.5b".into()).unwrap();
        let reply = client
            .chat(&[OllamaMessage {
                role: "user".into(),
                content: "hi".into(),
            }])
            .await
            .unwrap();
        assert_eq!(reply, "ok");
    }

    #[tokio::test]
    async fn chat_returns_error_on_non_2xx() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&server)
            .await;

        let client = OllamaClient::new(server.uri(), "qwen2.5:1.5b".into()).unwrap();
        let err = client
            .chat(&[OllamaMessage {
                role: "user".into(),
                content: "hi".into(),
            }])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("ollama returned error"));
    }

    #[tokio::test]
    async fn chat_returns_error_on_invalid_json() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
            .mount(&server)
            .await;

        let client = OllamaClient::new(server.uri(), "qwen2.5:1.5b".into()).unwrap();
        let err = client
            .chat(&[OllamaMessage {
                role: "user".into(),
                content: "hi".into(),
            }])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("non-json"));
    }

    #[tokio::test]
    async fn new_rejects_invalid_url() {
        let err = OllamaClient::new("not a url".into(), "qwen2.5:1.5b".into()).unwrap_err();
        assert!(err.to_string().contains("invalid Ollama base URL"));
    }
}
