/**
 * Hands per PvP tunnel before cooperative settlement. PARITY CONTRACT: `handCap` sits in the
 * co-signed state (`encodeState`), so this MUST equal the fleet bot's cap
 * (`QUANTUM_POKER_HAND_CAP = 50` in rust/fleet/core/src/play_match.rs) — a divergent cap makes the
 * bot compute a different stateHash for the very first commit and silently reject it (the
 * "Shuffling · opponent's turn" stall). Was 180n (a solo self-play tuning value no PvP peer checks).
 */
export const QUANTUM_POKER_HAND_CAP = 50n;

/**
 * Hands per tunnel for the in-app Bot/Auto lanes before a cooperative close. The transcript carries
 * one fixed 250 B entry per off-chain update (~19 updates/hand ≈ 4.75 KB/hand; the hand state is
 * hashed into the 32-byte stateHash, never in the message). The backend `/settle` body cap is 32 MB,
 * so a tunnel fits ~7000 hands before overflow (→ 413, silent fallback to a direct close with no
 * Walrus proof); 2500 leaves a wide margin (~12 MB, ~35%). A higher cap means fewer settle gaps and
 * higher self-play TPS, traded against a bigger settle body and a longer cooperative close — being
 * tuned by benchmark (180 → 800 → 1500 → 2500).
 */
export const QUANTUM_POKER_HANDS_PER_TUNNEL = 2500n;

/** Locked per seat for the PvP/agent tunnel lane, in whole MTPS (0 decimals; ADR-0023). 100 buy-in
 *  at ante 1 keeps the 100:1 stack-to-ante ratio of the old 5000/50 economy, so the bots still bet
 *  across streets and tunnels reach HAND_CAP before a bust — just denominated in whole tokens. */
export const QUANTUM_POKER_STAKE = 100n;

/**
 * Per-seat buy-in for the PvP lane, in chips. chips == raw MTPS (1:1, 0 decimals), so this is also
 * the raw stake locked per seat per round. Kept equal to QUANTUM_POKER_STAKE. At 100/ante 1 a seat
 * still busts within HAND_CAP, but is deep enough to bet across streets (more action before the
 * all-in) instead of shoving on the first raise.
 */
export const POKER_BUYIN = 100n;

/**
 * Per-hand ante posted by both seats, in whole MTPS (0 decimals; ADR-0023). The protocol defaults
 * to a 9-decimal-era 50; the app passes this smaller value so the chip economy scales to whole-token
 * stakes (buy-in 100 : ante 1 == the old 5000 : 50 ratio, preserving bot bust/hand-cap behavior).
 */
export const QUANTUM_POKER_ANTE = 1n;
