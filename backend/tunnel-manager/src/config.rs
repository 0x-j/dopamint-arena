//! Typed runtime configuration, loaded from environment variables.
//!
//! On-chain/Walrus vars are `Option`: Phase 0 consumes none of them, so the
//! service must boot without them. The phase that *uses* a var resolves it with
//! `Config::require` at service-construction time, which fails loud naming the
//! missing var — moving the "fail loudly" guarantee to the consuming boundary
//! instead of hard-failing Phase 0 on env it never reads.

// Most fields are consumed from Phase 1 (settler) / Phase 2 (Walrus) onward; only
// `bind_addr` is read in Phase 0. `derive(Debug)` does not count as a read for the
// dead-code lint, so allow it on the foundation until the consumers land.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: String,
    pub coin_type: String,
    /// Sui network for Enoki sponsorship (`testnet`/`mainnet`/`devnet`), default `testnet`. Must
    /// match the network `ENOKI_API_KEY` is provisioned for. NOTE: the settler fallback's chain
    /// digest is hard-coded testnet (`sui.rs`), so leave this `testnet` until that is config-driven.
    pub sui_network: String,
    /// Enoki PRIVATE api key (`enoki_private_…`) with the SPONSORED_TRANSACTIONS feature. When set,
    /// Enoki is the primary gas sponsor and the settler is the fallback; unset disables Enoki
    /// sponsorship (settler-only). Distinct from the frontend's PUBLIC `VITE_ENOKI_API_KEY` (zkLogin
    /// wallet) and from `enoki_zklogin_api_key` below.
    pub enoki_api_key: Option<String>,
    /// Enoki PRIVATE api key with the **ZKLOGIN** feature, injected as `ENOKI_ZKLOGIN_API_KEY`. Used
    /// ONLY to verify a user's zkLogin id_token at `/v1/auth/session` (B5) and resolve their address.
    /// zkLogin is a DIFFERENT Enoki feature (and key) than sponsorship, so this is kept separate from
    /// `enoki_api_key` — identity verification then never forces Enoki to sponsor gas. Must belong to
    /// the SAME Enoki project + auth provider as the frontend's zkLogin key, or the resolved address
    /// won't match the user's wallet. Unset ⇒ the arena session gate can't mint (auth 503).
    pub enoki_zklogin_api_key: Option<String>,
    pub sui_rpc_url: Option<String>,
    pub package_id: Option<String>,
    /// Slim example-app packages — when set, their ops become gas-sponsorable.
    pub agent_allowance_package_id: Option<String>,
    pub streaming_payment_package_id: Option<String>,
    pub settler_key: Option<String>, // base64 ed25519 secret of the gas/settler account
    /// The MTPS `AdminCap` object id (ADR-0023), owned by the settler/deploy address. Required by
    /// the faucet endpoints: `admin_mint` takes it as a `&mut` owned input. Unset = faucet disabled
    /// (the endpoints 503), which is correct against the older permissionless package.
    pub mtps_admin_cap_id: Option<String>,
    /// Whole-token MTPS one public-faucet pull mints (0 decimals; ADR-0023).
    pub faucet_user_amount: u64,
    /// Whole-token MTPS the internal faucet mints by default (capped at the contract's
    /// `MAX_MINT_PER_CALL` = 10B). The internal endpoint may request less, never more.
    pub faucet_internal_amount: u64, // Capped at `crate::sui::MAX_MINT_PER_CALL` (10B)
    /// Public-faucet rate-limit window, seconds (the period `faucet_max_per_window` is counted over).
    pub faucet_cooldown_secs: i64,
    /// Max public-faucet pulls allowed per address within one window. Default 5 (per 30 min).
    pub faucet_max_per_window: u32,
    /// Shared bearer secret gating the internal faucet. Unset = internal endpoint disabled (503) —
    /// fails closed so an unlimited mint can never be accidentally open.
    pub faucet_admin_token: Option<String>,
    /// HS256 secret for the arena session-JWT gate (auth.rs, B5). Unset => the gate is DISABLED and
    /// `arena_allocate` stays unauthenticated (rollout switch, so a partial deploy can't brick play);
    /// set it (and ship the FE token) to enforce identity on house on-chain spend.
    pub session_jwt_secret: Option<String>,
    pub walrus_publisher_url: Option<String>,
    pub walrus_aggregator_url: Option<String>,
    pub redis_cache_url: Option<String>,
    pub redis_pubsub_url: Option<String>,
    pub instance_id: Option<String>,
    /// Max settles executing at once on THIS instance. The limit gates before the request body is
    /// read, so worst-case settle-body memory is bounded at this × the /settle body cap. Per-instance.
    pub settle_max_concurrency: usize,
    /// Sponsor grants allowed per sender within `sponsor_sender_window_secs`. Counts successful
    /// sponsorship issuance, not invalid/unsponsorable requests.
    pub sponsor_sender_max_per_window: u32,
    /// Per-sender sponsor window length in seconds.
    pub sponsor_sender_window_secs: i64,
    /// Global rolling-24h cap on successful sponsorship grants.
    pub sponsor_global_daily_limit: u64,
    pub ollama_url: Option<String>,
    pub ollama_model: Option<String>,
    /// S3 transcript archival (ADR-0023). When set, the settle handler archives the
    /// transcript body to this bucket alongside Walrus. Unset => archival disabled (dev).
    pub s3_bucket: Option<String>,
    /// Optional key prefix (e.g. "prod/"). Default empty.
    pub s3_prefix: Option<String>,
    /// Co-located fleet (ADR-0024): in-process bots per game, registered into the `BotPool` and
    /// served over the relay bus instead of a `/v1/fleet` WebSocket. `0` (default) keeps the relay
    /// inert; only an explicit `FLEET_COLOCATED_COUNT > 0` (+ `FLEET_COLOCATED_GAMES`) spawns them.
    pub colocated_fleet_count: u32,
    pub colocated_fleet_games: Vec<String>,
    /// Funded seat-B wallet pool (PR #124). When `WALLET_POOL_ID` is set, on-demand arena bots draw
    /// their on-chain address from the pool instead of the deterministic placeholder; the S3 bucket +
    /// AWS creds are read straight from the environment by `S3WalletPoolStore::from_env`. Unset =>
    /// placeholder identities (the default dev/Noop path).
    pub wallet_pool_id: Option<String>,
    /// Access value (passphrase) that unlocks the wallet pool. Required when `wallet_pool_id` is set.
    pub wallet_pool_access_value: Option<String>,
    /// Number of FUNDED members in the pool (`WALLET_POOL_FUNDED_COUNT`). The 1M pool is only partially
    /// funded as a prefix `1..=N`; seat-B checkout round-robins inside it so a bot never draws an empty
    /// wallet. Unset => the whole pool (with a warning). Raise it as more members are funded.
    pub wallet_pool_funded_count: Option<u32>,
}

impl Config {
    /// Load from env. Only `bind_addr`/`coin_type` have defaults; the rest are
    /// optional here and validated by `require` when a phase consumes them.
    pub fn from_env() -> anyhow::Result<Self> {
        let opt = |key: &str| std::env::var(key).ok();
        Ok(Self {
            bind_addr: std::env::var("TUNNEL_MANAGER_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:8080".into()),
            coin_type: std::env::var("TUNNEL_COIN_TYPE").unwrap_or_else(|_| "0x2::sui::SUI".into()),
            sui_network: std::env::var("SUI_NETWORK").unwrap_or_else(|_| "testnet".into()),
            enoki_api_key: opt("ENOKI_API_KEY"),
            enoki_zklogin_api_key: opt("ENOKI_ZKLOGIN_API_KEY"),
            sui_rpc_url: opt("SUI_RPC_URL"),
            package_id: opt("TUNNEL_PACKAGE_ID"),
            agent_allowance_package_id: opt("AGENT_ALLOWANCE_PACKAGE_ID"),
            streaming_payment_package_id: opt("STREAMING_PAYMENT_PACKAGE_ID"),
            settler_key: opt("SUI_SETTLER_KEY"),
            mtps_admin_cap_id: opt("MTPS_ADMIN_CAP_ID"),
            faucet_user_amount: std::env::var("FAUCET_USER_AMOUNT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(10_000),
            faucet_internal_amount: std::env::var("FAUCET_INTERNAL_AMOUNT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1_000_000),
            faucet_cooldown_secs: std::env::var("FAUCET_COOLDOWN_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|&n| n > 0)
                .unwrap_or(1_800),
            faucet_max_per_window: std::env::var("FAUCET_MAX_PER_WINDOW")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|&n| n > 0)
                .unwrap_or(5),
            faucet_admin_token: opt("FAUCET_ADMIN_TOKEN"),
            session_jwt_secret: opt("SESSION_JWT_SECRET"),
            walrus_publisher_url: opt("WALRUS_PUBLISHER_URL"),
            walrus_aggregator_url: opt("WALRUS_AGGREGATOR_URL"),
            redis_cache_url: opt("REDIS_CACHE_URL"),
            redis_pubsub_url: opt("REDIS_PUBSUB_URL"),
            instance_id: opt("INSTANCE_ID"),
            // Filter out 0 — `GlobalConcurrencyLimitLayer::new(0)` would wedge /settle (never ready).
            settle_max_concurrency: std::env::var("SETTLE_MAX_CONCURRENCY")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|&n| n > 0)
                .unwrap_or(32),
            sponsor_sender_max_per_window: std::env::var("SPONSOR_SENDER_MAX_PER_WINDOW")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|&n| n > 0)
                .unwrap_or(120),
            sponsor_sender_window_secs: std::env::var("SPONSOR_SENDER_WINDOW_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|&n| n > 0)
                .unwrap_or(60),
            sponsor_global_daily_limit: std::env::var("SPONSOR_GLOBAL_DAILY_LIMIT")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|&n| n > 0)
                .unwrap_or(100_000),
            ollama_url: opt("OLLAMA_URL"),
            ollama_model: opt("OLLAMA_MODEL"),
            s3_bucket: opt("S3_TRANSCRIPTS_BUCKET"),
            s3_prefix: opt("S3_TRANSCRIPTS_PREFIX"),
            colocated_fleet_count: std::env::var("FLEET_COLOCATED_COUNT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),
            colocated_fleet_games: std::env::var("FLEET_COLOCATED_GAMES")
                .ok()
                .map(|s| {
                    s.split(',')
                        .map(str::trim)
                        .filter(|g| !g.is_empty())
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
            wallet_pool_id: opt("WALLET_POOL_ID"),
            wallet_pool_access_value: opt("WALLET_POOL_ACCESS_VALUE"),
            wallet_pool_funded_count: std::env::var("WALLET_POOL_FUNDED_COUNT")
                .ok()
                .and_then(|s| s.parse().ok()),
        })
    }

    /// Tuning for the governed fullnode RPC layer (AIMD concurrency + retry/backoff). Read
    /// from env with conservative defaults for the public testnet node; meant to be tuned
    /// empirically (the node's real limit is undocumented).
    pub fn rpc_limits(&self) -> crate::sui_rpc::RpcLimits {
        fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
            std::env::var(name)
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(default)
        }
        let d = crate::sui_rpc::RpcLimits::default();
        crate::sui_rpc::RpcLimits {
            min: env_or("SUI_RPC_MIN_CONCURRENCY", d.min),
            start: env_or("SUI_RPC_START_CONCURRENCY", d.start),
            max: env_or("SUI_RPC_MAX_CONCURRENCY", d.max),
            grow_after: env_or("SUI_RPC_GROW_AFTER", d.grow_after),
            max_retries: env_or("SUI_RPC_MAX_RETRIES", d.max_retries),
            base_backoff_ms: env_or("SUI_RPC_BASE_BACKOFF_MS", d.base_backoff_ms),
            max_backoff_ms: env_or("SUI_RPC_MAX_BACKOFF_MS", d.max_backoff_ms),
        }
    }

    /// Resolve a phase-required var, failing loud with its name. Called at service
    /// construction (e.g. building the settler in Phase 1) — not at startup.
    #[allow(dead_code)] // first caller lands in Phase 1 (settler construction)
    pub fn require<'a>(name: &str, value: &'a Option<String>) -> anyhow::Result<&'a str> {
        value
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("missing required env var: {name}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Phase 0 consumes no on-chain/Walrus config, so it must boot without it:
    // defaults apply and the optional vars stay unset.
    #[test]
    fn from_env_boots_without_onchain_vars() {
        for k in [
            "SUI_RPC_URL",
            "TUNNEL_PACKAGE_ID",
            "SUI_SETTLER_KEY",
            "WALRUS_PUBLISHER_URL",
            "WALRUS_AGGREGATOR_URL",
            "TUNNEL_MANAGER_ADDR",
        ] {
            std::env::remove_var(k);
        }
        let c = Config::from_env().expect("Phase 0 boots without on-chain env");
        assert_eq!(c.bind_addr, "0.0.0.0:8080");
        assert_eq!(c.coin_type, "0x2::sui::SUI");
        assert!(c.sui_rpc_url.is_none());
    }

    // Enoki is optional-with-fallback: a deploy without ENOKI_API_KEY boots settler-only, and
    // SUI_NETWORK defaults to testnet so the chain matches the hard-coded settler digest. The zkLogin
    // identity key is independently optional (a deploy may verify identity without Enoki sponsorship).
    #[test]
    fn from_env_defaults_network_and_leaves_enoki_unset() {
        std::env::remove_var("SUI_NETWORK");
        std::env::remove_var("ENOKI_API_KEY");
        std::env::remove_var("ENOKI_ZKLOGIN_API_KEY");
        let c = Config::from_env().unwrap();
        assert_eq!(c.sui_network, "testnet");
        assert!(c.enoki_api_key.is_none());
        assert!(c.enoki_zklogin_api_key.is_none());
    }

    #[test]
    fn from_env_reads_redis_and_instance() {
        std::env::set_var("REDIS_CACHE_URL", "rediss://cache:6379");
        let c = Config::from_env().unwrap();
        assert_eq!(c.redis_cache_url.as_deref(), Some("rediss://cache:6379"));
        std::env::remove_var("REDIS_CACHE_URL");
    }

    // The fail-loud guarantee lives at the consuming boundary: `require` must name
    // the missing var so a misconfigured deploy fails clearly when it wires the feature.
    #[test]
    fn require_names_the_missing_var() {
        let err = Config::require("SUI_RPC_URL", &None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("SUI_RPC_URL"), "got: {err}");
    }

    struct EnvGuard(&'static str);

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var(self.0);
        }
    }

    // The co-located fleet is opt-in: with no env set it must parse as disabled (count 0, no
    // games) so a default deploy stays inert; when set, count + comma-split games come through.
    #[test]
    fn from_env_colocated_fleet_defaults_off_and_parses_when_set() {
        std::env::remove_var("FLEET_COLOCATED_COUNT");
        std::env::remove_var("FLEET_COLOCATED_GAMES");
        let off = Config::from_env().unwrap();
        assert_eq!(off.colocated_fleet_count, 0, "default must be disabled");
        assert!(off.colocated_fleet_games.is_empty());

        let _count = EnvGuard("FLEET_COLOCATED_COUNT");
        let _games = EnvGuard("FLEET_COLOCATED_GAMES");
        std::env::set_var("FLEET_COLOCATED_COUNT", "3");
        std::env::set_var("FLEET_COLOCATED_GAMES", "blackjack, caro");
        let on = Config::from_env().unwrap();
        assert_eq!(on.colocated_fleet_count, 3);
        assert_eq!(on.colocated_fleet_games, vec!["blackjack", "caro"]);
    }

    // Faucet amounts/cooldown have sensible defaults so a deploy that only sets the AdminCap id
    // works; FAUCET_COOLDOWN_SECS=0 is rejected (would disable the rate limit) and falls back.
    #[test]
    fn from_env_defaults_faucet_params() {
        for k in [
            "FAUCET_USER_AMOUNT",
            "FAUCET_INTERNAL_AMOUNT",
            "FAUCET_COOLDOWN_SECS",
            "FAUCET_MAX_PER_WINDOW",
            "FAUCET_ADMIN_TOKEN",
            "MTPS_ADMIN_CAP_ID",
        ] {
            std::env::remove_var(k);
        }
        let c = Config::from_env().unwrap();
        assert_eq!(c.faucet_user_amount, 10_000);
        assert_eq!(c.faucet_internal_amount, 1_000_000);
        assert_eq!(c.faucet_cooldown_secs, 1_800);
        assert_eq!(c.faucet_max_per_window, 5);
        assert!(c.faucet_admin_token.is_none());
        assert!(c.mtps_admin_cap_id.is_none());
    }

    #[test]
    fn from_env_reads_sponsor_limit_config() {
        let _window = EnvGuard("SPONSOR_SENDER_WINDOW_SECS");
        let _per_sender = EnvGuard("SPONSOR_SENDER_MAX_PER_WINDOW");
        let _daily = EnvGuard("SPONSOR_GLOBAL_DAILY_LIMIT");
        std::env::set_var("SPONSOR_SENDER_WINDOW_SECS", "30");
        std::env::set_var("SPONSOR_SENDER_MAX_PER_WINDOW", "7");
        std::env::set_var("SPONSOR_GLOBAL_DAILY_LIMIT", "99");
        let c = Config::from_env().unwrap();
        assert_eq!(c.sponsor_sender_window_secs, 30);
        assert_eq!(c.sponsor_sender_max_per_window, 7);
        assert_eq!(c.sponsor_global_daily_limit, 99);
    }

    #[test]
    fn from_env_reads_ollama_config() {
        let _url = EnvGuard("OLLAMA_URL");
        let _model = EnvGuard("OLLAMA_MODEL");
        std::env::set_var("OLLAMA_URL", "http://ollama:11434");
        std::env::set_var("OLLAMA_MODEL", "qwen2.5:1.5b");
        let c = Config::from_env().unwrap();
        assert_eq!(c.ollama_url.as_deref(), Some("http://ollama:11434"));
        assert_eq!(c.ollama_model.as_deref(), Some("qwen2.5:1.5b"));
    }

    #[test]
    fn from_env_reads_s3() {
        let _b = EnvGuard("S3_TRANSCRIPTS_BUCKET");
        let _p = EnvGuard("S3_TRANSCRIPTS_PREFIX");
        std::env::set_var("S3_TRANSCRIPTS_BUCKET", "dopamint-dev-transcripts");
        std::env::set_var("S3_TRANSCRIPTS_PREFIX", "x/");
        let c = Config::from_env().unwrap();
        assert_eq!(c.s3_bucket.as_deref(), Some("dopamint-dev-transcripts"));
        assert_eq!(c.s3_prefix.as_deref(), Some("x/"));
    }
}
