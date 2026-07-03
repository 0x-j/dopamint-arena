import { useEffect, useState } from "react";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { PokerMove } from "sui-tunnel-ts/protocol/quantumPoker";
import type { GameWindowProps } from "../types";
import { HAND_CAP, useRoutedPvpPoker } from "./usePvpQuantumPoker";
import { POKER_BUYIN } from "./constants";
import { QuantumPokerTable, PHASE_LABEL } from "./QuantumPokerTable";
import { SketchDefs } from "../sketch";
import { PokerActionBar } from "./PokerActionBar";
import { ForfeitDialog } from "@/pvp/ForfeitDialog";

/** Heads-up Quantum Poker vs a real opponent over the relay: matchmaking + co-sign + on-chain stakes,
 *  in the shared hand-drawn skin. An in-game Auto toggle lets a persona bot make this seat's bets. */
export function QuantumPokerPvpWindow({
  windowId,
  onExit,
}: GameWindowProps & { onExit?: () => void }) {
  const g = useRoutedPvpPoker(windowId);

  // In-match Back is destructive (forfeits the stake to the opponent), so a live hand confirms first
  // instead of routing straight through backOut/forfeit. Not live (matching/funding/settled/error) ⇒
  // Back keeps its existing bail-out behavior below.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canForfeit = g.status === "playing";

  // Back (not-live path) bails out via backOut: auto-fold → publish our settlement half → drop back to
  // THIS window's lobby once the half is on the wire ("settled") or if settle errors — a failed/stuck
  // close must never trap the player. A timeout backstops a hand that can't reach a settle boundary
  // (e.g. an unresponsive opponent). Forfeit (the confirmed in-match Back) does NOT arm this watchdog:
  // forfeit() has its own bounded teardown (peer wait capped at FORFEIT_SETTLE_TIMEOUT_MS, an RPC read,
  // and an optional wallet-signed close) and never nulls `g.state`, so the window keeps rendering the
  // table + "Play again" once `g.status` reaches "settled" (same fallthrough as the natural end-of-match
  // settle below). Arming this 8s bail on the forfeit path would race that: it fires first, resets the
  // hook (nulling state) out from under forfeit's still-running async work, and forfeit's late
  // `finally { setStatus("settled") }` then lands on a reset hook with no state — a permanently blank
  // window. The window itself closes only via the title-bar ✕.
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!leaving) return;
    if (g.status === "settled" || g.status === "error") {
      setLeaving(false);
      g.reset();
      return;
    }
    const bail = window.setTimeout(() => {
      setLeaving(false);
      g.reset();
    }, 8000);
    return () => window.clearTimeout(bail);
  }, [leaving, g.status, g.reset]);

  if (g.status === "idle") {
    return (
      <div className="sketch grid h-full min-h-[14rem] place-items-center overflow-hidden p-[clamp(12px,4cqmin,28px)] text-center">
        <SketchDefs />
        <div className="sketch-panel sketch-stroke max-w-[min(22rem,92%)] p-[clamp(14px,4cqmin,26px)]">
          <span className="sketch-eyebrow">heads-up · no dealer</span>
          <div className="qp-title mb-1 mt-1">Quantum Poker</div>
          <p className="sketch-note mb-3">
            Each seat stakes {POKER_BUYIN.toString()} chips on-chain. The deck
            is dealt by a two-party commit-reveal — no dealer — and chips move
            off-chain over a Sui tunnel for up to {HAND_CAP.toString()} hands,
            paid out at cooperative close.
          </p>
          <div className="flex flex-wrap justify-center gap-[clamp(6px,2cqmin,12px)]">
            <button
              type="button"
              className="sketch-btn sketch-btn--go"
              onClick={g.playArena}
            >
              Play
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (g.status === "matching" || g.status === "funding") {
    return (
      <div className="sketch grid h-full min-h-[14rem] place-items-center overflow-hidden p-[clamp(12px,4cqmin,28px)] text-center">
        <SketchDefs />
        <div className="sketch-panel sketch-stroke max-w-[min(22rem,92%)] p-[clamp(14px,4cqmin,26px)]">
          <div className="qp-title mb-1">
            {g.status === "matching"
              ? "Finding an opponent…"
              : "Opening tunnel…"}
          </div>
          <p className="sketch-note">
            {g.status === "matching"
              ? "Matching you with another player."
              : "Funding your seat and dealing you in."}
          </p>
          {g.opponentWallet && (
            <p className="sketch-note mt-1 tabular-nums">
              vs {g.opponentWallet.slice(0, 10)}…
            </p>
          )}
          {/* Cancel matchmaking / funding and drop back to the lobby (never closes the window). */}
          <button type="button" className="sketch-btn mt-3" onClick={g.reset}>
            Back
          </button>
        </div>
      </div>
    );
  }

  if (g.status === "error") {
    return (
      <div className="sketch grid h-full min-h-[14rem] place-items-center overflow-hidden p-[clamp(12px,4cqmin,28px)] text-center">
        <SketchDefs />
        <div className="sketch-panel sketch-stroke max-w-[min(22rem,92%)] p-[clamp(14px,4cqmin,26px)]">
          <div className="qp-title mb-2">Match error</div>
          <p className="sketch-note mb-3 text-[var(--sketch-red)]">{g.error}</p>
          <button type="button" className="sketch-btn" onClick={g.reset}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const s = g.state;
  const self = g.selfParty;
  if (!s || !self) return null;
  const opp: Party = self === "A" ? "B" : "A";

  // Map the table's by-party props from this seat's perspective: the viewer's holes are face-up, the
  // opponent's stay face-down (empty → hidden) until showdown reveals them.
  const oppShown = self === "A" ? s.shownHoleB : s.shownHoleA;
  const myHole = g.myHole ?? [];
  const holesA = self === "A" ? myHole : (oppShown ?? []);
  const holesB = self === "B" ? myHole : (oppShown ?? []);
  const nameA = self === "A" ? "You" : "Opponent";
  const nameB = self === "B" ? "You" : "Opponent";

  const pot = s.totalBetA + s.totalBetB;
  const terminal = s.phase === "done" || s.phase === "hand_over";
  const won = s.winner === self;
  const lost = s.winner === opp;
  const banner = terminal
    ? s.winner === "tie"
      ? "Split pot — stakes returned"
      : won
        ? `You win${s.lastResult?.reason === "fold" ? " — opponent folded" : ""}`
        : lost
          ? `You lose${s.lastResult?.reason === "fold" ? " — you folded" : ""}`
          : "Hand over"
    : g.myTurnToBet
      ? "Your turn"
      : `${PHASE_LABEL[s.phase]} · opponent's turn`;

  // Adapt the shared bar's abstract moves onto this hook's per-action methods.
  const onAct = (m: PokerMove) => {
    switch (m.kind) {
      case "fold":
        g.fold();
        break;
      case "check":
        g.check();
        break;
      case "call":
        g.call();
        break;
      case "bet":
        g.bet(m.amount);
        break;
    }
  };

  return (
    <>
      <div className="sketch grid h-full min-h-[14rem] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <SketchDefs />

        <header className="qp-head">
          <div className="flex min-w-0 items-center gap-[clamp(6px,2.2cqmin,14px)]">
            <button
              type="button"
              className="sketch-btn"
              onClick={() => {
                if (canForfeit) {
                  setConfirmOpen(true);
                  return;
                }
                setLeaving(true);
                g.backOut(); // auto-fold out → settle this hand → back to the lobby when settled
              }}
            >
              {leaving ? "Leaving…" : "Back"}
            </button>
            <div className="flex min-w-0 flex-col leading-none">
              <span className="sketch-eyebrow">
                PvP · you are {self}
                {g.status === "settling" && " · settling…"}
                {g.status === "settled" && " · settled ✓"}
              </span>
              <span className="qp-title truncate">Quantum Poker</span>
            </div>
          </div>
          <div className="flex items-center gap-[clamp(5px,1.8cqmin,12px)]">
            <span className="sketch-eyebrow tabular-nums">
              hand {(s.handNo + 1n).toString()}/{HAND_CAP.toString()}
            </span>
            {g.status === "playing" && (
              <button
                type="button"
                className={`sketch-btn${g.auto ? " sketch-btn--go" : ""}`}
                onClick={() => g.setAuto(!g.auto)}
                title={
                  g.auto
                    ? "Auto on — a bot is making your bets"
                    : "Let a bot play your hand"
                }
              >
                🤖 Auto{g.auto ? " ON" : ""}
              </button>
            )}
            {g.status === "playing" && !terminal && g.endRequested && (
              <span className="sketch-eyebrow whitespace-nowrap">
                ends after hand
              </span>
            )}
          </div>
        </header>

        <main className="grid min-h-0 overflow-hidden p-[clamp(10px,3.6cqmin,36px)]">
          <QuantumPokerTable
            state={s}
            hero={self}
            holesA={holesA}
            holesB={holesB}
            nameA={nameA}
            nameB={nameB}
          />
        </main>

        <footer className="grid gap-[clamp(5px,1.6cqmin,12px)] p-[clamp(6px,2.4cqmin,16px)] pt-0">
          {g.myTurnToBet && g.legal ? (
            <div
              className={`flex flex-col gap-[clamp(4px,1.4cqmin,10px)]${g.auto ? " opacity-40" : ""}`}
            >
              {g.auto && (
                <span className="sketch-note">🤖 Bot is playing your hand</span>
              )}
              <PokerActionBar
                legal={g.legal}
                pot={pot}
                onAct={onAct}
                secondsLeft={g.secondsLeft}
              />
            </div>
          ) : (
            <div className="flex items-center gap-[clamp(5px,1.8cqmin,12px)]">
              <span className="qp-stat__l">{banner}</span>
              {g.status === "settled" && (
                <button
                  type="button"
                  className="sketch-btn sketch-btn--go"
                  onClick={g.reset}
                >
                  Play again
                </button>
              )}
            </div>
          )}
        </footer>
      </div>
      <ForfeitDialog
        open={canForfeit && confirmOpen}
        stake={`${POKER_BUYIN} MTPS`}
        onKeepPlaying={() => setConfirmOpen(false)}
        onForfeit={() => {
          setConfirmOpen(false);
          g.forfeit(); // no `leaving`/watchdog — g.status → "settled" drives the table's own Play-again fallthrough
        }}
      />
    </>
  );
}
