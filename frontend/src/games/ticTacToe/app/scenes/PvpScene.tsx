import { useState } from "react";
import {
  usePvpTicTacToe,
  type Variant,
} from "@/games/ticTacToe/app/hooks/usePvpTicTacToe";
import { Board } from "@/games/ticTacToe/app/components/Board";
import { CaroBoard } from "@/games/ticTacToe/app/components/CaroBoard";
import { isMtpsConfigured } from "@/onchain/mtps";

const SUISCAN_TX = "https://suiscan.xyz/testnet/tx/";
const CARO_SIZES = [9, 15, 19];

// The 3×3 Cell renders value 1 ("O") / 2 ("X"), but the protocol marks seat A (X) as 1 and
// seat B (O) as 2 — the opposite. Swap 1↔2 so your X shows as X (CaroBoard already maps 1→✕).
function uiBoard(board: number[]): number[] {
  return board.map((v) => (v === 1 ? 2 : v === 2 ? 1 : 0));
}

function Digest({ label, digest }: { label: string; digest?: string }) {
  if (!digest) return null;
  return (
    <a
      href={`${SUISCAN_TX}${digest}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-tertiary underline underline-offset-2 break-all"
    >
      {label} {digest.slice(0, 6)}…
    </a>
  );
}

function statusText(g: ReturnType<typeof usePvpTicTacToe>): string {
  if (g.phase === "opening") return "Opening tunnel on-chain…";
  if (g.phase === "funding") return "Funding your seat…";
  if (g.phase === "settling") return "Settling on-chain…";
  if (g.phase === "done") return "Settled — game over";
  if (g.innerOver) {
    if (g.terminal) return "Session over — settling…";
    return g.role === "A"
      ? "You won/lost/drew — start the next game"
      : "Waiting for X to start the next game…";
  }
  if (g.isMyTurn) return `Your turn (${g.myMark === 1 ? "✕" : "◯"})`;
  return "Opponent's turn…";
}

export function PvpScene({ isPortrait = false }: { isPortrait?: boolean }) {
  // Default to Caro (15×15) — the headline variant for this window; the 3×3 classic is a toggle.
  const [variant, setVariant] = useState<Variant>("caro");
  const [boardSize, setBoardSize] = useState(15);
  const g = usePvpTicTacToe(variant, boardSize);

  const playing =
    g.phase === "playing" || g.phase === "settling" || g.phase === "done";
  // SUI mode: the connected wallet pays gas + the (tiny) deposit, so it needs a little testnet
  // SUI. MTPS mode (ADR-0010): gas is sponsored and the stake is faucet-minted, so play is
  // free — never gate on the SUI balance.
  const funded = isMtpsConfigured || g.balance > 10_000_000n;
  const locked = g.phase !== "idle" && g.phase !== "error";

  // "Leave" during a match settles our half and drops back to THIS window's lobby (like "Cancel
  // Search"): `g.leave()` sends the settlement half, tears the match down, and returns phase to
  // "idle" (the lobby). It never closes the window — that's the title-bar ✕'s job.
  const returnToLobby = () => g.leave();

  // ---- Lobby / matchmaking (fills the window; sizes scale with the window via cqw) ----------
  if (!playing) {
    return (
      <div className="w-full h-full overflow-y-auto flex flex-col items-center justify-center p-4">
        <section className="qp-panel qp-stroke @container w-[95%] max-w-2xl my-auto p-6 md:p-10 flex flex-col items-center gap-5 text-center mx-auto">
          <div className="w-full flex items-center justify-center">
            <span className="qp-eyebrow !text-sm md:!text-base">
              PvP Tic-Tac-Toe
            </span>
          </div>

          <div className="w-full flex flex-col items-center gap-3">
            <span className="qp-eyebrow text-sm">Game Variant</span>
            <div className="flex w-full gap-3">
              {(["ttt", "caro"] as const).map((v) => (
                <button
                  key={v}
                  disabled={locked}
                  onClick={() => setVariant(v)}
                  className={`qp-btn ttt-ctl-btn flex-1 disabled:opacity-40 ${variant === v ? "qp-btn--go" : ""}`}
                >
                  {v === "ttt" ? "3×3 Classic" : "Caro"}
                </button>
              ))}
            </div>
            {variant === "caro" && (
              <div className="flex gap-2 justify-center">
                {CARO_SIZES.map((sz) => (
                  <button
                    key={sz}
                    disabled={locked}
                    onClick={() => setBoardSize(sz)}
                    className={`qp-btn ttt-ctl-btn disabled:opacity-40 ${boardSize === sz ? "qp-btn--go" : ""}`}
                  >
                    {sz}×{sz}
                  </button>
                ))}
              </div>
            )}
          </div>

          {!funded && !isMtpsConfigured && (
            <div className="text-secondary font-bold text-sm bg-secondary/10 rounded-xl p-3 w-full">
              Your wallet needs SUI to play (gas + deposit).
            </div>
          )}

          <button
            onClick={g.playArena}
            disabled={locked}
            className="qp-btn qp-btn--go ttt-ctl-btn w-full uppercase tracking-widest disabled:opacity-40 flex items-center justify-center gap-2 font-black"
          >
            <span className="material-symbols-outlined text-xl">
              {g.phase === "queuing"
                ? "search"
                : g.phase === "connecting"
                  ? "sync"
                  : "sports_esports"}
            </span>
            {g.phase === "connecting"
              ? "Connecting…"
              : g.phase === "queuing"
                ? "Finding Opponent…"
                : g.phase === "opening"
                  ? "Opening tunnel…"
                  : g.phase === "funding"
                    ? "Funding seat…"
                    : "Play"}
          </button>

          {(g.phase === "queuing" || g.phase === "connecting") && (
            <button
              onClick={g.leave}
              className="text-outline text-sm font-bold underline hover:text-secondary transition-colors"
            >
              Cancel Search
            </button>
          )}
          {g.error && (
            <div className="font-bold text-sm text-red-500 bg-red-50 rounded-xl p-3 border-2 border-red-200 w-full break-words">
              {g.error}
            </div>
          )}
        </section>
      </div>
    );
  }

  // ---- Playing view -------------------------------------------------------------------------
  const board =
    g.variant === "caro" ? (
      <CaroBoard
        board={g.board}
        size={g.size}
        lastMove={g.lastMove}
        disabled={!g.isMyTurn || g.auto}
        onPlay={g.play}
      />
    ) : (
      <Board
        board={uiBoard(g.board)}
        disabled={!g.isMyTurn || g.auto}
        onPlay={g.play}
      />
    );

  const autoToggle = (
    <button
      onClick={() => g.setAuto(!g.auto)}
      aria-pressed={g.auto}
      className={`qp-btn ttt-ctl-btn w-full flex items-center justify-center gap-2 ${g.auto ? "qp-btn--go" : ""}`}
    >
      <span
        className={`grid h-4 w-4 shrink-0 place-items-center border-[2px] border-[var(--qp-ink)] text-xs rounded-sm ${g.auto ? "bg-[var(--qp-ink)] text-[var(--qp-paper)]" : "bg-[var(--qp-paper)]"}`}
      >
        {g.auto ? "✓" : ""}
      </span>
      Auto
    </button>
  );
  // Match-flow actions (next / stop / requeue) — only the relevant one shows.
  const actions = (
    <>
      {g.phase === "playing" &&
        g.innerOver &&
        !g.terminal &&
        g.role === "A" && (
          <button
            onClick={g.next}
            disabled={g.auto}
            className="qp-btn qp-btn--go ttt-ctl-btn w-full disabled:opacity-40 uppercase tracking-wider"
          >
            Next →
          </button>
        )}
      {g.innerOver && g.phase === "playing" && (
        <button
          onClick={g.stop}
          className="qp-btn ttt-ctl-btn w-full uppercase tracking-wider"
        >
          Stop &amp; settle
        </button>
      )}
      {g.phase === "done" && (
        <button
          onClick={() => {
            g.leave();
            g.playArena();
          }}
          className="qp-btn qp-btn--go ttt-ctl-btn w-full uppercase tracking-wider"
        >
          New match
        </button>
      )}
    </>
  );

  const youAre = (
    <div className="text-center leading-tight">
      <div className="qp-eyebrow text-[11px]">You are</div>
      <div className="font-bold text-2xl">
        {g.myMark === 1 ? "✕ (X)" : "◯ (O)"}
      </div>
    </div>
  );
  const scoreRow = (
    <div className="w-full flex items-center justify-center gap-3 font-bold text-lg tabular-nums">
      <span className="text-[var(--qp-red)]">✕ {g.score.x}</span>
      <span className="text-[var(--qp-ink)]">◯ {g.score.o}</span>
      <span className="text-[var(--qp-ink-soft)]">= {g.score.draws}</span>
    </div>
  );
  const gameLog = (
    <div className="w-full border-t-2 border-[var(--qp-ink-soft)]/40 pt-2">
      <div className="qp-eyebrow text-[11px] opacity-80 mb-1.5">On-chain</div>
      {g.games.length > 0 && (
        <div className="max-h-28 overflow-y-auto flex flex-col gap-0.5 font-mono text-[10px] mb-2">
          {[...g.games].reverse().map((r) => (
            <div key={r.game} className="flex justify-between">
              <span>Game {r.game}</span>
              <span
                className={`font-bold ${r.winner === 1 ? "text-primary" : r.winner === 2 ? "text-secondary" : "text-outline"}`}
              >
                {r.winner === 1 ? "X" : r.winner === 2 ? "O" : "draw"}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1 text-[10px] font-mono">
        <Digest label="OPEN:" digest={g.digests.create} />
        <Digest label="DEPOSIT:" digest={g.digests.deposit} />
        <Digest label="CLOSE:" digest={g.digests.close} />
      </div>
    </div>
  );

  // Portrait: stack board over a compact control/log block.
  if (isPortrait) {
    return (
      <div className="w-full h-full overflow-hidden flex flex-col items-center gap-1 p-1">
        <div className="w-full flex items-center justify-between gap-2 border-b-2 border-[var(--qp-ink-soft)] pb-2">
          {youAre}
          {scoreRow}
        </div>
        <div className="ttt-board-area flex-1 min-h-0 w-full grid place-items-center">
          <div className="ttt-board-square">{board}</div>
        </div>
        <div className="text-center qp-title text-xl min-h-[24px]">
          {statusText(g)}
        </div>
        <div className="w-full max-w-[480px] flex flex-col items-center gap-2 border-t-2 border-[var(--qp-ink-soft)] pt-2">
          <div className="flex items-stretch gap-3 w-full">
            <button
              onClick={returnToLobby}
              className="qp-btn ttt-ctl-btn flex-1"
            >
              ← Leave
            </button>
            {autoToggle}
          </div>
          <div className="flex items-stretch gap-3 w-full">{actions}</div>
          {gameLog}
        </div>
      </div>
    );
  }

  // Landscape: Bomb It-style three columns — controls pane | board hero | info pane.
  return (
    <div className="w-full h-full overflow-hidden flex flex-row items-stretch gap-3 px-1 py-2">
      {/* Left pane: leave, auto, match-flow actions, status. */}
      <aside className="ttt-pane qp-panel qp-stroke shrink-0 flex flex-col items-center gap-3 overflow-y-auto">
        <button onClick={returnToLobby} className="qp-btn ttt-ctl-btn w-full">
          ← Leave
        </button>
        {autoToggle}
        <div className="w-full flex flex-col gap-2">{actions}</div>
        <span className="qp-eyebrow text-[11px] opacity-80 text-center">
          Game {g.currentGame}
        </span>
        <div className="qp-title text-base leading-tight text-center min-h-[2.4em] flex items-center">
          {statusText(g)}
        </div>
      </aside>

      {/* Center: board hero (square). */}
      <main className="ttt-board-area flex-1 min-w-0 grid place-items-center">
        <div className="ttt-board-square">{board}</div>
      </main>

      {/* Right pane: you-are + scores + on-chain log. */}
      <aside className="ttt-pane qp-panel qp-stroke shrink-0 flex flex-col items-center gap-3 overflow-y-auto">
        {youAre}
        {scoreRow}
        {gameLog}
        {g.error && (
          <div className="text-[11px] text-secondary italic w-full text-center break-words">
            {g.error}
          </div>
        )}
      </aside>
    </div>
  );
}
