import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.PACKAGE_ID = "0x2";

import {
  BulkOpenJob,
  OpenCancelledError,
  BULK_OPEN_QUIET_MS,
  BULK_OPEN_MAX_WINDOW_MS,
  type OpenResult,
} from "./bulkOpenJob.ts";
import type { OpenTunnelParams } from "../engineApi";

const pk = (b: number) => new Uint8Array(32).fill(b);
const intent = (sender: string, label: string): OpenTunnelParams => ({
  partyA: { address: sender, publicKey: pk(1) },
  partyB: { address: `0xb${label}`, publicKey: pk(2) },
  amount: 1n,
  label,
});

/** A recording batch opener: returns one tunnel id per intent in input order. */
function recorder() {
  const batches: OpenTunnelParams[][] = [];
  const open = async (b: OpenTunnelParams[]): Promise<OpenResult[]> => {
    batches.push(b);
    return b.map((p) => ({ tunnelId: `t-${p.label}` }));
  };
  return { batches, open };
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

test("a lone open flushes after the quiet gap, not before", async () => {
  const { batches, open } = recorder();
  const job = new BulkOpenJob(open, { enabled: () => true });

  const p = job.enqueue(intent("0xA", "g1"));
  mock.timers.tick(BULK_OPEN_QUIET_MS - 1);
  assert.equal(
    batches.length,
    0,
    "must not flush before the quiet gap elapses",
  );

  mock.timers.tick(1);
  assert.deepEqual(await p, { tunnelId: "t-g1" });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
});

test("near-simultaneous opens coalesce into ONE PTB", async () => {
  const { batches, open } = recorder();
  const job = new BulkOpenJob(open, { enabled: () => true });

  // Three opens arriving ~100 ms apart (the "open all games at once" reload shape).
  const p1 = job.enqueue(intent("0xA", "g1"));
  mock.timers.tick(100);
  const p2 = job.enqueue(intent("0xA", "g2"));
  mock.timers.tick(100);
  const p3 = job.enqueue(intent("0xA", "g3"));
  assert.equal(batches.length, 0, "each new open resets the quiet timer");

  mock.timers.tick(BULK_OPEN_QUIET_MS);
  const r = await Promise.all([p1, p2, p3]);
  assert.equal(
    batches.length,
    1,
    "one flush ⇒ one sponsored PTB for all three",
  );
  assert.equal(batches[0].length, 3);
  assert.deepEqual(r, [
    { tunnelId: "t-g1" },
    { tunnelId: "t-g2" },
    { tunnelId: "t-g3" },
  ]);
});

test("the hard cap flushes a steady trickle that keeps resetting the quiet timer", async () => {
  const { batches, open } = recorder();
  const job = new BulkOpenJob(open, {
    enabled: () => true,
    quietMs: 500,
    maxWindowMs: 2000,
  });

  const ps = [job.enqueue(intent("0xA", "g0"))];
  // Enqueue one every 400 ms (< quietMs) so the quiet timer never elapses on its own.
  for (let t = 400; t <= 1600; t += 400) {
    mock.timers.tick(400);
    ps.push(job.enqueue(intent("0xA", `g${t}`)));
  }
  assert.equal(
    batches.length,
    0,
    "quiet keeps resetting; cap (2000) not yet reached",
  );

  mock.timers.tick(400); // elapsed 2000 ⇒ the cap fires
  await Promise.all(ps);
  assert.equal(batches.length, 1, "cap-bounded flush");
  assert.equal(
    batches[0].length,
    5,
    "all opens up to the cap deadline batched",
  );
});

test("different senders flush as separate PTBs (one sender per PTB)", async () => {
  const { batches, open } = recorder();
  const job = new BulkOpenJob(open, { enabled: () => true });

  job.enqueue(intent("0xAAA", "a1"));
  job.enqueue(intent("0xBBB", "b1"));
  mock.timers.tick(BULK_OPEN_QUIET_MS);

  assert.equal(batches.length, 2, "sharded by sender");
  assert.equal(batches[0].length, 1);
  assert.equal(batches[1].length, 1);
});

test("cancel drops a queued open before flush and excludes it from the batch", async () => {
  const { batches, open } = recorder();
  const job = new BulkOpenJob(open, { enabled: () => true });

  const keep = job.enqueue(intent("0xA", "keep"), "i-keep");
  const drop = job.enqueue(intent("0xA", "drop"), "i-drop");
  job.cancel("i-drop");
  await assert.rejects(drop, OpenCancelledError);

  mock.timers.tick(BULK_OPEN_QUIET_MS);
  assert.deepEqual(await keep, { tunnelId: "t-keep" });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1, "only the surviving intent is opened");
});

test("cancelling the last queued open clears its shard — no stray flush", async () => {
  const { batches, open } = recorder();
  const job = new BulkOpenJob(open, { enabled: () => true });

  const only = job.enqueue(intent("0xA", "only"), "i-only");
  job.cancel("i-only");
  await assert.rejects(only, OpenCancelledError);

  mock.timers.tick(BULK_OPEN_MAX_WINDOW_MS + 10);
  assert.equal(batches.length, 0, "no timer survives an emptied shard");
});

test("off the flag, an open is an immediate 1-item batch (no window)", async () => {
  const { batches, open } = recorder();
  const job = new BulkOpenJob(open, { enabled: () => false });

  const r = await job.enqueue(intent("0xA", "g1"));
  assert.deepEqual(r, { tunnelId: "t-g1" });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
});
