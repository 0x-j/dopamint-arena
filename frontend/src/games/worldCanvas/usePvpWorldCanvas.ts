/**
 * Online PvP for World Canvas: two real humans matched over the relay co-sign ONE
 * genuine 2-party tunnel and co-draw a shared canvas. Built on the shared, proven
 * {@link createPvpMatchHook} engine (matchmaking → fund → propose/ack co-sign → settle),
 * specialized by the {@link WorldCanvasPvpProtocol} (rolling-digest co-sign + a render-only
 * cell list) and a BATCHED paint move. With Auto on, both seats are bot-driven.
 *
 * Throughput: the channel is turn-based (the seats co-sign alternately), so one cell per
 * turn would crawl and a fast drag would lose most of its cells. Instead each co-signed
 * move carries a RUN of cells: `paint()` buffers your cells and flushes the whole pending
 * run as ONE move on your turn, trimming cells from the buffer as they confirm in the
 * view — so a drag crosses as a stroke, not sparse dots. The batch move is JSON-native
 * (chunk indices are JS safe ints), so the tunnel carries it over the relay with no codec,
 * exactly like chicken-cross.
 */
import { useCallback, useEffect, useRef } from "react";
import {
  createPvpMatchHook,
  type PvpMatch,
  type PvpStatus,
} from "@/pvp/pvpMatchHook";
import type { Role } from "@/pvp/mpClient";
import {
  WorldCanvasPvpProtocol,
  CHUNK_SIZE,
  MAX_BATCH_CELLS,
  type PvpCanvasState,
  type PvpCell,
  type PvpCellMove,
  type PvpPaintMove,
} from "sui-tunnel-ts/protocol/worldCanvasPvp";
import { makeWorldCanvasPvpResumeAdapter } from "./pvpResumeAdapter";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { engineEnabled } from "@/engine/flag";
import { engineClient } from "@/engine/engineClient";
import { useGameMatch } from "@/engine/react/useGameMatch";
import { useArenaWorkerEntry } from "@/engine/react/useArenaWorkerEntry";
import { useWorkerArenaPlay } from "@/engine/react/useWorkerArenaPlay";
import type { MatchSnapshot } from "@/engine/engineApi";

/** A seat's queued paint == the co-signed batch move (a run of cells). */
export type PaintIntent = PvpPaintMove;

/** Default when no human paint is pending: an empty run (a no-op co-sign tick). */
const IDLE_INTENT: PaintIntent = { cells: [] };

function intentToMove(_role: Role, i: PaintIntent): PvpPaintMove {
  return i;
}

function readIntent(
  _role: Role,
  m: PvpPaintMove | null,
): PaintIntent | undefined {
  return m ?? undefined;
}

/** Backend arena/`profile_for` id (underscore form of the registry id). Single source of truth for
 *  both the engine's arena consumer (the spec below) and `GameModule.arenaGameId` (index.ts). */
export const WORLD_CANVAS_ARENA_GAME_ID = "world_canvas";

/** @deprecated `?engine=legacy` fallback only — the worker spec in `worldCanvasSpec.ts` is the
 *  primary path. */
const useLegacyMatch = createPvpMatchHook<
  PvpCanvasState,
  PvpPaintMove,
  PaintIntent,
  PvpCell[]
>({
  game: "world-canvas",
  arenaGameId: WORLD_CANVAS_ARENA_GAME_ID,
  stepMs: 80,
  stake: 1n, // 1 MIST per seat — free/draw, never shifts (each human funds its own seat)
  makeProtocol: () => new WorldCanvasPvpProtocol(),
  deriveView: (s) => s.cells,
  makeResumeAdapter: makeWorldCanvasPvpResumeAdapter,
  idleIntent: IDLE_INTENT,
  intentToMove,
  readIntent,
});

/** Worker path (`?engine=worker`): same PvpMatch surface, backed by the worker engine; the
 *  paint-buffer wrapper below is unchanged. */
function useWorkerMatch(
  windowId: string,
): PvpMatch<PvpCanvasState, PaintIntent, PvpCell[]> {
  const snap = useGameMatch(windowId, "world-canvas") as MatchSnapshot<
    PvpCell[],
    PvpCanvasState["winner"]
  >;
  useArenaWorkerEntry({
    windowId,
    gameId: "world-canvas",
    arenaGameId: WORLD_CANVAS_ARENA_GAME_ID,
    isIdle: () => snap.status === "idle",
  });
  const playArena = useWorkerArenaPlay({
    windowId,
    gameId: "world-canvas",
    arenaGameId: WORLD_CANVAS_ARENA_GAME_ID,
    label: "world-canvas",
  });
  return {
    status: snap.status,
    role: snap.role,
    stake: snap.stake,
    auto: snap.auto,
    view: snap.view,
    winner: snap.winner,
    error: snap.error,
    findMatch: () => engineClient.findMatch(windowId, "world-canvas"),
    playArena: () => playArena(),
    setIntent: (i) => engineClient.submitInput(windowId, i),
    toggleAuto: () => engineClient.setAuto(windowId, !snap.auto),
    reset: () => engineClient.reset(windowId),
    leave: () => engineClient.reset(windowId),
    // Worker interim: same teardown as leave; a true concede needs engine support — follow-up.
    forfeit: () => engineClient.reset(windowId),
  };
}

/** `?engine=worker` selects the worker path; default keeps the main-thread path. Bound once
 *  at module load so the hook identity is stable per session (rules-of-hooks). */
const usePvpMatch = engineEnabled() ? useWorkerMatch : useLegacyMatch;

export type { PvpStatus };

export interface PvpWorldCanvas extends Omit<
  PvpMatch<PvpCanvasState, PaintIntent, PvpCell[]>,
  "setIntent"
> {
  /** Queue a painted cell (global-pixel coords). Buffered + co-signed as a run on your turn. */
  paint: (gx: number, gy: number, color: number) => void;
}

/** Flatten a global-pixel cell to a (chunk, in-chunk) move with its per-seat `seq`; floorDiv
 *  keeps x/y in-range for negative globals (the canvas extends in every direction). */
function toCellMove(
  gx: number,
  gy: number,
  color: number,
  seq: number,
): PvpCellMove {
  const cx = Math.floor(gx / CHUNK_SIZE);
  const cy = Math.floor(gy / CHUNK_SIZE);
  return {
    cx,
    cy,
    x: gx - cx * CHUNK_SIZE,
    y: gy - cy * CHUNK_SIZE,
    color,
    seq,
  };
}

/** Dashboard game key — groups PvP rows under the SAME "world-canvas" feed/tab as the solo
 *  wall, so MY ACTIVITY + LIVE TRANSACTIONS show open/painted/settled rows for online PvP too. */
const GAME = "world-canvas";
/** Leading-edge throttle (ms) between MY-ACTIVITY "painted N cell(s)" rows for your seat —
 *  mirrors the solo wall's bot-activity throttle so a fast co-draw summarizes into one row per
 *  window instead of flooding the feed. */
const PVP_PAINT_ACTIVITY_THROTTLE_MS = 1500;

/** Deterministic non-negative 31-bit int from a string — a stable React key for a feed row
 *  (TelemetryProvider reassigns a globally-unique id on push, so this only needs per-row
 *  uniqueness). Replicated from the solo wall (useWorldCanvasOnchain) so PvP rows key the same. */
function feedRowId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return Math.abs(h | 0);
}

/** Compact id (head…tail of the 0x address) for a feed row's `bot` column. */
function shortTunnelId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** A valid 32-byte 0x id minted per match purely for the dashboard `bot` column. The shared
 *  PvP engine doesn't surface the real on-chain tunnel id through its hook (and that hook is
 *  off-limits), so each match stamps its own short id so the open/settle rows have a handle. */
function makeSyntheticMatchId(): string {
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `0x${`${Date.now().toString(16)}${rand}`.padStart(64, "0")}`;
}

export function usePvpWorldCanvas(windowId: string): PvpWorldCanvas {
  const { setIntent, ...rest } = usePvpMatch(windowId);
  const role = rest.role;
  const view = rest.view;
  const auto = rest.auto;

  // YOUR un-confirmed cells, FIFO. `paint` stamps each with a per-seat `seq` and queues the
  // buffer's head (capped at the batch limit) as the next move; the engine sends it on your
  // turn. Re-sending is now PARITY-SAFE — the protocol folds each cell at most once per seat by
  // `seq` — so the buffer can stay at-least-once and we never double-fold the digest.
  const pendingRef = useRef<PvpCellMove[]>([]);
  // Next per-seat seq to stamp. Monotonic; re-seeded above the seat's applied cursor so a paint
  // taken back from the bot continues the seat's seq line instead of replaying skipped numbers.
  const nextSeqRef = useRef(1);
  // High-water of MY confirmed per-seat seq. Monotonic and taken as a MAX over the view, so the
  // render cap (drops oldest) and eviction can never corrupt it — fixing the trim counter that
  // pegged at the cap before. Cells at/below it are on-chain and safe to drop from the buffer.
  const confirmedSeqRef = useRef(0);

  /** Hand the buffer's head to the engine as the next move (≤ batch cap, so propose never throws
   *  "illegal batch" and stalls the turn loop); empty buffer ⇒ an idle co-sign tick. */
  const flush = useCallback(() => {
    const head = pendingRef.current.slice(0, MAX_BATCH_CELLS);
    setIntent(head.length ? { cells: head } : IDLE_INTENT);
  }, [setIntent]);

  useEffect(() => {
    if (!role) {
      // Between matches: drop any stale buffer so a new match starts clean.
      pendingRef.current = [];
      nextSeqRef.current = 1;
      confirmedSeqRef.current = 0;
      return;
    }
    // Advance the confirmed high-water from MY cells in the view (incl. bot paints while Auto was
    // on), so we never re-stamp a seq the seat already folded.
    let myMax = confirmedSeqRef.current;
    for (const c of view ?? []) {
      if (c.by === role && c.pseq > myMax) myMax = c.pseq;
    }
    confirmedSeqRef.current = myMax;
    if (nextSeqRef.current <= myMax) nextSeqRef.current = myMax + 1;

    if (auto) {
      // The bot drives this seat; drop any stale manual buffer so it can't replay later as a
      // run of already-skipped seqs.
      pendingRef.current = [];
      return;
    }
    // Drop confirmed cells; re-sending the rest is a safe no-op, so this only bounds the buffer.
    pendingRef.current = pendingRef.current.filter((c) => c.seq > myMax);
    flush();
  }, [view, role, auto, flush]);

  const paint = useCallback(
    (gx: number, gy: number, color: number) => {
      const seq = nextSeqRef.current++;
      pendingRef.current.push(toCellMove(gx, gy, color, seq));
      flush();
    },
    [flush],
  );

  // ─── Dashboard telemetry ────────────────────────────────────────────────────
  // PvP runs through the shared, telemetry-free engine, so the open/painted/settled rows are
  // wired HERE off this hook's own status/view transitions (the solo wall wires the identical
  // rows directly). Every write is best-effort: a feed error can NEVER throw back into the
  // co-sign/sync path or stall the turn loop.
  const { report } = useTelemetry();
  const status = rest.status;
  // Per-match guards so "open" fires once and "settle" fires once; reset at each new match.
  const openFiredRef = useRef(false);
  const settleFiredRef = useRef(false);
  // Synthetic short id for the feed `bot` column (the engine hides the real tunnel id).
  const matchIdRef = useRef<string | null>(null);
  // High-water of MY confirmed GLOBAL paint seq — cap-safe (new cells always seq higher, and
  // the render cap only drops the oldest), so it counts each of my cells exactly once.
  const lastPaintSeqRef = useRef(0);
  // Cells of MINE accumulated since the last MY-ACTIVITY flush + its leading-edge throttle
  // timer and a monotonic key counter (≤ one summary row per window — never a flood).
  const paintCountRef = useRef(0);
  const paintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paintFlushIdRef = useRef(0);

  // Flush the accumulated my-seat paint count into ONE "painted N cell(s)" MY-ACTIVITY row
  // ("You"). Fires on the throttle timer or eagerly at settle. MY-ACTIVITY only (no pushTxn).
  const flushPaints = useCallback(() => {
    paintTimerRef.current = null;
    const n = paintCountRef.current;
    paintCountRef.current = 0;
    if (n === 0) return;
    try {
      report.pushLocalTxn({
        id: feedRowId(`pvp-paint:${paintFlushIdRef.current++}`),
        game: GAME,
        time: new Date().toLocaleTimeString("en-GB"),
        bot: "You",
        type: `painted ${n} cell(s)`,
        status: "Success",
        amount: "",
      });
    } catch (e) {
      console.warn("[world-canvas-pvp] paint activity row skipped:", e);
    }
  }, [report]);

  // Open / settle / per-match reset, driven by the PvpStatus transitions. The engine sets
  // "playing" once the real 2-party tunnel is live (→ open rows) and "settled" once the
  // cooperative close lands (→ settle rows); "idle"/"matching" bracket a fresh match, so the
  // per-match guards reset there (the next "playing" re-fires open for the new match).
  useEffect(() => {
    try {
      if (status === "idle" || status === "matching") {
        openFiredRef.current = false;
        settleFiredRef.current = false;
        matchIdRef.current = null;
        lastPaintSeqRef.current = 0;
        paintCountRef.current = 0;
        if (paintTimerRef.current !== null) {
          clearTimeout(paintTimerRef.current);
          paintTimerRef.current = null;
        }
        return;
      }
      // ON TUNNEL OPEN: first entry into the live "playing" state for this match.
      if (status === "playing" && !openFiredRef.current) {
        openFiredRef.current = true;
        const id = makeSyntheticMatchId();
        matchIdRef.current = id;
        report.bumpCounters({ tunnelsOpened: 1 });
        report.setActive(2);
        report.pushLocalTxn({
          id: feedRowId(id),
          game: GAME,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: shortTunnelId(id),
          type: "Start",
          status: "Success",
          amount: "",
        });
        report.pushTxn({
          id: feedRowId(id),
          game: GAME,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: shortTunnelId(id),
          type: "Start",
          status: "Success",
          amount: "",
        });
      }
      // ON SETTLE/CLOSE: the cooperative close landed (terminal "settled").
      if (
        status === "settled" &&
        openFiredRef.current &&
        !settleFiredRef.current
      ) {
        settleFiredRef.current = true;
        flushPaints(); // capture any pending paints before the close row
        const id = matchIdRef.current ?? makeSyntheticMatchId();
        report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
        report.pushLocalTxn({
          id: feedRowId(`${id}:settled`),
          game: GAME,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: shortTunnelId(id),
          type: "End",
          status: "Success",
          amount: "closed",
        });
        report.pushTxn({
          id: feedRowId(`${id}:settled`),
          game: GAME,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: shortTunnelId(id),
          type: "End",
          status: "Success",
          amount: "closed",
        });
      }
    } catch (e) {
      console.warn("[world-canvas-pvp] status telemetry skipped:", e);
    }
  }, [status, report, flushPaints]);

  // PER YOUR PAINT: count NEW cells of YOUR seat (`by === role`) confirmed in `view` since the
  // last flush and arm the leading-edge throttle (one summary row per window). Skips while not
  // live so a fresh match's seq line (which restarts at 1) is only counted under "playing".
  useEffect(() => {
    if (!role || status !== "playing") return;
    try {
      let maxSeq = lastPaintSeqRef.current;
      let added = 0;
      for (const c of view ?? []) {
        if (c.by === role && c.seq > lastPaintSeqRef.current) {
          added += 1;
          if (c.seq > maxSeq) maxSeq = c.seq;
        }
      }
      lastPaintSeqRef.current = maxSeq;
      if (added > 0) {
        paintCountRef.current += added;
        if (paintTimerRef.current === null) {
          paintTimerRef.current = setTimeout(
            flushPaints,
            PVP_PAINT_ACTIVITY_THROTTLE_MS,
          );
        }
      }
    } catch (e) {
      console.warn("[world-canvas-pvp] paint tally skipped:", e);
    }
  }, [view, role, status, flushPaints]);

  // Clear the throttle timer on unmount/teardown so a pending flush can't fire after the
  // component is gone.
  useEffect(() => {
    return () => {
      if (paintTimerRef.current !== null) {
        clearTimeout(paintTimerRef.current);
        paintTimerRef.current = null;
      }
    };
  }, []);

  return { ...rest, paint };
}
