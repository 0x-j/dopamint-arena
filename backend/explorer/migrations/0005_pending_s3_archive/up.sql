-- Durable retry queue for S3 transcript archival (ADR-0023). The tunnel-manager
-- enqueues a settle's transcript blob here when the inline S3 PutObject fails; a
-- background worker drains it (PutObject -> delete) until the object lands. Rows are
-- transient — deleted on success. Schema owned by the explorer (Diesel
-- embed_migrations!), written/read by the tunnel-manager via sqlx (same cross-crate
-- pattern as shared::postgres on `settlement`).
CREATE TABLE IF NOT EXISTS pending_s3_archive (
    tx_digest       TEXT PRIMARY KEY,
    object_key      TEXT   NOT NULL,
    bytes           BYTEA  NOT NULL,
    metadata        JSONB  NOT NULL,
    attempts        INT    NOT NULL DEFAULT 0,
    created_at      BIGINT NOT NULL,
    next_attempt_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_s3_archive_due_idx
    ON pending_s3_archive (next_attempt_at);
