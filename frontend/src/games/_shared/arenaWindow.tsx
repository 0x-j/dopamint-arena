import { type ReactNode } from "react";
import type { GameWindowProps } from "../types";
import { ArenaScreen, type ArenaScreenTheme } from "./ArenaScreen";

/** The pvp-match surface the window controller reads. */
interface ArenaPvp {
  status: string; // PvpStatus, but the controller only string-compares it
  error: string | null;
  view: unknown;
  reset: () => void;
  /** Idle "Play": reserve a server bot for this game and enter its tunnel. See pvpMatchHook.playArena. */
  playArena: () => void;
  /** Back/Cancel: settles (publishes a half) when a match is live, else resets. See pvpMatchHook. */
  leave: () => void;
}

export interface ArenaWindowSpec<Pvp extends ArenaPvp> {
  /** Disposer/label prefix (e.g. "bomb-it"). */
  game: string;
  usePvp: (windowId: string) => Pvp;
  /** The idle screen: a single "Play" button that allocates a server bot for this game and enters. */
  Lobby: (props: { onPlay: () => void }) => ReactNode;
  /** Per-game card-chrome theme for the transitional screens. */
  screen: ArenaScreenTheme;
  /** PvP matchmaking title — "Finding match" / "Finding…" (kept per game, not unified). */
  matchingTitle: string;
  /** Render the game's board for the live pvp match. */
  renderPvpBoard: (pvp: Pvp, onPlayAgain: () => void) => ReactNode;
}

/**
 * Build an arena game Window: the single-button "Play" entry + status router shared by every
 * symmetric PvP tunnel game (bomb-it, chicken-cross). Driven entirely off the PvP session status —
 * `idle` shows the lobby's Play button; everything else routes through the matching/funding/error
 * screens to the live board. The session lives out-of-React (keyed by windowId), so a minimize /
 * reflow stays connected and a remount mid-match resumes straight to the board. A game supplies
 * only its hook, lobby, board render, and the strings/theme that differ.
 */
export function createArenaWindow<Pvp extends ArenaPvp>(
  spec: ArenaWindowSpec<Pvp>,
): (props: GameWindowProps) => ReactNode {
  return function ArenaWindow({ windowId }: GameWindowProps): ReactNode {
    const pvp = spec.usePvp(windowId);
    // Back/Cancel: `leave` settles first when a match is live (publishes our half, then returns to the
    // lobby); on the matching/error/settled screens it just resets. So an in-game Back no longer
    // strands the staked tunnel — it publishes a settlement half on the way out.
    const backToLobby = () => pvp.leave();

    const screen = (
      children: ReactNode,
      onBack?: () => void,
      backLabel?: string,
    ) => (
      <ArenaScreen theme={spec.screen} onBack={onBack} backLabel={backLabel}>
        {children}
      </ArenaScreen>
    );
    const funding = screen(
      <>
        <span className="sketch-eyebrow">Tunnel</span>
        <h2 className="sketch-title">Funding</h2>
        <p className="sketch-note">
          Opening + funding the tunnel on-chain… approve in your wallet.
        </p>
      </>,
    );
    const loading = screen(<p className="sketch-note">Loading…</p>);

    if (pvp.status === "idle") {
      const { Lobby } = spec;
      return <Lobby onPlay={() => pvp.playArena()} />;
    }
    if (pvp.status === "error")
      return screen(
        <p className="sketch-note text-[var(--sketch-red)]">
          {pvp.error ?? "something went wrong"}
        </p>,
        backToLobby,
      );
    if (pvp.status === "matching")
      return screen(
        <>
          <span className="sketch-eyebrow">Relay</span>
          <h2 className="sketch-title">{spec.matchingTitle}</h2>
          <p className="sketch-note">
            Matching you with the next player over the relay.
          </p>
        </>,
        backToLobby,
        "Cancel",
      );
    if (pvp.status === "funding") return funding;
    if (
      (pvp.status === "playing" ||
        pvp.status === "settling" ||
        pvp.status === "settled") &&
      pvp.view !== null
    )
      return spec.renderPvpBoard(pvp, backToLobby);
    return loading;
  };
}
