/**
 * Generic worker-engine helper for hidden-info turn games (commit-reveal: a binary move codec
 * that strips the secret from the wire, plus a per-match secret built from UI setup). It is the
 * intended de-dup of battleship's hand-rolled `MatchController` (`games/battleship/battleshipSpec.ts`),
 * encapsulating the "fire-vs-propose same-tick" ordering invariant once (design §3.1/§9).
 *
 * STATUS: typed-signature stub. The config below carries only the hidden-info fields the design
 * fixes (§3 variation table, §6): id, stake, protocol, and the REQUIRED secret-stripping codec.
 * The secret-build / fire-ordering / bot-pick / view / resume hooks are deliberately NOT modeled
 * here yet — extracting them from `BattleshipController` is the implementation step, and the doc
 * does not yet enumerate them, so inventing their shapes would get ahead of the spec.
 */
import type { GameId, GameSessionSpec } from "./engineApi";
import type { Protocol } from "sui-tunnel-ts/protocol/Protocol";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";

export interface CommitRevealConfig<State extends { winner: unknown }, Move> {
  game: GameId;
  /** Per-seat stake locked on-chain (MIST). */
  stake: bigint;
  makeProtocol(): Protocol<State, Move>;
  /** REQUIRED: strips the hidden secret from the wire frame (the tunnel enforces this). */
  moveCodec: MoveCodec<Move>;
}

/**
 * TODO(design §3.1/§13): build the shared commit-reveal `MatchController` (secret from
 * `initSetup`, ordered commit+reveal driver, `fire` input + same-tick guard, bot `pickShot`,
 * `deriveView`, resume adapter) so battleship becomes spec-only. Stub until that controller and
 * the remaining config fields are designed; not wired into any spec yet.
 */
export function makeCommitRevealSpec<
  State extends { winner: unknown },
  Move,
  Setup,
  Input,
  View,
>(
  cfg: CommitRevealConfig<State, Move>,
): GameSessionSpec<State, Move, Setup, Input, View> {
  void cfg;
  throw new Error(
    "makeCommitRevealSpec: not implemented (design §3.1/§13) — extract battleship's MatchController",
  );
}
