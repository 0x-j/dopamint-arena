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

    /// End-to-end smoke against real AWS S3 + a local Postgres (Task 11). This is marked
    /// `#[ignore]` so CI does not need AWS credentials; run it manually with:
    ///   S3_TRANSCRIPTS_BUCKET=<bucket> DATABASE_URL=postgresql://dopamint:dopamint@localhost:5432/dopamint \
    ///     cargo test --locked -p tunnel-manager archive_worker::tests::e2e_real_s3_and_postgres_retry -- --ignored
    #[tokio::test]
    #[ignore = "needs real AWS credentials, S3_TRANSCRIPTS_BUCKET, and DATABASE_URL"]
    async fn e2e_real_s3_and_postgres_retry() {
        use std::sync::Mutex;
        use std::time::Duration;

        use aws_config::BehaviorVersion;
        use aws_sdk_s3::Client as S3Client;

        use crate::archive_queue::PgArchiveQueue;
        use crate::s3::{archive_key, ArchiveMeta, S3Archiver};
        use crate::state::AppState;

        let bucket = std::env::var("S3_TRANSCRIPTS_BUCKET").expect("set S3_TRANSCRIPTS_BUCKET");
        let database_url = std::env::var("DATABASE_URL").expect("set DATABASE_URL");
        let region = std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".into());

        let aws_cfg = aws_config::defaults(BehaviorVersion::latest())
            .region(aws_config::Region::new(region))
            .load()
            .await;
        let client = S3Client::new(&aws_cfg);
        let archiver = std::sync::Arc::new(S3Archiver::new(client.clone(), bucket.clone()));
        let queue = std::sync::Arc::new(
            PgArchiveQueue::connect(&database_url).await.expect("connect to postgres"),
        );

        let mut state = AppState::in_memory_for_test();
        let inner = std::sync::Arc::get_mut(&mut state).expect("unique test arc");
        inner.archiver = Some(archiver.clone());
        inner.archive_queue = Some(queue.clone());
        inner.s3_prefix = "e2e/".into();
        let state = state;

        let tx_digest = "E2EDiG1";
        let tunnel_id = "0xe2e";
        let key = archive_key("e2e/", tunnel_id, tx_digest);
        let bytes = b"real aws s3 e2e body".to_vec();
        let meta = ArchiveMeta {
            tunnel_id: tunnel_id.into(),
            tx_digest: tx_digest.into(),
            transcript_root: "0xroot".into(),
            settle_version: 2,
        };

        // 1. Happy path: inline PutObject lands in S3.
        archive_or_enqueue(&state, key.clone(), bytes.clone(), meta.clone()).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        let obj = client
            .get_object()
            .bucket(&bucket)
            .key(&key)
            .send()
            .await
            .expect("get object from S3");
        let body = obj.body.collect().await.expect("read body").into_bytes();
        assert_eq!(body.to_vec(), bytes, "S3 bytes must match");

        // 2. Failure path: a failing archiver enqueues to Postgres.
        let failing = std::sync::Arc::new(crate::s3::FakeArchiver {
            archived: Mutex::new(vec![]),
            fail_with: Some("boom"),
        }) as std::sync::Arc<dyn crate::s3::TranscriptArchiver>;
        let mut state2 = AppState::in_memory_for_test();
        let inner2 = std::sync::Arc::get_mut(&mut state2).expect("unique test arc");
        inner2.archiver = Some(failing);
        inner2.archive_queue = Some(queue.clone());
        inner2.s3_prefix = "e2e/".into();
        let state2 = state2;

        let tx_digest2 = "E2EDiG2";
        let key2 = archive_key("e2e/", tunnel_id, tx_digest2);
        let meta2 = ArchiveMeta {
            tunnel_id: tunnel_id.into(),
            tx_digest: tx_digest2.into(),
            transcript_root: "0xroot".into(),
            settle_version: 2,
        };
        archive_or_enqueue(&state2, key2.clone(), bytes.clone(), meta2).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let rows = queue.drain_due(10).await.expect("drain queued row");
        assert!(rows.iter().any(|r| r.tx_digest == tx_digest2), "row should be queued");

        // 3. Drain worker retries the queued row against real S3 and deletes it.
        let mut state3 = AppState::in_memory_for_test();
        let inner3 = std::sync::Arc::get_mut(&mut state3).expect("unique test arc");
        inner3.archiver = Some(archiver.clone());
        inner3.archive_queue = Some(queue.clone());
        inner3.s3_prefix = "e2e/".into();
        let state3 = state3;
        drain_once(&state3).await.expect("drain_once");
        tokio::time::sleep(Duration::from_millis(500)).await;

        let obj2 = client
            .get_object()
            .bucket(&bucket)
            .key(&key2)
            .send()
            .await
            .expect("get retried object from S3");
        let body2 = obj2.body.collect().await.expect("read body2").into_bytes();
        assert_eq!(body2.to_vec(), bytes, "retried S3 bytes must match");

        let rows_after = queue.drain_due(10).await.expect("drain after retry");
        assert!(
            !rows_after.iter().any(|r| r.tx_digest == tx_digest2),
            "row should be deleted after success"
        );
    }
}
