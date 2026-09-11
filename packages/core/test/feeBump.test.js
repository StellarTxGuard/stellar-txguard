import assert from "node:assert/strict";
import { test } from "node:test";

import { DECISION, RISK, evaluateRetrySafety } from "../src/index.js";

test("successful fee bump: DO_NOT_RETRY, DUPLICATE_PAYMENT risk", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "SUCCESS",
    resultCode: "tx_fee_bump_inner_success",
    isFeeBump: true,
    feeBumpTransactionHash: "feebump-hash",
    innerTransactionHash: "inner-hash",
  });

  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.DUPLICATE_PAYMENT);
  assert.ok(result.evidence.some((e) => /inner transaction was applied/i.test(e)));
});

test("failed fee bump: inner tx_insufficient_balance delegates correctly", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_fee_bump_inner_failed",
    isFeeBump: true,
    innerResultCode: "tx_insufficient_balance",
    feeBumpTransactionHash: "feebump-hash",
    innerTransactionHash: "inner-hash",
  });

  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.FUNDS_STUCK);
  assert.equal(result.reasonCode, "tx_insufficient_balance");
  assert.ok(result.evidence.some((e) => /fee-bump envelope itself reached consensus/i.test(e)));
  assert.ok(result.evidence.some((e) => e.includes("feebump-hash")));
  assert.ok(result.evidence.some((e) => e.includes("inner-hash")));
});

test("fee-bump submission uncertainty: timeout checks both hashes, never assumes failure", () => {
  const result = evaluateRetrySafety({
    submissionStatus: "TIMEOUT",
    isFeeBump: true,
    feeBumpTransactionHash: "feebump-hash",
    innerTransactionHash: "inner-hash",
  });

  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNCERTAIN_SUBMISSION);
  assert.ok(
    result.evidence.some((e) => /fee-bump hash and the inner transaction hash should be checked/i.test(e)),
  );
});

test("inner transaction failure: tx_bad_seq delegates with DUPLICATE_PAYMENT risk preserved", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_fee_bump_inner_failed",
    innerResultCode: "tx_bad_seq",
    context: { originalSequence: "10", currentSequence: "12" },
  });

  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.DUPLICATE_PAYMENT);
  assert.equal(result.reasonCode, "tx_bad_seq");
});

test("inner transaction failure at operation level: op_underfunded delegates via payment rules", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_fee_bump_inner_failed",
    innerResultCode: "tx_failed",
    innerOperationResultCodes: ["op_success", "op_underfunded"],
  });

  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.FUNDS_STUCK);
  assert.equal(result.reasonCode, "op_underfunded");
});

test("unknown fee-bump state: tx_fee_bump_inner_failed without innerResultCode returns UNKNOWN", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_fee_bump_inner_failed",
  });

  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNKNOWN);
  assert.ok(result.evidence.some((e) => /no innerResultCode was provided/i.test(e)));
});

test("unknown fee-bump state: unrecognized innerResultCode returns UNKNOWN, never guesses", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_fee_bump_inner_failed",
    innerResultCode: "tx_some_future_code",
  });

  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNKNOWN);
});
