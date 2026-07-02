/**
 * Flash protocol (`flash.v1`): an unbounded two-party message transcript over a
 * tunnel, one message per move. Showcases max move throughput with instant
 * (non-LLM) replies. State stays fixed-size via a 32-byte rolling digest, so
 * encodeState is O(1) whether the flash session has 10 messages or 4 billion.
 *
 * Moves carry no value (no tips); balances are a nominal stake, returned 50/50
 * at settle. The move counter is capped at 1,000,000 by applyMove — at the cap
 * the driver settles and reopens a fresh tunnel.
 */
import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
  rollingDigest,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";
import { blake2b256 } from "../core/crypto";

/** Canonical signed state. transcriptDigest is a fold of the transcript, not the text. */
export interface FlashState {
  transcriptDigest: Uint8Array;
  messageCount: bigint;
  lastSender: Party | null;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
}

/** A flash move is a plain text message; serialized as a plain string on the wire. */
export type FlashMove = string;

/** Move cap: at 1,000,000 messages the tunnel settles and a fresh one opens. Must stay in lockstep
 *  with the Rust `FLASH_MAX_MOVES` (cross-language parity) — both sides gate `applyMove` on it. */
export const FLASH_MAX_MOVES = 1_000_000n;

const DOMAIN = protocolDomain("flash.v1");
const enc = new TextEncoder();

function partyByte(p: Party): number {
  return p === "A" ? 0x01 : 0x02;
}

export class FlashProtocol implements Protocol<FlashState, FlashMove> {
  readonly name = "flash.v1";

  initialState(ctx: ProtocolContext): FlashState {
    return {
      transcriptDigest: new Uint8Array(32),
      messageCount: 0n,
      lastSender: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
    };
  }

  applyMove(state: FlashState, move: FlashMove, by: Party): FlashState {
    if (state.messageCount >= FLASH_MAX_MOVES) {
      throw new Error("flash: message cap reached");
    }
    const messageBytes = enc.encode(move);
    if (messageBytes.length === 0)
      throw new Error("flash message must be non-empty");
    // Keep each move under one tunnel frame; matches the Move-side wire limit.
    if (messageBytes.length > 256) throw new Error("flash message too long");

    const delta = blake2b256(
      concatBytes([
        Uint8Array.of(partyByte(by)),
        u64ToBeBytes(messageBytes.length),
        messageBytes,
      ]),
    );
    const transcriptDigest = rollingDigest(
      blake2b256,
      state.transcriptDigest,
      delta,
    );

    return {
      transcriptDigest,
      messageCount: state.messageCount + 1n,
      lastSender: by,
      balanceA: state.balanceA,
      balanceB: state.balanceB,
      total: state.total,
    };
  }

  encodeState(state: FlashState): Uint8Array {
    return concatBytes([
      DOMAIN,
      state.transcriptDigest,
      u64ToBeBytes(state.messageCount),
      u64ToBeBytes(state.balanceA),
      u64ToBeBytes(state.balanceB),
    ]);
  }

  balances(state: FlashState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(_state: FlashState): boolean {
    return false;
  }

  randomMove(state: FlashState, _by: Party, _rng: () => number): FlashMove {
    return `msg${state.messageCount}`;
  }
}
