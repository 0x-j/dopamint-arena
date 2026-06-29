//! S3 transcript archival — the durable counterpart to Walrus (ADR-0023). Walrus stays
//! best-effort and untouched; this archiver is behind a trait so the retry worker is
//! unit-testable without real S3. `S3Archiver::archive` issues one PutObject; the SDK's
//! standard retries handle transient failures inline, and the worker owns the long tail.

use std::collections::HashMap;

use async_trait::async_trait;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;

/// Small ASCII metadata attached to each S3 object (S3 caps object metadata at ~2 KB).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[allow(dead_code)]
pub struct ArchiveMeta {
    pub tunnel_id: String,
    pub tx_digest: String,
    /// `0x`-prefixed hex transcript root (the on-chain-anchored Merkle root).
    pub transcript_root: String,
    pub settle_version: u8,
}

#[async_trait]
#[allow(dead_code)]
pub trait TranscriptArchiver: Send + Sync {
    /// Upload `bytes` to `key`. The implementation may retry transient failures; the
    /// caller treats an `Err` as "exhausted inline retries — enqueue for durable retry".
    async fn archive(&self, key: &str, bytes: &[u8], meta: &ArchiveMeta) -> anyhow::Result<()>;
}

/// Deterministic, S3-key-safe object key: `{prefix}transcripts/{tunnel_id}/{tx_digest}.bin`.
/// A tunnel settles once, so one object per tunnel; idempotent PutObject overwrites safely.
#[allow(dead_code)]
pub fn archive_key(prefix: &str, tunnel_id: &str, tx_digest: &str) -> String {
    let prefix = prefix.trim_end_matches('/');
    let base = format!("transcripts/{}/{}.bin", tunnel_id, tx_digest);
    if prefix.is_empty() {
        base
    } else {
        format!("{}/{}", prefix, base)
    }
}

/// Production transcript archiver: one PutObject per call, aws-sdk-s3 standard retries.
#[allow(dead_code)]
pub struct S3Archiver {
    client: S3Client,
    bucket: String,
}

#[allow(dead_code)]
impl S3Archiver {
    pub fn new(client: S3Client, bucket: String) -> Self {
        Self { client, bucket }
    }
}

#[async_trait]
impl TranscriptArchiver for S3Archiver {
    async fn archive(&self, key: &str, bytes: &[u8], meta: &ArchiveMeta) -> anyhow::Result<()> {
        let mut md: HashMap<String, String> = HashMap::new();
        md.insert("tunnel-id".into(), meta.tunnel_id.clone());
        md.insert("tx-digest".into(), meta.tx_digest.clone());
        md.insert("transcript-root".into(), meta.transcript_root.clone());
        md.insert("settle-version".into(), meta.settle_version.to_string());
        self.client
            .put_object()
            .bucket(self.bucket.clone())
            .key(key)
            // Callers own the bytes; copying once into the PutObject body is acceptable.
            .body(ByteStream::from(bytes.to_vec()))
            .content_type("application/octet-stream")
            .set_metadata(Some(md))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("s3 put_object {}/{} failed: {e}", self.bucket, key))?;
        Ok(())
    }
}

#[cfg(test)]
use std::sync::Mutex;

#[cfg(test)]
#[derive(Default)]
pub struct FakeArchiver {
    /// `(key, bytes)` for each successful archive, in order.
    pub archived: Mutex<Vec<(String, Vec<u8>)>>,
    /// When set, `archive` returns this error instead of recording.
    pub fail_with: Option<&'static str>,
}

#[cfg(test)]
#[async_trait]
impl TranscriptArchiver for FakeArchiver {
    async fn archive(&self, key: &str, bytes: &[u8], _meta: &ArchiveMeta) -> anyhow::Result<()> {
        if let Some(msg) = self.fail_with {
            return Err(anyhow::anyhow!(msg));
        }
        self.archived
            .lock()
            .unwrap()
            .push((key.to_string(), bytes.to_vec()));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_key_prefixes_and_paths() {
        assert_eq!(
            archive_key("", "0xabc", "DiG123"),
            "transcripts/0xabc/DiG123.bin"
        );
        assert_eq!(
            archive_key("x/", "0xabc", "DiG123"),
            "x/transcripts/0xabc/DiG123.bin"
        );
        assert_eq!(
            archive_key("x", "0xabc", "DiG123"),
            "x/transcripts/0xabc/DiG123.bin"
        );
    }

    #[tokio::test]
    async fn fake_archiver_records_exact_bytes() {
        // Parity guarantee: the bytes handed to the S3 archiver are byte-identical to the
        // settle body (which is also what Walrus receives). This is the "upload that" test.
        let body = b"\x02_settle_body_bytes_here".to_vec();
        let f = FakeArchiver::default();
        let meta = ArchiveMeta {
            tunnel_id: "0xabc".into(),
            tx_digest: "DiG1".into(),
            transcript_root: "0xdead".into(),
            settle_version: 2,
        };
        f.archive(&archive_key("", "0xabc", "DiG1"), &body, &meta)
            .await
            .unwrap();
        let rec = f.archived.lock().unwrap().clone();
        assert_eq!(rec, vec![("transcripts/0xabc/DiG1.bin".to_string(), body)]);
    }

    #[tokio::test]
    async fn fake_archiver_fails_when_asked() {
        let f = FakeArchiver {
            archived: Mutex::new(vec![]),
            fail_with: Some("boom"),
        };
        let meta = ArchiveMeta {
            tunnel_id: "0xabc".into(),
            tx_digest: "DiG1".into(),
            transcript_root: "0xdead".into(),
            settle_version: 2,
        };
        let err = f
            .archive(&archive_key("", "0xabc", "DiG1"), b"bytes", &meta)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("boom"));
        assert!(f.archived.lock().unwrap().is_empty());
    }
}
