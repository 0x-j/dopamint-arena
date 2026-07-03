import "global-jsdom/register";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, render } from "@testing-library/react";
import { ForfeitDialog } from "./ForfeitDialog.tsx";

// global-jsdom only copies window globals that Node doesn't already define (see its KEYS
// filter), so Node's native CustomEvent/Event/EventTarget shadow jsdom's. Radix's
// DismissableLayer dispatches a CustomEvent at jsdom's `document`, which rejects
// cross-realm Event instances — realign these three to jsdom's window so dispatchEvent
// accepts them.
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
globalThis.EventTarget = window.EventTarget;

afterEach(cleanup);

test("ForfeitDialog renders the exact copy with the stake when open", () => {
  const { baseElement } = render(
    <ForfeitDialog
      open
      stake="100 MTPS"
      onKeepPlaying={() => {}}
      onForfeit={() => {}}
    />,
  );
  const html = baseElement.innerHTML;
  assert.ok(html.includes("Forfeit this match?"));
  assert.ok(html.includes("your 100 MTPS stake is gone"));
  assert.ok(html.includes("Keep playing"));
  assert.ok(
    html.includes("Forfeit &amp; leave") || html.includes("Forfeit & leave"),
  );
});

test("ForfeitDialog renders nothing when closed", () => {
  const { baseElement } = render(
    <ForfeitDialog
      open={false}
      stake="100 MTPS"
      onKeepPlaying={() => {}}
      onForfeit={() => {}}
    />,
  );
  assert.ok(!baseElement.innerHTML.includes("Forfeit this match?"));
});
