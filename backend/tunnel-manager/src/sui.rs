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
const CLOCK_ADDRESS: &str = "0x0000000000000000000000000000000000000000000000000000000000000006";
/// Fixed gas budget for a single cooperative close (one MoveCall, two shared objects).
const GAS_BUDGET: u64 = 100_000_000;
/// Gas budget cap for a sponsored open/fund tx (create + deposit + share). Same magnitude as a
/// close; the dry-run rejects anything that would exceed it before the settler pays (ADR-0009).
const SPONSOR_GAS_BUDGET: u64 = 100_000_000;
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

/// `example_streaming_payment` ops sponsorable for a 0-SUI sender — the stream is funded from the
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
const CHAIN_DIGEST_B58: &str = "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD";

/// Fields for one on-chain `close_cooperative_with_root`, mapped from the SDK's
/// SettlementWithRoot (ADR-0002). Balances/timestamp already parsed to `u64`; sigs and
/// root already hex-decoded by the handler.
pub struct CloseArgs {
    pub tunnel_id: String,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub sig_a: Vec<u8>,
    pub sig_b: Vec<u8>,
    pub timestamp: u64,
    pub transcript_root: Vec<u8>,
}

/// A shared object's PTB reference: id + the version it was first shared at.
#[derive(Clone)]
struct SharedRef {
    id: Address,
    initial_shared_version: u64,
}

pub struct SuiSettler {
    http: reqwest::Client,
    rpc_url: String,
    package_id: Address,
    coin_type: TypeTag,
    /// Sponsorable example-app modules (agent allowance, streaming payment, …), built from config.
    /// Empty = only the tunnel/coin/faucet allowlist applies.
    example_packages: Vec<ExampleModule>,
    signer: Ed25519PrivateKey,
    sender: Address,
    /// Per-sponsorship nonce source for the `ValidDuring` FundsWithdrawal replay guard. Seeded
    /// from wall-clock nanos at boot so two process runs in the same epoch don't collide.
    sponsor_nonce: AtomicU32,
    /// Test-only override: when set, `submit_close` returns this digest without RPC calls.
    #[cfg(any(test, feature = "test-util"))]
    fixed_close_digest: Option<String>,
}

/// A parsed tunnel lifecycle event: the type suffix drives status folding; the rest feeds the
/// recent-events ring. `transcript_root` is hex; balances are `None` on non-close events.
#[derive(Debug, Clone)]
pub struct RawTunnelEvent {
    pub type_suffix: String,
    pub tunnel_id: String,
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
fn dryrun_effects_ok(resp: &serde_json::Value) -> Result<(), String> {
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
        rpc_url: String,
        package_id: &str,
        coin_type: &str,
        agent_allowance_package_id: Option<&str>,
        streaming_payment_package_id: Option<&str>,
        settler_key_b64: &str,
    ) -> anyhow::Result<Self> {
        let signer = load_ed25519(settler_key_b64)?;
        let sender = signer.public_key().derive_address();
        // Build the sponsorable example-app set from whatever packages are configured.
        let mut example_packages: Vec<ExampleModule> = Vec::new();
        if let Some(s) = agent_allowance_package_id {
            let pkg = Address::from_str(s).context("bad AGENT_ALLOWANCE_PACKAGE_ID")?;
            example_packages.push((pkg, "example_agent_allowance", SPONSOR_AGENT_ALLOWANCE_FNS));
        }
        if let Some(s) = streaming_payment_package_id {
            let pkg = Address::from_str(s).context("bad STREAMING_PAYMENT_PACKAGE_ID")?;
            example_packages.push((
                pkg,
                "example_streaming_payment",
                SPONSOR_STREAMING_PAYMENT_FNS,
            ));
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
            http: reqwest::Client::new(),
            rpc_url,
            package_id: Address::from_str(package_id).context("bad TUNNEL_PACKAGE_ID")?,
            coin_type: TypeTag::from_str(coin_type).context("bad TUNNEL_COIN_TYPE")?,
            example_packages,
            signer,
            sender,
            sponsor_nonce: AtomicU32::new(nonce_seed),
            #[cfg(any(test, feature = "test-util"))]
            fixed_close_digest: None,
        })
    }

    /// Construct a no-op settler for tests — RPC calls will fail at the network layer, which is
    /// acceptable since tests using `in_memory_for_test` never invoke `submit_close`.
    #[cfg(any(test, feature = "test-util"))]
    pub fn noop() -> Self {
        let signer = Ed25519PrivateKey::new([0u8; 32]);
        let sender = signer.public_key().derive_address();
        Self {
            http: reqwest::Client::new(),
            rpc_url: String::new(),
            package_id: Address::ZERO,
            coin_type: "0x2::sui::SUI".parse().expect("static coin type"),
            example_packages: Vec::new(),
            signer,
            sender,
            sponsor_nonce: AtomicU32::new(0),
            #[cfg(any(test, feature = "test-util"))]
            fixed_close_digest: None,
        }
    }

    /// Test-only settler that returns a fixed digest from `submit_close` without RPC calls.
    /// Use this in handler-level tests that need the settle success path to run.
    #[cfg(any(test, feature = "test-util"))]
    pub fn fixed_digest(digest: impl Into<String>) -> Self {
        let mut s = Self::noop();
        s.fixed_close_digest = Some(digest.into());
        s
    }

    /// Build, sign, and execute `close_cooperative_with_root`; returns the tx digest.
    /// Resolves the tunnel shared ref + reference gas price over JSON-RPC, builds offline.
    /// Concurrent calls are safe: no shared gas coin means no equivocation risk.
    pub async fn submit_close(&self, args: CloseArgs) -> anyhow::Result<String> {
        #[cfg(any(test, feature = "test-util"))]
        if let Some(digest) = self.fixed_close_digest.clone() {
            return Ok(digest);
        }
        let tunnel = self.resolve_shared(&args.tunnel_id).await?;
        let (epoch, gas_price) = self.epoch_and_gas_price().await?;
        let chain = Digest::from_base58(CHAIN_DIGEST_B58).context("chain digest")?;
        let tx = build_close_tx(
            self.package_id,
            self.coin_type.clone(),
            self.sender,
            &args,
            &tunnel,
            gas_price,
            epoch,
            chain,
            nonce_from_tunnel(&args.tunnel_id),
        )?;
        // Verify-before-gas: reject a settlement that won't land before sponsoring it (ADR-0007).
        self.dry_run(&tx).await?;
        let sig = self
            .signer
            .sign_transaction(&tx)
            .map_err(|e| anyhow!("sign close tx: {e}"))?;
        self.execute(&tx, &sig).await
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

    async fn rpc(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
        let resp: serde_json::Value = self
            .http
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if let Some(err) = resp.get("error") {
            return Err(anyhow!("rpc {method}: {err}"));
        }
        Ok(resp
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    async fn resolve_shared(&self, object_id: &str) -> anyhow::Result<SharedRef> {
        let r = self
            .rpc(
                "sui_getObject",
                serde_json::json!([object_id, {"showOwner": true}]),
            )
            .await?;
        let isv = r
            .pointer("/data/owner/Shared/initial_shared_version")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| anyhow!("object {object_id} is not a shared tunnel: {r}"))?;
        Ok(SharedRef {
            id: Address::from_str(object_id).context("tunnel id")?,
            initial_shared_version: isv,
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

/// Project a raw event to a displayable Transaction-Log row, or `None` if it is not one
/// (only activations and closes are shown). `game` is left `None` for v1 — the event carries
/// no game tag; joining `tunnel_id → game` via the session registry is a deferred follow-up.
#[allow(dead_code)]
fn to_tunnel_event(raw: &RawTunnelEvent) -> Option<crate::state::TunnelEvent> {
    let kind = match raw.type_suffix.as_str() {
        "TunnelActivated" => crate::state::TunnelEventKind::Opened,
        "TunnelClosed" | "TunnelClosedWithRoot" => crate::state::TunnelEventKind::Settled,
        _ => return None,
    };
    Some(crate::state::TunnelEvent {
        tunnel_id: raw.tunnel_id.clone(),
        kind,
        party_a_balance: raw.party_a_balance,
        party_b_balance: raw.party_b_balance,
        transcript_root: raw.transcript_root.clone(),
        tx_digest: raw.tx_digest.clone(),
        timestamp_ms: raw.timestamp_ms,
        proof_url: None, // indexer rows are explorer-only; the /settle handler sets this (Task 7)
    })
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
                        let status = match raw.type_suffix.as_str() {
                            "TunnelCreated" => Some(crate::state::TunnelStatus::Created),
                            "TunnelActivated" => Some(crate::state::TunnelStatus::Active),
                            "TunnelClosed" | "TunnelClosedWithRoot" => {
                                Some(crate::state::TunnelStatus::Closed)
                            }
                            _ => None,
                        };
                        if let Some(s) = status {
                            state.control.set_tunnel_status(&raw.tunnel_id, s).await;
                        }
                        if let Some(row) = to_tunnel_event(&raw) {
                            state.control.push_recent_event(row).await;
                        }
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

/// PURE core: build the `close_cooperative_with_root` PTB. Arg order matches the Move
/// signature exactly: tunnel, a_balance, b_balance, sig_a, sig_b, timestamp, transcript_root,
/// clock. The clock SharedRef is constructed internally from the well-known 0x6 address.
///
/// Uses SIP-58 address-balance gas: `try_build` requires ≥1 gas object, so a zero-value
/// placeholder is added to pass that check, then cleared before returning. The caller must
/// sign the returned tx before use — clearing before signing is required since the sig covers
/// `gas_payment`. Unit-tested.
/// A stable per-tunnel nonce for the `ValidDuring` expiration: the low 4 bytes of the tunnel id.
/// Exactly one cooperative close per tunnel, so this is unique per settlement.
fn nonce_from_tunnel(tunnel_id: &str) -> u32 {
    let h = tunnel_id.trim_start_matches("0x");
    let tail = &h[h.len().saturating_sub(8)..];
    u32::from_str_radix(tail, 16).unwrap_or(0)
}

#[allow(clippy::too_many_arguments)] // mirrors the Move close-with-root entry's parameter list
fn build_close_tx(
    package_id: Address,
    coin_type: TypeTag,
    sender: Address,
    args: &CloseArgs,
    tunnel: &SharedRef,
    gas_price: u64,
    epoch: u64,
    chain: Digest,
    nonce: u32,
) -> anyhow::Result<Transaction> {
    anyhow::ensure!(
        args.transcript_root.len() == 32,
        "transcript_root must be 32 bytes, got {}",
        args.transcript_root.len()
    );
    let mut tb = TransactionBuilder::new();
    let tunnel_arg = tb.object(ObjectInput::shared(
        tunnel.id,
        tunnel.initial_shared_version,
        true,
    ));
    // Move params sig_a/sig_b/transcript_root are `vector<u8>`: use `pure(&Vec<u8>)`, which
    // BCS-encodes them length-prefixed. `pure_bytes` inserts RAW bytes (no length prefix) →
    // the node rejects them as InvalidBCSBytes. (Caught only by the localnet e2e, not the
    // build-time `is_ok()` unit test.)
    let a = tb.pure(&args.party_a_balance);
    let b = tb.pure(&args.party_b_balance);
    let sa = tb.pure(&args.sig_a);
    let sb = tb.pure(&args.sig_b);
    let ts = tb.pure(&args.timestamp);
    let root = tb.pure(&args.transcript_root);
    let clock_arg = tb.object(ObjectInput::shared(
        Address::from_str(CLOCK_ADDRESS).expect("static clock id"),
        1,
        false,
    ));

    let func = Function::new(
        package_id,
        Identifier::new("tunnel").context("module ident")?,
        Identifier::new("close_cooperative_with_root").context("fn ident")?,
    )
    .with_type_args(vec![coin_type]);
    tb.move_call(func, vec![tunnel_arg, a, b, sa, sb, ts, root, clock_arg]);

    // Placeholder satisfies try_build's non-empty-gas check (builder.rs:676).
    tb.add_gas_objects([ObjectInput::owned(Address::ZERO, 1, Digest::ZERO)]);
    tb.set_sender(sender);
    tb.set_gas_budget(GAS_BUDGET);
    tb.set_gas_price(gas_price.max(1));
    // SIP-58 address-balance gas REQUIRES a `ValidDuring` expiration: with no gas-coin object
    // versions to mutate, the epoch-bounded window + nonce is what gives the FundsWithdrawal its
    // replay protection. Without it the node rejects the withdrawal ("Invalid withdraw
    // reservation"). min_epoch == max_epoch == current epoch (sui-sdk-types: "must equal current
    // epoch"); `chain` is the genesis digest (cross-chain replay guard).
    tb.set_expiration(TransactionExpiration::ValidDuring {
        min_epoch: Some(epoch),
        max_epoch: Some(epoch),
        min_timestamp: None,
        max_timestamp: None,
        chain,
        nonce,
    });
    let mut tx = tb.try_build().map_err(|e| anyhow!("build close tx: {e}"))?;
    // Empty objects => FundsWithdrawal from sender's address balance (SIP-58).
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
    match &kind {
        TransactionKind::ProgrammableTransaction(ptb) => {
            validate_sponsorable_inner(ptb, package_id, coin_type, example_packages)?
        }
        _ => anyhow::bail!("only programmable transactions can be sponsored"),
    }
    Ok(Transaction {
        kind,
        sender,
        gas_payment: GasPayment {
            // SIP-58: empty objects => the gas FundsWithdrawal is drawn from the gas OWNER (the
            // settler), NOT the sender — so the settler pays the user's gas from its own balance.
            objects: Vec::new(),
            owner: gas_owner,
            price: gas_price.max(1),
            budget: SPONSOR_GAS_BUDGET,
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
                // The MTPS stake token's faucet lives in the coin type's own package
                // (`<pkg>::mtps`). Sponsor the free `mint`/`mint_default` so a 0-token player
                // can faucet their stake (gas-sponsored) before opening a game. Also sponsor
                // `mint_nft` so the micro-payments shop can gaslessly reward the miner.
                let mtps_package_call = coin_type_address(coin_type) == Some(mc.package)
                    && mc.module.as_str() == "mtps"
                    && matches!(mc.function.as_str(), "mint" | "mint_default" | "mint_nft");
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
fn load_ed25519(b64: &str) -> anyhow::Result<Ed25519PrivateKey> {
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

    fn tunnel_ref() -> SharedRef {
        SharedRef {
            id: Address::from_str("0x2").unwrap(),
            initial_shared_version: 3,
        }
    }

    // The PTB must build for a well-formed settlement: a 32-byte root, both sigs, the
    // coin type arg. This pins the write-path wiring against the Move arg order.
    #[test]
    fn build_close_tx_builds_for_valid_settlement() {
        let tx = build_close_tx(
            Address::from_str("0xabc").unwrap(),
            "0x2::sui::SUI".parse().unwrap(),
            Address::ZERO,
            &args_with_root(32),
            &tunnel_ref(),
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            0,
        );
        assert!(tx.is_ok(), "valid settlement should build: {:?}", tx.err());
    }

    // The Move aborts on a non-32-byte root (EInvalidTranscriptRoot); reject it before
    // spending gas, with a clear error rather than an opaque on-chain failure.
    #[test]
    fn build_close_tx_rejects_wrong_root_length() {
        let err = build_close_tx(
            Address::ZERO,
            "0x2::sui::SUI".parse().unwrap(),
            Address::ZERO,
            &args_with_root(31),
            &tunnel_ref(),
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            0,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("32 bytes"), "got: {err}");
    }

    // Address-balance gas (SIP-58): the built close tx must carry an EMPTY gas payment so
    // the node charges gas as a FundsWithdrawal from the settler's SUI balance — no owned
    // gas coin to lock, so concurrent closes never equivocate.
    #[test]
    fn build_close_tx_uses_address_balance_gas() {
        let sender = Address::from_str("0x9").unwrap();
        let tx = build_close_tx(
            Address::from_str("0xabc").unwrap(),
            "0x2::sui::SUI".parse().unwrap(),
            sender,
            &args_with_root(32),
            &tunnel_ref(),
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
        assert_eq!(tx.gas_payment.owner, sender);
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

    // The MTPS faucet `mint` (in the coin type's own package) is sponsorable, so a 0-token
    // player can faucet their stake gaslessly.
    #[test]
    fn validate_accepts_mtps_faucet_mint() {
        let coin: TypeTag = "0xabc::mtps::MTPS".parse().unwrap();
        let mint = Command::MoveCall(sui_sdk_types::MoveCall {
            package: Address::from_str("0xabc").unwrap(),
            module: Identifier::new("mtps").unwrap(),
            function: Identifier::new("mint").unwrap(),
            type_arguments: vec![],
            arguments: vec![Argument::Input(0), Argument::Input(1), Argument::Input(2)],
        });
        // The tunnel package is unrelated to the faucet call; pass an arbitrary one.
        let tunnel_pkg = Address::from_str("0xfff").unwrap();
        assert!(validate_sponsorable(&ptb(vec![mint]), tunnel_pkg, &coin).is_ok());
    }

    // A `mint` from a package OTHER than the configured coin type's is refused — only the real
    // MTPS faucet is sponsored, not a look-alike.
    #[test]
    fn validate_rejects_faucet_mint_from_foreign_package() {
        let coin: TypeTag = "0xabc::mtps::MTPS".parse().unwrap();
        let mint = Command::MoveCall(sui_sdk_types::MoveCall {
            package: Address::from_str("0xbad").unwrap(),
            module: Identifier::new("mtps").unwrap(),
            function: Identifier::new("mint").unwrap(),
            type_arguments: vec![],
            arguments: vec![],
        });
        assert!(
            validate_sponsorable(&ptb(vec![mint]), Address::from_str("0xfff").unwrap(), &coin)
                .is_err()
        );
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
            "example_streaming_payment",
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
                "example_streaming_payment",
                "create_stream",
                vec![coin.clone()]
            ),
            &stream_mods
        )
        .is_ok());
        assert!(check(
            call(
                stream_pkg,
                "example_streaming_payment",
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
        assert_eq!(tx.gas_payment.budget, SPONSOR_GAS_BUDGET);
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
            party_a_balance: Some(1500),
            party_b_balance: Some(500),
            transcript_root: Some("deadbeef".into()),
            tx_digest: "d1".into(),
            timestamp_ms: 9,
        };
        let row = to_tunnel_event(&closed).expect("close is displayable");
        assert_eq!(row.kind, TunnelEventKind::Settled);
        assert_eq!(row.party_a_balance, Some(1500));
        assert_eq!(row.transcript_root.as_deref(), Some("deadbeef"));

        closed.type_suffix = "TunnelActivated".into();
        assert_eq!(
            to_tunnel_event(&closed).expect("activation").kind,
            TunnelEventKind::Opened
        );

        closed.type_suffix = "TunnelCreated".into();
        assert!(to_tunnel_event(&closed).is_none(), "created is not a row");
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
        let tx = build_close_tx(
            Address::from_str("0xabc").unwrap(),
            "0x2::sui::SUI".parse().unwrap(),
            Address::ZERO,
            &args_with_root(32),
            &tunnel_ref(),
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
