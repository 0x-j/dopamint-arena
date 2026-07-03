//! Enoki sponsored-transaction HTTP client (the PRIMARY gas source; the settler in `sui.rs` is
//! the fallback — see ADR-0014). Enoki holds its own gas key and EXECUTES the tx itself, so unlike
//! the settler it returns no detached sponsor signature: the flow is create -> the user signs the
//! returned bytes -> execute. Two calls, both server-side with the PRIVATE api key.
//!
//! This client is deliberately on the open/fund hot path (tried before the settler), so its
//! `reqwest` client carries a request timeout: a hung Enoki must surface as an error promptly so
//! the caller can fall back to the settler, not stall the request. Errors keep Enoki's response
//! body (we do NOT use `error_for_status`, which discards it) — that body is the only diagnostic
//! when Enoki refuses (e.g. the app's portal allowlist doesn't cover our package).

use std::time::Duration;

use anyhow::{anyhow, Context};

/// Enoki's public API host. Kept here (not env) — there is one production endpoint; tests point the
/// client at a `wiremock` server via `EnokiClient::new`'s `base_url`.
pub const ENOKI_BASE_URL: &str = "https://api.enoki.mystenlabs.com";

/// Bounds an Enoki call so a hang falls back to the settler instead of stalling the open/fund. Well
/// under any client-side patience: Enoki sponsor/execute are single round-trips that normally
/// answer in well under a second.
const ENOKI_TIMEOUT: Duration = Duration::from_secs(15);

pub struct EnokiClient {
    http: reqwest::Client,
    api_key: String,
    /// Sui network passed as Enoki's `network` field (`testnet`/`mainnet`/`devnet`). Must match the
    /// network the api key is provisioned for, or Enoki rejects the sponsor.
    network: String,
    base_url: String,
}

impl EnokiClient {
    /// Build a client. `base_url` is the API host (`ENOKI_BASE_URL` in prod, a mock in tests).
    /// Fails only if the `reqwest` builder can't construct a client with the timeout.
    pub fn new(api_key: String, network: String, base_url: &str) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(ENOKI_TIMEOUT)
            .build()
            .context("build enoki http client")?;
        Ok(Self {
            http,
            api_key,
            network,
            base_url: base_url.trim_end_matches('/').to_string(),
        })
    }

    /// CREATE a sponsored tx: Enoki wraps the client-built tx KIND in its own gas and returns the
    /// full sponsored `(bytes, digest)`. `allowed_targets` are the `pkg::module::fn` move-call
    /// targets the sponsored tx may invoke — defense-in-depth alongside the backend's own validate.
    /// The caller signs `bytes`, then passes `digest` + the signature to `execute`.
    pub async fn sponsor(
        &self,
        sender: &str,
        kind_b64: &str,
        allowed_targets: &[String],
    ) -> anyhow::Result<(String, String)> {
        let url = format!("{}/v1/transaction-blocks/sponsor", self.base_url);
        let body = serde_json::json!({
            "network": self.network,
            "transactionBlockKindBytes": kind_b64,
            "sender": sender,
            "allowedMoveCallTargets": allowed_targets,
        });
        let resp = self
            .http
            .post(url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .context("enoki sponsor request")?;
        let json = read_enoki_json(resp, "sponsor").await?;
        let bytes = json
            .pointer("/data/bytes")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("enoki sponsor response missing data.bytes: {json}"))?
            .to_owned();
        let digest = json
            .pointer("/data/digest")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("enoki sponsor response missing data.digest: {json}"))?
            .to_owned();
        Ok((bytes, digest))
    }

    /// EXECUTE a previously-created sponsored tx: hand Enoki the user's `signature` over the bytes
    /// it returned; Enoki adds its own gas signature and submits. Returns the executed tx digest.
    /// The `digest` is the opaque handle from `sponsor`; it is charset-checked before going into the
    /// URL path so a malformed value fails loud rather than building a bad request.
    pub async fn execute(&self, digest: &str, signature: &str) -> anyhow::Result<String> {
        anyhow::ensure!(
            is_base58(digest),
            "enoki execute: digest is not base58: {digest}"
        );
        let url = format!("{}/v1/transaction-blocks/sponsor/{}", self.base_url, digest);
        let body = serde_json::json!({ "signature": signature });
        let resp = self
            .http
            .post(url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .context("enoki execute request")?;
        let json = read_enoki_json(resp, "execute").await?;
        json.pointer("/data/digest")
            .and_then(|v| v.as_str())
            .map(|s| s.to_owned())
            .ok_or_else(|| anyhow!("enoki execute response missing data.digest: {json}"))
    }

    /// Verify a user's Enoki/zkLogin id_token and return their canonical Sui address. Calls Enoki's
    /// `GET /v1/zklogin` (the endpoint the wallet itself hits at login) with the id_token in the
    /// `zklogin-jwt` header and OUR private api key as bearer; Enoki validates the JWT and returns
    /// the address derived from (sub, aud, salt). An invalid/expired id_token yields a non-2xx,
    /// surfaced via `read_enoki_json`. This is how a spend endpoint binds a request to a real
    /// identity — validating the JWT and resolving its address in one call.
    pub async fn verify_zklogin(&self, jwt: &str) -> anyhow::Result<String> {
        let url = format!("{}/v1/zklogin", self.base_url);
        let resp = self
            .http
            .get(url)
            .bearer_auth(&self.api_key)
            .header("zklogin-jwt", jwt)
            .send()
            .await
            .context("enoki zklogin request")?;
        let json = read_enoki_json(resp, "zklogin").await?;
        json.pointer("/data/address")
            .and_then(|v| v.as_str())
            .map(|s| s.to_owned())
            .ok_or_else(|| anyhow!("enoki zklogin response missing data.address: {json}"))
    }
}

/// Read an Enoki response: capture the body as text FIRST (so a non-2xx error body survives — unlike
/// `error_for_status`, which drops it), fail with status+body on non-2xx, else parse the success
/// JSON. The body is the only signal when Enoki refuses, so it must reach the caller's log.
async fn read_enoki_json(resp: reqwest::Response, op: &str) -> anyhow::Result<serde_json::Value> {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("enoki {op} failed ({status}): {body}"));
    }
    serde_json::from_str(&body).with_context(|| format!("enoki {op} returned non-JSON: {body}"))
}

/// True if every char is in the Bitcoin/Sui base58 alphabet (no `0 O I l`). Sui digests are base58;
/// this guards the `execute` URL path against an unexpected/malformed digest.
fn is_base58(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|b| {
            matches!(b,
                b'1'..=b'9'
                | b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'Z'
                | b'a'..=b'k' | b'm'..=b'z')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client(uri: String) -> EnokiClient {
        EnokiClient::new("test_key".into(), "testnet".into(), &uri).unwrap()
    }

    // sponsor() must send the bearer key + the exact request body Enoki expects, and pull
    // (bytes, digest) out of the `{data:{...}}` envelope. An envelope-shape change is an
    // integration break, so this pins the field paths against a mocked Enoki.
    #[tokio::test]
    async fn sponsor_sends_auth_and_body_and_extracts_bytes_digest() {
        let server = MockServer::start().await;
        let resp = serde_json::json!({ "data": { "bytes": "QUJD", "digest": "Hq3" } });
        Mock::given(method("POST"))
            .and(path("/v1/transaction-blocks/sponsor"))
            .and(header("authorization", "Bearer test_key"))
            .and(body_json(serde_json::json!({
                "network": "testnet",
                "transactionBlockKindBytes": "KIND",
                "sender": "0xabc",
                "allowedMoveCallTargets": ["0x2::tunnel::create"],
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(resp))
            .mount(&server)
            .await;
        let c = client(server.uri());
        let (bytes, digest) = c
            .sponsor("0xabc", "KIND", &["0x2::tunnel::create".to_string()])
            .await
            .unwrap();
        assert_eq!(bytes, "QUJD");
        assert_eq!(digest, "Hq3");
    }

    // execute() posts to the digest-scoped path with the signature and returns the executed digest.
    #[tokio::test]
    async fn execute_posts_signature_and_returns_digest() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/transaction-blocks/sponsor/Hq3"))
            .and(header("authorization", "Bearer test_key"))
            .and(body_json(serde_json::json!({ "signature": "SIG" })))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "data": { "digest": "exec99" } })),
            )
            .mount(&server)
            .await;
        let c = client(server.uri());
        assert_eq!(c.execute("Hq3", "SIG").await.unwrap(), "exec99");
    }

    // A non-2xx must surface Enoki's error body (the only diagnostic when the portal allowlist
    // refuses), proving we don't swallow it via `error_for_status`.
    #[tokio::test]
    async fn sponsor_error_surfaces_enoki_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(403).set_body_string("move call target not allowed"),
            )
            .mount(&server)
            .await;
        let c = client(server.uri());
        let err = c
            .sponsor("0xabc", "KIND", &[])
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("403"), "got: {err}");
        assert!(err.contains("move call target not allowed"), "got: {err}");
    }

    // A 2xx whose envelope is missing the expected field is an error, never a silent empty value.
    #[tokio::test]
    async fn sponsor_errors_on_missing_field() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": {} })),
            )
            .mount(&server)
            .await;
        let c = client(server.uri());
        assert!(c.sponsor("0xabc", "KIND", &[]).await.is_err());
    }

    // A non-base58 digest is rejected before any request — guards the URL path.
    #[tokio::test]
    async fn execute_rejects_non_base58_digest() {
        let c = client("http://127.0.0.1:1".into());
        // `0` and `/` are outside base58; the second would also be a path-injection.
        assert!(c.execute("bad0digest", "SIG").await.is_err());
        assert!(c.execute("../escape", "SIG").await.is_err());
        assert!(c.execute("", "SIG").await.is_err());
    }

    // verify_zklogin GETs /v1/zklogin with the user id_token in the `zklogin-jwt` header + OUR api
    // key as bearer, and returns the canonical address from the `{data:{address}}` envelope. This is
    // the exact contract the Enoki wallet uses at login, so it pins the header names + field path.
    #[tokio::test]
    async fn verify_zklogin_sends_jwt_header_and_returns_address() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/zklogin"))
            .and(header("authorization", "Bearer test_key"))
            .and(header("zklogin-jwt", "USER_ID_TOKEN"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "data": { "address": "0xuser", "publicKey": "0xpk" } }),
            ))
            .mount(&server)
            .await;
        let c = client(server.uri());
        assert_eq!(c.verify_zklogin("USER_ID_TOKEN").await.unwrap(), "0xuser");
    }

    // An invalid/expired id_token → Enoki non-2xx → the error must surface Enoki's body (never a
    // silent empty address that would authorize the wrong caller).
    #[tokio::test]
    async fn verify_zklogin_error_surfaces_enoki_body() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid jwt"))
            .mount(&server)
            .await;
        let c = client(server.uri());
        let err = c.verify_zklogin("bad").await.unwrap_err().to_string();
        assert!(err.contains("401"), "got: {err}");
        assert!(err.contains("invalid jwt"), "got: {err}");
    }
}
