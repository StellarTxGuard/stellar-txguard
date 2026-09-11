import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DECISION,
  RISK,
  evaluateRetrySafety,
  normalizeHorizonTransaction,
  TxGuardAdapterError,
} from "../src/index.js";

function loadFixture(name) {
  const path = fileURLToPath(new URL(`./fixtures/horizon/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

test("Horizon pipeline: successful transaction -> DO_NOT_RETRY / DUPLICATE_PAYMENT", () => {
  const normalized = normalizeHorizonTransaction(loadFixture("success.json"));

  assert.equal(normalized.transactionStatus, "SUCCESS");
  assert.equal(normalized.resultCode, "tx_success");
  assert.equal(normalized.observedState, "CONFIRMED_SUCCESS");

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.DUPLICATE_PAYMENT);
});

test("Horizon pipeline: tx_bad_seq submission failure -> DO_NOT_RETRY / DUPLICATE_PAYMENT", () => {
  const normalized = normalizeHorizonTransaction(loadFixture("failed_bad_seq.json"));

  assert.equal(normalized.transactionStatus, "FAILED");
  assert.equal(normalized.resultCode, "tx_bad_seq");

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.DUPLICATE_PAYMENT);
});

test("Horizon pipeline: tx_bad_seq is SAFE_TO_RETRY once currentSequence + verification are supplied", () => {
  const normalized = normalizeHorizonTransaction(loadFixture("failed_bad_seq.json"), {
    currentSequence: "999",
    verifiedNoPriorSuccess: true,
  });

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.SAFE_TO_RETRY);
});

test("Horizon pipeline: op_no_trust payment failure -> RETRY_AFTER_ACTION / CONFIGURATION_ISSUE", () => {
  const normalized = normalizeHorizonTransaction(loadFixture("failed_payment_no_trust.json"));

  assert.equal(normalized.resultCode, "tx_failed");
  assert.deepEqual(normalized.operationResultCodes, ["op_no_trust"]);

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.CONFIGURATION_ISSUE);
  assert.equal(result.reasonCode, "op_no_trust");
});

test("Horizon pipeline: undecoded GET failure -> UNKNOWN, never guesses", () => {
  const normalized = normalizeHorizonTransaction(loadFixture("failed_undecoded.json"));

  assert.equal(normalized.resultCode, "tx_failed_undecoded");
  assert.equal(normalized.context.originalSequence, "4611686018427388020");
  assert.equal(
    typeof normalized.context.originalSequence,
    "string",
    "sequence numbers must be strings, never a JavaScript number (see sequence.js)",
  );

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.risk, RISK.UNKNOWN);
});

test("Horizon pipeline: undecoded GET failure honors a caller-supplied decoded resultCode", () => {
  const normalized = normalizeHorizonTransaction(loadFixture("failed_undecoded.json"), {
    resultCode: "tx_insufficient_fee",
  });

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.reasonCode, "tx_insufficient_fee");
});

test("Horizon pipeline: successful fee-bump transaction -> DO_NOT_RETRY / DUPLICATE_PAYMENT", () => {
  const normalized = normalizeHorizonTransaction(loadFixture("fee_bump_success.json"));

  assert.equal(normalized.resultCode, "tx_fee_bump_inner_success");
  assert.equal(normalized.isFeeBump, true);
  assert.ok(normalized.feeBumpTransactionHash);
  assert.ok(normalized.innerTransactionHash);

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.DUPLICATE_PAYMENT);
});

test("Horizon pipeline: failed fee-bump (inner tx_insufficient_balance) -> RETRY_AFTER_ACTION / FUNDS_STUCK", () => {
  const normalized = normalizeHorizonTransaction(loadFixture("fee_bump_failed.json"));

  assert.equal(normalized.resultCode, "tx_fee_bump_inner_failed");
  assert.equal(normalized.innerResultCode, "tx_insufficient_balance");

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.FUNDS_STUCK);
  assert.equal(result.reasonCode, "tx_insufficient_balance");
  assert.ok(result.evidence.some((e) => /fee-bump/i.test(e)));
});

// --- POST /transactions_async (note the underscore, not a hyphen — the
// real registered Horizon route; verified against stellar-horizon's own
// router.go during the Milestone 4 audit) ---

test("Horizon async: PENDING -> UNKNOWN, do not resubmit (fresh acceptance)", () => {
  const normalized = normalizeHorizonTransaction(loadFixture("async_pending.json"));

  assert.equal(normalized.transactionStatus, "PENDING");
  assert.equal(normalized.observedState, "PENDING");
  assert.equal(normalized.context.duplicateSubmission, undefined);

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.reasonCode, "tx_pending");
  assert.ok(result.recommendedActions.some((a) => /poll|pending/i.test(a)));
  assert.ok(
    result.recommendedActions.some((a) => /do not submit a new transaction/i.test(a)),
    "must not tell the caller to create a new transaction merely because submission is unresolved",
  );
});

test("Horizon async: DUPLICATE -> same decision as PENDING, but distinguishable", () => {
  const normalized = normalizeHorizonTransaction(loadFixture("async_duplicate.json"));

  assert.equal(normalized.transactionStatus, "PENDING");
  assert.equal(normalized.observedState, "DUPLICATE");
  assert.equal(normalized.context.duplicateSubmission, true);

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.equal(result.reasonCode, "tx_pending_duplicate");
  assert.ok(result.evidence.some((e) => /duplicate/i.test(e)));
});

test("Horizon async: TRY_AGAIN_LATER -> RETRY_AFTER_ACTION, no duplicate-payment risk", () => {
  const normalized = normalizeHorizonTransaction(loadFixture("async_try_again_later.json"));

  assert.equal(normalized.resultCode, "rpc_try_again_later");

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.NONE);
});

test("Horizon async: ERROR -> UNKNOWN by default, transaction hash preserved as evidence", () => {
  const fixture = loadFixture("async_error.json");
  const normalized = normalizeHorizonTransaction(fixture);

  assert.equal(normalized.resultCode, "tx_failed_undecoded");
  assert.equal(normalized.transactionHash, fixture.hash);
  assert.equal(normalized.raw.errorResultXdr, fixture.error_result_xdr);

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.UNKNOWN);
  assert.notEqual(
    result.decision,
    "SAFE_TO_RETRY",
    "an unresolved async ERROR must never be presented as safe to retry",
  );
});

test("Horizon async: ERROR resolves to a real code when xdrDecoder is supplied (real Horizon doc example)", async () => {
  const { decodeTransactionResultXdr } = await import("@stellar-txguard/xdr");
  const fixture = loadFixture("async_error.json");

  // async submission responses never echo back result_xdr under that name —
  // only error_result_xdr — so it must be routed in as options.resultCode's
  // source manually here; there is nothing in the response shape itself for
  // applyXdrDecoder to find under raw.resultXdr. Decode it directly and
  // confirm it's the tx_bad_seq this official example actually encodes.
  const decoded = await decodeTransactionResultXdr(fixture.error_result_xdr);
  assert.equal(decoded.resultCode, "tx_bad_seq");

  const normalized = normalizeHorizonTransaction(fixture, { resultCode: decoded.resultCode });
  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.equal(result.risk, RISK.DUPLICATE_PAYMENT);
});

test("Horizon async: envelopeXdr option lets sequence context flow through an ERROR response", async () => {
  const { decodeTransactionResultXdr, decodeTransactionEnvelopeXdr } = await import(
    "@stellar-txguard/xdr"
  );
  const xdrFixtures = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../xdr/test/fixtures/fixtures.json", import.meta.url)),
      "utf8",
    ),
  );
  const fixture = loadFixture("async_error.json");

  const normalized = await normalizeHorizonTransaction(fixture, {
    resultCode: "tx_bad_seq",
    envelopeXdr: xdrFixtures.envelopes.plain,
    xdrDecoder: { decodeTransactionResultXdr, decodeTransactionEnvelopeXdr },
  });

  assert.equal(normalized.context.originalSequence, "4611686018427388001");
  // handleTxBadSeq only cites the sequence numbers in evidence once BOTH
  // originalSequence and currentSequence are known; only the former came
  // from envelope decoding here, so evidence correctly still says a
  // current sequence is needed rather than fabricating one.
  const result = evaluateRetrySafety(normalized);
  assert.ok(result.evidence.some((e) => /no current account sequence number/i.test(e)));
});

test("Horizon async: malformed-request problem response is a request error, not a transaction state", () => {
  assert.throws(
    () => normalizeHorizonTransaction(loadFixture("async_malformed_request.json")),
    (err) => {
      assert.ok(err instanceof TxGuardAdapterError);
      assert.match(err.message, /transaction_malformed/);
      return true;
    },
  );
});

test("Horizon async: Horizon-Core communication failure is not modeled as a transaction state", () => {
  assert.throws(
    () => normalizeHorizonTransaction(loadFixture("async_submission_failed.json")),
    (err) => {
      assert.ok(err instanceof TxGuardAdapterError);
      assert.match(err.message, /transaction_submission_failed/);
      return true;
    },
  );
});

test("Horizon adapter: rejects an unrecognized response shape", () => {
  assert.throws(
    () => normalizeHorizonTransaction({ some: "unrelated shape" }),
    TxGuardAdapterError,
  );
});

test("Horizon adapter: rejects a null response", () => {
  assert.throws(() => normalizeHorizonTransaction(null), TxGuardAdapterError);
});
