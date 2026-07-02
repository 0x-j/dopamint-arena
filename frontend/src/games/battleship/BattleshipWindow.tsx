import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Wallet } from "lucide-react";
import { ConnectModal, useCurrentAccount } from "@mysten/dapp-kit";
import { isEnokiWallet } from "@mysten/enoki";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { GameWindowProps } from "../types";
import { PlacementBoard } from "./components/PlacementBoard";
import { BattleView } from "./components/BattleView";
import { useBattleshipPvp } from "./useBattleshipPvp";
import { SketchDefs } from "../sketch";
import "./battleship.css";

// Big pill action in the shared hand-drawn "sketch" skin (matches Quantum Poker):
// amber-inked "go" for the primary. The `qp-btn` class carries the wobble border +
// cqmin sizing; we add layout utilities.
const BTN_PRIMARY =
  "sketch-btn sketch-btn--go inline-flex w-full items-center justify-center gap-2";

/**
 * Battleship over a REAL Sui tunnel, PvP only. Requires a connected wallet (gas is
 * sponsored, so play is free): matchmaking pairs a real opponent over the relay, every
 * shot is commit-revealed and co-signed, and the winner settles on-chain. The session
 * lives in a windowId-keyed store, so minimizing or resizing the window never drops the
 * game. ADR 0003.
 */
export function BattleshipWindow({ windowId }: GameWindowProps) {
  // One size-container for the whole game so every pane sizes off the WINDOW's
  // width AND height (container queries + cqh units), not the viewport — correct
  // in a small floating window on a big screen, or full-width on mobile.
  return (
    <div className="sketch relative h-full min-h-0 overflow-hidden">
      {/* The roughen filter every `.qp-*` / `.bs-*` border references — rendered once. */}
      <SketchDefs />

      {/* Actual game layout sits on top */}
      <div className="relative z-20 h-full w-full">
        <PvpGame windowId={windowId} />
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="sketch-note flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      {children}
    </div>
  );
}

/** Wallet gate: every battleship match opens + settles a real tunnel, so a wallet
 *  is required (gas is sponsored — free to play). One-click connect via Enoki. */
function ConnectWalletPane({ note }: { note: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-5 text-center">
      <div className="flex flex-col items-center gap-1">
        <span className="sketch-eyebrow">Wallet required</span>
        <h3 className="sketch-title text-[clamp(20px,7cqmin,30px)]">
          Connect to play
        </h3>
        <p className="sketch-note mt-1 max-w-xs">{note}</p>
      </div>
      <ConnectModal
        walletFilter={isEnokiWallet}
        trigger={
          <button className={cn(BTN_PRIMARY, "max-w-xs")}>
            <Wallet className="size-4" /> Connect wallet
          </button>
        }
      />
    </div>
  );
}

/** Big tap-to-toggle "Auto" checkbox: hands your shots to autopilot. */
function AutoToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title="Let the bot play your shots too"
      className={cn(
        "sketch-btn inline-flex items-center gap-1",
        on && "sketch-btn--go",
      )}
    >
      <span className="grid size-[1.1em] place-items-center">
        {on ? <Check className="size-[0.9em]" strokeWidth={3} /> : "○"}
      </span>
      Auto
    </button>
  );
}

/** Every mode renders inside this frame: a thin control strip carries the back button
 *  and optional trailing actions (Auto / Settle) — NOT a title, since the desktop window
 *  chrome above already shows one — with the mode's own UI filling the space below it. */
function ModeFrame({
  onBack,
  headerExtra,
  children,
}: {
  onBack?: () => void;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col">
      {/* A thin in-game control strip. The window chrome above already shows the title,
          so this carries only the game actions (Back / Auto / Settle), kept compact.
          Back is omitted on the placement menu — closing is the title-bar ✕'s job. */}
      <header className="bs-head shrink-0 py-[clamp(4px,1.4cqmin,9px)]">
        {onBack && (
          <button
            onClick={onBack}
            className="sketch-btn inline-flex items-center gap-1"
          >
            <ArrowLeft className="size-[1em]" /> Back
          </button>
        )}
        {headerExtra && <div className="ml-auto shrink-0">{headerExtra}</div>}
      </header>
      {/* Scrolls vertically when a pane is taller than the window (e.g. stacked
          boards on a short phone); the radar background behind stays fixed. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function ErrorPane({
  error,
  onBack,
}: {
  error: string | null;
  onBack: () => void;
}) {
  return (
    <Centered>
      <p className="text-[var(--sketch-red)]">
        {error ?? "something went wrong"}
      </p>
      <button onClick={onBack} className="sketch-btn">
        Back
      </button>
    </Centered>
  );
}

function settleLabel(status: string): string | undefined {
  if (status === "settling") return "settling on-chain…";
  if (status === "settled") return "settled ✓";
  return undefined;
}

function PvpGame({ windowId }: { windowId: string }) {
  const {
    status,
    view,
    error,
    opponentWallet,
    playArena,
    fire,
    auto,
    setAuto,
    reset,
    endMatch,
  } = useBattleshipPvp(windowId);
  const account = useCurrentAccount();

  // Notify once when the match settles on-chain (auto-settles at game end in PvP).
  useEffect(() => {
    if (status === "settled") {
      toast.success(
        view?.outcome === "win"
          ? "Victory — match settled ✓"
          : view?.outcome === "lose"
            ? "Defeat — match settled ✓"
            : "Match settled ✓",
      );
    }
    // outcome is stable once settled; status drives the one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Courtesy autopilot: if it's YOUR turn and you sit idle for 10s, switch autopilot
  // on so the opponent isn't left waiting. Firing passes the turn (myTurn → false),
  // which clears the timer; it re-arms each time it's your turn, and stops once auto.
  useEffect(() => {
    if (status !== "playing" || auto || !view?.myTurn) return;
    const t = setTimeout(() => {
      setAuto(true);
      toast("Autopilot on — you were idle");
    }, 10_000);
    return () => clearTimeout(t);
  }, [status, auto, view?.myTurn, setAuto]);

  // Back: publish our settlement half, then drop back to the placement menu once it's on the wire
  // (status → settled) or if it errors — a failed/stuck close must never trap the player. A timeout
  // backstops an unreachable settle boundary. The window itself closes only via the title-bar ✕ or
  // Back on the placement menu (idle).
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!leaving) return;
    if (status === "settled" || status === "error") {
      setLeaving(false);
      reset();
      return;
    }
    const bail = window.setTimeout(() => {
      setLeaving(false);
      reset();
    }, 8000);
    return () => window.clearTimeout(bail);
  }, [leaving, status, reset]);
  const back = () => {
    if (status === "playing" || status === "settling") {
      setLeaving(true);
      endMatch(); // publish our half; the leaving effect returns to the menu on "settled"
    } else {
      reset(); // matching / funding / error → back to the placement menu
    }
  };
  let content: ReactNode;
  if (!account && !view) {
    // No wallet → require connect before matchmaking (the match is on-chain).
    content = (
      <ConnectWalletPane note="PvP matches open a shared tunnel and settle on-chain — gas is sponsored, so it's free to play." />
    );
  } else if (status === "error") {
    content = <ErrorPane error={error} onBack={back} />;
  } else if (status === "idle") {
    content = <PlacementBoard onReady={playArena} ctaLabel="Play" />;
  } else if (status === "matching" || status === "funding" || !view) {
    content = (
      <Centered>
        <div>
          {status === "matching"
            ? "Finding an opponent…"
            : status === "funding"
              ? "Opening + funding the tunnel on-chain… approve in your wallet."
              : "Setting up…"}
        </div>
        {opponentWallet && (
          <div className="text-[11px]">vs {opponentWallet.slice(0, 10)}…</div>
        )}
      </Centered>
    );
  } else {
    content = (
      <BattleView
        view={view}
        statusLabel={settleLabel(status)}
        onFire={fire}
        // End the match early without leaving the window: publish our half + show the settled screen
        // (BattleView hides this once settled). Back instead closes the window — same publish path.
        onSettle={endMatch}
        // "Find next match": after the match settles, reset to placement (stay in PvP)
        // so the next Find Match is one tap away — not back out to the arena.
        onPlayAgain={reset}
        playAgainLabel="Find next match"
        playAgainDisabled={status === "settling"}
        auto={auto}
      />
    );
  }
  // Autopilot toggle appears once a match is live (a fired shot is possible).
  const headerExtra =
    view && status === "playing" ? (
      <AutoToggle on={auto} onChange={setAuto} />
    ) : undefined;
  return (
    <ModeFrame
      onBack={status === "idle" ? undefined : back}
      headerExtra={headerExtra}
    >
      {content}
    </ModeFrame>
  );
}
