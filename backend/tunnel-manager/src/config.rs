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
    /// Enoki PRIVATE api key (`enoki_private_…`). When set, Enoki is the primary gas sponsor and the
    /// settler is the fallback; unset disables Enoki entirely (settler-only). Distinct from the
    /// frontend's PUBLIC `VITE_ENOKI_API_KEY` (zkLogin wallet).
    pub enoki_api_key: Option<String>,
    pub sui_rpc_url: Option<String>,
    pub package_id: Option<String>,
    /// Slim example-app packages — when set, their ops become gas-sponsorable.
    pub agent_allowance_package_id: Option<String>,
    pub streaming_payment_package_id: Option<String>,
    pub settler_key: Option<String>, // base64 ed25519 secret of the gas/settler account
    pub walrus_publisher_url: Option<String>,
    pub walrus_aggregator_url: Option<String>,
    pub redis_cache_url: Option<String>,
    pub redis_pubsub_url: Option<String>,
    pub instance_id: Option<String>,
    /// Max settles executing at once on THIS instance. The limit gates before the request body is
    /// read, so worst-case settle-body memory is bounded at this × the /settle body cap. Per-instance.
    pub settle_max_concurrency: usize,
    pub ollama_url: Option<String>,
    pub ollama_model: Option<String>,
    /// S3 transcript archival (ADR-0023). When set, the settle handler archives the
    /// transcript body to this bucket alongside Walrus. Unset => archival disabled (dev).
    pub s3_bucket: Option<String>,
    /// Optional key prefix (e.g. "prod/"). Default empty.
    pub s3_prefix: Option<String>,
    /// Postgres DATABASE_URL (via RDS Proxy) for the `pending_s3_archive` durable retry
    /// queue. Required for durable retry; when unset, archival is fire-and-forget.
    pub database_url: Option<String>,
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
            sui_rpc_url: opt("SUI_RPC_URL"),
            package_id: opt("TUNNEL_PACKAGE_ID"),
            agent_allowance_package_id: opt("AGENT_ALLOWANCE_PACKAGE_ID"),
            streaming_payment_package_id: opt("STREAMING_PAYMENT_PACKAGE_ID"),
            settler_key: opt("SUI_SETTLER_KEY"),
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
            ollama_url: opt("OLLAMA_URL"),
            ollama_model: opt("OLLAMA_MODEL"),
            s3_bucket: opt("S3_TRANSCRIPTS_BUCKET"),
            s3_prefix: opt("S3_TRANSCRIPTS_PREFIX"),
            database_url: opt("DATABASE_URL"),
        })
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
    // SUI_NETWORK defaults to testnet so the chain matches the hard-coded settler digest.
    #[test]
    fn from_env_defaults_network_and_leaves_enoki_unset() {
        std::env::remove_var("SUI_NETWORK");
        std::env::remove_var("ENOKI_API_KEY");
        let c = Config::from_env().unwrap();
        assert_eq!(c.sui_network, "testnet");
        assert!(c.enoki_api_key.is_none());
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
    fn from_env_reads_s3_and_db() {
        let _b = EnvGuard("S3_TRANSCRIPTS_BUCKET");
        let _p = EnvGuard("S3_TRANSCRIPTS_PREFIX");
        let _d = EnvGuard("DATABASE_URL");
        std::env::set_var("S3_TRANSCRIPTS_BUCKET", "dopamint-dev-transcripts");
        std::env::set_var("S3_TRANSCRIPTS_PREFIX", "x/");
        std::env::set_var("DATABASE_URL", "postgresql://u:p@h:5432/d");
        let c = Config::from_env().unwrap();
        assert_eq!(c.s3_bucket.as_deref(), Some("dopamint-dev-transcripts"));
        assert_eq!(c.s3_prefix.as_deref(), Some("x/"));
        assert_eq!(c.database_url.as_deref(), Some("postgresql://u:p@h:5432/d"));
    }
}
