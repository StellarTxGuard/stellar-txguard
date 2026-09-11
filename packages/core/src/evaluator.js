import { CONFIDENCE, DECISION, RISK } from "./decisions.js";
import { buildResult } from "./evidence.js";
import {
  evaluateFeeBumpRule,
  evaluatePaymentRule,
  evaluateTransactionRule,
  SUPPORTED_FEE_BUMP_RESULT_CODES,
} from "./rules/index.js";
import { describeSequenceError } from "./sequence.js";

/** `context` fields that must be canonical decimal-string sequence numbers. */
const SEQUENCE_CONTEXT_FIELDS = ["originalSequence", "currentSequence"];

/**
 * Thrown when the input to {@link evaluateRetrySafety} is structurally
 * invalid. This is distinct from an UNKNOWN decision: UNKNOWN means "the
 * input was understood but no deterministic rule applies", while this
 * error means "the input could not be understood at all". Callers should
 * fix the input rather than treat this as a safety signal.
 */
export class TxGuardValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TxGuardValidationError";
  }
}

const VALID_TRANSACTION_STATUSES = new Set(["SUCCESS", "FAILED", "PENDING"]);

/**
 * `submissionStatus` values recognized as an uncertain (not confirmed)
 * submission outcome:
 *
 * - `TIMEOUT`: the submission request itself did not complete.
 * - `NOT_FOUND`: the queried node has no record of the transaction. This
 *   does not mean it failed — it may still be propagating, or it may be
 *   outside the node's retention window (a common stellar-rpc
 *   `getTransaction` outcome).
 */
const VALID_SUBMISSION_STATUSES = new Set(["TIMEOUT", "NOT_FOUND"]);

const SUCCESS_RESULT_CODES = new Set(["tx_success", "tx_fee_bump_inner_success"]);

/**
 * Determines whether the input describes a submission whose outcome is
 * unknown (a network timeout, gateway error, or a node reporting the
 * transaction as not found) rather than a confirmed transaction result.
 *
 * @param {object} input
 * @returns {boolean}
 */
function isUncertainSubmission(input) {
  return (
    input.submissionStatus === "TIMEOUT" ||
    input.submissionStatus === "NOT_FOUND" ||
    input.httpStatus === 504 ||
    input.httpStatus === 502 ||
    input.httpStatus === 503
  );
}

/**
 * Validates the raw input shape. Throws {@link TxGuardValidationError} on
 * any structural problem, with a message describing what is wrong.
 *
 * @param {unknown} input
 */
function assertValidInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TxGuardValidationError(
      "evaluateRetrySafety() requires a non-null input object.",
    );
  }

  const {
    transactionStatus,
    resultCode,
    operationResultCodes,
    submissionStatus,
    httpStatus,
    transactionHash,
    context,
    isFeeBump,
    innerResultCode,
    innerOperationResultCodes,
    innerTransactionHash,
    feeBumpTransactionHash,
  } = input;

  if (
    submissionStatus !== undefined &&
    (typeof submissionStatus !== "string" || !VALID_SUBMISSION_STATUSES.has(submissionStatus))
  ) {
    throw new TxGuardValidationError(
      `Invalid submissionStatus "${submissionStatus}". Expected one of: ${[
        ...VALID_SUBMISSION_STATUSES,
      ].join(", ")}.`,
    );
  }
  if (httpStatus !== undefined && typeof httpStatus !== "number") {
    throw new TxGuardValidationError("httpStatus must be a number.");
  }
  if (transactionHash !== undefined && typeof transactionHash !== "string") {
    throw new TxGuardValidationError("transactionHash must be a string.");
  }
  if (
    operationResultCodes !== undefined &&
    (!Array.isArray(operationResultCodes) ||
      !operationResultCodes.every((code) => typeof code === "string"))
  ) {
    throw new TxGuardValidationError(
      "operationResultCodes must be an array of strings.",
    );
  }
  if (
    context !== undefined &&
    (context === null || typeof context !== "object" || Array.isArray(context))
  ) {
    throw new TxGuardValidationError("context must be an object.");
  }
  if (context !== undefined && context !== null && typeof context === "object") {
    for (const field of SEQUENCE_CONTEXT_FIELDS) {
      if (context[field] === undefined) continue;
      const sequenceError = describeSequenceError(context[field]);
      if (sequenceError) {
        throw new TxGuardValidationError(
          `context.${field} ${sequenceError}. Stellar sequence numbers routinely exceed Number.MAX_SAFE_INTEGER — pass them as a decimal string (e.g. "19801804984287233"), not a JavaScript number.`,
        );
      }
    }
  }
  if (isFeeBump !== undefined && typeof isFeeBump !== "boolean") {
    throw new TxGuardValidationError("isFeeBump must be a boolean.");
  }
  if (innerResultCode !== undefined && typeof innerResultCode !== "string") {
    throw new TxGuardValidationError("innerResultCode must be a string.");
  }
  if (
    innerOperationResultCodes !== undefined &&
    (!Array.isArray(innerOperationResultCodes) ||
      !innerOperationResultCodes.every((code) => typeof code === "string"))
  ) {
    throw new TxGuardValidationError(
      "innerOperationResultCodes must be an array of strings.",
    );
  }
  if (innerTransactionHash !== undefined && typeof innerTransactionHash !== "string") {
    throw new TxGuardValidationError("innerTransactionHash must be a string.");
  }
  if (feeBumpTransactionHash !== undefined && typeof feeBumpTransactionHash !== "string") {
    throw new TxGuardValidationError("feeBumpTransactionHash must be a string.");
  }

  if (isUncertainSubmission(input)) {
    // Uncertain submissions don't require a transactionStatus/resultCode,
    // since by definition the outcome was never confirmed.
    return;
  }

  if (transactionStatus === undefined || transactionStatus === null) {
    throw new TxGuardValidationError(
      "evaluateRetrySafety() requires transactionStatus, or submissionStatus: 'TIMEOUT'/'NOT_FOUND' (or an httpStatus of 502/503/504) for an unconfirmed submission.",
    );
  }
  if (!VALID_TRANSACTION_STATUSES.has(transactionStatus)) {
    throw new TxGuardValidationError(
      `Invalid transactionStatus "${transactionStatus}". Expected one of: ${[
        ...VALID_TRANSACTION_STATUSES,
      ].join(", ")}.`,
    );
  }

  if (transactionStatus === "PENDING") {
    // Nothing further to validate; PENDING is handled without a resultCode.
    return;
  }

  if (resultCode === undefined || resultCode === null || resultCode === "") {
    throw new TxGuardValidationError(
      `resultCode is required when transactionStatus is "${transactionStatus}".`,
    );
  }
  if (typeof resultCode !== "string") {
    throw new TxGuardValidationError("resultCode must be a string.");
  }
  if (transactionStatus === "SUCCESS" && !SUCCESS_RESULT_CODES.has(resultCode)) {
    throw new TxGuardValidationError(
      `transactionStatus "SUCCESS" is inconsistent with resultCode "${resultCode}" (expected one of: ${[
        ...SUCCESS_RESULT_CODES,
      ].join(", ")}).`,
    );
  }
  if (transactionStatus === "FAILED" && SUCCESS_RESULT_CODES.has(resultCode)) {
    throw new TxGuardValidationError(
      `transactionStatus "FAILED" is inconsistent with resultCode "${resultCode}".`,
    );
  }
}

function buildUncertainSubmissionResult(input) {
  const hasHash =
    typeof input.transactionHash === "string" && input.transactionHash.length > 0;
  const isNotFound = input.submissionStatus === "NOT_FOUND";
  // Gate on the presence of either fee-bump hash, not just the isFeeBump
  // flag: an adapter (or hand-built input) may supply the hashes without
  // remembering to also set isFeeBump, and the guidance to check both
  // hashes is correct either way.
  const isFeeBump =
    input.isFeeBump === true ||
    Boolean(input.feeBumpTransactionHash) ||
    Boolean(input.innerTransactionHash);

  const evidence = [];
  if (input.submissionStatus === "TIMEOUT") {
    evidence.push("The submission reported a TIMEOUT status.");
  } else if (isNotFound) {
    evidence.push(
      "The queried node reported the transaction as NOT_FOUND. This can mean it has not yet propagated to that node, or that it falls outside the node's retention window — it does not mean the transaction failed.",
    );
  }
  if (typeof input.httpStatus === "number") {
    evidence.push(`The submission attempt returned HTTP status ${input.httpStatus}.`);
  }
  evidence.push(
    hasHash
      ? `A transaction hash (${input.transactionHash}) is available to look up the actual outcome.`
      : "No transaction hash was provided, which limits the ability to verify what actually happened.",
  );
  if (isFeeBump) {
    evidence.push(
      "This submission was a fee-bump transaction; both the fee-bump hash and the inner transaction hash should be checked, since either may have reached the ledger.",
    );
  }

  const lookupAction = isNotFound
    ? "Query a different node, or wait and re-query the same node, since NOT_FOUND does not rule out later inclusion."
    : "Look up the transaction by hash on Horizon or RPC to determine its actual outcome before doing anything else.";

  return buildResult({
    decision: DECISION.UNKNOWN,
    risk: RISK.UNCERTAIN_SUBMISSION,
    reasonCode: isNotFound
      ? "not_found"
      : input.submissionStatus === "TIMEOUT"
        ? "submission_timeout"
        : `http_${input.httpStatus}`,
    confidence: CONFIDENCE.LOW,
    summary: isNotFound
      ? "The transaction could not be found by the queried node. This does not confirm failure — it may still be propagating, or the node's retention window may not cover it."
      : "The request timed out or the gateway failed before a definitive response was received. The transaction may or may not have been applied to the ledger — this is not the same as a confirmed failure.",
    evidence,
    recommendedActions: hasHash
      ? [
          lookupAction,
          "Do not submit a new transaction for the same intent until the original transaction's status is confirmed.",
          "If the transaction is not found after allowing time for ledger closure, check the source account's current sequence number to determine whether it was applied.",
        ]
      : [
          "Check the source account's recent transactions and current sequence number to determine whether the submission was applied.",
          "Do not submit a new transaction for the same intent until the original submission's outcome is confirmed.",
        ],
  });
}

function buildPendingResult(input) {
  const isDuplicate = input.context?.duplicateSubmission === true;

  return buildResult({
    decision: DECISION.UNKNOWN,
    risk: RISK.UNCERTAIN_SUBMISSION,
    reasonCode: isDuplicate ? "tx_pending_duplicate" : "tx_pending",
    confidence: CONFIDENCE.LOW,
    summary: isDuplicate
      ? "The transaction has not yet reached a final state. The node recognized this submission as a duplicate of one it already knows about, so this call did not create a new attempt."
      : "The transaction has not yet reached a final state. Its outcome is not yet known.",
    evidence: isDuplicate
      ? [
          "transactionStatus was reported as PENDING.",
          "The submission was flagged as a duplicate of a transaction already known to the node (e.g. stellar-rpc sendTransaction status DUPLICATE) — not a fresh acceptance.",
        ]
      : ["transactionStatus was reported as PENDING."],
    recommendedActions: [
      "Poll for the transaction's final status before deciding whether to retry.",
      "Do not submit a new transaction for the same intent while the original is still pending.",
    ],
  });
}

function buildUnknownResultCodeResult(input, note) {
  return buildResult({
    decision: DECISION.UNKNOWN,
    risk: RISK.UNKNOWN,
    reasonCode: input.resultCode ?? "unknown",
    confidence: CONFIDENCE.LOW,
    summary: note,
    evidence: [note],
    recommendedActions: [
      "Manually investigate the transaction result before retrying.",
      "Do not assume retrying is safe without further evidence.",
    ],
  });
}

/**
 * Evaluates whether it is safe to retry a Stellar transaction, given its
 * current known state.
 *
 * This function is deterministic: the same input always produces the same
 * output, and no network or I/O access occurs. If the input does not
 * contain enough information to reach a confident decision, the result's
 * decision will be UNKNOWN rather than a guess.
 *
 * Inputs are typically produced by the `adapters/` in this package
 * (`normalizeHorizonTransaction`, `normalizeRpcTransaction`) rather than
 * constructed by hand, but the shape below is stable and safe to build
 * directly.
 *
 * @param {object} input
 * @param {"SUCCESS"|"FAILED"|"PENDING"} [input.transactionStatus] The
 *   confirmed status of the transaction. Omit only when describing an
 *   uncertain submission (see submissionStatus/httpStatus below).
 * @param {string} [input.resultCode] The Stellar transaction result code
 *   (e.g. "tx_success", "tx_bad_seq"). Required when transactionStatus is
 *   SUCCESS or FAILED.
 * @param {string[]} [input.operationResultCodes] Per-operation result
 *   codes (e.g. ["op_underfunded"]), used when resultCode is "tx_failed".
 * @param {"TIMEOUT"|"NOT_FOUND"} [input.submissionStatus] Set when the
 *   submission's outcome could not be confirmed (as opposed to a
 *   confirmed transaction result).
 * @param {number} [input.httpStatus] The HTTP status of the submission
 *   attempt, if relevant (e.g. 504).
 * @param {string} [input.transactionHash] The transaction hash, if known.
 * @param {boolean} [input.isFeeBump] Whether this transaction was
 *   submitted as a fee-bump transaction.
 * @param {string} [input.innerResultCode] The inner transaction's own
 *   result code, required to evaluate resultCode "tx_fee_bump_inner_failed".
 * @param {string[]} [input.innerOperationResultCodes] The inner
 *   transaction's operation result codes, used when innerResultCode is
 *   "tx_failed".
 * @param {string} [input.innerTransactionHash] The inner transaction's hash.
 * @param {string} [input.feeBumpTransactionHash] The fee-bump envelope's hash.
 * @param {object} [input.context] Additional evidence relevant to specific
 *   rules (account sequence numbers, timebounds, prior verification, etc).
 * @param {string} [input.context.originalSequence] The sequence number the
 *   submitted transaction used, as a canonical decimal string (e.g.
 *   `"19801804984287233"`) — **not** a JavaScript number. Stellar sequence
 *   numbers are 64-bit and routinely exceed `Number.MAX_SAFE_INTEGER`;
 *   see `sequence.js` for why and `compareSequences()`/`isValidSequence()`
 *   if you need to work with one yourself.
 * @param {string} [input.context.currentSequence] The account's current
 *   sequence number, as a canonical decimal string. Same rule as above.
 * @returns {import("./evidence.js").RetrySafetyResult}
 */
export function evaluateRetrySafety(input) {
  assertValidInput(input);

  if (isUncertainSubmission(input)) {
    return buildUncertainSubmissionResult(input);
  }

  if (input.transactionStatus === "PENDING") {
    return buildPendingResult(input);
  }

  const normalized = {
    ...input,
    context: input.context ?? {},
  };

  if (SUPPORTED_FEE_BUMP_RESULT_CODES.has(normalized.resultCode)) {
    return evaluateFeeBumpRule(normalized);
  }

  if (normalized.resultCode === "tx_failed") {
    const codes = normalized.operationResultCodes ?? [];
    const failingCode = codes.find((code) => code !== "op_success");
    if (failingCode) {
      const opResult = evaluatePaymentRule(failingCode, normalized);
      if (opResult) {
        return opResult;
      }
      return buildUnknownResultCodeResult(
        normalized,
        `The transaction failed at the operation level with result code "${failingCode}", which is not yet recognized by any deterministic rule.`,
      );
    }
    return buildUnknownResultCodeResult(
      normalized,
      'The transaction returned "tx_failed" but no recognized operationResultCodes were provided, so the specific cause is unknown.',
    );
  }

  const txResult = evaluateTransactionRule(normalized);
  if (txResult) {
    return txResult;
  }

  return buildUnknownResultCodeResult(
    normalized,
    `The transaction result code "${normalized.resultCode}" is not recognized by any deterministic rule.`,
  );
}
