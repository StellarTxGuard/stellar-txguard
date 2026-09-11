import { TxGuardAdapterError } from "./errors.js";
import { NORMALIZED_STATE } from "./states.js";
import {
  applyXdrDecoder,
  nonEmptyOrUndefined,
  normalizeSubmissionStatus,
  omitUndefined,
  pickContext,
  SUBMISSION_STATUSES,
} from "./shared.js";

// Horizon problem+json `type` values (bare or full-URL form) that describe
// a request- or infrastructure-level problem with POST /transactions_async,
// rather than a transaction outcome. Recognized so the error thrown for
// them is specific, not the generic "unrecognized shape" message — but
// none of them are modeled as a normalized transaction, since none of them
// describe a submission outcome to reason about retry-safety for. See
// docs/architecture.md#horizon-transactions_async for why.
const UNMODELED_PROBLEM_TYPES = [
  "transaction_malformed",
  "transaction_submission_failed",
  "transaction_submission_exception",
  "transaction_submission_invalid_status",
  "transaction_submission_disabled",
  "stale_history",
];

function unmodeledProblemType(response) {
  if (typeof response.type !== "string") {
    return null;
  }
  return (
    UNMODELED_PROBLEM_TYPES.find(
      (type) => response.type === type || response.type.endsWith(`/${type}`),
    ) ?? null
  );
}

/**
 * Normalizes a Horizon transaction response into the input shape expected
 * by `evaluateRetrySafety()`.
 *
 * `normalizeHorizonTransaction()` accepts two different real Horizon
 * response shapes, auto-detected from the object it is given:
 *
 * 1. **A transaction resource** — the body of `GET /transactions/{hash}`,
 *    an entry from `GET /accounts/{id}/transactions`, or the 200 response
 *    from `POST /transactions`. Detected by the presence of a boolean
 *    `successful` field. Fields read:
 *      - `successful` (boolean) — whether the transaction was included and
 *        applied.
 *      - `hash` (string) — the transaction hash.
 *      - `source_account_sequence` (string) — the sequence number the
 *        transaction envelope used. Mapped to `context.originalSequence`.
 *        Note this is NOT the account's current sequence number — Horizon
 *        does not expose that on the transaction resource, so pass it via
 *        `options.currentSequence` if you have it (e.g. from
 *        `GET /accounts/{id}`).
 *      - `fee_bump_transaction` / `inner_transaction` (objects, optional)
 *        — presence indicates this was a fee-bump transaction. Their
 *        `hash` fields are mapped to `feeBumpTransactionHash` /
 *        `innerTransactionHash`.
 *      - `preconditions.timebounds.{min_time,max_time}` (strings,
 *        optional; `"0"` means unset), or the legacy top-level
 *        `valid_after` / `valid_before` (ISO 8601 strings) — mapped to
 *        `context.minTime` / `context.maxTime` (unix seconds).
 *    Horizon does not include a decoded result code on this resource
 *    (only raw `result_xdr`), so a `successful: false` record normalizes
 *    to the synthetic `tx_failed_undecoded` result code unless the caller
 *    supplies an already-decoded one via `options.resultCode` /
 *    `options.operationResultCodes`.
 *
 * 2. **A submission error body** — the JSON Horizon returns for a failed
 *    synchronous `POST /transactions` (HTTP 400, problem type
 *    `.../horizon-errors/transaction_failed`). Detected by the presence of
 *    `extras.result_codes`. Fields read:
 *      - `extras.result_codes.transaction` (string) — e.g. `"tx_bad_seq"`.
 *        Mapped directly to `resultCode`; Horizon's strings already match
 *        this package's `tx_*` naming.
 *      - `extras.result_codes.operations` (string[], optional) — e.g.
 *        `["op_success", "op_underfunded"]`. Mapped to
 *        `operationResultCodes` (or `innerOperationResultCodes` for a fee
 *        bump — see below).
 *      - `extras.result_codes.inner_transaction` (string, optional) —
 *        present when `extras.result_codes.transaction` is
 *        `"tx_fee_bump_inner_failed"`. Mapped to `innerResultCode`.
 *
 * 3. **An async submission response** — the JSON Horizon returns from
 *    `POST /transactions_async` (note: an underscore, not a hyphen — see
 *    `docs/architecture.md#horizon-transactions_async`). Detected by
 *    `tx_status` being one of `"PENDING"`, `"DUPLICATE"`,
 *    `"TRY_AGAIN_LATER"`, `"ERROR"` — the exact same four values, and the
 *    exact same underlying stellar-core classification, as stellar-rpc's
 *    `sendTransaction`, so this is normalized through the identical logic
 *    (see `adapters/rpc.js`'s `normalizeRpcTransaction()` for the full
 *    semantics of each status). Fields read: `tx_status`, `hash`,
 *    `error_result_xdr` (only present when `tx_status` is `"ERROR"`).
 *    Horizon's async response never echoes back the submitted envelope, so
 *    there is no `envelope_xdr` to read here — pass `options.envelopeXdr`
 *    if you want envelope-derived context (you already have the envelope;
 *    you just submitted it) and have supplied `options.xdrDecoder`.
 *    A handful of other, rarer `POST /transactions_async` responses —
 *    Horizon-level problem+json bodies for a malformed request or a
 *    Horizon-Core communication failure, as opposed to a stellar-core
 *    submission-outcome classification — are recognized but not yet
 *    modeled; `normalizeHorizonTransaction()` throws `TxGuardAdapterError`
 *    for them rather than guessing at a normalized shape.
 *
 * Does not decode `envelope_xdr` / `result_xdr` / `result_meta_xdr` on its
 * own — see `docs/architecture.md` for why — but will, for shapes 1 and 2,
 * if `options.xdrDecoder` is supplied (see below).
 *
 * @param {object} response A Horizon transaction resource, submission
 *   error body, or async submission response.
 * @param {object} [options]
 * @param {string} [options.originalSequence] Overrides the sequence number
 *   read from the response, as a canonical decimal string (not a
 *   JavaScript number — see `../sequence.js`).
 * @param {string} [options.currentSequence] The source account's current
 *   sequence number, if independently looked up, as a canonical decimal
 *   string (not a JavaScript number — see `../sequence.js`).
 * @param {boolean} [options.verifiedNoPriorSuccess]
 * @param {boolean} [options.movesFunds]
 * @param {number} [options.now] Unix seconds to treat as "now" when
 *   timebounds are present (from the response directly, or decoded from
 *   `options.xdrDecoder`). Defaults to the current time.
 * @param {string} [options.resultCode] A pre-decoded transaction result
 *   code, used in place of the `tx_failed_undecoded` fallback when Horizon
 *   did not supply one directly (i.e. a plain `successful: false`
 *   transaction resource, or an async `"ERROR"` response).
 * @param {string[]} [options.operationResultCodes] Pre-decoded operation
 *   result codes, paired with `options.resultCode`.
 * @param {string} [options.innerResultCode] Pre-decoded inner-transaction
 *   result code for an undecoded fee-bump failure.
 * @param {string[]} [options.innerOperationResultCodes]
 * @param {string} [options.transactionHash] Fallback hash, used only if
 *   the response itself doesn't carry one.
 * @param {string} [options.envelopeXdr] The submitted envelope's XDR, for
 *   response shapes that don't echo it back (currently: async submission
 *   responses). Combines with `options.xdrDecoder` to derive
 *   `context.originalSequence` / `minTime` / `maxTime`.
 * @param {{decodeTransactionResultXdr?: (xdr: string) => Promise<object>, decodeTransactionEnvelopeXdr?: (xdr: string) => Promise<object>}} [options.xdrDecoder]
 *   Optional XDR decoder — pass `@stellar-txguard/xdr`'s exports to
 *   automatically resolve the `tx_failed_undecoded` fallback into a real
 *   result code from raw `result_xdr` (`decodeTransactionResultXdr`), and/or
 *   to fill in sequence-number/timebounds context from raw `envelope_xdr`
 *   (`decodeTransactionEnvelopeXdr`) — either function is independently
 *   optional on the object you pass. This package never imports
 *   `@stellar-txguard/xdr` itself — passing this option is the only way
 *   XDR decoding happens, and only when you ask for it. **When provided,
 *   this function returns a `Promise` instead of a plain object** (only in
 *   that case — omit it and you get a plain object back, exactly as before).
 * @returns {object | Promise<object>} Input suitable for
 *   `evaluateRetrySafety()`, or a Promise of one if `options.xdrDecoder`
 *   was supplied.
 */
export function normalizeHorizonTransaction(response, options = {}) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new TxGuardAdapterError(
      "normalizeHorizonTransaction() requires a non-null Horizon response object.",
    );
  }

  let normalized;
  if (response.extras && typeof response.extras === "object" && response.extras.result_codes) {
    normalized = normalizeSubmissionError(response, options);
  } else if (SUBMISSION_STATUSES.has(response.tx_status)) {
    normalized = normalizeAsyncSubmission(response, options);
  } else if (typeof response.successful === "boolean") {
    normalized = normalizeTransactionResource(response, options);
  } else {
    const unmodeled = unmodeledProblemType(response);
    if (unmodeled) {
      throw new TxGuardAdapterError(
        `Horizon returned a "${unmodeled}" problem response from an async submission attempt, which normalizeHorizonTransaction() does not model — it only handles the four stellar-core submission-outcome statuses (PENDING/DUPLICATE/TRY_AGAIN_LATER/ERROR) from POST /transactions_async, not Horizon-level request/infrastructure problems like this one. See response.detail for what Horizon reported.`,
      );
    }
    throw new TxGuardAdapterError(
      'Unrecognized Horizon response shape: expected a transaction resource (boolean "successful" field), a submission error body ("extras.result_codes"), or an async submission response ("tx_status").',
    );
  }

  return applyXdrDecoder(normalized, options);
}

function normalizeAsyncSubmission(response, options) {
  return normalizeSubmissionStatus(
    response.tx_status,
    {
      hash: response.hash,
      errorResultXdr: response.error_result_xdr,
    },
    options,
  );
}

function normalizeSubmissionError(response, options) {
  const codes = response.extras.result_codes;
  const isFeeBump = typeof codes.inner_transaction === "string";

  return omitUndefined({
    transactionStatus: "FAILED",
    resultCode: codes.transaction,
    operationResultCodes: isFeeBump ? undefined : codes.operations,
    isFeeBump: isFeeBump || undefined,
    innerResultCode: codes.inner_transaction,
    innerOperationResultCodes: isFeeBump ? codes.operations : undefined,
    context: pickContext(options),
    observedState: NORMALIZED_STATE.CONFIRMED_FAILURE,
    raw: nonEmptyOrUndefined({
      envelopeXdr: response.extras.envelope_xdr,
      resultXdr: response.extras.result_xdr,
    }),
  });
}

function normalizeTransactionResource(response, options) {
  const isFeeBump = Boolean(response.fee_bump_transaction || response.inner_transaction);

  const context = {
    ...pickContext(options),
    ...buildSequenceContext(response, options),
    ...buildTimeContext(response, options),
  };

  if (response.successful) {
    return omitUndefined({
      transactionStatus: "SUCCESS",
      resultCode: isFeeBump ? "tx_fee_bump_inner_success" : "tx_success",
      transactionHash: response.hash,
      isFeeBump: isFeeBump || undefined,
      feeBumpTransactionHash: response.fee_bump_transaction?.hash,
      innerTransactionHash: response.inner_transaction?.hash,
      context,
      observedState: NORMALIZED_STATE.CONFIRMED_SUCCESS,
      raw: nonEmptyOrUndefined({
        envelopeXdr: response.envelope_xdr,
        resultXdr: response.result_xdr,
        resultMetaXdr: response.result_meta_xdr,
        ledger: response.ledger,
      }),
    });
  }

  return omitUndefined({
    transactionStatus: "FAILED",
    resultCode: options.resultCode ?? "tx_failed_undecoded",
    operationResultCodes: options.operationResultCodes,
    isFeeBump: isFeeBump || undefined,
    innerResultCode: options.innerResultCode,
    innerOperationResultCodes: options.innerOperationResultCodes,
    transactionHash: response.hash,
    feeBumpTransactionHash: response.fee_bump_transaction?.hash,
    innerTransactionHash: response.inner_transaction?.hash,
    context,
    observedState: NORMALIZED_STATE.CONFIRMED_FAILURE,
    raw: nonEmptyOrUndefined({
      envelopeXdr: response.envelope_xdr,
      resultXdr: response.result_xdr,
      resultMetaXdr: response.result_meta_xdr,
      ledger: response.ledger,
    }),
  });
}

function buildSequenceContext(response, options) {
  if (options.originalSequence !== undefined) {
    // Explicit option wins over the response field.
    return {};
  }
  if (response.source_account_sequence === undefined) {
    return {};
  }
  // Horizon's source_account_sequence is already a decimal string in JSON
  // (XDR `int64,string`-tagged) — pass it through as-is. Do NOT wrap in
  // Number(...): real sequence numbers routinely exceed
  // Number.MAX_SAFE_INTEGER (see ../sequence.js), and Number() would
  // silently round them.
  return { originalSequence: response.source_account_sequence };
}

function buildTimeContext(response, options) {
  const timebounds = response.preconditions?.timebounds;
  const context = {};

  if (timebounds) {
    if (timebounds.min_time !== undefined && timebounds.min_time !== "0") {
      context.minTime = Number(timebounds.min_time);
    }
    if (timebounds.max_time !== undefined && timebounds.max_time !== "0") {
      context.maxTime = Number(timebounds.max_time);
    }
  } else if (response.valid_after || response.valid_before) {
    if (response.valid_after) {
      context.minTime = Math.floor(Date.parse(response.valid_after) / 1000);
    }
    if (response.valid_before) {
      context.maxTime = Math.floor(Date.parse(response.valid_before) / 1000);
    }
  }

  if (context.minTime !== undefined || context.maxTime !== undefined) {
    context.currentTime = options.now ?? Math.floor(Date.now() / 1000);
  }

  return context;
}
