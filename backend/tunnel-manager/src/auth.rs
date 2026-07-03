//! Session auth for spend endpoints (arena allocate). The frontend proves its zkLogin identity
//! ONCE at connect via Enoki (`POST /v1/auth/session` verifies the Enoki id_token and returns the
//! canonical address); we mint a short-lived HS256 session JWT bound to that address, and spend
//! endpoints verify it locally per request. The session JWT — NOT the ~1h-lived Enoki id_token — is
//! what survives reloads, so a returning player re-authorizes without re-hitting Enoki per allocate.

use anyhow::Context;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

/// Claims in the backend-issued session JWT. `sub` is the Enoki-verified canonical Sui address the
/// token authorizes spend for; `exp` is the unix expiry the verifier enforces.
#[derive(Debug, Serialize, Deserialize)]
pub struct SessionClaims {
    pub sub: String,
    pub exp: usize,
}

/// Mint a session JWT binding `address` for `ttl_secs`, signed with `secret` (HS256). `now_unix` is
/// injected (not read from the clock) so callers stay testable; the handler passes the real now.
pub fn mint_session_jwt(
    secret: &str,
    address: &str,
    ttl_secs: u64,
    now_unix: u64,
) -> anyhow::Result<String> {
    let claims = SessionClaims {
        sub: address.to_string(),
        exp: (now_unix + ttl_secs) as usize,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .context("mint session jwt")
}

/// Verify a session JWT's HS256 signature (with `secret`) and expiry, returning its claims. Errors
/// on a bad signature, a tampered payload, a missing/expired `exp`, or a malformed token.
pub fn verify_session_jwt(secret: &str, token: &str) -> anyhow::Result<SessionClaims> {
    // Default HS256 validation requires + checks `exp` (60s leeway); no aud/iss on a self-issued token.
    let validation = Validation::new(Algorithm::HS256);
    let data = decode::<SessionClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .context("verify session jwt")?;
    Ok(data.claims)
}

/// Outcome of the arena spend gate. `Disabled` = `SESSION_JWT_SECRET` unset (feature off — allocate
/// runs unauthenticated as before, logged loudly at startup; the rollout switch); `Authorized` = a
/// valid session JWT whose `sub` matches the requested address; `Denied` = a configured gate that
/// failed and the request must be rejected.
#[derive(Debug, PartialEq, Eq)]
pub enum GateOutcome {
    Disabled,
    Authorized,
    Denied(DenyReason),
}

/// Why a configured arena gate rejected a request. Maps to a status at the HTTP boundary
/// (`MissingToken`/`InvalidToken` → 401, `AddressMismatch` → 403).
#[derive(Debug, PartialEq, Eq)]
pub enum DenyReason {
    MissingToken,
    InvalidToken,
    AddressMismatch,
}

/// Decide whether an arena spend request is authorized. Pure (no I/O): the caller extracts the
/// bearer token from the request and passes the configured `secret` + the client-claimed address.
/// When `secret` is `None` the gate is disabled (enforced only once `SESSION_JWT_SECRET` is set, so a
/// partial rollout can't brick gameplay). Otherwise a valid, unexpired session JWT is required AND
/// its `sub` must equal the requested address (canonicalized) — so a stolen token can't allocate,
/// and burn house gas, for a different wallet.
pub fn arena_session_gate(
    secret: Option<&str>,
    bearer_token: Option<&str>,
    requested_address: &str,
) -> GateOutcome {
    let Some(secret) = secret else {
        return GateOutcome::Disabled;
    };
    let Some(token) = bearer_token else {
        return GateOutcome::Denied(DenyReason::MissingToken);
    };
    let claims = match verify_session_jwt(secret, token) {
        Ok(c) => c,
        Err(_) => return GateOutcome::Denied(DenyReason::InvalidToken),
    };
    // Canonicalize both sides: the token `sub` is Enoki-canonical, but the client-claimed address
    // may be short/differently-padded. Compare canonical forms so a real match isn't rejected and a
    // real mismatch (spend-for-another-wallet) is caught.
    let canon = |a: &str| crate::sui::canonical_address(a).ok();
    match (canon(&claims.sub), canon(requested_address)) {
        (Some(a), Some(b)) if a == b => GateOutcome::Authorized,
        _ => GateOutcome::Denied(DenyReason::AddressMismatch),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    // A full-length (64-hex) address; the padded form of `0x…abc` used across the gate tests.
    const ADDR_ABC: &str = "0x0000000000000000000000000000000000000000000000000000000000000abc";
    const ADDR_DEF: &str = "0x0000000000000000000000000000000000000000000000000000000000000def";

    fn now_unix() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    // A minted token round-trips: verifying with the same secret yields the address it was bound to.
    // This is the core contract the spend endpoints rely on to pin the caller to a real identity.
    #[test]
    fn mint_then_verify_recovers_the_bound_address() {
        let secret = "s3cr3t";
        let token = mint_session_jwt(secret, "0xabc", 3600, now_unix()).unwrap();
        let claims = verify_session_jwt(secret, &token).unwrap();
        assert_eq!(claims.sub, "0xabc");
    }

    // A token signed with a different secret must NOT verify — else anyone could forge a session for
    // any address and drive house spend. This is the whole point of the signature.
    #[test]
    fn verify_rejects_a_token_signed_with_a_different_secret() {
        let token = mint_session_jwt("secret-A", "0xabc", 3600, now_unix()).unwrap();
        assert!(verify_session_jwt("secret-B", &token).is_err());
    }

    // An expired token must be rejected so a leaked session can't be replayed forever. Minted 2h in
    // the past (well beyond jsonwebtoken's default 60s exp leeway).
    #[test]
    fn verify_rejects_an_expired_token() {
        let secret = "s3cr3t";
        let token = mint_session_jwt(secret, "0xabc", 0, now_unix() - 7200).unwrap();
        assert!(verify_session_jwt(secret, &token).is_err());
    }

    // A tampered token must fail signature verification — the bound address can't be swapped post-mint.
    #[test]
    fn verify_rejects_a_tampered_token() {
        let secret = "s3cr3t";
        let token = mint_session_jwt(secret, "0xabc", 3600, now_unix()).unwrap();
        let mut chars: Vec<char> = token.chars().collect();
        let mid = chars.len() / 2;
        chars[mid] = if chars[mid] == 'a' { 'b' } else { 'a' };
        let tampered: String = chars.into_iter().collect();
        assert!(verify_session_jwt(secret, &tampered).is_err());
    }

    // Rollout: with no secret configured the gate is OFF, so allocate keeps working unauthenticated
    // until SESSION_JWT_SECRET is set (+ the FE ships the token). A partial deploy can't brick play.
    #[test]
    fn gate_is_disabled_when_no_secret_configured() {
        assert_eq!(
            arena_session_gate(None, None, ADDR_ABC),
            GateOutcome::Disabled
        );
    }

    // The B5 hole: a configured gate with NO token is denied — an anonymous caller can no longer
    // drive house on-chain spend.
    #[test]
    fn gate_denies_a_configured_request_with_no_token() {
        assert_eq!(
            arena_session_gate(Some("s3cr3t"), None, ADDR_ABC),
            GateOutcome::Denied(DenyReason::MissingToken)
        );
    }

    // A garbage/forged token is denied — the HS256 signature is what stops forging a session.
    #[test]
    fn gate_denies_an_invalid_token() {
        assert_eq!(
            arena_session_gate(Some("s3cr3t"), Some("not.a.jwt"), ADDR_ABC),
            GateOutcome::Denied(DenyReason::InvalidToken)
        );
    }

    // A VALID token but for a DIFFERENT address is denied — address-pinning stops a stolen/replayed
    // token from allocating (and burning house gas) for someone else's wallet. This is the core guard.
    #[test]
    fn gate_denies_a_valid_token_for_a_different_address() {
        let secret = "s3cr3t";
        let token = mint_session_jwt(secret, ADDR_ABC, 3600, now_unix()).unwrap();
        assert_eq!(
            arena_session_gate(Some(secret), Some(&token), ADDR_DEF),
            GateOutcome::Denied(DenyReason::AddressMismatch)
        );
    }

    // A valid token whose sub matches the requested address authorizes the spend (the happy path).
    #[test]
    fn gate_authorizes_a_valid_token_matching_the_address() {
        let secret = "s3cr3t";
        let token = mint_session_jwt(secret, ADDR_ABC, 3600, now_unix()).unwrap();
        assert_eq!(
            arena_session_gate(Some(secret), Some(&token), ADDR_ABC),
            GateOutcome::Authorized
        );
    }

    // Address comparison is CANONICAL: a token minted for the padded form and a request giving the
    // short form (`0xabc`) are the same address, so it must NOT spuriously reject.
    #[test]
    fn gate_authorizes_when_addresses_are_canonically_equal() {
        let secret = "s3cr3t";
        let token = mint_session_jwt(secret, ADDR_ABC, 3600, now_unix()).unwrap();
        assert_eq!(
            arena_session_gate(Some(secret), Some(&token), "0xabc"),
            GateOutcome::Authorized
        );
    }
}
