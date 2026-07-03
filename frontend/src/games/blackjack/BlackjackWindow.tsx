import type { GameWindowProps } from "../types";
import App from "./app/App";

/** The integrated Blackjack game running as a Native Component window. */
export function BlackjackWindow({ windowId }: GameWindowProps) {
  return <App windowId={windowId} />;
}
