// This is the one test file in @stellar-txguard/core that imports
// @stellar-txguard/xdr — it is a devDependency only (see package.json),
// used exclusively to prove the opt-in `options.xdrDecoder` wiring in the
// adapters actually works end-to-end against a real decoder. Nothing in
// src/ imports @stellar-txguard/xdr; the core package remains
// dependency-free at runtime.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decodeTransactionEnvelopeXdr, decodeTransactionResultXdr } from "@stellar-txguard/xdr";

import {
  DECISION,
  RISK,
  evaluateRetrySafety,
  normalizeHorizonTransaction,
  normalizeRpcTransaction,
} from "../src/index.js";

const xdrFixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../xdr/test/fixtures/fixtures.json", import.meta.url)),
    "utf8",
  ),
);

const xdrDecoder = { decodeTransactionResultXdr };
const fullXdrDecoder = { decodeTransactionResultXdr, decodeTransactionEnvelopeXdr };

test("normalizeHorizonTransaction returns a plain object (not a Promise) when no xdrDecoder is given", () => {
  const result = normalizeHorizonTransaction({
    id: "x",
    hash: "x",
    successful: false,
    ledger: 1,
    source_account_sequence: "1",
    envelope_xdr: "x",
    result_xdr: xdrFixtures.results.bad_seq,
  });
  assert.equal(typeof result.then, "undefined");
  assert.equal(result.resultCode, "tx_failed_undecoded");
});

test("normalizeHorizonTransaction + xdrDecoder resolves tx_failed_undecoded into a real code", async () => {
  const normalizedPromise = normalizeHorizonTransaction(
    {
      id: "x",
      hash: "x",
      successful: false,
      ledger: 1,
      source_account_sequence: "1",
      envelope_xdr: "x",
      result_xdr: xdrFixtures.results.bad_seq,
    },
    { xdrDecoder },
  );

  assert.equal(typeof normalizedPromise.then, "function");
  const normalized = await normalizedPromise;
  assert.equal(normalized.resultCode, "tx_bad_seq");

  const decision = evaluateRetrySafety(normalized);
  assert.equal(decision.decision, DECISION.DO_NOT_RETRY);
  assert.equal(decision.risk, RISK.DUPLICATE_PAYMENT);
});

test("normalizeHorizonTransaction + xdrDecoder resolves a payment failure with operation codes", async () => {
  const normalized = await normalizeHorizonTransaction(
    {
      id: "x",
      hash: "x",
      successful: false,
      ledger: 1,
      result_xdr: xdrFixtures.results.payment_no_trust,
    },
    { xdrDecoder },
  );

  assert.equal(normalized.resultCode, "tx_failed");
  assert.deepEqual(normalized.operationResultCodes, ["op_no_trust"]);

  const decision = evaluateRetrySafety(normalized);
  assert.equal(decision.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(decision.risk, RISK.CONFIGURATION_ISSUE);
});

test("normalizeHorizonTransaction + xdrDecoder resolves a fee-bump failure end-to-end", async () => {
  const normalized = await normalizeHorizonTransaction(
    {
      id: "x",
      hash: "x",
      successful: false,
      ledger: 1,
      result_xdr: xdrFixtures.results.fee_bump_failed_bad_seq,
    },
    { xdrDecoder },
  );

  assert.equal(normalized.resultCode, "tx_fee_bump_inner_failed");
  assert.equal(normalized.isFeeBump, true);
  assert.equal(normalized.innerResultCode, "tx_bad_seq");

  const decision = evaluateRetrySafety(normalized);
  assert.equal(decision.decision, DECISION.DO_NOT_RETRY);
  assert.equal(decision.risk, RISK.DUPLICATE_PAYMENT);
  assert.equal(decision.reasonCode, "tx_bad_seq");
});

test("normalizeRpcTransaction + xdrDecoder resolves a getTransaction FAILED response", async () => {
  const normalized = await normalizeRpcTransaction(
    {
      status: "FAILED",
      txHash: "x",
      resultXdr: xdrFixtures.results.insufficient_balance,
    },
    { xdrDecoder },
  );

  assert.equal(normalized.resultCode, "tx_insufficient_balance");

  const decision = evaluateRetrySafety(normalized);
  assert.equal(decision.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(decision.risk, RISK.FUNDS_STUCK);
});

test("an already-decoded resultCode (options.resultCode) takes priority over xdrDecoder", async () => {
  // options.resultCode already means "don't fall back to tx_failed_undecoded",
  // so xdrDecoder is never even consulted here.
  const normalized = await normalizeHorizonTransaction(
    {
      id: "x",
      hash: "x",
      successful: false,
      ledger: 1,
      result_xdr: xdrFixtures.results.bad_seq,
    },
    { resultCode: "tx_missing_operation", xdrDecoder },
  );

  assert.equal(normalized.resultCode, "tx_missing_operation");
});

test("xdrDecoder is a no-op when the response already carries a decoded resultCode", async () => {
  // Horizon's submission-error body always has a decoded code — xdrDecoder
  // should never be invoked, and no Promise-vs-object surprise should occur.
  const result = normalizeHorizonTransaction(
    {
      status: 400,
      extras: { result_codes: { transaction: "tx_bad_seq" } },
    },
    { xdrDecoder },
  );
  // Still a Promise (xdrDecoder was supplied), but resolves immediately
  // without ever calling the decoder.
  const resolved = await result;
  assert.equal(resolved.resultCode, "tx_bad_seq");
});

// --- Envelope decoding (decodeTransactionEnvelopeXdr wired via xdrDecoder) ---

test("envelope decoding fills sequence + timebounds context when nothing else supplies them", async () => {
  const normalized = await normalizeHorizonTransaction(
    {
      status: 400,
      extras: {
        envelope_xdr: xdrFixtures.envelopes.with_time_bounds,
        result_codes: { transaction: "tx_bad_seq" },
      },
    },
    { xdrDecoder: fullXdrDecoder, now: 1750000000 },
  );

  // A submission-error body has no source_account_sequence /
  // preconditions.timebounds fields at all — this context can only have
  // come from decoding the envelope.
  assert.equal(normalized.context.originalSequence, "4611686018427388050");
  assert.deepEqual(
    { minTime: normalized.context.minTime, maxTime: normalized.context.maxTime },
    { minTime: 1700000000, maxTime: 1800000000 },
  );
  assert.equal(normalized.context.currentTime, 1750000000);
});

test("envelope decoding never overrides an explicit options value", async () => {
  const normalized = await normalizeHorizonTransaction(
    {
      status: 400,
      extras: {
        envelope_xdr: xdrFixtures.envelopes.with_time_bounds,
        result_codes: { transaction: "tx_bad_seq" },
      },
    },
    { xdrDecoder: fullXdrDecoder, originalSequence: "42", minTime: 1, maxTime: 2, currentTime: 3 },
  );

  assert.equal(normalized.context.originalSequence, "42");
  assert.equal(normalized.context.minTime, 1);
  assert.equal(normalized.context.maxTime, 2);
  assert.equal(normalized.context.currentTime, 3);
});

test("envelope decoding never overrides a value Horizon's own response already supplied", async () => {
  // The transaction resource shape *does* carry source_account_sequence
  // directly — envelope decoding must not clobber that with a (here,
  // deliberately different) value decoded from a mismatched envelope.
  const normalized = await normalizeHorizonTransaction(
    {
      id: "x",
      hash: "x",
      successful: false,
      ledger: 1,
      source_account_sequence: "999",
      envelope_xdr: xdrFixtures.envelopes.plain, // encodes sequence 4611686018427388001
      result_xdr: xdrFixtures.results.bad_seq,
    },
    { xdrDecoder: fullXdrDecoder },
  );

  assert.equal(normalized.context.originalSequence, "999");
});

test("fee-bump envelope decoding uses the inner transaction's sequence, not the fee-bump's own", async () => {
  const normalized = await normalizeHorizonTransaction(
    {
      status: 400,
      extras: {
        envelope_xdr: xdrFixtures.envelopes.fee_bump, // inner seq_num: "12345"
        result_codes: {
          transaction: "tx_fee_bump_inner_failed",
          inner_transaction: "tx_bad_seq",
        },
      },
    },
    { xdrDecoder: fullXdrDecoder },
  );

  assert.equal(normalized.context.originalSequence, "12345");
});

test("RPC: options.envelopeXdr lets envelope decoding apply even though sendTransaction never echoes an envelope", async () => {
  const normalized = await normalizeRpcTransaction(
    { status: "ERROR", hash: "h1" },
    {
      xdrDecoder: fullXdrDecoder,
      resultCode: "tx_bad_seq",
      envelopeXdr: xdrFixtures.envelopes.plain,
    },
  );

  assert.equal(normalized.context.originalSequence, "4611686018427388001");
});

test("envelope decoding is skipped entirely when xdrDecoder has no decodeTransactionEnvelopeXdr", async () => {
  // xdrDecoder (result-only) from earlier in this file — envelope_xdr is
  // present, but the decoder can't decode it, so context stays empty
  // rather than throwing.
  const normalized = await normalizeHorizonTransaction(
    {
      status: 400,
      extras: {
        envelope_xdr: xdrFixtures.envelopes.with_time_bounds,
        result_codes: { transaction: "tx_bad_seq" },
      },
    },
    { xdrDecoder },
  );

  assert.deepEqual(normalized.context, {});
});
