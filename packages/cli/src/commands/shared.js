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
 *
 * The thrown message always names the value that was received and why it
 * was rejected, so a typo is diagnosable without guessing.
 */
export function validateHash(hash) {
  if (typeof hash === "string" && HASH_PATTERN.test(hash)) {
    return;
  }

  const received = JSON.stringify(hash);
  let reason;
  if (typeof hash !== "string") {
    reason = `expected a string of 64 hexadecimal characters, received ${typeof hash}`;
  } else if (hash.length !== 64) {
    reason = `expected exactly 64 hexadecimal characters, received ${hash.length}`;
  } else {
    reason = "expected only hexadecimal characters (0-9, a-f)";
  }
  throw new Error(`${received} is not a valid transaction hash (${reason}).`);
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
      throw new Error(
        `--current-sequence received ${JSON.stringify(args.currentSequence)}: ${error}.`,
      );
    }
    context.currentSequence = args.currentSequence;
  }
  if (args.verifiedNoPriorSuccess) {
    context.verifiedNoPriorSuccess = true;
  }
  if (args.movesFunds !== undefined) {
    if (args.movesFunds !== "true" && args.movesFunds !== "false") {
      throw new Error(
        `--moves-funds received ${JSON.stringify(args.movesFunds)}: expected "true" or "false".`,
      );
    }
    context.movesFunds = args.movesFunds === "true";
  }
  return context;
}
