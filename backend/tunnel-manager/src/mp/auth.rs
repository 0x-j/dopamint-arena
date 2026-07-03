//! Connect-handshake signature verification. v1 verifies the ed25519 signature over the
//! server nonce (proves key control); wallet<->pubkey address derivation is a noted
//! follow-up. Uses `ed25519-dalek` directly.
//!
//! Also hosts the keypair-session proof used by the walletless flash spectator bot: it signs a
//! self-issued, time-bounded message with its own ed25519 key, and the backend mints a session JWT
//! bound to the address that key derives to (so a signer can only authorize its OWN address, never
//! a foreign one). This is the non-zkLogin path onto the B5 arena gate.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use tunnel_core::crypto::blake2b256;

/// Sui's signature-scheme flag byte for Ed25519 — prefixed before the pubkey when deriving an address.
const ED25519_SCHEME_FLAG: u8 = 0x00;

/// Domain-separated prefix of the message a keypair signs to prove control of its address. Bumping
/// this invalidates every in-flight proof (both FE and BE build the message from this exact string).
const KEYPAIR_SESSION_DOMAIN: &str = "mtps.arena.session.v1";

/// The exact bytes a keypair signs to request a session for `address` at `issued_at_ms`. FE and BE
/// MUST build this identically or every proof fails verification.
pub fn keypair_session_message(address: &str, issued_at_ms: u64) -> Vec<u8> {
    format!("{KEYPAIR_SESSION_DOMAIN}\n{address}\n{issued_at_ms}").into_bytes()
}

/// The Sui address an ed25519 public key controls (`0x`-hex, 32 bytes). `None` if the hex isn't 32
/// bytes. Sui's standard derivation: `blake2b256(flag || pubkey)` — the same address a wallet's
/// `Ed25519PublicKey.toSuiAddress()` yields. The binding that stops a signer from minting a token
/// for an address it does not own.
pub fn ed25519_address(pubkey_hex: &str) -> Option<String> {
    let pk = decode32(pubkey_hex)?;
    let mut preimage = Vec::with_capacity(1 + pk.len());
    preimage.push(ED25519_SCHEME_FLAG);
    preimage.extend_from_slice(&pk);
    Some(format!("0x{}", hex::encode(blake2b256(&preimage))))
}

/// Why a keypair-session proof was rejected. `Stale` → 401 (clock skew / replay past the window),
/// `BadSignature`/`AddressMismatch` → 401 (not a genuine self-proof for the claimed address).
#[derive(Debug, PartialEq, Eq)]
pub enum KeypairAuthError {
    Stale,
    BadSignature,
    AddressMismatch,
}

/// Verify a keypair-session proof and return the canonical address the JWT should bind to. Requires:
/// the request is fresh (`|now - issued| <= max_skew_ms`, bounding replay without server state); the
/// signature is a genuine ed25519 sig by `pubkey_hex` over the canonical message; and — critically —
/// `pubkey_hex` derives to `address`, so a key can only authorize its OWN address, never a foreign
/// wallet's. Pure (no I/O), so the whole security contract is unit-testable.
pub fn verify_keypair_session(
    address: &str,
    pubkey_hex: &str,
    sig_hex: &str,
    issued_at_ms: u64,
    now_ms: u64,
    max_skew_ms: u64,
) -> Result<String, KeypairAuthError> {
    if now_ms.abs_diff(issued_at_ms) > max_skew_ms {
        return Err(KeypairAuthError::Stale);
    }
    let message = keypair_session_message(address, issued_at_ms);
    if !verify_ed25519(pubkey_hex, &message, sig_hex) {
        return Err(KeypairAuthError::BadSignature);
    }
    let derived = ed25519_address(pubkey_hex).ok_or(KeypairAuthError::BadSignature)?;
    let canon = |a: &str| crate::sui::canonical_address(a).ok();
    match (canon(&derived), canon(address)) {
        (Some(a), Some(b)) if a == b => Ok(a),
        _ => Err(KeypairAuthError::AddressMismatch),
    }
}

/// True iff `sig_hex` is a valid ed25519 signature by `pubkey_hex` over `message`.
/// All inputs are `0x`-optional hex; malformed inputs verify as false (never panic).
pub fn verify_ed25519(pubkey_hex: &str, message: &[u8], sig_hex: &str) -> bool {
    let pk = match decode32(pubkey_hex) {
        Some(b) => b,
        None => return false,
    };
    let sig_bytes = match hex::decode(sig_hex.trim_start_matches("0x")) {
        Ok(b) if b.len() == 64 => b,
        _ => return false,
    };
    let vk = match VerifyingKey::from_bytes(&pk) {
        Ok(v) => v,
        Err(_) => return false,
    };
    match Signature::from_slice(&sig_bytes) {
        Ok(sig) => vk.verify(message, &sig).is_ok(),
        Err(_) => false,
    }
}

fn decode32(hex_str: &str) -> Option<[u8; 32]> {
    let v = hex::decode(hex_str.trim_start_matches("0x")).ok()?;
    if v.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&v);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    // A genuine signature over the nonce verifies; a tampered message does not.
    #[test]
    fn verify_ed25519_accepts_genuine_rejects_tampered() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk_hex = hex::encode(sk.verifying_key().to_bytes());
        let nonce = b"server-nonce-123";
        let sig_hex = hex::encode(sk.sign(nonce).to_bytes());
        assert!(verify_ed25519(&pk_hex, nonce, &sig_hex));
        assert!(!verify_ed25519(&pk_hex, b"different-nonce", &sig_hex));
        assert!(
            !verify_ed25519("zz", nonce, &sig_hex),
            "garbage pubkey -> false"
        );
    }

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    // Our manual `blake2b256(flag || pk)` derivation MUST equal the Sui SDK's `derive_address` (which
    // is what a wallet's `toSuiAddress()` uses) — else every self-proof would 403 on the gate's
    // address check. Same 32-byte seed → same ed25519 key in both `sui_crypto` and `ed25519-dalek`.
    #[test]
    fn ed25519_address_matches_the_sui_sdk_derivation() {
        use sui_crypto::ed25519::Ed25519PrivateKey;
        let seed = [3u8; 32];
        let sdk_addr = Ed25519PrivateKey::new(seed)
            .public_key()
            .derive_address()
            .to_string();
        let dalek_pk = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        let ours = ed25519_address(&hex::encode(dalek_pk)).unwrap();
        assert_eq!(
            crate::sui::canonical_address(&ours).unwrap(),
            crate::sui::canonical_address(&sdk_addr).unwrap(),
        );
    }

    // A genuine self-signed proof for the address the key derives to mints a session for THAT address.
    #[test]
    fn keypair_session_accepts_a_genuine_self_proof() {
        let sk = signing_key(9);
        let pk_hex = hex::encode(sk.verifying_key().to_bytes());
        let address = ed25519_address(&pk_hex).expect("derive address");
        let now = 1_700_000_000_000u64;
        let sig = hex::encode(sk.sign(&keypair_session_message(&address, now)).to_bytes());
        let bound = verify_keypair_session(&address, &pk_hex, &sig, now, now, 120_000).unwrap();
        assert_eq!(
            crate::sui::canonical_address(&bound).unwrap(),
            crate::sui::canonical_address(&address).unwrap(),
        );
    }

    // A proof issued far outside the freshness window is rejected — bounds replay without any
    // server-side nonce store.
    #[test]
    fn keypair_session_rejects_a_stale_proof() {
        let sk = signing_key(9);
        let pk_hex = hex::encode(sk.verifying_key().to_bytes());
        let address = ed25519_address(&pk_hex).unwrap();
        let issued = 1_700_000_000_000u64;
        let sig = hex::encode(
            sk.sign(&keypair_session_message(&address, issued))
                .to_bytes(),
        );
        assert_eq!(
            verify_keypair_session(&address, &pk_hex, &sig, issued, issued + 600_000, 120_000),
            Err(KeypairAuthError::Stale),
        );
    }

    // A signature by a DIFFERENT key over the message is rejected — only the address's own key proves.
    #[test]
    fn keypair_session_rejects_a_signature_from_another_key() {
        let sk = signing_key(9);
        let impostor = signing_key(8);
        let pk_hex = hex::encode(sk.verifying_key().to_bytes());
        let address = ed25519_address(&pk_hex).unwrap();
        let now = 1_700_000_000_000u64;
        let sig = hex::encode(
            impostor
                .sign(&keypair_session_message(&address, now))
                .to_bytes(),
        );
        assert_eq!(
            verify_keypair_session(&address, &pk_hex, &sig, now, now, 120_000),
            Err(KeypairAuthError::BadSignature),
        );
    }

    // THE core guard: a genuine signature over a message claiming SOMEONE ELSE'S address is rejected,
    // because the signer's pubkey doesn't derive to it. Without this, any key could mint a token for
    // any wallet and burn house gas for it.
    #[test]
    fn keypair_session_rejects_minting_for_an_unowned_address() {
        let sk = signing_key(9);
        let pk_hex = hex::encode(sk.verifying_key().to_bytes());
        let victim = "0x0000000000000000000000000000000000000000000000000000000000000abc";
        let now = 1_700_000_000_000u64;
        // Validly signs, but for a foreign address it does not control.
        let sig = hex::encode(sk.sign(&keypair_session_message(victim, now)).to_bytes());
        assert_eq!(
            verify_keypair_session(victim, &pk_hex, &sig, now, now, 120_000),
            Err(KeypairAuthError::AddressMismatch),
        );
    }
}
