//! S3 archival orchestration (ADR-0023). `archive_or_enqueue` is the fast path used by
//! the settle handler: one PutObject, and on exhaustion enqueue the bytes for durable
//! retry. `spawn_archive_drain` is the long-lived worker that retries queued uploads
//! until they land. Both are no-ops when S3/Postgres are unconfigured (dev/test).

#![allow(dead_code)] // wired into settle handler / main in later tasks

use std::time::Duration;

use crate::archive_queue::PendingArchive;
use crate::s3::ArchiveMeta;
use crate::state::SharedState;

/// Inline PutObject; on failure, durably enqueue for the worker. Fire-and-forget from
/// the caller (the settle handler spawns this). No-op when S3 is unconfigured.
pub async fn archive_or_enqueue(
    state: &SharedState,
    key: String,
    bytes: Vec<u8>,
    meta: ArchiveMeta,
) {
    let Some(archiver) = state.archiver.clone() else {
        return;
    };
    let tx_digest = meta.tx_digest.clone();
    match archiver.archive(&key, &bytes, &meta).await {
        Ok(()) => {}
        Err(e) => {
            tracing::warn!(%tx_digest, error = %e, "s3 archive inline failed; enqueuing for durable retry");
            let Some(queue) = state.archive_queue.clone() else {
                tracing::error!(%tx_digest, "s3 archive failed and no durable queue configured — upload lost");
                return;
            };
            if let Err(e) = queue
                .enqueue(PendingArchive {
                    tx_digest: tx_digest.clone(),
                    object_key: key,
                    bytes,
                    meta,
                })
                .await
            {
                tracing::error!(%tx_digest, error = %e, "failed to enqueue s3 archive — upload lost");
            }
        }
    }
}

/// Long-lived drain worker: every 10 seconds, retry due uploads until they land.
/// No-op (returns immediately) when archiver or queue is unconfigured.
pub fn spawn_archive_drain(state: SharedState) {
    if state.archiver.is_none() || state.archive_queue.is_none() {
        return;
    }
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        loop {
            tick.tick().await;
            if let Err(e) = drain_once(&state).await {
                tracing::warn!(error = %e, "s3 archive drain tick failed");
            }
        }
    });
}

async fn drain_once(state: &SharedState) -> anyhow::Result<()> {
    let Some(queue) = state.archive_queue.clone() else {
        return Ok(());
    };
    let Some(archiver) = state.archiver.clone() else {
        return Ok(());
    };
    for p in queue.drain_due(64).await? {
        match archiver.archive(&p.object_key, &p.bytes, &p.meta).await {
            Ok(()) => {
                queue.delete(&p.tx_digest).await?;
            }
            Err(e) => {
                tracing::warn!(digest = %p.tx_digest, error = %e, "s3 archive retry failed; requeued");
                queue.requeue(&p.tx_digest).await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive_queue::{ArchiveQueue, InMemoryArchiveQueue};
    use crate::s3::{archive_key, FakeArchiver, TranscriptArchiver};
    use crate::state::AppState;
    use std::sync::Arc;
    use std::sync::Mutex;

    /// Build a state wired with an in-memory queue + a configurable archiver.
    fn state_with(
        archiver: Arc<dyn TranscriptArchiver>,
        queue: Arc<dyn ArchiveQueue>,
    ) -> SharedState {
        let mut s = AppState::in_memory_for_test();
        let inner = Arc::get_mut(&mut s).expect("unique test arc");
        inner.archiver = Some(archiver);
        inner.archive_queue = Some(queue);
        s
    }

    fn meta(d: &str) -> ArchiveMeta {
        ArchiveMeta {
            tunnel_id: "0xt".into(),
            tx_digest: d.into(),
            transcript_root: "0xr".into(),
            settle_version: 2,
        }
    }

    #[tokio::test]
    async fn archive_or_enqueue_lands_when_s3_ok() {
        let f = Arc::new(FakeArchiver::default());
        let q = Arc::new(InMemoryArchiveQueue::default());
        let state = state_with(f.clone(), q.clone());
        archive_or_enqueue(
            &state,
            archive_key("", "0xt", "D1"),
            b"bytes".to_vec(),
            meta("D1"),
        )
        .await;
        assert_eq!(f.archived.lock().unwrap().len(), 1);
        assert!(q.drain_due(10).await.unwrap().is_empty()); // nothing queued
    }

    #[tokio::test]
    async fn archive_or_enqueue_enqueues_on_failure() {
        let f = Arc::new(FakeArchiver {
            archived: Mutex::new(vec![]),
            fail_with: Some("boom"),
        });
        let q = Arc::new(InMemoryArchiveQueue::default());
        let state = state_with(f, q.clone());
        archive_or_enqueue(
            &state,
            archive_key("", "0xt", "D1"),
            b"bytes".to_vec(),
            meta("D1"),
        )
        .await;
        let due = q.drain_due(10).await.unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].tx_digest, "D1");
        assert_eq!(due[0].bytes, b"bytes");
    }

    #[tokio::test]
    async fn drain_retries_then_deletes_on_success() {
        let f = Arc::new(FakeArchiver::default()); // succeeds
        let q = Arc::new(InMemoryArchiveQueue::default());
        q.enqueue(PendingArchive {
            tx_digest: "D1".into(),
            object_key: "k".into(),
            bytes: vec![9],
            meta: meta("D1"),
        })
        .await
        .unwrap();
        let state = state_with(f.clone(), q.clone());
        drain_once(&state).await.unwrap();
        assert_eq!(f.archived.lock().unwrap().len(), 1);
        assert!(q.drain_due(10).await.unwrap().is_empty()); // deleted on success
    }

    #[tokio::test]
    async fn drain_requeues_on_failure() {
        let f = Arc::new(FakeArchiver {
            archived: Mutex::new(vec![]),
            fail_with: Some("boom"),
        });
        let q = Arc::new(InMemoryArchiveQueue::default());
        q.enqueue(PendingArchive {
            tx_digest: "D1".into(),
            object_key: "k".into(),
            bytes: vec![9],
            meta: meta("D1"),
        })
        .await
        .unwrap();
        let state = state_with(f, q.clone());
        drain_once(&state).await.unwrap();
        // Row must still be present and retryable.
        let due = q.drain_due(10).await.unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].tx_digest, "D1");
    }
}
