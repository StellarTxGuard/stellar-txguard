import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DECISION,
  RISK,
  evaluateRetrySafety,
  normalizeRpcTransaction,
  TxGuardAdapterError,
} from "../src/index.js";

function loadFixture(name) {
  const path = fileURLToPath(new URL(`./fixtures/rpc/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

test("RPC pipeline: getTransaction SUCCESS -> DO_NOT_RETRY / DUPLICATE_PAYMENT", () => {
  const normalized = normalizeRpcTransaction(loadFixture("get_success.json"), {
    transactionHash: "abc123",
  });

  assert.equal(normalized.transactionStatus, "SUCCESS");
  assert.equal(normalized.resultCode, "tx_success");

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.DUPLICATE_PAYMENT);
});

test("RPC pipeline: getTransaction SUCCESS with feeBump -> tx_fee_bump_inner_success", () => {
  const normalized = normalizeRpcTransaction(loadFixture("get_fee_bump_success.json"));

  assert.equal(normalized.resultCode, "tx_fee_bump_inner_success");
  assert.equal(normalized.isFeeBump, true);

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
});

test("RPC pipeline: getTransaction NOT_FOUND -> UNKNOWN / UNCERTAIN_SUBMISSION, not a confirmed failure", () => {
  const fixture = loadFixture("get_not_found.json");
  // No options.transactionHash supplied — stellar-rpc always echoes back
  // txHash itself, even for NOT_FOUND, so the adapter should pick it up
  // without the caller needing to pass it separately.
  const normalized = normalizeRpcTransaction(fixture);

  assert.equal(normalized.transactionHash, fixture.txHash);
  assert.equal(normalized.submissionStatus, "NOT_FOUND");
  assert.equal(normalized.transactionStatus, undefined);

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNCERTAIN_SUBMISSION);
  assert.equal(result.reasonCode, "not_found");
  assert.ok(
    !result.recommendedActions.some((a) => /submit a new transaction for the same intent/i.test(a) && !/do not/i.test(a)),
  );
});

test("RPC pipeline: getTransaction FAILED without a decoded code -> UNKNOWN, never guesses", () => {
  const normalized = normalizeRpcTransaction(loadFixture("get_failed.json"));

  assert.equal(normalized.resultCode, "tx_failed_undecoded");

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.UNKNOWN);
});

test("RPC pipeline: sendTransaction PENDING -> UNKNOWN, do not resubmit", () => {
  const normalized = normalizeRpcTransaction(loadFixture("send_pending.json"));

  assert.equal(normalized.transactionStatus, "PENDING");

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.ok(result.recommendedActions.some((a) => /poll|pending/i.test(a)));
});

test("RPC pipeline: sendTransaction DUPLICATE -> same safety decision as PENDING, but distinguishable", () => {
  const normalized = normalizeRpcTransaction(loadFixture("send_duplicate.json"));

  // Same decision-relevant dispatch as PENDING (poll, don't resubmit)...
  assert.equal(normalized.transactionStatus, "PENDING");
  // ...but NOT collapsed into indistinguishable output: this is how a
  // caller (or evaluateRetrySafety's evidence) can tell a fresh acceptance
  // apart from "the node already knew about this exact submission."
  assert.equal(normalized.observedState, "DUPLICATE");
  assert.equal(normalized.context.duplicateSubmission, true);

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.reasonCode, "tx_pending_duplicate");
  assert.ok(result.evidence.some((e) => /duplicate/i.test(e)));
});

test("RPC pipeline: sendTransaction PENDING (not a duplicate) does not carry duplicate evidence", () => {
  const normalized = normalizeRpcTransaction(loadFixture("send_pending.json"));
  assert.equal(normalized.context.duplicateSubmission, undefined);

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.reasonCode, "tx_pending");
  assert.ok(!result.evidence.some((e) => /duplicate/i.test(e)));
});

test("RPC pipeline: sendTransaction TRY_AGAIN_LATER -> RETRY_AFTER_ACTION, no duplicate risk", () => {
  const normalized = normalizeRpcTransaction(loadFixture("send_try_again_later.json"));

  assert.equal(normalized.resultCode, "rpc_try_again_later");

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.NONE);
});

test("RPC pipeline: sendTransaction ERROR -> UNKNOWN unless a decoded code is supplied", () => {
  const normalized = normalizeRpcTransaction(loadFixture("send_error.json"));
  assert.equal(normalized.resultCode, "tx_failed_undecoded");
  assert.equal(evaluateRetrySafety(normalized).decision, DECISION.UNKNOWN);
  // errorResultXdr and diagnosticEventsXdr are preserved raw for future use.
  assert.ok(normalized.raw.errorResultXdr);
  assert.ok(normalized.raw.diagnosticEventsXdr);

  const decoded = normalizeRpcTransaction(loadFixture("send_error.json"), {
    resultCode: "tx_bad_auth",
  });
  const result = evaluateRetrySafety(decoded);
  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.reasonCode, "tx_bad_auth");
});

test("RPC adapter: rejects an unrecognized status", () => {
  assert.throws(
    () => normalizeRpcTransaction({ status: "SOMETHING_ELSE" }),
    TxGuardAdapterError,
  );
});

test("RPC adapter: rejects a null response", () => {
  assert.throws(() => normalizeRpcTransaction(null), TxGuardAdapterError);
});
