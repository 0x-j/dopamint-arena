import { cn } from "@/lib/utils";
import { FLEET_CELLS } from "../engine/fleet";
import type { BattleshipView } from "../view";
import { BoardGrid } from "./BoardGrid";

/**
 * The in-battle screen shared by both modes: enemy waters (where you fire) and
 * your own fleet under fire, your fleet's ship roster, a turn banner, and — when
 * the game ends — a result overlay with damage stats. Outcome is from this seat's
 * perspective, so it reads right for either PvP role.
 */
export function BattleView({
  view,
  statusLabel,
  onFire,
  onPlayAgain,
  auto = false,
  score,
  gameNumber,
  playAgainLabel,
  playAgainDisabled,
}: {
  view: BattleshipView;
  /** Extra status line shown on the result card (e.g. "settling…", "settled ✓"). */
  statusLabel?: string;
  onFire: (cell: number) => void;
  onPlayAgain: () => void;
  /** Autopilot is firing your shots too — reflect it in the turn banner, and (since
   *  finished games rematch automatically) suppress the blocking result overlay. */
  auto?: boolean;
  /** Multi-game session tally (bot mode): your wins vs the bot's, across one tunnel. */
  score?: { you: number; foe: number };
  /** 1-based number of the game on screen (bot multi-game). */
  gameNumber?: number;
  /** Label for the primary post-game action (e.g. "Find next match" in PvP). */
  playAgainLabel?: string;
  /** Disable the post-game action (e.g. while a PvP settle is still in flight). */
  playAgainDisabled?: boolean;
}) {
  const accuracy =
    view.yourShots > 0
      ? Math.round((view.hitsOnEnemy / view.yourShots) * 100)
      : 0;

  return (
    <div className="relative flex min-h-full flex-col gap-2 p-2 @[26rem]:p-3 lg:h-full lg:min-h-0 lg:overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[clamp(10px,2.6cqmin,15px)] text-[var(--sketch-ink-soft)]">
        <span>
          Enemy sunk{" "}
          <span className="text-[var(--sketch-ink)]">
            {view.hitsOnEnemy}/{FLEET_CELLS}
          </span>{" "}
          · your hull{" "}
          <span className="text-[var(--sketch-ink)]">
            {view.hitsOnYou}/{FLEET_CELLS}
          </span>
        </span>
        <span>
          {score ? (
            <>
              <span className="uppercase tracking-wider text-[var(--sketch-accent)]">
                Game {gameNumber}
              </span>{" "}
              · <span className="text-[var(--sketch-felt)]">{score.you}</span>–
              <span className="text-[var(--sketch-red)]">{score.foe}</span>
            </>
          ) : view.onChain ? (
            "on-chain"
          ) : (
            "demo · off-chain"
          )}
        </span>
      </div>

      {/* Boards are VIEWPORT-driven, not container-driven. Desktop (≥lg, the windowed shell):
          side-by-side and height-fit — they shrink to fill the window like quantum poker's felt,
          never restacking into a column and never scrolling. Mobile (<lg): one column of
          FULL-WIDTH boards (big tap targets), and the page scrolls vertically (ModeFrame owns the
          overflow-y-auto) since two full-width boards exceed the viewport — far easier to tap than
          two height-squeezed boards. */}
      <div className="grid grid-cols-1 gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-2 lg:gap-4">
        <BoardGrid
          title="Enemy waters"
          cells={view.enemyCells}
          interactive={view.myTurn && !auto}
          onCell={onFire}
          lastShot={view.lastYourShot}
        />
        <BoardGrid
          title="Your fleet"
          cells={view.ownCells}
          lastShot={view.lastEnemyShot}
          placements={view.placements}
        />
      </div>

      {/* Manual play only: a thin turn prompt. Autopilot needs none — the animating
          boards already show the duel, and dropping it gives the boards more height. */}
      {view.outcome === null && !auto && (
        <div className="shrink-0 text-center text-[clamp(13px,3.4cqmin,20px)]">
          <span
            className={cn(
              view.myTurn
                ? "text-[var(--sketch-accent)] motion-safe:animate-pulse"
                : "text-[var(--sketch-ink-soft)]",
            )}
          >
            {view.myTurn ? "Your turn — fire!" : "Opponent is aiming…"}
          </span>
        </div>
      )}

      {/* Result card. Suppressed while autopilot is looping (it rematches on its own);
          shown when a game ends in manual play, with Play Again. */}
      {view.outcome !== null && !auto && (
        <div className="absolute inset-0 grid place-items-center overflow-y-auto bg-[rgba(35,34,31,0.32)] p-2 backdrop-blur-[2px] @[20rem]:p-4">
          <div className="sketch-panel sketch-stroke flex w-full max-w-xs animate-in flex-col items-center gap-3 p-4 text-center zoom-in-95 @[20rem]:p-5">
            <div
              className={cn(
                "sketch-title text-[clamp(20px,7cqmin,30px)]",
                view.outcome === "win"
                  ? "text-[var(--sketch-felt)]"
                  : "text-[var(--sketch-red)]",
              )}
            >
              {view.outcome === "win" ? "Victory" : "Defeat"}
            </div>
            {score ? (
              <p className="sketch-note">
                Session{" "}
                <span className="text-[var(--sketch-felt)]">{score.you}</span> –{" "}
                <span className="text-[var(--sketch-red)]">{score.foe}</span> ·
                settle to cash out, or play on.
              </p>
            ) : (
              <p className="sketch-note">
                {view.outcome === "win"
                  ? "You sank the enemy fleet."
                  : "Your fleet was sunk."}
              </p>
            )}
            <dl className="grid w-full grid-cols-1 gap-y-1.5 text-[clamp(10px,2.6cqmin,15px)] @[16rem]:grid-cols-2">
              <Stat label="Shots fired" value={String(view.yourShots)} />
              <Stat label="Hits" value={String(view.hitsOnEnemy)} />
              <Stat label="Accuracy" value={`${accuracy}%`} />
              <Stat
                label="Hull lost"
                value={`${view.hitsOnYou}/${FLEET_CELLS}`}
              />
            </dl>
            <div className="text-[clamp(10px,2.4cqmin,14px)] text-[var(--sketch-ink-soft)]">
              {statusLabel ?? ""}
            </div>
            <div className="mt-1 flex w-full flex-col gap-2">
              <button
                onClick={onPlayAgain}
                disabled={playAgainDisabled}
                className="sketch-btn sketch-btn--go w-full"
              >
                {playAgainLabel ?? "Play Again"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-2">
      <dt className="text-[var(--sketch-ink-soft)]">{label}</dt>
      <dd className="text-[var(--sketch-ink)]">{value}</dd>
    </div>
  );
}
