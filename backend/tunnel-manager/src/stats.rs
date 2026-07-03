//! The stats broadcaster: publish the aggregate *counter* snapshot on the Redis `stats:snapshot`
//! channel each tick. The explorer indexer collapses the N-instance publishes per second into one
//! `metric_bucket` row (PK ts_bucket), and the live TPS rate is derived ONCE downstream from that
//! deduped series (`explorer::api::derive_live_frame`) — never per instance. Deriving the rate here
//! instead gave every instance its own window; the explorer fanned all N out interleaved and the
//! displayed number flipped between them. Publish raw counters only; let the single reader derive.

use std::time::Duration;

use crate::state::SharedState;

/// How often the counter snapshot is published. Kept short for a "live" feel; the indexer's
/// per-second primary key collapses the N-instance publishes into one row.
const TICK: Duration = Duration::from_millis(500);

/// Publish the aggregate counter snapshot once per tick on `stats:snapshot`. Raw counters only — no
/// rate is computed here (that would be a per-instance derivation; see the module note).
pub(crate) fn spawn_stats_broadcaster(state: SharedState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(TICK);
        loop {
            interval.tick().await;
            let snap = state.control.snapshot().await;
            if let Ok(json) = serde_json::to_string(&snap) {
                state.bus.publish_raw("stats:snapshot", json).await;
            }
        }
    });
}
