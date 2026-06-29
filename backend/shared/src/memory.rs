//! In-memory `SettlementStore` for local dev + unit tests (no Postgres). Mirrors the
//! upsert/upgrade + write-time-counter semantics of the Postgres impl so the parity
//! tests in postgres.rs hold.

use std::collections::HashMap;
use std::sync::RwLock;

use crate::{
    decode_cursor, encode_cursor, LifecycleKind, SettlementPage, SettlementQuery, SettlementRow,
    SettlementStore,
};

#[derive(Default)]
pub struct InMemorySettlementStore {
    rows: RwLock<HashMap<String, SettlementRow>>,
    settled: RwLock<i64>,
}

impl InMemorySettlementStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seed/update a row (dev + tests). Upgrade-only on gap fields; bumps settled_count once
    /// per new Settled digest — mirrors the indexer's write-time counter. Not on the read trait.
    pub async fn upsert(&self, row: SettlementRow) -> anyhow::Result<()> {
        let mut rows = self.rows.write().unwrap();
        match rows.get_mut(&row.tx_digest) {
            Some(existing) => {
                // Upgrade only: fill gaps, never downgrade a present field.
                if existing.proof_url.is_none() {
                    existing.proof_url = row.proof_url;
                }
                if existing.walrus_blob_id.is_none() {
                    existing.walrus_blob_id = row.walrus_blob_id;
                }
                if existing.party_a_addr.is_none() {
                    existing.party_a_addr = row.party_a_addr;
                }
                if existing.party_b_addr.is_none() {
                    existing.party_b_addr = row.party_b_addr;
                }
            }
            None => {
                if row.kind == LifecycleKind::Settled {
                    *self.settled.write().unwrap() += 1;
                }
                rows.insert(row.tx_digest.clone(), row);
            }
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl SettlementStore for InMemorySettlementStore {
    async fn get(&self, tx_digest: &str) -> anyhow::Result<Option<SettlementRow>> {
        Ok(self.rows.read().unwrap().get(tx_digest).cloned())
    }

    async fn list(&self, q: &SettlementQuery) -> anyhow::Result<SettlementPage> {
        // Composite keyset over (ts, digest, tunnel_id): a row is "before" the cursor when its ts
        // is smaller, or ts ties and digest sorts lower, or both tie and tunnel_id sorts lower —
        // matching the (ts DESC, digest DESC, tunnel_id DESC) order. tunnel_id is in the key because
        // one tx (PTB) can settle many tunnels (shared ts+digest), else a sibling is skipped at a
        // page edge.
        let cur = q.cursor.as_deref().and_then(decode_cursor);
        let mut v: Vec<SettlementRow> = self
            .rows
            .read()
            .unwrap()
            .values()
            .filter(|r| q.tunnel_id.as_deref().map_or(true, |t| r.tunnel_id == t))
            .filter(|r| q.kind.map_or(true, |k| r.kind == k))
            .filter(|r| {
                q.address.as_deref().map_or(true, |a| {
                    r.party_a_addr.as_deref() == Some(a) || r.party_b_addr.as_deref() == Some(a)
                })
            })
            .filter(|r| match &cur {
                None => true,
                Some((ts, digest, tunnel)) => {
                    r.timestamp_ms < *ts
                        || (r.timestamp_ms == *ts && r.tx_digest < *digest)
                        || (r.timestamp_ms == *ts
                            && r.tx_digest == *digest
                            && r.tunnel_id < *tunnel)
                }
            })
            .cloned()
            .collect();
        v.sort_by(|a, b| {
            b.timestamp_ms
                .cmp(&a.timestamp_ms)
                .then_with(|| b.tx_digest.cmp(&a.tx_digest))
                .then_with(|| b.tunnel_id.cmp(&a.tunnel_id))
        });
        let limit = q.limit.clamp(1, 1000) as usize;
        let next_cursor = if v.len() > limit {
            let last = &v[limit - 1];
            Some(encode_cursor(
                last.timestamp_ms,
                &last.tx_digest,
                &last.tunnel_id,
            ))
        } else {
            None
        };
        v.truncate(limit);
        Ok(SettlementPage {
            rows: v,
            next_cursor,
        })
    }

    async fn settled_count(&self) -> anyhow::Result<i64> {
        Ok(*self.settled.read().unwrap())
    }

    // No time-series in the in-memory store; the metric_bucket table lives only in Postgres.
    async fn metric_history(
        &self,
        _from_secs: i64,
        _to_secs: i64,
        _stride_secs: i64,
    ) -> anyhow::Result<Vec<(i64, i64)>> {
        Ok(vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(digest: &str, ts: i64, kind: LifecycleKind) -> SettlementRow {
        SettlementRow {
            tx_digest: digest.into(),
            kind,
            tunnel_id: "0xtun".into(),
            party_a_addr: None,
            party_b_addr: None,
            party_a_balance: Some(60),
            party_b_balance: Some(40),
            final_nonce: Some(3),
            transcript_root: Some("aa".into()),
            proof_url: None,
            walrus_blob_id: None,
            checkpoint: 100,
            timestamp_ms: ts,
            closed_at_ms: Some(ts),
            game: None,
        }
    }

    #[tokio::test]
    async fn upsert_counts_settled_once_and_upgrades_proof_url() {
        let s = InMemorySettlementStore::new();
        s.upsert(row("d1", 10, LifecycleKind::Settled))
            .await
            .unwrap();
        // indexer-sourced bare row first (no proof); then /settle enriches it.
        let mut enriched = row("d1", 10, LifecycleKind::Settled);
        enriched.proof_url = Some("https://agg/v1/blobs/x".into());
        s.upsert(enriched).await.unwrap();
        assert_eq!(
            s.settled_count().await.unwrap(),
            1,
            "same digest counts once"
        );
        assert_eq!(
            s.get("d1").await.unwrap().unwrap().proof_url.as_deref(),
            Some("https://agg/v1/blobs/x"),
            "proof_url is upgraded in place"
        );
    }

    #[tokio::test]
    async fn upsert_never_downgrades_proof_url() {
        let s = InMemorySettlementStore::new();
        let mut first = row("d1", 10, LifecycleKind::Settled);
        first.proof_url = Some("https://agg/v1/blobs/x".into());
        s.upsert(first).await.unwrap();
        s.upsert(row("d1", 10, LifecycleKind::Settled))
            .await
            .unwrap(); // bare, no proof
        assert_eq!(
            s.get("d1").await.unwrap().unwrap().proof_url.as_deref(),
            Some("https://agg/v1/blobs/x"),
            "a present proof_url is never cleared"
        );
    }

    #[tokio::test]
    async fn list_is_newest_first_keyset_paginated_and_filtered() {
        let s = InMemorySettlementStore::new();
        for (d, ts) in [("a", 10), ("b", 20), ("c", 30)] {
            s.upsert(row(d, ts, LifecycleKind::Settled)).await.unwrap();
        }
        let p1 = s
            .list(&SettlementQuery {
                limit: 2,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            p1.rows
                .iter()
                .map(|r| r.tx_digest.clone())
                .collect::<Vec<_>>(),
            ["c", "b"]
        );
        assert_eq!(p1.next_cursor.as_deref(), Some("20:b:0xtun"));
        let p2 = s
            .list(&SettlementQuery {
                cursor: p1.next_cursor,
                limit: 2,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            p2.rows
                .iter()
                .map(|r| r.tx_digest.clone())
                .collect::<Vec<_>>(),
            ["a"]
        );
        assert_eq!(p2.next_cursor, None);
    }

    // Regression: a ts-only cursor would drop same-millisecond rows at a page edge. With the
    // composite cursor all three rows sharing ts=50 must appear across the two pages.
    #[tokio::test]
    async fn list_keeps_same_timestamp_rows_across_a_page_boundary() {
        let s = InMemorySettlementStore::new();
        for d in ["a", "b", "c"] {
            s.upsert(row(d, 50, LifecycleKind::Settled)).await.unwrap();
        }
        let p1 = s
            .list(&SettlementQuery {
                limit: 2,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(p1.rows.len(), 2);
        let p2 = s
            .list(&SettlementQuery {
                cursor: p1.next_cursor.clone(),
                limit: 2,
                ..Default::default()
            })
            .await
            .unwrap();
        let mut seen: Vec<String> = p1
            .rows
            .iter()
            .chain(p2.rows.iter())
            .map(|r| r.tx_digest.clone())
            .collect();
        seen.sort();
        assert_eq!(seen, ["a", "b", "c"], "no same-ts row dropped across pages");
    }

    #[tokio::test]
    async fn list_filters_by_address_on_either_seat() {
        let s = InMemorySettlementStore::new();
        let mut r = row("d1", 10, LifecycleKind::Settled);
        r.party_b_addr = Some("0xbob".into());
        s.upsert(r).await.unwrap();
        let hit = s
            .list(&SettlementQuery {
                limit: 10,
                address: Some("0xbob".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(hit.rows.len(), 1);
        let miss = s
            .list(&SettlementQuery {
                limit: 10,
                address: Some("0xnobody".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(miss.rows.len(), 0);
    }
}
