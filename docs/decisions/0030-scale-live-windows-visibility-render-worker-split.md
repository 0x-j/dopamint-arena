# 0030 — Scale live game windows: visibility-gated render + socket/game-worker split

- **Status**: Proposed
- **Date**: 2026-07-01

## Context

A user can open many concurrent game windows (target: ~30). Each window's match
runs off the main thread in one shared PvP hub worker (ADR-not-recorded; see
`engine/pvpHub.ts`), which multiplexes every window's session over **one** relay
socket. The co-sign hot loop is already off-main, so main-thread FPS holds; the
felt "lag" at many windows is two separate ceilings:

1. **Main-thread render.** Game boards are DOM/React (not canvas), so they can
   only paint on the main thread. Today every live window — including ones in a
   hidden workspace (`display:none`) or scrolled off-screen — still counts in the
   adaptive render throttle (`renderIntervalMs`, `n = pvpWindows.size`) and still
   React-reconciles on each snapshot. With N ≥ 7 the throttle floors every board
   at ~4 fps to protect the shared budget, so on-screen games get choppy paying
   for off-screen ones. Adding workers cannot move DOM paint off-main, so it does
   **not** touch this ceiling.
2. **Single worker thread.** All N matches' co-signing shares one worker isolate.
   At human pace this is network-bound and fine; under flat-out auto-play (30
   games co-signing as fast as frames arrive) that one thread can saturate, so
   matches advance slower than N cores could.

## Decision

We scale live windows along both axes:

1. **Visibility-gated rendering.** Windows report on-screen/off-screen via an
   `IntersectionObserver` (workspace switch → `display:none`, minimize, scroll all
   collapse to one signal); the engine keeps every match **running in its worker**
   but delivers snapshots to React **only for visible windows**, and counts only
   visible windows in the render-throttle budget. Off-screen → store the latest
   snapshot, skip the notify; on becoming visible → flush the stored snapshot once
   and resume. "Not rendered" never means "not running" — auto-play lives in the
   worker controller and drives the match to settle regardless of paint.
2. **Socket/game-worker split.** Replace the single hub with **one dedicated
   socket worker** that owns the single relay WebSocket and routes frames by
   matchId, plus **one game worker per window** hosting that window's
   `PvpMatchSession` (tunnel client + co-sign). Game workers exchange relay frames
   with the socket worker over a `MessageChannel`. This keeps the one-socket
   invariant (ADR-0011/0015 relay-pressure rationale) while spreading co-sign
   across cores and isolating a game's fault to its own worker. The live-window
   cap (`deviceTier`) becomes a real per-isolate memory budget again, as its
   docstring already assumes.

Sequencing: (1) ships first — self-contained in the render/notify path, no
topology change, immediately removes the off-screen render tax. (2) follows.

## Consequences

- **Easier**: many windows stay smooth because only on-screen boards paint and
  only they spend the render budget; auto-play in hidden workspaces runs to settle
  untouched. Co-sign parallelizes across cores; one game crashing can't take down
  the others.
- **Harder / committed to**: the engine now needs a visibility signal from the UI
  (engine↔desktop boundary — via `GameWindow`'s existing `domId`, which equals the
  window id). The worker split adds an inter-worker frame-routing protocol
  (socket worker ↔ game workers) and N× the engine-bundle memory, bounded by the
  `deviceTier` cap; parallelism is still capped by core count, not window count.
- **Explicitly not doing**: one dedicated socket **per** window (the relay-pressure
  regression the shared hub was built to avoid); moving DOM boards to
  OffscreenCanvas (would parallelize paint but requires rewriting every game's
  rendering — out of scope); raising the window cap beyond the device memory tier.
