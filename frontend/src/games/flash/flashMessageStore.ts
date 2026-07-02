/**
 * Companion persistence for the flash chat's VISIBLE transcript. The protocol state is a rolling
 * digest (`FlashState.transcriptDigest`) — a fold, not the message text — so a reloaded session
 * would rebuild the tunnel via the resume record but show an empty chat. This keeps the bubbles,
 * keyed by tunnelId, alongside the resume record. Cleared on settle / New Chat.
 */
import type { FlashChatMessage } from "./session-core";

const keyFor = (tunnelId: string) => `flash:msgs:${tunnelId}`;

export function saveFlashMessages(
  tunnelId: string,
  messages: FlashChatMessage[],
): void {
  try {
    localStorage.setItem(keyFor(tunnelId), JSON.stringify(messages));
  } catch {
    /* storage full / unavailable — the tunnel still resumes, only the visible history is lost */
  }
}

export function loadFlashMessages(tunnelId: string): FlashChatMessage[] {
  try {
    const raw = localStorage.getItem(keyFor(tunnelId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FlashChatMessage[]) : [];
  } catch {
    return [];
  }
}

export function clearFlashMessages(tunnelId: string): void {
  try {
    localStorage.removeItem(keyFor(tunnelId));
  } catch {
    /* ignore */
  }
}
