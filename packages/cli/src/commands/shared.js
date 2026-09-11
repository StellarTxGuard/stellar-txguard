/**
 * Shared helpers between `inspect` and `retry-safety` — both fetch a
 * transaction the same way and accept the same context flags. Neither
 * command reimplements the other's logic.
 */

import { describeSequenceError } from "@stellar-txguard/core";

const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Stellar transaction hashes are always exactly 64 hex characters (a
 * SHA-256 digest). Checking this before making a network request turns an
 * obviously-wrong hash into a clear, immediate usage error instead of a
 * confusing 404 or RPC error a request later.
 */
export function validateHash(hash) {
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(
      `"${hash}" is not a valid transaction hash (expected 64 hexadecimal characters).`,
    );
  }
}

export function resolveSource(args) {
  if (args.source) {
    if (args.source !== "horizon" && args.source !== "rpc") {
      throw new Error(`Unknown --source "${args.source}". Expected "horizon" or "rpc".`);
    }
    return args.source;
  }
  // rpcUrl without an explicit --source implies the user wants RPC.
  return args.rpcUrl && !args.horizonUrl ? "rpc" : "horizon";
}

/**
 * Builds the evaluator `context` fields the CLI exposes as flags. These
 * are all judgments only the caller can supply (see
 * `@stellar-txguard/core`'s `pickContext` docs) — the CLI never infers them.
 */
export function buildContextFromArgs(args) {
  const context = {};
  if (args.currentSequence !== undefined) {
    // Passed through as the exact string node:util.parseArgs gave us —
    // never Number(...): Stellar sequence numbers routinely exceed
    // Number.MAX_SAFE_INTEGER, and converting would silently round them.
    // Validated eagerly here (rather than left to evaluateRetrySafety())
    // so a bad value is rejected before any network request is made.
    const error = describeSequenceError(args.currentSequence);
    if (error) {
      throw new Error(`--current-sequence ${error}.`);
    }
    context.currentSequence = args.currentSequence;
  }
  if (args.verifiedNoPriorSuccess) {
    context.verifiedNoPriorSuccess = true;
  }
  if (args.movesFunds !== undefined) {
    context.movesFunds = args.movesFunds !== "false";
  }
  return context;
}
