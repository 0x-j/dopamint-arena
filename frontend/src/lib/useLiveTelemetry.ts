import { useEffect, useRef, useState } from "react";

import { PLACEHOLDER_SNAPSHOT } from "../placeholders";
import type { TelemetrySnapshot, TxnRow } from "../panels/types";

/**
 * Demo-only telemetry source: seeds from {@link PLACEHOLDER_SNAPSHOT} and drifts
 * it on an interval so the dashboard, sparkline, and feeds look live. It emits
 * the exact {@link TelemetrySnapshot} shape the real engine will, so swapping in
 * a worker-backed source later needs no panel changes.
 */
const TICK_MS = 1100;
const DT = TICK_MS / 1000;

// Each transaction is tagged with its registry game id so the feed can tab by game.
const GAME_FEED: { game: string; type: string }[] = [
  { game: "blackjack", type: "Blackjack Win" },
  { game: "quantum-poker", type: "Poker Win" },
  { game: "tic-tac-toe", type: "TicTacToe Win" },
  { game: "coin-flip", type: "Coin Flip" },
  { game: "dice", type: "Dice Roll" },
  { game: "slots", type: "Slots Spin" },
  { game: "regular-payments", type: "Payment" },
  { game: "chat", type: "Tip" },
];

const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const rndInt = (lo: number, hi: number) => Math.floor(rnd(lo, hi + 1));
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const nowStr = () => new Date().toLocaleTimeString("en-US", { hour12: false });

// Plausible-looking mock identifiers so the feed's explorer links have shape.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const randStr = (alphabet: string, len: number) =>
  Array.from(
    { length: len },
    () => alphabet[rndInt(0, alphabet.length - 1)],
  ).join("");
const mockDigest = () => randStr(B58, 44);
const mockAddress = () => `0x${randStr("0123456789abcdef", 64)}`;

function makeTxn(id: number): { row: TxnRow; delta: number } {
  const failed = Math.random() < 0.06;
  const magnitude = round2(rnd(1, 80));
  const delta = failed ? -magnitude : magnitude;
  const event = GAME_FEED[rndInt(0, GAME_FEED.length - 1)];
  return {
    row: {
      id,
      game: event.game,
      digest: mockDigest(),
      address: mockAddress(),
      time: nowStr(),
      bot: `Bot #${rndInt(1, 16)}`,
      type: event.type,
      status: failed ? "Failed" : "Success",
      amount: `${delta >= 0 ? "+" : "-"}$${Math.abs(delta).toFixed(2)}`,
    },
    delta,
  };
}

// Off-chain action verbs per game — the Local feed shows pre-settlement moves.
const LOCAL_FEED: { game: string; type: string }[] = [
  { game: "blackjack", type: "Blackjack Hit" },
  { game: "quantum-poker", type: "Poker Raise" },
  { game: "tic-tac-toe", type: "TicTacToe Move" },
  { game: "coin-flip", type: "Coin Flip" },
  { game: "dice", type: "Dice Roll" },
  { game: "slots", type: "Slots Spin" },
  { game: "regular-payments", type: "Transfer" },
  { game: "chat", type: "Tip" },
];

// A local move: a co-signed tunnel action with no on-chain anchor (no digest) yet.
function makeLocalTxn(id: number): TxnRow {
  const failed = Math.random() < 0.05;
  const magnitude = round2(rnd(0.25, 8));
  const event = LOCAL_FEED[rndInt(0, LOCAL_FEED.length - 1)];
  return {
    id,
    game: event.game,
    time: nowStr(),
    bot: `Bot #${rndInt(1, 16)}`,
    type: event.type,
    status: failed ? "Failed" : "Success",
    amount: `${failed ? "-" : "+"}$${magnitude.toFixed(2)}`,
  };
}

function advance(
  prev: TelemetrySnapshot,
  nextId: () => number,
): TelemetrySnapshot {
  const r = prev.rate;
  const updatesPerSec = clamp(r.updatesPerSec + rnd(-900, 900), 18_000, 30_000);
  const bytesPerSec = Math.round(updatesPerSec * 126);

  const fresh = Array.from({ length: rndInt(1, 3) }, () => makeTxn(nextId()));
  const netDelta = fresh.reduce((sum, t) => sum + t.delta, 0);
  // Off-chain moves arrive faster than on-chain settlements.
  const freshLocal = Array.from({ length: rndInt(2, 5) }, () =>
    makeLocalTxn(nextId()),
  );

  const lastTps = prev.tpsSeries[prev.tpsSeries.length - 1] ?? 24;
  const nextTps = clamp(lastTps + rnd(-3, 3), 12, 30);

  const addDeposit = Math.random() < 0.18;
  const depositAmt = round2(rnd(25, 250));

  return {
    rate: {
      ...r,
      updatesPerSec,
      signaturesPerSec: updatesPerSec * 2,
      verificationsPerSec: updatesPerSec * 2,
      bytesPerSec,
      updates: r.updates + Math.round(updatesPerSec * DT),
      signatures: r.signatures + Math.round(updatesPerSec * 2 * DT),
      verifications: r.verifications + Math.round(updatesPerSec * 2 * DT),
      bytes: r.bytes + Math.round(bytesPerSec * DT),
      elapsedSec: round2(r.elapsedSec + DT),
      tunnelsActive: clamp(r.tunnelsActive + rndInt(-3, 3), 600, 760),
      tunnelsOpened: r.tunnelsOpened + (Math.random() < 0.5 ? 1 : 0),
      tunnelsClosed: r.tunnelsClosed + (Math.random() < 0.3 ? 1 : 0),
      settlements: r.settlements + (Math.random() < 0.3 ? 1 : 0),
      errors: r.errors + (Math.random() < 0.05 ? 1 : 0),
    },
    botsRunning: clamp(
      prev.botsRunning +
        (Math.random() < 0.2 ? (Math.random() < 0.5 ? 1 : -1) : 0),
      8,
      24,
    ),
    totalBalance: round2(prev.totalBalance + netDelta),
    successRate: clamp(
      round2(prev.successRate + rnd(-0.05, 0.05)),
      98.5,
      99.95,
    ),
    tpsSeries: [...prev.tpsSeries.slice(1), round2(nextTps)],
    txns: [...fresh.map((t) => t.row), ...prev.txns].slice(0, 30),
    localTxns: [...freshLocal, ...prev.localTxns].slice(0, 30),
    deposits: addDeposit
      ? [
          {
            id: nextId(),
            time: nowStr(),
            method: ["USDT (TRC20)", "USDC (ERC20)", "BTC", "SUI"][
              rndInt(0, 3)
            ],
            amount: `+$${depositAmt.toFixed(2)}`,
            status: "Success" as const,
          },
          ...prev.deposits,
        ].slice(0, 12)
      : prev.deposits,
  };
}

export function useLiveTelemetry(): TelemetrySnapshot {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(() =>
    structuredClone(PLACEHOLDER_SNAPSHOT),
  );
  const seq = useRef(1000);

  useEffect(() => {
    const nextId = () => seq.current++;
    const timer = setInterval(
      () => setSnapshot((prev) => advance(prev, nextId)),
      TICK_MS,
    );
    return () => clearInterval(timer);
  }, []);

  return snapshot;
}
