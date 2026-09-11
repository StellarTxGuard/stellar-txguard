import assert from "node:assert/strict";
import { test } from "node:test";

import { DECISION, RISK, evaluateRetrySafety } from "../src/index.js";

function evaluatePaymentFailure(operationResultCode, extra = {}) {
  return evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_failed",
    operationResultCodes: [operationResultCode],
    ...extra,
  });
}

const CONFIGURATION_CASES = [
  ["op_no_trust", DECISION.RETRY_AFTER_ACTION],
  ["op_src_no_trust", DECISION.RETRY_AFTER_ACTION],
  ["op_not_authorized", DECISION.RETRY_AFTER_ACTION],
  ["op_src_not_authorized", DECISION.RETRY_AFTER_ACTION],
  ["op_no_destination", DECISION.RETRY_AFTER_ACTION],
  ["op_line_full", DECISION.RETRY_AFTER_ACTION],
  ["op_no_issuer", DECISION.DO_NOT_RETRY],
  ["op_malformed", DECISION.DO_NOT_RETRY],
];

for (const [code, expectedDecision] of CONFIGURATION_CASES) {
  test(`${code}: decision is ${expectedDecision}, risk is CONFIGURATION_ISSUE`, () => {
    const result = evaluatePaymentFailure(code);

    assert.equal(result.decision, expectedDecision);
    assert.equal(result.risk, RISK.CONFIGURATION_ISSUE);
    assert.equal(result.reasonCode, code);
    assert.ok(result.evidence.length > 0);
    assert.ok(result.recommendedActions.length > 0);
    assert.ok(
      result.evidence.some((e) => /atomically/i.test(e)),
      "evidence should note that no funds moved due to atomicity",
    );
  });
}

const PATH_PAYMENT_CASES = [
  "op_too_few_offers",
  // Verified against stellar-horizon's codes package during the Milestone 3
  // audit: these are "op_cross_self" and "op_over_source_max", NOT
  // "op_offer_cross_self" / "op_over_send_max" as Milestone 2 had them.
  "op_cross_self",
  "op_over_source_max",
  "op_under_dest_min",
];

for (const code of PATH_PAYMENT_CASES) {
  test(`${code}: RETRY_AFTER_ACTION with risk NONE (no funds moved, market/path condition)`, () => {
    const result = evaluatePaymentFailure(code);

    assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
    assert.equal(result.risk, RISK.NONE);
    assert.equal(result.reasonCode, code);
    assert.ok(result.recommendedActions.length > 0);
  });
}

test("op_over_source_max and op_under_dest_min both call out re-quoting the price", () => {
  const overSourceMax = evaluatePaymentFailure("op_over_source_max");
  const underDestMin = evaluatePaymentFailure("op_under_dest_min");

  assert.ok(overSourceMax.recommendedActions.some((a) => /re-quote/i.test(a)));
  assert.ok(underDestMin.recommendedActions.some((a) => /re-quote/i.test(a)));
});

test("op_offer_cross_self and op_over_send_max (the old, incorrect names) are not recognized", () => {
  // These never appear in real Horizon output; guard against silently
  // reintroducing them and having them fall through to UNKNOWN unnoticed.
  const crossSelf = evaluatePaymentFailure("op_offer_cross_self");
  const overSendMax = evaluatePaymentFailure("op_over_send_max");

  assert.equal(crossSelf.decision, DECISION.UNKNOWN);
  assert.equal(overSendMax.decision, DECISION.UNKNOWN);
});

test("op_underfunded: retry after funding, FUNDS_STUCK risk", () => {
  const result = evaluatePaymentFailure("op_underfunded");

  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.FUNDS_STUCK);
  assert.ok(result.recommendedActions.some((a) => /fund/i.test(a)));
});

test("tx_failed with multiple operation results picks the first failing one", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_failed",
    operationResultCodes: ["op_success", "op_underfunded"],
  });

  assert.equal(result.reasonCode, "op_underfunded");
  assert.equal(result.risk, RISK.FUNDS_STUCK);
});

test("tx_failed with no operationResultCodes returns UNKNOWN, never guesses", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_failed",
  });

  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNKNOWN);
});

test("tx_failed with an unrecognized operation result code returns UNKNOWN", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_failed",
    operationResultCodes: ["op_some_future_code"],
  });

  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNKNOWN);
});

test("every payment failure result carries an explanation and recommended action", () => {
  const codes = [
    "op_no_trust",
    "op_src_no_trust",
    "op_not_authorized",
    "op_src_not_authorized",
    "op_no_destination",
    "op_underfunded",
    "op_line_full",
    "op_no_issuer",
    "op_malformed",
    "op_too_few_offers",
    "op_cross_self",
    "op_over_source_max",
    "op_under_dest_min",
  ];

  for (const code of codes) {
    const result = evaluatePaymentFailure(code);
    assert.notEqual(result.decision, undefined);
    assert.ok(result.summary.length > 0, `${code} should have a summary`);
    assert.ok(
      result.recommendedActions.length > 0,
      `${code} should have at least one recommended action`,
    );
    assert.notEqual(
      result.decision,
      "SAFE_TO_RETRY",
      `${code} should never be blindly treated as safe to retry`,
    );
  }
});
