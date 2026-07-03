/**
 * Contracts for the browser tunnel-client Web Worker (design:
 * docs/design/frontend-tunnel-client-worker.md).
 *
 * ALL PvP windows share ONE relay-socket "hub" worker ({@link PvpHubApi}), multiplexed by matchId.
 * The worker owns its `DistributedTunnel` + ephemeral signing + any hidden-info secret; the main
 * thread renders snapshots and serves wallet/Sui-client through the bridge.
 *
 * The boundary is Comlink: commands + the snapshot/bridge callbacks cross as RPC; their *payloads*
 * are plain / structured-cloneable (the callbacks themselves ride as `Comlink.proxy`'d references).
 * Closures (a game's `Protocol`, `MoveCodec`, `GameSessionSpec`) are imported INSIDE the worker and
 * addressed by `gameId` — they are never sent across.
 */
import type { Role } from "@/pvp/mpClient";
import type { Protocol } from "sui-tunnel-ts/protocol/Protocol";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
import type { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import type {
  CoSignedSettlementWithRoot,
  CoSignedUpdate,
  OffchainTunnel,
} from "sui-tunnel-ts/core/tunnel";
import type { ResumeAdapter } from "@/pvp/resumeSession";

/** A registered game's matchmaking/spec key (e.g. "bomb-it"). */
export type GameId = string;

export type EngineStatus =
  | "idle"
  | "matching"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export type ConnStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * The coalesced, render-ready snapshot the UI consumes — a superset of the two existing
 * `PvpSnapshot` shapes. `view` is the game's `deriveView` output; all fields are plain.
 */
export interface MatchSnapshot<View = unknown, Winner = unknown> {
  status: EngineStatus;
  role: Role | null;
  auto: boolean;
  /** Per-seat stake (MIST) surfaced in the outcome banner. */
  stake: number;
  view: View | null;
  winner: Winner;
  opponentWallet: string | null;
  /** The active tunnel's on-chain id, or null before funding (no synthetic ids — design §4). */
  tunnelId: string | null;
  /** Socket lifecycle for this match, folded in from the worker (design §7). */
  connStatus: ConnStatus;
  error: string | null;
  /** CUMULATIVE co-signed updates this match (the tunnel nonce). The React binding feeds the delta
   *  to the scoped telemetry so a PvP window's TPS chip shows its own local co-sign rate. */
  moves?: number;
}

/**
 * Worker bootstrap config (the wallet address is only a matchmaking label).
 *
 * `mpWsUrl` is resolved on MAIN (`resolveMpWsUrl(resolveBackendUrl())`) and passed in, NOT derived
 * inside the worker: a worker's `self.location` is the worker-script URL, so a same-origin fallback
 * would resolve the relay against the wrong origin (design §1). `backendUrl` stays for the
 * control-plane `fetch` base (settle, heartbeat), which is origin-independent.
 */
export interface EngineConfig {
  backendUrl: string;
  /** Fully-resolved `/v1/mp` relay WebSocket URL (main-resolved; see above). */
  mpWsUrl: string;
  wallet: string;
}

// --- Worker RPC surfaces (Comlink) --------------------------------------------------------

/**
 * A fleet allocation handed to the worker for arena entry (ADR-0028). The tunnel is already created +
 * seat B funded by the fleet, and seat A deposited by the main-thread batched `enterArena` PTB — so
 * the worker only JOINS the pre-allocated match + wires the relay/engine over the live tunnel (no
 * matchmaking, no open). The ephemeral key was minted on MAIN (its pubkey is baked into the tunnel at
 * allocate) and travels here as a secret hex — the SAME key must co-sign moves (a different key
 * rejects every signature). Plain/cloneable so it crosses the Comlink boundary.
 */
export interface WorkerArenaEntry {
  /** The pre-allocated relay match to `joinMatch` (role is always A — the fleet bound the bot as B). */
  matchId: string;
  /** The fleet-pre-created tunnel to build the engine over (no open here). */
  tunnelId: string;
  /** The user's per-game ephemeral secret (32-byte ed25519 seed, hex); rebuilt via `keyPairFromSecret`. */
  ephemeralSecretHex: string;
  /** Tunnel party B (the bot): pubkey verifies its move sigs, address receives seat B. */
  botPubkeyHex: string;
  botAddress: string;
  /** Per-seat stake the fleet + the batched deposit funded (backend `GameProfile`); inits both balances. */
  stakeEach: string;
  /** Optional `makeProtocol`/`initSetup` payload (ttt/caro board size + game cap). */
  setup?: unknown;
}

/**
 * The shared PvP hub the SINGLE relay worker `Comlink.expose`s (M1: one socket for all PvP). Every
 * method is keyed by `windowId` because ONE worker multiplexes MANY windows' matches over ONE
 * `MpClient` (one WebSocket), routed by matchId. The snapshot sink is therefore `(windowId, snap)`
 * so the manager can fan each match's snapshots back to its window.
 *
 * Setup (`init`/`attachBridge`/`subscribe`) is posted once for the whole hub; per-window matches
 * then start via `findMatch(windowId, …)`.
 */
export interface PvpHubApi {
  init(config: EngineConfig): void;
  attachBridge(bridge: MainBridge): void;
  /** windowId-tagged coalesced-snapshot sink (a Comlink proxy). */
  subscribe(onSnapshot: (windowId: string, snap: MatchSnapshot) => void): void;
  findMatch(windowId: string, gameId: GameId, setup?: unknown): Promise<void>;
  /** Arena entry (ADR-0028): join a fleet-pre-allocated match + wire the engine over its live tunnel,
   *  instead of quickMatch + open. The {@link WorkerArenaEntry} carries the pre-opened tunnel + the
   *  main-minted ephemeral key; funding already happened on main (batched), so this only plays. */
  enterArenaMatch(
    windowId: string,
    gameId: GameId,
    entry: WorkerArenaEntry,
  ): Promise<void>;
  resume(windowId: string, gameId: GameId): Promise<void>;
  submitInput(windowId: string, input: unknown): void;
  setAuto(windowId: string, on: boolean): void;
  setVisibility(windowId: string, visible: boolean): void;
  /** Tear ONE window's match down (cancel queued open, release its matchId from the shared socket);
   *  the hub closes the shared socket only when its LAST session goes. Async (orphan-tunnel cancel,
   *  design §4.1) so the manager can let the cancel land before reclaiming the window. */
  reset(windowId: string): Promise<void>;
}

// --- Bridge: the few privileged ops the worker calls back into main for -------------------

export interface PartyRef {
  address: string;
  publicKey: Uint8Array;
}
export interface OpenTunnelParams {
  partyA: PartyRef;
  partyB: PartyRef;
  amount: bigint;
  label: string;
}
export interface DepositStakeParams {
  tunnelId: string;
  amount: bigint;
  label: string;
}
/** Self-play open: BOTH ephemeral-bot seats funded from one wallet in a single signature. The
 *  amounts are the LARGE per-seat bank (vs the small per-duel stake) — one tunnel hosts many duels. */
export interface OpenSelfPlayParams {
  partyA: PartyRef;
  partyB: PartyRef;
  aAmount: bigint;
  bAmount: bigint;
  label: string;
}
export interface CloseFallbackParams {
  tunnelId: string;
  settlement: CoSignedSettlementWithRoot;
  coinType?: string;
}
export interface RaiseDisputeParams {
  tunnelId: string;
  /** The latest BOTH-signed checkpoint to stake on-chain via `raise_dispute` (the settlement floor
   *  when the peer is gone and no fresh cooperative co-signature is reachable). Plain data — it
   *  structured-clones across the bridge like `CloseFallbackParams.settlement`. */
  update: CoSignedUpdate;
  role: Role;
}
export interface ForceCloseParams {
  tunnelId: string;
}

/**
 * Implemented on MAIN (dapp-kit signers + Sui client live there) and called FROM the worker.
 * All `@mysten/sui` tx-building stays behind these coarse ops. The happy-path settle
 * (`cp.settle`) is plain `fetch` and runs in the worker, not here. Resume persistence is NOT
 * on the bridge — the worker owns it in its own IndexedDB (`persist/idb.ts`, design §5/§6).
 */
export interface MainBridge {
  /** Role A: open + fund the shared tunnel on-chain; returns its id. `intentId` (minted by the
   *  worker per open) tags the queued bulk-open intent so a teardown can {@link cancelOpen} it. */
  openTunnel(
    p: OpenTunnelParams,
    intentId?: string,
  ): Promise<{ tunnelId: string }>;
  /** Self-play: open + fund BOTH ephemeral seats in ONE signature; returns the shared tunnel id.
   *  The single per-duel loop is pure crypto, so only this open and the close cross the bridge. */
  openSelfPlay(p: OpenSelfPlayParams): Promise<{ tunnelId: string }>;
  /** Cancel a still-queued seat-A open (orphan-tunnel cancel, design §4.1): the match/window was
   *  torn down inside the bulk-open window, so its pending open must not flush a tunnel (and
   *  consume stake). No-op if the intent already flushed into an in-flight PTB. */
  cancelOpen(intentId: string): Promise<void>;
  /** Role B: deposit this seat's stake into the opened tunnel. */
  depositStake(p: DepositStakeParams): Promise<void>;
  /** Settle: read the tunnel's on-chain `createdAt` for the settlement timestamp. */
  readCreatedAt(tunnelId: string): Promise<bigint>;
  /** Settle fallback only (backend `/settle` down): wallet-submitted cooperative close. */
  closeFallback(p: CloseFallbackParams): Promise<void>;
  /** Unilateral settlement floor: after a resumed match's peer stays gone past the on-chain grace,
   *  stake the held checkpoint via `raise_dispute` so the stake is recoverable without the peer. */
  raiseDispute(p: RaiseDisputeParams): Promise<void>;
  /** Finalize a dispute WE raised, once its on-chain timeout has elapsed (`force_close_after_timeout`
   *  — only the raiser may call it). Driven by the cold-resume dispute sweep, not the live path. */
  forceClose(p: ForceCloseParams): Promise<void>;
}

// --- Per-game spec (imported in the worker, addressed by gameId) --------------------------

/** What the engine hands a game's controller for one match. */
export interface MatchIo<State, Move> {
  role: Role;
  /** The live tunnel for this match (null before activation). */
  tunnel(): DistributedTunnel<State, Move> | null;
  /** Current auto/autopilot state for this seat (engine-owned). */
  auto(): boolean;
  /** Ask the engine to re-derive the view and flush a coalesced snapshot. */
  emitView(): void;
}

/**
 * The per-match, game-specific brain. Closes over this match's private local state (secret,
 * placements, last shots). The engine calls these at well-defined points; the spec owns the
 * game logic and — critically — the move ordering (`onTick`).
 */
export interface MatchController<State, Move, Setup, Input, View> {
  /** Build any secret/local state from the UI's `findMatch(setup)` (no-op for public-state). */
  initSetup(setup: Setup): void;
  /** After each confirmed update: drive the due move (proposeDue / maybePropose). */
  onConfirmed(): void;
  /** Queue a human input (fire/intent) and propose if applicable. */
  onInput(input: Input): void;
  /** Auto/autopilot toggled for this seat; (re)evaluate whether to propose. */
  setAuto(on: boolean): void;
  /** Render-ready view from the display state — the only game data that reaches the UI. */
  deriveView(displayState: State): View;
  /** Persist/restore incl. any secret; wired when resume lands (optional for now). */
  resumeAdapter?(): ResumeAdapter<State, Move>;
  /** One activity/telemetry row per finished match; reads `io.tunnel()` for the result. */
  onSettled?(): void;
  /** Clear any timers/local state when the match ends. */
  dispose(): void;
}

/**
 * Everything game-specific the generic engine needs, registered by `gameId`. The engine
 * supplies the skeleton (matchmaking, role-asymmetric funding, settle, resume, snapshot);
 * the spec supplies protocol + codec + the per-match controller.
 *
 * @typeParam State must carry a `winner` the snapshot reads.
 */
export interface GameSessionSpec<
  State extends { winner: unknown },
  Move,
  Setup,
  Input,
  View,
> {
  game: GameId;
  /** Per-seat stake locked on-chain (MIST). */
  stake: bigint;
  /** Optional idle pacing for an auto/bot seat (ms); event-driven games omit it. */
  stepMs?: number;
  /** Build the match protocol. `setup` (the `findMatch(setup)` payload) parameterizes it for games
   *  that need it — ttt/caro's board size + game cap (§13). Public-state/battleship specs ignore it
   *  (a nullary `() => Protocol` still satisfies this), so the in-scope games are unaffected. */
  makeProtocol(setup?: Setup): Protocol<State, Move>;
  /** Optional composite matchmaking-queue key derived from `setup` (§13): one `gameId` maps to many
   *  queues — e.g. ttt/caro key on board size (`tictactoe:caro:${size}`). Default: the bare `gameId`,
   *  so games that omit this match exactly as before. */
  matchmakingKey?(setup?: Setup): string;
  /** REQUIRED iff `protocol.movesCarrySecrets` — the tunnel enforces this. */
  moveCodec?: MoveCodec<Move>;
  createMatch(
    io: MatchIo<State, Move>,
  ): MatchController<State, Move, Setup, Input, View>;
}
