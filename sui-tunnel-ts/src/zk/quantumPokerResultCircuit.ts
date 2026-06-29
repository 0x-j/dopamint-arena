/**
 * Quantum Poker result-proof public input schema.
 *
 * This module intentionally does not try to prove the blake2b mod-52 card
 * derivation inside Circom. The milestone ships the byte-exact public input schema
 * consumed by Sui native Groth16, plus a pluggable prover interface. Real proving
 * artifacts are a deploy-time concern.
 */

import { concatBytes } from "../core/bytes";
import { blake2b256 } from "../core/crypto";
import { addressToBytes32, u64ToBeBytes } from "../core/wire";
import {
  concatScalars,
  fieldSafeScalar,
  hashToFieldSafeScalar,
  u64ToScalar,
} from "./scalars";

const enc = new TextEncoder();

export const QUANTUM_POKER_RESULT_CIRCUIT_NAME = "quantum_poker_result_v1";
export const QUANTUM_POKER_RESULT_PUBLIC_INPUT_COUNT = 8;

export type QuantumPokerWinnerCode = 0 | 1 | 2;

export interface QuantumPokerResultStatement {
  /** fieldSafe(blake2b256(rules descriptor)), supplied as the raw 32-byte digest. */
  rulesHash: Uint8Array;
  /** Tunnel object id/address. Hashed to a field-safe scalar by this builder. */
  tunnelId: string | Uint8Array;
  /** Tunnel disputed state hash, supplied as the raw 32-byte digest. */
  stateHash: Uint8Array;
  handId: bigint | number;
  /** 0 = A, 1 = B, 2 = tie. */
  winner: QuantumPokerWinnerCode;
  partyABalance: bigint | number;
  partyBBalance: bigint | number;
  /** fieldSafe(blake2b256(result descriptor)), supplied as the raw 32-byte digest. */
  resultHash: Uint8Array;
}

export interface QuantumPokerResultWitness {
  /**
   * Circuit-specific private values. The scaffold keeps this opaque so a deploy-time
   * Poseidon-based derivation proof can slot in without changing public inputs.
   */
  readonly values?: Record<string, unknown>;
}

export interface QuantumPokerResultProver {
  readonly circuitName: string;
  prove(
    statement: QuantumPokerResultStatement,
    witness: QuantumPokerResultWitness
  ): Promise<Uint8Array>;
}

export function quantumPokerRulesDescriptor(): Uint8Array {
  return enc.encode(
    [
      "quantum_poker.v2",
      "heads_up",
      "slots=9",
      "single_sample_mod52_per_slot",
      "board_unique",
      "hidden_duplicates_allowed",
      "board_duplicate_hidden_burn",
      "five_of_a_kind_enabled",
    ].join("|")
  );
}

export function quantumPokerRulesHash(): Uint8Array {
  return blake2b256(quantumPokerRulesDescriptor());
}

export interface QuantumPokerResultDescriptor {
  handId: bigint | number;
  winner: QuantumPokerWinnerCode;
  partyABalance: bigint | number;
  partyBBalance: bigint | number;
  board: readonly number[];
  shownHoleA: readonly number[];
  shownHoleB: readonly number[];
  scoreA: bigint | number;
  scoreB: bigint | number;
}

export function quantumPokerResultHash(
  result: QuantumPokerResultDescriptor
): Uint8Array {
  return blake2b256(
    concatBytes([
      enc.encode("sui_tunnel::quantum_poker::result"),
      u64ToBeBytes(result.handId),
      u64ToBeBytes(result.winner),
      u64ToBeBytes(result.partyABalance),
      u64ToBeBytes(result.partyBBalance),
      Uint8Array.from(result.board),
      Uint8Array.from(result.shownHoleA),
      Uint8Array.from(result.shownHoleB),
      u64ToBeBytes(result.scoreA),
      u64ToBeBytes(result.scoreB),
    ])
  );
}

export function tunnelIdHash(tunnelId: string | Uint8Array): Uint8Array {
  const bytes =
    typeof tunnelId === "string" ? addressToBytes32(tunnelId) : tunnelId;
  if (bytes.length !== 32) {
    throw new Error(`tunnel id bytes must be 32 bytes, got ${bytes.length}`);
  }
  return blake2b256(bytes);
}

export function buildQuantumPokerResultPublicInputs(
  statement: QuantumPokerResultStatement
): Uint8Array {
  return concatScalars([
    fieldSafeScalar(statement.rulesHash),
    hashToFieldSafeScalar(
      typeof statement.tunnelId === "string"
        ? addressToBytes32(statement.tunnelId)
        : statement.tunnelId
    ),
    fieldSafeScalar(statement.stateHash),
    u64ToScalar(statement.handId),
    u64ToScalar(statement.winner),
    u64ToScalar(statement.partyABalance),
    u64ToScalar(statement.partyBBalance),
    fieldSafeScalar(statement.resultHash),
  ]);
}

export class UnavailableQuantumPokerResultProver
  implements QuantumPokerResultProver
{
  readonly circuitName = QUANTUM_POKER_RESULT_CIRCUIT_NAME;

  async prove(
    _statement: QuantumPokerResultStatement,
    _witness: QuantumPokerResultWitness
  ): Promise<Uint8Array> {
    throw new Error(
      "quantum_poker_result Groth16 proving requires compiled circuit artifacts " +
        "and a trusted setup. This milestone ships public-input encoding and the " +
        "pluggable prover interface only."
    );
  }
}

export const QUANTUM_POKER_RESULT_CIRCOM = `pragma circom 2.1.0;
// Public inputs, in order:
//   rules_hash, tunnel_id_hash, state_hash, hand_id, winner,
//   party_a_balance, party_b_balance, result_hash
//
// This milestone circuit spec binds the result to the tunnel dispute state and
// settlement balances. Full card derivation proof is deferred because the live
// protocol uses blake2b mod-52 sampling; a deploy-time circuit can add Poseidon
// commitments behind the same public input schema.
template QuantumPokerResult() {
    signal input rulesHash;
    signal input tunnelIdHash;
    signal input stateHash;
    signal input handId;
    signal input winner;
    signal input partyABalance;
    signal input partyBBalance;
    signal input resultHash;

    // Placeholder constraints for deploy-time implementation.
    winner * (winner - 1) * (winner - 2) === 0;
}
component main { public [
  rulesHash,
  tunnelIdHash,
  stateHash,
  handId,
  winner,
  partyABalance,
  partyBBalance,
  resultHash
] } = QuantumPokerResult();`;
