// Run with: node examples/basic-evaluation.js
// (from the repository root, after `npm install`)

import {
  evaluateRetrySafety,
  normalizeHorizonTransaction,
  normalizeRpcTransaction,
} from "@stellar-txguard/core";

function show(label, input) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(evaluateRetrySafety(input), null, 2));
}

show("A transaction that already succeeded", {
  transactionStatus: "SUCCESS",
  resultCode: "tx_success",
});

show("A stale sequence number, with no evidence prior submissions failed", {
  transactionStatus: "FAILED",
  resultCode: "tx_bad_seq",
  context: {
    // Sequence numbers are always decimal strings, never JS numbers —
    // Stellar sequence numbers routinely exceed Number.MAX_SAFE_INTEGER.
    originalSequence: "123",
    currentSequence: "125",
  },
});

show("A stale sequence number, after the caller confirms nothing else succeeded", {
  transactionStatus: "FAILED",
  resultCode: "tx_bad_seq",
  context: {
    // Sequence numbers are always decimal strings, never JS numbers —
    // Stellar sequence numbers routinely exceed Number.MAX_SAFE_INTEGER.
    originalSequence: "123",
    currentSequence: "125",
    verifiedNoPriorSuccess: true,
  },
});

show("An insufficient fee", {
  transactionStatus: "FAILED",
  resultCode: "tx_insufficient_fee",
});

show("A payment that failed because the destination lacks a trustline", {
  transactionStatus: "FAILED",
  resultCode: "tx_failed",
  operationResultCodes: ["op_no_trust"],
});

show("A submission that timed out before a response was received", {
  submissionStatus: "TIMEOUT",
  transactionHash: "3c1c9b3f6e2a4d7c8f0e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d",
});

// --- Adapters: going straight from a real network response shape ---

console.log("\n=== A Horizon submission-failure response, adapted and evaluated ===");
const horizonNormalized = normalizeHorizonTransaction({
  status: 400,
  extras: {
    result_codes: {
      transaction: "tx_bad_seq",
    },
  },
});
console.log("normalized:", JSON.stringify(horizonNormalized, null, 2));
console.log("result:", JSON.stringify(evaluateRetrySafety(horizonNormalized), null, 2));

console.log("\n=== A stellar-rpc getTransaction NOT_FOUND response, adapted and evaluated ===");
const rpcNormalized = normalizeRpcTransaction(
  { status: "NOT_FOUND" },
  { transactionHash: "3c1c9b3f6e2a4d7c8f0e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d" },
);
console.log("normalized:", JSON.stringify(rpcNormalized, null, 2));
console.log("result:", JSON.stringify(evaluateRetrySafety(rpcNormalized), null, 2));
