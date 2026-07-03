/**
 * Reload-grade resume persistence. Each seat persists a compact ResumeRecord per tunnel to
 * localStorage (the same synchronous, reload-surviving home as the ephemeral signer, pvpIdentity).
 * Writes are debounced/coalesced off the move hot path; a synchronous pagehide/visibilitychange
 * flush guarantees durability before a reload. bigints are tagged through a JSON replacer/reviver;
 * the signed wire fields persist as hex / decimal strings so a record reconstructs a settleable
 * CoSignedUpdate. Losing the latest checkpoint to the debounce window is safe — restore lands at
 * most one move behind, which the reconciliation handshake closes.
 */
import { toHex, fromHex } from "sui-tunnel-ts/core/bytes";
import { keyPairFromSecret, type KeyPair } from "sui-tunnel-ts/core/crypto";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import type { StateUpdate } from "sui-tunnel-ts/core/wire";

export type JsonValue = unknown;

const KEY_PREFIX = "mp_resume.v1:";
const INDEX_KEY = "mp_resume.v1.index";
const DEFAULT_TTL_MS = 6 * 3600_000;

/** localStorage-safe form of a signed StateUpdate (stateHash hex; u64s decimal strings). */
export interface WireStateUpdate {
  tunnelId: string;
  stateHash: string;
  nonce: string;
  timestamp: string;
  partyABalance: string;
  partyBBalance: string;
}
export interface WireCoSigned {
  update: WireStateUpdate;
  sigA: string;
  sigB: string;
}

/** Compact per-tunnel resume state. `latestState`/`pending.move`/`secret` are adapter-serialized. */
export interface ResumeRecord {
  matchId: string;
  tunnelId: string;
  role: "A" | "B";
  game: string;
  opponentWallet: string;
  opponentPubkeyHex: string;
  /** Per-match self signing secret (hex). Persisted so a cold reload can rebuild the ephemeral
   *  KeyPair needed to co-sign moves and the resync. Optional-at-read: records written before this
   *  field existed are unrestorable and get evicted on rebuild. */
  selfEphemeralSecretHex?: string;
  latestCoSigned: WireCoSigned;
  latestState: JsonValue;
  pending?: { move: JsonValue; timestamp: string };
  secret?: JsonValue;
  /** Whether `latestState` is a game-over (terminal) state, stamped at write time where the game
   *  protocol is available. Lets proto-less readers (the batched arena allocate) tell a finished
   *  match from an in-flight one without a protocol: a finished match must NOT suppress a fresh
   *  allocate on reload. Absent on records written before this field existed (treated as non-terminal). */
  terminal?: boolean;
  /** Wall-clock ms when we raised an on-chain dispute on this tunnel (the grace floor fired: the peer
   *  was gone). Set → the tunnel is `STATUS_DISPUTED` on-chain, so a cold-resume must NOT rebuild it as
   *  a live match; instead it force-closes to claim once the on-chain timeout has elapsed (see
   *  `disputesToFinalize`). Absent on every normal in-flight record. */
  disputedAt?: number;
  updatedAt: number;
}

/** Rebuild an ephemeral signing KeyPair from a persisted hex secret (cold-load only). */
export function keypairFromSecretHex(secretHex: string): KeyPair {
  return keyPairFromSecret(fromHex(secretHex));
}

export function toWireCoSigned(u: CoSignedUpdate): WireCoSigned {
  return {
    update: {
      tunnelId: u.update.tunnelId,
      stateHash: toHex(u.update.stateHash),
      nonce: u.update.nonce.toString(),
      timestamp: u.update.timestamp.toString(),
      partyABalance: u.update.partyABalance.toString(),
      partyBBalance: u.update.partyBBalance.toString(),
    },
    sigA: toHex(u.sigA),
    sigB: toHex(u.sigB),
  };
}
export function fromWireCoSigned(w: WireCoSigned): CoSignedUpdate {
  const update: StateUpdate = {
    tunnelId: w.update.tunnelId,
    stateHash: fromHex(w.update.stateHash),
    nonce: BigInt(w.update.nonce),
    timestamp: BigInt(w.update.timestamp),
    partyABalance: BigInt(w.update.partyABalance),
    partyBBalance: BigInt(w.update.partyBBalance),
  };
  return { update, sigA: fromHex(w.sigA), sigB: fromHex(w.sigB) };
}

const BIGINT_TAG = "__bigint__";
export function stringifyWithBigint(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    typeof val === "bigint" ? { [BIGINT_TAG]: val.toString() } : val,
  );
}
export function parseWithBigint(s: string): unknown {
  return JSON.parse(s, (_k, val) => {
    if (
      val &&
      typeof val === "object" &&
      typeof (val as Record<string, unknown>)[BIGINT_TAG] === "string"
    ) {
      return BigInt((val as Record<string, string>)[BIGINT_TAG]);
    }
    return val;
  });
}

function ls(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}
function readIndex(): string[] {
  const raw = ls()?.getItem(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}
function writeIndex(ids: string[]): void {
  ls()?.setItem(INDEX_KEY, JSON.stringify([...new Set(ids)]));
}

// Debounce: keep the newest record per tunnel dirty; flush coalesces to one write each.
const dirty = new Map<string, ResumeRecord>();
let scheduled = false;

export function writeResumeRecord(r: ResumeRecord): void {
  dirty.set(r.tunnelId, r);
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    scheduled = false;
    flushResumeWrites();
  };
  // Coalesce a burst of confirmed moves into one write; microtask if available, else timer.
  if (typeof queueMicrotask === "function") queueMicrotask(flush);
  else setTimeout(flush, 0);
}

export function flushResumeWrites(): void {
  const store = ls();
  if (!store) {
    dirty.clear();
    return;
  }
  if (dirty.size === 0) return;
  const ids = readIndex();
  for (const [tunnelId, rec] of dirty) {
    store.setItem(KEY_PREFIX + tunnelId, stringifyWithBigint(rec));
    if (!ids.includes(tunnelId)) ids.push(tunnelId);
  }
  writeIndex(ids);
  dirty.clear();
}

export function readResumeRecord(tunnelId: string): ResumeRecord | null {
  const raw = ls()?.getItem(KEY_PREFIX + tunnelId);
  if (!raw) return null;
  try {
    return parseWithBigint(raw) as ResumeRecord;
  } catch {
    return null;
  }
}

export function clearResumeRecord(tunnelId: string): void {
  dirty.delete(tunnelId);
  ls()?.removeItem(KEY_PREFIX + tunnelId);
  writeIndex(readIndex().filter((id) => id !== tunnelId));
}

export function listActiveTunnels(): string[] {
  return readIndex().filter((id) => ls()?.getItem(KEY_PREFIX + id) != null);
}

/** Whether an in-flight match for `game` is persisted — the signal a game's mode/lane UI uses on a
 *  fresh load (a reload wipes in-memory mode) to reopen the PvP lane so its hook can resume, instead
 *  of dropping to a default lane. A lingering finished record self-heals: the lane's resume clears
 *  records whose state is terminal. */
export function hasResumableMatch(game: string): boolean {
  return listActiveTunnels().some((id) => readResumeRecord(id)?.game === game);
}

export function evictExpiredRecords(maxAgeMs: number = DEFAULT_TTL_MS): void {
  const now = Date.now();
  for (const id of readIndex()) {
    const rec = readResumeRecord(id);
    if (!rec || now - rec.updatedAt >= maxAgeMs) clearResumeRecord(id);
  }
}

let installed = false;
/** Register synchronous flush on tab hide/close. Idempotent; safe to call on app mount. */
export function installResumePersistence(): void {
  if (installed) return;
  const w = (
    globalThis as {
      window?: { addEventListener?: (t: string, cb: () => void) => void };
    }
  ).window;
  if (!w?.addEventListener) return;
  installed = true;
  w.addEventListener("pagehide", flushResumeWrites);
  w.addEventListener("visibilitychange", () => {
    const doc = (globalThis as { document?: { visibilityState?: string } })
      .document;
    if (doc?.visibilityState === "hidden") flushResumeWrites();
  });
}
