import type { GameWindowProps } from "../types";
import App from "./app/App";

/** The Tic-Tac-Toe & Caro PvP game running as a Native Component window. */
export function TicTacToeWindow({ windowId, onClose }: GameWindowProps) {
  return <App windowId={windowId} onClose={onClose} />;
}
