/**
 * Per-game resume driver. One `attachResume` call wires a game's tunnel + channel into:
 *  - debounced persistence on every confirmed move (the resume record), and
 *  - the resume-time reconciliation handshake over the existing peer-message side channel.
 * Games supply only a thin `ResumeAdapter` (full-state (de)serialization, an optional hidden
 * secret the peer can never supply, optional move (de)serialization for codec-based moves, and a
 * re-render hook). Verification + adoption live in the SDK; this module never touches keys or
 * signatures directly.
 */
import {
  DistributedTunnel,
  type Transport,
} from "sui-tunnel-ts/core/distributedTunnel";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { fromHex } from "sui-tunnel-ts/core/bytes";
import type { Protocol } from "sui-tunnel-ts/protocol/Protocol";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
import { decideReconcile } from "sui-tunnel-ts/core/reconcile";
import type { ReconcileAction, ResyncView } from "sui-tunnel-ts/core/reconcile";
import type {
  MpClient,
  RelayClient,
  PvpChannel,
  PeerMessage,
} from "./mpClient";
import {
  clearResumeRecord,
  evictExpiredRecords,
  fromWireCoSigned,
  keypairFromSecretHex,
  listActiveTunnels,
  readResumeRecord,
  toWireCoSigned,
  writeResumeRecord,
} from "./resume";
import type { JsonValue, ResumeRecord } from "./resume";

export type ReconcileOutcome = ReconcileAction;

/** A game's thin resume adapter. State (de)serialization is REQUIRED and covers the FULL app
 *  state; `serializeState` MUST exclude any hidden secret (captured separately). Move methods
 *  default to identity (JSON-native moves); secret methods are omitted by games with no secret. */
export interface ResumeAdapter<State, Move> {
  serializeState(s: State): JsonValue;
  deserializeState(j: JsonValue): State;
  serializeMove?(m: Move): JsonValue;
  deserializeMove?(j: JsonValue): Move;
  captureSecret?(): JsonValue;
  restoreSecret?(j: JsonValue): void;
  onReconciled(
    tunnel: DistributedTunnel<State, Move>,
    outcome: ReconcileOutcome,
  ): void;
}

/** Static record fields the driver cannot derive from the tunnel snapshot. */
export interface ResumeIdentity {
  matchId: string;
  tunnelId: string;
  role: "A" | "B";
  game: string;
  opponentWallet: string;
  opponentPubkeyHex: string;
  /** Per-match self signing secret (hex), persisted so a cold reload can rebuild the signer. */
  selfEphemeralSecretHex: string;
}

export interface AttachResumeArgs<State, Move> {
  mp: RelayClient;
  channel: PvpChannel;
  tunnel: DistributedTunnel<State, Move>;
  adapter: ResumeAdapter<State, Move>;
  identity: ResumeIdentity;
  graceMs?: number;
  onGraceExpired?: (latest: CoSignedUpdate | null) => void;
  /** Where to persist records. Defaults to localStorage (`writeResumeRecord`); the worker
   *  engine injects an IndexedDB sink so the record never leaves the worker thread. */
  persist?: (rec: ResumeRecord) => void;
  /** Injectable for tests; defaults to the globals. */
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  };
}

/** Build the full ResumeRecord from the live tunnel snapshot + static identity + adapter.
 *  Exported for unit testing of the terminal stamp; production callers use it via `attachResume`. */
export function buildRecord<State, Move>(
  tunnel: DistributedTunnel<State, Move>,
  adapter: ResumeAdapter<State, Move>,
  identity: ResumeIdentity,
): ResumeRecord | null {
  const snap = tunnel.snapshot();
  if (!snap.latest) return null; // nothing co-signed yet — nothing to resume to
  const serMove =
    adapter.serializeMove ?? ((m: Move) => m as unknown as JsonValue);
  return {
    ...identity,
    latestCoSigned: toWireCoSigned(snap.latest),
    latestState: adapter.serializeState(snap.state),
    pending: snap.pending
      ? {
          move: serMove(snap.pending.move),
          timestamp: snap.pending.timestamp.toString(),
        }
      : undefined,
    secret: adapter.captureSecret ? adapter.captureSecret() : undefined,
    // Stamp terminality here (proto in hand) so the proto-less arena allocate can tell a finished
    // match from an in-flight one and not suppress a fresh game after a settle+reload.
    terminal: tunnel.protocol.isTerminal(snap.state),
    updatedAt: Date.now(),
  };
}

/** Cold-load: seat a freshly-constructed tunnel from a persisted record WITHOUT sending. The
 *  reconciliation handshake decides whether to (re-)send the pending move. */
export function restoreInto<State, Move>(
  tunnel: DistributedTunnel<State, Move>,
  record: ResumeRecord,
  adapter: ResumeAdapter<State, Move>,
): void {
  tunnel.adoptCheckpoint(
    adapter.deserializeState(record.latestState),
    fromWireCoSigned(record.latestCoSigned),
  );
  if (record.secret !== undefined && adapter.restoreSecret)
    adapter.restoreSecret(record.secret);
  if (record.pending) {
    const deMove =
      adapter.deserializeMove ?? ((j: JsonValue) => j as unknown as Move);
    tunnel.seatPending(
      deMove(record.pending.move),
      BigInt(record.pending.timestamp),
    );
  }
}

/** Current connected wallet at mount — the only live value cold-load can't read from a record. */
export interface ResumeContext {
  selfWallet: string;
}

/** The thin per-game inputs cold-load reconstruction cannot derive from a persisted record. */
export interface RebuildSpec<State, Move> {
  /** The same `Protocol` object the hook builds for a live match. */
  proto: Protocol<State, Move>;
  /** Required for games with binary moves (battleship, poker); JSON-native games omit it. */
  moveCodec?: MoveCodec<Move>;
  /** Full-state + hidden-secret (de)serialization + UI hydration. */
  adapter: ResumeAdapter<State, Move>;
  /** Override the rebuilt tunnel's locked balances; defaults to the checkpoint's A/B split. */
  balancesFromRecord?(record: ResumeRecord): { a: bigint; b: bigint };
  /** Wrap the relay transport before the tunnel binds its frame handler. The worker passes a guard
   *  that keeps an ahead-frame's throw from killing its long-lived frame pump (see
   *  `PvpMatchSession.guardTransport`); main-thread hooks omit it — each WS message self-isolates. */
  wrapTransport?(transport: Transport): Transport;
}

export interface RestoredSession<State, Move> {
  tunnel: DistributedTunnel<State, Move>;
  channel: PvpChannel;
}

/** Default locked balances: the checkpoint's current A/B split (sums to the same locked total). */
function balancesFromCheckpoint(record: ResumeRecord): {
  a: bigint;
  b: bigint;
} {
  return {
    a: BigInt(record.latestCoSigned.update.partyABalance),
    b: BigInt(record.latestCoSigned.update.partyBBalance),
  };
}

/**
 * Cold-load: reconstruct one tunnel from a persisted record + per-game spec, seat it at the
 * checkpoint, and warm-attach it. Throws if the record can't be restored (missing per-match key,
 * `adoptCheckpoint` integrity failure) — `resumeActiveTunnels` catches and evicts those. The
 * returned tunnel renders immediately from `tunnel.snapshot().state`; the resync handshake (run by
 * the attached driver once the peer is reachable) closes any ≤1-move gap.
 */
export function rebuildTunnel<State, Move>(
  mp: RelayClient,
  record: ResumeRecord,
  spec: RebuildSpec<State, Move>,
  ctx: ResumeContext,
): RestoredSession<State, Move> {
  if (!record.selfEphemeralSecretHex)
    throw new Error("rebuildTunnel: record has no per-match signing key");
  const backend = defaultBackend();
  const keypair = keypairFromSecretHex(record.selfEphemeralSecretHex);
  const self = makeEndpoint(backend, ctx.selfWallet, keypair, true);
  const opponent = makeEndpoint(
    backend,
    record.opponentWallet,
    { publicKey: fromHex(record.opponentPubkeyHex), scheme: keypair.scheme },
    false,
  );
  const channel = mp.channel(record.matchId);
  const balances = (spec.balancesFromRecord ?? balancesFromCheckpoint)(record);
  const tunnel = new DistributedTunnel<State, Move>(
    spec.proto,
    {
      tunnelId: record.tunnelId,
      self,
      opponent,
      selfParty: record.role,
      moveCodec: spec.moveCodec,
    },
    spec.wrapTransport
      ? spec.wrapTransport(channel.transport)
      : channel.transport,
    balances,
  );
  restoreInto(tunnel, record, spec.adapter); // verify-on-adopt; throws on tamper
  mp.markActive(record.matchId);
  // Reconstruct-only: the caller owns onConfirmed + attachResume (live and cold paths
  // share one activateSession), so they can pass onGraceExpired and the per-move handler.
  return { tunnel, channel };
}

/**
 * Cold-load every persisted match for one game: evict expired records, then rebuild each active
 * record whose `game` matches. Corrupt/unrestorable records are evicted and skipped so a single bad
 * entry never blocks the rest. Call once on hook mount, BEFORE `mp.connect()`.
 */
export function resumeActiveTunnels<State, Move>(
  mp: MpClient,
  gameId: string,
  spec: RebuildSpec<State, Move>,
  ctx: ResumeContext,
): RestoredSession<State, Move>[] {
  evictExpiredRecords();
  const out: RestoredSession<State, Move>[] = [];
  for (const tunnelId of listActiveTunnels()) {
    const record = readResumeRecord(tunnelId);
    if (!record || record.game !== gameId) continue;
    // A disputed record is STATUS_DISPUTED on-chain — rebuilding it would drive a channel that can no
    // longer advance. The hook's own resume() sweep finalizes it (force_close) once matured; skip it
    // here either way so it never seats a stuck "playing" tunnel.
    if (record.disputedAt != null) continue;
    try {
      // A record whose persisted state is already terminal is a finished match: settle either
      // completed (record is stale) or was interrupted. Rebuilding it seats a live "playing"
      // tunnel that strands the settled board on refresh and blocks a new match. Drop it so the
      // hook stays idle and the arena allocates a fresh game. Checked pre-rebuild to avoid the
      // markActive/channel side effects, and heals records already on disk (no field needed).
      if (
        spec.proto.isTerminal(spec.adapter.deserializeState(record.latestState))
      ) {
        clearResumeRecord(tunnelId);
        continue;
      }
      out.push(rebuildTunnel(mp, record, spec, ctx));
    } catch {
      clearResumeRecord(tunnelId); // unrestorable → drop; user falls through to a fresh match
    }
  }
  return out;
}

/** Send THIS seat's resync (latest nonce + pending flag + checkpoint + full state for gap-fill). */
function sendResync<State, Move>(args: AttachResumeArgs<State, Move>): void {
  const snap = args.tunnel.snapshot();
  args.channel.sendPeer({
    t: "resync",
    nonce: snap.nonce.toString(),
    hasPending: snap.pending !== null,
    checkpoint: snap.latest ? toWireCoSigned(snap.latest) : undefined,
    fullState: args.adapter.serializeState(snap.state),
  } as Extract<PeerMessage, { t: "resync" }>);
}

/** React to a peer's resync: decide, then act on the LOCAL tunnel (verify-on-adopt). */
function onResync<State, Move>(
  args: AttachResumeArgs<State, Move>,
  msg: Extract<PeerMessage, { t: "resync" }>,
): void {
  const snap = args.tunnel.snapshot();
  const self: ResyncView = {
    nonce: snap.nonce,
    hasPending: snap.pending !== null,
    checkpoint: snap.latest,
  };
  const peerCp: CoSignedUpdate | null = msg.checkpoint
    ? fromWireCoSigned(msg.checkpoint)
    : null;
  const peer: ResyncView = {
    nonce: BigInt(msg.nonce),
    hasPending: msg.hasPending,
    checkpoint: peerCp,
  };
  const { action } = decideReconcile(self, peer);
  try {
    if (action === "adopt" && peerCp && msg.fullState !== undefined) {
      // adoptCheckpoint swaps in the peer's PUBLIC fullState, which carries none of our local secrets
      // (hole cards / slot secrets are stripped on serialize). Capture them first and re-apply after —
      // mirroring restoreInto's cold-load path — so adopting the peer's checkpoint never blanks our hand.
      const secret = args.adapter.captureSecret?.();
      args.tunnel.adoptCheckpoint(
        args.adapter.deserializeState(msg.fullState),
        peerCp,
      );
      if (secret !== undefined && args.adapter.restoreSecret)
        args.adapter.restoreSecret(secret);
      // We jumped to the peer's CONFIRMED checkpoint. If it also holds a pending move beyond that
      // (it proposed N+1 but we hadn't ACKed before the drop), this single round strands us at the
      // checkpoint — the peer "waited" on our older nonce and never re-sent. Now that we're caught up,
      // resync again so the peer re-proposes its pending and we both reach it.
      if (msg.hasPending) sendResync(args);
    } else if (action === "re-propose") {
      args.tunnel.resendPending();
    }
    // "wait"/"noop" do nothing; "settle" is surfaced to the game via onReconciled.
    args.adapter.onReconciled(args.tunnel, action);
  } catch {
    // adoptCheckpoint rejected (equivocation / tamper) -> fall through to the settlement floor.
    args.adapter.onReconciled(args.tunnel, "settle");
  }
}

/**
 * Wire persistence + the resync handshake. Persists on every confirmed move (debounced), sends a
 * resync when the peer is reachable (`resume.ok` with peerOnline, or `peer.resumed`), and reacts to
 * the peer's resync. Returns a detach fn (unsubscribes; does not close the socket).
 */
export function attachResume<State, Move>(
  args: AttachResumeArgs<State, Move>,
): () => void {
  const { mp, channel, tunnel, identity } = args;
  const persist = args.persist ?? writeResumeRecord;

  // Persist on confirm, preserving any game-set onConfirmed.
  const prevConfirmed = tunnel.onConfirmed;
  tunnel.onConfirmed = (u) => {
    prevConfirmed?.(u);
    const rec = buildRecord(tunnel, args.adapter, identity);
    if (rec) persist(rec);
  };

  // Persist on PROPOSE too, preserving any game-set onProposed. `onConfirmed` fires only AFTER the
  // pending clears, so it can never capture a still-in-flight move — without this the proposer's
  // pending is lost on reload. Two things ride on that pending surviving: a commit-reveal seat's
  // fresh secret lives only in the pending proposal until the ACK (captureSecret reads the pending/
  // display state), so a reload in the propose→ACK window would strand the seat at draw_reveal with
  // no matching pre-image; and the co-located bot's resync-less resume relies on the restored pending,
  // which `resumeKick` re-sends so the bot's replayed ACK finds a match instead of throwing "unexpected
  // ACK". Uses the injected `persist` sink (IndexedDB in the worker engine, localStorage otherwise).
  const prevProposed = tunnel.onProposed;
  tunnel.onProposed = () => {
    prevProposed?.();
    const rec = buildRecord(tunnel, args.adapter, identity);
    if (rec) persist(rec);
  };

  // Route the peer's resync through the channel's existing onPeer; preserve any prior handler.
  const peerHandler = (m: Exclude<PeerMessage, { t: "frame" }>) => {
    if ((m as { t: string }).t === "resync")
      onResync(args, m as Extract<PeerMessage, { t: "resync" }>);
  };
  channel.addPeerListener(peerHandler);

  // On resume: announce our nonce (so a live bot targets its replay) AND re-deliver any restored
  // in-flight move. `restoreInto` re-seats the pending WITHOUT sending, and only the generic hook
  // called `resendPending` itself — the custom hooks (poker, tic-tac-toe/caro, battleship, blackjack)
  // did not, so a move made just before a reload was persisted (onProposed) but never re-sent, and a
  // bot that hadn't received it deadlocked. Doing it HERE covers every hook. Both are idempotent: an
  // unanswered resync is harmless, and the bot re-ACKs a duplicate move; `resendPending` no-ops with
  // nothing pending.
  const resumeKick = () => {
    sendResync(args);
    args.tunnel.resendPending();
  };
  const offOk = mp.onResumeOk((e) => {
    if (e.matchId === identity.matchId) resumeKick();
  });
  const offRes = mp.onPeerResumed((e) => {
    if (e.matchId === identity.matchId) resumeKick();
  });

  const graceMs = args.graceMs ?? 3_600_000;
  const timers = args.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) =>
      clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let graceHandle: unknown = null;
  const cancelGrace = () => {
    if (graceHandle != null) {
      timers.clearTimeout(graceHandle);
      graceHandle = null;
    }
  };

  const offDrop = mp.onPeerDropped((e) => {
    if (e.matchId !== identity.matchId) return;
    cancelGrace();
    graceHandle = timers.setTimeout(() => {
      graceHandle = null;
      args.onGraceExpired?.(tunnel.snapshot().latest);
    }, graceMs);
  });
  // a peer return cancels the grace timer (handshake handles convergence instead)
  const offOkCancel = mp.onResumeOk((e) => {
    if (e.matchId === identity.matchId && e.peerOnline) cancelGrace();
  });
  const offResCancel = mp.onPeerResumed((e) => {
    if (e.matchId === identity.matchId) cancelGrace();
  });

  return () => {
    offOk();
    offRes();
    offDrop();
    offOkCancel();
    offResCancel();
    cancelGrace();
    channel.removePeerListener(peerHandler);
    if (tunnel.onConfirmed) tunnel.onConfirmed = prevConfirmed;
    if (tunnel.onProposed) tunnel.onProposed = prevProposed;
  };
}
