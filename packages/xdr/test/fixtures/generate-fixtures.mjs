// Regenerates fixtures.json.
//
// Run with: node test/fixtures/generate-fixtures.mjs  (from packages/xdr/)
//
// Every value in fixtures.json is base64 XDR *encoded locally by this
// script*, using the official `@stellar/stellar-xdr-json` encoder — it is
// not captured from any real network traffic, and none of the account
// addresses, hashes, or ledger data it contains correspond to a real
// Stellar account or transaction. Addresses and hashes are fixed,
// deterministic, checksum-valid placeholders (see strkey.mjs and
// `fixedHex` below) — this exists only so the resulting XDR is
// structurally valid enough for stellar-xdr-json to accept and decode.
//
// Deliberately deterministic: this script uses no randomness anywhere, so
// running it twice in a row (or on two different machines) produces a
// byte-for-byte identical fixtures.json. If a change to this script
// legitimately changes the fixtures, re-run it and commit the result —
// `git diff` on fixtures.json should otherwise always be empty.
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { deterministicAccountId } from "./strkey.mjs";

const require = createRequire(import.meta.url);
const { initSync, encode } = await import("@stellar/stellar-xdr-json");
initSync(readFileSync(require.resolve("@stellar/stellar-xdr-json/stellar_xdr_json_bg.wasm")));

// Each identifier below is derived from a distinct fixed byte so they're
// all trivially distinguishable from one another and from the repeated-
// character placeholders used elsewhere in this project (see
// packages/core/test/fixtures/README.md).
const source = deterministicAccountId(0x11);
const feeSource = deterministicAccountId(0x22);
const dest = deterministicAccountId(0x33);

/** A fixed 32-byte value (64 hex chars), e.g. fixedHex(0xaa) => "aaaa...aa". */
function fixedHex(byteValue) {
  return byteValue.toString(16).padStart(2, "0").repeat(32);
}

function encodeResult(result) {
  return encode(
    "TransactionResult",
    JSON.stringify({ fee_charged: "100", result, ext: "v0" }),
  );
}

function innerResult(result) {
  return { fee_charged: "0", result, ext: "v0" };
}

const results = {
  success: encodeResult({ tx_success: [] }),
  bad_seq: encodeResult("tx_bad_seq"),
  insufficient_fee: encodeResult("tx_insufficient_fee"),
  insufficient_balance: encodeResult("tx_insufficient_balance"),
  no_source_account: encodeResult("tx_no_account"),
  payment_no_trust: encodeResult({
    tx_failed: [{ op_inner: { payment: "no_trust" } }],
  }),
  payment_underfunded: encodeResult({
    tx_failed: [{ op_inner: { payment: "underfunded" } }],
  }),
  path_payment_offer_cross_self: encodeResult({
    tx_failed: [{ op_inner: { path_payment_strict_receive: "offer_cross_self" } }],
  }),
  path_payment_over_sendmax: encodeResult({
    tx_failed: [{ op_inner: { path_payment_strict_receive: "over_sendmax" } }],
  }),
  path_payment_under_destmin: encodeResult({
    tx_failed: [{ op_inner: { path_payment_strict_send: "under_destmin" } }],
  }),
  // An operation type/result this package does not map (create_account),
  // to prove decoding degrades gracefully instead of guessing.
  unsupported_operation: encodeResult({
    tx_failed: [{ op_inner: { create_account: "low_reserve" } }],
  }),
  fee_bump_success: encodeResult({
    tx_fee_bump_inner_success: {
      transaction_hash: fixedHex(0xaa),
      result: innerResult({ tx_success: [] }),
    },
  }),
  fee_bump_failed_bad_seq: encodeResult({
    tx_fee_bump_inner_failed: {
      transaction_hash: fixedHex(0xbb),
      result: innerResult("tx_bad_seq"),
    },
  }),
  fee_bump_failed_payment_underfunded: encodeResult({
    tx_fee_bump_inner_failed: {
      transaction_hash: fixedHex(0xcc),
      result: innerResult({
        tx_failed: [{ op_inner: { payment: "underfunded" } }],
      }),
    },
  }),
};

function encodeEnvelope(tx) {
  return encode("TransactionEnvelope", JSON.stringify(tx));
}

const envelopes = {
  plain: encodeEnvelope({
    tx: {
      tx: {
        source_account: source,
        fee: 100,
        seq_num: "4611686018427388001",
        cond: "none",
        memo: "none",
        operations: [],
        ext: "v0",
      },
      signatures: [],
    },
  }),
  with_time_bounds: encodeEnvelope({
    tx: {
      tx: {
        source_account: source,
        fee: 100,
        seq_num: "4611686018427388050",
        cond: { time: { min_time: "1700000000", max_time: "1800000000" } },
        memo: "none",
        operations: [],
        ext: "v0",
      },
      signatures: [],
    },
  }),
  fee_bump: encodeEnvelope({
    tx_fee_bump: {
      tx: {
        fee_source: feeSource,
        fee: "200",
        inner_tx: {
          tx: {
            tx: {
              source_account: source,
              fee: 100,
              seq_num: "12345",
              cond: "none",
              memo: "none",
              operations: [],
              ext: "v0",
            },
            signatures: [],
          },
        },
        ext: "v0",
      },
      signatures: [],
    },
  }),
  // Legacy pre-CAP-15 envelope format (ENVELOPE_TYPE_TX_V0). Still a
  // structurally valid TransactionEnvelope per the XDR schema, but not one
  // decodeTransactionEnvelopeXdr() supports — used to test that an
  // unsupported-but-valid envelope variant throws a clear
  // TxGuardXdrDecodeError instead of silently misreading it as a v1
  // envelope.
  legacy_v0: encodeEnvelope({
    tx_v0: {
      tx: {
        source_account_ed25519: fixedHex(0xdd),
        fee: 100,
        seq_num: "4611686018427388001",
        memo: "none",
        operations: [],
        ext: "v0",
      },
      signatures: [],
    },
  }),
};

const fixtures = {
  _synthetic:
    "Every XDR value below was generated locally by generate-fixtures.mjs using @stellar/stellar-xdr-json's encoder. None of it is captured from real network traffic; addresses and hashes are fixed, deterministic synthetic placeholders (not random) — running this script always produces this exact file, byte for byte.",
  accounts: { source, feeSource, dest },
  results,
  envelopes,
};

const outPath = fileURLToPath(new URL("./fixtures.json", import.meta.url));
writeFileSync(outPath, JSON.stringify(fixtures, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
