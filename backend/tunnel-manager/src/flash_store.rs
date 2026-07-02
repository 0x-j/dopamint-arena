//! In-memory store for the live bot-vs-bot flash transcript, plus SSE fan-out.

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

const CAP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashMessage {
    pub sender: String, // "A" | "B"
    pub text: String,
    pub move_no: u64,
}

pub struct FlashTranscriptStore {
    tx: broadcast::Sender<String>,
    #[allow(dead_code)] // retained for tests and a future /snapshot endpoint
    messages: std::sync::Mutex<Vec<FlashMessage>>,
}

impl FlashTranscriptStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel::<String>(64);
        Self {
            tx,
            messages: std::sync::Mutex::new(Vec::with_capacity(CAP)),
        }
    }
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    pub async fn publish(&self, msg: FlashMessage) {
        let json = serde_json::to_string(&msg).unwrap_or_default();
        {
            let mut v = self.messages.lock().expect("flash store lock");
            v.push(msg);
            if v.len() > CAP {
                let drop = v.len() - CAP;
                v.drain(0..drop);
            }
        }
        let _ = self.tx.send(json);
    }
}

impl Default for FlashTranscriptStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_fans_out_and_trims() {
        let store = FlashTranscriptStore::new();
        let mut rx = store.subscribe();
        for i in 0..(CAP + 5) {
            store
                .publish(FlashMessage {
                    sender: "A".into(),
                    text: format!("m{i}"),
                    move_no: i as u64,
                })
                .await;
            if i == 0 {
                // at least one event received on the subscriber before the broadcast buffer laps
                let first = rx.recv().await;
                assert!(first.is_ok());
            }
        }
        // ring trimmed to CAP
        assert_eq!(store.messages.lock().unwrap().len(), CAP);
    }
}
