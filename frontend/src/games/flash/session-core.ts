/**
 * Pure, React-free helpers for the flash Play session. SDK imports are
 * `import type` only so this file runs under tsx for tests.
 */
import type { FlashState } from "sui-tunnel-ts/protocol/flash";

export type FlashMove = string;
export type FlashSessionStatus =
  | "idle"
  | "joining"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface FlashChatMessage {
  sender: "You" | "Bot";
  text: string;
}

/** It is the local party's turn iff the last sender was the opponent. */
export function canSend(
  state: FlashState | null,
  selfParty: "A" | "B",
): boolean {
  if (!state) return false;
  if (state.lastSender === null) return selfParty === "A";
  return state.lastSender !== selfParty;
}

/** Build a flash msg move from user text. */
export function makeMove(text: string): FlashMove {
  return text;
}

/** Derive a view-model move from a confirmed move (for the transcript). */
export function messageFromMove(
  text: string,
  bySelf: boolean,
): FlashChatMessage {
  return { sender: bySelf ? "You" : "Bot", text };
}

const LOCAL_BOT_REPLIES = [
  "Interesting point — tell me more.",
  "I see what you mean.",
  "Go on, I'm listening.",
  "That's one way to look at it.",
  "Hmm, let me think about that.",
  "Could you expand on that?",
  "Nice one!",
  "I hadn't considered that.",
];

/** Deterministic-ish offline reply for the local fallback bot. */
export function localBotReply(input: string): string {
  const idx =
    input.length > 0
      ? input.charCodeAt(0) % LOCAL_BOT_REPLIES.length
      : Math.floor(Math.random() * LOCAL_BOT_REPLIES.length);
  return LOCAL_BOT_REPLIES[idx];
}
