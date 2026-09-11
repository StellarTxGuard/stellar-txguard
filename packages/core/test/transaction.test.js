import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DECISION,
  RISK,
  evaluateRetrySafety,
  TxGuardValidationError,
} from "../src/index.js";

test("tx_success: already succeeded, do not retry, duplicate payment risk by default", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "SUCCESS",
    resultCode: "tx_success",
  });

  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.DUPLICATE_PAYMENT);
  assert.equal(result.reasonCode, "tx_success");
  assert.ok(result.evidence.length > 0);
  assert.ok(result.recommendedActions.length > 0);
});

test("tx_success: risk is NONE when the operation does not move funds", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "SUCCESS",
    resultCode: "tx_success",
    context: { movesFunds: false },
  });

  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.NONE);
});

test("tx_bad_seq: defaults to DO_NOT_RETRY with duplicate payment risk", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_bad_seq",
    context: {
      originalSequence: "123",
      currentSequence: "125",
    },
  });

  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.DUPLICATE_PAYMENT);
  assert.equal(result.reasonCode, "tx_bad_seq");
  assert.ok(
    result.evidence.some((e) => e.includes("125")),
    "evidence should reference the current sequence",
  );
  assert.ok(
    result.recommendedActions.some((a) => /recent transactions/i.test(a)),
  );
});

test("tx_bad_seq: without sequence context still defaults to DO_NOT_RETRY", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_bad_seq",
  });

  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.confidence, "high");
});

test("tx_bad_seq: SAFE_TO_RETRY only when caller attests no prior success", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_bad_seq",
    context: {
      originalSequence: "123",
      currentSequence: "125",
      verifiedNoPriorSuccess: true,
    },
  });

  assert.equal(result.decision, DECISION.SAFE_TO_RETRY);
  assert.equal(result.risk, RISK.NONE);
  assert.equal(result.confidence, "medium");
});

test("tx_insufficient_fee: retry after action, no duplicate risk", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_insufficient_fee",
  });

  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.NONE);
  assert.ok(result.recommendedActions.some((a) => /fee/i.test(a)));
});

test("tx_insufficient_balance: retry after funding, FUNDS_STUCK risk", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_insufficient_balance",
  });

  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.FUNDS_STUCK);
  assert.ok(result.recommendedActions.some((a) => /fund/i.test(a)));
});

test("tx_too_early: retry after waiting", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_too_early",
    context: { minTime: 1000, currentTime: 900 },
  });

  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.ok(result.recommendedActions.some((a) => /wait/i.test(a)));
});

test("tx_too_late: retry after rebuilding timebounds", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_too_late",
    context: { maxTime: 1000, currentTime: 1100 },
  });

  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.ok(result.recommendedActions.some((a) => /timebounds/i.test(a)));
});

test("tx_no_source_account: do not retry until account exists", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_no_source_account",
  });

  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.CONFIGURATION_ISSUE);
  assert.ok(result.recommendedActions.some((a) => /create|fund/i.test(a)));
});

test("tx_bad_auth: retry after adding required signatures, no duplicate risk", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_bad_auth",
  });

  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.NONE);
  assert.ok(result.recommendedActions.some((a) => /signature/i.test(a)));
});

test("tx_bad_auth_extra: retry after removing invalid signatures", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_bad_auth_extra",
  });

  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.NONE);
  assert.ok(result.recommendedActions.some((a) => /signature/i.test(a)));
});

test("tx_missing_operation: do not retry the same empty envelope", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_missing_operation",
  });

  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.CONFIGURATION_ISSUE);
  assert.ok(result.recommendedActions.some((a) => /at least one operation/i.test(a)));
});

test("tx_failed_undecoded: UNKNOWN, recommends decoding XDR rather than guessing", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_failed_undecoded",
  });

  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNKNOWN);
  assert.ok(result.recommendedActions.some((a) => /decode/i.test(a)));
});

test("rpc_try_again_later: retry after backoff, no duplicate risk since nothing was queued", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "rpc_try_again_later",
  });

  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.NONE);
});

test("submissionStatus NOT_FOUND: UNKNOWN, distinct evidence from TIMEOUT", () => {
  const result = evaluateRetrySafety({
    submissionStatus: "NOT_FOUND",
    transactionHash: "abcd1234",
  });

  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNCERTAIN_SUBMISSION);
  assert.equal(result.reasonCode, "not_found");
  assert.ok(result.evidence.some((e) => /NOT_FOUND/.test(e)));
  assert.ok(!result.evidence.some((e) => /TIMEOUT/.test(e)));
});

test("malformed input: invalid submissionStatus throws", () => {
  assert.throws(
    () => evaluateRetrySafety({ submissionStatus: "SOMETHING_ELSE" }),
    TxGuardValidationError,
  );
});

test("unknown transaction result code returns UNKNOWN, never guesses", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_some_future_code_not_yet_supported",
  });

  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNKNOWN);
});

test("PENDING transaction status returns UNKNOWN and advises against retry", () => {
  const result = evaluateRetrySafety({ transactionStatus: "PENDING" });

  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.ok(result.recommendedActions.some((a) => /poll|pending/i.test(a)));
});

test("timeout submission (submissionStatus): does not recommend a fresh transaction", () => {
  const result = evaluateRetrySafety({
    submissionStatus: "TIMEOUT",
    transactionHash: "abcd1234",
  });

  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNCERTAIN_SUBMISSION);
  assert.ok(result.recommendedActions.some((a) => /look up/i.test(a)));
  assert.ok(
    result.recommendedActions.some((a) => /do not submit a new transaction/i.test(a)),
  );
});

test("HTTP 504 without a hash: still checks status first, notes missing hash", () => {
  const result = evaluateRetrySafety({ httpStatus: 504 });

  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNCERTAIN_SUBMISSION);
  assert.ok(result.evidence.some((e) => /no transaction hash/i.test(e)));
  assert.ok(result.recommendedActions.some((a) => /sequence number/i.test(a)));
});

test("missing context on tx_bad_seq does not crash and stays conservative", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_bad_seq",
    context: {},
  });

  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
});

test("malformed input: null throws TxGuardValidationError", () => {
  assert.throws(() => evaluateRetrySafety(null), TxGuardValidationError);
});

test("malformed input: array throws TxGuardValidationError", () => {
  assert.throws(() => evaluateRetrySafety([]), TxGuardValidationError);
});

test("malformed input: missing transactionStatus and no submission info throws", () => {
  assert.throws(
    () => evaluateRetrySafety({ resultCode: "tx_bad_seq" }),
    TxGuardValidationError,
  );
});

test("malformed input: invalid transactionStatus throws", () => {
  assert.throws(
    () =>
      evaluateRetrySafety({
        transactionStatus: "NOT_A_REAL_STATUS",
        resultCode: "tx_success",
      }),
    TxGuardValidationError,
  );
});

test("malformed input: FAILED without resultCode throws", () => {
  assert.throws(
    () => evaluateRetrySafety({ transactionStatus: "FAILED" }),
    TxGuardValidationError,
  );
});

test("malformed input: SUCCESS with mismatched resultCode throws", () => {
  assert.throws(
    () =>
      evaluateRetrySafety({
        transactionStatus: "SUCCESS",
        resultCode: "tx_bad_seq",
      }),
    TxGuardValidationError,
  );
});

test("malformed input: FAILED with resultCode tx_success throws", () => {
  assert.throws(
    () =>
      evaluateRetrySafety({
        transactionStatus: "FAILED",
        resultCode: "tx_success",
      }),
    TxGuardValidationError,
  );
});

test("malformed input: non-object context throws", () => {
  assert.throws(
    () =>
      evaluateRetrySafety({
        transactionStatus: "FAILED",
        resultCode: "tx_bad_seq",
        context: "not-an-object",
      }),
    TxGuardValidationError,
  );
});

test("malformed input: non-array operationResultCodes throws", () => {
  assert.throws(
    () =>
      evaluateRetrySafety({
        transactionStatus: "FAILED",
        resultCode: "tx_failed",
        operationResultCodes: "op_underfunded",
      }),
    TxGuardValidationError,
  );
});
