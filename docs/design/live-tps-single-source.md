# Live TPS — read-time derivation from the counter series

> **Status:** accepted. Fixes the live-TPS `170k ↔ 0` flicker by deriving the rate once, in the
> read path, from the stored counter series — the Prometheus/Grafana `rate()` model.

## Root cause

TPS is a **global aggregate**, but it is derived **independently on each of the N tunnel-manager
instances** (each over its own private in-memory `RateWindow`,
`backend/tunnel-manager/src/stats.rs`), and the explorer relays **all N** snapshots interleaved to
`/v1/stats/live`. The frontend renders whichever frame arrived last, so the number flips between
instances that disagree. (Evidence: across adjacent SSE frames `totalActions` goes *backwards* and
`tps` is `0` on one instance while another reports `271k`.)

**Violated principle:** a rate is the **read-time derivative of a stored monotonic counter
series** — compute it once, in the read path, from the shared series (Prometheus/Grafana/RRDtool).
The writers must not each pre-compute and publish it.

## Decision

Derive live TPS the same way the **history** endpoint already does — from the `metric_bucket`
counter series — so live and history share **one source and one derivation**. No new Redis channel:
a value reproducible from stored state does not belong on an event bus (that's for irreducible
events like `explorer:events`). The current-TPS number becomes a deterministic function of stored
rows, so it is coherent regardless of how many tunnel-manager instances (2 → 10) or explorer-api
replicas run.

```
tunnel-manager × N ──stats:snapshot (raw counters)──► indexer ──► metric_bucket (1 row/sec, deduped)
                                                                      ▲ read last ~8s, 1/sec
explorer-api  ── derive current_tps(rows) ──► SSE /v1/stats/live ──► browser (unchanged)
```

## Changes

1. **`backend/tunnel-manager/src/stats.rs` — stop deriving.** `spawn_stats_broadcaster` no longer
   builds `RateWindow`s or sets `tps`/`peak_tps`/per-game `tps`, and no longer calls
   `update_peak_tps`. It still publishes `stats:snapshot` with the raw counters (`total_actions`,
   `active_tunnels`, `settled_tunnels`, per-game `total_actions`/`tunnels`) + `recent_events`, so
   the indexer keeps writing `metric_bucket`. Delete `RateWindow` (nothing else uses it); its
   regression intents move to `current_tps` tests (below).

2. **`backend/explorer/src/api.rs` — the one derivation.** Add, next to `peak_tps_points` (same
   derivation family, same gap/saturating guards):
   ```rust
   /// Current TPS = counter derivative over the trailing `window_secs`, from ascending
   /// (ts_secs, total_actions) rows. Deterministic ⇒ every reader of the same rows agrees. An
   /// isolated recent sample (all prior rows older than the window) yields 0: a rate needs two
   /// points inside the window, so a data gap can't smear the pre-gap accrual into a fake spike.
   pub(crate) fn current_tps(rows: &[(i64, i64)], window_secs: i64) -> f64 {
       let Some(&(t_last, v_last)) = rows.last() else { return 0.0 };
       let anchor = rows.iter().rev().take_while(|&&(t, _)| t_last - t <= window_secs).last();
       let Some(&(t0, v0)) = anchor else { return 0.0 };
       let dt = t_last - t0;
       if dt <= 0 { return 0.0; }
       (v_last - v0).max(0) as f64 / dt as f64   // reset ⇒ 0, never negative
   }
   ```

3. **`backend/shared` — reader + durable-peak writer.** Add to `SettlementStore` (postgres +
   memory): `metric_recent(from_secs)` returning `metric_bucket` rows with `ts_bucket >= from_secs`
   ascending `(ts_bucket, total_actions, active_tunnels, settled_tunnels)` (the caller passes
   `now - window`; `metric_history` returns only `total_actions`, but the frame also needs
   active/settled); and `bump_peak_tps(candidate) -> peak`, a commutative `GREATEST` upsert on
   `metric_meta` (migration `0005_metric_meta`) that maintains the durable all-time peak.

4. **`backend/explorer/src/api.rs` + `bin/api.rs` — derive in the read path.** Remove the
   `stats:snapshot → stats_tx` Redis bridge. Add `peak_1s_rate(rows, gap)` (max 1s-resolution rate,
   reusing `peak_tps_points` at stride 1) and `derive_live_frame(rows, window, peak)`. Spawn a 1 Hz
   task: `store.metric_recent(now-8)` → `current_tps` (5 s, **smoothed** — the live number) + newest
   row for `totalActions/activeTunnels/settledTunnels`; `store.bump_peak_tps(peak_1s_rate(rows, 10))`
   for the **sharp, durable** peak; build the `StatsSnapshot`-shaped frame and `stats_tx.send(json)`.
   Seed the peak from the last 24 h of history on startup. `/v1/stats/live` SSE handler unchanged;
   explorer-api drops its Redis stats subscription and uses its existing Postgres store.

**Not changed:** frontend, the indexer, the history path, `metric_bucket` schema.

## Assumptions & non-goals (stated, not hidden)

- **Current vs peak window.** *Current* TPS uses a 5 s window (smooth — kills the flicker). *Peak*
  uses 1 s resolution (`peak_1s_rate`), because the max of a smoothed series under-reports a burst
  (a 6M/1s burst averages to ~1.2M over 5 s, which is why the old peak read 1.5M while the history
  chart showed 6M). Peak therefore matches `/v1/stats/history`, maintained all-time + durable via
  the `GREATEST` `metric_meta` row → coherent across replicas and restart-safe. Both numbers are
  deterministic functions of the shared rows.
- **Per-game live TPS** is not derivable from the global `metric_bucket`. v1 carries global
  tps/peak/totals; `perGame.tps` is deferred to **Phase 2** (a companion per-game bucket, derived
  the same way). Do the frontend per-game-chip cleanup then so it does not fall through to the
  buggy local `0` (`useSampledRate`).
- **`recentEvents`** rides the separate `explorer:events` SSE (`/v1/explorer/stream`), so the live
  frame need not carry it — verify the explorer page reads events from that stream during T3.
- **Freshness:** the browser still gets SSE **push**; only the internal explorer-api→Postgres read
  is a 1 s poll. If the indexer lags, `metric_bucket` goes stale → live TPS stale (same as history
  today; no new SPOF).

## Tasks (test-first; `cargo test -p <crate>`)

- [ ] **T1** `current_tps` in `explorer::api` + tests: steady counter ⇒ steady rate; bursty
      `+2 every 1.8 s` ⇒ bounded, never `0`, never spikes to 4 (port
      `bursty_single_player_rate_is_steady_not_aliased`); reset ⇒ `>= 0`; a `>gap` interval ⇒ `0`;
      empty/one row ⇒ `0`. `cargo test -p explorer api::`.
- [ ] **T2** `metric_recent` (trait + postgres + memory) + a memory-store unit test. `cargo test -p shared`.
- [ ] **T3** explorer-api bin: replace the `stats:snapshot` bridge with the 1 Hz derive task;
      adjust the SSE test. `cargo test -p explorer`.
- [ ] **T4** tunnel-manager: stop deriving; delete `RateWindow`; trim `stats.rs` tests to
      snapshot-shape. `cargo test -p tunnel-manager`.
- [ ] **T5** e2e: `curl -skN https://<alb>:443/v1/stats/live` ~30 s ⇒ one coherent series
      (`totalActions` monotonic non-decreasing; no interleaving `0`s). A genuine idle `0` from no
      traffic is expected (§ separate issues).

## Separate issues (not this fix)

- **Frozen counter / arena stall** — counter often genuinely flat (~2 real actions/sec vs ~55k
  idle tunnels); TPS is *truthfully* `0` between bursts. Engine problem.
- **Stale `activeTunnels` (~55k)** — membership not cleaned on abandoned tunnels.
- **~2 s SSE cadence** — publisher throttled (likely `control.snapshot()` `SCAN` cost); this fix
  removes N× of that scan. Revisit only if it still matters.
```
