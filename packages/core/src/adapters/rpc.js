import { TxGuardAdapterError } from "./errors.js";
import { NORMALIZED_STATE } from "./states.js";
import {
  applyXdrDecoder,
  nonEmptyOrUndefined,
  normalizeSubmissionStatus,
  omitUndefined,
  pickContext,
  SUBMISSION_STATUSES as SEND_TRANSACTION_STATUSES,
} from "./shared.js";

const GET_TRANSACTION_STATUSES = new Set(["SUCCESS", "NOT_FOUND", "FAILED"]);

/**
 * Normalizes a Stellar RPC (`soroban-rpc` / `stellar-rpc`) JSON-RPC
 * response into the input shape expected by `evaluateRetrySafety()`.
 *
 * `normalizeRpcTransaction()` accepts the `result` payload of either RPC
 * method, auto-detected by its `status` field:
 *
 * 1. **`sendTransaction`** — the response to submitting a transaction.
 *    Recognized statuses: `"PENDING"`, `"DUPLICATE"`, `"TRY_AGAIN_LATER"`,
 *    `"ERROR"`. Fields read:
 *      - `status` (string).
 *      - `hash` (string) — the transaction hash.
 *      - `errorResultXdr` / `diagnosticEventsXdr` (strings, optional) —
 *        present only when `status` is `"ERROR"`; raw, undecoded, kept on
 *        the normalized object's `raw` property. Pass a decoded code via
 *        `options.resultCode` if you have one (or an `options.xdrDecoder`
 *        — see below).
 *    `"PENDING"` means the node freshly accepted the submission.
 *    `"DUPLICATE"` means this exact transaction was already known to the
 *    node (a duplicate of an earlier submission) — per Stellar's own
 *    documentation, both call for the same action (poll `getTransaction`,
 *    do not build a new transaction), so both normalize to
 *    `transactionStatus: "PENDING"`. They are NOT collapsed into
 *    indistinguishable output, though: `DUPLICATE` additionally sets
 *    `context.duplicateSubmission: true`, which `evaluateRetrySafety()`
 *    surfaces as distinct evidence, and `observedState` is
 *    `NORMALIZED_STATE.DUPLICATE` rather than `.PENDING`. `"TRY_AGAIN_LATER"`
 *    means the node's queue declined the submission outright (it was
 *    never processed) — normalizes to the synthetic result code
 *    `rpc_try_again_later`. `"ERROR"` means the node synchronously
 *    rejected the envelope — a confirmed rejection, normalized to
 *    `tx_failed_undecoded` unless `options.resultCode` is supplied.
 *
 * 2. **`getTransaction`** — the response to polling for a transaction's
 *    final status. Recognized statuses: `"SUCCESS"`, `"NOT_FOUND"`,
 *    `"FAILED"`. Fields read:
 *      - `status` (string).
 *      - `txHash` (string) — the transaction hash, always echoed back by
 *        stellar-rpc (including for `NOT_FOUND`) since it reflects the
 *        hash the caller queried for.
 *      - `feeBump` (boolean, optional) — whether this was a fee-bump
 *        transaction.
 *      - `ledger` (number, optional).
 *      - `createdAt` (optional) — unix timestamp. Note: stellar-rpc encodes
 *        this as a JSON **string** on the singular `getTransaction`
 *        response specifically (a documented quirk — `getTransactions`,
 *        plural, encodes the equivalent field as a number). Preserved
 *        as-is, whichever type it arrives as.
 *      - `envelopeXdr` / `resultXdr` / `resultMetaXdr` (strings,
 *        optional) — raw, undecoded; preserved on the normalized object's
 *        `raw` property for future/manual use, not read for the decision.
 *      - `diagnosticEventsXdr` (string[], optional) — same treatment.
 *    `"NOT_FOUND"` does NOT mean the transaction failed — it means this
 *    node has no record of it (not yet propagated, or outside its
 *    retention window) — normalizes to `submissionStatus: "NOT_FOUND"`,
 *    an uncertain-submission state. `"SUCCESS"` / `"FAILED"` are decoded
 *    confirmed outcomes; `"FAILED"` normalizes to `tx_failed_undecoded"`
 *    unless `options.resultCode` is supplied, since `getTransaction` only
 *    returns raw `resultXdr`, not a decoded result code.
 *
 * `options.transactionHash` is only needed as a fallback for response
 * shapes that don't carry their own hash; both real `getTransaction` and
 * `sendTransaction` responses do, so it is rarely necessary in practice.
 *
 * @param {object} response A stellar-rpc `sendTransaction` or
 *   `getTransaction` result payload.
 * @param {object} [options]
 * @param {string} [options.transactionHash] The transaction hash, when the
 *   response itself doesn't carry one (`getTransaction`).
 * @param {string} [options.originalSequence] Canonical decimal string, not
 *   a JavaScript number — see `../sequence.js`.
 * @param {string} [options.currentSequence] Canonical decimal string, not
 *   a JavaScript number — see `../sequence.js`.
 * @param {number} [options.minTime]
 * @param {number} [options.maxTime]
 * @param {number} [options.currentTime]
 * @param {boolean} [options.verifiedNoPriorSuccess]
 * @param {boolean} [options.movesFunds]
 * @param {string} [options.resultCode] A pre-decoded transaction result
 *   code, used in place of the `tx_failed_undecoded` fallback.
 * @param {string[]} [options.operationResultCodes]
 * @param {string} [options.innerResultCode] Pre-decoded inner-transaction
 *   result code, for a fee-bump `getTransaction` FAILED response.
 * @param {string[]} [options.innerOperationResultCodes]
 * @param {{decodeTransactionResultXdr: (xdr: string) => Promise<object>}} [options.xdrDecoder]
 *   Optional XDR decoder — pass `{ decodeTransactionResultXdr }` imported
 *   from `@stellar-txguard/xdr` to automatically resolve the
 *   `tx_failed_undecoded` fallback into a real result code from raw
 *   `resultXdr`. This package never imports `@stellar-txguard/xdr` itself.
 *   **When provided, this function returns a `Promise` instead of a plain
 *   object** — omit it and you get a plain object back, as before.
 * @returns {object | Promise<object>} Input suitable for
 *   `evaluateRetrySafety()`, or a Promise of one if `options.xdrDecoder`
 *   was supplied.
 */
export function normalizeRpcTransaction(response, options = {}) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new TxGuardAdapterError(
      "normalizeRpcTransaction() requires a non-null RPC response object.",
    );
  }

  let normalized;
  if (SEND_TRANSACTION_STATUSES.has(response.status)) {
    normalized = normalizeSendTransaction(response, options);
  } else if (GET_TRANSACTION_STATUSES.has(response.status)) {
    normalized = normalizeGetTransaction(response, options);
  } else {
    throw new TxGuardAdapterError(
      `Unrecognized stellar-rpc response status "${response.status}". Expected a sendTransaction status (${[...SEND_TRANSACTION_STATUSES].join(", ")}) or a getTransaction status (${[...GET_TRANSACTION_STATUSES].join(", ")}).`,
    );
  }

  return applyXdrDecoder(normalized, options);
}

function normalizeSendTransaction(response, options) {
  return normalizeSubmissionStatus(
    response.status,
    {
      hash: response.hash,
      errorResultXdr: response.errorResultXdr,
      diagnosticEventsXdr: response.diagnosticEventsXdr,
    },
    options,
  );
}

function normalizeGetTransaction(response, options) {
  const isFeeBump = response.feeBump === true;
  const raw = nonEmptyOrUndefined({
    envelopeXdr: response.envelopeXdr,
    resultXdr: response.resultXdr,
    resultMetaXdr: response.resultMetaXdr,
    diagnosticEventsXdr: response.diagnosticEventsXdr,
    ledger: response.ledger,
    createdAt: response.createdAt,
  });
  const context = pickContext(options);
  const transactionHash = response.txHash || options.transactionHash;

  if (response.status === "NOT_FOUND") {
    return omitUndefined({
      submissionStatus: "NOT_FOUND",
      transactionHash,
      isFeeBump: isFeeBump || undefined,
      context,
      observedState: NORMALIZED_STATE.NOT_FOUND,
    });
  }

  if (response.status === "SUCCESS") {
    return omitUndefined({
      transactionStatus: "SUCCESS",
      resultCode: isFeeBump ? "tx_fee_bump_inner_success" : "tx_success",
      transactionHash,
      isFeeBump: isFeeBump || undefined,
      context,
      observedState: NORMALIZED_STATE.CONFIRMED_SUCCESS,
      raw,
    });
  }

  // response.status === "FAILED"
  return omitUndefined({
    transactionStatus: "FAILED",
    resultCode: options.resultCode ?? "tx_failed_undecoded",
    operationResultCodes: options.operationResultCodes,
    isFeeBump: isFeeBump || undefined,
    innerResultCode: options.innerResultCode,
    innerOperationResultCodes: options.innerOperationResultCodes,
    transactionHash,
    context,
    observedState: NORMALIZED_STATE.CONFIRMED_FAILURE,
    raw,
  });
}
