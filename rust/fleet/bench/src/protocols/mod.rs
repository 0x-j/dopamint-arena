use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::play_protocol_tunnel_with_strategies;
use crate::party_driver::SeatKit;
use crate::party_driver::{StageWindowRecorder, TunnelTelemetry};
use crate::party_driver::{SuiSponsoredBenchContext, TunnelOutcome};
use tunnel_core::protocol_id::{
    API_CREDITS_V1, BATTLESHIP_SERIES_V1, BATTLESHIP_V1, BLACKJACK_BET_V1, BLACKJACK_DUEL_V1,
    BLACKJACK_V2, BOMB_IT_SERIES_V1, BOMB_IT_V1, CARO_SERIES_V1, CARO_V1, CHAT_V1, CROSS_SERIES_V1,
    CROSS_V1, FLASH_V1, PAYMENTS_V1, QUANTUM_POKER_V2, TIC_TAC_TOE_SERIES_V1, TIC_TAC_TOE_V1,
    WORLD_CANVAS_CELL_V1, WORLD_CANVAS_STROKE_V1,
};
use tunnel_harness::{
    BcsFrameCodec, DriverRunControl, FrameCodec, JsonFrameCodec, MoveStrategy, PostcardFrameCodec,
    Protocol,
};

pub(crate) mod api_credits;
pub(crate) mod battleship;
pub(crate) mod blackjack;
pub(crate) mod bomb_it;
pub(crate) mod caro;
pub(crate) mod chat;
pub(crate) mod cross;
pub(crate) mod flash;
pub(crate) mod payments;
pub(crate) mod quantum_poker;
pub(crate) mod tic_tac_toe;
pub(crate) mod world_canvas;

pub(crate) const DEFAULT_MAX_MOVES_PER_TUNNEL: u64 = 1000;
pub(crate) const MAX_MOVES: u64 = DEFAULT_MAX_MOVES_PER_TUNNEL;
pub(crate) const DEFAULT_BALANCE: u64 = 200;

pub(crate) struct PlayTunnelRequest<'a> {
    pub protocol_id: &'static str,
    pub codec: FrameCodecKind,
    pub card_seed: Option<u64>,
    pub run_control: Option<DriverRunControl>,
    pub kit: &'a SeatKit,
    pub tunnel_id: &'a str,
    pub initial_balance: u64,
    pub max_moves_per_tunnel: u64,
    pub anchor_mode: AnchorMode,
    pub sui_context: Option<&'a SuiSponsoredBenchContext>,
    pub telemetry: TunnelTelemetry,
    pub stage_windows: Option<StageWindowRecorder>,
}

tokio::task_local! {
    static REQUEST_RUN_CONTROL: Option<DriverRunControl>;
    static REQUEST_STAGE_WINDOWS: Option<StageWindowRecorder>;
    static REQUEST_INITIAL_BALANCE: u64;
    static REQUEST_MAX_MOVES_PER_TUNNEL: u64;
}

fn current_request_run_control() -> Option<DriverRunControl> {
    REQUEST_RUN_CONTROL.try_with(Clone::clone).ok().flatten()
}

fn current_request_stage_windows() -> Option<StageWindowRecorder> {
    REQUEST_STAGE_WINDOWS.try_with(Clone::clone).ok().flatten()
}

pub(crate) fn current_initial_balance() -> u64 {
    REQUEST_INITIAL_BALANCE
        .try_with(|initial_balance| *initial_balance)
        .unwrap_or(DEFAULT_BALANCE)
}

pub(crate) fn current_max_moves_per_tunnel() -> u64 {
    REQUEST_MAX_MOVES_PER_TUNNEL
        .try_with(|max_moves| *max_moves)
        .unwrap_or(DEFAULT_MAX_MOVES_PER_TUNNEL)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn play_with_strategies<P, StrategyA, StrategyB>(
    protocol: P,
    strategy_a: StrategyA,
    strategy_b: StrategyB,
    codec: FrameCodecKind,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    move_seed: u64,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    max_moves: u64,
    telemetry: TunnelTelemetry,
) -> TunnelOutcome
where
    P: Protocol + Clone,
    P::Move: Clone + Send + Sync,
    StrategyA: MoveStrategy<P>,
    StrategyB: MoveStrategy<P>,
{
    let max_moves = current_max_moves_per_tunnel().max(max_moves);
    match codec {
        FrameCodecKind::Json => {
            play_with_codec::<P, JsonFrameCodec, StrategyA, StrategyB>(
                protocol,
                strategy_a,
                strategy_b,
                move_seed,
                kit,
                tunnel_id,
                balance_a,
                balance_b,
                max_moves,
                anchor_mode,
                sui_context,
                telemetry,
                current_request_run_control(),
                current_request_stage_windows(),
            )
            .await
        }
        FrameCodecKind::Bcs => {
            play_with_codec::<P, BcsFrameCodec, StrategyA, StrategyB>(
                protocol,
                strategy_a,
                strategy_b,
                move_seed,
                kit,
                tunnel_id,
                balance_a,
                balance_b,
                max_moves,
                anchor_mode,
                sui_context,
                telemetry,
                current_request_run_control(),
                current_request_stage_windows(),
            )
            .await
        }
        FrameCodecKind::Postcard => {
            play_with_codec::<P, PostcardFrameCodec, StrategyA, StrategyB>(
                protocol,
                strategy_a,
                strategy_b,
                move_seed,
                kit,
                tunnel_id,
                balance_a,
                balance_b,
                max_moves,
                anchor_mode,
                sui_context,
                telemetry,
                current_request_run_control(),
                current_request_stage_windows(),
            )
            .await
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn play_with_codec<P, C, StrategyA, StrategyB>(
    protocol: P,
    strategy_a: StrategyA,
    strategy_b: StrategyB,
    _move_seed: u64,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    max_moves: u64,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    telemetry: TunnelTelemetry,
    run_control: Option<DriverRunControl>,
    stage_windows: Option<StageWindowRecorder>,
) -> TunnelOutcome
where
    P: Protocol + Clone,
    P::Move: Clone + Send + Sync,
    C: FrameCodec<P::Move> + Default,
    StrategyA: MoveStrategy<P>,
    StrategyB: MoveStrategy<P>,
{
    play_protocol_tunnel_with_strategies::<P, C, StrategyA, StrategyB>(
        protocol,
        strategy_a,
        strategy_b,
        kit,
        tunnel_id,
        balance_a,
        balance_b,
        max_moves,
        anchor_mode,
        sui_context,
        telemetry,
        run_control,
        stage_windows,
    )
    .await
}

pub(crate) async fn play_tunnel_for(request: PlayTunnelRequest<'_>) -> TunnelOutcome {
    let PlayTunnelRequest {
        protocol_id,
        codec,
        card_seed,
        run_control,
        kit,
        tunnel_id,
        initial_balance,
        max_moves_per_tunnel,
        anchor_mode,
        sui_context,
        telemetry,
        stage_windows,
    } = request;
    REQUEST_INITIAL_BALANCE
        .scope(initial_balance, async move {
            REQUEST_MAX_MOVES_PER_TUNNEL
                .scope(max_moves_per_tunnel, async move {
                    REQUEST_RUN_CONTROL
                        .scope(run_control, async move {
                            REQUEST_STAGE_WINDOWS
                                .scope(stage_windows, async move {
                                    match protocol_id {
                                        API_CREDITS_V1 => {
                                            api_credits::play(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        BATTLESHIP_V1 => {
                                            battleship::play_single(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        BATTLESHIP_SERIES_V1 => {
                                            battleship::play_series(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        BLACKJACK_BET_V1 => {
                                            blackjack::play_bet(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        BLACKJACK_DUEL_V1 => {
                                            blackjack::play_duel(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        BLACKJACK_V2 => {
                                            blackjack::play_v2(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        BOMB_IT_V1 => {
                                            bomb_it::play_single(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        BOMB_IT_SERIES_V1 => {
                                            bomb_it::play_series(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        CARO_V1 => {
                                            caro::play_single(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        CARO_SERIES_V1 => {
                                            caro::play_series(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        CHAT_V1 => {
                                            chat::play(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        FLASH_V1 => {
                                            flash::play(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        CROSS_V1 => {
                                            cross::play_single(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        CROSS_SERIES_V1 => {
                                            cross::play_series(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        PAYMENTS_V1 => {
                                            payments::play(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        QUANTUM_POKER_V2 => {
                                            quantum_poker::play(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        TIC_TAC_TOE_V1 => {
                                            tic_tac_toe::play_single(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        TIC_TAC_TOE_SERIES_V1 => {
                                            tic_tac_toe::play_series(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        WORLD_CANVAS_CELL_V1 => {
                                            world_canvas::play_cell(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        WORLD_CANVAS_STROKE_V1 => {
                                            world_canvas::play_stroke(
                                                codec,
                                                card_seed,
                                                kit,
                                                tunnel_id,
                                                anchor_mode,
                                                sui_context,
                                                telemetry,
                                            )
                                            .await
                                        }
                                        _ => panic!(
                                            "unsupported fleet-bench protocol id: {protocol_id}"
                                        ),
                                    }
                                })
                                .await
                        })
                        .await
                })
                .await
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_run_control_reaches_protocol_runner() {
        let (run_control, outcome) = std::thread::Builder::new()
            .name("fleet-protocol-run-control-test".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .worker_threads(2)
                    .build()
                    .expect("test runtime");
                runtime.block_on(async {
                    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
                    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
                    let kit = SeatKit::new(&sa, &sb);
                    let run_control = DriverRunControl::with_move_limit(2);
                    let outcome = play_tunnel_for(PlayTunnelRequest {
                        protocol_id: BLACKJACK_BET_V1,
                        codec: FrameCodecKind::Json,
                        card_seed: None,
                        run_control: Some(run_control.clone()),
                        kit: &kit,
                        tunnel_id: "0x1",
                        initial_balance: DEFAULT_BALANCE,
                        max_moves_per_tunnel: 2,
                        anchor_mode: AnchorMode::Memory,
                        sui_context: None,
                        telemetry: TunnelTelemetry {
                            collect: false,
                            record_transcript: false,
                            heartbeat: None,
                        },
                        stage_windows: None,
                    })
                    .await;
                    (run_control, outcome)
                })
            })
            .expect("spawn test thread")
            .join()
            .expect("protocol run-control test thread");

        assert!(run_control.stopped());
        assert_eq!(run_control.moves(), outcome.moves);
        assert!(
            outcome.moves < 143,
            "request control should stop before the terminal golden path"
        );
        assert!(outcome.settle_ok, "cooperative stop still settles");
        assert_eq!(outcome.final_balances.sum(), 400);
    }

    #[test]
    fn tic_tac_toe_series_uses_requested_continuation_cap() {
        let outcome = std::thread::Builder::new()
            .name("fleet-protocol-tic-tac-toe-test".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .worker_threads(2)
                    .build()
                    .expect("test runtime");
                runtime.block_on(async {
                    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
                    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
                    let kit = SeatKit::new(&sa, &sb);
                    play_tunnel_for(PlayTunnelRequest {
                        protocol_id: TIC_TAC_TOE_SERIES_V1,
                        codec: FrameCodecKind::Json,
                        card_seed: None,
                        run_control: None,
                        kit: &kit,
                        tunnel_id: "0x1",
                        initial_balance: DEFAULT_BALANCE,
                        max_moves_per_tunnel: 40,
                        anchor_mode: AnchorMode::Memory,
                        sui_context: None,
                        telemetry: TunnelTelemetry {
                            collect: false,
                            record_transcript: false,
                            heartbeat: None,
                        },
                        stage_windows: None,
                    })
                    .await
                })
            })
            .expect("spawn test thread")
            .join()
            .expect("tic-tac-toe protocol test thread");

        assert!(outcome.moves > 29);
        assert!(outcome.settle_ok, "natural series terminal still settles");
    }
}
