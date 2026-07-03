//! Ollama-backed [`ChatResponder`] for the co-located flash chat bot. It turns the recent
//! plaintext transcript into the bot's reply: prepend a persona system prompt, map turns to
//! chat-completion roles, and call Ollama under a tight latency budget. Any miss — error, timeout,
//! or empty reply — yields `None`, and the flash strategy falls back to its instant Markov reply,
//! so a slow or unreachable model never stalls the conversation.

use std::time::Duration;

use tunnel_flash::{ChatReply, ChatResponder, ChatRole, ChatTurn};

use crate::ollama::{OllamaClient, OllamaMessage};

/// Persona + length guidance. Keeping replies to one short sentence also bounds generation time.
const SYSTEM_PROMPT: &str = "You are a witty, upbeat companion in a fast-paced arena chat. \
Reply with ONE short, casual sentence, under 200 characters. Stay conversational and playful; \
never explain that you are an AI.";

/// Per-call latency budget. On elapse the responder returns `None` and the bot answers instantly
/// from its Markov fallback instead of blocking the match on a slow model.
const REPLY_TIMEOUT: Duration = Duration::from_secs(6);

pub struct OllamaFlashResponder {
    client: OllamaClient,
    timeout: Duration,
}

impl OllamaFlashResponder {
    pub fn new(client: OllamaClient) -> Self {
        Self {
            client,
            timeout: REPLY_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(client: OllamaClient, timeout: Duration) -> Self {
        Self { client, timeout }
    }

    /// Prepend the persona system prompt, then map each transcript turn to its chat role.
    fn build_messages(turns: &[ChatTurn]) -> Vec<OllamaMessage> {
        let mut messages = Vec::with_capacity(turns.len() + 1);
        messages.push(OllamaMessage {
            role: "system".into(),
            content: SYSTEM_PROMPT.into(),
        });
        for turn in turns {
            let role = match turn.role {
                ChatRole::User => "user",
                ChatRole::Assistant => "assistant",
            };
            messages.push(OllamaMessage {
                role: role.into(),
                content: turn.text.clone(),
            });
        }
        messages
    }
}

impl ChatResponder for OllamaFlashResponder {
    fn respond<'a>(&'a self, turns: &'a [ChatTurn]) -> ChatReply<'a> {
        Box::pin(async move {
            let messages = Self::build_messages(turns);
            match tokio::time::timeout(self.timeout, self.client.reply(&messages)).await {
                Ok(Ok(text)) if !text.trim().is_empty() => Some(text),
                // Empty reply is unusable as a flash move → fall back.
                Ok(Ok(_)) => None,
                Ok(Err(e)) => {
                    tracing::debug!("flash ollama reply failed, using fallback: {e:#}");
                    None
                }
                Err(_) => {
                    tracing::debug!(
                        "flash ollama reply exceeded {:?}, using fallback",
                        self.timeout
                    );
                    None
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn ok_reply(text: &str) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "message": { "role": "assistant", "content": text }
        }))
    }

    fn turns() -> Vec<ChatTurn> {
        vec![
            ChatTurn {
                role: ChatRole::User,
                text: "hey bot".into(),
            },
            ChatTurn {
                role: ChatRole::Assistant,
                text: "hey yourself!".into(),
            },
            ChatTurn {
                role: ChatRole::User,
                text: "what's up".into(),
            },
        ]
    }

    #[tokio::test]
    async fn forwards_persona_and_transcript_and_returns_reply() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ok_reply("not much, ready to play!"))
            .mount(&server)
            .await;
        let responder = OllamaFlashResponder::new(
            OllamaClient::new(server.uri(), "qwen2.5:1.5b".into()).unwrap(),
        );

        let reply = responder.respond(&turns()).await;
        assert_eq!(reply.as_deref(), Some("not much, ready to play!"));

        // The request carries the system persona first, then the transcript in order/role.
        let reqs = server.received_requests().await.unwrap();
        let body: Value = reqs[0].body_json().unwrap();
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "hey bot");
        assert_eq!(msgs[2]["role"], "assistant");
        assert_eq!(msgs[3]["content"], "what's up");
        // Latency knobs are applied.
        assert_eq!(body["stream"], false);
        assert_eq!(body["keep_alive"], "10m");
        assert!(body["options"]["num_predict"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn declines_on_server_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let responder =
            OllamaFlashResponder::new(OllamaClient::new(server.uri(), "m".into()).unwrap());
        assert_eq!(responder.respond(&turns()).await, None);
    }

    #[tokio::test]
    async fn declines_on_empty_reply() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ok_reply("   "))
            .mount(&server)
            .await;
        let responder =
            OllamaFlashResponder::new(OllamaClient::new(server.uri(), "m".into()).unwrap());
        assert_eq!(responder.respond(&turns()).await, None);
    }

    #[tokio::test]
    async fn declines_when_the_model_is_too_slow() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ok_reply("too late").set_delay(Duration::from_millis(400)))
            .mount(&server)
            .await;
        let responder = OllamaFlashResponder::with_timeout(
            OllamaClient::new(server.uri(), "m".into()).unwrap(),
            Duration::from_millis(50),
        );
        assert_eq!(responder.respond(&turns()).await, None);
    }
}
