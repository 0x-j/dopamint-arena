//! Per-match orchestration a bot runs after `match.found`, layered on the merged
//! `tunnel_harness::PartyDriver` (PR #131). The driver now brackets the whole match —
//! `anchor.open` → co-signed move loop → `anchor.settle` — so our job shrinks to the relay-side
//! ephemeral-key exchange (learn the opponent's co-signing pubkey) and then handing the driver our
//! demuxed frame transport + the chosen [`tunnel_harness::TunnelAnchor`].
//!
//! Adding a game is still data: a [`GameProfile`] (id + stake) plus the [`Protocol`] and its
//! [`MoveStrategy`]. The anchor is the swap point: `InMemoryAnchor` drives a full off-chain match
//! (bot-vs-bot, both seats sharing one anchor instance); the Sui anchor / a relay-bridged anchor is
//! the on-chain genuine-two-party path.

use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use tunnel_battleship::{Battleship, BattleshipStrategy};
use tunnel_blackjack::v2::{BlackjackV2, BlackjackV2Strategy};
use tunnel_blackjack::{Blackjack, BlackjackStrategy};
use tunnel_bomb_it::{BombIt, BombItStrategy};
use tunnel_caro::{CaroSeries, CaroSeriesStrategy, CaroStrength};
use tunnel_cross::{Cross, CrossStrategy};
use tunnel_flash::{ChatResponder, Flash, FlashStrategy};
use tunnel_harness::{
    Balances, DriverOutcome, DriverRunControl, MoveStrategy, PartyDriver, Protocol, SeatParts,
    Signer, TranscriptRecorder, TunnelAnchor,
};
use tunnel_payments::{PayMove, Payments, RegularPayments, ShopPosStrategy};
use tunnel_quantum_poker::{QuantumPoker, QuantumPokerStrategy};
use tunnel_tic_tac_toe::{TicTacToeDifficulty, TicTacToeSeries, TicTacToeSeriesStrategy};
use tunnel_world_canvas::{WorldCanvasStroke, WorldCanvasStrokeStrategy};

use crate::match_channel::MatchChannel;
use crate::peer::PeerMsg;
use crate::relay_ws::RelayTransport;
use crate::signer_durable::DurableSigner;
use crate::{MatchInfo, Role};

/// Per-tunnel move budget (matches the canonical MAX_MOVES_PER_TUNNEL ceiling).
const MAX_MOVES: u64 = 100_000;

/// The static per-game config. `host` is gone vs the pre-merge harness: the merged `TunnelAnchor`
/// is symmetric (both seats `open` idempotently and `settle` their own half), so no seat is "the
/// opener". What remains differs between games: the matchmaking id and the per-seat stake.
#[derive(Clone, Copy, Debug)]
pub struct GameProfile {
    /// The matchmaking queue id (`queue.join`), matching the FE's game id.
    pub game_id: &'static str,
    pub stake_each: u64,
}

/// Blackjack profile: stake 1000 MTPS each (0 decimals → integer `1000`). The arena FE co-signs
/// `allocation.stakeEach` (this value, echoed by the backend) — NOT the FE `DEFAULT_STAKE` (100,
/// which is the human-vs-human buy-in default) — so bot and browser agree on the initial off-chain
/// balances (a divergent stake would break co-signing). Must be ≥ `MIN_BET` (25)
/// or `is_terminal` fires at the initial state and the match settles with zero moves. Match length
/// is bounded by the protocol's `ROUND_CAP`, not the bankroll. (No host — see [`GameProfile`].)
pub const BLACKJACK: GameProfile = GameProfile {
    game_id: "blackjack",
    stake_each: 1000,
};

/// Quantum Poker profile: stake 100 MTPS per seat (the bankroll), ante 1 per hand, 50-hand cap —
/// matching the FE PvP hook (`POKER_BUYIN = 100`, `HAND_CAP = 50`, `ANTE = 1`, the "100:1 == old
/// 5000:50 ratio" in `frontend/.../quantumPoker/constants.ts`) so the bot and the FE agree on the
/// INITIAL co-signed balances. A divergent stake makes the bot compute different party balances than
/// the browser and reject its first move (`frame balances mismatch`). Real MTPS only moves at
/// open/settle; intra-match bets draw against the staked bankroll off-chain.
pub const QUANTUM_POKER: GameProfile = GameProfile {
    game_id: "quantum_poker",
    stake_each: 100,
};

/// Bomb It profile: stake 500 MTPS per seat, matching the FE generic-hook spec (`stake: 500n`) so
/// the bot's pre-created tunnel and the user's deposit agree on the initial off-chain balances. The
/// move is JSON-native and `encode_state`/seed are byte-identical to the TS `BombItProtocol`
/// (verified by read-compare of both sides), so the bot co-signs against the unchanged FE.
pub const BOMB_IT: GameProfile = GameProfile {
    game_id: "bomb_it",
    stake_each: 500,
};

/// Chicken Cross profile: stake 500 MTPS per seat, matching the FE generic-hook spec (`stake: 500n`).
/// Same parity guarantee as [`BOMB_IT`] (JSON moves, byte-identical `encode_state`/seed vs the TS
/// `CrossProtocol`). The arena id is the underscored FE registry id (`chicken-cross`).
pub const CHICKEN_CROSS: GameProfile = GameProfile {
    game_id: "chicken_cross",
    stake_each: 500,
};

/// World Canvas profile: stake 1 MTPS per seat, matching the FE generic-hook spec (`stake: 1n`) — a
/// free/draw co-draw, balances never move. The co-signed state is a 32-byte rolling digest
/// (`encode_state` = the digest), byte-identical to the TS `WorldCanvasPvpProtocol` once the FE name
/// matches the Rust `world_canvas.stroke.v1` (so the genesis digest agrees). NEVER terminal — the
/// match plays until the human's window closes.
pub const WORLD_CANVAS: GameProfile = GameProfile {
    game_id: "world_canvas",
    stake_each: 1,
};

/// Tic-Tac-Toe profile: stake 1, matching the FE `MultiGameTicTacToeProtocol` (`tic_tac_toe.series.v2`).
/// The fleet drives the SERIES wrapper at max_games=1 (the FE const; the Rust series only state-matches
/// the FE at 1 game — it omits the FE's per-game opener alternation). Move `salt` is bare-hex JSON
/// (verified golden); encode_state/name match.
pub const TIC_TAC_TOE: GameProfile = GameProfile {
    game_id: "tic_tac_toe",
    stake_each: 1,
};

/// Caro (gomoku) profile: stake 1, matching the FE `MultiGameCaroProtocol` (`caro.series.v2`), series
/// max_games=1. Board size is PINNED to the FE canonical 15 in [`play_caro`] (the FE carries size in
/// its matchmaking key; the arena path joins by match id, so the bot must hardcode the same size).
pub const CARO: GameProfile = GameProfile {
    game_id: "caro",
    stake_each: 1,
};

/// Battleship profile: stake 1 (FE `STAKE_SHIFT`=1), `battleship.v1` (merkle commit-reveal). Move-wire
/// fixed to the FE codec (bare-hex root/salt/proof, `isShip`) — verified golden; encode_state matches.
pub const BATTLESHIP: GameProfile = GameProfile {
    game_id: "battleship",
    stake_each: 1,
};

/// Regular Payments (Tunnel Mart): shopper budget per seat at arena open — matches FE
/// `DEPOSIT_BUDGET` (`mtps(500)` → 500 whole MTPS). The shop bot (seat B) never initiates;
/// it co-signs catalog-priced A→B moves from the human shopper.
pub const REGULAR_PAYMENTS: GameProfile = GameProfile {
    game_id: "regular_payments",
    stake_each: 500,
};

/// Flash profile: stake 1, `flash.v1`.
pub const FLASH: GameProfile = GameProfile {
    game_id: "flash",
    stake_each: 1,
};

/// Caro's pinned board size — the FE canonical (`PvpScene` default). The arena path can't negotiate
/// it (joins by match id), so both the bot and the FE arena consumer must use this exact size.
const CARO_BOARD_SIZE: usize = 15;

/// Look up the [`GameProfile`] for a game id, or `None` if the fleet has no wired profile for it.
/// The arena allocate path uses this to find the per-seat stake for the opener (ADR-0028); adding a
/// game is a new `const` here + an arm in [`play_game`]'s dispatch.
pub fn profile_for(game: &str) -> Option<GameProfile> {
    match game {
        "blackjack" => Some(BLACKJACK),
        "quantum_poker" => Some(QUANTUM_POKER),
        "bomb_it" => Some(BOMB_IT),
        "chicken_cross" => Some(CHICKEN_CROSS),
        "world_canvas" => Some(WORLD_CANVAS),
        "tic_tac_toe" => Some(TIC_TAC_TOE),
        "caro" => Some(CARO),
        "battleship" => Some(BATTLESHIP),
        "regular_payments" => Some(REGULAR_PAYMENTS),
        "flash" => Some(FLASH),
        _ => None,
    }
}

/// Per-hand ante for the fleet bot's quantum poker. Matches the FE arena `ANTE = 1` (paired with
/// `POKER_BUYIN = 100`). Kept separate from [`QUANTUM_POKER`] because the ante is a
/// protocol-construction param, not a stake. A divergent ante desyncs the co-signed hand state.
const QUANTUM_POKER_ANTE: u64 = 1;

/// Hand cap for the fleet bot's quantum poker, matching the FE `HAND_CAP = 50n`.
const QUANTUM_POKER_HAND_CAP: u64 = 50;

/// Drive one match of ANY game to completion over the relay, on the merged `PartyDriver`.
/// `signer` is this bot's fresh per-match ephemeral key; `match_info.role` is its seat; the
/// `anchor` brackets the on-chain open/settle (its impl decides off-chain vs Sui vs relay-bridged);
/// `recorder` taps the transcript (use `NullTranscriptRecorder` when not archiving).
#[allow(clippy::too_many_arguments)] // game + match + transport + anchor + signer + recorder seams
pub async fn play_match<P, Strat, T, A, R>(
    protocol: P,
    strategy: Strat,
    profile: &GameProfile,
    match_info: &MatchInfo,
    mut channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    recorder: R,
) -> Result<DriverOutcome>
where
    P: Protocol,
    Strat: MoveStrategy<P>,
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<P::Move> + Send + Sync,
{
    // 1. Ephemeral-key exchange over the relay: announce ours, learn the opponent's co-signing pk.
    //    (The merged driver expects `opponent_pk` up front; the relay peer protocol supplies it.)
    let my_pk = signer.public_key();
    channel
        .send_peer(&PeerMsg::Hello {
            ephemeral_pubkey: hex::encode(my_pk),
        })
        .await
        .map_err(|e| anyhow!("send hello: {e:?}"))?;
    let opponent_pk = recv_hello(&channel).await?;

    // Graceful stop: the FE's `{t:"stop"}` (Pay now) must wind the bot down and emit `settleHalf`.
    // Non-terminal protocols (regular payments, world canvas, …) never finish otherwise.
    let run_control = DriverRunControl::graceful_unbounded();
    let stop_control = run_control.clone();
    let game_id = profile.game_id;
    let frame_transport = channel.take_frame_transport();
    let stop_listener = tokio::spawn(async move {
        while let Some(msg) = channel.recv_peer().await {
            if msg == PeerMsg::Stop {
                tracing::info!(
                    game = game_id,
                    "peer stop received — requesting graceful settle"
                );
                stop_control.request_stop();
                break;
            }
        }
    });

    // 2. Hand the driver the demuxed frame transport + the anchor; it opens, plays, and settles.
    let parts = SeatParts {
        protocol,
        signer,
        opponent_pk,
        initial: Balances {
            a: profile.stake_each,
            b: profile.stake_each,
        },
        seat: match_info.role.seat(),
    };
    let driver = PartyDriver::new(parts, strategy, frame_transport, anchor, recorder)
        .with_run_control(run_control);
    let mut ts = 1u64;
    let driver_result = driver
        .run(MAX_MOVES, move || {
            ts += 1;
            ts
        })
        .await
        .map_err(|e| anyhow!("party driver run: {e:?}"));
    stop_listener.abort();
    let (outcome, _recorder) = driver_result?;
    Ok(outcome)
}

/// Blackjack: a thin wrapper over [`play_match`] driving the real basic-strategy [`BlackjackStrategy`].
pub async fn play_blackjack<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<<Blackjack as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    play_match(
        Blackjack,
        BlackjackStrategy,
        &BLACKJACK,
        &info,
        channel,
        anchor,
        signer,
        recorder,
    )
    .await
}

/// Blackjack v2 (variable-bet, per-card commit-reveal) — the protocol the FE actually runs
/// (`blackjack.v2`). This is the arena/co-located path; the dealerless [`play_blackjack`]
/// (`blackjack.bet.v1`) is legacy (its FE counterpart was removed). Drives [`BlackjackV2Strategy`],
/// which bets when it's the (rotating) player and plays basic strategy otherwise.
pub async fn play_blackjack_v2<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<<BlackjackV2 as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    play_match(
        BlackjackV2,
        BlackjackV2Strategy::new(fleet_seed(role)),
        &BLACKJACK,
        &info,
        channel,
        anchor,
        signer,
        recorder,
    )
    .await
}

/// Quantum Poker: a thin wrapper over [`play_match`] driving [`QuantumPokerStrategy`] over the
/// commit-reveal v2 protocol. The ante scales the chip economy to the whole-token bankroll; it
/// defaults to the FE's `ANTE` (50) so the bot co-signs against the unchanged FE.
pub async fn play_quantum_poker<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<<QuantumPoker as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    play_match(
        QuantumPoker::with_ante(QUANTUM_POKER_HAND_CAP, QUANTUM_POKER_ANTE),
        QuantumPokerStrategy::new(fleet_seed(role)),
        &QUANTUM_POKER,
        &info,
        channel,
        anchor,
        signer,
        recorder,
    )
    .await
}

/// Bomb It: a thin wrapper over [`play_match`] driving the greedy-hunter [`BombItStrategy`]. The
/// strategy only needs to produce LEGAL moves for its own seat (each seat plays independently); the
/// bot is always seat B in the arena path. Seeded per role so its play is deterministic per seat.
pub async fn play_bomb_it<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<<BombIt as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    play_match(
        BombIt,
        BombItStrategy::new(fleet_seed(role)),
        &BOMB_IT,
        &info,
        channel,
        anchor,
        signer,
        recorder,
    )
    .await
}

/// Chicken Cross: a thin wrapper over [`play_match`] driving the greedy [`CrossStrategy`]. Same
/// shape as [`play_bomb_it`] — JSON-native moves, byte-identical state encoding vs the FE.
pub async fn play_chicken_cross<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<<Cross as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    play_match(
        Cross,
        CrossStrategy::new(fleet_seed(role)),
        &CHICKEN_CROSS,
        &info,
        channel,
        anchor,
        signer,
        recorder,
    )
    .await
}

/// World Canvas: a thin wrapper over [`play_match`] driving the wandering-stroke
/// [`WorldCanvasStrokeStrategy`]. Endless co-draw — the protocol is never terminal, so the match runs
/// until the relay channel closes (the human's window tears down); no economic settle (free/draw).
pub async fn play_world_canvas<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<<WorldCanvasStroke as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    play_match(
        WorldCanvasStroke,
        WorldCanvasStrokeStrategy::new(fleet_seed(role)),
        &WORLD_CANVAS,
        &info,
        channel,
        anchor,
        signer,
        recorder,
    )
    .await
}

/// Tic-Tac-Toe: drives the SERIES wrapper at max_games=1 (FE parity) with the `Fast` heuristic bot.
pub async fn play_tic_tac_toe<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<<TicTacToeSeries as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    let protocol = TicTacToeSeries::new(1, TIC_TAC_TOE.stake_each)
        .map_err(|e| anyhow!("ttt series: {e:?}"))?;
    let strategy = TicTacToeSeriesStrategy::new(TicTacToeDifficulty::Fast, fleet_seed(role) as u32);
    play_match(
        protocol,
        strategy,
        &TIC_TAC_TOE,
        &info,
        channel,
        anchor,
        signer,
        recorder,
    )
    .await
}

/// Caro (gomoku): series wrapper, max_games=1, board size pinned to [`CARO_BOARD_SIZE`] (FE canonical).
pub async fn play_caro<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<<CaroSeries as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    let protocol = CaroSeries::new(1, CARO_BOARD_SIZE, CARO.stake_each)
        .map_err(|e| anyhow!("caro series: {e:?}"))?;
    // Easy = the easiest caro bot: it ignores threats entirely (never blocks, never builds a line)
    // and plays a pseudo-random adjacent cell, so a casual human reliably wins. `Weak`/`Strong`
    // still defend and are too strong for a casual player at gomoku.
    let strategy =
        CaroSeriesStrategy::with_seed(1, CARO_BOARD_SIZE, CaroStrength::Easy, fleet_seed(role))
            .map_err(|e| anyhow!("caro strategy: {e:?}"))?;
    play_match(
        protocol, strategy, &CARO, &info, channel, anchor, signer, recorder,
    )
    .await
}

/// Regular Payments: `payments.v1` shop POS — the fleet bot (seat B) co-signs shopper moves and
/// never initiates purchases.
pub async fn play_regular_payments<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<PayMove> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    play_match(
        RegularPayments(Payments { max_transfers: 0 }),
        ShopPosStrategy,
        &REGULAR_PAYMENTS,
        &info,
        channel,
        anchor,
        signer,
        recorder,
    )
    .await
}

/// Battleship: `battleship.v1` merkle commit-reveal, basic-AI deterministic fleet (hunt/target).
pub async fn play_battleship<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<<Battleship as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    play_match(
        Battleship::new(BATTLESHIP.stake_each),
        BattleshipStrategy::new(fleet_seed(role)),
        &BATTLESHIP,
        &info,
        channel,
        anchor,
        signer,
        recorder,
    )
    .await
}

/// Flash: `flash.v1`. In chat mode the co-located bot answers with `responder`'s LLM reply to the
/// user's plaintext; pass `None` (bench self-play, offline) for the digest-seeded Markov fallback.
pub async fn play_flash<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
    responder: Option<Arc<dyn ChatResponder>>,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<<Flash as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    let strategy = match responder {
        Some(responder) => FlashStrategy::with_responder(responder),
        None => FlashStrategy::new(),
    };
    play_match(
        Flash, strategy, &FLASH, &info, channel, anchor, signer, recorder,
    )
    .await
}

/// A stable-per-role seed for the poker strategy, so a bot's play is deterministic per match seat
/// but distinct across seats. Not cryptographic — the per-match co-signing key is the secret.
fn fleet_seed(role: Role) -> u64 {
    match role {
        Role::A => 0xa11ce,
        Role::B => 0xb0b_5eed,
    }
}

async fn recv_hello<T: RelayTransport>(ch: &MatchChannel<T>) -> Result<[u8; 32]> {
    loop {
        match ch.recv_peer().await {
            Some(PeerMsg::Hello { ephemeral_pubkey }) => {
                let bytes = hex::decode(&ephemeral_pubkey).context("opponent hello pubkey hex")?;
                return bytes
                    .as_slice()
                    .try_into()
                    .map_err(|_| anyhow!("opponent pubkey not 32 bytes"));
            }
            Some(_) => continue, // ignore other control messages until the hello arrives
            None => bail!("channel closed before opponent hello"),
        }
    }
}
