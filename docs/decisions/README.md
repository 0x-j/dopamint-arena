# Architecture Decision Records

Short records of **architecture-level** decisions, written _before_ the code
that depends on them. An ADR captures the decision and the reasoning so the
_why_ survives after the people involved have moved on.

## Convention

- **Architectural only.** An ADR records a decision that shapes system
  structure, crosses a component or team boundary, or is costly to reverse
  (control-plane topology, settlement auth, randomness strategy, funding model).
  It is **not** for implementation details, library/component choices, or a game
  adopting an already-recorded pattern — those belong in a design doc or the PR.
- One file per decision: `NNNN-kebab-case-title.md` (zero-padded, monotonic and
  **unique** — never reuse a number). Numbers match the references in the code.
- Copy `0000-template.md` to start.
- Status moves `Proposed → Accepted → (Superseded by NNNN)`. Never delete a
  superseded ADR — mark it and link forward, so the history stays readable.
- Keep it short. An ADR records a decision; it is not a design doc.

## Index

- [0001](0001-arena-baseline-architecture.md) — Baseline architecture: Rust
  control-plane backend, per-game `Protocol`. _(§1 self-play hot path retired by
  0020 — users compete against our bots; genuine two-party play is the only
  model.)_
- [0002](0002-backend-client-api-contract.md) — Backend ↔ client REST/SSE
  contract: sessions, heartbeat, settle, live stats. _(Settle-auth portion
  superseded by 0007.)_
- [0003](0003-battleship-on-sui-tunnel.md) — Battleship on the tunnel:
  commit-reveal fairness with public-only protocol state.
- [0005](0005-redis-backed-ha-control-plane.md) — HA control plane on Redis only
  (cache + pubsub clusters, no Postgres); delivery partitioned by instance;
  address-balance gas for concurrent settle.
- [0007](0007-settle-authorized-by-settlement-not-token.md) — Settlement is
  self-authenticating; `/settle` verifies the co-signed bytes against the tunnel's
  on-chain party pubkeys and drops the session bearer token. Supersedes the
  settle-auth portion of 0002.
- [0008](0008-quantum-poker-protocol-zk.md) — Quantum Poker: protocol-first
  tunnel model, per-slot asymmetric commit-reveal, n-deck/burn/Five-of-a-Kind
  rules, and optional ZK dispute adapter.
- [0009](0009-sponsor-create-and-fund-gas.md) — Backend sponsors gas (only) for
  the user's open/fund tx via SIP-58 address balance; the user's stake stays
  user-owned. Enables 0-SUI zkLogin onboarding.
- [0010](0010-mtps-stake-token.md) — Free faucet-minted MTPS token for stakes
  (not SUI), auto-minted before stake; gas still sponsored in SUI. (Token renamed
  DOPAMINT → MTPS.)
- [0011](0011-local-first-pairing.md) — Local-first pairing: bounded-hold
  matchmaking (same-instance preferred, ≤750 ms hold before cross-instance
  fallback) plus a reconnect affinity cookie for co-location.
- [0012](0012-arena-attract-cabinet-seam.md) — Arena attract mode: one shared
  cabinet shell (`GameCabinet` + `CabinetController`) owns hover → pause →
  take-over; auto-play is a config (the kit is the brain); take-over is cosmetic
  on-chain today (real ephemeral-key you-vs-bot deferred). Applies to every arena
  game (all share the auto-loop + take-a-seat shape); ttt is the reference.
- [0013](0013-address-balance-stake.md) — Fund the stake from the player's SIP-58
  address balance (`coin::redeem_funds`/`tx.withdrawal`) instead of a version-pinned
  `Coin<T>`, so concurrent reload opens stop equivocating. Sponsor allowlist gains
  `redeem_funds`/`send_funds` + a mandatory `WithdrawFrom::Sender` input guard
  (anti settler-drain). Behind `VITE_MTPS_ADDRESS_BALANCE`; no Move redeploy.
- [0014](0014-enoki-sponsor-with-settler-fallback.md) — Enoki sponsored
  transactions as the primary gas source with the settler wallet as fallback:
  validate-first, `provider`-tagged response, stateless two-call Enoki execute,
  settler path unchanged. Refines 0009.
- [0015](0015-data-plane-local-control-plane-redis.md) — Partition by ownership:
  single-owned per-move state (relay, counters, routing cache) in-process; shared
  state (matchmaking, presence, match record, checkpoints, stats) on atomic Redis.
  Refines 0005; demotes its per-frame `SPUBLISH` to a fallback.
- [0016](0016-mp-resume-protocol.md) — MP resume: atomic `ConnRef` rebind,
  event-driven peer-cache eviction, peer-to-peer state reconciliation; on-chain
  settlement is the floor. Affinity/re-homing deferred to ADR-0011.
- [0017](0017-deterministic-seed-vs-commit-reveal.md) — Derive randomness from a
  deterministic `tunnelId` seed for public symmetric fields (blackjack, bomb-it,
  chicken-cross); reserve commit-reveal for hidden-state games.
- [0018](0018-multi-game-self-play-per-game-seed.md) — Multi-game wrappers with a
  synthetic per-game seed (`` `${tunnelId}:g${gamesPlayed}` ``) for bomb-it &
  chicken-cross, mirroring battleship's many-games-per-tunnel shape.
- [0019](0019-batched-tunnel-open.md) — Batch connect-time self-play tunnel opens
  into one PTB instead of one sponsored open+fund per window.
- [0021](0021-sans-io-synchronous-protocol-core.md) — Adopt sans-IO: the protocol
  core is synchronous and pure (no futures in the transition); async is confined
  to the IO seams (FrameTransport, MoveStrategy, future remote-KMS Signer).
  Required by 0020.
- [0022](0022-canonical-protocol-id-naming.md) — Canonical protocol IDs use
  snake_case segments separated by dots and an explicit `.vN` suffix; `.series`
  replaces new `.multi` wrapper IDs, with legacy aliases recorded in the port
  inventory.
- [0023](0023-mtps-token-hardening.md) — Harden the MTPS stake token: admin-only
  `admin_mint` via an owned `AdminCap` (no public mint → no brick/griefing), a
  0-decimal whole-token currency via `coin_registry`; the faucet moves to the
  backend admin endpoint. Builds on 0010.
- [0024](0024-control-plane-durable-s3-archive-retry-queue.md) — Control plane gains
  narrow read/write access to one Postgres work-queue table (`pending_s3_archive`) for
  durable S3-archive retry; a contained exception to ADR-0005/0015's Redis-only rule.
- [0026](0026-arena-enter-one-sig-genuine-two-party.md) — Arena enter: one
  sponsored PTB opens + funds-own-seat every game vs warm fleet bots; direct
  allocation (not FIFO), user=A/bot=B, bot drives settle, genuine auto-play.
  _(Open mechanics — who creates the tunnel — superseded by 0028.)_
- [0028](0028-arena-bot-preopens-user-deposit-only.md) — Arena open: the bot
  pre-creates + funds seat B at allocate; the user joins with a deposit-only PTB
  (Active on one signature). Supersedes the open mechanics of 0026; makes
  `allocate` on-chain-bound, so it **must** be authenticated + rate-limited.
- [0030](0030-scale-live-windows-visibility-render-worker-split.md) — Scale live
  game windows: gate main-thread render by window visibility (off-screen matches
  keep running in the worker, don't paint), and split the shared hub into one
  socket worker + a per-window game worker (`?enginepool`, auto-on High/Max) so
  co-sign spreads across cores while keeping one relay socket.

### Backend-local decisions

Decisions internal to the backend (not crossing into the frontend, on-chain Move,
or the protocol/SDK contract) live in
[`backend/docs/decisions/`](../../backend/docs/decisions/), sharing this ADR
numbering (no gaps reused). Currently:

- 0020 — Two bot fleets over one sans-IO core (user-serving + local bench).
- 0027 — Serving-fleet topology: WS-client for the demo → co-located at scale.
- 0029 — Async queued settlement: `/settle` enqueues → 202; a worker pool
  coalesces closes into batched PTBs behind a governed AIMD+backoff RPC layer.

> Numbers 0004 (multiplayer experience lane) and 0006 have no record file: 0004
> predates this directory (still referenced from code/specs), and 0006 was
> dropped. The numbers are retired, not reused.
