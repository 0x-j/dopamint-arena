import { createContext } from "react";

/**
 * Broadcasts the desktop's "wallet disconnected — sessions frozen" state to every
 * mounted game body (desktop floor, phone floor, overview) without prop-drilling
 * through GridLayout's renderItem. Provided by ArenaView; read by GameContent.
 */
export const FrozenContext = createContext(false);
