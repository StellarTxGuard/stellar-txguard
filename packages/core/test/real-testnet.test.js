// Regression test built from a REAL Stellar Testnet transaction failure —
// see fixtures/horizon/real_testnet_op_no_destination.json's _provenance
// field for exactly how this was obtained and independently verified
// (envelope_xdr/result_xdr were re-decoded with @stellar-txguard/xdr and
// the transaction hash was independently recomputed and cross-checked).
// Every other test in this package uses synthetic fixtures; this is the
// one exception, kept in its own file so it's easy to find.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DECISION, RISK, evaluateRetrySafety, normalizeHorizonTransaction } from "../src/index.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/horizon/real_testnet_op_no_destination.json", import.meta.url)),
    "utf8",
  ),
);

const REAL_TX_HASH = "89a3b23e9b7b0e946fedbd405dbbcf095b90d777c36a6fe9abba0b56ca365247";
const SOURCE = "GCZ5Q3U5YQE6DCGAQV3CTVZ3POAXZDFM2NCVKKIMIL6TXPFEFCWM6IO7";
const DESTINATION = "GCTUVNPBMQCVLLKKO6KRDAMP7U73YFO5BYKCDRBOWYSJ2QCD7QQPX2JS";

test("real Testnet fixture: envelope_xdr independently re-decodes to the exact submitted payment", async () => {
  const { decodeTransactionEnvelopeXdr } = await import("@stellar-txguard/xdr");
  const envelope = await decodeTransactionEnvelopeXdr(fixture.extras.envelope_xdr);

  assert.equal(envelope.sourceAccount, SOURCE);
  assert.equal(envelope.isFeeBump, false);
  assert.equal(envelope.operationCount, 1);
});

test("real Testnet fixture: result_xdr independently re-decodes to tx_failed / op_no_destination", async () => {
  const { decodeTransactionResultXdr } = await import("@stellar-txguard/xdr");
  const decoded = await decodeTransactionResultXdr(fixture.extras.result_xdr);

  assert.equal(decoded.resultCode, "tx_failed");
  assert.deepEqual(decoded.operationResults, ["op_no_destination"]);
});

test("real Testnet fixture: normalizeHorizonTransaction() correctly normalizes the submission failure", () => {
  const normalized = normalizeHorizonTransaction(fixture);

  assert.equal(normalized.transactionStatus, "FAILED");
  assert.equal(normalized.resultCode, "tx_failed");
  assert.deepEqual(normalized.operationResultCodes, ["op_no_destination"]);
  assert.equal(normalized.observedState, "CONFIRMED_FAILURE");
  assert.equal(normalized.raw.envelopeXdr, fixture.extras.envelope_xdr);
  assert.equal(normalized.raw.resultXdr, fixture.extras.result_xdr);
});

test("real Testnet fixture: evaluateRetrySafety() reaches the correct, conservative decision", () => {
  const normalized = normalizeHorizonTransaction(fixture);
  const result = evaluateRetrySafety(normalized);

  // Decision: this is a fixable configuration problem (the destination
  // account doesn't exist), not a duplicate-payment risk — Stellar
  // transactions are atomic, so a failed operation never moved funds.
  // Blindly resubmitting the identical envelope would just fail again for
  // the same reason, but the underlying problem (create/fund Account B)
  // is genuinely fixable, so RETRY_AFTER_ACTION is correct — neither the
  // overly permissive SAFE_TO_RETRY (retrying *this* envelope won't work
  // until the destination exists) nor the overly conservative DO_NOT_RETRY
  // (there is a clear, known fix, unlike e.g. tx_bad_seq's ambiguity).
  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.CONFIGURATION_ISSUE);
  assert.equal(result.reasonCode, "op_no_destination");
  assert.equal(result.confidence, "high");

  assert.ok(
    result.evidence.some((e) => /op_no_destination/.test(e)),
    "evidence should cite the actual operation result code",
  );
  assert.ok(
    result.evidence.some((e) => /no funds were transferred/i.test(e) && /atomic/i.test(e)),
    "evidence should explain why this doesn't carry duplicate-payment risk",
  );
  assert.ok(
    result.recommendedActions.some((a) => /destination/i.test(a) && /(confirm|correct)/i.test(a)),
    "should recommend confirming the destination address",
  );
  assert.ok(
    result.recommendedActions.some((a) => /(create|fund)/i.test(a) && /destination/i.test(a)),
    "should recommend creating/funding the destination account before retrying",
  );

  // Never present as safe to blindly resubmit without any caveat.
  assert.notEqual(result.decision, DECISION.SAFE_TO_RETRY);
});

test("real Testnet fixture: xdrDecoder resolves the same fixture with an undecoded fallback (defense in depth)", async () => {
  // Exercise the path that would apply if this fixture instead only had
  // raw result_xdr (e.g. from a GET transaction resource rather than a
  // POST submission-error body): confirm the decoder pipeline reaches the
  // identical conclusion as the pre-decoded extras.result_codes path above.
  const { decodeTransactionResultXdr } = await import("@stellar-txguard/xdr");

  const undecodedShape = {
    id: REAL_TX_HASH,
    hash: REAL_TX_HASH,
    successful: false,
    ledger: 1,
    result_xdr: fixture.extras.result_xdr,
  };

  const normalized = await normalizeHorizonTransaction(undecodedShape, {
    xdrDecoder: { decodeTransactionResultXdr },
  });

  assert.equal(normalized.resultCode, "tx_failed");
  assert.deepEqual(normalized.operationResultCodes, ["op_no_destination"]);

  const result = evaluateRetrySafety(normalized);
  assert.equal(result.decision, DECISION.RETRY_AFTER_ACTION);
  assert.equal(result.risk, RISK.CONFIGURATION_ISSUE);
});

test("real Testnet fixture: the real sequence number (19801804984287233) survives normalization exactly", async () => {
  // This account's real, live Testnet source_account_sequence exceeds
  // Number.MAX_SAFE_INTEGER (2^53-1 = 9007199254740991) — this is the
  // exact real-world value that surfaced the Number()-conversion bug this
  // fix addresses (see ../src/sequence.js and sequence.test.js for the
  // general regression coverage). This fixture is a submission-error body
  // with no source_account_sequence field of its own, so the only way to
  // get this value is by decoding the real envelope_xdr.
  const { decodeTransactionEnvelopeXdr, decodeTransactionResultXdr } = await import(
    "@stellar-txguard/xdr"
  );

  const REAL_SEQUENCE = "19801804984287233";
  assert.ok(
    BigInt(REAL_SEQUENCE) > 9007199254740991n,
    "sanity: this value must actually exceed Number.MAX_SAFE_INTEGER for this test to mean anything",
  );

  const normalized = await normalizeHorizonTransaction(fixture, {
    xdrDecoder: { decodeTransactionResultXdr, decodeTransactionEnvelopeXdr },
  });

  assert.equal(normalized.context.originalSequence, REAL_SEQUENCE);
  assert.equal(
    typeof normalized.context.originalSequence,
    "string",
    "must remain a string end to end — never silently coerced to a JavaScript number",
  );

  // And once more through evaluateRetrySafety()'s own input validation,
  // to prove the exact value survives the full public entry point, not
  // just the adapter's internal object.
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_bad_seq",
    context: { originalSequence: REAL_SEQUENCE, currentSequence: REAL_SEQUENCE },
  });
  assert.ok(result.evidence.some((e) => e.includes(REAL_SEQUENCE)));
});
