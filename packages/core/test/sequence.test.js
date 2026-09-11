// Regression coverage for the sequence-number precision fix. Stellar
// sequence numbers are 64-bit and routinely exceed
// Number.MAX_SAFE_INTEGER (2^53-1) — this file exists because that used
// to be silently mishandled via Number(...) conversion (discovered via a
// real Stellar Testnet transaction; see fixtures/horizon/
// real_testnet_op_no_destination.json and real-testnet.test.js, which has
// a dedicated test for that exact real value). See ../src/sequence.js for
// the full rationale.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DECISION,
  MAX_SEQUENCE,
  compareSequences,
  describeSequenceError,
  evaluateRetrySafety,
  isValidSequence,
  TxGuardValidationError,
} from "../src/index.js";

// --- describeSequenceError / isValidSequence ---

test("describeSequenceError: accepts canonical decimal strings, including huge ones", () => {
  for (const value of ["0", "1", "123", "9007199254740991", "19801804984287233", MAX_SEQUENCE.toString()]) {
    assert.equal(describeSequenceError(value), null, `expected "${value}" to be valid`);
    assert.equal(isValidSequence(value), true);
  }
});

test("describeSequenceError: rejects a JavaScript number, even a small one", () => {
  assert.match(describeSequenceError(123), /must be a decimal string/);
  assert.equal(isValidSequence(123), false);
});

test("describeSequenceError: rejects non-integer / negative / malformed decimal forms", () => {
  const invalid = [
    "123.45", // non-integer
    "-5", // negative
    "-0", // negative sign on zero
    "+5", // explicit positive sign
    "01", // leading zero
    "007", // leading zeros
    "", // empty
    " 123", // leading whitespace
    "123 ", // trailing whitespace
    "12a3", // non-digit characters
    "0x1F", // hex
    "1e10", // scientific notation
    "12,345", // thousands separator
    null,
    undefined,
    {},
    [],
  ];
  for (const value of invalid) {
    assert.notEqual(describeSequenceError(value), null, `expected "${value}" to be rejected`);
    assert.equal(isValidSequence(value), false);
  }
});

test("describeSequenceError: rejects values beyond the int64 maximum (2^63-1)", () => {
  const tooLarge = (MAX_SEQUENCE + 1n).toString();
  assert.match(describeSequenceError(tooLarge), /exceeds the maximum/);
  assert.equal(isValidSequence(tooLarge), false);
});

test("describeSequenceError: accepts the exact int64 maximum", () => {
  assert.equal(describeSequenceError(MAX_SEQUENCE.toString()), null);
});

// --- compareSequences: exact BigInt comparison, no Number precision loss ---

test("compareSequences: correct ordering across the Number.MAX_SAFE_INTEGER boundary", () => {
  // 2^53 and 2^53+1 are NOT both exactly representable as doubles — under
  // naive Number() conversion, Number("9007199254740992") ===
  // Number("9007199254740993") (both round to 9007199254740992), so a
  // Number-based `b > a` comparison would incorrectly return false. This
  // is the exact bug class this module exists to prevent.
  assert.equal(Number("9007199254740992") === Number("9007199254740993"), true, "sanity: Number() does collide these two values");

  assert.equal(compareSequences("9007199254740992", "9007199254740993"), -1);
  assert.equal(compareSequences("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareSequences("9007199254740992", "9007199254740992"), 0);
});

test("compareSequences: correct ordering at Number.MAX_SAFE_INTEGER itself", () => {
  assert.equal(compareSequences("9007199254740991", "9007199254740991"), 0);
  assert.equal(compareSequences("9007199254740991", "9007199254740992"), -1);
  assert.equal(compareSequences("9007199254740992", "9007199254740991"), 1);
});

test("compareSequences: correct ordering for a real Testnet-magnitude value differing by 1", () => {
  // 19801804984287233 is the real value from real-testnet.test.js's
  // fixture; Number(...) rounds it (to a different value depending on
  // how the rounding is observed — see sequence.js's module doc), so any
  // Number-based comparison against a neighboring sequence number is
  // unreliable at this magnitude.
  assert.equal(compareSequences("19801804984287233", "19801804984287234"), -1);
  assert.equal(compareSequences("19801804984287234", "19801804984287233"), 1);
  assert.equal(compareSequences("19801804984287233", "19801804984287233"), 0);
});

// --- evaluateRetrySafety(): end-to-end validation and comparison ---

test("evaluateRetrySafety: rejects a JavaScript number for context.originalSequence", () => {
  assert.throws(
    () =>
      evaluateRetrySafety({
        transactionStatus: "FAILED",
        resultCode: "tx_bad_seq",
        context: { originalSequence: 123, currentSequence: "125" },
      }),
    (err) => {
      assert.ok(err instanceof TxGuardValidationError);
      assert.match(err.message, /context\.originalSequence/);
      assert.match(err.message, /decimal string/);
      return true;
    },
  );
});

test("evaluateRetrySafety: rejects a JavaScript number for context.currentSequence", () => {
  assert.throws(
    () =>
      evaluateRetrySafety({
        transactionStatus: "FAILED",
        resultCode: "tx_bad_seq",
        context: { originalSequence: "123", currentSequence: 125 },
      }),
    TxGuardValidationError,
  );
});

test("evaluateRetrySafety: rejects a malformed sequence string clearly", () => {
  assert.throws(
    () =>
      evaluateRetrySafety({
        transactionStatus: "FAILED",
        resultCode: "tx_bad_seq",
        context: { originalSequence: "123", currentSequence: "12.5" },
      }),
    (err) => {
      assert.ok(err instanceof TxGuardValidationError);
      assert.match(err.message, /context\.currentSequence/);
      return true;
    },
  );
});

test("evaluateRetrySafety: rejects a negative sequence string", () => {
  assert.throws(
    () =>
      evaluateRetrySafety({
        transactionStatus: "FAILED",
        resultCode: "tx_bad_seq",
        context: { originalSequence: "-5", currentSequence: "10" },
      }),
    TxGuardValidationError,
  );
});

test("evaluateRetrySafety: tx_bad_seq evidence is exact at the Number.MAX_SAFE_INTEGER+1 collision point", () => {
  // Under the old Number()-based comparison, these two sequence numbers
  // would have compared equal, producing the wrong evidence sentence
  // ("does not exceed") even though the account sequence genuinely
  // advanced by one.
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_bad_seq",
    context: {
      originalSequence: "9007199254740992",
      currentSequence: "9007199254740993",
    },
  });

  assert.equal(result.decision, DECISION.DO_NOT_RETRY);
  assert.ok(
    result.evidence.some((e) => /has advanced beyond the submitted sequence/.test(e)),
    "evidence must correctly report the sequence advanced, not silently treat the two values as equal",
  );
  assert.ok(!result.evidence.some((e) => /does not exceed/.test(e)));
});

test("evaluateRetrySafety: tx_bad_seq evidence is exact for the real Testnet magnitude (19801804984287233 vs +1)", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_bad_seq",
    context: {
      originalSequence: "19801804984287233",
      currentSequence: "19801804984287234",
    },
  });

  assert.ok(result.evidence.some((e) => e.includes("19801804984287233")));
  assert.ok(result.evidence.some((e) => e.includes("19801804984287234")));
  assert.ok(result.evidence.some((e) => /has advanced beyond the submitted sequence/.test(e)));
});

test("evaluateRetrySafety: tx_bad_seq at exactly Number.MAX_SAFE_INTEGER (boundary, still exact)", () => {
  const result = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_bad_seq",
    context: {
      originalSequence: "9007199254740991",
      currentSequence: "9007199254740991",
    },
  });

  assert.ok(result.evidence.some((e) => /does not exceed the submitted sequence/.test(e)));
});

test("evaluateRetrySafety: tx_insufficient_fee sequence-match evidence is exact past Number.MAX_SAFE_INTEGER", () => {
  const matching = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_insufficient_fee",
    context: {
      originalSequence: "19801804984287233",
      currentSequence: "19801804984287233",
    },
  });
  assert.ok(matching.evidence.some((e) => /matches the current sequence/.test(e)));

  const differing = evaluateRetrySafety({
    transactionStatus: "FAILED",
    resultCode: "tx_insufficient_fee",
    context: {
      originalSequence: "9007199254740992",
      currentSequence: "9007199254740993",
    },
  });
  // Under Number()-based equality these two would have incorrectly
  // compared equal ("matches"); BigInt-based compareSequences correctly
  // treats them as different.
  assert.ok(differing.evidence.some((e) => /differs from the current sequence/.test(e)));
});
