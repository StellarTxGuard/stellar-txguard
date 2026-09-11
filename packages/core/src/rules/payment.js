import { CONFIDENCE, DECISION, RISK } from "../decisions.js";
import { buildResult } from "../evidence.js";

/**
 * Deterministic handlers for payment operation-level result codes.
 *
 * Stellar transactions are atomic: if any operation fails, none of the
 * transaction's operations take effect. This means a payment operation
 * failure, on its own, never moves funds — so these rules do not carry
 * DUPLICATE_PAYMENT risk. The risk instead comes from configuration
 * problems (trustlines, authorization, missing accounts) or from funds
 * being unavailable where the transaction expects them.
 */

function makeConfigurationIssueResult({
  reasonCode,
  summary,
  evidenceDetail,
  recommendedActions,
  decision = DECISION.RETRY_AFTER_ACTION,
  confidence = CONFIDENCE.HIGH,
}) {
  return buildResult({
    decision,
    risk: RISK.CONFIGURATION_ISSUE,
    reasonCode,
    confidence,
    summary,
    evidence: [evidenceDetail, "No funds were transferred, since the enclosing transaction failed atomically."],
    recommendedActions,
  });
}

const PAYMENT_RESULT_HANDLERS = {
  op_no_trust: (input) =>
    makeConfigurationIssueResult({
      reasonCode: "op_no_trust",
      summary:
        "The destination account does not have a trustline for the asset being sent.",
      evidenceDetail: "The operation returned op_no_trust.",
      recommendedActions: [
        "Confirm with the destination account holder that they establish a trustline for this asset.",
        "Do not resubmit until the destination's trustline exists.",
      ],
    }),

  op_src_no_trust: (input) =>
    makeConfigurationIssueResult({
      reasonCode: "op_src_no_trust",
      summary:
        "The source account does not have a trustline for the asset it is trying to send.",
      evidenceDetail: "The operation returned op_src_no_trust.",
      recommendedActions: [
        "Establish a trustline for the asset on the source account.",
        "Re-evaluate once the trustline exists before retrying.",
      ],
    }),

  op_not_authorized: (input) =>
    makeConfigurationIssueResult({
      reasonCode: "op_not_authorized",
      summary:
        "The destination account is not authorized to hold this asset (the issuer requires authorization).",
      evidenceDetail: "The operation returned op_not_authorized.",
      recommendedActions: [
        "Ask the asset issuer to authorize the destination account for this asset.",
        "Do not resubmit until authorization is confirmed.",
      ],
    }),

  op_src_not_authorized: (input) =>
    makeConfigurationIssueResult({
      reasonCode: "op_src_not_authorized",
      summary:
        "The source account is not authorized to hold or transfer this asset (the issuer requires authorization).",
      evidenceDetail: "The operation returned op_src_not_authorized.",
      recommendedActions: [
        "Ask the asset issuer to authorize the source account for this asset.",
        "Do not resubmit until authorization is confirmed.",
      ],
    }),

  op_no_destination: (input) =>
    makeConfigurationIssueResult({
      reasonCode: "op_no_destination",
      summary:
        "The destination account does not exist on the network.",
      evidenceDetail: "The operation returned op_no_destination.",
      recommendedActions: [
        "Confirm the destination address is correct.",
        "Create/fund the destination account (for example, via a createAccount operation) before retrying, or wait for it to be created.",
      ],
    }),

  op_underfunded: (input) =>
    buildResult({
      decision: DECISION.RETRY_AFTER_ACTION,
      risk: RISK.FUNDS_STUCK,
      reasonCode: "op_underfunded",
      confidence: CONFIDENCE.HIGH,
      summary:
        "The source account does not hold enough of the asset being sent to complete the payment.",
      evidence: [
        "The operation returned op_underfunded.",
        "No funds were transferred, since the enclosing transaction failed atomically.",
      ],
      recommendedActions: [
        "Fund the source account with sufficient balance of the asset being sent.",
        "Re-evaluate once the balance is sufficient before retrying.",
      ],
    }),

  op_line_full: (input) =>
    makeConfigurationIssueResult({
      reasonCode: "op_line_full",
      summary:
        "The destination account's trustline limit for this asset would be exceeded by this payment.",
      evidenceDetail: "The operation returned op_line_full.",
      recommendedActions: [
        "Ask the destination account holder to raise their trustline limit for this asset, or reduce their existing balance.",
        "Alternatively, reduce the payment amount so it fits within the destination's current trustline limit.",
      ],
    }),

  op_no_issuer: (input) =>
    makeConfigurationIssueResult({
      reasonCode: "op_no_issuer",
      decision: DECISION.DO_NOT_RETRY,
      summary:
        "The asset's issuer account does not exist on the network, so the asset itself cannot be valid as specified.",
      evidenceDetail: "The operation returned op_no_issuer.",
      recommendedActions: [
        "Verify the asset code and issuer address are correct.",
        "Do not resubmit the same operation until the asset definition is confirmed to be valid.",
      ],
    }),

  op_malformed: (input) =>
    makeConfigurationIssueResult({
      reasonCode: "op_malformed",
      decision: DECISION.DO_NOT_RETRY,
      summary:
        "The payment operation's parameters are invalid as constructed (for example, a negative or zero amount, or a malformed asset).",
      evidenceDetail: "The operation returned op_malformed.",
      recommendedActions: [
        "Review the operation's amount, asset, and destination fields for correctness.",
        "Do not resubmit the same operation unmodified; it will fail again for the same reason.",
      ],
    }),

  // Path-payment-specific result codes (PathPaymentStrictReceiveResultCode /
  // PathPaymentStrictSendResultCode). The trustline/authorization/account
  // codes above (op_no_trust, op_src_no_trust, op_not_authorized,
  // op_src_not_authorized, op_no_destination, op_underfunded, op_line_full,
  // op_no_issuer, op_malformed) are shared across Payment and both
  // path-payment operation types and apply identically here. The codes
  // below are unique to path payments: they reflect the state of the
  // offer book / requested price bounds at execution time, not account
  // configuration, so they carry risk NONE rather than
  // CONFIGURATION_ISSUE — retrying is not unsafe, it is simply pointless
  // until the underlying market condition changes.

  op_too_few_offers: (input) =>
    buildResult({
      decision: DECISION.RETRY_AFTER_ACTION,
      risk: RISK.NONE,
      reasonCode: "op_too_few_offers",
      confidence: CONFIDENCE.HIGH,
      summary:
        "No path of offers was found that could satisfy this path payment. No funds were transferred.",
      evidence: [
        "The operation returned op_too_few_offers.",
        "No funds were transferred, since the enclosing transaction failed atomically.",
      ],
      recommendedActions: [
        "Confirm a viable offer path exists for this asset pair before retrying (for example, by re-running path-finding).",
        "Consider adjusting the send/destination assets or amounts, or trying a different path.",
      ],
    }),

  // Horizon's string for PATH_PAYMENT_STRICT_{RECEIVE,SEND}_OFFER_CROSS_SELF
  // is "op_cross_self" (shared with ManageBuyOffer/ManageSellOffer's
  // identical CROSS_SELF code) — verified against
  // stellar-horizon/internal/codes/main.go. It is NOT "op_offer_cross_self".
  op_cross_self: (input) =>
    buildResult({
      decision: DECISION.RETRY_AFTER_ACTION,
      risk: RISK.NONE,
      reasonCode: "op_cross_self",
      confidence: CONFIDENCE.HIGH,
      summary:
        "The path payment would have crossed an offer already placed by the source account itself, which Stellar disallows. No funds were transferred.",
      evidence: [
        "The operation returned op_cross_self.",
        "No funds were transferred, since the enclosing transaction failed atomically.",
      ],
      recommendedActions: [
        "Cancel or adjust the source account's conflicting offer for this asset pair before retrying.",
        "Alternatively, choose a different path that avoids crossing the account's own offer.",
      ],
    }),

  // Horizon's string for PATH_PAYMENT_STRICT_RECEIVE_OVER_SENDMAX is
  // "op_over_source_max" — verified against stellar-horizon's codes
  // package. It is NOT "op_over_send_max".
  op_over_source_max: (input) =>
    buildResult({
      decision: DECISION.RETRY_AFTER_ACTION,
      risk: RISK.NONE,
      reasonCode: "op_over_source_max",
      confidence: CONFIDENCE.HIGH,
      summary:
        "The path would have required sending more of the source asset than the specified sendMax allows, most likely because the market price moved since the transaction was built. No funds were transferred.",
      evidence: [
        "The operation returned op_over_source_max.",
        "No funds were transferred, since the enclosing transaction failed atomically.",
      ],
      recommendedActions: [
        "Re-quote the path immediately before resubmitting, since the price may continue to move.",
        "Increase sendMax, or accept the currently available price, before retrying.",
      ],
    }),

  op_under_dest_min: (input) =>
    buildResult({
      decision: DECISION.RETRY_AFTER_ACTION,
      risk: RISK.NONE,
      reasonCode: "op_under_dest_min",
      confidence: CONFIDENCE.HIGH,
      summary:
        "The path would have delivered less of the destination asset than the specified destMin requires, most likely because the market price moved since the transaction was built. No funds were transferred.",
      evidence: [
        "The operation returned op_under_dest_min.",
        "No funds were transferred, since the enclosing transaction failed atomically.",
      ],
      recommendedActions: [
        "Re-quote the path immediately before resubmitting, since the price may continue to move.",
        "Lower destMin, or find a better path, before retrying.",
      ],
    }),
};

/**
 * Evaluates a payment operation-level result code.
 *
 * @param {string} operationResultCode
 * @param {object} input Normalized evaluator input.
 * @returns {import("../evidence.js").RetrySafetyResult | null} `null` if
 *   there is no deterministic rule for this result code.
 */
export function evaluatePaymentRule(operationResultCode, input) {
  const handler = PAYMENT_RESULT_HANDLERS[operationResultCode];
  return handler ? handler(input) : null;
}

/** @type {ReadonlySet<string>} Operation result codes with a deterministic handler. */
export const SUPPORTED_PAYMENT_RESULT_CODES = new Set(
  Object.keys(PAYMENT_RESULT_HANDLERS),
);
