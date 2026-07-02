import { useEffect, useRef, useState } from "react";
import { useGameScale } from "@/games/blackjack/app/components/app/ScaledWrapper";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { CardDisplay } from "@/games/blackjack/app/components/app/CardDisplay";
import { usePvpBlackjack } from "@/games/blackjack/app/hooks/usePvpBlackjack";
import { handToCardIndices } from "@/games/blackjack/app/lib/bjCards";
import { isMtpsConfigured } from "@/onchain/mtps";
import {
  betChipColor,
  SeatChips,
  CHIP_DEALER_HOME,
  CHIP_PLAYER_HOME,
} from "@/games/blackjack/app/components/app/chips";

import { SketchDefs } from "@/games/blackjack/app/App";

const MIN_BUYIN = 100;
const chipsToSui = (chips: bigint) =>
  (Number(chips) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });

function statusText(g: ReturnType<typeof usePvpBlackjack>): string {
  if (g.phase === "opening") return "Opening tunnel on-chain…";
  if (g.phase === "funding") return "Funding your seat…";
  if (g.phase === "settling") return "Ending…";
  if (g.gamePhase === "player")
    return g.isDealer ? "Player is deciding…" : "Your turn — Hit or Stand";
  if (g.gamePhase === "draw_commit" || g.gamePhase === "draw_reveal")
    return "Dealer drawing…";
  if (g.gamePhase === "round_over") {
    if (g.terminal)
      return g.outOfChips
        ? `${g.outOfChips === "player" ? "Player" : "Dealer"} is out of chips — settling…`
        : "Round cap reached — settling…";
    return g.isDealer
      ? "Waiting for the player's bet…"
      : "Place your bet for the next round";
  }
  return "";
}

export default function PvpBlackjack() {
  const g = usePvpBlackjack();
  const { isPortrait } = useGameScale();
  const account = useCurrentAccount();
  useEffect(() => {
    document.title = "Blackjack — PvP";
  }, []);

  // MTPS mode: gas is sponsored and the buy-in is faucet-minted MTPS, so a 0-SUI player can
  // play — the wallet-SUI gate doesn't apply. SUI mode still needs gas to open/deposit.
  const funded = isMtpsConfigured || g.walletBalance > 20_000_000n;
  const playing =
    g.phase === "playing" || g.phase === "settling" || g.phase === "done";
  const myBal = g.myBalance;
  const oppBal = g.oppBalance;
  const finalResult = myBal > oppBal ? "win" : myBal < oppBal ? "lose" : "push";

  // Perspective-based rendering (always show "self" at the bottom and "opponent" at the top)
  const selfTitle = g.isDealer ? "Dealer (you)" : "Player (you)";
  const selfLabel = g.isDealer ? "Dealer" : "Player";
  const selfCards = g.isDealer ? g.dealerHand : g.playerHand;
  const selfCardSeed = g.isDealer ? g.round * 2 + 1 : g.round * 2;
  const selfSum = g.isDealer ? g.dealerSum : g.playerSum;
  const selfBalance = g.isDealer ? g.balanceDealer : g.balancePlayer;
  const selfIsWinning = finalResult === "win" && g.phase === "done";

  const oppTitle = g.isDealer ? "Player" : "Dealer";
  const oppLabel = g.isDealer ? "Player" : "Dealer";
  const oppCards = g.isDealer ? g.playerHand : g.dealerHand;
  const oppCardSeed = g.isDealer ? g.round * 2 : g.round * 2 + 1;
  const oppSum = g.isDealer ? g.playerSum : g.dealerSum;
  const oppBalance = g.isDealer ? g.balancePlayer : g.balanceDealer;
  const oppIsWinning = finalResult === "lose" && g.phase === "done";

  // Bet/payout chip animation, driven off the player's (party A) seat — matching the fixed
  // player-bottom / dealer-top layout (same felt motion as the bot-vs-bot self-play table).
  const [customStake, setCustomStake] = useState(""); // free-typed buy-in (empty → a preset is active)
  const [animState, setAnimState] = useState<
    "idle" | "deal" | "win" | "lose" | "push"
  >("idle");

  // Chip thrown in — coloured by the wager's denomination (shared with the bot table).
  const thrownChipColor = betChipColor(Number(g.currentBet));

  const getDealerChipTransform = () => {
    if (animState === "idle") return `translate(${CHIP_DEALER_HOME}) scale(0)`;
    if (animState === "deal") return "translate(-10px, 0px) scale(1)";
    if (animState === "win") return `translate(${CHIP_PLAYER_HOME}) scale(0)`;
    if (animState === "lose")
      return `translate(${CHIP_DEALER_HOME}) scale(1.5)`;
    if (animState === "push") return `translate(${CHIP_DEALER_HOME}) scale(0)`;
    return "translate(0,0) scale(1)";
  };

  const getPlayerChipTransform = () => {
    if (animState === "idle") return `translate(${CHIP_PLAYER_HOME}) scale(0)`;
    if (animState === "deal") return "translate(10px, 0px) scale(1)";
    if (animState === "win") return `translate(${CHIP_PLAYER_HOME}) scale(1.5)`;
    if (animState === "lose") return `translate(${CHIP_DEALER_HOME}) scale(0)`;
    if (animState === "push") return `translate(${CHIP_PLAYER_HOME}) scale(0)`;
    return "translate(0,0) scale(1)";
  };
  const prevRoundRef = useRef(-1);
  const prevPhaseRef = useRef("");
  const prevBalanceRef = useRef(-1);
  useEffect(() => {
    const hasCards = g.playerHand.length > 0 || g.dealerHand.length > 0;
    if (!hasCards) {
      setAnimState("idle");
      prevRoundRef.current = -1;
      return;
    }
    const balance = Number(g.myBalance);
    if (prevRoundRef.current === -1) {
      if (g.gamePhase === "player") setAnimState("deal");
    } else {
      const roundChanged = g.round !== prevRoundRef.current;
      const phaseChanged = g.gamePhase !== prevPhaseRef.current;
      if (roundChanged || (phaseChanged && g.gamePhase === "player")) {
        setAnimState("deal"); // a fresh round was dealt → chip slides from the player to the spot
      } else if (phaseChanged && g.gamePhase === "round_over") {
        const diff = balance - prevBalanceRef.current;
        setAnimState(diff > 0 ? "win" : diff < 0 ? "lose" : "push");
      }
    }
    prevRoundRef.current = g.round;
    prevPhaseRef.current = g.gamePhase ?? "";
    prevBalanceRef.current = balance;
  }, [
    g.round,
    g.gamePhase,
    g.myBalance,
    g.playerHand.length,
    g.dealerHand.length,
  ]);
  // Settle animations are one-shot — return to the resting spot once they finish.
  useEffect(() => {
    if (animState === "win" || animState === "lose" || animState === "push") {
      const timer = setTimeout(() => setAnimState("idle"), 850);
      return () => clearTimeout(timer);
    }
  }, [animState]);

  // --- Action toasts + per-round result (mirrors the bot table, from YOUR perspective) ---
  type ToastMsg = {
    id: number;
    msg: string;
    type: "info" | "win" | "lose" | "push";
  };
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastIdRef = useRef(0);
  const addToast = (msg: string, type: ToastMsg["type"] = "info") => {
    setToasts((prev) => {
      const next = [...prev, { id: toastIdRef.current++, msg, type }];
      return next.length > 5 ? next.slice(next.length - 5) : next;
    });
  };
  // Snapshot of the last frame so we can spot hits (a hand grew) and stands (a phase boundary).
  const snapRef = useRef({
    selfLen: 0,
    oppLen: 0,
    selfSum: 0,
    oppSum: 0,
    phase: g.gamePhase,
  });
  const prevRoundsLenRef = useRef(g.rounds.length);

  useEffect(() => {
    const p = snapRef.current;
    if (selfCards.length > p.selfLen && p.selfLen > 0)
      addToast(`You hit (${selfSum})`);
    if (oppCards.length > p.oppLen && p.oppLen > 0)
      addToast(`${oppLabel} hits (${oppSum})`);
    // Player role finished (stood) → commit/reveal for dealer's auto-draw begins.
    if (
      p.phase === "player" &&
      (g.gamePhase === "draw_commit" || g.gamePhase === "draw_reveal")
    )
      addToast(
        g.isDealer
          ? `${oppLabel} stands (${p.oppSum})`
          : `You stand (${p.selfSum})`,
      );
    // Dealer auto-draw finished → round resolved.
    if (
      (p.phase === "draw_commit" || p.phase === "draw_reveal") &&
      g.gamePhase === "round_over"
    )
      addToast(
        g.isDealer
          ? `You stand (${p.selfSum})`
          : `${oppLabel} stands (${p.oppSum})`,
      );
    snapRef.current = {
      selfLen: selfCards.length,
      oppLen: oppCards.length,
      selfSum,
      oppSum,
      phase: g.gamePhase,
    };
  }, [
    selfCards.length,
    oppCards.length,
    selfSum,
    oppSum,
    g.gamePhase,
    g.isDealer,
    oppLabel,
  ]);

  // Round outcome (g.rounds is PLAYER-perspective — flip it for the dealer's seat).
  useEffect(() => {
    if (g.rounds.length > prevRoundsLenRef.current) {
      const r = g.rounds[g.rounds.length - 1];
      if (r) {
        const mine = !g.isDealer
          ? r.outcome
          : r.outcome === "win"
            ? "lose"
            : r.outcome === "lose"
              ? "win"
              : "push";
        if (mine === "win") addToast("You win!", "win");
        else if (mine === "lose") addToast("You lose", "lose");
        else addToast("Push", "push");
      }
    }
    prevRoundsLenRef.current = g.rounds.length;
  }, [g.rounds, g.isDealer]);

  // The latest round's result, from YOUR seat (for the centre flash badge).
  const latestRound =
    g.rounds.length > 0 ? g.rounds[g.rounds.length - 1] : null;
  const latestMine = !latestRound
    ? null
    : !g.isDealer
      ? latestRound.outcome
      : latestRound.outcome === "win"
        ? "lose"
        : latestRound.outcome === "lose"
          ? "win"
          : "push";

  return (
    <div className="qp-sketch h-full w-full flex flex-col relative overflow-hidden select-none">
      <SketchDefs />

      {/* Play area felt wrapper */}
      <div className="relative z-10 flex-1 w-full flex items-center justify-center p-1 md:p-2">
        <div className="bj-felt w-full h-full relative">
          {playing && (
            <button
              onClick={() => g.leave()}
              className="qp-btn !px-4 !py-2 !absolute !top-4 !left-4 z-30 !text-sm font-semibold cursor-pointer"
              title="Back"
            >
              ← Back
            </button>
          )}

          {/* Round / role badge */}
          {playing && (
            <div
              className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-1 bg-[#fffefb] border-2 border-[var(--qp-ink)] rounded-full shadow-md z-10 flex items-center gap-2"
              style={{ filter: "url(#qpRough)" }}
            >
              <span className="text-[10px] md:text-xs text-[var(--qp-amber)] font-extrabold uppercase tracking-widest">
                Round {g.round}
              </span>
              <span className="text-[10px] text-[var(--qp-ink-soft)] uppercase tracking-widest">
                · you are the {g.isDealer ? "dealer" : "player"}
              </span>
            </div>
          )}

          {/* Action toasts (hit / stand / round result), from your perspective */}
          {playing && (
            <div className="absolute z-30 flex flex-col items-end gap-2 pointer-events-none top-4 right-4 md:top-8 md:right-8">
              {toasts.map((t) => (
                <div
                  key={t.id}
                  className={`px-3 py-1 rounded-md shadow-md text-xs font-bold fade-in-up border-2 ${
                    t.type === "win"
                      ? "bg-[#eaf8ee] text-emerald-850 border-emerald-600"
                      : t.type === "lose"
                        ? "bg-[#ffe9e9] text-red-850 border-red-600"
                        : t.type === "push"
                          ? "bg-[#ffe9bd] text-amber-850 border-amber-600"
                          : "bg-[#fffefb] text-zinc-700 border-zinc-600"
                  }`}
                >
                  {t.msg}
                </div>
              ))}
            </div>
          )}

          {/* Per-round result flash — who took the round, from your seat */}
          {playing && !g.terminal && latestRound && latestMine && (
            <div
              key={`flash-${latestRound.round}`}
              className="absolute top-[54%] left-1/2 -translate-x-1/2 z-20 flex items-center justify-center pointer-events-none fade-in-up"
            >
              <div
                className="px-5 py-2 bg-[#fffefb] border-2 border-[var(--qp-ink)] rounded-full shadow-md flex items-center gap-3 font-mono text-sm md:text-base text-[var(--qp-ink)]"
                style={{ filter: "url(#qpRough)" }}
              >
                <span className="text-zinc-400 font-bold">
                  R{latestRound.round + 1}
                </span>
                <span className="text-zinc-700 font-semibold">
                  You:
                  {g.isDealer
                    ? latestRound.dealerSum
                    : latestRound.playerSum}{" "}
                  Opp:
                  {g.isDealer ? latestRound.playerSum : latestRound.dealerSum}
                </span>
                <span
                  className={`font-extrabold text-base md:text-lg ${
                    latestMine === "win"
                      ? "text-emerald-600"
                      : latestMine === "lose"
                        ? "text-red-600"
                        : "text-amber-600"
                  }`}
                >
                  {latestMine.toUpperCase()}
                </span>
              </div>
            </div>
          )}

          {playing && (
            <div className="absolute top-[48%] left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-1">
              {/* Dealer flying chip — coloured by the wager's denomination. */}
              <div
                className={`absolute left-1/2 top-0 -mt-3 -ml-3 w-6 h-6 rounded-full border-[3px] border-[var(--qp-ink)] shadow-[0_4px_0_var(--qp-ink)] z-40 transition-all duration-700 ease-[cubic-bezier(0.34,1.56,0.64,1)] flex items-center justify-center pointer-events-none ${animState === "idle" ? "opacity-0" : "opacity-100"}`}
                style={{
                  transform: getDealerChipTransform(),
                  backgroundColor: thrownChipColor,
                }}
              >
                <div className="w-3 h-3 rounded-full border border-[var(--qp-ink)] opacity-50"></div>
              </div>

              {/* Player flying chip — coloured by the wager's denomination. */}
              <div
                className={`absolute left-1/2 top-0 -mt-3 -ml-3 w-6 h-6 rounded-full border-[3px] border-[var(--qp-ink)] shadow-[0_4px_0_var(--qp-ink)] z-40 transition-all duration-700 ease-[cubic-bezier(0.34,1.56,0.64,1)] flex items-center justify-center pointer-events-none ${animState === "idle" ? "opacity-0" : "opacity-100"}`}
                style={{
                  transform: getPlayerChipTransform(),
                  backgroundColor: thrownChipColor,
                }}
              >
                <div className="w-3 h-3 rounded-full border border-[var(--qp-ink)] opacity-50"></div>
              </div>

              <div
                className="qp-bet relative z-10"
                style={{ filter: "url(#qpRough)" }}
              >
                <span className="qp-chip" /> Wager:{" "}
                {g.currentBet > 0n
                  ? `${Number(g.currentBet).toLocaleString()}`
                  : "PLACE BET"}
              </div>
              <div className="text-[10px] text-[var(--qp-ink-soft)] uppercase tracking-widest font-bold">
                Blackjack pays 3 to 2
              </div>
            </div>
          )}

          {playing && (
            <>
              {/* Opponent seat (left) */}
              <div className="absolute top-[15%] left-[2%] md:left-[5%] z-20 flex flex-col items-center gap-2 scale-75 md:scale-90 origin-left">
                <div
                  className="qp-seat qp-stroke flex items-center justify-center"
                  style={{ filter: "url(#qpRough)" }}
                >
                  <div className="qp-seat__who">
                    <span
                      className={`qp-seat__id ${g.isDealer ? "qp-seat__id--a" : "qp-seat__id--b"}`}
                    >
                      {g.isDealer ? "P" : "D"}
                    </span>
                    <div>
                      <div className="qp-seat__name">{oppTitle}</div>
                      <div className="qp-seat__stack">
                        <span className="qp-chip" />{" "}
                        {oppBalance.toLocaleString()}
                      </div>
                    </div>
                  </div>
                </div>
                {/* Opponent chip pile — denomination chips from their balance. */}
                <SeatChips balance={Number(oppBalance)} />
              </div>

              {/* Opponent hand (center) */}
              <div className="absolute top-[16%] left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2">
                <CardDisplay
                  title=""
                  cards={handToCardIndices(oppCards, oppCardSeed)}
                  sum={oppSum}
                  isWinning={oppIsWinning}
                />
              </div>

              {/* Player seat (left) */}
              <div className="absolute bottom-[2%] left-[2%] md:left-[5%] z-20 flex flex-col items-center gap-2 scale-75 md:scale-90 origin-left">
                {/* Player chip pile — denomination chips from your balance. */}
                <SeatChips balance={Number(selfBalance)} />
                <div
                  className="qp-seat qp-stroke flex items-center justify-center"
                  style={{ filter: "url(#qpRough)" }}
                >
                  <div className="qp-seat__who">
                    <span
                      className={`qp-seat__id ${g.isDealer ? "qp-seat__id--b" : "qp-seat__id--a"}`}
                    >
                      {g.isDealer ? "D" : "P"}
                    </span>
                    <div>
                      <div className="qp-seat__name">{selfTitle}</div>
                      <div className="qp-seat__stack">
                        <span className="qp-chip" />{" "}
                        {selfBalance.toLocaleString()}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Player hand (center) */}
              <div className="absolute bottom-[5%] left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2">
                <CardDisplay
                  title=""
                  cards={handToCardIndices(selfCards, selfCardSeed)}
                  sum={selfSum}
                  isPlayer
                  isWinning={selfIsWinning}
                />
              </div>
            </>
          )}

          {/* Pre-game / connect overlay */}
          {!playing && (
            <div className="absolute inset-0 z-20 flex items-center justify-center p-4">
              <div className="qp-panel qp-stroke max-w-[min(48rem,95%)] p-10 md:p-12 flex flex-col items-center gap-5 text-center relative">
                {/* <span className="qp-eyebrow">Blackjack · PvP</span> */}
                <h2 className="qp-title uppercase text-center mb-1">
                  Blackjack PvP
                </h2>
                {!account ? (
                  <p className="text-center text-2xl md:text-3xl text-[var(--qp-red)] font-bold py-6 uppercase tracking-widest">
                    Please connect your Sui wallet in the top bar to play.
                  </p>
                ) : g.phase === "opening" || g.phase === "funding" ? (
                  <div className="text-[var(--qp-amber)] py-6 animate-pulse font-bold">
                    {statusText(g)}
                  </div>
                ) : (
                  <div className="w-full flex flex-col gap-3">
                    {/* Buy-in */}
                    <div className="flex flex-col gap-2">
                      <span className="text-sm text-[var(--qp-ink-soft)] uppercase tracking-widest text-center font-bold">
                        Your buy-in
                      </span>
                      <div className="grid grid-cols-4 gap-2">
                        {g.fundOptions.map((amt) => {
                          const selected =
                            customStake === "" && g.stake === BigInt(amt);
                          return (
                            <button
                              key={amt}
                              onClick={() => {
                                g.setStake(BigInt(amt));
                                setCustomStake("");
                              }}
                              disabled={
                                g.phase === "queuing" ||
                                g.phase === "connecting"
                              }
                              className={`qp-btn !py-2.5 !text-base font-black tabular-nums transition-colors disabled:opacity-40 ${selected ? "qp-btn--go" : ""}`}
                            >
                              {amt.toLocaleString()}
                            </button>
                          );
                        })}
                      </div>
                      {/* Custom buy-in */}
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={MIN_BUYIN}
                          placeholder="Custom amount"
                          value={customStake}
                          disabled={
                            g.phase === "queuing" || g.phase === "connecting"
                          }
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9]/g, "");
                            setCustomStake(v);
                            if (v) g.setStake(BigInt(v));
                          }}
                          className="flex-1 min-w-0 qp-input bg-[#fffdf6] border-2 border-[var(--qp-ink)] focus:border-[var(--qp-amber)] rounded-md px-3 py-1.5 text-sm font-mono outline-none"
                        />
                      </div>
                      {!isMtpsConfigured && (
                        <div className="text-[11px] text-[var(--qp-ink-soft)] text-center leading-relaxed">
                          {Number(g.stake).toLocaleString()} buy-in ≈{" "}
                          <span className="font-mono text-emerald-600 font-bold">
                            {chipsToSui(g.stake)} SUI
                          </span>{" "}
                          on-chain
                        </div>
                      )}
                      {g.stake < BigInt(MIN_BUYIN) && (
                        <div className="text-[var(--qp-red)] text-[11px] text-center font-bold">
                          minimum buy-in is {MIN_BUYIN.toLocaleString()}
                        </div>
                      )}
                    </div>
                    {!funded && (
                      <button
                        onClick={g.fund}
                        className="qp-btn w-full !py-3.5 !text-base font-black"
                      >
                        Fund wallet (faucet)
                      </button>
                    )}
                    <button
                      onClick={g.playArena}
                      disabled={
                        g.phase === "queuing" || g.phase === "connecting"
                      }
                      className="qp-btn qp-btn--go w-full !py-5 !text-xl font-black uppercase tracking-widest disabled:opacity-40"
                    >
                      {g.phase === "queuing"
                        ? "Finding opponent…"
                        : g.phase === "connecting"
                          ? "Connecting…"
                          : "Play"}
                    </button>
                    {g.phase === "queuing" && (
                      <button
                        onClick={g.leave}
                        className="text-xs text-[var(--qp-ink-soft)] hover:text-[var(--qp-ink)] underline cursor-pointer mt-1"
                      >
                        cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom HUD */}
      {playing && (
        <div className="w-full qp-ticker border-t-2 border-[var(--qp-ink)] bg-[var(--qp-paper)] z-30 select-none px-2 py-2 flex overflow-x-auto overflow-y-hidden">
          <div className="flex items-center flex-nowrap justify-center gap-2 min-w-max mx-auto px-1">
            {g.phase === "playing" && g.myTurn && (
              <>
                <button
                  onClick={g.hit}
                  disabled={g.auto}
                  className="qp-btn qp-btn--go !px-4 !py-2 !text-sm font-black uppercase disabled:opacity-30"
                >
                  Hit
                </button>
                <button
                  onClick={g.stand}
                  disabled={g.auto}
                  className="qp-btn qp-btn--stop !px-4 !py-2 !text-sm font-black uppercase disabled:opacity-30"
                >
                  Stand
                </button>
              </>
            )}
            {g.phase === "playing" && g.inRoundOver && (
              <>
                {!g.terminal && !g.isDealer && (
                  <div className="flex items-center flex-nowrap justify-center gap-1.5">
                    <span className="text-[11px] text-[var(--qp-ink)] uppercase tracking-wide mr-0.5 font-bold">
                      Bet:
                    </span>
                    {g.betOptions.map((amt) => (
                      <button
                        key={amt}
                        onClick={() => g.bet(amt)}
                        disabled={g.auto}
                        className="qp-btn qp-btn--go !px-2 !py-1.5 !text-xs font-black"
                      >
                        ${amt}
                      </button>
                    ))}
                  </div>
                )}
                {!g.terminal && g.isDealer && (
                  <span className="px-4 py-2 text-xs text-[var(--qp-amber)] font-bold animate-pulse">
                    Player is betting…
                  </span>
                )}
                <button
                  onClick={g.stop}
                  className="qp-btn qp-btn--stop !px-3 !py-2 !text-xs font-black uppercase"
                >
                  Stop &amp; settle
                </button>
              </>
            )}
            {g.phase === "done" && (
              <button
                onClick={() => {
                  g.leave();
                  g.playArena();
                }}
                className="qp-btn qp-btn--go !px-4 !py-2 !text-sm font-black uppercase"
              >
                Rematch
              </button>
            )}

            {/* Auto Toggle */}
            <button
              onClick={() => g.setAuto(!g.auto)}
              className={`qp-btn !px-3 !py-2 !text-xs font-black uppercase flex items-center gap-1.5 ${g.auto ? "qp-btn--go" : ""}`}
            >
              <span
                className={`grid h-3.5 w-3.5 place-items-center rounded border ${g.auto ? "border-emerald-600 bg-emerald-500/20 text-emerald-850" : "border-zinc-500"}`}
              >
                {g.auto ? "✓" : ""}
              </span>
              Auto
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
