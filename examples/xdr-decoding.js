// Run with: node examples/xdr-decoding.js
// (from the repository root, after `npm install`)
//
// Demonstrates the optional XDR decoding path: @stellar-txguard/core never
// imports @stellar-txguard/xdr itself, so this only works because we import
// both and wire them together via `options.xdrDecoder`. Without that
// option, the same Horizon response would normalize to the synthetic
// `tx_failed_undecoded` result code and evaluate to UNKNOWN — see
// basic-evaluation.js for that path.
//
// The XDR below was generated locally (see packages/xdr/test/fixtures/) —
// it is not from a real network transaction.

import { evaluateRetrySafety, normalizeHorizonTransaction } from "@stellar-txguard/core";
import { decodeTransactionResultXdr } from "@stellar-txguard/xdr";

const xdrDecoder = { decodeTransactionResultXdr };

// A Horizon GET /transactions/{hash} record for a failed transaction.
// Horizon does not decode result_xdr on this resource — only the raw
// bytes are available, which is exactly the case @stellar-txguard/xdr
// exists for.
const horizonResponse = {
  id: "example",
  hash: "example",
  successful: false,
  ledger: 1000002,
  source_account_sequence: "4611686018427388020",
  result_xdr: "AAAAAAAAAGT////7AAAAAA==", // synthetic tx_bad_seq
};

console.log("=== Without xdrDecoder ===");
const undecoded = normalizeHorizonTransaction(horizonResponse);
console.log("resultCode:", undecoded.resultCode); // "tx_failed_undecoded"
console.log("decision:", evaluateRetrySafety(undecoded).decision); // "UNKNOWN"

console.log("\n=== With xdrDecoder ===");
const decoded = await normalizeHorizonTransaction(horizonResponse, { xdrDecoder });
console.log("resultCode:", decoded.resultCode); // "tx_bad_seq"
console.log(JSON.stringify(evaluateRetrySafety(decoded), null, 2));
