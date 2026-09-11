import { CONFIDENCE, DECISION, RISK } from "../decisions.js";
import { buildResult } from "../evidence.js";
import { evaluatePaymentRule } from "./payment.js";
import { evaluateTransactionRule } from "./transaction.js";

/**
 * Deterministic handlers for fee-bump transaction result codes.
 *
 * A fee-bump transaction (CAP-15) wraps an "inner" transaction with a new
 * fee and fee source. When a fee-bump transaction is submitted, Stellar
 * reports the OUTER envelope's result as one of two codes:
 *
 * - `tx_fee_bump_inner_success`: the fee bump was accepted and its inner
 *   transaction was applied.
 * - `tx_fee_bump_inner_failed`: the fee bump was accepted, but its inner
 *   transaction failed. The inner transaction's own result code (and, if
 *   relevant, its operation result codes) describe what actually happened
 *   and are required to reach a safety decision — this module never infers
 *   them.
 *
 * Other outer-envelope failures (e.g. the fee-bump itself was rejected for
 * `tx_insufficient_fee` or `tx_no_source_account`, before the inner
 * transaction was ever considered) use the ordinary transaction-level
 * result codes and are handled by `evaluateTransactionRule`, not this
 * module — from a safety standpoint they behave the same whether or not a
 * fee bump was involved, since the inner transaction never ran.
 */

function handleFeeBumpInnerSuccess(input) {
  const movesFunds = input.context?.movesFunds !== false;
  const evidence = [
    "The fee-bump transaction returned tx_fee_bump_inner_success: the inner transaction was applied to the ledger.",
  ];
  if (input.feeBumpTransactionHash) {
    evidence.push(`Fee-bump transaction hash: ${input.feeBumpTransactionHash}.`);
  }
  if (input.innerTransactionHash) {
    evidence.push(`Inner transaction hash: ${input.innerTransactionHash}.`);
  }

  return buildResult({
    decision: DECISION.DO_NOT_RETRY,
    risk: movesFunds ? RISK.DUPLICATE_PAYMENT : RISK.NONE,
    reasonCode: "tx_fee_bump_inner_success",
    confidence: CONFIDENCE.HIGH,
    summary:
      "This was submitted as a fee-bump transaction, and its inner transaction succeeded. Submitting a new transaction for the same intent would repeat its effects.",
    evidence,
    recommendedActions: movesFunds
      ? [
          "Treat the inner transaction's operations as complete; do not resubmit them.",
          "If the caller is uncertain why a retry was considered, confirm the application state reflects the inner transaction's effects before doing anything else.",
        ]
      : ["Treat the inner transaction as complete; do not resubmit it."],
  });
}

function handleFeeBumpInnerFailed(input) {
  const { innerResultCode, innerOperationResultCodes, innerTransactionHash, feeBumpTransactionHash } =
    input;

  if (typeof innerResultCode !== "string" || innerResultCode.length === 0) {
    return buildResult({
      decision: DECISION.UNKNOWN,
      risk: RISK.UNKNOWN,
      reasonCode: "tx_fee_bump_inner_failed",
      confidence: CONFIDENCE.LOW,
      summary:
        "This was submitted as a fee-bump transaction and its inner transaction failed, but no innerResultCode was provided, so the specific cause is unknown.",
      evidence: [
        "The fee-bump transaction returned tx_fee_bump_inner_failed.",
        "No innerResultCode was provided describing why the inner transaction failed.",
      ],
      recommendedActions: [
        "Look up the inner transaction's own result code before deciding how to proceed.",
        "Do not assume retrying is safe without further evidence.",
      ],
    });
  }

  let inner;
  if (innerResultCode === "tx_failed") {
    const codes = innerOperationResultCodes ?? [];
    const failingCode = codes.find((code) => code !== "op_success");
    inner = failingCode ? evaluatePaymentRule(failingCode, input) : null;
  } else {
    inner = evaluateTransactionRule({ ...input, resultCode: innerResultCode });
  }

  const feeBumpEvidence = [
    "This was submitted as a fee-bump transaction; the fee-bump envelope itself reached consensus, but its inner transaction failed.",
  ];
  if (feeBumpTransactionHash) {
    feeBumpEvidence.push(`Fee-bump transaction hash: ${feeBumpTransactionHash}.`);
  }
  if (innerTransactionHash) {
    feeBumpEvidence.push(`Inner transaction hash: ${innerTransactionHash}.`);
  }

  if (!inner) {
    return buildResult({
      decision: DECISION.UNKNOWN,
      risk: RISK.UNKNOWN,
      reasonCode: innerResultCode,
      confidence: CONFIDENCE.LOW,
      summary: `This was submitted as a fee-bump transaction. Its inner transaction failed with result code "${innerResultCode}", which is not recognized by any deterministic rule.`,
      evidence: [
        ...feeBumpEvidence,
        `The inner transaction's result code was "${innerResultCode}".`,
      ],
      recommendedActions: [
        "Manually investigate the inner transaction's result before retrying.",
        "Do not assume retrying is safe without further evidence.",
      ],
    });
  }

  return buildResult({
    ...inner,
    evidence: [...feeBumpEvidence, ...inner.evidence],
  });
}

const FEE_BUMP_RESULT_HANDLERS = {
  tx_fee_bump_inner_success: handleFeeBumpInnerSuccess,
  tx_fee_bump_inner_failed: handleFeeBumpInnerFailed,
};

/**
 * Evaluates a fee-bump transaction's outer result code.
 *
 * @param {object} input Normalized evaluator input.
 * @returns {import("../evidence.js").RetrySafetyResult | null} `null` if
 *   `input.resultCode` is not a fee-bump result code.
 */
export function evaluateFeeBumpRule(input) {
  const handler = FEE_BUMP_RESULT_HANDLERS[input.resultCode];
  return handler ? handler(input) : null;
}

/** @type {ReadonlySet<string>} Fee-bump result codes with a deterministic handler. */
export const SUPPORTED_FEE_BUMP_RESULT_CODES = new Set(
  Object.keys(FEE_BUMP_RESULT_HANDLERS),
);
