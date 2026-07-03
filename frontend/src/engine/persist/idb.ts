/**
 * Worker-owned resume persistence on IndexedDB (design §5/§6). The worker engine confines the
 * ephemeral signing secret and the game's hidden-info secret to its own thread: records persist
 * HERE, never transiting the main-thread heap, `postMessage`, or `localStorage`. That confinement
 * is the reason IndexedDB was chosen over a localStorage storage-bridge.
 *
 * IndexedDB is async, so there is no synchronous `pagehide` flush to rely on — the engine instead
 * persists eagerly on every confirmed/proposed update (the cadence `attachResume` already drives),
 * so the durable record is on disk before a reload. Records carry a 6h TTL, evicted on cold-load.
 *
 * The on-disk row stores the `ResumeRecord` as a bigint-tagged JSON string via resume.ts's
 * `stringifyWithBigint`/`parseWithBigint` — reusing the exact (de)serialization the localStorage
 * resume tests already prove, so both persistence backends round-trip a record identically.
 */
import {
  stringifyWithBigint,
  parseWithBigint,
  type ResumeRecord,
} from "@/pvp/resume";

const DB_NAME = "mp_resume";
const DB_VERSION = 1;
const STORE = "records";
const GAME_INDEX = "game";
const TTL_MS = 6 * 3600_000;

/**
 * On-disk row. `record` is the bigint-tagged JSON of the full ResumeRecord; `game` and
 * `updatedAt` are duplicated as columns so `getAllByGame` can use an index and TTL eviction can
 * scan without parsing every record.
 */
interface ResumeRow {
  tunnelId: string;
  game: string;
  updatedAt: number;
  record: string;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function idbFactory(): IDBFactory | null {
  try {
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null;
  } catch {
    return null;
  }
}

/** Open (and lazily create) the resume DB. Resolves null when IndexedDB is unavailable (SSR,
 *  private mode, blocked) so callers degrade gracefully instead of throwing — mirroring resume.ts's
 *  null-localStorage no-op path. A failed open is not cached, so a later call can retry. */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const factory = idbFactory();
  if (!factory) return Promise.resolve(null);
  const p = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "tunnelId" });
        store.createIndex(GAME_INDEX, "game", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  dbPromise = p;
  void p.then((db) => {
    if (!db) dbPromise = null;
  });
  return p;
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("idb tx failed"));
    tx.onabort = () => reject(tx.error ?? new Error("idb tx aborted"));
  });
}

/** Drop every record older than the 6h TTL in one cursor-driven readwrite tx (kept within the
 *  transaction — no awaiting between requests — to avoid auto-commit). */
async function evictExpired(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const cutoff = Date.now() - TTL_MS;
  const tx = db.transaction(STORE, "readwrite");
  const cursorReq = tx.objectStore(STORE).openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    if ((cursor.value as ResumeRow).updatedAt <= cutoff) cursor.delete();
    cursor.continue();
  };
  await txDone(tx);
}

/**
 * The worker's resume store: an object store keyed by `tunnelId` whose value is a `ResumeRecord`.
 * All ops are no-ops / empty when IndexedDB is unavailable.
 */
export const resumeIdb = {
  /** Upsert a record (eager-write-on-confirm). Last write wins per `tunnelId`. */
  async put(record: ResumeRecord): Promise<void> {
    const db = await openDb();
    if (!db) return;
    const row: ResumeRow = {
      tunnelId: record.tunnelId,
      game: record.game,
      updatedAt: record.updatedAt,
      record: stringifyWithBigint(record),
    };
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(row);
    await txDone(tx);
  },

  /** All non-expired records for a game (cold-load). Evicts expired records first; corrupt rows
   *  are skipped and dropped so one bad entry never blocks the rest. */
  async getAllByGame(game: string): Promise<ResumeRecord[]> {
    await evictExpired();
    const db = await openDb();
    if (!db) return [];
    const tx = db.transaction(STORE, "readonly");
    const rows = (await reqDone(
      tx.objectStore(STORE).index(GAME_INDEX).getAll(game),
    )) as ResumeRow[];
    const out: ResumeRecord[] = [];
    for (const row of rows) {
      try {
        out.push(parseWithBigint(row.record) as ResumeRecord);
      } catch {
        void resumeIdb.delete(row.tunnelId);
      }
    }
    return out;
  },

  /** Drop a record (on settle / when unrestorable). */
  async delete(tunnelId: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(tunnelId);
    await txDone(tx);
  },

  /** Exposed for cold-load callers/tests; `getAllByGame` already runs it. */
  evictExpired,
};
