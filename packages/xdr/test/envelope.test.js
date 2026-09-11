import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decodeTransactionEnvelopeXdr, TxGuardXdrDecodeError } from "../src/index.js";

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/fixtures.json", import.meta.url)), "utf8"),
);

test("decodes a plain envelope: source account, sequence, no timebounds", async () => {
  const envelope = await decodeTransactionEnvelopeXdr(fixtures.envelopes.plain);

  assert.equal(envelope.isFeeBump, false);
  assert.equal(envelope.sourceAccount, fixtures.accounts.source);
  assert.equal(envelope.sequence, "4611686018427388001");
  assert.equal(envelope.feeSourceAccount, null);
  assert.equal(envelope.timeBounds, null);
});

test("decodes an envelope with timebounds", async () => {
  const envelope = await decodeTransactionEnvelopeXdr(fixtures.envelopes.with_time_bounds);

  assert.deepEqual(envelope.timeBounds, { minTime: 1700000000, maxTime: 1800000000 });
});

test("decodes a fee-bump envelope: distinguishes fee source from inner source", async () => {
  const envelope = await decodeTransactionEnvelopeXdr(fixtures.envelopes.fee_bump);

  assert.equal(envelope.isFeeBump, true);
  assert.equal(envelope.sourceAccount, fixtures.accounts.source);
  assert.equal(envelope.feeSourceAccount, fixtures.accounts.feeSource);
  assert.equal(envelope.sequence, "12345");
});

test("unsupported envelope type (legacy V0) throws a clear TxGuardXdrDecodeError, not a misread", async () => {
  await assert.rejects(
    () => decodeTransactionEnvelopeXdr(fixtures.envelopes.legacy_v0),
    (err) => {
      assert.ok(err instanceof TxGuardXdrDecodeError);
      assert.match(err.message, /unrecognized envelope variant/i);
      return true;
    },
  );
});

test("malformed XDR throws TxGuardXdrDecodeError", async () => {
  await assert.rejects(
    () => decodeTransactionEnvelopeXdr("not-valid-base64-xdr!!!"),
    TxGuardXdrDecodeError,
  );
});

test("XDR of the wrong type throws TxGuardXdrDecodeError", async () => {
  await assert.rejects(
    () => decodeTransactionEnvelopeXdr(fixtures.results.success),
    TxGuardXdrDecodeError,
  );
});
