# 0023 — Control-plane durable S3-archive retry queue

- **Status**: Proposed
- **Date**: 2026-06-29
- **Refs**: refines [ADR-0005](0005-redis-backed-ha-control-plane.md) and
  [ADR-0015](0015-data-plane-local-control-plane-redis.md) (Redis-only control plane)
  by adding one narrow exception.

## Context

Settlement must archive each tunnel's off-chain transcript blob to S3 (in addition
to Walrus), and the S3 push **must succeed** — unlike Walrus, which is best-effort.
The only place the full transcript bytes exist is the tunnel-manager, at settle time.
For "must succeed" to hold across a process crash during a sustained S3 outage, the
bytes must reach a durable store before the process can lose them.

Redis/Valkey is a cache (evicts; ADR-0005) and cannot be that store. Postgres is the
system's only durable store, owned by the explorer. So the bytes must reach Postgres
— which means the control plane (tunnel-manager) must write to Postgres, breaking the
Redis-only rule ADR-0005/0015 established.

Two reasonable engineers disagree: keep the control plane Redis-only (clean boundary)
by shipping bytes to the explorer over Redis for durable retry, or give the control
plane narrow direct Postgres access to a work-queue table.

## Decision

We give the tunnel-manager read/write access to **one** append-only work-queue table
(`pending_s3_archive`) on the explorer's Postgres, via a bounded sqlx pool. The
table holds a failed S3 upload's bytes + key + metadata; a background worker in the
tunnel-manager drains it (PutObject → delete) until the object lands. This co-locates
the S3 client, the bytes, and the retry loop in the service that already has all three
at settle time, with a zero-loss fallback (once a row is written, the upload survives
a crash).

## Consequences

- The boundary crossing is **narrow and transient**: `pending_s3_archive` is a
  work queue (rows deleted on success), not control-plane state, and the pool is the
  same bounded sqlx pattern `shared::postgres` already uses to *read* explorer tables
  cross-crate. The explorer still owns the schema (Diesel migration).
- A residual loss window remains during the inline S3 attempt (~seconds): if the
  process crashes *and* S3 is unreachable in that window, that one upload is lost
  (a rare double-failure). Writing the Postgres row *before* the S3 call would close
  it at the cost of one transient bytea write per settle; deferred unless required.
- **What we chose not to do:** hand the bytes to the explorer over a Redis `LIST`
  (multi-MB blobs through Redis + a milliseconds loss window), or rely on Walrus as
  the byte source (Walrus is best-effort — it may not have the blob, so S3 could not
  succeed independently). aws-sdk-s3 (and thus aws-lc/cmake in the Dockerfile) is an
  accepted, contained exception to the repo's ring-only TLS stance, scoped to S3.
