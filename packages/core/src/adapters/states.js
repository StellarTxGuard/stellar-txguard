/**
 * A coarse, human-labeled classification of a transaction's observed
 * network state, attached to a normalized object as `observedState`.
 *
 * This is informational only — `evaluateRetrySafety()` never reads it, it
 * decides purely from `transactionStatus` / `resultCode` /
 * `submissionStatus`. `observedState` exists so callers (logs, UIs,
 * debugging) don't have to reverse-engineer "was this confirmed, pending,
 * or genuinely unknown?" from the lower-level fields, and so adapters
 * never collapse these meaningfully different situations into a single
 * success/failure boolean.
 */
export const NORMALIZED_STATE = Object.freeze({
  CONFIRMED_SUCCESS: "CONFIRMED_SUCCESS",
  CONFIRMED_FAILURE: "CONFIRMED_FAILURE",
  PENDING: "PENDING",
  // stellar-rpc sendTransaction's DUPLICATE status: this exact envelope was
  // already submitted and is already known to the node. The *safety*
  // decision this produces is identical to PENDING (poll, do not resubmit)
  // — but the network signal itself is meaningfully different (a fresh
  // acceptance vs. recognizing a repeat), so it gets its own state rather
  // than being silently folded into PENDING. See evaluator.js's
  // `context.duplicateSubmission` handling.
  DUPLICATE: "DUPLICATE",
  NOT_FOUND: "NOT_FOUND",
  SUBMISSION_TIMEOUT: "SUBMISSION_TIMEOUT",
  UNKNOWN: "UNKNOWN",
});
