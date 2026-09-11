/**
 * Enumerations shared across the rule engine and its consumers.
 *
 * These are plain frozen objects rather than a language-level enum
 * because the public API is JavaScript, not TypeScript. Consumers should
 * compare against these constants rather than hard-coding string literals.
 */

/**
 * The safety decision returned for a given transaction state.
 *
 * - SAFE_TO_RETRY: there is sufficient evidence that resubmitting will not
 *   cause harm (e.g. duplicate payment, loss of funds).
 * - DO_NOT_RETRY: retrying (or rebuilding and resubmitting) could cause
 *   harm, or the previous outcome cannot be distinguished from a state
 *   where harm is possible.
 * - RETRY_AFTER_ACTION: retrying may be safe, but only after the caller
 *   takes a specific corrective action (funding an account, waiting,
 *   rebuilding timebounds, etc.).
 * - UNKNOWN: the engine does not have a deterministic rule for this input,
 *   or the input does not contain enough information to decide.
 */
export const DECISION = Object.freeze({
  SAFE_TO_RETRY: "SAFE_TO_RETRY",
  DO_NOT_RETRY: "DO_NOT_RETRY",
  RETRY_AFTER_ACTION: "RETRY_AFTER_ACTION",
  UNKNOWN: "UNKNOWN",
});

/**
 * The category of risk associated with a decision, independent of the
 * decision itself. Two DO_NOT_RETRY results can carry different risks
 * (e.g. duplicate payment vs. unrecoverable configuration error).
 */
export const RISK = Object.freeze({
  DUPLICATE_PAYMENT: "DUPLICATE_PAYMENT",
  FUNDS_STUCK: "FUNDS_STUCK",
  CONFIGURATION_ISSUE: "CONFIGURATION_ISSUE",
  UNCERTAIN_SUBMISSION: "UNCERTAIN_SUBMISSION",
  NONE: "NONE",
  UNKNOWN: "UNKNOWN",
});

/**
 * How confident the engine is in the decision, given the evidence it was
 * provided. A rule that requires the caller to supply extra attestations
 * (e.g. "I already checked transaction history") should generally not
 * exceed "medium", since the engine cannot independently verify claims
 * about the outside world.
 */
export const CONFIDENCE = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
});

/** @type {ReadonlySet<string>} */
export const VALID_DECISIONS = new Set(Object.values(DECISION));

/** @type {ReadonlySet<string>} */
export const VALID_RISKS = new Set(Object.values(RISK));

/** @type {ReadonlySet<string>} */
export const VALID_CONFIDENCE_LEVELS = new Set(Object.values(CONFIDENCE));
