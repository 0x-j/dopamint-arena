/// MTPS — the free stake token for MillionsTPS, lightning-speed games and apps on Sui. Stakes are
/// paid in MTPS (gas stays sponsored in SUI), so a 0-SUI player can fund a game for free.
///
/// Minting is NOT permissionless: the backend faucet holds the `AdminCap` and mints each player
/// exactly the amount they need (an off-chain HTTP faucet — see the backend). Admin-only minting
/// removes the attacker brick vector, so there is no supply cap and no kill switch; `admin_mint`
/// keeps only a per-call sanity bound (`MAX_MINT_PER_CALL`) to cap the blast radius of a backend
/// bug. Coin metadata is registered via the modern `coin_registry`, and the `MetadataCap` is kept
/// (not burned) so symbol/name/icon stay updatable post-deploy without a redeploy.
module mtps::mtps;

use sui::coin::{Self, Coin, TreasuryCap};
use sui::coin_registry;

/// One-time witness: guarantees a single `TreasuryCap<MTPS>` for this currency.
public struct MTPS has drop {}

/// The mint authority. Holding it is the sole permission to mint or burn MTPS; the backend
/// faucet custodies it. It wraps the `TreasuryCap`, so there is no shared faucet object and no
/// public mint — minting only happens in a tx signed by the cap's owner.
public struct AdminCap has key {
    id: UID,
    treasury_cap: TreasuryCap<MTPS>,
}

/// 0 decimals: MTPS is an indivisible whole-token stake, so a 1-token tunnel deposit is the
/// integer `1` (not `1e9`). Decimals are fixed at creation — not even the `MetadataCap` can
/// change them — so this is permanent for the deployment.
const DECIMALS: u8 = 0;

/// Per-call sanity bound on `admin_mint`. NOT an attacker defense — minting is already
/// AdminCap-only — but a guardrail bounding a backend bug (a stray large value) minting an
/// absurd amount. 10B MTPS is ~1M× the biggest real faucet pull (10k MTPS).
const MAX_MINT_PER_CALL: u64 = 10_000_000_000; // 10B MTPS (0 decimals → whole tokens)

/// `admin_mint` was called with `amount` above `MAX_MINT_PER_CALL`.
const EAmountTooLarge: u64 = 0;

fun init(witness: MTPS, ctx: &mut TxContext) {
    // Register metadata via coin_registry (replaces the deprecated `coin::create_currency`).
    // OTW path: `init` only parks the `Currency` at the registry; a one-time post-publish
    // `coin_registry::finalize_registration` tx promotes it (see docs/runbooks/mtps-deploy.md).
    // We keep the `TreasuryCap` inside the AdminCap.
    let (initializer, treasury_cap) = coin_registry::new_currency_with_otw(
        witness,
        DECIMALS,
        b"MTPS".to_string(),
        b"MTPS".to_string(),
        b"Lightning speed games and apps on Sui".to_string(),
        b"https://dev.millionstps.io/favicons/favicon.svg".to_string(),
        ctx,
    );
    // Keep the MetadataCap (hand it to the deployer) so symbol/name/icon stay updatable
    // post-deploy — wallets/explorers render a public token's metadata.
    let metadata_cap = initializer.finalize(ctx);
    transfer::public_transfer(metadata_cap, ctx.sender());

    // The AdminCap (with the treasury) goes to the deployer; the backend faucet custodies it.
    // It is `key`-only (no `store`), so it cannot be transferred after this — the deploy MUST
    // be signed by the backend faucet's key (see docs/runbooks/mtps-deploy.md).
    transfer::transfer(AdminCap { id: object::new(ctx), treasury_cap }, ctx.sender());
}

/// Mint `amount` MTPS to `recipient`. Authorized solely by holding the `AdminCap`; the backend
/// faucet calls this to fund each player exactly what they need for a game.
public fun admin_mint(
    cap: &mut AdminCap,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    assert!(amount <= MAX_MINT_PER_CALL, EAmountTooLarge);
    coin::mint_and_transfer<MTPS>(&mut cap.treasury_cap, amount, recipient, ctx);
}

/// Mint `amount` MTPS straight into `recipient`'s account (SIP-58 address) balance, instead of as a
/// version-pinned owned coin. The off-chain stake path withdraws from the address balance (ADR-0013),
/// so this lets the backend faucet fund a player in ONE tx — no separate client-side sweep. Same
/// AdminCap-only authority and per-call bound as `admin_mint`.
public fun admin_mint_to_balance(
    cap: &mut AdminCap,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    assert!(amount <= MAX_MINT_PER_CALL, EAmountTooLarge);
    coin::send_funds(coin::mint(&mut cap.treasury_cap, amount, ctx), recipient);
}

/// Burn MTPS back out of supply (AdminCap-only).
public fun burn(cap: &mut AdminCap, coin: Coin<MTPS>) {
    coin::burn(&mut cap.treasury_cap, coin);
}

#[test_only]
public fun test_init(ctx: &mut TxContext) {
    init(MTPS {}, ctx);
}

#[test_only]
public fun max_mint_per_call(): u64 { MAX_MINT_PER_CALL }
