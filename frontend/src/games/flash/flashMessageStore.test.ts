import test from "node:test";
import assert from "node:assert/strict";

// localStorage fake — the message store touches it at import-usage time, so install before importing.
class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
(globalThis as Record<string, unknown>).localStorage = new FakeStorage();

const { saveFlashMessages, loadFlashMessages, clearFlashMessages } =
  await import("./flashMessageStore");

test("flash messages round-trip per tunnel and clear evicts them", () => {
  const tunnelId = "0xchat";
  assert.deepEqual(loadFlashMessages(tunnelId), [], "empty before any save");

  const messages = [
    { sender: "You" as const, text: "hello" },
    { sender: "Bot" as const, text: "and spoil the fun" },
  ];
  saveFlashMessages(tunnelId, messages);
  assert.deepEqual(loadFlashMessages(tunnelId), messages);

  // Keyed by tunnel: a different tunnel is isolated.
  assert.deepEqual(loadFlashMessages("0xother"), []);

  clearFlashMessages(tunnelId);
  assert.deepEqual(
    loadFlashMessages(tunnelId),
    [],
    "cleared after settle/new-chat",
  );
});
