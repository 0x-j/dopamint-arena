//! Redis impls of `ControlStore`, `MpStore`, and `Bus` (fred 9.x). Selected when `REDIS_CACHE_URL`
//! is set. `RedisBus` uses sharded pub/sub: SPUBLISH for cross-instance delivery, `SubscriberClient`
//! for the inbound fan-in loop.

use std::collections::HashMap;
use std::sync::RwLock;

use async_trait::async_trait;
use fred::clients::SubscriberClient;
use fred::prelude::*;
use futures::TryStreamExt;
use tokio::sync::mpsc;

use super::{Bus, ConnRef, ControlStore, CtrlMsg, MpStore};
use crate::mp::ConnId;
use crate::state::{GameStat, SessionRecord, StatsSnapshot, TunnelEvent, TunnelStatus};

const SESSION_TTL: i64 = 24 * 3600;
const MATCH_TTL: i64 = 6 * 3600;
// Owner/game maps self-expire so they never grow unbounded; horizon must exceed the gap
// between TunnelCreated and a later Closed for visible (open-ended) tunnels.
const TUNNEL_OWNER_TTL: i64 = 24 * 3600;
// Dedup horizon for recent-events: must exceed the indexer's worst-case cursor-replay window.
const SEEN_TTL: i64 = 24 * 3600;
// Count-once horizon for settled tunnels: exceeds the indexer cursor-replay window (matches SEEN_TTL).
const SETTLED_SEEN_TTL: i64 = 24 * 3600;

// Per-address fixed-window faucet rate limit. Refuse (return 0) WITHOUT incrementing when already at
// `max`, so a rejected pull never inflates the counter (else a released slot couldn't be re-claimed);
// otherwise INCR, set the window TTL on the first pull (the key self-expires, resetting the window),
// and return 1. Atomic so a concurrent burst can't exceed `max`.
// KEYS[1]=faucet:count:<addr>  ARGV[1]=window_secs  ARGV[2]=max
const CLAIM_FAUCET_SLOT: &str = r#"
if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[2]) then return 0 end
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return 1
"#;

// Atomic dedup-then-push for the recent-events ring. Dedup is a per-digest
// `events:seen:<digest>` key with a TTL, so the dedup set self-expires (no unbounded growth).
// A re-polled event (cursor restart / second indexer) never double-inserts. Newest-first
// via LPUSH; LTRIM bounds the list.
//
// On a seen digest it is NOT a blind no-op: the /settle handler's enriched row (with a Walrus
// proofUrl) and the indexer's bare row race for the same close — and the handler loses when its
// ~6s Walrus upload lands its push after the indexer's 1s poll. So when this row carries a
// proofUrl the stored one lacks, upgrade it in place (cjson + LSET) so the proof link is never
// lost; never downgrade an existing proofUrl. Atomic under the script lock, so the LRANGE/LSET
// pair sees no concurrent mutation.
// KEYS[1]=events:recent KEYS[2]=events:seen:<digest>  ARGV[1]=json ARGV[2]=digest ARGV[3]=cap ARGV[4]=ttl
const PUSH_RECENT_EVENT: &str = r#"
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[4])) then
  redis.call('LPUSH', KEYS[1], ARGV[1])
  redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[3]) - 1)
  return 1
end
local incoming = cjson.decode(ARGV[1])
if incoming.proofUrl == nil or incoming.proofUrl == cjson.null then
  return 0
end
local rows = redis.call('LRANGE', KEYS[1], 0, -1)
for i = 1, #rows do
  local row = cjson.decode(rows[i])
  if row.txDigest == ARGV[2] then
    if row.proofUrl == nil or row.proofUrl == cjson.null then
      redis.call('LSET', KEYS[1], i - 1, ARGV[1])
      return 1
    end
    return 0
  end
end
return 0
"#;

// Running-max CAS for peak tps: store the new value only if it exceeds the stored one. Honors the
// aggregation invariant (owned/last-writer via Lua, never a Rust read-modify-write of a shared
// aggregate). Stored verbatim as a float string; snapshot GETs and parses it.
// KEYS[1]=stats:peak_tps  ARGV[1]=tps
const UPDATE_PEAK_TPS: &str = r#"
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local new = tonumber(ARGV[1])
if new > cur then redis.call('SET', KEYS[1], ARGV[1]) end
return 1
"#;

pub async fn connect(url: &str) -> anyhow::Result<RedisPool> {
    let config = RedisConfig::from_url(url)?;
    let pool = Builder::from_config(config).build_pool(6)?;
    pool.init().await?;
    Ok(pool)
}

// ===== ControlStore =====

pub struct RedisControlStore {
    pool: RedisPool,
}

impl RedisControlStore {
    pub fn new(pool: RedisPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ControlStore for RedisControlStore {
    async fn put_session(&self, id: &str, rec: SessionRecord) {
        let json = serde_json::to_string(&rec).unwrap();
        let res: Result<(), _> = self
            .pool
            .set(
                format!("session:{id}"),
                json,
                Some(Expiration::EX(SESSION_TTL)),
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis put_session set failed");
        }
        let res: Result<i64, _> = self
            .pool
            .incr_by(
                format!("stats:tunnels:game:{}", rec.game),
                rec.tunnels.len() as i64,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis put_session incr tunnels failed");
        }
        for t in &rec.tunnels {
            let res: Result<(), _> = self
                .pool
                .set(
                    format!("tunnel:game:{}", t.tunnel_id),
                    rec.game.clone(),
                    Some(Expiration::EX(TUNNEL_OWNER_TTL)),
                    None,
                    false,
                )
                .await;
            if let Err(e) = res {
                tracing::warn!(error = %e, "redis put_session set tunnel game failed");
            }
        }
    }

    async fn get_session(&self, id: &str) -> Option<SessionRecord> {
        let v: Option<String> = self.pool.get(format!("session:{id}")).await.ok().flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }

    // `active` is a SADD/SREM set (bounded — shrinks on close; SCARD gives the live count).
    // `settled` is a count-once INCR counter: a per-id NX dedup key gates the increment so N
    // indexers replaying Closed events don't over-count, without an ever-growing set.
    async fn set_tunnel_status(&self, id: &str, s: TunnelStatus) {
        let res: Result<(), _> = self
            .pool
            .set(
                format!("tunnel:{id}"),
                serde_json::to_string(&s).unwrap(),
                None,
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_tunnel_status set failed");
        }
        match s {
            TunnelStatus::Active => {
                let res: Result<i64, _> = self.pool.sadd("stats:tunnels:active", id).await;
                if let Err(e) = res {
                    tracing::warn!(error = %e, "redis set_tunnel_status sadd active failed");
                }
            }
            TunnelStatus::Closed => {
                let res: Result<i64, _> = self.pool.srem("stats:tunnels:active", id).await;
                if let Err(e) = res {
                    tracing::warn!(error = %e, "redis set_tunnel_status srem active failed");
                }
                // Count-once: SET NX returns nil when the id was already seen → no increment on
                // replay. The dedup key self-expires (TTL), so it never grows unbounded.
                let newly: Option<String> = self
                    .pool
                    .set(
                        format!("tunnels:seen:settled:{id}"),
                        "1",
                        Some(Expiration::EX(SETTLED_SEEN_TTL)),
                        Some(SetOptions::NX),
                        false,
                    )
                    .await
                    .ok()
                    .flatten();
                if newly.is_some() {
                    let res: Result<i64, _> = self.pool.incr("stats:tunnels:settled_count").await;
                    if let Err(e) = res {
                        tracing::warn!(error = %e, "redis set_tunnel_status incr settled_count failed");
                    }
                }
            }
            TunnelStatus::Created => {}
        }
    }

    async fn get_tunnel_status(&self, id: &str) -> Option<TunnelStatus> {
        let v: Option<String> = self.pool.get(format!("tunnel:{id}")).await.ok().flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn add_actions(&self, game: &str, delta: u64) {
        // Per-game only: the total is derived in `snapshot` as the sum of per-game keys.
        // Writing a separate total would be a redundant, single-slot write-hotspot (every
        // instance, every second) and could diverge from the per-game sum on partial failure.
        let res: Result<i64, _> = self
            .pool
            .incr_by(format!("stats:actions:game:{game}"), delta as i64)
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis add_actions incr per-game failed");
        }
    }

    async fn update_peak_tps(&self, tps: f64) {
        let res: Result<i64, _> = self
            .pool
            .eval(
                UPDATE_PEAK_TPS,
                vec!["stats:peak_tps".to_string()],
                vec![tps.to_string()],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis update_peak_tps eval failed");
        }
    }

    async fn snapshot(&self) -> StatsSnapshot {
        let active: i64 = self.pool.scard("stats:tunnels:active").await.unwrap_or(0);
        let settled: i64 = self
            .pool
            .get("stats:tunnels:settled_count")
            .await
            .ok()
            .flatten()
            .unwrap_or(0);

        let mut total_actions: u64 = 0;
        let mut per_game: HashMap<String, GameStat> = HashMap::new();
        for (prefix, is_actions) in [
            ("stats:actions:game:", true),
            ("stats:tunnels:game:", false),
        ] {
            let keys = self.scan_keys(&format!("{prefix}*")).await;
            for key in keys {
                let v: i64 = self.pool.get(&key).await.ok().flatten().unwrap_or(0);
                let game = key.trim_start_matches(prefix).to_owned();
                let entry = per_game.entry(game).or_insert(GameStat {
                    tps: 0.0,
                    tunnels: 0,
                    total_actions: 0,
                });
                if is_actions {
                    entry.total_actions = v as u64;
                    total_actions += v as u64;
                } else {
                    entry.tunnels = v as u64;
                }
            }
        }

        let peak_tps: f64 = self
            .pool
            .get::<Option<String>, _>("stats:peak_tps")
            .await
            .ok()
            .flatten()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);

        let recent_events = self.recent_events().await;
        StatsSnapshot {
            tps: 0.0, // filled by the broadcaster from its per-tick diff
            peak_tps,
            total_actions,
            active_tunnels: active as u64,
            settled_tunnels: settled as u64,
            per_game,
            recent_events,
        }
    }

    async fn push_recent_event(&self, ev: TunnelEvent) {
        let json = serde_json::to_string(&ev).unwrap();
        let res: Result<i64, _> = self
            .pool
            .eval::<i64, _, _, _>(
                PUSH_RECENT_EVENT,
                vec![
                    "events:recent".to_string(),
                    format!("events:seen:{}", ev.tx_digest),
                ],
                vec![
                    json,
                    ev.tx_digest.clone(),
                    crate::store::RECENT_EVENTS_CAP.to_string(),
                    SEEN_TTL.to_string(),
                ],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis push_recent_event eval failed");
        }
    }

    async fn recent_events(&self) -> Vec<TunnelEvent> {
        let raws: Vec<String> = self
            .pool
            .lrange(
                "events:recent",
                0,
                (crate::store::RECENT_EVENTS_CAP - 1) as i64,
            )
            .await
            .unwrap_or_default();
        raws.iter()
            .filter_map(|j| serde_json::from_str(j).ok())
            .collect()
    }

    // Set-once + TTL: NX gates first-writer-wins (replays no-op); TunnelOwner has no serde derive,
    // so the three fields are written as an explicit camelCase JSON object and read back by key.
    async fn set_tunnel_owner(&self, tunnel_id: &str, owner: crate::state::TunnelOwner) {
        let json = serde_json::json!({
            "partyA": owner.party_a,
            "partyB": owner.party_b,
            "funder": owner.funder,
        })
        .to_string();
        let res: Result<(), _> = self
            .pool
            .set(
                format!("tunnel:owner:{tunnel_id}"),
                json,
                Some(Expiration::EX(TUNNEL_OWNER_TTL)),
                Some(SetOptions::NX),
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_tunnel_owner set failed");
        }
    }

    async fn get_tunnel_owner(&self, tunnel_id: &str) -> Option<crate::state::TunnelOwner> {
        let raw: Option<String> = self
            .pool
            .get(format!("tunnel:owner:{tunnel_id}"))
            .await
            .ok()
            .flatten();
        let v: serde_json::Value = serde_json::from_str(&raw?).ok()?;
        Some(crate::state::TunnelOwner {
            party_a: v["partyA"].as_str().map(str::to_string),
            party_b: v["partyB"].as_str().map(str::to_string),
            funder: v["funder"].as_str().map(str::to_string),
        })
    }

    async fn tunnel_game(&self, tunnel_id: &str) -> Option<String> {
        self.pool
            .get(format!("tunnel:game:{tunnel_id}"))
            .await
            .ok()
            .flatten()
    }

    async fn set_tunnel_game(&self, tunnel_id: &str, game: &str) {
        let res: Result<(), _> = self
            .pool
            .set(
                format!("tunnel:game:{tunnel_id}"),
                game,
                Some(Expiration::EX(TUNNEL_OWNER_TTL)),
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_tunnel_game set failed");
        }
    }

    async fn claim_faucet_slot(
        &self,
        address: &str,
        window_secs: i64,
        max_per_window: u32,
    ) -> bool {
        let res: Result<i64, _> = self
            .pool
            .eval(
                CLAIM_FAUCET_SLOT,
                vec![format!("faucet:count:{address}")],
                vec![window_secs.to_string(), max_per_window.to_string()],
            )
            .await;
        match res {
            Ok(allowed) => allowed == 1,
            Err(e) => {
                // Fail closed: a cache blip must never enable unmetered (gas-costing) mints.
                tracing::warn!(error = %e, "redis claim_faucet_slot eval failed");
                false
            }
        }
    }

    async fn faucet_window_ttl(&self, address: &str) -> Option<i64> {
        let ttl: Result<i64, _> = self.pool.ttl(format!("faucet:count:{address}")).await;
        match ttl {
            Ok(secs) if secs > 0 => Some(secs),
            _ => None,
        }
    }

    async fn release_faucet_slot(&self, address: &str) {
        // Give back one pull (a claimed mint that then failed). The key keeps its window TTL.
        let res: Result<i64, _> = self.pool.decr(format!("faucet:count:{address}")).await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis release_faucet_slot decr failed");
        }
    }

    // fred 9.4.0: ping takes no argument (cheat-sheet erroneously shows `ping::<String>(None)`).
    async fn ready(&self) -> bool {
        self.pool.ping::<String>().await.is_ok()
    }
}

impl RedisControlStore {
    // SCAN cursor loop via a single client from the pool. Game-key cardinality is tiny (~7 games),
    // so one scan per stats tick is negligible.
    async fn scan_keys(&self, pattern: &str) -> Vec<String> {
        let mut keys = Vec::new();
        let client = self.pool.next();
        let mut stream = client.scan_buffered(pattern, Some(100), None);
        loop {
            match stream.try_next().await {
                Ok(Some(key)) => {
                    if let Some(s) = key.as_str() {
                        keys.push(s.to_owned());
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(error = %e, "redis scan_keys stream error, truncating");
                    break;
                }
            }
        }
        keys
    }
}

// ===== MpStore =====

pub struct RedisMpStore {
    pool: RedisPool,
}

impl RedisMpStore {
    pub fn new(pool: RedisPool) -> Self {
        Self { pool }
    }
}

// KEYS[1]=queue:<game> ARGV[1]=selfJson ARGV[2]=selfWallet ARGV[3]=selfInstance ARGV[4]=holdMs
// Atomically (server-clock `now` from TIME): drain stale self entries; pair a same-instance
// opponent if one waits; else a different-wallet waiter already past its deadline; else park self
// with deadline=now+holdMs. Co-located pairs relay in-process; cross-instance is the fallback.
// One eval → exactly-once under concurrency. Returns the opponent JSON or nil (None in Rust).
const JOIN_OR_PAIR: &str = r#"
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local me = cjson.decode(ARGV[1])
local me_bot = me.is_bot
local items = redis.call('LRANGE', KEYS[1], 0, -1)
local colocated = nil
local expired = nil
for _, v in ipairs(items) do
  local ok, w = pcall(cjson.decode, v)
  if ok then
    if w.wallet == ARGV[2] then
      redis.call('LREM', KEYS[1], 1, v)
    -- A bot is NEVER paired with another bot; skip a candidate when both are bots.
    elseif not (me_bot and w.is_bot) then
      if colocated == nil and w.conn and w.conn.instance_id == ARGV[3] then
        colocated = v
      end
      if expired == nil and w.deadline and tonumber(w.deadline) <= now then
        expired = v
      end
    end
  end
end
local chosen = colocated or expired
if chosen then
  redis.call('LREM', KEYS[1], 1, chosen)
  return chosen
end
me.deadline = now + tonumber(ARGV[4])
redis.call('RPUSH', KEYS[1], cjson.encode(me))
return false
"#;

// KEYS[1]=queue:<game> ARGV[1]=selfWallet
// Timer-driven fallback: if self is still parked, pair it with the oldest different-wallet
// waiter (any instance). Drains self entries; LREMs the chosen opponent. Returns opponent JSON
// or nil. One atomic eval → cannot double-pair against a concurrent join.
const FALLBACK_PAIR: &str = r#"
local items = redis.call('LRANGE', KEYS[1], 0, -1)
local self_present = false
local self_bot = false
-- Pass 1: detect self, capture its is_bot, and drain self entries.
for _, v in ipairs(items) do
  local ok, w = pcall(cjson.decode, v)
  if ok and w.wallet == ARGV[1] then
    self_present = true
    self_bot = w.is_bot
    redis.call('LREM', KEYS[1], 1, v)
  end
end
if not self_present then return false end
-- Pass 2: pick + remove the oldest different-wallet opponent. A bot is NEVER paired with
-- another bot, so skip a candidate when both are bots.
for _, v in ipairs(items) do
  local ok, w = pcall(cjson.decode, v)
  if ok and w.wallet ~= ARGV[1] and not (self_bot and w.is_bot) then
    redis.call('LREM', KEYS[1], 1, v)
    return v
  end
end
return false
"#;

// Presence compare-and-delete on a single key holding the full ConnRef JSON: delete only if
// the stored conn_id still matches. cjson.decode reads conn_id (a string) only; nothing is
// re-encoded. KEYS[1]=presence:<wallet>  ARGV[1]=conn_id string
const CLEAR_PRESENCE_IF: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ref = cjson.decode(raw)
if ref.conn_id == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
"#;

// Atomically rebuild queue:<game> excluding every entry whose wallet == ARGV[1].
// Single KEYS[1] → cluster-safe. The DEL before RPUSH means an empty result leaves no key.
// KEYS[1]=queue:<game> ARGV[1]=wallet
const LEAVE_QUEUE: &str = r#"
local items = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
for _, v in ipairs(items) do
  local ok, w = pcall(cjson.decode, v)
  if not ok or w.wallet ~= ARGV[1] then redis.call('RPUSH', KEYS[1], v) end
end
return 1
"#;

// Atomic accept: return the invite JSON and delete it iff it exists and is addressed to the
// accepter; else nil. Single-winner under concurrent accepts (no GET→DEL gap).
// KEYS[1]=invite:<match_id>  ARGV[1]=accepter wallet
const TAKE_INVITE: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local inv = cjson.decode(raw)
if inv.to ~= ARGV[1] then return false end
redis.call('DEL', KEYS[1])
return raw
"#;

// Write the match HASH atomically with its 6h TTL. Core fields are always present; tunnel_id
// and checkpoint are written only when non-empty (sentinel '' means "skip"). The checkpoint is
// stored verbatim (opaque JSON) and its nonce kept as a plain integer field, so no balance is
// ever cjson-round-tripped. KEYS[1]=match:<id>
// ARGV: 1=game 2=seat_a 3=seat_b 4=conn_a 5=conn_b 6=tunnel_id|'' 7=checkpoint|'' 8=nonce|'' 9=ttl
const PUT_MATCH: &str = r#"
redis.call('HSET', KEYS[1], 'game', ARGV[1], 'seat_a', ARGV[2], 'seat_b', ARGV[3], 'conn_a', ARGV[4], 'conn_b', ARGV[5])
if ARGV[6] ~= '' then redis.call('HSET', KEYS[1], 'tunnel_id', ARGV[6]) end
if ARGV[7] ~= '' then redis.call('HSET', KEYS[1], 'latest_checkpoint', ARGV[7], 'checkpoint_nonce', ARGV[8]) end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[9]))
return 1
"#;

// Monotonic checkpoint CAS: store the new checkpoint (verbatim) only if its nonce >= the stored
// one. Compares integers; never decodes the checkpoint body, so balances stay byte-exact.
// KEYS[1]=match:<id>  ARGV[1]=nonce  ARGV[2]=checkpoint json  ARGV[3]=ttl
const RECORD_CHECKPOINT: &str = r#"
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local cur = redis.call('HGET', KEYS[1], 'checkpoint_nonce')
if cur and tonumber(ARGV[1]) < tonumber(cur) then return 0 end
redis.call('HSET', KEYS[1], 'latest_checkpoint', ARGV[2], 'checkpoint_nonce', ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
"#;

// Set tunnel_id only if the match still exists; refresh the 6h TTL. Mirrors the memory
// impl's no-op-on-absent behavior and avoids leaking a one-field hash.
// KEYS[1]=match:<id>  ARGV[1]=tunnel_id  ARGV[2]=ttl
const SET_TUNNEL_ID: &str = r#"
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'tunnel_id', ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
"#;

// Rebind a seat's ConnRef, authorized by seat ownership, and refresh the TTL. Returns 'a'/'b'
// for the rebound seat, or false if the match is gone / the wallet owns no seat. O(1): two
// HGETs + one HSET + EXPIRE, no loops, no cjson (ConnRef carries no numeric balance).
// KEYS[1]=match:<id>  ARGV[1]=wallet  ARGV[2]=ConnRef json  ARGV[3]=ttl
const REBIND_MATCH_CONN: &str = r#"
local sa = redis.call('HGET', KEYS[1], 'seat_a')
if not sa then return false end
if sa == ARGV[1] then
  redis.call('HSET', KEYS[1], 'conn_a', ARGV[2])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 'a'
end
local sb = redis.call('HGET', KEYS[1], 'seat_b')
if sb == ARGV[1] then
  redis.call('HSET', KEYS[1], 'conn_b', ARGV[2])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 'b'
end
return false
"#;

/// Arena reservation TTL (seconds): covers the user's deposit-signing window between `allocate` and
/// `arena.join`. A user who never joins simply expires — no bot was ever spawned to reclaim.
const ARENA_RES_TTL_SECS: i64 = 300;

// Seed an arena reservation as a hash + TTL. KEYS[1]=arena:res:<id>
// ARGV: 1=game 2=seat_a 3=seat_b 4=tunnel_id 5=eph_secret 6=created_at 7=ttl
const PUT_ARENA_RESERVATION: &str = r#"
redis.call('HSET', KEYS[1], 'game', ARGV[1], 'seat_a', ARGV[2], 'seat_b', ARGV[3], 'tunnel_id', ARGV[4], 'eph_secret', ARGV[5], 'created_at', ARGV[6], 'claimed', '0')
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[7]))
return 1
"#;

// Atomic claim-once for play. Verifies the joining wallet is the allocator (seat_a) and that no
// prior join claimed it, then flips 'claimed' and returns the recipe. One eval → exactly one
// caller ever gets status 'claimed', so exactly one bot spawns under a double-join.
// KEYS[1]=arena:res:<id>  ARGV[1]=wallet  ARGV[2]=ttl. Returns cjson {status, ...recipe}.
const CLAIM_ARENA: &str = r#"
if redis.call('EXISTS', KEYS[1]) == 0 then return cjson.encode({status='notfound'}) end
local sa = redis.call('HGET', KEYS[1], 'seat_a')
if sa ~= ARGV[1] then return cjson.encode({status='foreign'}) end
if redis.call('HGET', KEYS[1], 'claimed') == '1' then return cjson.encode({status='claimed_already'}) end
redis.call('HSET', KEYS[1], 'claimed', '1')
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return cjson.encode({
  status='claimed',
  game=redis.call('HGET', KEYS[1], 'game'),
  seat_a=sa,
  seat_b=redis.call('HGET', KEYS[1], 'seat_b'),
  tunnel_id=redis.call('HGET', KEYS[1], 'tunnel_id'),
  eph_secret=redis.call('HGET', KEYS[1], 'eph_secret'),
  created_at=redis.call('HGET', KEYS[1], 'created_at')
})
"#;

#[async_trait]
impl MpStore for RedisMpStore {
    async fn set_presence(&self, wallet: &str, at: ConnRef) {
        // One key holds the full ConnRef JSON: get_presence reads it; clear_presence_if's Lua
        // decodes conn_id from it. No separate mirror to orphan.
        let res: Result<(), _> = self
            .pool
            .set(
                format!("presence:{wallet}"),
                serde_json::to_string(&at).unwrap(),
                None,
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_presence failed");
        }
    }

    async fn get_presence(&self, wallet: &str) -> Option<ConnRef> {
        let v: Option<String> = self
            .pool
            .get(format!("presence:{wallet}"))
            .await
            .ok()
            .flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn clear_presence_if(&self, wallet: &str, conn: crate::mp::ConnId) {
        let res: Result<i64, _> = self
            .pool
            .eval(
                CLEAR_PRESENCE_IF,
                vec![format!("presence:{wallet}")],
                vec![conn.to_string()],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis clear_presence_if eval failed");
        }
    }

    async fn join_or_pair(
        &self,
        game: &str,
        me: crate::mp::Waiting,
        hold_ms: u64,
    ) -> Option<crate::mp::Waiting> {
        let me_json = serde_json::to_string(&me).unwrap();
        let res: Option<String> = match self
            .pool
            .eval::<Option<String>, _, _, _>(
                JOIN_OR_PAIR,
                vec![format!("queue:{game}")],
                vec![
                    me_json,
                    me.wallet.clone(),
                    me.conn.instance_id.clone(),
                    hold_ms.to_string(),
                ],
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "redis join_or_pair eval failed");
                None
            }
        };
        res.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn fallback_pair(&self, game: &str, wallet: &str) -> Option<crate::mp::Waiting> {
        let res: Option<String> = match self
            .pool
            .eval::<Option<String>, _, _, _>(
                FALLBACK_PAIR,
                vec![format!("queue:{game}")],
                vec![wallet.to_owned()],
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "redis fallback_pair eval failed");
                None
            }
        };
        res.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn leave_queue(&self, game: &str, wallet: &str) {
        let res: Result<i64, _> = self
            .pool
            .eval::<i64, _, _, _>(
                LEAVE_QUEUE,
                vec![format!("queue:{game}")],
                vec![wallet.to_owned()],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis leave_queue eval failed");
        }
    }

    async fn put_invite(&self, match_id: &str, inv: crate::mp::DirectedInvite) {
        let res: Result<(), _> = self
            .pool
            .set(
                format!("invite:{match_id}"),
                serde_json::to_string(&inv).unwrap(),
                Some(Expiration::EX(60)),
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis put_invite set failed");
        }
    }

    async fn take_invite(
        &self,
        match_id: &str,
        accepter: &str,
    ) -> Option<crate::mp::DirectedInvite> {
        let raw: Option<String> = match self
            .pool
            .eval::<Option<String>, _, _, _>(
                TAKE_INVITE,
                vec![format!("invite:{match_id}")],
                vec![accepter.to_owned()],
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "redis take_invite eval failed");
                None
            }
        };
        raw.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn drop_invite(&self, match_id: &str) {
        let res: Result<i64, _> = self.pool.del(format!("invite:{match_id}")).await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis drop_invite del failed");
        }
    }

    async fn put_match(&self, match_id: &str, m: crate::mp::MatchRecord) {
        let (cp_json, cp_nonce) = match &m.latest_checkpoint {
            Some(cp) => (serde_json::to_string(cp).unwrap(), cp.nonce.to_string()),
            None => (String::new(), String::new()),
        };
        let res: Result<i64, _> = self
            .pool
            .eval(
                PUT_MATCH,
                vec![format!("match:{match_id}")],
                vec![
                    m.game,
                    m.seat_a,
                    m.seat_b,
                    serde_json::to_string(&m.conn_a).unwrap(),
                    serde_json::to_string(&m.conn_b).unwrap(),
                    m.tunnel_id.unwrap_or_default(),
                    cp_json,
                    cp_nonce,
                    MATCH_TTL.to_string(),
                ],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis put_match eval failed");
        }
    }

    async fn get_match(&self, match_id: &str) -> Option<crate::mp::MatchRecord> {
        let h: HashMap<String, String> =
            self.pool.hgetall(format!("match:{match_id}")).await.ok()?;
        if h.is_empty() {
            return None;
        }
        Some(crate::mp::MatchRecord {
            game: h.get("game")?.clone(),
            seat_a: h.get("seat_a")?.clone(),
            seat_b: h.get("seat_b")?.clone(),
            conn_a: serde_json::from_str(h.get("conn_a")?).ok()?,
            conn_b: serde_json::from_str(h.get("conn_b")?).ok()?,
            tunnel_id: h.get("tunnel_id").cloned(),
            latest_checkpoint: h
                .get("latest_checkpoint")
                .and_then(|s| serde_json::from_str(s).ok()),
        })
    }

    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str) {
        let res: Result<i64, _> = self
            .pool
            .eval(
                SET_TUNNEL_ID,
                vec![format!("match:{match_id}")],
                vec![tunnel_id.to_owned(), MATCH_TTL.to_string()],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_tunnel_id eval failed");
        }
    }

    async fn record_checkpoint(&self, match_id: &str, cp: crate::mp::Checkpoint) {
        let res: Result<i64, _> = self
            .pool
            .eval(
                RECORD_CHECKPOINT,
                vec![format!("match:{match_id}")],
                vec![
                    cp.nonce.to_string(),
                    serde_json::to_string(&cp).unwrap(),
                    MATCH_TTL.to_string(),
                ],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis record_checkpoint eval failed");
        }
    }

    async fn rebind_match_conn(
        &self,
        match_id: &str,
        wallet: &str,
        at: ConnRef,
    ) -> Option<crate::mp::Seat> {
        let res: Result<Option<String>, _> = self
            .pool
            .eval(
                REBIND_MATCH_CONN,
                vec![format!("match:{match_id}")],
                vec![
                    wallet.to_owned(),
                    serde_json::to_string(&at).unwrap(),
                    MATCH_TTL.to_string(),
                ],
            )
            .await;
        match res {
            Ok(Some(s)) if s == "a" => Some(crate::mp::Seat::A),
            Ok(Some(s)) if s == "b" => Some(crate::mp::Seat::B),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(error = %e, "redis rebind_match_conn eval failed");
                None
            }
        }
    }

    async fn put_arena_reservation(&self, match_id: &str, rec: crate::store::ArenaReservation) {
        let res: Result<i64, _> = self
            .pool
            .eval(
                PUT_ARENA_RESERVATION,
                vec![format!("arena:res:{match_id}")],
                vec![
                    rec.game,
                    rec.seat_a,
                    rec.seat_b,
                    rec.tunnel_id,
                    rec.eph_secret_hex,
                    rec.created_at_ms.to_string(),
                    ARENA_RES_TTL_SECS.to_string(),
                ],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis put_arena_reservation failed");
        }
    }

    async fn claim_arena(&self, match_id: &str, wallet: &str) -> crate::store::ArenaClaim {
        use crate::store::{ArenaClaim, ArenaReservation};
        let res: Result<Option<String>, _> = self
            .pool
            .eval(
                CLAIM_ARENA,
                vec![format!("arena:res:{match_id}")],
                vec![wallet.to_owned(), ARENA_RES_TTL_SECS.to_string()],
            )
            .await;
        let json = match res {
            Ok(Some(j)) => j,
            Ok(None) => return ArenaClaim::NotFound,
            Err(e) => {
                tracing::warn!(error = %e, "redis claim_arena eval failed");
                return ArenaClaim::NotFound;
            }
        };
        #[derive(serde::Deserialize)]
        struct ClaimOut {
            status: String,
            game: Option<String>,
            seat_a: Option<String>,
            seat_b: Option<String>,
            tunnel_id: Option<String>,
            eph_secret: Option<String>,
            created_at: Option<String>,
        }
        let Ok(out) = serde_json::from_str::<ClaimOut>(&json) else {
            return ArenaClaim::NotFound;
        };
        match out.status.as_str() {
            "claimed" => ArenaClaim::Claimed(ArenaReservation {
                game: out.game.unwrap_or_default(),
                seat_a: out.seat_a.unwrap_or_default(),
                seat_b: out.seat_b.unwrap_or_default(),
                tunnel_id: out.tunnel_id.unwrap_or_default(),
                eph_secret_hex: out.eph_secret.unwrap_or_default(),
                // Absent (pre-rollout reservation) or unparsable → 0, matching the FE's slow-read
                // fallback; a real value makes the bot's settle timestamp byte-match the FE half.
                created_at_ms: out
                    .created_at
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0),
            }),
            "foreign" => ArenaClaim::ForeignWallet,
            "claimed_already" => ArenaClaim::AlreadyClaimed,
            _ => ArenaClaim::NotFound,
        }
    }
}

// ===== Bus =====

// Cross-instance pub/sub payload. `Frame` is a client-bound relay frame; `Evict` tells a
// connection task to drop a match from its relay cache; `Populate` warms a connection's relay
// cache with a freshly-created match record. Retagged from the old flat `{conn,text}` — internal
// to the bus, deployed together. A rolling deploy may drop a few cross-instance frames mid-rollout
// (pubsub is a soft dependency, ADR-0005); accepted.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "k")]
enum WireMsg {
    Frame {
        conn: ConnId,
        text: String,
    },
    Evict {
        conn: ConnId,
        match_id: String,
    },
    Populate {
        conn: ConnId,
        match_id: String,
        record: Box<crate::mp::MatchRecord>,
    },
}

/// Redis `Bus`: local delivery/eviction/populate hits the in-process `conns`/`ctrls` maps; remote
/// routing SPUBLISH-es a `WireMsg` JSON (a `Frame` for client delivery, an `Evict` for relay-cache
/// invalidation, or a `Populate` to warm a relay cache) to `mp:inst:<target.instance_id>`. Each
/// instance runs one `SubscriberClient` that fans inbound `WireMsg`s to local sockets (`Frame`) or
/// ctrl channels (`Evict`/`Populate`).
///
/// Phase 5 wires this via `RedisBus::new(instance_id, publisher_pool)` where `instance_id` comes
/// from `INSTANCE_ID` env and `publisher_pool` is built from `REDIS_PUBSUB_URL`.
pub struct RedisBus {
    instance_id: String,
    /// Pool used for SPUBLISH. Kept separate from the cache pool (two different connection classes).
    publisher: RedisPool,
    conns: std::sync::Arc<RwLock<HashMap<ConnId, mpsc::UnboundedSender<String>>>>,
    ctrls: std::sync::Arc<RwLock<HashMap<ConnId, mpsc::UnboundedSender<CtrlMsg>>>>,
    // Holds the SubscriberClient so the connection stays alive for the lifetime of the bus.
    #[allow(dead_code)]
    _subscriber: SubscriberClient,
    // Holds the auto-resubscribe task handle; dropping a JoinHandle detaches but does not cancel.
    #[allow(dead_code)]
    _mgr: tokio::task::JoinHandle<()>,
}

impl RedisBus {
    /// Build the bus: connect a subscriber, SSUBSCRIBE to this instance's channel, and spawn the
    /// inbound fan-in task. The subscriber is kept alive inside the struct.
    ///
    /// Phase 5 should call: `RedisBus::new(config.instance_id.clone(), pubsub_pool).await?`
    /// where `pubsub_pool` is `redis::connect(&config.redis_pubsub_url).await?`.
    pub async fn new(instance_id: String, publisher: RedisPool) -> anyhow::Result<Self> {
        let channel = format!("mp:inst:{instance_id}");
        let conns: std::sync::Arc<RwLock<HashMap<ConnId, mpsc::UnboundedSender<String>>>> =
            Default::default();
        let ctrls: std::sync::Arc<RwLock<HashMap<ConnId, mpsc::UnboundedSender<CtrlMsg>>>> =
            Default::default();

        // Derive subscriber config from the pool so both connections target the same Redis.
        let sub_config = publisher.client_config();
        let sub = Builder::from_config(sub_config).build_subscriber_client()?;
        sub.init().await?;
        // Grab rx before ssubscribe so no messages are missed between subscribe and loop start.
        let mut rx = sub.message_rx();
        sub.ssubscribe(channel).await?;
        // Spawn auto-resubscribe on reconnect; task self-terminates when the client drops.
        let mgr = sub.manage_subscriptions();

        let conns_arc = conns.clone();
        let ctrls_arc = ctrls.clone();
        tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            loop {
                match rx.recv().await {
                    Ok(msg) => {
                        let Some(payload) = msg.value.as_string() else {
                            continue;
                        };
                        let Ok(msg) = serde_json::from_str::<WireMsg>(&payload) else {
                            continue;
                        };
                        match msg {
                            WireMsg::Frame { conn, text } => {
                                if let Some(tx) = conns_arc.read().unwrap().get(&conn) {
                                    let _ = tx.send(text);
                                }
                            }
                            WireMsg::Evict { conn, match_id } => {
                                if let Some(tx) = ctrls_arc.read().unwrap().get(&conn) {
                                    let _ = tx.send(CtrlMsg::Evict(match_id));
                                }
                            }
                            WireMsg::Populate {
                                conn,
                                match_id,
                                record,
                            } => {
                                if let Some(tx) = ctrls_arc.read().unwrap().get(&conn) {
                                    let _ = tx.send(CtrlMsg::Populate(match_id, record));
                                }
                            }
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!(
                            skipped = n,
                            "pubsub message_rx lagged; some cross-instance messages dropped"
                        );
                    }
                    Err(RecvError::Closed) => break,
                }
            }
        });

        Ok(Self {
            instance_id,
            publisher,
            conns,
            ctrls,
            _subscriber: sub,
            _mgr: mgr,
        })
    }
}

#[async_trait]
impl Bus for RedisBus {
    fn instance_id(&self) -> &str {
        &self.instance_id
    }

    fn register(
        &self,
        conn: ConnId,
        client_tx: mpsc::UnboundedSender<String>,
        ctrl_tx: mpsc::UnboundedSender<CtrlMsg>,
    ) {
        self.conns.write().unwrap().insert(conn, client_tx);
        self.ctrls.write().unwrap().insert(conn, ctrl_tx);
    }

    fn unregister(&self, conn: ConnId) {
        self.conns.write().unwrap().remove(&conn);
        self.ctrls.write().unwrap().remove(&conn);
    }

    async fn deliver(&self, target: &ConnRef, text: String) {
        if target.instance_id == self.instance_id {
            // Local: clone tx out before any await so we never hold the guard across an .await.
            let tx = self.conns.read().unwrap().get(&target.conn_id).cloned();
            if let Some(tx) = tx {
                let _ = tx.send(text);
            }
        } else {
            let wire = serde_json::to_string(&WireMsg::Frame {
                conn: target.conn_id,
                text,
            })
            .expect("WireMsg serializes");
            let channel = format!("mp:inst:{}", target.instance_id);
            // RedisPool doesn't impl PubsubInterface; get a client from the pool for spublish.
            let res: Result<i64, _> = self.publisher.next().spublish(channel, wire).await;
            if let Err(e) = res {
                tracing::warn!(error = %e, instance = %target.instance_id, "spublish frame failed");
            }
        }
    }

    async fn evict(&self, target: &ConnRef, match_id: &str) {
        if target.instance_id == self.instance_id {
            let tx = self.ctrls.read().unwrap().get(&target.conn_id).cloned();
            if let Some(tx) = tx {
                let _ = tx.send(CtrlMsg::Evict(match_id.to_owned()));
            }
        } else {
            let wire = serde_json::to_string(&WireMsg::Evict {
                conn: target.conn_id,
                match_id: match_id.to_owned(),
            })
            .expect("WireMsg serializes");
            let channel = format!("mp:inst:{}", target.instance_id);
            let res: Result<i64, _> = self.publisher.next().spublish(channel, wire).await;
            if let Err(e) = res {
                tracing::warn!(error = %e, instance = %target.instance_id, "spublish evict failed");
            }
        }
    }

    async fn publish_raw(&self, channel: &str, payload: String) {
        // Regular PUBLISH (not SPUBLISH) so the indexer subscribes with regular SUBSCRIBE.
        let _: Result<i64, _> = self.publisher.next().publish(channel, payload).await;
    }

    async fn populate(&self, target: &ConnRef, match_id: &str, rec: &crate::mp::MatchRecord) {
        if target.instance_id == self.instance_id {
            let tx = self.ctrls.read().unwrap().get(&target.conn_id).cloned();
            if let Some(tx) = tx {
                let _ = tx.send(CtrlMsg::Populate(
                    match_id.to_owned(),
                    Box::new(rec.clone()),
                ));
            }
        } else {
            let wire = serde_json::to_string(&WireMsg::Populate {
                conn: target.conn_id,
                match_id: match_id.to_owned(),
                record: Box::new(rec.clone()),
            })
            .expect("WireMsg serializes");
            let channel = format!("mp:inst:{}", target.instance_id);
            let res: Result<i64, _> = self.publisher.next().spublish(channel, wire).await;
            if let Err(e) = res {
                tracing::warn!(error = %e, instance = %target.instance_id, "spublish populate failed");
            }
        }
    }
}

// ===== Integration tests =====

#[cfg(test)]
mod tests {
    use testcontainers_modules::redis::Redis;
    use testcontainers_modules::testcontainers::{runners::AsyncRunner, ContainerAsync, ImageExt};

    use super::*;

    /// Start an ephemeral Redis and return a connected pool. The returned container must be held
    /// for the test's lifetime (drop = stop). Per-test isolation: no shared keys, runs in parallel.
    ///
    /// Pinned to a stable Redis 7 minor: `RedisBus` uses sharded pub/sub (`SSUBSCRIBE`/`SPUBLISH`),
    /// which only exists on Redis >= 7.0, so the `redis` module's default tag (5.0) makes
    /// `RedisBus::new` fail. Pinning the minor (not the floating `7-alpine`) keeps CI reproducible.
    async fn redis_fixture() -> (ContainerAsync<Redis>, RedisPool) {
        let node = Redis::default()
            .with_tag("7.4-alpine")
            .start()
            .await
            .expect("start redis container");
        let port = node.get_host_port_ipv4(6379).await.expect("redis port");
        // The published port can be reachable a beat before redis is accepting (the
        // container is "Up" but still initializing). `connect` does a single eager attempt,
        // so poll briefly through that window instead of flaking on a transient refusal.
        let url = format!("redis://127.0.0.1:{port}");
        let mut pool = None;
        for _ in 0..40 {
            match connect(&url).await {
                Ok(p) => {
                    pool = Some(p);
                    break;
                }
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
            }
        }
        let pool = pool.expect("connect to redis container within 2s");
        (node, pool)
    }

    // ElastiCache uses `rediss://` (TLS in transit). With `enable-rustls-ring`, `from_url` must
    // build a TLS connector for the rediss scheme and leave plain `redis://` untls'd. Building
    // the rustls config selects the crypto provider, so this test would PANIC if the provider
    // were ambiguous (the rustls 0.23 multi-provider footgun) — it guards the feature choice.
    // Pure config construction: no Redis or network needed.
    #[test]
    fn rediss_url_configures_tls_and_redis_does_not() {
        let secure =
            RedisConfig::from_url("rediss://cache.example.com:6379").expect("rediss:// parses");
        assert!(secure.uses_tls(), "rediss:// must configure TLS");
        let plain =
            RedisConfig::from_url("redis://cache.example.com:6379").expect("redis:// parses");
        assert!(!plain.uses_tls(), "redis:// must stay plaintext");
    }

    #[tokio::test]
    async fn deliver_crosses_instances() {
        // Both buses must share one Redis so SPUBLISH on A reaches B's subscriber.
        let (redis, pool_b) = redis_fixture().await;
        let port = redis.get_host_port_ipv4(6379).await.expect("redis port");
        let pool_a = connect(&format!("redis://127.0.0.1:{port}")).await.unwrap();
        // Instance B owns the socket; instance A delivers to it via SPUBLISH.
        let bus_b = RedisBus::new("B".into(), pool_b).await.unwrap();
        let bus_a = RedisBus::new("A".into(), pool_a).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (ctx, _crx) = tokio::sync::mpsc::unbounded_channel::<CtrlMsg>();
        let conn = uuid::Uuid::new_v4();
        bus_b.register(conn, tx, ctx);
        bus_a
            .deliver(
                &ConnRef {
                    instance_id: "B".into(),
                    conn_id: conn,
                },
                "hello".into(),
            )
            .await;
        let got = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("delivery timed out")
            .expect("channel closed");
        assert_eq!(
            got, "hello",
            "cross-instance message must arrive on B's socket"
        );
    }

    #[tokio::test]
    async fn evict_signals_the_target_ctrl_channel() {
        let (_redis, pool) = redis_fixture().await;
        let bus = RedisBus::new("instA".into(), pool).await.unwrap();
        let conn = uuid::Uuid::new_v4();
        let (ctx, _crx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (cctx, mut ccrx) = tokio::sync::mpsc::unbounded_channel::<CtrlMsg>();
        bus.register(conn, ctx, cctx);
        // Same-instance evict routes to the ctrl channel.
        bus.evict(
            &ConnRef {
                instance_id: "instA".into(),
                conn_id: conn,
            },
            "m1",
        )
        .await;
        match ccrx.recv().await {
            Some(CtrlMsg::Evict(id)) => assert_eq!(id, "m1"),
            other => panic!("expected CtrlMsg::Evict(\"m1\"), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn evict_crosses_instances() {
        // Both buses share one Redis so SPUBLISH of WireMsg::Evict on A reaches B's subscriber,
        // which routes it to B's ctrl channel (the cross-instance relay-cache invalidation path).
        let (redis, pool_b) = redis_fixture().await;
        let port = redis.get_host_port_ipv4(6379).await.expect("redis port");
        let pool_a = connect(&format!("redis://127.0.0.1:{port}")).await.unwrap();
        let bus_b = RedisBus::new("B".into(), pool_b).await.unwrap();
        let bus_a = RedisBus::new("A".into(), pool_a).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (ctx, mut ccrx) = tokio::sync::mpsc::unbounded_channel::<CtrlMsg>();
        let conn = uuid::Uuid::new_v4();
        bus_b.register(conn, tx, ctx);
        bus_a
            .evict(
                &ConnRef {
                    instance_id: "B".into(),
                    conn_id: conn,
                },
                "m-evict",
            )
            .await;
        let got = tokio::time::timeout(std::time::Duration::from_secs(2), ccrx.recv())
            .await
            .expect("evict timed out")
            .expect("ctrl channel closed");
        match got {
            CtrlMsg::Evict(id) => assert_eq!(
                id, "m-evict",
                "cross-instance evict must reach B's ctrl channel"
            ),
            other => panic!("expected CtrlMsg::Evict, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn populate_signals_the_target_ctrl_channel() {
        let (_redis, pool) = redis_fixture().await;
        let bus = RedisBus::new("instA".into(), pool).await.unwrap();
        let conn = uuid::Uuid::new_v4();
        let (ctx, _crx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (cctx, mut ccrx) = tokio::sync::mpsc::unbounded_channel::<CtrlMsg>();
        bus.register(conn, ctx, cctx);
        let rec = sample_match();
        // Same-instance populate routes the freshly-created record to the ctrl channel.
        bus.populate(
            &ConnRef {
                instance_id: "instA".into(),
                conn_id: conn,
            },
            "m1",
            &rec,
        )
        .await;
        match ccrx.recv().await {
            Some(CtrlMsg::Populate(id, got)) => {
                assert_eq!(id, "m1");
                assert_eq!(got.seat_a, rec.seat_a);
            }
            other => panic!("expected CtrlMsg::Populate(\"m1\", _), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn populate_crosses_instances() {
        // Both buses share one Redis so SPUBLISH of WireMsg::Populate on A reaches B's subscriber,
        // which routes it to B's ctrl channel (the cross-instance relay-cache warming path).
        let (redis, pool_b) = redis_fixture().await;
        let port = redis.get_host_port_ipv4(6379).await.expect("redis port");
        let pool_a = connect(&format!("redis://127.0.0.1:{port}")).await.unwrap();
        let bus_b = RedisBus::new("B".into(), pool_b).await.unwrap();
        let bus_a = RedisBus::new("A".into(), pool_a).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (ctx, mut ccrx) = tokio::sync::mpsc::unbounded_channel::<CtrlMsg>();
        let conn = uuid::Uuid::new_v4();
        bus_b.register(conn, tx, ctx);
        let rec = sample_match();
        bus_a
            .populate(
                &ConnRef {
                    instance_id: "B".into(),
                    conn_id: conn,
                },
                "m-populate",
                &rec,
            )
            .await;
        let got = tokio::time::timeout(std::time::Duration::from_secs(2), ccrx.recv())
            .await
            .expect("populate timed out")
            .expect("ctrl channel closed");
        match got {
            CtrlMsg::Populate(id, record) => {
                assert_eq!(
                    id, "m-populate",
                    "cross-instance populate must reach B's ctrl channel"
                );
                assert_eq!(record.seat_a, rec.seat_a, "record must round-trip");
            }
            other => panic!("expected CtrlMsg::Populate, got {other:?}"),
        }
    }

    // "Total tunnels" is a count-once counter, not a growing SADD set: a replayed Closed event
    // (cursor restart / second indexer) must not double-count. The first sighting of an id
    // increments; subsequent ones are deduped by the `tunnels:seen:settled:<id>` NX key.
    #[tokio::test]
    async fn settled_count_is_idempotent_under_replay() {
        let (_redis, pool) = redis_fixture().await;
        let store = RedisControlStore::new(pool);
        store.set_tunnel_status("0xtun", TunnelStatus::Closed).await;
        store.set_tunnel_status("0xtun", TunnelStatus::Closed).await; // replay / second indexer
        assert_eq!(
            store.snapshot().await.settled_tunnels,
            1,
            "replay must not double-count"
        );
    }

    #[tokio::test]
    async fn actions_count_accumulates_per_game() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool);
        s.add_actions("blackjack", 100).await;
        s.add_actions("blackjack", 50).await;
        let snap = s.snapshot().await;
        assert!(snap.total_actions >= 150);
        assert!(
            snap.per_game
                .get("blackjack")
                .is_some_and(|g| g.total_actions >= 150),
            "per-game actions must accumulate"
        );
    }

    #[tokio::test]
    async fn session_roundtrip() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool);
        let id = uuid::Uuid::new_v4().to_string();
        let tunnel = crate::routes::TunnelRef {
            tunnel_id: "t1".to_owned(),
            party_a: "0xA".to_owned(),
            party_b: "0xB".to_owned(),
        };
        let rec = SessionRecord {
            game: "chess".to_owned(),
            tunnels: vec![tunnel.clone()],
            stats_token: "tok".to_owned(),
        };
        s.put_session(&id, rec.clone()).await;
        let got = s.get_session(&id).await.expect("session must round-trip");
        assert_eq!(got.game, rec.game);
        assert_eq!(got.tunnels.len(), 1);
        assert_eq!(got.tunnels[0].tunnel_id, tunnel.tunnel_id);
    }

    #[tokio::test]
    async fn join_or_pair_pairs_each_waiter_exactly_once_under_concurrency() {
        let (_redis, pool) = redis_fixture().await;
        let s = std::sync::Arc::new(RedisMpStore::new(pool));
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let mut handles = vec![];
        for i in 0..50u32 {
            let s = s.clone();
            let game = game.clone();
            handles.push(tokio::spawn(async move {
                let cr = ConnRef {
                    instance_id: "i".into(),
                    conn_id: uuid::Uuid::new_v4(),
                };
                s.join_or_pair(
                    &game,
                    crate::mp::Waiting {
                        wallet: format!("0x{i}"),
                        conn: cr,
                        is_bot: false,
                    },
                    0,
                )
                .await
            }));
        }
        let mut pairs = 0u32;
        let mut parked = 0u32;
        for h in handles {
            if h.await.unwrap().is_some() {
                pairs += 1;
            } else {
                parked += 1;
            }
        }
        // 50 concurrent joiners → exactly 25 pair events, 25 parked. The Lua script guarantees
        // atomicity, so there can never be a double-pair.
        assert_eq!(pairs, 25, "expected 25 pair events");
        assert_eq!(parked, 25, "expected 25 parked waiters");
    }

    // A long hold lets two cross-instance waiters park together; a later same-instance joiner
    // then prefers its co-located partner over the FIFO front.
    #[tokio::test]
    async fn join_or_pair_prefers_a_same_instance_opponent() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let hold = 10_000; // long: nothing expires during the test
        let w = |wallet: &str, inst: &str| crate::mp::Waiting {
            wallet: wallet.to_owned(),
            conn: ConnRef {
                instance_id: inst.to_owned(),
                conn_id: uuid::Uuid::new_v4(),
            },
            is_bot: false,
        };
        // A(ia) and B(ib) both park (no local partner, neither expired).
        assert!(s.join_or_pair(&game, w("wa", "ia"), hold).await.is_none());
        assert!(s.join_or_pair(&game, w("wb", "ib"), hold).await.is_none());
        // Joiner on ib pairs the same-instance waiter wb, not the FIFO front wa.
        let opp = s
            .join_or_pair(&game, w("wj", "ib"), hold)
            .await
            .expect("pairs");
        assert_eq!(opp.wallet, "wb", "same-instance preferred over FIFO front");
        // wa is still queued → a same-instance joiner on ia pairs it.
        let opp2 = s
            .join_or_pair(&game, w("wk", "ia"), hold)
            .await
            .expect("pairs");
        assert_eq!(opp2.wallet, "wa", "front waiter still pairs same-instance");
    }

    // The fleet invariant on the deployed (Lua) path: two bots never pair; a human pairs a bot.
    #[tokio::test]
    async fn join_or_pair_never_pairs_two_bots() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let hold = 10_000;
        let seat = |wallet: &str, is_bot: bool| crate::mp::Waiting {
            wallet: wallet.to_owned(),
            conn: ConnRef {
                instance_id: "ia".to_owned(),
                conn_id: uuid::Uuid::new_v4(),
            },
            is_bot,
        };
        // Two bots both park — the Lua skips a bot-vs-bot candidate.
        assert!(
            s.join_or_pair(&game, seat("bot1", true), hold)
                .await
                .is_none(),
            "first bot parks"
        );
        assert!(
            s.join_or_pair(&game, seat("bot2", true), hold)
                .await
                .is_none(),
            "a second bot must NOT pair the waiting bot"
        );
        // A human pairs a waiting (same-instance) bot.
        let opp = s
            .join_or_pair(&game, seat("human", false), hold)
            .await
            .expect("a human pairs a waiting bot");
        assert!(opp.is_bot, "the human's opponent is a bot");
    }

    // With a short hold, a parked cross-instance waiter becomes selectable once its deadline
    // passes — the join path's expired branch pairs it.
    #[tokio::test]
    async fn join_or_pair_falls_back_to_expired_waiter() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let w = |wallet: &str, inst: &str| crate::mp::Waiting {
            wallet: wallet.to_owned(),
            conn: ConnRef {
                instance_id: inst.to_owned(),
                conn_id: uuid::Uuid::new_v4(),
            },
            is_bot: false,
        };
        assert!(s.join_or_pair(&game, w("wa", "ia"), 30).await.is_none());
        // Before expiry, a cross-instance joiner does NOT take wa — it parks instead.
        assert!(s.join_or_pair(&game, w("wb", "ib"), 30).await.is_none());
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        // Both wa and wb are now expired; the script scans in RPUSH (FIFO) order, so the front
        // waiter wa is the deterministic pick — this assertion depends on that ordering, not a race.
        let opp = s
            .join_or_pair(&game, w("wc", "ic"), 30)
            .await
            .expect("pairs");
        assert_eq!(
            opp.wallet, "wa",
            "expired waiter taken as cross-instance fallback"
        );
    }

    // Two idle cross-instance waiters: the timer-driven fallback pairs them.
    #[tokio::test]
    async fn fallback_pair_matches_two_idle_waiters() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let w = |wallet: &str, inst: &str| crate::mp::Waiting {
            wallet: wallet.to_owned(),
            conn: ConnRef {
                instance_id: inst.to_owned(),
                conn_id: uuid::Uuid::new_v4(),
            },
            is_bot: false,
        };
        assert!(s.join_or_pair(&game, w("wa", "ia"), 10_000).await.is_none());
        assert!(s.join_or_pair(&game, w("wb", "ib"), 10_000).await.is_none());
        let opp = s.fallback_pair(&game, "wa").await.expect("pairs");
        assert_eq!(opp.wallet, "wb", "fallback pairs the other idle waiter");
        // Both removed: a subsequent fallback for wa finds nothing.
        assert!(s.fallback_pair(&game, "wa").await.is_none());
    }

    // A lone waiter's fallback is a no-op (no opponent); an already-paired waiter's too.
    #[tokio::test]
    async fn fallback_pair_noops_without_opponent() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let w = |wallet: &str, inst: &str| crate::mp::Waiting {
            wallet: wallet.to_owned(),
            conn: ConnRef {
                instance_id: inst.to_owned(),
                conn_id: uuid::Uuid::new_v4(),
            },
            is_bot: false,
        };
        assert!(s.join_or_pair(&game, w("wa", "ia"), 10_000).await.is_none());
        assert!(
            s.fallback_pair(&game, "wa").await.is_none(),
            "no opponent → no-op"
        );
        assert!(
            s.fallback_pair(&game, "wnone").await.is_none(),
            "absent self → no-op"
        );
    }

    #[tokio::test]
    async fn recent_events_ring_dedupes_and_caps() {
        use crate::state::{TunnelEvent, TunnelEventKind};
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool);
        let ev = |digest: &str| TunnelEvent {
            tunnel_id: "0xt".into(),
            kind: TunnelEventKind::Settled,
            party_a: None,
            party_b: None,
            funder: None,
            game: None,
            party_a_balance: Some(1),
            party_b_balance: Some(1),
            transcript_root: None,
            tx_digest: digest.into(),
            timestamp_ms: 1,
            proof_url: None,
        };
        let tag = uuid::Uuid::new_v4().simple().to_string();
        s.push_recent_event(ev(&format!("{tag}-a"))).await;
        s.push_recent_event(ev(&format!("{tag}-a"))).await; // replay — no-op
        s.push_recent_event(ev(&format!("{tag}-b"))).await;
        let got = s.recent_events().await;
        // newest-first; our two unique digests are at the front of this test's fresh-container ring.
        assert_eq!(got[0].tx_digest, format!("{tag}-b"));
        assert_eq!(got[1].tx_digest, format!("{tag}-a"));
        assert!(got.len() <= crate::store::RECENT_EVENTS_CAP);
    }

    // The Walrus proofUrl must survive the indexer/handler race for the same digest, in either
    // arrival order — same contract as the in-memory store, exercised through the Lua upgrade
    // path. Without it a settled row in the cross-instance ring shows no proof link.
    #[tokio::test]
    async fn recent_events_proof_url_survives_race_either_order() {
        use crate::state::{TunnelEvent, TunnelEventKind};
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool);
        let proof = "https://agg/v1/blobs/xyz";
        let ev = |digest: &str, p: Option<&str>| TunnelEvent {
            tunnel_id: "0xt".into(),
            kind: TunnelEventKind::Settled,
            party_a: None,
            party_b: None,
            funder: None,
            game: None,
            party_a_balance: Some(1),
            party_b_balance: Some(1),
            transcript_root: None,
            tx_digest: digest.into(),
            timestamp_ms: 1,
            proof_url: p.map(Into::into),
        };
        let find = |rows: &[TunnelEvent], d: &str| rows.iter().find(|r| r.tx_digest == d).cloned();

        // indexer (bare) first, then handler (enriched): bare row is upgraded.
        let a = format!("{}-a", uuid::Uuid::new_v4().simple());
        s.push_recent_event(ev(&a, None)).await;
        s.push_recent_event(ev(&a, Some(proof))).await;
        let ra = find(&s.recent_events().await, &a).expect("row present");
        assert_eq!(
            ra.proof_url.as_deref(),
            Some(proof),
            "bare row upgraded to the proofUrl"
        );

        // handler (enriched) first, then indexer (bare): proofUrl not downgraded.
        let b = format!("{}-b", uuid::Uuid::new_v4().simple());
        s.push_recent_event(ev(&b, Some(proof))).await;
        s.push_recent_event(ev(&b, None)).await;
        let rb = find(&s.recent_events().await, &b).expect("row present");
        assert_eq!(
            rb.proof_url.as_deref(),
            Some(proof),
            "bare row never downgrades a proofUrl"
        );
    }

    #[tokio::test]
    async fn recent_events_dedup_key_is_per_digest_with_ttl() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool.clone());
        let digest = format!("d{}", uuid::Uuid::new_v4().simple());
        let ev = crate::state::TunnelEvent {
            tunnel_id: "0xt".into(),
            kind: crate::state::TunnelEventKind::Settled,
            party_a: None,
            party_b: None,
            funder: None,
            game: None,
            party_a_balance: Some(1),
            party_b_balance: Some(1),
            transcript_root: None,
            tx_digest: digest.clone(),
            timestamp_ms: 1,
            proof_url: None,
        };
        s.push_recent_event(ev).await;
        // Dedup is tracked by a per-digest key that carries a positive TTL (self-cleaning).
        let ttl: i64 = pool
            .ttl(format!("events:seen:{digest}"))
            .await
            .unwrap_or(-2);
        assert!(ttl > 0, "per-digest dedup key must have a TTL, got {ttl}");
    }

    // The faucet is a self-expiring windowed counter: up to `max` pulls succeed within the window
    // (the key carries a positive TTL), the next is refused, and releasing a slot frees one pull.
    #[tokio::test]
    async fn faucet_slot_allows_n_per_window_then_refuses() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool.clone());
        let addr = format!("0x{}", uuid::Uuid::new_v4().simple());
        for i in 0..3 {
            assert!(
                s.claim_faucet_slot(&addr, 1800, 3).await,
                "pull {i} within the limit must succeed"
            );
        }
        assert!(
            !s.claim_faucet_slot(&addr, 1800, 3).await,
            "the 4th pull in the window is refused"
        );
        let ttl = s.faucet_window_ttl(&addr).await.expect("window active");
        assert!(ttl > 0 && ttl <= 1800, "ttl within the window, got {ttl}");
        // Releasing a slot (failed mint) frees one pull within the same window.
        s.release_faucet_slot(&addr).await;
        assert!(
            s.claim_faucet_slot(&addr, 1800, 3).await,
            "a freed slot can be re-claimed"
        );
    }

    #[tokio::test]
    async fn take_invite_yields_some_to_exactly_one_concurrent_accepter() {
        let (_redis, pool) = redis_fixture().await;
        let s = std::sync::Arc::new(RedisMpStore::new(pool));
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        let inv = crate::mp::DirectedInvite {
            from: "0xa".into(),
            to: "0xb".into(),
            game: "ttt".into(),
            from_conn: ConnRef {
                instance_id: "i".into(),
                conn_id: uuid::Uuid::nil(),
            },
        };
        s.put_invite(&mid, inv).await;
        // Two concurrent accepts by the invited wallet; exactly one must win.
        let (s1, s2, m1, m2) = (s.clone(), s.clone(), mid.clone(), mid.clone());
        let h1 = tokio::spawn(async move { s1.take_invite(&m1, "0xb").await });
        let h2 = tokio::spawn(async move { s2.take_invite(&m2, "0xb").await });
        let wins = [h1.await.unwrap(), h2.await.unwrap()]
            .iter()
            .filter(|o| o.is_some())
            .count();
        assert_eq!(
            wins, 1,
            "exactly one concurrent accept may consume the invite"
        );
    }

    #[tokio::test]
    async fn take_invite_rejects_wrong_recipient_and_preserves_invite() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        let inv = crate::mp::DirectedInvite {
            from: "0xa".into(),
            to: "0xb".into(),
            game: "ttt".into(),
            from_conn: ConnRef {
                instance_id: "i".into(),
                conn_id: uuid::Uuid::nil(),
            },
        };
        s.put_invite(&mid, inv).await;
        // Wrong recipient must get None and leave the invite intact.
        let rejected = s.take_invite(&mid, "0xwrong").await;
        assert!(rejected.is_none(), "wrong recipient must be rejected");
        // The invite must still be present for the correct recipient.
        let accepted = s.take_invite(&mid, "0xb").await;
        assert!(
            accepted.is_some(),
            "invite must still be present after wrong-recipient attempt"
        );
    }

    #[tokio::test]
    async fn join_or_pair_never_pairs_wallet_with_itself() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let wallet = "0xself".to_owned();

        // First call: parks self.
        let cr1 = ConnRef {
            instance_id: "i".into(),
            conn_id: uuid::Uuid::new_v4(),
        };
        let first = s
            .join_or_pair(
                &game,
                crate::mp::Waiting {
                    wallet: wallet.clone(),
                    conn: cr1,
                    is_bot: false,
                },
                0,
            )
            .await;
        assert!(first.is_none(), "first call must park, not pair");

        // Second call (reconnect): stale self-entry must be dropped; wallet parks again.
        let cr2 = ConnRef {
            instance_id: "i".into(),
            conn_id: uuid::Uuid::new_v4(),
        };
        let second = s
            .join_or_pair(
                &game,
                crate::mp::Waiting {
                    wallet: wallet.clone(),
                    conn: cr2,
                    is_bot: false,
                },
                0,
            )
            .await;
        assert!(
            second.is_none(),
            "reconnecting wallet must not pair with itself"
        );
    }

    #[tokio::test]
    async fn actions_total_is_derived_not_a_separate_key() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool.clone());
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        s.add_actions(&game, 7).await;
        s.add_actions(&game, 5).await;
        // Total must come from summing per-game keys, never from a written aggregate.
        let legacy: Option<i64> = pool.get("stats:actions:total").await.ok().flatten();
        assert!(legacy.is_none(), "stats:actions:total must not be written");
        let snap = s.snapshot().await;
        assert_eq!(snap.per_game[&game].total_actions, 12);
        assert!(snap.total_actions >= 12, "total is the sum of per-game");
    }

    #[tokio::test]
    async fn presence_uses_one_key_and_cas_clears_it() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool.clone());
        let wallet = format!("0x{}", uuid::Uuid::new_v4().simple());
        let conn = uuid::Uuid::new_v4();
        s.set_presence(
            &wallet,
            ConnRef {
                instance_id: "A".into(),
                conn_id: conn,
            },
        )
        .await;
        // No mirror key may exist.
        let mirror: Option<String> = pool
            .get(format!("presence:ref:{wallet}"))
            .await
            .ok()
            .flatten();
        assert!(mirror.is_none(), "no presence:ref mirror key");
        // Round-trips the full ConnRef.
        let got = s.get_presence(&wallet).await.expect("presence present");
        assert_eq!((got.instance_id.as_str(), got.conn_id), ("A", conn));
        // CAS with a wrong conn must not clear.
        s.clear_presence_if(&wallet, uuid::Uuid::new_v4()).await;
        assert!(
            s.get_presence(&wallet).await.is_some(),
            "wrong conn must not clear"
        );
        // CAS with the right conn clears it, leaving no key behind.
        s.clear_presence_if(&wallet, conn).await;
        assert!(
            s.get_presence(&wallet).await.is_none(),
            "matching conn clears"
        );
        let leftover: Option<String> = pool.get(format!("presence:{wallet}")).await.ok().flatten();
        assert!(leftover.is_none(), "no orphaned presence key");
    }

    fn sample_match() -> crate::mp::MatchRecord {
        let cr = ConnRef {
            instance_id: "i".into(),
            conn_id: uuid::Uuid::new_v4(),
        };
        crate::mp::MatchRecord {
            game: "ttt".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: cr.clone(),
            conn_b: cr,
            tunnel_id: None,
            latest_checkpoint: None,
        }
    }

    #[tokio::test]
    async fn match_record_round_trips_through_hash() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        let m = sample_match();
        s.put_match(&mid, m.clone()).await;
        let got = s.get_match(&mid).await.expect("match round-trips");
        assert_eq!(got.game, m.game);
        assert_eq!((got.seat_a, got.seat_b), (m.seat_a, m.seat_b));
        assert_eq!(got.conn_a.conn_id, m.conn_a.conn_id);
        assert!(got.tunnel_id.is_none() && got.latest_checkpoint.is_none());
    }

    #[tokio::test]
    async fn tunnel_id_and_checkpoint_writes_do_not_clobber() {
        let (_redis, pool) = redis_fixture().await;
        let s = std::sync::Arc::new(RedisMpStore::new(pool));
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        s.put_match(&mid, sample_match()).await;
        // A huge balance (> 2^53) must survive byte-exact: it rides in the checkpoint and is
        // submitted on-chain, so any precision loss is a correctness break.
        let big = 9_007_199_254_740_993u64; // 2^53 + 1
        let cp = crate::mp::Checkpoint {
            nonce: 4,
            party_a_balance: big,
            party_b_balance: 1,
            state_hash: "h".into(),
            sig_a: "a".into(),
            sig_b: "b".into(),
        };
        let (s1, s2, m1, m2) = (s.clone(), s.clone(), mid.clone(), mid.clone());
        let h1 = tokio::spawn(async move { s1.set_tunnel_id(&m1, "0xtunnel").await });
        let h2 = tokio::spawn(async move { s2.record_checkpoint(&m2, cp).await });
        h1.await.unwrap();
        h2.await.unwrap();
        let got = s.get_match(&mid).await.unwrap();
        assert_eq!(
            got.tunnel_id.as_deref(),
            Some("0xtunnel"),
            "tunnel_id survived"
        );
        let stored = got.latest_checkpoint.expect("checkpoint survived");
        assert_eq!(stored.nonce, 4);
        assert_eq!(
            stored.party_a_balance, big,
            "u64 balance must be byte-exact"
        );
    }

    #[tokio::test]
    async fn rebind_match_conn_rebinds_seat_and_rejects_non_owner() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        s.put_match(&mid, sample_match()).await; // seat_a="0xa", seat_b="0xb"
        let new = ConnRef {
            instance_id: "i2".into(),
            conn_id: uuid::Uuid::new_v4(),
        };
        // Non-owner → None, no change.
        assert_eq!(
            s.rebind_match_conn(&mid, "0xstranger", new.clone()).await,
            None
        );
        // Seat A owner rebinds conn_a; conn_b untouched.
        let before = s.get_match(&mid).await.unwrap();
        assert_eq!(
            s.rebind_match_conn(&mid, "0xa", new.clone()).await,
            Some(crate::mp::Seat::A)
        );
        let after = s.get_match(&mid).await.unwrap();
        assert_eq!(after.conn_a.conn_id, new.conn_id, "conn_a rebound");
        assert_eq!(
            after.conn_b.conn_id, before.conn_b.conn_id,
            "conn_b untouched"
        );
        // Absent match → None (EXISTS-guarded by seat_a presence).
        let gone = format!("m{}", uuid::Uuid::new_v4().simple());
        assert_eq!(s.rebind_match_conn(&gone, "0xa", new).await, None);
    }

    #[tokio::test]
    async fn record_checkpoint_keeps_highest_nonce_redis() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        s.put_match(&mid, sample_match()).await;
        let cp = |n| crate::mp::Checkpoint {
            nonce: n,
            party_a_balance: 1,
            party_b_balance: 1,
            state_hash: "h".into(),
            sig_a: "a".into(),
            sig_b: "b".into(),
        };
        s.record_checkpoint(&mid, cp(5)).await;
        s.record_checkpoint(&mid, cp(3)).await; // stale, must be ignored
        assert_eq!(
            s.get_match(&mid)
                .await
                .unwrap()
                .latest_checkpoint
                .unwrap()
                .nonce,
            5
        );
    }
}
