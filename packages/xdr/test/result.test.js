import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decodeTransactionResultXdr, TxGuardXdrDecodeError } from "../src/index.js";

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/fixtures.json", import.meta.url)), "utf8"),
);

test("decodes a successful transaction", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.success);
  assert.equal(result.resultCode, "tx_success");
  assert.equal(result.feeBump, false);
  assert.deepEqual(result.operationResults, []);
  assert.equal(result.raw.resultXdr, fixtures.results.success);
});

test("decodes tx_bad_seq", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.bad_seq);
  assert.equal(result.resultCode, "tx_bad_seq");
});

test("decodes tx_insufficient_fee", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.insufficient_fee);
  assert.equal(result.resultCode, "tx_insufficient_fee");
});

test("decodes tx_insufficient_balance", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.insufficient_balance);
  assert.equal(result.resultCode, "tx_insufficient_balance");
});

test("decodes tx_no_account as tx_no_source_account (Horizon naming convention)", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.no_source_account);
  assert.equal(result.resultCode, "tx_no_source_account");
});

test("decodes a payment failure (op_no_trust)", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.payment_no_trust);
  assert.equal(result.resultCode, "tx_failed");
  assert.deepEqual(result.operationResults, ["op_no_trust"]);
});

test("decodes a payment failure (op_underfunded)", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.payment_underfunded);
  assert.deepEqual(result.operationResults, ["op_underfunded"]);
});

test("decodes path-payment offer_cross_self as op_cross_self, not op_offer_cross_self", async () => {
  const result = await decodeTransactionResultXdr(
    fixtures.results.path_payment_offer_cross_self,
  );
  assert.deepEqual(result.operationResults, ["op_cross_self"]);
});

test("decodes path-payment over_sendmax as op_over_source_max, not op_over_send_max", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.path_payment_over_sendmax);
  assert.deepEqual(result.operationResults, ["op_over_source_max"]);
});

test("decodes path-payment (strict send) under_destmin as op_under_dest_min", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.path_payment_under_destmin);
  assert.deepEqual(result.operationResults, ["op_under_dest_min"]);
});

test("unsupported operation type decodes without crashing, omitting the unmapped result", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.unsupported_operation);
  assert.equal(result.resultCode, "tx_failed");
  assert.deepEqual(result.operationResults, []);
});

test("decodes a successful fee-bump transaction", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.fee_bump_success);
  assert.equal(result.resultCode, "tx_fee_bump_inner_success");
  assert.equal(result.feeBump, true);
  assert.equal(result.innerResultCode, "tx_success");
});

test("decodes a failed fee-bump transaction (inner tx_bad_seq)", async () => {
  const result = await decodeTransactionResultXdr(fixtures.results.fee_bump_failed_bad_seq);
  assert.equal(result.resultCode, "tx_fee_bump_inner_failed");
  assert.equal(result.feeBump, true);
  assert.equal(result.innerResultCode, "tx_bad_seq");
});

test("decodes a failed fee-bump transaction (inner payment failure)", async () => {
  const result = await decodeTransactionResultXdr(
    fixtures.results.fee_bump_failed_payment_underfunded,
  );
  assert.equal(result.innerResultCode, "tx_failed");
  assert.deepEqual(result.innerOperationResults, ["op_underfunded"]);
});

test("malformed XDR throws TxGuardXdrDecodeError, never a guessed result", async () => {
  await assert.rejects(
    () => decodeTransactionResultXdr("not-valid-base64-xdr!!!"),
    TxGuardXdrDecodeError,
  );
});

test("truncated XDR throws TxGuardXdrDecodeError", async () => {
  await assert.rejects(() => decodeTransactionResultXdr("AAAAAAAAAA=="), TxGuardXdrDecodeError);
});

test("empty string throws TxGuardXdrDecodeError", async () => {
  await assert.rejects(() => decodeTransactionResultXdr(""), TxGuardXdrDecodeError);
});

test("XDR of the wrong type throws TxGuardXdrDecodeError", async () => {
  // A valid TransactionEnvelope is not a valid TransactionResult.
  await assert.rejects(
    () => decodeTransactionResultXdr(fixtures.envelopes.plain),
    TxGuardXdrDecodeError,
  );
});
