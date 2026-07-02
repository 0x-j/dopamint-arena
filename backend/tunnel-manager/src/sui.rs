//! On-chain cooperative settlement via the lightweight Sui SDK (PTB build + Ed25519
//! sign) and JSON-RPC (object resolution + execution).
//!
//! The settler is a NON-PARTY gas payer: only the two co-signatures verify on-chain
//! (tunnel.move:1062). It derives NO nonce — `final_nonce` is reconstructed on-chain
//! as `tunnel.state.nonce + 1`; `sig_a`/`sig_b` are passed verbatim. See ADR-0002.
//!
//! Gas: SIP-58 address-balance gas (empty `gas_payment.objects`). The node charges gas as a
//! FundsWithdrawal from the settler's address balance — no owned coin to lock, so concurrent
//! closes never equivocate. Node acceptance (protocol-v125+) is e2e-deferred (no live node).
//!
//! Earlier e2e (localnet, single-close with owned gas) verified the PTB arg order, signature
//! serialization (`UserSignature::to_base64`, not `bcs::to_bytes`), and `pure` encoding.

use std::str::FromStr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context};
use base64::Engine;
use sui_crypto::ed25519::Ed25519PrivateKey;
use sui_crypto::SuiSigner;
use sui_sdk_types::{
    Address, Argument, Command, Digest, GasPayment, Identifier, Input, ProgrammableTransaction,
    Transaction, TransactionExpiration, TransactionKind, TypeTag, UserSignature, WithdrawFrom,
};
use sui_transaction_builder::{Function, ObjectInput, TransactionBuilder};

/// 0x6 system Clock — shared, first shared at version 1.
pub(crate) const CLOCK_ADDRESS: &str =
    "0x0000000000000000000000000000000000000000000000000000000000000006";
/// Fixed gas budget for a single cooperative close (one MoveCall, two shared objects).
pub(crate) const GAS_BUDGET: u64 = 100_000_000;
/// Ceiling for a batched close PTB's budget (ADR-0029): `GAS_BUDGET × K` is capped here so a
/// large batch can't exceed the protocol per-tx gas max. 50,000 SUI = Sui testnet `max_tx_gas`.
const MAX_BATCH_GAS_BUDGET: u64 = 50_000 * 1_000_000_000;
/// Max binary-split depth when isolating a poison settlement in a batch (ADR-0029). Caps the
/// extra round-trips a pathological batch can cost: ≤ 2^depth − 1 retries. 7 covers K≈128.
const MAX_SETTLE_SPLIT_DEPTH: u32 = 7;
/// Per-command gas budget for a sponsored open/fund PTB; the total is this × the PTB's command
/// count, so a batched open of N tunnels (~N+1 commands) scales instead of under-funding on a flat
/// budget. An upper bound, not a charge — the dry-run rejects any PTB whose actual gas exceeds the
/// total before the settler pays, and only actual is charged. Bounded by the 1024-command protocol
/// cap (≪ max_tx_gas): a tight, work-proportional anti-abuse ceiling (ADR-0009).
const SPONSOR_GAS_BUDGET_PER_COMMAND: u64 = 100_000_000;
/// Per-call mint cap, mirroring `mtps::admin_mint`'s `MAX_MINT_PER_CALL` (ADR-0023). The faucet
/// pre-checks against this so an over-cap request returns a clean 422 instead of an on-chain abort.
pub const MAX_MINT_PER_CALL: u64 = 1_000_000;
/// 0x2 Sui framework — the only non-tunnel package the sponsor allows, for `public_share_object`.
const SUI_FRAMEWORK_ADDRESS: &str =
    "0x0000000000000000000000000000000000000000000000000000000000000002";
/// `tunnel` module functions the sponsor will pay gas for: the open/fund lifecycle only. Every
/// other call (other modules, other packages, Publish/Upgrade) is refused so the endpoint can't
/// become an open gas faucet (ADR-0009). Kept in lockstep with the frontend's open/fund builders.
const SPONSOR_TUNNEL_FNS: &[&str] = &[
    "create",
    "deposit_party_a",
    "deposit_party_b",
    "entry_deposit",
    "entry_create_and_share",
    // Batch self-play opener. The deployed package has `create_and_fund` (not the id-returning
    // `_with_id`, which is source-only), and the SDK targets it post-fix — so this is what a
    // sponsored self-play/bot open actually calls.
    "create_and_fund",
    // Cooperative close. PvP closes go through the dedicated `/settle` route (server-sponsored),
    // but self-play/bot games close via the generic `/sponsor` route — so a 0-SUI player can close
    // their own bot game for free. Authorization is the dual-signed settlement, re-verified on-chain.
    // The SDK's close builders target the `entry_` wrappers, so those are the names a sponsored
    // fallback close actually calls — the bare names stay for any direct caller.
    "close_cooperative",
    "close_cooperative_with_root",
    "entry_close_cooperative",
    "entry_close_cooperative_with_root",
];

/// `example_agent_allowance` ops a 0-SUI player may have gas-sponsored. Same safety model as the
/// tunnel allowlist: the escrow comes from the user's OWN input coins, so the settler only pays gas.
const SPONSOR_AGENT_ALLOWANCE_FNS: &[&str] = &[
    "entry_create_and_share",
    "entry_claim",
    "entry_top_up",
    "entry_revoke",
    "pause",
    "resume",
    "set_rate",
];

/// `streaming_payment` ops sponsorable for a 0-SUI sender — the stream is funded from the
/// user's OWN input coins, so the settler only pays gas.
const SPONSOR_STREAMING_PAYMENT_FNS: &[&str] = &[
    "create_stream",
    "withdraw",
    "withdraw_amount",
    "cancel_stream",
    "top_up",
];

/// A sponsorable example-app module: package, module name, allowlisted fns. Each new payment example
/// is one more entry, built from config in `SuiSettler::new` — a config + one-line change, not a new
/// validator parameter every time.
type ExampleModule = (Address, &'static str, &'static [&'static str]);
/// Testnet genesis checkpoint digest — the chain identifier `ValidDuring` uses for cross-chain
/// replay protection (its first 4 bytes are the `4c78adac` testnet chain id). SIP-58
/// address-balance gas requires this in the transaction expiration.
pub(crate) const CHAIN_DIGEST_B58: &str = "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD";

/// Fields for one on-chain `close_cooperative_with_root`, mapped from the SDK's
/// SettlementWithRoot (ADR-0002). Balances/timestamp already parsed to `u64`; sigs and
/// root already hex-decoded by the handler.
#[derive(Clone)]
pub struct CloseArgs {
    pub tunnel_id: String,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub sig_a: Vec<u8>,
    pub sig_b: Vec<u8>,
    pub timestamp: u64,
    pub transcript_root: Vec<u8>,
}

/// Outcome of a settle attempt, split by whether the client should retry. `Transient` means
/// the fullnode rate-limited us (after `GovernedRpc` exhausted its own retries) — the handler
/// answers 503 + Retry-After. `Rejected` means the settlement itself is bad — the handler
/// answers 422 and the client must not retry the same bytes.
#[derive(Clone)]
pub enum CloseError {
    Transient {
        msg: String,
        retry_after: Option<u64>,
    },
    Rejected(String),
}

impl std::fmt::Display for CloseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloseError::Transient { msg, .. } => write!(f, "{msg}"),
            CloseError::Rejected(msg) => write!(f, "{msg}"),
        }
    }
}

/// Classify an on-chain-path `anyhow` error into the settle taxonomy by downcasting the preserved
/// `RpcError` source: a fullnode rate-limit (after `GovernedRpc` exhausted its retries) is
/// `Transient`; anything else (bad sig, already-closed, balance mismatch, build error) is
/// `Rejected`. Not string-matching — the type is carried through via `with_context`.
fn anyhow_to_close_error(e: anyhow::Error) -> CloseError {
    match e.downcast_ref::<crate::sui_rpc::RpcError>() {
        Some(crate::sui_rpc::RpcError::Transient { retry_after, .. }) => CloseError::Transient {
            msg: e.to_string(),
            retry_after: *retry_after,
        },
        _ => CloseError::Rejected(e.to_string()),
    }
}

/// A shared object's PTB reference: id + the version it was first shared at.
#[derive(Clone)]
struct SharedRef {
    id: Address,
    initial_shared_version: u64,
}

/// An owned object's PTB reference: its current (id, version, digest). Owned inputs are
/// version-pinned, so this must be re-resolved before each tx that mutates the object — the version
/// bumps on every use (see the faucet's `mint_lock`).
#[derive(Clone)]
struct OwnedRef {
    id: Address,
    version: u64,
    digest: Digest,
}

pub struct SuiSettler {
    /// The single governed JSON-RPC client (throttle + retry/backoff), shared with the arena
    /// opener so all fullnode traffic is throttled together against the one rate-limited node.
    rpc: std::sync::Arc<crate::sui_rpc::GovernedRpc>,
    package_id: Address,
    coin_type: TypeTag,
    /// MTPS `AdminCap` object id (ADR-0023), owned by `sender`. `None` = the faucet is unconfigured
    /// and `mint_mtps` refuses. The cap is an owned `&mut` input to `admin_mint`.
    admin_cap_id: Option<Address>,
    /// Sponsorable example-app modules (agent allowance, streaming payment, …), built from config.
    /// Empty = only the tunnel/coin/faucet allowlist applies.
    example_packages: Vec<ExampleModule>,
    signer: Ed25519PrivateKey,
    sender: Address,
    /// Per-sponsorship nonce source for the `ValidDuring` FundsWithdrawal replay guard. Seeded
    /// from wall-clock nanos at boot so two process runs in the same epoch don't collide.
    sponsor_nonce: AtomicU32,
    /// Serializes `admin_mint` calls. The `AdminCap` is a single owned object: two concurrent mints
    /// would pin the same version and equivocate (one fails). One in-flight mint at a time, so the
    /// cap's owned ref re-resolved per call is always current.
    mint_lock: tokio::sync::Mutex<()>,
}

/// A parsed tunnel lifecycle event: the type suffix drives status folding; the rest feeds the
/// recent-events ring. `transcript_root` is hex; balances are `None` on non-close events.
#[derive(Debug, Clone)]
pub struct RawTunnelEvent {
    pub type_suffix: String,
    pub tunnel_id: String,
    /// party_a/party_b from a `TunnelCreated`'s `parsedJson`; the indexer folds them into the
    /// ownership map (other event types carry no addresses).
    pub party_a: Option<String>,
    pub party_b: Option<String>,
    /// Tx sender from the event envelope (`/sender`) — the wallet that opened/funded the tunnel.
    pub sender: Option<String>,
    pub party_a_balance: Option<u64>,
    pub party_b_balance: Option<u64>,
    pub transcript_root: Option<String>,
    pub tx_digest: String,
    pub timestamp_ms: u64,
}

/// u64 fields arrive over JSON-RPC as strings; accept a number too, for robustness.
fn parsed_u64(v: &serde_json::Value, field: &str) -> Option<u64> {
    let f = v.pointer(&format!("/parsedJson/{field}"))?;
    f.as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| f.as_u64())
}

/// Read a Sui address string from `parsedJson` (e.g. `party_a` on `TunnelCreated`).
fn parsed_addr(v: &serde_json::Value, field: &str) -> Option<String> {
    v.pointer(&format!("/parsedJson/{field}"))?
        .as_str()
        .map(str::to_string)
}

/// `vector<u8>` arrives as an array of byte numbers; render to lowercase hex.
/// NOTE: the exact `vector<u8>` JSON encoding is confirmed against a live event during the
/// e2e milestone (see spec "Dependencies & readiness"); array-of-bytes is the documented shape.
fn parsed_bytes_hex(v: &serde_json::Value, field: &str) -> Option<String> {
    let arr = v.pointer(&format!("/parsedJson/{field}"))?.as_array()?;
    let mut out = String::with_capacity(arr.len() * 2);
    for b in arr {
        out.push_str(&format!("{:02x}", b.as_u64()? as u8));
    }
    Some(out)
}

/// Parse one `suix_queryEvents` data row into a `RawTunnelEvent`, or `None` if it is not a
/// tunnel lifecycle event (no `parsedJson.tunnel_id`).
fn parse_event_row(ev: &serde_json::Value) -> Option<RawTunnelEvent> {
    let tunnel_id = ev.pointer("/parsedJson/tunnel_id")?.as_str()?.to_string();
    let type_suffix = ev
        .get("type")
        .and_then(|v| v.as_str())
        .and_then(|t| t.rsplit("::").next())
        .unwrap_or_default()
        .to_string();
    let tx_digest = ev
        .pointer("/id/txDigest")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let timestamp_ms = ev
        .get("timestampMs")
        .and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse().ok())
                .or_else(|| v.as_u64())
        })
        .unwrap_or(0);
    Some(RawTunnelEvent {
        type_suffix,
        tunnel_id,
        party_a: parsed_addr(ev, "party_a"),
        party_b: parsed_addr(ev, "party_b"),
        sender: ev
            .get("sender")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        party_a_balance: parsed_u64(ev, "party_a_balance"),
        party_b_balance: parsed_u64(ev, "party_b_balance"),
        transcript_root: parsed_bytes_hex(ev, "transcript_root"),
        tx_digest,
        timestamp_ms,
    })
}

/// Read a `sui_dryRunTransactionBlock` result: `Ok` iff `effects.status.status == "success"`,
/// else `Err(<status json>)`. Mirrors the `execute()` status check; lets the settler reject a
/// settlement that will not land BEFORE sponsoring gas (ADR-0007). Unit-tested against sample JSON.
pub(crate) fn dryrun_effects_ok(resp: &serde_json::Value) -> Result<(), String> {
    match resp
        .pointer("/effects/status/status")
        .and_then(|v| v.as_str())
    {
        Some("success") => Ok(()),
        _ => Err(resp
            .pointer("/effects/status")
            .map(|v| v.to_string())
            .unwrap_or_else(|| "dry-run result missing effects.status".to_string())),
    }
}

impl SuiSettler {
    pub fn new(
        rpc: std::sync::Arc<crate::sui_rpc::GovernedRpc>,
        package_id: &str,
        coin_type: &str,
        agent_allowance_package_id: Option<&str>,
        streaming_payment_package_id: Option<&str>,
        settler_key_b64: &str,
        mtps_admin_cap_id: Option<&str>,
    ) -> anyhow::Result<Self> {
        let signer = load_ed25519(settler_key_b64)?;
        let sender = signer.public_key().derive_address();
        let admin_cap_id = mtps_admin_cap_id
            .map(|s| Address::from_str(s).context("bad MTPS_ADMIN_CAP_ID"))
            .transpose()?;
        // Build the sponsorable example-app set from whatever packages are configured.
        let mut example_packages: Vec<ExampleModule> = Vec::new();
        if let Some(s) = agent_allowance_package_id {
            let pkg = Address::from_str(s).context("bad AGENT_ALLOWANCE_PACKAGE_ID")?;
            example_packages.push((pkg, "example_agent_allowance", SPONSOR_AGENT_ALLOWANCE_FNS));
        }
        if let Some(s) = streaming_payment_package_id {
            let pkg = Address::from_str(s).context("bad STREAMING_PAYMENT_PACKAGE_ID")?;
            example_packages.push((pkg, "streaming_payment", SPONSOR_STREAMING_PAYMENT_FNS));
        }
        // Seed the per-sponsorship nonce from the full wall clock (secs mixed with nanos), not
        // just subsec_nanos, so two restarts in the same epoch are very unlikely to pick colliding
        // seeds (a collision is a liveness hiccup — the node rejects the replayed withdrawal — not
        // a fund risk). A multi-instance HA deployment would still want a shared/instance-tagged
        // counter; out of scope here.
        let nonce_seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| {
                (d.as_secs() as u32)
                    .wrapping_mul(2_654_435_761)
                    .wrapping_add(d.subsec_nanos())
            })
            .unwrap_or(0);
        Ok(Self {
            rpc,
            package_id: Address::from_str(package_id).context("bad TUNNEL_PACKAGE_ID")?,
            coin_type: TypeTag::from_str(coin_type).context("bad TUNNEL_COIN_TYPE")?,
            admin_cap_id,
            example_packages,
            signer,
            sender,
            sponsor_nonce: AtomicU32::new(nonce_seed),
            mint_lock: tokio::sync::Mutex::new(()),
        })
    }

    /// Construct a no-op settler for tests — RPC calls will fail at the network layer, which is
    /// acceptable since tests using `in_memory_for_test` never invoke `submit_close`.
    #[cfg(any(test, feature = "test-util"))]
    pub fn noop() -> Self {
        let signer = Ed25519PrivateKey::new([0u8; 32]);
        let sender = signer.public_key().derive_address();
        Self {
            rpc: crate::sui_rpc::GovernedRpc::new(
                String::new(),
                crate::sui_rpc::RpcLimits::default(),
            ),
            package_id: Address::ZERO,
            coin_type: "0x2::sui::SUI".parse().expect("static coin type"),
            admin_cap_id: None,
            example_packages: Vec::new(),
            signer,
            sender,
            sponsor_nonce: AtomicU32::new(0),
            mint_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Batched settle (ADR-0029): submit up to K closes as ONE PTB, isolating a poison settlement
    /// by retry-by-split. Resolves all K shared refs in one `multiGetObjects` and reads epoch/gas
    /// once, so a healthy batch costs ~constant RPC regardless of K. Returns one result per input
    /// close, in order. This is the sole on-chain settle path (the worker calls it via the
    /// `BatchSettler` trait); a single close is just a batch of one.
    pub async fn submit_close_batch(
        &self,
        closes: Vec<CloseArgs>,
    ) -> Vec<Result<String, CloseError>> {
        if closes.is_empty() {
            return Vec::new();
        }
        let ids: Vec<String> = closes.iter().map(|c| c.tunnel_id.clone()).collect();
        let refs = match self.resolve_shared_many(&ids).await {
            Ok(r) => r,
            Err(e) => {
                let ce = anyhow_to_close_error(e);
                return closes.iter().map(|_| Err(ce.clone())).collect();
            }
        };
        let ref_map: std::collections::HashMap<String, SharedRef> =
            ids.iter().cloned().zip(refs).collect();
        let (epoch, gas_price) = match self.epoch_and_gas_price().await {
            Ok(v) => v,
            Err(e) => {
                let ce = anyhow_to_close_error(e);
                return closes.iter().map(|_| Err(ce.clone())).collect();
            }
        };
        crate::settle_batch::split_submit(closes, MAX_SETTLE_SPLIT_DEPTH, |sub| {
            let refs: Vec<SharedRef> = sub.iter().map(|c| ref_map[&c.tunnel_id].clone()).collect();
            self.try_submit_one_ptb(sub, refs, epoch, gas_price)
        })
        .await
    }

    /// Build, dry-run, sign, and execute ONE batched-close PTB for `sub`. Each call draws a fresh
    /// `sponsor_nonce` so a split-retry sub-tx never replays the SIP-58 withdrawal. Errors carry the
    /// transient/rejected distinction (downcast from the governed `RpcError`).
    async fn try_submit_one_ptb(
        &self,
        sub: Vec<CloseArgs>,
        refs: Vec<SharedRef>,
        epoch: u64,
        gas_price: u64,
    ) -> Result<String, CloseError> {
        let chain = Digest::from_base58(CHAIN_DIGEST_B58)
            .map_err(|e| CloseError::Rejected(format!("chain digest: {e}")))?;
        let nonce = self.sponsor_nonce.fetch_add(1, Ordering::Relaxed);
        let tx = build_close_batch_tx(
            self.package_id,
            &self.coin_type,
            self.sender,
            &sub,
            &refs,
            gas_price,
            epoch,
            chain,
            nonce,
        )
        .map_err(|e| CloseError::Rejected(format!("build batch: {e}")))?;
        // Verify-before-gas (ADR-0007): the dry-run runs every close, re-checking both seat sigs
        // and the balance sum, before the settler pays. A poison close aborts here → Rejected → split.
        self.dry_run(&tx).await.map_err(anyhow_to_close_error)?;
        let sig = self
            .signer
            .sign_transaction(&tx)
            .map_err(|e| CloseError::Rejected(format!("sign batch tx: {e}")))?;
        self.execute(&tx, &sig).await.map_err(anyhow_to_close_error)
    }

    /// Sponsor gas (only) for a user's open/fund transaction (ADR-0009). The `user` is the tx
    /// SENDER; the settler is the gas owner, paying via SIP-58 address-balance gas from its own
    /// balance. Refuses anything but the allowlisted tunnel open/fund calls, dry-runs before
    /// signing (so a tx that won't land never costs the settler gas), and returns
    /// `(txBytes_b64, sponsorSig_b64)`. The caller (user) co-signs the SAME bytes and submits with
    /// both signatures — the funds (stake) come from the user's own coin, never the sponsor.
    pub async fn sponsor_open_fund(
        &self,
        user: &str,
        kind_b64: &str,
    ) -> anyhow::Result<(String, String)> {
        let user_addr = Address::from_str(user).context("bad sender address")?;
        let kind_bytes = base64::engine::general_purpose::STANDARD
            .decode(kind_b64.trim())
            .context("txKindBytes is not valid base64")?;
        let (epoch, gas_price) = self.epoch_and_gas_price().await?;
        let chain = Digest::from_base58(CHAIN_DIGEST_B58).context("chain digest")?;
        let tx = build_sponsored_tx(
            self.package_id,
            &self.coin_type,
            &self.example_packages,
            user_addr,
            self.sender,
            &kind_bytes,
            gas_price,
            epoch,
            chain,
            self.sponsor_nonce.fetch_add(1, Ordering::Relaxed),
        )?;
        // Verify-before-gas (ADR-0009, mirrors /settle): the unsigned tx is enough to simulate —
        // the user's sender signature is not checked by a dry-run, only that the PTB would land.
        let tx_b64 =
            base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).context("bcs tx")?);
        let r = self
            .rpc("sui_dryRunTransactionBlock", serde_json::json!([tx_b64]))
            .await?;
        dryrun_effects_ok(&r).map_err(|e| anyhow!("sponsor dry-run failed: {e}"))?;
        let sig = self
            .signer
            .sign_transaction(&tx)
            .map_err(|e| anyhow!("sign sponsor tx: {e}"))?;
        Ok((tx_b64, sig.to_base64()))
    }

    /// Sponsor gas for a backend-built arena seat-B open (ADR-0028): the BOT is the tx sender (its
    /// SIP-58 MTPS balance funds seat B), the settler owns the SIP-58 gas — so the bot needs zero SUI.
    /// Unlike `sponsor_open_fund` (untrusted client kind → returns bytes for the client to co-sign),
    /// this is the trusted in-process fleet path: it returns the wrapped `Transaction` + the settler's
    /// gas signature so the caller co-signs as the bot and executes. Reuses `build_sponsored_tx` — the
    /// same open/fund allowlist, per-command budget, and `sponsor_nonce`, so every settler-gas
    /// withdrawal (opens, faucet, `/settle`, user sponsors) draws from one monotonic nonce source.
    /// Dry-runs before signing: a drained settler gas balance or an unfundable open never gets signed.
    pub async fn sponsor_arena_open(
        &self,
        bot_sender: Address,
        kind_bytes: &[u8],
    ) -> anyhow::Result<(Transaction, UserSignature)> {
        let (epoch, gas_price) = self.epoch_and_gas_price().await?;
        let chain = Digest::from_base58(CHAIN_DIGEST_B58).context("chain digest")?;
        let tx = build_sponsored_tx(
            self.package_id,
            &self.coin_type,
            &self.example_packages,
            bot_sender,
            self.sender,
            kind_bytes,
            gas_price,
            epoch,
            chain,
            self.sponsor_nonce.fetch_add(1, Ordering::Relaxed),
        )?;
        self.dry_run(&tx).await?;
        let sig = self
            .signer
            .sign_transaction(&tx)
            .map_err(|e| anyhow!("sign arena open gas: {e}"))?;
        Ok((tx, sig))
    }

    /// True iff the MTPS `AdminCap` id is configured. The faucet routes 503 when this is false, so
    /// they never claim a cooldown nor sign a mint they cannot complete.
    pub fn mint_configured(&self) -> bool {
        self.admin_cap_id.is_some()
    }

    /// Mint `amount` whole-token MTPS to `recipient` (ADR-0023); returns the tx digest. `to_balance`
    /// selects the entry: `admin_mint_to_balance` deposits straight into the recipient's SIP-58
    /// address balance (the stake path withdraws from it — no client sweep), `admin_mint` gives an
    /// owned coin. The settler holds the `AdminCap`, so this signs with the settler key. Serialized by
    /// `mint_lock`: the cap is a single owned `&mut` input, so concurrent mints would equivocate on
    /// its version — one mint at a time, with the cap's owned ref re-resolved fresh each call.
    pub async fn mint_mtps(
        &self,
        recipient: &str,
        amount: u64,
        to_balance: bool,
    ) -> anyhow::Result<String> {
        let _guard = self.mint_lock.lock().await;
        let cap_id = self
            .admin_cap_id
            .ok_or_else(|| anyhow!("faucet not configured: MTPS_ADMIN_CAP_ID unset"))?;
        let recipient_addr = Address::from_str(recipient).context("bad recipient address")?;
        // The MTPS module lives in the coin type's own package (`<pkg>::mtps::admin_mint`).
        let mtps_package = coin_type_address(&self.coin_type)
            .ok_or_else(|| anyhow!("TUNNEL_COIN_TYPE is not an MTPS struct type"))?;
        let cap = self.resolve_owned(cap_id).await?;
        let (epoch, gas_price) = self.epoch_and_gas_price().await?;
        let chain = Digest::from_base58(CHAIN_DIGEST_B58).context("chain digest")?;
        let tx = build_admin_mint_tx(
            mtps_package,
            self.sender,
            &cap,
            recipient_addr,
            amount,
            to_balance,
            gas_price,
            epoch,
            chain,
            self.sponsor_nonce.fetch_add(1, Ordering::Relaxed),
        )?;
        // Verify-before-gas (mirrors /settle): an unsigned dry-run catches the `MAX_MINT_PER_CALL`
        // abort or a wrong cap before the settler pays gas.
        self.dry_run(&tx).await?;
        let sig = self
            .signer
            .sign_transaction(&tx)
            .map_err(|e| anyhow!("sign mint tx: {e}"))?;
        self.execute(&tx, &sig).await
    }

    /// Decode + validate a base64 tx KIND against the SAME anti-abuse allowlist the settler path
    /// uses, and return its de-duplicated `pkg::module::fn` move-call targets — for Enoki's
    /// `allowedMoveCallTargets`. The sponsor handler calls this FIRST so an off-allowlist tx is
    /// rejected before any provider is asked to pay (ADR-0014). Pure (no I/O); the settler's
    /// `sponsor_open_fund` re-validates independently, so this never weakens that path.
    pub fn validate_kind(&self, kind_b64: &str) -> anyhow::Result<Vec<String>> {
        let kind_bytes = base64::engine::general_purpose::STANDARD
            .decode(kind_b64.trim())
            .context("txKindBytes is not valid base64")?;
        validate_kind_inner(
            &kind_bytes,
            self.package_id,
            &self.coin_type,
            &self.example_packages,
        )
    }

    /// Dry-run the built close tx so the real `close_cooperative_with_root` runs (re-verifying
    /// both seat sigs against the on-chain pubkeys and the balance sum) WITHOUT executing — an
    /// invalid settlement is rejected here, before any gas is sponsored (ADR-0007). The seat sigs
    /// are PTB `vector<u8>` arguments, so an unsigned tx is sufficient to exercise them.
    /// e2e-deferred (needs a live node); the status parse is unit-tested (`dryrun_effects_ok`).
    async fn dry_run(&self, tx: &Transaction) -> anyhow::Result<()> {
        let tx_b64 =
            base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(tx).context("bcs tx")?);
        let r = self
            .rpc("sui_dryRunTransactionBlock", serde_json::json!([tx_b64]))
            .await?;
        dryrun_effects_ok(&r).map_err(|e| anyhow!("close dry-run failed: {e}"))
    }

    // ---- JSON-RPC reads/execute (compile-verified; e2e-deferred, see module docs) ----

    /// Adapter for all on-chain paths: delegate to the governed client. `with_context`
    /// (not `anyhow!`) keeps the `RpcError` as the chain *source*, so `submit_close_typed`
    /// can downcast it to tell a transient 429 (→ 503) from a genuine rejection (→ 422).
    async fn rpc(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.rpc
            .call(method, params)
            .await
            .with_context(|| format!("rpc {method}"))
    }

    /// Resolve many tunnels' shared refs in ONE round-trip per ≤50-id chunk via
    /// `sui_multiGetObjects` (ADR-0029) — so a K-close batch costs ~K/50 reads, not K. Returns refs
    /// in the same order as `ids`. `initial_shared_version` is immutable for a shared object, so this
    /// is the only per-settle object read the batch path makes.
    async fn resolve_shared_many(&self, ids: &[String]) -> anyhow::Result<Vec<SharedRef>> {
        let mut out = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(50) {
            let r = self
                .rpc(
                    "sui_multiGetObjects",
                    serde_json::json!([chunk, {"showOwner": true}]),
                )
                .await?;
            let arr = r
                .as_array()
                .ok_or_else(|| anyhow!("multiGetObjects did not return an array: {r}"))?;
            anyhow::ensure!(
                arr.len() == chunk.len(),
                "multiGetObjects returned {} objects for {} ids",
                arr.len(),
                chunk.len()
            );
            for (obj, id) in arr.iter().zip(chunk) {
                let isv = obj
                    .pointer("/data/owner/Shared/initial_shared_version")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| anyhow!("object {id} is not a shared tunnel: {obj}"))?;
                out.push(SharedRef {
                    id: Address::from_str(id).context("tunnel id")?,
                    initial_shared_version: isv,
                });
            }
        }
        Ok(out)
    }

    /// Resolve an OWNED object's current (version, digest) for a version-pinned PTB input. Used for
    /// the `AdminCap`, whose version bumps on every mint — so this is re-read under `mint_lock`
    /// before each `admin_mint`. Verifies the cap is address-owned by the settler (`sender`): if it
    /// is not, no mint this key signs could ever land, so fail loud rather than burn a dry-run.
    async fn resolve_owned(&self, id: Address) -> anyhow::Result<OwnedRef> {
        let r = self
            .rpc(
                "sui_getObject",
                serde_json::json!([id.to_string(), {"showOwner": true}]),
            )
            .await?;
        let owner = r
            .pointer("/data/owner/AddressOwner")
            .and_then(|v| v.as_str());
        anyhow::ensure!(
            owner == Some(self.sender.to_string().as_str()),
            "AdminCap {id} is not owned by the settler address {} (owner: {owner:?})",
            self.sender,
        );
        let version = r
            .pointer("/data/version")
            .and_then(|v| {
                v.as_str()
                    .and_then(|s| s.parse().ok())
                    .or_else(|| v.as_u64())
            })
            .ok_or_else(|| anyhow!("object {id} has no version: {r}"))?;
        let digest = r
            .pointer("/data/digest")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("object {id} has no digest: {r}"))?;
        Ok(OwnedRef {
            id,
            version,
            digest: Digest::from_base58(digest).context("object digest")?,
        })
    }

    /// `(epoch, reference_gas_price)` in one round-trip. Both are per-epoch constants and the
    /// system-state summary carries both, so the close/sponsor paths read them together instead of
    /// firing two RPCs. Epoch is fetched fresh (never cached): the SIP-58 `ValidDuring` expiration
    /// must equal the *current* epoch (see `build_close_tx`), so a stale epoch would be unlandable.
    async fn epoch_and_gas_price(&self) -> anyhow::Result<(u64, u64)> {
        let r = self
            .rpc("suix_getLatestSuiSystemState", serde_json::json!([]))
            .await?;
        let epoch = r
            .pointer("/epoch")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| anyhow!("no epoch in latest system state"))?;
        let gas_price = r
            .pointer("/referenceGasPrice")
            .and_then(|v| {
                v.as_str()
                    .and_then(|s| s.parse().ok())
                    .or_else(|| v.as_u64())
            })
            .ok_or_else(|| anyhow!("no referenceGasPrice in latest system state"))?;
        Ok((epoch, gas_price))
    }

    async fn execute(&self, tx: &Transaction, sig: &UserSignature) -> anyhow::Result<String> {
        let b64 = base64::engine::general_purpose::STANDARD;
        let tx_b64 = b64.encode(bcs::to_bytes(tx).context("bcs tx")?);
        // NOT bcs::to_bytes — UserSignature's BCS double-tags the enum (98 bytes). The
        // JSON-RPC `signatures` field wants the flat 97-byte flag‖sig‖pubkey form, which
        // is exactly `to_base64()`. (Pinned by ed25519_signature_serializes_to_97_byte_sui_format.)
        let sig_b64 = sig.to_base64();
        let r = self
            .rpc(
                "sui_executeTransactionBlock",
                serde_json::json!([tx_b64, [sig_b64], {"showEffects": true}, "WaitForLocalExecution"]),
            )
            .await?;
        // On-chain verification failure (bad sig / balance sum) surfaces here, not as a
        // transport error — make it a hard error so the handler maps it to 422.
        if let Some(status) = r.pointer("/effects/status/status").and_then(|v| v.as_str()) {
            anyhow::ensure!(
                status == "success",
                "on-chain execution failed: {}",
                r.pointer("/effects/status")
                    .map(|v| v.to_string())
                    .unwrap_or_default()
            );
        }
        r.get("digest")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("no digest in execute result: {r}"))
    }

    /// Poll this package's `tunnel` module events, cursor-paginated (ascending). Returns
    /// `(events, next_cursor)`; the cursor is opaque (passed straight back).
    /// e2e-deferred (needs a live node + package).
    pub async fn query_tunnel_events(
        &self,
        cursor: Option<serde_json::Value>,
    ) -> anyhow::Result<(Vec<RawTunnelEvent>, Option<serde_json::Value>)> {
        let filter = serde_json::json!({
            "MoveModule": { "package": self.package_id.to_string(), "module": "tunnel" }
        });
        let r = self
            .rpc(
                "suix_queryEvents",
                serde_json::json!([filter, cursor, 50, false]),
            )
            .await?;
        let mut events = Vec::new();
        if let Some(data) = r.get("data").and_then(|v| v.as_array()) {
            for ev in data {
                if let Some(raw) = parse_event_row(ev) {
                    events.push(raw);
                }
            }
        }
        // Advance only when the node gives a cursor; a null cursor (empty poll) keeps our
        // position so we don't replay from genesis every tick.
        let next = r.get("nextCursor").cloned().filter(|v| !v.is_null());
        Ok((events, next))
    }
}

/// Project a raw event to a displayable row, inheriting ownership/game (which its own event does
/// not carry). Returns `None` for non-display events (e.g. `TunnelCreated`). Missing owner/game →
/// `None` fields → today's neutral display (no highlight, `—`), never a false attribution.
#[allow(dead_code)]
fn enrich_event_row(
    raw: &RawTunnelEvent,
    owner: Option<crate::state::TunnelOwner>,
    game: Option<String>,
) -> Option<crate::state::TunnelEvent> {
    let kind = match raw.type_suffix.as_str() {
        "TunnelActivated" => crate::state::TunnelEventKind::Opened,
        "TunnelClosed" | "TunnelClosedWithRoot" => crate::state::TunnelEventKind::Settled,
        _ => return None,
    };
    let (party_a, party_b, funder) = match owner {
        Some(o) => (o.party_a, o.party_b, o.funder),
        None => (None, None, None),
    };
    Some(crate::state::TunnelEvent {
        tunnel_id: raw.tunnel_id.clone(),
        kind,
        party_a,
        party_b,
        funder,
        game,
        party_a_balance: raw.party_a_balance,
        party_b_balance: raw.party_b_balance,
        transcript_root: raw.transcript_root.clone(),
        tx_digest: raw.tx_digest.clone(),
        timestamp_ms: raw.timestamp_ms,
        proof_url: None, // indexer rows are explorer-only; the /settle handler sets proofUrl
    })
}

/// Fold one raw chain event into the store: maintain tunnel status, capture set-once ownership at
/// `TunnelCreated` (funder = the open tx sender), then inherit owner + the joined game onto the
/// displayed Opened/Settled row. Extracted from the poll loop so the composition is unit-testable.
#[allow(dead_code)]
async fn fold_event(control: &dyn crate::store::ControlStore, raw: &RawTunnelEvent) {
    let status = match raw.type_suffix.as_str() {
        "TunnelCreated" => Some(crate::state::TunnelStatus::Created),
        "TunnelActivated" => Some(crate::state::TunnelStatus::Active),
        "TunnelClosed" | "TunnelClosedWithRoot" => Some(crate::state::TunnelStatus::Closed),
        _ => None,
    };
    if let Some(s) = status {
        control.set_tunnel_status(&raw.tunnel_id, s).await;
    }
    if raw.type_suffix == "TunnelCreated" {
        control
            .set_tunnel_owner(
                &raw.tunnel_id,
                crate::state::TunnelOwner {
                    party_a: raw.party_a.clone(),
                    party_b: raw.party_b.clone(),
                    funder: raw.sender.clone(),
                },
            )
            .await;
    }
    let owner = control.get_tunnel_owner(&raw.tunnel_id).await;
    let game = control.tunnel_game(&raw.tunnel_id).await;
    if let Some(row) = enrich_event_row(raw, owner, game) {
        control.push_recent_event(row).await;
    }
}

/// Poll the chain for this package's tunnel events and fold them into the registry via
/// `ControlStore::set_tunnel_status` — the transition logic (idempotency, count maintenance)
/// now lives in the store impl. e2e-deferred (needs a live node + published package).
#[allow(dead_code)]
pub fn spawn_event_indexer(state: crate::state::SharedState) {
    tokio::spawn(async move {
        let mut cursor = None;
        loop {
            match state.settler.query_tunnel_events(cursor.clone()).await {
                Ok((events, next)) => {
                    for raw in events {
                        fold_event(state.control.as_ref(), &raw).await;
                    }
                    if next.is_some() {
                        cursor = next;
                    }
                }
                Err(e) => tracing::warn!(error = %e, "tunnel event poll failed; retrying"),
            }
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }
    });
}

/// PURE core (ADR-0029): build ONE PTB with K `close_cooperative_with_root` calls — the
/// fleet-scale lever. Each call is independent (distinct shared tunnel + its own seat sigs as
/// `vector<u8>` args), the settler is the sole signer + SIP-58 gas payer, and the clock is one
/// shared input shared by all calls. Gas scales with K (capped at the protocol max). `nonce` is
/// per-batch: each PTB (including a split-retry sub-batch) gets a distinct one so the SIP-58
/// `ValidDuring` withdrawal can't be replayed. `tunnels[i]` must be the shared ref for `closes[i]`.
#[allow(clippy::too_many_arguments)]
fn build_close_batch_tx(
    package_id: Address,
    coin_type: &TypeTag,
    sender: Address,
    closes: &[CloseArgs],
    tunnels: &[SharedRef],
    gas_price: u64,
    epoch: u64,
    chain: Digest,
    nonce: u32,
) -> anyhow::Result<Transaction> {
    anyhow::ensure!(!closes.is_empty(), "empty batch");
    anyhow::ensure!(
        closes.len() == tunnels.len(),
        "closes/tunnels length mismatch: {} vs {}",
        closes.len(),
        tunnels.len()
    );
    let mut tb = TransactionBuilder::new();
    // One shared, read-only clock input referenced by every call in the batch.
    let clock_arg = tb.object(ObjectInput::shared(
        Address::from_str(CLOCK_ADDRESS).expect("static clock id"),
        1,
        false,
    ));
    for (args, tunnel) in closes.iter().zip(tunnels.iter()) {
        anyhow::ensure!(
            args.transcript_root.len() == 32,
            "transcript_root must be 32 bytes, got {}",
            args.transcript_root.len()
        );
        let tunnel_arg = tb.object(ObjectInput::shared(
            tunnel.id,
            tunnel.initial_shared_version,
            true,
        ));
        let a = tb.pure(&args.party_a_balance);
        let b = tb.pure(&args.party_b_balance);
        let sa = tb.pure(&args.sig_a);
        let sb = tb.pure(&args.sig_b);
        let ts = tb.pure(&args.timestamp);
        let root = tb.pure(&args.transcript_root);
        let func = Function::new(
            package_id,
            Identifier::new("tunnel").context("module ident")?,
            Identifier::new("close_cooperative_with_root").context("fn ident")?,
        )
        .with_type_args(vec![coin_type.clone()]);
        tb.move_call(func, vec![tunnel_arg, a, b, sa, sb, ts, root, clock_arg]);
    }

    tb.add_gas_objects([ObjectInput::owned(Address::ZERO, 1, Digest::ZERO)]);
    tb.set_sender(sender);
    // Scale the budget with batch size, capped at the protocol's per-tx ceiling.
    let budget = GAS_BUDGET
        .saturating_mul(closes.len() as u64)
        .min(MAX_BATCH_GAS_BUDGET);
    tb.set_gas_budget(budget);
    tb.set_gas_price(gas_price.max(1));
    tb.set_expiration(TransactionExpiration::ValidDuring {
        min_epoch: Some(epoch),
        max_epoch: Some(epoch),
        min_timestamp: None,
        max_timestamp: None,
        chain,
        nonce,
    });
    let mut tx = tb
        .try_build()
        .map_err(|e| anyhow!("build batch close tx: {e}"))?;
    tx.gas_payment.objects.clear();
    Ok(tx)
}

/// PURE core: build the `mtps::admin_mint{,_to_balance}(cap, amount, recipient)` PTB (ADR-0023). Arg
/// order matches the Move signature exactly: the owned `&mut AdminCap`, the `u64` amount, the
/// recipient `address`. `to_balance` picks `admin_mint_to_balance` (deposit into the recipient's
/// SIP-58 address balance) over `admin_mint` (owned coin); both share that signature and are not
/// generic, so there is no type argument. SIP-58 address-balance gas like `build_close_tx`: a
/// placeholder gas object satisfies `try_build`, then is cleared so the node charges gas from the
/// settler's address balance (the caller must sign AFTER this returns, since the signature covers
/// `gas_payment`). Unit-tested for arg order + empty gas.
#[allow(clippy::too_many_arguments)] // mirrors the offline-build parameter list of build_close_tx
fn build_admin_mint_tx(
    mtps_package: Address,
    sender: Address,
    admin_cap: &OwnedRef,
    recipient: Address,
    amount: u64,
    to_balance: bool,
    gas_price: u64,
    epoch: u64,
    chain: Digest,
    nonce: u32,
) -> anyhow::Result<Transaction> {
    let mut tb = TransactionBuilder::new();
    let cap_arg = tb.object(ObjectInput::owned(
        admin_cap.id,
        admin_cap.version,
        admin_cap.digest,
    ));
    let amount_arg = tb.pure(&amount);
    let recipient_arg = tb.pure(&recipient);
    let fn_name = if to_balance {
        "admin_mint_to_balance"
    } else {
        "admin_mint"
    };
    let func = Function::new(
        mtps_package,
        Identifier::new("mtps").context("module ident")?,
        Identifier::new(fn_name).context("fn ident")?,
    );
    tb.move_call(func, vec![cap_arg, amount_arg, recipient_arg]);

    // Placeholder satisfies try_build's non-empty-gas check; cleared below (see build_close_tx).
    tb.add_gas_objects([ObjectInput::owned(Address::ZERO, 1, Digest::ZERO)]);
    tb.set_sender(sender);
    tb.set_gas_budget(GAS_BUDGET);
    tb.set_gas_price(gas_price.max(1));
    // SIP-58 address-balance gas requires a `ValidDuring` window; nonce is the per-withdrawal replay
    // guard. min==max==current epoch; chain is the genesis digest (see build_close_tx).
    tb.set_expiration(TransactionExpiration::ValidDuring {
        min_epoch: Some(epoch),
        max_epoch: Some(epoch),
        min_timestamp: None,
        max_timestamp: None,
        chain,
        nonce,
    });
    let mut tx = tb
        .try_build()
        .map_err(|e| anyhow!("build admin_mint tx: {e}"))?;
    // Empty objects => FundsWithdrawal from the settler's address balance (SIP-58).
    tx.gas_payment.objects.clear();
    Ok(tx)
}

/// Wrap a client-built transaction KIND in SIP-58 sponsor gas: the user is the sender, the settler
/// owns the (empty, address-balance) gas, so the settler pays the user's gas from its own balance.
/// Validates the kind is an allowlisted open/fund PTB first — the anti-abuse gate (ADR-0009).
#[allow(clippy::too_many_arguments)] // mirrors build_close_tx's offline-build parameter list
fn build_sponsored_tx(
    package_id: Address,
    coin_type: &TypeTag,
    example_packages: &[ExampleModule],
    sender: Address,
    gas_owner: Address,
    kind_bytes: &[u8],
    gas_price: u64,
    epoch: u64,
    chain: Digest,
    nonce: u32,
) -> anyhow::Result<Transaction> {
    let kind: TransactionKind = bcs::from_bytes(kind_bytes).context("decode tx kind")?;
    let num_commands = match &kind {
        TransactionKind::ProgrammableTransaction(ptb) => {
            validate_sponsorable_inner(ptb, package_id, coin_type, example_packages)?;
            ptb.commands.len() as u64
        }
        _ => anyhow::bail!("only programmable transactions can be sponsored"),
    };
    // Scale the budget with PTB size (see SPONSOR_GAS_BUDGET_PER_COMMAND). saturating_mul guards an
    // implausibly large count; the floor keeps a degenerate 0-command PTB off a zero budget.
    let budget = SPONSOR_GAS_BUDGET_PER_COMMAND
        .saturating_mul(num_commands)
        .max(SPONSOR_GAS_BUDGET_PER_COMMAND);
    Ok(Transaction {
        kind,
        sender,
        gas_payment: GasPayment {
            // SIP-58: empty objects => the gas FundsWithdrawal is drawn from the gas OWNER (the
            // settler), NOT the sender — so the settler pays the user's gas from its own balance.
            objects: Vec::new(),
            owner: gas_owner,
            price: gas_price.max(1),
            budget,
        },
        // SIP-58 address-balance gas requires a ValidDuring window; nonce is the per-withdrawal
        // replay guard. min==max==current epoch; chain is the genesis digest (see build_close_tx).
        expiration: TransactionExpiration::ValidDuring {
            min_epoch: Some(epoch),
            max_epoch: Some(epoch),
            min_timestamp: None,
            max_timestamp: None,
            chain,
            nonce,
        },
    })
}

/// True if any argument of `cmd` is `Argument::Gas` — i.e. the command touches the gas coin.
/// In a sponsored tx the gas is the SETTLER's (SIP-58 address-balance), so a PTB that references
/// the gas coin could split/transfer the settler's own funds out. The stake must come only from
/// the user's input coins, never the gas. (Fixes the H1 settler-drain.)
fn command_references_gas(cmd: &Command) -> bool {
    let is_gas = |a: &Argument| matches!(a, Argument::Gas);
    match cmd {
        Command::MoveCall(mc) => mc.arguments.iter().any(is_gas),
        Command::SplitCoins(s) => is_gas(&s.coin) || s.amounts.iter().any(is_gas),
        Command::MergeCoins(m) => is_gas(&m.coin) || m.coins_to_merge.iter().any(is_gas),
        Command::TransferObjects(t) => is_gas(&t.address) || t.objects.iter().any(is_gas),
        Command::MakeMoveVector(v) => v.elements.iter().any(is_gas),
        // Publish/Upgrade carry no Argument; any future variant is rejected outright by
        // validate_sponsorable's catch-all, so it never needs a gas check here.
        _ => false,
    }
}

/// Validate + canonicalize a Sui address: trim, then re-render via the SDK to the 0x-prefixed,
/// lowercase, 32-byte-padded form. The faucet uses this to key the per-recipient cooldown and to
/// credit the mint; `Err` on a malformed address maps to 422 at the handler.
pub fn canonical_address(s: &str) -> anyhow::Result<String> {
    Ok(Address::from_str(s.trim())
        .context("invalid address")?
        .to_string())
}

/// The package address of a struct coin type (`0xABC::mtps::MTPS` -> `0xABC`), or `None`
/// for a primitive type like SUI. Used to locate the stake token's own faucet module.
fn coin_type_address(coin_type: &TypeTag) -> Option<Address> {
    match coin_type {
        TypeTag::Struct(s) => Some(*s.address()),
        _ => None,
    }
}

/// The anti-abuse gate (ADR-0009): the settler pays gas, so it sponsors ONLY the tunnel open/fund
/// move calls (+ the framework `public_share_object`) plus benign coin/object plumbing over the
/// user's OWN inputs. Three invariants make this safe rather than an open faucet:
///   1. No command may reference the gas coin (`Argument::Gas`) — else it could move the settler's
///      funds out (H1). The stake comes from the user's input coins only.
///   2. Every move call must be an allowlisted `tunnel::*` open/fund fn (or the framework share);
///      Publish/Upgrade and any other package/module/function are refused.
///   3. Tunnel calls must use the settler's configured coin type, not an arbitrary `T` (M1).
///
/// NOTE: this does NOT rate-limit or cap a global spend — a flood of valid sponsorships can still
/// burn the settler's balance via gas. Add per-sender rate limiting + a daily budget before prod.
///
/// Test-only 3-arg shim: validate with NO example-app packages (the default), so the large
/// tunnel/coin test suite keeps its existing call shape. Production goes through the inner.
#[cfg(test)]
fn validate_sponsorable(
    ptb: &ProgrammableTransaction,
    package_id: Address,
    coin_type: &TypeTag,
) -> anyhow::Result<()> {
    validate_sponsorable_inner(ptb, package_id, coin_type, &[])
}

/// As {@link validate_sponsorable}, plus the configured example-app packages whose allowlisted fns
/// are also sponsorable (over the configured coin type).
fn validate_sponsorable_inner(
    ptb: &ProgrammableTransaction,
    package_id: Address,
    coin_type: &TypeTag,
    example_packages: &[ExampleModule],
) -> anyhow::Result<()> {
    let framework = Address::from_str(SUI_FRAMEWORK_ADDRESS).expect("static 0x2 address");
    for cmd in &ptb.commands {
        anyhow::ensure!(
            !command_references_gas(cmd),
            "sponsor refuses a command that references the gas coin",
        );
        match cmd {
            Command::MoveCall(mc) => {
                let is_tunnel = mc.package == package_id && mc.module.as_str() == "tunnel";
                let tunnel_call = is_tunnel && SPONSOR_TUNNEL_FNS.contains(&mc.function.as_str());
                let framework_share = mc.package == framework
                    && mc.module.as_str() == "transfer"
                    && mc.function.as_str() == "public_share_object";
                // The stake faucet moved to the backend admin endpoint (ADR-0023 `admin_mint`), so
                // the permissionless `mint`/`mint_default` are no longer sponsored. Only `mint_nft`
                // (the regular-payments shop reward, in the coin type's own `<pkg>::mtps`) stays
                // sponsorable so the miner receives the collectible gaslessly.
                let mtps_package_call = coin_type_address(coin_type) == Some(mc.package)
                    && mc.module.as_str() == "mtps"
                    && mc.function.as_str() == "mint_nft";
                // SIP-58 stake path (ADR-0013): `redeem_funds` turns the sender's address-balance
                // withdrawal into the stake `Coin<T>` for the open; `send_funds` is the funding
                // sweep that deposits a faucet coin into the player's address balance;
                // `destroy_zero` consumes the zero remainder the open's stake split leaves behind
                // (a redeemed `Coin<T>` has no `drop`). All framework `0x2::coin` calls over the
                // configured `T` and the user's own funds.
                let coin_balance_op = mc.package == framework
                    && mc.module.as_str() == "coin"
                    && matches!(
                        mc.function.as_str(),
                        "redeem_funds" | "send_funds" | "destroy_zero"
                    );
                // Example-app calls (agent allowance, streaming payment, …) in their own packages.
                // Funds come from the user's input coins, so the settler only pays gas. Empty
                // `example_packages` (none configured) matches nothing.
                let example_call = example_packages.iter().any(|(pkg, module, fns)| {
                    mc.package == *pkg
                        && mc.module.as_str() == *module
                        && fns.contains(&mc.function.as_str())
                });
                anyhow::ensure!(
                    tunnel_call
                        || framework_share
                        || mtps_package_call
                        || coin_balance_op
                        || example_call,
                    "sponsor refuses move call {}::{}::{}",
                    mc.package,
                    mc.module.as_str(),
                    mc.function.as_str(),
                );
                // The tunnel fns, coin balance ops, and example-app calls are generic over the coin
                // `T`; only sponsor the configured type. (The framework share's type arg is a
                // different shape — skip it.)
                if tunnel_call || coin_balance_op || example_call {
                    anyhow::ensure!(
                        mc.type_arguments.as_slice() == std::slice::from_ref(coin_type),
                        "sponsor refuses move call with an unexpected coin type",
                    );
                }
            }
            // A sponsor must never pay to publish or upgrade code.
            Command::Publish(_) | Command::Upgrade(_) => {
                anyhow::bail!("sponsor refuses publish/upgrade commands");
            }
            // SplitCoins / MergeCoins / TransferObjects / MakeMoveVector are allowed ONLY because
            // the gas-coin guard above already rejected any that touch the settler's gas; what
            // remains operates on the user's own input coins/objects.
            Command::SplitCoins(_)
            | Command::MergeCoins(_)
            | Command::TransferObjects(_)
            | Command::MakeMoveVector(_) => {}
            // `Command` is non-exhaustive; refuse anything we don't explicitly understand rather
            // than pay gas for an unknown command shape.
            _ => anyhow::bail!("sponsor refuses an unrecognized command"),
        }
    }
    // SIP-58 (ADR-0013): a sponsored PTB may withdraw from an address balance to fund its stake,
    // but ONLY the SENDER's own balance. `WithdrawFrom::Sponsor` would draw from the gas OWNER —
    // the settler — draining its balance: the address-balance analogue of the `Argument::Gas`
    // guard above. Refuse any non-sender withdrawal, and only for the configured stake coin type.
    for input in &ptb.inputs {
        if let Input::FundsWithdrawal(w) = input {
            anyhow::ensure!(
                w.source() == WithdrawFrom::Sender,
                "sponsor refuses a FundsWithdrawal that is not from the sender",
            );
            anyhow::ensure!(
                w.coin_type() == coin_type,
                "sponsor refuses a FundsWithdrawal of an unexpected coin type",
            );
        }
    }
    Ok(())
}

/// Decode a sponsorable tx KIND (raw bytes), run the SAME allowlist as the settler path
/// (`validate_sponsorable_inner`), and collect its move-call targets `pkg::module::fn`,
/// de-duplicated, first-seen order. Used by `SuiSettler::validate_kind` to gate BOTH providers and
/// to feed Enoki's `allowedMoveCallTargets`. Reusing `validate_sponsorable_inner` keeps the single
/// source of truth for what is sponsorable — the Enoki path can never sponsor more than the settler.
fn validate_kind_inner(
    kind_bytes: &[u8],
    package_id: Address,
    coin_type: &TypeTag,
    example_packages: &[ExampleModule],
) -> anyhow::Result<Vec<String>> {
    let kind: TransactionKind = bcs::from_bytes(kind_bytes).context("decode tx kind")?;
    let ptb = match &kind {
        TransactionKind::ProgrammableTransaction(ptb) => ptb,
        _ => anyhow::bail!("only programmable transactions can be sponsored"),
    };
    validate_sponsorable_inner(ptb, package_id, coin_type, example_packages)?;
    let mut targets: Vec<String> = Vec::new();
    for cmd in &ptb.commands {
        if let Command::MoveCall(mc) = cmd {
            let target = format!(
                "{}::{}::{}",
                mc.package,
                mc.module.as_str(),
                mc.function.as_str()
            );
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
    }
    Ok(targets)
}

/// Test-only shim: extract targets with NO example packages configured (mirrors the
/// `validate_sponsorable` shim shape), so existing PTB fixtures drive these tests unchanged.
#[cfg(test)]
fn validate_kind_targets(
    kind_bytes: &[u8],
    package_id: Address,
    coin_type: &TypeTag,
) -> anyhow::Result<Vec<String>> {
    validate_kind_inner(kind_bytes, package_id, coin_type, &[])
}

/// Decode the settler's ed25519 secret: 32 raw bytes, or 33 with the Sui ed25519 flag
/// (`0x00`) prefix, base64-encoded.
pub(crate) fn load_ed25519(b64: &str) -> anyhow::Result<Ed25519PrivateKey> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .context("SUI_SETTLER_KEY is not valid base64")?;
    let key: [u8; 32] = match raw.len() {
        32 => raw.try_into().unwrap(),
        33 if raw[0] == 0x00 => raw[1..].try_into().unwrap(),
        n => {
            return Err(anyhow!(
                "ed25519 secret must be 32 bytes (or 33 with flag), got {n}"
            ))
        }
    };
    Ok(Ed25519PrivateKey::new(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A dry-run that succeeds means the close WILL land — proceed to execute.
    #[test]
    fn dryrun_ok_on_success_effects() {
        let r = serde_json::json!({ "effects": { "status": { "status": "success" } } });
        assert!(dryrun_effects_ok(&r).is_ok());
    }

    // A dry-run failure (e.g. a bad seat signature the Move rejects) must error so the settler
    // refuses to sponsor gas — the error carries the on-chain status for the client log.
    #[test]
    fn dryrun_err_on_failure_effects() {
        let r = serde_json::json!({
            "effects": { "status": { "status": "failure", "error": "InvalidSignature" } }
        });
        let e = dryrun_effects_ok(&r).unwrap_err();
        assert!(
            e.contains("failure") || e.contains("InvalidSignature"),
            "got: {e}"
        );
    }

    // A malformed result with no effects is treated as a failure, never a silent pass.
    #[test]
    fn dryrun_err_when_effects_missing() {
        let r = serde_json::json!({ "nope": true });
        assert!(dryrun_effects_ok(&r).is_err());
    }

    fn args_with_root(len: usize) -> CloseArgs {
        CloseArgs {
            tunnel_id: "0x1".into(),
            party_a_balance: 1500,
            party_b_balance: 500,
            sig_a: vec![1u8; 64],
            sig_b: vec![2u8; 64],
            timestamp: 1_750_000_000_000,
            transcript_root: vec![0u8; len],
        }
    }

    fn close_and_ref(addr: &str) -> (CloseArgs, SharedRef) {
        let mut c = args_with_root(32);
        c.tunnel_id = addr.to_string();
        (
            c,
            SharedRef {
                id: Address::from_str(addr).unwrap(),
                initial_shared_version: 3,
            },
        )
    }

    // The batch PTB carries exactly one `close_cooperative_with_root` call per settlement (the
    // fleet-scale lever: K closes in one tx) and scales the gas budget with K — pinned against the
    // Move arg order via a successful build.
    #[test]
    fn build_close_batch_tx_one_move_call_per_close_and_scales_gas() {
        let (ca, ra) = close_and_ref("0x11");
        let (cb, rb) = close_and_ref("0x22");
        let (cc, rc) = close_and_ref("0x33");
        let tx = build_close_batch_tx(
            Address::from_str("0xabc").unwrap(),
            &"0x2::sui::SUI".parse().unwrap(),
            Address::from_str("0x9").unwrap(),
            &[ca, cb, cc],
            &[ra, rb, rc],
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            7,
        )
        .expect("batch builds");
        let move_calls = match &tx.kind {
            TransactionKind::ProgrammableTransaction(ptb) => ptb
                .commands
                .iter()
                .filter(|c| matches!(c, Command::MoveCall(_)))
                .count(),
            _ => 0,
        };
        assert_eq!(move_calls, 3, "one close call per settlement");
        assert!(
            tx.gas_payment.objects.is_empty(),
            "SIP-58 address-balance gas"
        );
        assert_eq!(
            tx.gas_payment.budget,
            GAS_BUDGET * 3,
            "gas budget scales with batch size"
        );
    }

    // A closes/refs length mismatch is a programmer error, caught before build, never a malformed tx.
    #[test]
    fn build_close_batch_tx_rejects_len_mismatch() {
        let (ca, ra) = close_and_ref("0x11");
        let (_cb, rb) = close_and_ref("0x22");
        let err = build_close_batch_tx(
            Address::ZERO,
            &"0x2::sui::SUI".parse().unwrap(),
            Address::ZERO,
            &[ca],
            &[ra, rb],
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            1,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("length mismatch"), "got: {err}");
    }

    fn admin_cap_ref() -> OwnedRef {
        OwnedRef {
            id: Address::from_str("0x5").unwrap(),
            version: 7,
            digest: Digest::ZERO,
        }
    }

    // The admin_mint PTB must build with the Move arg order (cap, amount, recipient) and no type
    // argument — pins the faucet write-path wiring against `mtps::admin_mint`.
    #[test]
    fn build_admin_mint_tx_builds_for_valid_args() {
        let tx = build_admin_mint_tx(
            Address::from_str("0xabc").unwrap(),
            Address::ZERO,
            &admin_cap_ref(),
            Address::from_str("0x9").unwrap(),
            10_000,
            true, // admin_mint_to_balance path
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            0,
        );
        assert!(tx.is_ok(), "valid mint should build: {:?}", tx.err());
    }

    // Address-balance gas (SIP-58): the built mint tx carries an EMPTY gas payment owned by the
    // settler — gas is charged from the settler's SUI balance, no owned gas coin to lock.
    #[test]
    fn build_admin_mint_tx_uses_address_balance_gas() {
        let settler = Address::from_str("0x9").unwrap();
        let tx = build_admin_mint_tx(
            Address::from_str("0xabc").unwrap(),
            settler,
            &admin_cap_ref(),
            Address::from_str("0x1").unwrap(),
            10_000,
            false, // admin_mint (owned coin) path
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            0,
        )
        .expect("builds");
        assert!(
            tx.gas_payment.objects.is_empty(),
            "gas payment must be empty (address-balance)"
        );
        assert_eq!(tx.gas_payment.owner, settler);
        assert_eq!(tx.gas_payment.budget, GAS_BUDGET);
    }

    fn sui_coin() -> TypeTag {
        "0x2::sui::SUI".parse().unwrap()
    }

    fn tunnel_call(package: Address, function: &str) -> Command {
        Command::MoveCall(sui_sdk_types::MoveCall {
            package,
            module: Identifier::new("tunnel").unwrap(),
            function: Identifier::new(function).unwrap(),
            // The tunnel fns are generic over the coin T; the validator pins it to the configured type.
            type_arguments: vec![sui_coin()],
            arguments: vec![],
        })
    }

    fn ptb(commands: Vec<Command>) -> ProgrammableTransaction {
        ProgrammableTransaction {
            inputs: vec![],
            commands,
        }
    }

    // The happy path: the seat-A open PTB (create + deposit_party_a + framework share) is exactly
    // what the sponsor pays gas for.
    #[test]
    fn validate_accepts_allowlisted_open_fund_ptb() {
        let pkg = Address::from_str("0xabc").unwrap();
        let p = ptb(vec![
            tunnel_call(pkg, "create"),
            tunnel_call(pkg, "deposit_party_a"),
            Command::MoveCall(sui_sdk_types::MoveCall {
                package: Address::from_str(SUI_FRAMEWORK_ADDRESS).unwrap(),
                module: Identifier::new("transfer").unwrap(),
                function: Identifier::new("public_share_object").unwrap(),
                type_arguments: vec![],
                arguments: vec![],
            }),
        ]);
        assert!(validate_sponsorable(&p, pkg, &sui_coin()).is_ok());
    }

    // A call into a DIFFERENT package must never be sponsored — this is the anti-abuse core.
    #[test]
    fn validate_rejects_foreign_package_call() {
        let pkg = Address::from_str("0xabc").unwrap();
        let evil = Command::MoveCall(sui_sdk_types::MoveCall {
            package: Address::from_str("0xdead").unwrap(),
            module: Identifier::new("rug").unwrap(),
            function: Identifier::new("drain").unwrap(),
            type_arguments: vec![],
            arguments: vec![],
        });
        assert!(validate_sponsorable(&ptb(vec![evil]), pkg, &sui_coin()).is_err());
    }

    // A tunnel fn outside the open/fund allowlist (e.g. a close/dispute) is refused: the sponsor
    // pays for opening a channel, not for arbitrary tunnel operations.
    #[test]
    fn validate_rejects_non_allowlisted_tunnel_fn() {
        let pkg = Address::from_str("0xabc").unwrap();
        assert!(validate_sponsorable(
            &ptb(vec![tunnel_call(pkg, "force_close")]),
            pkg,
            &sui_coin()
        )
        .is_err());
    }

    // H1 (settler-drain): a PTB that references the GAS coin — even via an otherwise-benign
    // SplitCoins/TransferObjects, with NO disallowed move call — must be refused. In a sponsored
    // tx the gas is the settler's, so touching it could move the settler's funds out.
    #[test]
    fn validate_rejects_any_command_touching_gas() {
        let pkg = Address::from_str("0xabc").unwrap();
        // Split the (settler's) gas coin — no move call at all; the variant-only check would miss it.
        let split_gas = Command::SplitCoins(sui_sdk_types::SplitCoins {
            coin: Argument::Gas,
            amounts: vec![Argument::Input(0)],
        });
        assert!(validate_sponsorable(&ptb(vec![split_gas]), pkg, &sui_coin()).is_err());
        // Transfer the gas coin straight out.
        let xfer_gas = Command::TransferObjects(sui_sdk_types::TransferObjects {
            objects: vec![Argument::Gas],
            address: Argument::Input(0),
        });
        assert!(validate_sponsorable(&ptb(vec![xfer_gas]), pkg, &sui_coin()).is_err());
        // Feed the gas coin into an allowlisted tunnel call as a funding coin.
        let fund_from_gas = Command::MoveCall(sui_sdk_types::MoveCall {
            package: pkg,
            module: Identifier::new("tunnel").unwrap(),
            function: Identifier::new("create_and_fund").unwrap(),
            type_arguments: vec![sui_coin()],
            arguments: vec![Argument::Gas],
        });
        assert!(validate_sponsorable(&ptb(vec![fund_from_gas]), pkg, &sui_coin()).is_err());
    }

    // M1: an allowlisted tunnel call for a DIFFERENT coin type than the settler's configured one
    // is refused — the settler only sponsors gas for its own coin's tunnels.
    #[test]
    fn validate_rejects_wrong_coin_type() {
        let pkg = Address::from_str("0xabc").unwrap();
        let other = Command::MoveCall(sui_sdk_types::MoveCall {
            package: pkg,
            module: Identifier::new("tunnel").unwrap(),
            function: Identifier::new("create").unwrap(),
            type_arguments: vec!["0xabc::usdc::USDC".parse().unwrap()],
            arguments: vec![],
        });
        assert!(validate_sponsorable(&ptb(vec![other]), pkg, &sui_coin()).is_err());
    }

    // The micro-payments shop reward path: `mint_nft` in the MTPS package is sponsorable so
    // the miner receives the collectible gaslessly (emits `NftMinted` on-chain).
    #[test]
    fn validate_accepts_mtps_mint_nft() {
        let coin: TypeTag = "0xabc::mtps::MTPS".parse().unwrap();
        let mint_nft = Command::MoveCall(sui_sdk_types::MoveCall {
            package: Address::from_str("0xabc").unwrap(),
            module: Identifier::new("mtps").unwrap(),
            function: Identifier::new("mint_nft").unwrap(),
            type_arguments: vec![],
            arguments: vec![Argument::Input(0), Argument::Input(1), Argument::Input(2)],
        });
        let tunnel_pkg = Address::from_str("0xfff").unwrap();
        assert!(validate_sponsorable(&ptb(vec![mint_nft]), tunnel_pkg, &coin).is_ok());
    }

    // The permissionless `mtps::mint` faucet is no longer sponsorable — minting moved fully behind
    // the backend `admin_mint` endpoint (ADR-0023). Even from the real coin package it is refused.
    #[test]
    fn validate_refuses_mtps_mint_now_admin_only() {
        let coin: TypeTag = "0xabc::mtps::MTPS".parse().unwrap();
        let mint = Command::MoveCall(sui_sdk_types::MoveCall {
            package: Address::from_str("0xabc").unwrap(),
            module: Identifier::new("mtps").unwrap(),
            function: Identifier::new("mint").unwrap(),
            type_arguments: vec![],
            arguments: vec![Argument::Input(0), Argument::Input(1), Argument::Input(2)],
        });
        let tunnel_pkg = Address::from_str("0xfff").unwrap();
        assert!(validate_sponsorable(&ptb(vec![mint]), tunnel_pkg, &coin).is_err());
    }

    fn coin_op(function: &str, coin: TypeTag) -> Command {
        Command::MoveCall(sui_sdk_types::MoveCall {
            package: Address::from_str(SUI_FRAMEWORK_ADDRESS).unwrap(),
            module: Identifier::new("coin").unwrap(),
            function: Identifier::new(function).unwrap(),
            type_arguments: vec![coin],
            arguments: vec![],
        })
    }

    fn withdrawal(coin: TypeTag, source: WithdrawFrom) -> Input {
        Input::FundsWithdrawal(sui_sdk_types::FundsWithdrawal::new(100, coin, source))
    }

    fn ptb_in(inputs: Vec<Input>, commands: Vec<Command>) -> ProgrammableTransaction {
        ProgrammableTransaction { inputs, commands }
    }

    // ADR-0013: the stake is redeemed from the SENDER's address balance — a `coin::redeem_funds<T>`
    // over a sender withdrawal of the configured coin is sponsorable.
    #[test]
    fn validate_accepts_sender_stake_withdrawal() {
        let coin: TypeTag = "0xabc::mtps::MTPS".parse().unwrap();
        let pkg = Address::from_str("0xfff").unwrap();
        let p = ptb_in(
            vec![withdrawal(coin.clone(), WithdrawFrom::Sender)],
            vec![coin_op("redeem_funds", coin.clone())],
        );
        assert!(validate_sponsorable(&p, pkg, &coin).is_ok());
    }

    // Settler-drain (H1, address-balance form): a withdrawal whose source is the SPONSOR (gas owner
    // = settler) must be refused — a sponsored PTB may withdraw only the user's OWN funds.
    #[test]
    fn validate_rejects_sponsor_withdrawal_settler_drain() {
        let coin: TypeTag = "0xabc::mtps::MTPS".parse().unwrap();
        let pkg = Address::from_str("0xfff").unwrap();
        let p = ptb_in(
            vec![withdrawal(coin.clone(), WithdrawFrom::Sponsor)],
            vec![coin_op("redeem_funds", coin.clone())],
        );
        assert!(validate_sponsorable(&p, pkg, &coin).is_err());
    }

    // M1 (for withdrawals): a sender withdrawal of a coin type other than the settler's configured
    // one is refused.
    #[test]
    fn validate_rejects_withdrawal_wrong_coin_type() {
        let coin: TypeTag = "0xabc::mtps::MTPS".parse().unwrap();
        let other: TypeTag = "0x2::sui::SUI".parse().unwrap();
        let pkg = Address::from_str("0xfff").unwrap();
        let p = ptb_in(vec![withdrawal(other, WithdrawFrom::Sender)], vec![]);
        assert!(validate_sponsorable(&p, pkg, &coin).is_err());
    }

    // The funding sweep `coin::send_funds<T>` and the stake-remainder `coin::destroy_zero<T>` are
    // sponsorable for the configured coin; a wrong type arg is refused (M1).
    #[test]
    fn validate_coin_ops_pin_coin_type() {
        let coin: TypeTag = "0xabc::mtps::MTPS".parse().unwrap();
        let pkg = Address::from_str("0xfff").unwrap();
        for op in ["send_funds", "destroy_zero"] {
            assert!(
                validate_sponsorable(&ptb(vec![coin_op(op, coin.clone())]), pkg, &coin).is_ok(),
                "{op} for the configured coin is sponsorable",
            );
        }
        let wrong: TypeTag = "0x2::sui::SUI".parse().unwrap();
        assert!(
            validate_sponsorable(&ptb(vec![coin_op("destroy_zero", wrong)]), pkg, &coin).is_err()
        );
    }

    // Example-app calls are sponsorable only when the settler is configured with that package AND
    // the call targets the configured coin type — same safety envelope as tunnel calls.
    #[test]
    fn validate_example_app_calls() {
        let coin: TypeTag = "0xabc::mtps::MTPS".parse().unwrap();
        let tunnel_pkg = Address::from_str("0xabc").unwrap();
        let agent_pkg = Address::from_str("0xa9e").unwrap();
        let stream_pkg = Address::from_str("0x57ea").unwrap();
        let agent_mods: Vec<ExampleModule> = vec![(
            agent_pkg,
            "example_agent_allowance",
            SPONSOR_AGENT_ALLOWANCE_FNS,
        )];
        let stream_mods: Vec<ExampleModule> = vec![(
            stream_pkg,
            "streaming_payment",
            SPONSOR_STREAMING_PAYMENT_FNS,
        )];
        let call = |package: Address, module: &str, function: &str, type_args: Vec<TypeTag>| {
            Command::MoveCall(sui_sdk_types::MoveCall {
                package,
                module: Identifier::new(module).unwrap(),
                function: Identifier::new(function).unwrap(),
                type_arguments: type_args,
                arguments: vec![],
            })
        };
        let check = |cmd: Command, mods: &[ExampleModule]| {
            validate_sponsorable_inner(&ptb(vec![cmd]), tunnel_pkg, &coin, mods)
        };
        let agent = |f: &str, ta: Vec<TypeTag>| call(agent_pkg, "example_agent_allowance", f, ta);

        // Agent allowance create + claim accepted with the package configured.
        assert!(check(
            agent("entry_create_and_share", vec![coin.clone()]),
            &agent_mods
        )
        .is_ok());
        assert!(check(agent("entry_claim", vec![coin.clone()]), &agent_mods).is_ok());
        // No configured example packages => refused.
        assert!(check(agent("entry_claim", vec![coin.clone()]), &[]).is_err());
        // A non-allowlisted fn is refused.
        assert!(check(
            agent("destroy_for_testing", vec![coin.clone()]),
            &agent_mods
        )
        .is_err());
        // Wrong coin type is refused.
        let usdc: TypeTag = "0xabc::usdc::USDC".parse().unwrap();
        assert!(check(agent("entry_claim", vec![usdc]), &agent_mods).is_err());
        // A different package with the same module name is refused.
        let other = Address::from_str("0xbad").unwrap();
        assert!(check(
            call(
                other,
                "example_agent_allowance",
                "entry_claim",
                vec![coin.clone()]
            ),
            &agent_mods
        )
        .is_err());
        // Streaming create_stream accepted only under the streaming config.
        assert!(check(
            call(
                stream_pkg,
                "streaming_payment",
                "create_stream",
                vec![coin.clone()]
            ),
            &stream_mods
        )
        .is_ok());
        assert!(check(
            call(
                stream_pkg,
                "streaming_payment",
                "create_stream",
                vec![coin.clone()]
            ),
            &agent_mods
        )
        .is_err());
    }

    // The end-to-end wrap: a valid kind yields a sponsored tx where the USER is the sender and the
    // SETTLER owns the empty (SIP-58 address-balance) gas — i.e. the settler pays the user's gas.
    #[test]
    fn build_sponsored_tx_makes_user_sender_settler_gas() {
        let pkg = Address::from_str("0xabc").unwrap();
        let user = Address::from_str("0x111").unwrap();
        let settler = Address::from_str("0x222").unwrap();
        let kind = TransactionKind::ProgrammableTransaction(ptb(vec![tunnel_call(pkg, "create")]));
        let kind_bytes = bcs::to_bytes(&kind).unwrap();
        let tx = build_sponsored_tx(
            pkg,
            &sui_coin(),
            &[],
            user,
            settler,
            &kind_bytes,
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            7,
        )
        .expect("valid open/fund kind builds");
        assert_eq!(tx.sender, user, "user is the sender");
        assert_eq!(tx.gas_payment.owner, settler, "settler owns + pays gas");
        assert!(
            tx.gas_payment.objects.is_empty(),
            "SIP-58 address-balance gas (empty objects)"
        );
        // One command => one unit of the per-command budget.
        assert_eq!(tx.gas_payment.budget, SPONSOR_GAS_BUDGET_PER_COMMAND);
    }

    // The REAL arena seat-B open kind (create + redeem_funds + deposit_party_b + share) is a valid
    // sponsorable open/fund: the settler can own its gas so the bot holds zero SUI (ADR-0028). This is
    // the cross-module contract the zero-SUI fleet depends on — if the open kind drifts off the
    // sponsor allowlist (a renamed fn, or a stake withdrawal that isn't `WithdrawFrom::Sender`), the
    // wrap errs here, before anything reaches the chain. Built here, next to the validator it exercises.
    #[test]
    fn arena_open_kind_is_sponsorable_with_bot_sender_settler_gas() {
        use crate::fleet::arena_opener::build_arena_open_kind;
        let pkg = Address::from_str("0xabc").unwrap();
        let coin: TypeTag = "0xabc::mtps::MTPS".parse().unwrap();
        let bot = Address::from_str("0xb0b").unwrap();
        let settler = Address::from_str("0x5e7").unwrap();
        let kind = build_arena_open_kind(
            pkg,
            coin.clone(),
            Address::from_str("0x11").unwrap(),
            vec![0xaa; 32],
            bot,
            vec![0xbb; 32],
            1000,
        )
        .unwrap();
        let kind_bytes = bcs::to_bytes(&kind).unwrap();
        let tx = build_sponsored_tx(
            pkg,
            &coin,
            &[],
            bot,
            settler,
            &kind_bytes,
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            0,
        )
        .expect("arena open kind passes the sponsor allowlist (sender-sourced stake, allowlisted calls)");
        assert_eq!(tx.sender, bot, "bot is the sender — its MTPS funds seat B");
        assert_eq!(
            tx.gas_payment.owner, settler,
            "settler owns + pays the SIP-58 gas (bot needs no SUI)"
        );
        assert!(
            tx.gas_payment.objects.is_empty(),
            "SIP-58 address-balance gas (empty objects)"
        );
        assert_eq!(
            tx.gas_payment.budget,
            4 * SPONSOR_GAS_BUDGET_PER_COMMAND,
            "4-command open scales the gas budget"
        );
    }

    // A BATCHED open (N games in one PTB) must clear the same sponsor allowlist as the single open:
    // N repetitions of the allowlisted calls + N sender-sourced `redeem_funds` withdrawals, all under
    // one shared party-B sender. The gas budget must scale to the whole PTB (4 commands × N games),
    // not the single-open's 4 — else a batch under-funds and reverts on-chain.
    #[test]
    fn arena_batch_open_kind_is_sponsorable_and_scales_budget_by_game_count() {
        use crate::fleet::arena_opener::build_arena_open_kind_many;
        let pkg = Address::from_str("0xabc").unwrap();
        let coin: TypeTag = "0xabc::mtps::MTPS".parse().unwrap();
        let bot = Address::from_str("0xb0b").unwrap();
        let settler = Address::from_str("0x5e7").unwrap();
        let games = vec![
            (
                Address::from_str("0x11").unwrap(),
                vec![0xa1; 32],
                vec![0xb1; 32],
                1000u64,
            ),
            (
                Address::from_str("0x22").unwrap(),
                vec![0xa2; 32],
                vec![0xb2; 32],
                2000u64,
            ),
            (
                Address::from_str("0x33").unwrap(),
                vec![0xa3; 32],
                vec![0xb3; 32],
                3000u64,
            ),
        ];
        let kind = build_arena_open_kind_many(pkg, coin.clone(), bot, &games).unwrap();
        let kind_bytes = bcs::to_bytes(&kind).unwrap();
        let tx = build_sponsored_tx(
            pkg,
            &coin,
            &[],
            bot,
            settler,
            &kind_bytes,
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            0,
        )
        .expect("batched arena open passes the sponsor allowlist (all calls allowlisted, sender-sourced stake)");
        assert_eq!(tx.sender, bot, "one shared party-B sender for the batch");
        assert_eq!(tx.gas_payment.owner, settler, "settler still pays the gas");
        assert!(
            tx.gas_payment.objects.is_empty(),
            "SIP-58 address-balance gas"
        );
        assert_eq!(
            tx.gas_payment.budget,
            4 * 3 * SPONSOR_GAS_BUDGET_PER_COMMAND,
            "budget scales to 4 commands × 3 games, not a single open's 4"
        );
    }

    // A batched open packs many commands into one PTB; the gas budget must scale with the command
    // count so the dry-run doesn't reject the batch as under-funded — the bug a flat budget caused.
    #[test]
    fn build_sponsored_tx_scales_budget_by_command_count() {
        let pkg = Address::from_str("0xabc").unwrap();
        let framework = Address::from_str(SUI_FRAMEWORK_ADDRESS).unwrap();
        // create + deposit_party_a + framework public_share_object = 3 sponsorable commands.
        let kind = TransactionKind::ProgrammableTransaction(ptb(vec![
            tunnel_call(pkg, "create"),
            tunnel_call(pkg, "deposit_party_a"),
            Command::MoveCall(sui_sdk_types::MoveCall {
                package: framework,
                module: Identifier::new("transfer").unwrap(),
                function: Identifier::new("public_share_object").unwrap(),
                type_arguments: vec![],
                arguments: vec![],
            }),
        ]));
        let kind_bytes = bcs::to_bytes(&kind).unwrap();
        let tx = build_sponsored_tx(
            pkg,
            &sui_coin(),
            &[],
            Address::from_str("0x111").unwrap(),
            Address::from_str("0x222").unwrap(),
            &kind_bytes,
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            7,
        )
        .expect("valid 3-command open/fund kind builds");
        assert_eq!(
            tx.gas_payment.budget,
            3 * SPONSOR_GAS_BUDGET_PER_COMMAND,
            "budget scales with PTB command count"
        );
    }

    // The wrap refuses a kind whose move call is not allowlisted, before any gas is signed for.
    #[test]
    fn build_sponsored_tx_rejects_non_allowlisted_kind() {
        let pkg = Address::from_str("0xabc").unwrap();
        let kind = TransactionKind::ProgrammableTransaction(ptb(vec![Command::MoveCall(
            sui_sdk_types::MoveCall {
                package: Address::from_str("0xbad").unwrap(),
                module: Identifier::new("x").unwrap(),
                function: Identifier::new("y").unwrap(),
                type_arguments: vec![],
                arguments: vec![],
            },
        )]));
        let kind_bytes = bcs::to_bytes(&kind).unwrap();
        let err = build_sponsored_tx(
            pkg,
            &sui_coin(),
            &[],
            Address::ZERO,
            Address::ZERO,
            &kind_bytes,
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            0,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("refuses"), "got: {err}");
    }

    // validate_kind extracts the de-duplicated move-call targets from a valid open/fund KIND, in the
    // `pkg::module::fn` form Enoki's allowedMoveCallTargets wants (ADR-0014). The duplicate `create`
    // proves de-duplication; the framework share proves cross-package targets are included.
    #[test]
    fn validate_kind_extracts_dedup_targets() {
        let pkg = Address::from_str("0xabc").unwrap();
        let framework = Address::from_str(SUI_FRAMEWORK_ADDRESS).unwrap();
        let share = Command::MoveCall(sui_sdk_types::MoveCall {
            package: framework,
            module: Identifier::new("transfer").unwrap(),
            function: Identifier::new("public_share_object").unwrap(),
            type_arguments: vec![],
            arguments: vec![],
        });
        let kind = TransactionKind::ProgrammableTransaction(ptb(vec![
            tunnel_call(pkg, "create"),
            tunnel_call(pkg, "deposit_party_a"),
            tunnel_call(pkg, "create"), // duplicate — must collapse to one target
            share,
        ]));
        let bytes = bcs::to_bytes(&kind).unwrap();
        let targets = validate_kind_targets(&bytes, pkg, &sui_coin()).unwrap();
        assert_eq!(
            targets,
            vec![
                format!("{pkg}::tunnel::create"),
                format!("{pkg}::tunnel::deposit_party_a"),
                format!("{framework}::transfer::public_share_object"),
            ]
        );
    }

    // A KIND that fails the allowlist (foreign package) returns Err — targets are never produced for
    // an unsponsorable tx, so neither provider can be asked to pay for it.
    #[test]
    fn validate_kind_rejects_unsponsorable() {
        let pkg = Address::from_str("0xabc").unwrap();
        let evil = Command::MoveCall(sui_sdk_types::MoveCall {
            package: Address::from_str("0xdead").unwrap(),
            module: Identifier::new("rug").unwrap(),
            function: Identifier::new("drain").unwrap(),
            type_arguments: vec![],
            arguments: vec![],
        });
        let kind = TransactionKind::ProgrammableTransaction(ptb(vec![evil]));
        let bytes = bcs::to_bytes(&kind).unwrap();
        assert!(validate_kind_targets(&bytes, pkg, &sui_coin()).is_err());
    }

    // Bytes that are not a decodable tx KIND are rejected at decode, never sponsored.
    #[test]
    fn validate_kind_rejects_undecodable_bytes() {
        let pkg = Address::from_str("0xabc").unwrap();
        assert!(validate_kind_targets(&[0xff, 0xff, 0xff], pkg, &sui_coin()).is_err());
    }

    // The indexer must lift payout + transcript root + tx digest out of a real suix_queryEvents
    // row, not just the tunnel id. Pins parsedJson field paths (u64 as string; vector<u8> as bytes).
    #[test]
    fn parses_closed_with_root_event_into_raw() {
        let row = serde_json::json!({
            "id": { "txDigest": "9xDigest", "eventSeq": "0" },
            "type": "0xPKG::tunnel::TunnelClosedWithRoot",
            "parsedJson": {
                "tunnel_id": "0xfeed",
                "party_a_balance": "1500",
                "party_b_balance": "500",
                "final_nonce": "7",
                "transcript_root": [222, 173, 190, 239],
                "closed_at": "1750000000000"
            },
            "timestampMs": "1750000000123"
        });
        let raw = parse_event_row(&row).expect("a lifecycle event parses");
        assert_eq!(raw.type_suffix, "TunnelClosedWithRoot");
        assert_eq!(raw.tunnel_id, "0xfeed");
        assert_eq!(raw.party_a_balance, Some(1500));
        assert_eq!(raw.party_b_balance, Some(500));
        assert_eq!(raw.transcript_root.as_deref(), Some("deadbeef"));
        assert_eq!(raw.tx_digest, "9xDigest");
        assert_eq!(raw.timestamp_ms, 1_750_000_000_123);
    }

    #[test]
    fn skips_non_tunnel_event_rows() {
        let row = serde_json::json!({ "id": { "txDigest": "x" }, "type": "0x::other::Thing" });
        assert!(parse_event_row(&row).is_none());
    }

    // A close maps to a `settled` row carrying payout + root; an activation maps to `opened`;
    // anything else (created / deposit) is not a displayable row.
    #[test]
    fn maps_raw_events_to_displayable_rows() {
        use crate::state::TunnelEventKind;
        let mut closed = RawTunnelEvent {
            type_suffix: "TunnelClosedWithRoot".into(),
            tunnel_id: "0xt".into(),
            party_a: None,
            party_b: None,
            sender: None,
            party_a_balance: Some(1500),
            party_b_balance: Some(500),
            transcript_root: Some("deadbeef".into()),
            tx_digest: "d1".into(),
            timestamp_ms: 9,
        };
        let row = enrich_event_row(&closed, None, None).expect("close is displayable");
        assert_eq!(row.kind, TunnelEventKind::Settled);
        assert_eq!(row.party_a_balance, Some(1500));
        assert_eq!(row.transcript_root.as_deref(), Some("deadbeef"));

        closed.type_suffix = "TunnelActivated".into();
        assert_eq!(
            enrich_event_row(&closed, None, None)
                .expect("activation")
                .kind,
            TunnelEventKind::Opened
        );

        closed.type_suffix = "TunnelCreated".into();
        assert!(
            enrich_event_row(&closed, None, None).is_none(),
            "created is not a row"
        );
    }

    #[test]
    fn parse_event_row_extracts_parties_and_sender_from_created() {
        let ev = serde_json::json!({
            "id": { "txDigest": "DIG1" },
            "type": "0xpkg::tunnel::TunnelCreated",
            "sender": "0xfunder",
            "timestampMs": "1750000000000",
            "parsedJson": { "tunnel_id": "0xt", "party_a": "0xaaa", "party_b": "0xbbb" }
        });
        let raw = parse_event_row(&ev).expect("created row parses");
        assert_eq!(raw.party_a.as_deref(), Some("0xaaa"));
        assert_eq!(raw.party_b.as_deref(), Some("0xbbb"));
        assert_eq!(raw.sender.as_deref(), Some("0xfunder"));
    }

    #[test]
    fn parse_event_row_has_no_parties_on_close() {
        let ev = serde_json::json!({
            "id": { "txDigest": "DIG2" },
            "type": "0xpkg::tunnel::TunnelClosed",
            "sender": "0xsomeone",
            "timestampMs": "1",
            "parsedJson": { "tunnel_id": "0xt", "party_a_balance": "5", "party_b_balance": "3" }
        });
        let raw = parse_event_row(&ev).expect("close row parses");
        assert_eq!(raw.party_a, None);
        assert_eq!(raw.party_b, None);
        assert_eq!(raw.sender.as_deref(), Some("0xsomeone"));
        assert_eq!(raw.party_a_balance, Some(5));
    }

    #[test]
    fn enrich_inherits_owner_and_game_onto_opened_row() {
        use crate::state::{TunnelEventKind, TunnelOwner};
        let raw = RawTunnelEvent {
            type_suffix: "TunnelActivated".into(),
            tunnel_id: "0xt".into(),
            party_a: None,
            party_b: None,
            sender: None, // Activated carries no addresses
            party_a_balance: None,
            party_b_balance: None,
            transcript_root: None,
            tx_digest: "D".into(),
            timestamp_ms: 7,
        };
        let owner = TunnelOwner {
            party_a: Some("0xaaa".into()),
            party_b: Some("0xbbb".into()),
            funder: Some("0xfff".into()),
        };
        let row = enrich_event_row(&raw, Some(owner), Some("blackjack".into())).unwrap();
        assert_eq!(row.kind, TunnelEventKind::Opened);
        assert_eq!(row.party_a.as_deref(), Some("0xaaa"));
        assert_eq!(row.funder.as_deref(), Some("0xfff"));
        assert_eq!(row.game.as_deref(), Some("blackjack"));
    }

    #[test]
    fn enrich_degrades_without_owner() {
        let closed = RawTunnelEvent {
            type_suffix: "TunnelClosed".into(),
            tunnel_id: "0xt".into(),
            party_a: None,
            party_b: None,
            sender: None,
            party_a_balance: Some(2),
            party_b_balance: Some(1),
            transcript_root: None,
            tx_digest: "D2".into(),
            timestamp_ms: 2,
        };
        let row = enrich_event_row(&closed, None, None).unwrap();
        assert_eq!(row.party_a, None, "no owner → no false attribution");
        assert_eq!(row.party_a_balance, Some(2));
    }

    // The fold loop's composition: a [Created, Activated, Closed] batch must capture ownership at
    // Created (which itself yields no display row) and inherit owner + the session-joined game onto
    // BOTH the Opened and Settled rows — including when all three arrive in the same poll batch.
    #[tokio::test]
    async fn fold_sequence_captures_owner_and_inherits_onto_opened_and_settled() {
        use crate::state::TunnelEventKind;
        use crate::store::memory::InMemoryControlStore;
        use crate::store::ControlStore; // bring trait methods into scope for the concrete store
        let store = InMemoryControlStore::default();
        // game is joined from the session registry, as put_session would record it.
        store
            .put_session(
                "s",
                crate::state::SessionRecord {
                    game: "blackjack".into(),
                    tunnels: vec![crate::routes::TunnelRef {
                        tunnel_id: "0xt".into(),
                        party_a: "0xa".into(),
                        party_b: "0xb".into(),
                    }],
                    stats_token: "tok".into(),
                },
            )
            .await;
        let raw = |suffix: &str, dig: &str| RawTunnelEvent {
            type_suffix: suffix.into(),
            tunnel_id: "0xt".into(),
            // only TunnelCreated carries the addresses; the others must inherit them.
            party_a: (suffix == "TunnelCreated").then(|| "0xaaa".into()),
            party_b: (suffix == "TunnelCreated").then(|| "0xbbb".into()),
            sender: (suffix == "TunnelCreated").then(|| "0xfff".into()),
            party_a_balance: None,
            party_b_balance: None,
            transcript_root: None,
            tx_digest: dig.into(),
            timestamp_ms: 1,
        };
        fold_event(&store, &raw("TunnelCreated", "dC")).await;
        fold_event(&store, &raw("TunnelActivated", "dA")).await;
        fold_event(&store, &raw("TunnelClosed", "dZ")).await;

        let rows = store.recent_events().await; // newest-first: [Closed, Activated]
        assert_eq!(rows.len(), 2, "Created itself yields no display row");
        assert_eq!(rows[0].kind, TunnelEventKind::Settled);
        assert_eq!(rows[0].funder.as_deref(), Some("0xfff"));
        assert_eq!(rows[0].game.as_deref(), Some("blackjack"));
        assert_eq!(rows[1].kind, TunnelEventKind::Opened);
        assert_eq!(rows[1].party_a.as_deref(), Some("0xaaa"));
        assert_eq!(rows[1].party_b.as_deref(), Some("0xbbb"));
        assert_eq!(rows[1].game.as_deref(), Some("blackjack"));
    }

    // The settler key loader must accept both the 32-byte raw secret and the 33-byte
    // flagged form, and reject anything else loudly.
    #[test]
    fn load_ed25519_accepts_32_and_33_byte_keys() {
        let b64 = base64::engine::general_purpose::STANDARD;
        assert!(load_ed25519(&b64.encode([9u8; 32])).is_ok());
        let mut flagged = vec![0u8];
        flagged.extend_from_slice(&[9u8; 32]);
        assert!(load_ed25519(&b64.encode(flagged)).is_ok());
        assert!(load_ed25519(&b64.encode([9u8; 16])).is_err());
    }

    // The JSON-RPC `signatures` field expects base64 of the 97-byte Sui form
    // flag(0x00)‖sig(64)‖pubkey(32). `execute()` uses `UserSignature::to_bytes()` for
    // this — NOT `bcs::to_bytes`, which double-tags the enum to 98 bytes (the bug this
    // test caught). A wrong layout would fail EVERY settle on a real node, which no
    // other test would catch.
    #[test]
    fn ed25519_signature_serializes_to_97_byte_sui_format() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let sk = load_ed25519(&b64.encode([7u8; 32])).unwrap();
        let (ca, ra) = close_and_ref("0x2");
        let tx = build_close_batch_tx(
            Address::from_str("0xabc").unwrap(),
            &"0x2::sui::SUI".parse().unwrap(),
            Address::ZERO,
            &[ca],
            &[ra],
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            0,
        )
        .unwrap();
        let sig = sk.sign_transaction(&tx).unwrap();
        let bytes = sig.to_bytes();
        assert_eq!(
            bytes.len(),
            97,
            "want flag(1)+sig(64)+pubkey(32), got {}",
            bytes.len()
        );
        assert_eq!(bytes[0], 0x00, "ed25519 flag byte");
        // Guard: bcs is the wrong encoder here (98 bytes); if this ever changes, revisit execute().
        assert_eq!(bcs::to_bytes(&sig).unwrap().len(), 98);
    }
}
