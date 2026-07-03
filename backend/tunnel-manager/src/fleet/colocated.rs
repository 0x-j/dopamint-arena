//! Co-located arena bots (ADR-0024 + ADR-0005 co-location): the bot's play task is spawned at
//! `arena.join`, **on the same instance as the user's WebSocket**, so every relayed frame stays
//! in-process (no cross-instance hop). It is NOT spawned at `allocate` — allocate only writes a
//! small shared reservation recipe (`{game, seat_b, tunnel_id, eph_secret}`) to the control store
//! via [`reserve_arena_slot_on`]/`put_arena_reservation`, which ANY instance can read to reconstruct
//! party B when the user actually shows up.
//!
//! **Still pure on-demand:** one short-lived task per real match, no warm pool. Because the spawn
//! trigger is the join (not the allocate), a user who allocates but never joins spawns nothing — the
//! reservation simply TTL-expires. The on-chain tunnel + seat-B funding happen in the `allocate`
//! handler (`SuiArenaOpener`), independent of the bot task; the bot resolves the pre-created tunnel
//! and co-signs with the per-match ephemeral key it re-derives from the reservation recipe.

use anyhow::bail;
use transcript_store::TranscriptChunkWriter;
use transcript_stream::{ChunkUpload, S3StreamingRecorder};
use tunnel_harness::{Signer, TranscriptRecorder};

use fleet_core::match_channel::MatchChannel;
use fleet_core::play_match::{
    play_battleship, play_blackjack_v2, play_bomb_it, play_caro, play_chicken_cross, play_flash,
    play_quantum_poker, play_regular_payments, play_tic_tac_toe, play_world_canvas, profile_for,
};
use fleet_core::signer_durable::DurableSigner;
use fleet_core::Role;

use crate::fleet::arena_anchor::RelayBridgedAnchor;
use crate::fleet::bus_transport::{BusRelayConnection, BusRelayTransport};
use crate::mp::protocol::ServerMsg;
use crate::mp::MatchRecord;
use crate::state::SharedState;
use crate::store::{ArenaClaim, ConnRef};

#[cfg(test)]
use crate::store::ArenaReservation;

/// Per-spawn sequence for distinct placeholder seat-B identities when no wallet pool is configured —
/// a fixed index would make every concurrent match of a game share one seat-B address.
static ONDEMAND_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// The recipe minted at `allocate` for one arena match: a globally-unique match id, seat-B identity
/// (both keys the FE needs to build the open PTB), and the per-match co-signing secret persisted in
/// the reservation so the join-instance can reconstruct party B. No running task, no pool slot.
pub struct ArenaSlot {
    pub match_id: String,
    pub bot_address: String,
    pub eph_pubkey: String,
    pub eph_secret_hex: String,
}

/// Test convenience: check out a fresh address AND mint a recipe in one call. Production goes through
/// `checkout_bot_address` + `reserve_arena_slot_on` so a whole allocate batch shares one seat-B
/// address (Design 1); this single-address-per-slot shape is only what the tests want.
#[cfg(test)]
pub fn reserve_arena_slot(state: &SharedState, game: &str) -> ArenaSlot {
    reserve_arena_slot_on(checkout_bot_address(state, game))
}

/// Check out one funded seat-B on-chain address (round-robin over the pool, or a distinct placeholder
/// per call when no pool is configured). Split out so the batch opener can check out ONE address for a
/// whole allocate request — Design 1 batching shares party B across a request's tunnels because
/// `deposit_party_b` asserts `sender == party_b` and a single PTB has one sender.
pub fn checkout_bot_address(state: &SharedState, game: &str) -> String {
    match state.wallet_pool.as_ref().map(|p| p.checkout_address()) {
        Some(Ok(addr)) => addr,
        Some(Err(e)) => {
            tracing::warn!("wallet pool checkout failed, using placeholder: {e:#}");
            bot_address(
                game,
                ONDEMAND_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            )
        }
        None => bot_address(
            game,
            ONDEMAND_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ),
    }
}

/// Mint a match recipe on an ALREADY-CHOSEN seat-B address. Each call still gets its own match id +
/// per-match ephemeral co-signing key (only the on-chain address is shared across a batch); the
/// distinct ephemeral key is what keeps per-match identity — settlement authenticates by pubkey, not
/// address, so N tunnels can share one party-B address safely.
pub fn reserve_arena_slot_on(bot_address: String) -> ArenaSlot {
    let secret = random_secret();
    let match_key = DurableSigner::from_secret(&secret);
    ArenaSlot {
        match_id: format!("arena_{}", uuid::Uuid::new_v4().simple()),
        bot_address,
        eph_pubkey: hex::encode(match_key.public_key()),
        eph_secret_hex: hex::encode(secret),
    }
}

/// The user's `arena.join` landed here: atomically claim the reserved match, then spawn the bot on
/// THIS instance (co-located with the user's socket) and pair them. Exactly one join ever claims a
/// given match, so a reconnect/double-mount second join is a no-op (`unknown_arena_match`), not a
/// second bot. Returns an error code for the WS layer to relay to the client.
pub async fn join_and_spawn(
    state: &SharedState,
    match_id: &str,
    user_conn: ConnRef,
    wallet: &str,
    // Flash Play (chat) mode opts in via the `arena.join` message; the co-located bot then answers
    // with the LLM. Spectator (bot-vs-bot) and every non-chat game leave it false → Markov reply.
    chat_llm: bool,
) -> Result<(), &'static str> {
    let rec = match state.mp.claim_arena(match_id, wallet).await {
        ArenaClaim::Claimed(rec) => rec,
        // Not seeded here / expired, a foreign wallet, or already claimed by a prior join all present
        // to the client as the same opaque "no such match" — the FE reconnect path is `resume`, not a
        // second `arena.join`.
        ArenaClaim::NotFound | ArenaClaim::ForeignWallet | ArenaClaim::AlreadyClaimed => {
            return Err("unknown_arena_match")
        }
    };

    // Per-instance backpressure: bound concurrent bot tasks on this box (total = cap × instances).
    // We already claimed; a rare over-cap join wastes the reservation (it TTL-expires).
    if !state.fleet.admit_arena(state.arena_fleet_count.max(1)) {
        tracing::warn!(match_id, "arena join refused: instance at capacity");
        return Err("arena_at_capacity");
    }

    let Some(secret) = secret_from_hex(&rec.eph_secret_hex) else {
        state.fleet.release_arena();
        tracing::error!(
            match_id,
            "arena reservation carried an unreadable eph secret"
        );
        return Err("unknown_arena_match");
    };
    let match_key = DurableSigner::from_secret(&secret);

    // The bot's virtual relay connection, registered on THIS instance next to the user's socket.
    let conn = BusRelayConnection::register(state.clone());
    let match_record = MatchRecord {
        game: rec.game.clone(),
        seat_a: wallet.to_owned(),
        seat_b: rec.seat_b.clone(),
        conn_a: user_conn.clone(),
        conn_b: conn.conn_ref(),
        tunnel_id: Some(rec.tunnel_id.clone()),
        latest_checkpoint: None,
    };
    // Routing must be live before the bot's first frame, or the hello is dropped and the handshake
    // deadlocks — persist the record, then announce to the user (party A) and warm its relay cache,
    // exactly as the former rendezvous `complete` did. Both conns are local here, so this is cheap.
    state.mp.put_match(match_id, match_record.clone()).await;
    state
        .bus
        .deliver(
            &user_conn,
            ServerMsg::MatchFound {
                match_id: match_id.to_owned(),
                role: "A".into(),
                opponent_wallet: rec.seat_b.clone(),
                game: rec.game.clone(),
            }
            .to_text(),
        )
        .await;
    state
        .bus
        .populate(&user_conn, match_id, &match_record)
        .await;
    tracing::info!(
        match_id,
        game = %rec.game,
        tunnel = %rec.tunnel_id,
        "co-located arena match started"
    );

    // Spawn the one-shot play task. It drives to settlement, then frees its admission slot. The bot's
    // opponent is the joiner (party A) — `rec.seat_a`, which `claim_arena` verified equals `wallet`.
    let st = state.clone();
    let match_id = match_id.to_owned();
    // Stream this match's co-signed transcript to S3 during play (both `None` = no S3, dev/test).
    let chunk_upload_tx = state.chunk_upload_tx.clone();
    let chunk_writer = state.chunk_writer.clone();
    // Flash chat mode: hand the bot an Ollama-backed reply oracle. It falls back to the offline
    // Markov reply on any miss, so a missing/slow model never stalls the match. Only built when the
    // joining client opted in (Play, not Spectator) and only consumed by the flash arm.
    let responder: Option<std::sync::Arc<dyn tunnel_flash::ChatResponder>> = if chat_llm {
        tracing::info!(match_id, "flash chat: LLM reply oracle attached");
        Some(std::sync::Arc::new(
            crate::flash_responder::OllamaFlashResponder::new(state.ollama.clone()),
        ))
    } else {
        None
    };
    tokio::spawn(async move {
        if let Err(e) = drive_arena_bot(
            &rec.game,
            &match_id,
            &rec.tunnel_id,
            &rec.seat_a,
            rec.created_at_ms,
            match_key,
            secret,
            conn,
            chunk_upload_tx,
            chunk_writer,
            responder,
        )
        .await
        {
            tracing::debug!(match_id = %match_id, game = %rec.game, "arena match ended: {e:#}");
        }
        st.fleet.release_arena();
    });
    Ok(())
}

/// Drive the co-located bot (party B) to settlement over the relay bus. The tunnel already exists
/// (created at allocate); `RelayBridgedAnchor::open` resolves it with no chain call. There is no
/// join wait or wake — the bot is spawned already paired with a live `MatchRecord`.
#[allow(clippy::too_many_arguments)]
async fn drive_arena_bot(
    game: &str,
    match_id: &str,
    tunnel_id: &str,
    opponent_wallet: &str,
    created_at_ms: u64,
    match_key: DurableSigner,
    secret: [u8; 32],
    conn: std::sync::Arc<BusRelayConnection>,
    chunk_upload_tx: Option<tokio::sync::mpsc::Sender<ChunkUpload>>,
    chunk_writer: Option<std::sync::Arc<dyn TranscriptChunkWriter>>,
    responder: Option<std::sync::Arc<dyn tunnel_flash::ChatResponder>>,
) -> anyhow::Result<()> {
    // The FE's bare `forfeit` frame is diverted out-of-band by the bot's transport onto this channel;
    // `play_game` races it against play and leads a forced close. One-shot (`(1)` capacity).
    let (forfeit_tx, forfeit_rx) = tokio::sync::mpsc::channel::<()>(1);
    let transport =
        BusRelayTransport::new(conn.clone(), match_id.to_owned()).forfeit_to(forfeit_tx);
    let channel = MatchChannel::new(transport);
    // `created_at` is captured at allocate and carried in the reservation — the bot does ZERO chain IO
    // before its first move. A slow Sui RPC HERE previously left the bot spawned but silent (no hello,
    // no move): the "bot never moves" bug. It is used only to sign the SETTLE timestamp; the FE reads
    // the same on-chain field, so both halves commit to equal timestamp bytes.
    tracing::info!(
        match_id = %match_id,
        game = %game,
        created_at_ms,
        "arena bot entering play (created_at from reservation, no chain IO)"
    );
    // A second anchor for the forfeit path: the play anchor is MOVED into the driver future (dropped
    // on forfeit), so leading the forced-close half needs an independent handle. Both share the same
    // relay `conn` (Arc), tunnel id, and `created_at`, so the forced half commits to identical bytes.
    let forfeit_anchor = RelayBridgedAnchor::new(
        tunnel_id.to_owned(),
        conn.clone(),
        match_id.to_owned(),
        created_at_ms,
    );
    let anchor = RelayBridgedAnchor::new(
        tunnel_id.to_owned(),
        conn,
        match_id.to_owned(),
        created_at_ms,
    );
    let moves = play_game(
        game,
        channel,
        anchor,
        match_key,
        secret,
        forfeit_anchor,
        forfeit_rx,
        opponent_wallet,
        tunnel_id,
        chunk_upload_tx,
        chunk_writer,
        responder,
    )
    .await?;
    tracing::info!(
        match_id = %match_id,
        game = %game,
        tunnel = %tunnel_id,
        moves,
        "co-located arena match settled",
    );
    Ok(())
}

/// Drive the bot (party B) through one match of `game` over `channel`, settling via `anchor`. The
/// transport/anchor are game-agnostic; this is the one place protocol+strategy are chosen, so adding
/// a game is a single arm here — once its Rust protocol byte-matches the FE's TS protocol (verified
/// by a cross-language golden test) and it has a `MoveStrategy`. Returns the move count.
#[allow(clippy::too_many_arguments)]
async fn play_game(
    game: &str,
    channel: MatchChannel<BusRelayTransport>,
    anchor: RelayBridgedAnchor,
    match_key: DurableSigner,
    secret: [u8; 32],
    forfeit_anchor: RelayBridgedAnchor,
    mut forfeit_rx: tokio::sync::mpsc::Receiver<()>,
    opponent_wallet: &str,
    tunnel_id: &str,
    chunk_upload_tx: Option<tokio::sync::mpsc::Sender<ChunkUpload>>,
    chunk_writer: Option<std::sync::Arc<dyn TranscriptChunkWriter>>,
    // Flash chat mode only: the LLM reply oracle. `None` → the offline Markov reply; every other
    // game ignores it (they aren't chat protocols).
    responder: Option<std::sync::Arc<dyn tunnel_flash::ChatResponder>>,
) -> anyhow::Result<u64> {
    // The tunnel's full pot = both seats' stake. Sourced from the game's `GameProfile` — the SAME
    // per-seat stake `play_match` co-signs the initial balances against and the FE echoes as
    // `allocation.stakeEach` — so the forced `(0, total)` split sums to the on-chain total. `None`
    // only for an unwired game, whose match arm bails before any forfeit branch runs.
    let forfeit_total = profile_for(game).map(|p| 2 * p.stake_each);
    // Every game drives the identical party-B seam (Role::B + a fresh transcript recorder); only the
    // protocol's `play_*` entry differs, so each game is one arm. The recorder folds the O(log N) root
    // AND streams the co-signed transcript to S3 in chunks during play through the shared bounded
    // uploader (`chunk_upload_tx`); `finish()` flushes the tail + seals the manifest via `chunk_writer`.
    // A clone drives the game while the retained handle finishes. Both `None` (dev/test) → root only.
    macro_rules! play {
        // Standard games: fixed party-B seam, no extra strategy input.
        ($play_fn:ident) => {{
            let recorder = S3StreamingRecorder::new(tunnel_id, chunk_upload_tx, chunk_writer);
            // Race play against an inbound forfeit. On a natural terminal, seal on EVERY exit
            // (including abandon: a disconnect makes `$play_fn` return Err, so finishing before `?`
            // flushes the tail + seals the manifest). On forfeit, `select!` DROPS the driver future —
            // a clean cancellation because `record` is synchronous, so the shared root/buffer is never
            // torn — then the RETAINED recorder handle (Arc-shared state with the driver's clone) yields
            // the real folded root and seals S3. The bot LEADS the forced `(0, total)` half over that
            // root; the FE pairs it and submits the cooperative close.
            // `biased;` + the play arm FIRST: a completed natural close must always win over a
            // same-poll forfeit signal. Without it, `select!`'s random poll order can, on a
            // forfeit-then-terminal-move back-to-back arrival, take the forfeit arm even though
            // `$play_fn` already emitted the natural `settleHalf` as a side effect — sending the
            // FE a second, conflicting `(0, total)` half. Polling top-to-bottom means the forfeit
            // arm is only ever taken while the driver is genuinely `Pending`.
            tokio::select! {
                biased;
                result = $play_fn(
                    channel,
                    anchor,
                    match_key,
                    Role::B,
                    opponent_wallet,
                    recorder.clone(),
                ) => {
                    recorder.finish().await;
                    result?.moves
                }
                _ = forfeit_rx.recv() => {
                    let root = recorder.canonical_root_for_tunnel(tunnel_id)?;
                    let Some(total) = forfeit_total else {
                        anyhow::bail!("no GameProfile for {game}; cannot compute forfeit total");
                    };
                    forfeit_anchor
                        .emit_forfeit_half(total, root, &DurableSigner::from_secret(&secret))
                        .await;
                    recorder.finish().await;
                    0
                }
            }
        }};
        // Flash chat: same seam plus the optional LLM responder (last arg).
        ($play_fn:ident, $responder:expr) => {{
            let recorder = S3StreamingRecorder::new(tunnel_id, chunk_upload_tx, chunk_writer);
            let result = $play_fn(
                channel,
                anchor,
                match_key,
                Role::B,
                opponent_wallet,
                recorder.clone(),
                $responder,
            )
            .await;
            recorder.finish().await;
            result?.moves
        }};
    }
    let moves = match game {
        "blackjack" => play!(play_blackjack_v2),
        "quantum_poker" => play!(play_quantum_poker),
        "bomb_it" => play!(play_bomb_it),
        "chicken_cross" => play!(play_chicken_cross),
        "world_canvas" => play!(play_world_canvas),
        "tic_tac_toe" => play!(play_tic_tac_toe),
        "caro" => play!(play_caro),
        "battleship" => play!(play_battleship),
        "regular_payments" => play!(play_regular_payments),
        "flash" => play!(play_flash, responder),
        other => bail!("co-located fleet has no protocol wired for game '{other}'"),
    };
    Ok(moves)
}

/// A bot's stable on-chain address — distinct per (game, idx), the same across its matches (only
/// the per-match co-signing key rotates). Placeholder identity for the scaffold; a real fleet loads
/// funded per-bot accounts from a durable store / KMS.
fn bot_address(game: &str, idx: u32) -> String {
    format!("0x{}", hex::encode(identity_secret(game, idx)))
}

/// Deterministic, distinct-per-(game, idx) identity secret. Placeholder for a durable/KMS key.
fn identity_secret(game: &str, idx: u32) -> [u8; 32] {
    let mut s = [0u8; 32];
    s[..4].copy_from_slice(&idx.to_le_bytes());
    let g = game.as_bytes();
    let n = g.len().min(27);
    s[4..4 + n].copy_from_slice(&g[..n]);
    s[31] = 0xb0; // fleet-bot marker (cosmetic)
    s
}

/// A random 32-byte per-match ephemeral secret, from the already-present `uuid` v4 RNG (two uuids =
/// 32 random bytes) — no extra crypto dependency for a scaffold key.
fn random_secret() -> [u8; 32] {
    let mut s = [0u8; 32];
    s[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    s[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    s
}

/// Decode the 32-byte per-match co-signing secret persisted in the reservation.
fn secret_from_hex(hex_str: &str) -> Option<[u8; 32]> {
    hex::decode(hex_str).ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use tunnel_harness::InMemoryTranscriptRecorder;

    // `reserve_arena_slot` mints a globally-unique recipe with a distinct per-match key each call —
    // two concurrent matches must never share a match id or a co-signing secret.
    #[test]
    fn reserve_arena_slot_mints_a_unique_recipe() {
        let state = AppState::in_memory_for_test();
        let a = reserve_arena_slot(&state, "blackjack");
        let b = reserve_arena_slot(&state, "blackjack");
        assert_ne!(a.match_id, b.match_id, "match ids are globally unique");
        assert_ne!(a.eph_secret_hex, b.eph_secret_hex, "keys are per-match");
        assert_eq!(a.eph_secret_hex.len(), 64, "32-byte secret encoded as hex");
        assert!(!a.bot_address.is_empty() && !a.eph_pubkey.is_empty());
    }

    // A second `arena.join` for an already-claimed match must NOT spawn a second bot — the atomic
    // claim admits exactly one joiner. This is what makes a reconnect / StrictMode double-mount safe.
    #[tokio::test]
    async fn second_join_is_rejected_not_double_spawned() {
        let state = AppState::in_memory_for_test();
        let slot = reserve_arena_slot(&state, "blackjack");
        state
            .mp
            .put_arena_reservation(
                &slot.match_id,
                ArenaReservation {
                    game: "blackjack".into(),
                    seat_a: "0xuser".into(),
                    seat_b: slot.bot_address.clone(),
                    tunnel_id: "0xdead".into(),
                    eph_secret_hex: slot.eph_secret_hex.clone(),
                    created_at_ms: 0,
                },
            )
            .await;

        let c1 = BusRelayConnection::register(state.clone());
        join_and_spawn(&state, &slot.match_id, c1.conn_ref(), "0xuser", false)
            .await
            .expect("first join claims + spawns");
        let c2 = BusRelayConnection::register(state.clone());
        assert_eq!(
            join_and_spawn(&state, &slot.match_id, c2.conn_ref(), "0xuser", false).await,
            Err("unknown_arena_match"),
            "a second join finds the match already claimed"
        );
    }

    // A foreign wallet cannot claim another user's reserved match.
    #[tokio::test]
    async fn join_rejects_foreign_wallet() {
        let state = AppState::in_memory_for_test();
        let slot = reserve_arena_slot(&state, "blackjack");
        state
            .mp
            .put_arena_reservation(
                &slot.match_id,
                ArenaReservation {
                    game: "blackjack".into(),
                    seat_a: "0xowner".into(),
                    seat_b: slot.bot_address.clone(),
                    tunnel_id: "0xdead".into(),
                    eph_secret_hex: slot.eph_secret_hex.clone(),
                    created_at_ms: 0,
                },
            )
            .await;
        let c = BusRelayConnection::register(state.clone());
        assert_eq!(
            join_and_spawn(&state, &slot.match_id, c.conn_ref(), "0xattacker", false).await,
            Err("unknown_arena_match"),
            "only the allocator may join"
        );
    }

    // The placeholder identity must be stable per bot and distinct across bots, so two bots never
    // collide on the same on-chain address.
    #[test]
    fn bot_address_is_stable_and_distinct() {
        assert_eq!(bot_address("blackjack", 0), bot_address("blackjack", 0));
        assert_ne!(bot_address("blackjack", 0), bot_address("blackjack", 1));
        assert_ne!(bot_address("blackjack", 0), bot_address("caro", 0));
    }

    // The whole co-located arena seam end to end over the REAL relay bus: `arena.join` (`join_and_spawn`)
    // claims the reservation, spawns party B on THIS instance, and pairs it with a stand-in human
    // (party A) that joined by match id — proving the recipe alone lets any instance build the bot and
    // play a genuine two-party match to settlement, with no rendezvous/wake and no cross-instance hop.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn join_and_spawn_settles_against_a_stand_in_human() {
        use fleet_core::play_match::{play_blackjack_v2, BLACKJACK};
        use std::time::Duration;

        const TUNNEL_ID: &str = "0xdead";
        let state = AppState::in_memory_for_test();

        // Allocate: mint the recipe + seed the shared reservation (what `arena_allocate` does).
        let slot = reserve_arena_slot(&state, "blackjack");
        let match_id = slot.match_id.clone();
        state
            .mp
            .put_arena_reservation(
                &match_id,
                ArenaReservation {
                    game: "blackjack".into(),
                    seat_a: "0xuser".into(),
                    seat_b: slot.bot_address.clone(),
                    tunnel_id: TUNNEL_ID.into(),
                    eph_secret_hex: slot.eph_secret_hex.clone(),
                    created_at_ms: 0,
                },
            )
            .await;

        // Human side: register the relay conn (the WS), then join — which claims + spawns the bot HERE.
        let human_conn = BusRelayConnection::register(state.clone());
        join_and_spawn(&state, &match_id, human_conn.conn_ref(), "0xuser", false)
            .await
            .expect("join claims the reservation and spawns the bot");

        // `match.found` arrives first (before the bot's hello), the same ordering the FE follows.
        let first = human_conn
            .recv_for_test()
            .await
            .expect("human receives a frame");
        assert!(
            first.contains("match.found"),
            "first inbound frame must be the match announcement, got: {first}"
        );

        let human_transport = BusRelayTransport::new(human_conn.clone(), match_id.clone());
        let human_channel = MatchChannel::new(human_transport);
        let human_anchor =
            RelayBridgedAnchor::new(TUNNEL_ID.to_owned(), human_conn, match_id.clone(), 0);
        let human = play_blackjack_v2(
            human_channel,
            human_anchor,
            DurableSigner::from_secret(&[42u8; 32]),
            Role::A,
            &slot.bot_address,
            InMemoryTranscriptRecorder::new(),
        );

        // Bound the wait so a genuine bot-side hang fails the test instead of stalling CI until the
        // global job timeout. The bound must clear a REAL match's wall-clock on a loaded CI runner:
        // `cargo test` runs the whole backend suite in parallel and oversubscribes the box's cores,
        // where an equivalent stand-in match (bot-fleet's `bot_plays_a_full_match…`) legitimately
        // takes ~90s — so the former 10s fired spuriously. 180s still catches a true deadlock (which
        // never completes) while tolerating a slow, contended runner.
        let human_outcome = tokio::time::timeout(Duration::from_secs(180), human)
            .await
            .expect("the match settles in time")
            .expect("human (party A) plays to settlement over the bus");
        assert!(human_outcome.moves > 0, "the match actually progressed");
        assert_eq!(
            human_outcome.final_balances.sum(),
            2 * BLACKJACK.stake_each,
            "stakes are conserved across the genuine two-party match",
        );
    }

    // Test-only `RelayTransport` wrapper around the human's real bus transport: flags the first
    // real game-move envelope (`{"t":"frame",...}`, either direction — a proposed move or its ack)
    // it observes. Lets the forfeit-seal test below know, without a fixed sleep, that the bot's
    // recorder has almost certainly folded at least one entry before injecting forfeit — the wait
    // is bounded by the actual match progressing, not a guessed duration that could race a loaded
    // CI runner.
    struct MoveWatchTransport {
        inner: BusRelayTransport,
        frames_seen: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl fleet_core::relay_ws::RelayTransport for MoveWatchTransport {
        async fn send_payload(
            &self,
            payload: Vec<u8>,
        ) -> Result<(), tunnel_harness::FrameTransportError> {
            if String::from_utf8_lossy(&payload).contains("\"t\":\"frame\"") {
                self.frames_seen
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            self.inner.send_payload(payload).await
        }

        async fn recv_payload(
            &self,
        ) -> Result<Option<Vec<u8>>, tunnel_harness::FrameTransportError> {
            let got = self.inner.recv_payload().await?;
            if let Some(bytes) = &got {
                if String::from_utf8_lossy(bytes).contains("\"t\":\"frame\"") {
                    self.frames_seen
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
            Ok(got)
        }
    }

    // The forfeit branch of the `play!` macro's `select!` must reach `recorder.finish()` and seal a
    // real manifest — the money-adjacent regression the Task 5 review flagged: a `select!` silently
    // DROPS the non-winning branch's future, so a future edit that moved the seal onto the play_fn
    // branch alone (relying on the recorder's `Drop`, never actually calling `finish()`) would lose
    // the tail chunk on every forfeit and pass every OTHER test (which never forfeits). This drives
    // a real match (tic_tac_toe: few, fast, deterministic moves) far enough to fold at least one
    // transcript entry, forfeits, and asserts the S3 chunk store actually received a sealed manifest
    // — the same seal path (`writer.put_chunk` + `writer.seal`) the natural-terminal arm takes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn forfeit_path_seals_the_recorder_not_a_select_drop() {
        use fleet_core::play_match::play_tic_tac_toe;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Duration;
        use transcript_store::testing::FakeChunkStore;
        use transcript_store::TranscriptChunkReader;

        const TUNNEL_ID: &str = "0xdeadfeed";

        let fake = std::sync::Arc::new(FakeChunkStore::default());
        // `in_memory_for_test` has no seam for a chunk writer; unwrap the freshly-minted (single-
        // owner) Arc to inject one, mirroring the explorer crate's `testing`-feature pattern.
        let mut inner = std::sync::Arc::try_unwrap(AppState::in_memory_for_test())
            .ok()
            .expect("freshly constructed state has a single owner");
        inner.chunk_writer =
            Some(fake.clone() as std::sync::Arc<dyn transcript_store::TranscriptChunkWriter>);
        let state: SharedState = std::sync::Arc::new(inner);

        let slot = reserve_arena_slot(&state, "tic_tac_toe");
        let match_id = slot.match_id.clone();
        state
            .mp
            .put_arena_reservation(
                &match_id,
                ArenaReservation {
                    game: "tic_tac_toe".into(),
                    seat_a: "0xuser".into(),
                    seat_b: slot.bot_address.clone(),
                    tunnel_id: TUNNEL_ID.into(),
                    eph_secret_hex: slot.eph_secret_hex.clone(),
                    created_at_ms: 0,
                },
            )
            .await;

        let human_conn = BusRelayConnection::register(state.clone());
        join_and_spawn(&state, &match_id, human_conn.conn_ref(), "0xuser", false)
            .await
            .expect("join claims the reservation and spawns the bot");
        human_conn
            .recv_for_test()
            .await
            .expect("human receives match.found");

        let frames_seen = std::sync::Arc::new(AtomicUsize::new(0));
        let human_transport = MoveWatchTransport {
            inner: BusRelayTransport::new(human_conn.clone(), match_id.clone()),
            frames_seen: frames_seen.clone(),
        };
        let human_channel = MatchChannel::new(human_transport);
        let human_anchor = RelayBridgedAnchor::new(
            TUNNEL_ID.to_owned(),
            human_conn.clone(),
            match_id.clone(),
            0,
        );
        let bot_address = slot.bot_address.clone();
        let human_play = tokio::spawn(async move {
            play_tic_tac_toe(
                human_channel,
                human_anchor,
                DurableSigner::from_secret(&[42u8; 32]),
                Role::A,
                &bot_address,
                tunnel_harness::NullTranscriptRecorder,
            )
            .await
        });

        // Wait for a full round trip (a proposed move + its ack — 2 frame envelopes) so the bot's
        // recorder has actually folded an entry, not just seen a proposal in flight.
        let progressed = tokio::time::timeout(Duration::from_secs(10), async {
            while frames_seen.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(
            progressed.is_ok(),
            "the match exchanged a real move before forfeit (no hang)"
        );

        human_conn
            .send_to_peer(&match_id, r#"{"t":"forfeit"}"#.to_owned())
            .await;

        // Bounded poll, not a fixed sleep: fails fast on a genuine regression (finish() skipped)
        // instead of racing wall-clock, and doesn't wait longer than the match actually needs.
        let sealed = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if fake
                    .read_manifest(TUNNEL_ID)
                    .await
                    .expect("fake store never errors")
                    .is_some()
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(
            sealed.is_ok(),
            "forfeit must seal the transcript manifest (recorder.finish() reached the writer), \
             not truncate the tail via a select! drop"
        );

        human_play.abort();
    }
}
