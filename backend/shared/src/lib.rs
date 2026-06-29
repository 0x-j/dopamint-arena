//! Canonical types shared by the explorer indexer (writer) and explorer-api (reader).
//! `SettlementRow` is the durable read-model record; `SettlementStore` is the read-only
//! storage seam (Postgres in prod, in-memory for dev/tests). The framework (Diesel, in
//! the `explorer` crate) owns the `settlement` table, all writes, and checkpoint watermarks.

pub mod memory;
pub mod postgres;

/// A lifecycle event we index. Opens give context; settles are the verifiable closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleKind {
    Opened,
    Settled,
}

impl LifecycleKind {
    /// The DB/wire token for this kind (`"opened"` / `"settled"`) — matches the serde lowercase.
    pub fn as_str(self) -> &'static str {
        match self {
            LifecycleKind::Opened => "opened",
            LifecycleKind::Settled => "settled",
        }
    }

    /// Parse a DB/wire token back to a kind; `None` for anything else.
    pub fn from_db_str(s: &str) -> Option<LifecycleKind> {
        match s {
            "opened" => Some(LifecycleKind::Opened),
            "settled" => Some(LifecycleKind::Settled),
            _ => None,
        }
    }
}

/// Serialize a `u64`-derived `Option<i64>` as a decimal STRING on the JSON wire (ADR-0002: u64
/// values travel as decimal strings), so the browser keeps full precision past 2^53 — a balance
/// over ~9.0M SUI (2^53 MIST) would otherwise round-trip lossily through a JS `number` and break
/// the in-browser balance-conservation check. The Rust type stays `i64` (Postgres BIGINT).
mod opt_u64_str {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<i64>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(n) => s.serialize_some(&n.to_string()),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
        match Option::<String>::deserialize(d)? {
            Some(st) => st.parse().map(Some).map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

/// One durable, queryable settlement-index row, keyed by `tx_digest`. u64 on-chain
/// values are stored as i64 (Postgres BIGINT) — SUI amounts and nonces are well within
/// i63 range. JSON is camelCase to match the SDK/frontend (ADR-0002); monetary u64 fields go
/// out as decimal strings (see `opt_u64_str`). `checkpoint`/`timestamp_ms` stay numeric — they
/// are far below 2^53 for centuries and feed `Date`/cursor logic; revisit if that ever changes.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementRow {
    pub tx_digest: String,
    pub kind: LifecycleKind,
    pub tunnel_id: String,
    pub party_a_addr: Option<String>,
    pub party_b_addr: Option<String>,
    #[serde(with = "opt_u64_str")]
    pub party_a_balance: Option<i64>,
    #[serde(with = "opt_u64_str")]
    pub party_b_balance: Option<i64>,
    #[serde(with = "opt_u64_str")]
    pub final_nonce: Option<i64>,
    pub transcript_root: Option<String>,
    pub proof_url: Option<String>,
    pub walrus_blob_id: Option<String>,
    /// Sui checkpoint sequence number this lifecycle tx landed in.
    pub checkpoint: i64,
    pub timestamp_ms: i64,
    pub closed_at_ms: Option<i64>,
    pub game: Option<String>,
}

/// Keyset list query. `cursor` is an opaque `"{timestamp_ms}:{tx_digest}"` token taken from
/// a prior page's `next_cursor` (exclusive), newest-first; `None` starts at the newest. The
/// cursor is COMPOSITE (ts + digest) to match the `(timestamp_ms DESC, tx_digest DESC)` order
/// — a ts-only cursor silently drops rows that share a millisecond at a page boundary.
#[derive(Debug, Clone, Default)]
pub struct SettlementQuery {
    pub cursor: Option<String>,
    pub limit: i64,
    pub tunnel_id: Option<String>,
    pub address: Option<String>,
    pub kind: Option<LifecycleKind>,
}

/// Decode a `"{ts}:{digest}:{tunnel_id}"` keyset cursor. Sui digests (base58) and tunnel ids
/// (0x-hex) never contain `:`, so split into at most three. A legacy two-part `"{ts}:{digest}"`
/// token (in-flight clients across a deploy) decodes with an empty tunnel_id — the minimum in the
/// DESC keyset, so the transition never re-emits an already-seen row.
pub fn decode_cursor(token: &str) -> Option<(i64, String, String)> {
    let mut parts = token.splitn(3, ':');
    let ts = parts.next()?.parse().ok()?;
    let digest = parts.next()?.to_string();
    let tunnel_id = parts.next().unwrap_or("").to_string();
    Some((ts, digest, tunnel_id))
}
/// Build a `"{ts}:{digest}:{tunnel_id}"` keyset cursor. tunnel_id is part of the key because one
/// tx (PTB) can settle many tunnels — rows then share (ts, digest) and only tunnel_id breaks the tie.
pub fn encode_cursor(ts: i64, digest: &str, tunnel_id: &str) -> String {
    format!("{ts}:{digest}:{tunnel_id}")
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementPage {
    pub rows: Vec<SettlementRow>,
    /// Opaque `"{ts}:{digest}"` token to pass as the next `cursor`, or `None` on the last page.
    pub next_cursor: Option<String>,
}

/// Read-only settlement store. Single writer (framework indexer via Diesel), many readers
/// (explorer-api). `upsert`/`last_checkpoint` are NOT on this trait — the framework owns writes.
#[async_trait::async_trait]
pub trait SettlementStore: Send + Sync {
    async fn get(&self, tx_digest: &str) -> anyhow::Result<Option<SettlementRow>>;
    async fn list(&self, q: &SettlementQuery) -> anyhow::Result<SettlementPage>;
    /// Maintained counter (write-time, by the indexer's Diesel trigger), not a runtime aggregate.
    async fn settled_count(&self) -> anyhow::Result<i64>;
    /// Cumulative (ts_bucket, total_actions) points within [from_secs, to_secs], ascending,
    /// downsampled to one point per `stride_secs`-wide bucket (use 1 for full resolution). The
    /// per-bucket point is the bucket's MAX — and since the counter is monotonic, MAX is the
    /// bucket's last value, which is gap-robust (a bucket missing some seconds still reports its
    /// true endpoint, unlike point-sampling at fixed offsets).
    async fn metric_history(
        &self,
        from_secs: i64,
        to_secs: i64,
        stride_secs: i64,
    ) -> anyhow::Result<Vec<(i64, i64)>>;
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    fn row(party_a_balance: Option<i64>, final_nonce: Option<i64>) -> SettlementRow {
        SettlementRow {
            tx_digest: "d".into(),
            kind: LifecycleKind::Settled,
            tunnel_id: "0xt".into(),
            party_a_addr: None,
            party_b_addr: None,
            party_a_balance,
            party_b_balance: Some(0),
            final_nonce,
            transcript_root: None,
            proof_url: None,
            walrus_blob_id: None,
            checkpoint: 1,
            timestamp_ms: 2,
            closed_at_ms: None,
            game: None,
        }
    }

    #[test]
    fn u64_balances_serialize_as_decimal_strings_and_roundtrip_past_2_53() {
        // A balance past 2^53 MIST would round-trip lossily through a JS `number`; on the wire it
        // must be a string so the browser BigInts it exactly (else the conservation check breaks).
        let big = 9_007_199_254_740_993; // 2^53 + 1, unrepresentable as an f64
        let r = row(Some(big), Some(7));
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["partyABalance"], serde_json::json!("9007199254740993"));
        assert_eq!(json["finalNonce"], serde_json::json!("7"));
        assert!(json["partyBBalance"].is_string());
        // checkpoint/timestamp intentionally stay numeric (documented divergence on the struct).
        assert!(json["checkpoint"].is_number());
        assert_eq!(serde_json::from_value::<SettlementRow>(json).unwrap(), r);
    }

    #[test]
    fn null_u64_fields_serialize_as_json_null() {
        let json = serde_json::to_value(row(None, None)).unwrap();
        assert!(json["partyABalance"].is_null());
        assert!(json["finalNonce"].is_null());
        assert_eq!(
            serde_json::from_value::<SettlementRow>(json)
                .unwrap()
                .party_a_balance,
            None
        );
    }
}
