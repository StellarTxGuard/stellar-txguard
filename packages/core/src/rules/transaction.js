import { CONFIDENCE, DECISION, RISK } from "../decisions.js";
import { buildResult } from "../evidence.js";
import { compareSequences } from "../sequence.js";

/**
 * Deterministic handlers for Stellar transaction-level result codes.
 *
 * Each handler receives the normalized input and returns a
 * {@link import("../evidence.js").RetrySafetyResult}. Handlers must not
 * perform any I/O and must not guess: if the available context is
 * insufficient to reach a confident decision, they fall back to the most
 * conservative applicable decision rather than assuming safety.
 */

function handleTxSuccess(input) {
  const movesFunds = input.context?.movesFunds !== false;
  return buildResult({
    decision: DECISION.DO_NOT_RETRY,
    risk: movesFunds ? RISK.DUPLICATE_PAYMENT : RISK.NONE,
    reasonCode: "tx_success",
    confidence: CONFIDENCE.HIGH,
    summary:
      "The transaction already succeeded. Submitting a new transaction for the same intent would repeat its effects.",
    evidence: ["The transaction result code was tx_success."],
    recommendedActions: movesFunds
      ? [
          "Treat the underlying operation as complete; do not resubmit it.",
          "If the caller is uncertain why a retry was considered, confirm the application state reflects this transaction's effects before doing anything else.",
        ]
      : [
          "Treat the transaction as complete; do not resubmit it.",
        ],
  });
}

function handleTxBadSeq(input) {
  const { originalSequence, currentSequence, verifiedNoPriorSuccess } =
    input.context ?? {};

  // originalSequence/currentSequence are canonical decimal strings (never
  // JavaScript numbers — see sequence.js for why); evaluateRetrySafety()'s
  // input validation already guarantees that by the time a rule runs, so
  // a plain typeof check is enough here without re-validating format.
  const hasSequenceEvidence =
    typeof originalSequence === "string" && typeof currentSequence === "string";

  if (verifiedNoPriorSuccess === true) {
    const evidence = [
      "The original transaction returned tx_bad_seq, meaning it was not applied to the ledger under the submitted sequence number.",
      "The caller has attested that transaction history for the source account was checked and no prior submission for this intent succeeded.",
    ];
    if (hasSequenceEvidence) {
      evidence.push(
        `The account sequence has advanced from ${originalSequence} to ${currentSequence}.`,
      );
    }
    return buildResult({
      decision: DECISION.SAFE_TO_RETRY,
      risk: RISK.NONE,
      reasonCode: "tx_bad_seq",
      confidence: CONFIDENCE.MEDIUM,
      summary:
        "The submitted sequence number is stale, but the caller has verified no prior submission for this intent succeeded, so rebuilding with the current sequence number should be safe.",
      evidence,
      recommendedActions: [
        "Rebuild the transaction using the account's current sequence number.",
        "Keep a record of the new transaction hash in case its status also becomes uncertain later.",
      ],
    });
  }

  const evidence = [
    "The original transaction returned tx_bad_seq, meaning the submitted sequence number did not match the account's expected sequence number.",
  ];
  if (hasSequenceEvidence) {
    evidence.push(
      compareSequences(currentSequence, originalSequence) > 0
        ? `The account sequence has advanced beyond the submitted sequence (submitted ${originalSequence}, current ${currentSequence}), which is consistent with another transaction having been applied.`
        : `The account sequence (${currentSequence}) does not exceed the submitted sequence (${originalSequence}).`,
    );
  } else {
    evidence.push(
      "No current account sequence number was provided, so it is not possible to tell whether another transaction was applied in the meantime.",
    );
  }

  return buildResult({
    decision: DECISION.DO_NOT_RETRY,
    risk: RISK.DUPLICATE_PAYMENT,
    reasonCode: "tx_bad_seq",
    confidence: CONFIDENCE.HIGH,
    summary:
      "The transaction sequence is no longer current. Rebuilding and resubmitting without first confirming what happened to prior submissions could cause a duplicate payment.",
    evidence,
    recommendedActions: [
      "Check recent transactions and effects for the source account.",
      "Verify whether the intended payment already succeeded under a different submission.",
      "Do not construct a new transaction for the same intent until the previous submission's outcome is understood.",
    ],
  });
}

function handleTxInsufficientFee(input) {
  const { currentSequence, originalSequence } = input.context ?? {};
  const evidence = [
    "The transaction returned tx_insufficient_fee: the offered fee was too low for the network's current fee requirements.",
    "No funds were transferred, since the transaction was not included in a ledger.",
  ];
  if (typeof originalSequence === "string" && typeof currentSequence === "string") {
    evidence.push(
      `The account sequence at submission time (${originalSequence}) ${
        compareSequences(currentSequence, originalSequence) === 0 ? "matches" : "differs from"
      } the current sequence (${currentSequence}).`,
    );
  }

  return buildResult({
    decision: DECISION.RETRY_AFTER_ACTION,
    risk: RISK.NONE,
    reasonCode: "tx_insufficient_fee",
    confidence: CONFIDENCE.HIGH,
    summary:
      "The transaction was rejected for an insufficient fee before being included in a ledger. Increasing the fee should resolve this, but the transaction's current state should be confirmed first.",
    evidence,
    recommendedActions: [
      "Confirm the transaction was not separately included in a ledger under a race condition before rebuilding it.",
      "Increase the fee and resubmit, or submit a fee-bump transaction wrapping the original envelope.",
      "Confirm the account's current sequence number matches what the new submission expects.",
    ],
  });
}

function handleTxInsufficientBalance(input) {
  return buildResult({
    decision: DECISION.RETRY_AFTER_ACTION,
    risk: RISK.FUNDS_STUCK,
    reasonCode: "tx_insufficient_balance",
    confidence: CONFIDENCE.HIGH,
    summary:
      "The source account does not hold enough native balance to cover the transaction's amount and fees. No funds were transferred.",
    evidence: [
      "The transaction returned tx_insufficient_balance.",
    ],
    recommendedActions: [
      "Fund the source account with sufficient XLM to cover the transaction's operations and fees.",
      "Re-evaluate the transaction once the account is funded before retrying.",
    ],
  });
}

function handleTxTooEarly(input) {
  const { minTime, currentTime } = input.context ?? {};
  const evidence = ["The transaction returned tx_too_early: the ledger closing time is before the transaction's minimum time bound."];
  if (minTime !== undefined && currentTime !== undefined) {
    evidence.push(`Minimum time bound: ${minTime}. Time at submission: ${currentTime}.`);
  }
  return buildResult({
    decision: DECISION.RETRY_AFTER_ACTION,
    risk: RISK.NONE,
    reasonCode: "tx_too_early",
    confidence: CONFIDENCE.HIGH,
    summary:
      "The transaction cannot be applied until its minimum time bound is reached. No funds were transferred.",
    evidence,
    recommendedActions: [
      "Wait until the transaction's minimum time bound (minTime) is reached, then resubmit the same envelope.",
    ],
  });
}

function handleTxTooLate(input) {
  const { maxTime, currentTime } = input.context ?? {};
  const evidence = ["The transaction returned tx_too_late: the ledger closing time is after the transaction's maximum time bound."];
  if (maxTime !== undefined && currentTime !== undefined) {
    evidence.push(`Maximum time bound: ${maxTime}. Time at submission: ${currentTime}.`);
  }
  return buildResult({
    decision: DECISION.RETRY_AFTER_ACTION,
    risk: RISK.NONE,
    reasonCode: "tx_too_late",
    confidence: CONFIDENCE.HIGH,
    summary:
      "The transaction's timebounds have expired, so it can never be applied in its current form. No funds were transferred.",
    evidence,
    recommendedActions: [
      "Rebuild the transaction with valid (future) timebounds.",
      "Resubmit the rebuilt transaction using the account's current sequence number.",
    ],
  });
}

function handleTxNoSourceAccount(input) {
  return buildResult({
    decision: DECISION.DO_NOT_RETRY,
    risk: RISK.CONFIGURATION_ISSUE,
    reasonCode: "tx_no_source_account",
    confidence: CONFIDENCE.HIGH,
    summary:
      "The transaction's source account does not exist on the network, so it cannot be applied. No funds were transferred.",
    evidence: ["The transaction returned tx_no_source_account."],
    recommendedActions: [
      "Create and fund the source account on the network.",
      "Do not resubmit until the account exists, then re-evaluate before retrying.",
    ],
  });
}

function handleTxBadAuth(input) {
  return buildResult({
    decision: DECISION.RETRY_AFTER_ACTION,
    risk: RISK.NONE,
    reasonCode: "tx_bad_auth",
    confidence: CONFIDENCE.HIGH,
    summary:
      "The transaction did not carry enough valid signatures to meet the source account's signing threshold, so it was rejected before being included in a ledger. No funds were transferred.",
    evidence: ["The transaction returned tx_bad_auth."],
    recommendedActions: [
      "Add the missing signature(s) from the account's authorized signers to meet its signing threshold.",
      "Resubmit the transaction once it is properly signed.",
    ],
  });
}

function handleTxBadAuthExtra(input) {
  return buildResult({
    decision: DECISION.RETRY_AFTER_ACTION,
    risk: RISK.NONE,
    reasonCode: "tx_bad_auth_extra",
    confidence: CONFIDENCE.HIGH,
    summary:
      "The transaction envelope carried a signature that does not correspond to a valid signer for the source account, so it was rejected before being included in a ledger. No funds were transferred.",
    evidence: ["The transaction returned tx_bad_auth_extra."],
    recommendedActions: [
      "Remove any signatures that do not correspond to the source account's actual signers.",
      "Re-sign the transaction using only valid signers and resubmit.",
    ],
  });
}

function handleTxMissingOperation(input) {
  return buildResult({
    decision: DECISION.DO_NOT_RETRY,
    risk: RISK.CONFIGURATION_ISSUE,
    reasonCode: "tx_missing_operation",
    confidence: CONFIDENCE.HIGH,
    summary:
      "The transaction contained no operations, which is never valid. No funds were transferred, and resubmitting the same empty envelope will fail again for the same reason.",
    evidence: ["The transaction returned tx_missing_operation."],
    recommendedActions: [
      "Rebuild the transaction with at least one operation.",
      "Do not resubmit the empty transaction unmodified.",
    ],
  });
}

/**
 * `tx_failed_undecoded` is not a real Stellar/XDR result code. It is a
 * StellarTxGuard-specific marker that adapters use when a network response
 * confirms the transaction did not succeed, but only supplies raw,
 * undecoded XDR (`result_xdr` / `resultXdr`) rather than a decoded result
 * code — for example, a Horizon `GET /transactions/{hash}` record with
 * `successful: false`, or a stellar-rpc `getTransaction` response with
 * `status: "FAILED"`. StellarTxGuard does not decode XDR, so this always
 * resolves to UNKNOWN rather than guessing at the underlying cause.
 */
function handleTxFailedUndecoded(input) {
  return buildResult({
    decision: DECISION.UNKNOWN,
    risk: RISK.UNKNOWN,
    reasonCode: "tx_failed_undecoded",
    confidence: CONFIDENCE.LOW,
    summary:
      "The transaction failed, but the response only included raw, undecoded result data. StellarTxGuard does not decode XDR, so the specific cause cannot be determined automatically.",
    evidence: [
      "The transaction was reported as unsuccessful.",
      "No decoded transaction- or operation-level result code was available in the data provided.",
    ],
    recommendedActions: [
      "Decode the transaction's result XDR (for example, with a Stellar SDK) to determine the specific result code, then re-evaluate with that code.",
      "Do not assume retrying is safe without understanding why the transaction failed — a stale sequence number, in particular, can indicate a prior submission already succeeded.",
    ],
  });
}

/**
 * `rpc_try_again_later` is not an XDR `TransactionResultCode`. It is a
 * StellarTxGuard marker for stellar-rpc's `sendTransaction` status
 * `TRY_AGAIN_LATER`, which means the node's transaction queue declined to
 * accept the submission at all due to backpressure — the transaction was
 * never queued or processed, unlike a ledger-level failure.
 */
function handleRpcTryAgainLater(input) {
  return buildResult({
    decision: DECISION.RETRY_AFTER_ACTION,
    risk: RISK.NONE,
    reasonCode: "rpc_try_again_later",
    confidence: CONFIDENCE.HIGH,
    summary:
      "The RPC node declined to accept the submission because its transaction queue was busy (TRY_AGAIN_LATER); the transaction was never queued or processed. No funds were transferred, and no submission is in flight.",
    evidence: [
      "The submission attempt returned stellar-rpc sendTransaction status TRY_AGAIN_LATER.",
    ],
    recommendedActions: [
      "Wait briefly and resubmit the same transaction envelope.",
      "If TRY_AGAIN_LATER persists, back off further before retrying again.",
    ],
  });
}

/** @type {Record<string, (input: object) => import("../evidence.js").RetrySafetyResult>} */
const TRANSACTION_RESULT_HANDLERS = {
  tx_success: handleTxSuccess,
  tx_bad_seq: handleTxBadSeq,
  tx_insufficient_fee: handleTxInsufficientFee,
  tx_insufficient_balance: handleTxInsufficientBalance,
  tx_too_early: handleTxTooEarly,
  tx_too_late: handleTxTooLate,
  tx_no_source_account: handleTxNoSourceAccount,
  tx_bad_auth: handleTxBadAuth,
  tx_bad_auth_extra: handleTxBadAuthExtra,
  tx_missing_operation: handleTxMissingOperation,
  tx_failed_undecoded: handleTxFailedUndecoded,
  rpc_try_again_later: handleRpcTryAgainLater,
};

/**
 * Evaluates a transaction-level result code.
 *
 * @param {object} input Normalized evaluator input.
 * @returns {import("../evidence.js").RetrySafetyResult | null} `null` if
 *   there is no deterministic rule for this result code.
 */
export function evaluateTransactionRule(input) {
  const handler = TRANSACTION_RESULT_HANDLERS[input.resultCode];
  return handler ? handler(input) : null;
}

/** @type {ReadonlySet<string>} Result codes with a deterministic handler. */
export const SUPPORTED_TRANSACTION_RESULT_CODES = new Set(
  Object.keys(TRANSACTION_RESULT_HANDLERS),
);
