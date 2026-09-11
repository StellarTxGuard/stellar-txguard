/**
 * Shared helpers for adapters. Kept tiny and dependency-free on purpose —
 * adapters translate network response shapes into the evaluator's input
 * shape, they do not add behavior of their own.
 */

import { TxGuardAdapterError } from "./errors.js";
import { NORMALIZED_STATE } from "./states.js";

/**
 * Returns a shallow copy of `obj` with all `undefined`-valued keys
 * removed, so adapters can build result objects with optional fields
 * without scattering `if (x !== undefined)` checks everywhere.
 *
 * @param {object} obj
 * @returns {object}
 */
export function omitUndefined(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Returns `obj` with undefined keys removed, or `undefined` itself if the
 * result would be empty. Used for optional "raw evidence" bags so an
 * adapter never attaches an empty `raw: {}` to a normalized object.
 *
 * @param {object} obj
 * @returns {object|undefined}
 */
export function nonEmptyOrUndefined(obj) {
  const cleaned = omitUndefined(obj);
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * Extracts the `context` fields `evaluateRetrySafety()` understands from
 * an adapter's `options` argument. None of these are present on Horizon or
 * RPC transaction responses themselves (sequence "current as of now",
 * "verified no prior success", and "moves funds" are all judgments the
 * caller's application layer must supply), so adapters accept them as an
 * optional second argument rather than inventing them from response data.
 *
 * @param {object} [options]
 * @returns {object}
 */
export function pickContext(options = {}) {
  return omitUndefined({
    originalSequence: options.originalSequence,
    currentSequence: options.currentSequence,
    minTime: options.minTime,
    maxTime: options.maxTime,
    currentTime: options.currentTime,
    verifiedNoPriorSuccess: options.verifiedNoPriorSuccess,
    movesFunds: options.movesFunds,
  });
}

/**
 * Applies an optional, caller-supplied XDR decoder to a normalized object,
 * in two independent ways:
 *
 * 1. **Result decoding**: if the object fell back to the synthetic
 *    `tx_failed_undecoded` result code and raw `resultXdr` is available,
 *    replaces that fallback with `xdrDecoder.decodeTransactionResultXdr()`'s
 *    structured result — exactly as before envelope decoding existed.
 * 2. **Envelope decoding**: if raw `envelopeXdr` is available and
 *    `xdrDecoder.decodeTransactionEnvelopeXdr` is provided, fills in
 *    `context.originalSequence` / `context.minTime` / `context.maxTime` /
 *    `context.currentTime` — but only the ones not already known from a
 *    more authoritative source (an explicit `options` value, or a field
 *    Horizon/RPC already gave us directly, e.g. Horizon's
 *    `source_account_sequence`). This is most useful exactly where those
 *    more authoritative sources don't exist — e.g. a Horizon submission-
 *    error body carries no `source_account_sequence` field at all, so
 *    envelope decoding is the only way to get `tx_bad_seq` sequence
 *    evidence there without the caller supplying it by hand.
 *
 * `xdrDecoder` is duck-typed to match `@stellar-txguard/xdr`'s exports
 * (`{ decodeTransactionResultXdr, decodeTransactionEnvelopeXdr }`, either
 * independently optional) but this module never imports that package —
 * adapters, and therefore `@stellar-txguard/core` as a whole, have no hard
 * dependency on it. A caller who wants XDR decoding installs
 * `@stellar-txguard/xdr` themselves and passes its functions in; a caller
 * who doesn't gets the exact same dependency-free behavior as before.
 *
 * The return type follows one predictable rule: if `options.xdrDecoder` is
 * omitted, this returns `normalized` synchronously (no Promise, no
 * behavior change from before this option existed). If it is provided,
 * this *always* returns a Promise — even on the calls where no decoding
 * actually turns out to be necessary — so a caller who opts in never has
 * to guess per-call whether to `await`.
 *
 * @param {object} normalized
 * @param {object} [options]
 * @param {{decodeTransactionResultXdr?: (xdr: string) => Promise<object>, decodeTransactionEnvelopeXdr?: (xdr: string) => Promise<object>}} [options.xdrDecoder]
 * @param {number} [options.now] Unix seconds to treat as "now" when an
 *   envelope's timebounds are decoded, paired with `context.currentTime`
 *   (same meaning as the adapters' own `options.now`). Defaults to the
 *   current time.
 * @returns {object | Promise<object>}
 */
export function applyXdrDecoder(normalized, options = {}) {
  const xdrDecoder = options.xdrDecoder;
  if (!xdrDecoder) {
    return normalized;
  }
  return decodeWithXdr(normalized, xdrDecoder, options);
}

async function decodeWithXdr(normalized, xdrDecoder, options) {
  let result = normalized;

  const resultXdr = result.raw?.resultXdr;
  if (
    typeof xdrDecoder.decodeTransactionResultXdr === "function" &&
    result.resultCode === "tx_failed_undecoded" &&
    resultXdr
  ) {
    const decoded = await xdrDecoder.decodeTransactionResultXdr(resultXdr);
    result = mergeDecodedResult(result, decoded);
  }

  const envelopeXdr = result.raw?.envelopeXdr;
  if (typeof xdrDecoder.decodeTransactionEnvelopeXdr === "function" && envelopeXdr) {
    const decodedEnvelope = await xdrDecoder.decodeTransactionEnvelopeXdr(envelopeXdr);
    result = mergeDecodedEnvelopeContext(result, decodedEnvelope, options);
  }

  return result;
}

function mergeDecodedResult(normalized, decoded) {
  const merged = { ...normalized };
  if (decoded.feeBump) {
    merged.resultCode = decoded.resultCode; // tx_fee_bump_inner_success | _failed
    merged.isFeeBump = true;
    merged.innerResultCode = decoded.innerResultCode ?? undefined;
    if (decoded.innerOperationResults?.length) {
      merged.innerOperationResultCodes = decoded.innerOperationResults;
    }
  } else {
    merged.resultCode = decoded.resultCode;
    if (decoded.operationResults?.length) {
      merged.operationResultCodes = decoded.operationResults;
    }
  }
  return omitUndefined(merged);
}

/**
 * Fills `context.originalSequence` / `minTime` / `maxTime` / `currentTime`
 * from a decoded envelope, but only where `normalized.context` doesn't
 * already have a value — an explicit `options` value or a field the
 * response supplied directly always wins over what we derive ourselves by
 * decoding. `decodedEnvelope.sequence` is already a canonical decimal
 * string (as is `context.originalSequence` — see `../sequence.js`), so
 * it's copied through verbatim, never wrapped in `Number(...)`: real
 * Stellar sequence numbers routinely exceed `Number.MAX_SAFE_INTEGER`,
 * and `Number()` would silently round them.
 */
function mergeDecodedEnvelopeContext(normalized, decodedEnvelope, options) {
  const context = { ...(normalized.context ?? {}) };
  let changed = false;

  if (context.originalSequence === undefined && decodedEnvelope.sequence !== undefined) {
    context.originalSequence = decodedEnvelope.sequence;
    changed = true;
  }

  const timeBounds = decodedEnvelope.timeBounds;
  if (timeBounds) {
    // A bound of 0 means "unset" per XDR convention (see docs on
    // DecodedTransactionEnvelope.timeBounds) — never treated as a real value.
    if (context.minTime === undefined && timeBounds.minTime) {
      context.minTime = timeBounds.minTime;
      changed = true;
    }
    if (context.maxTime === undefined && timeBounds.maxTime) {
      context.maxTime = timeBounds.maxTime;
      changed = true;
    }
    if (
      context.currentTime === undefined &&
      (context.minTime !== undefined || context.maxTime !== undefined)
    ) {
      context.currentTime = options.now ?? Math.floor(Date.now() / 1000);
      changed = true;
    }
  }

  if (!changed) {
    return normalized;
  }
  return { ...normalized, context: omitUndefined(context) };
}

/**
 * The four submission-outcome statuses shared verbatim between stellar-rpc's
 * `sendTransaction` and Horizon's `POST /transactions_async` — both are
 * thin wrappers around the same underlying stellar-core classification
 * (`stellarcore.TXStatus{Pending,Duplicate,TryAgainLater,Error}`), so both
 * adapters normalize them through {@link normalizeSubmissionStatus} rather
 * than each reimplementing this logic.
 */
export const SUBMISSION_STATUSES = new Set(["PENDING", "DUPLICATE", "TRY_AGAIN_LATER", "ERROR"]);

/**
 * Normalizes one of the four shared submission-outcome statuses into
 * `evaluateRetrySafety()` input. Used by `adapters/rpc.js` (stellar-rpc
 * `sendTransaction`) and `adapters/horizon.js` (Horizon
 * `POST /transactions_async`) — see {@link SUBMISSION_STATUSES}.
 *
 * `"PENDING"` means the node freshly accepted the submission — normalizes
 * to `transactionStatus: "PENDING"`. `"DUPLICATE"` means this exact
 * envelope was already known to the node; the recommended action is
 * identical (poll, don't resubmit), so it also normalizes to
 * `transactionStatus: "PENDING"`, but is kept distinguishable via
 * `context.duplicateSubmission: true` and `observedState: "DUPLICATE"`
 * rather than being silently folded into an ordinary PENDING. Both are
 * genuinely still-in-flight, not confirmed outcomes — a caller must not
 * read either as "safe to submit something else."
 * `"TRY_AGAIN_LATER"` means the node's queue declined the submission
 * outright (never processed) — normalizes to the synthetic result code
 * `rpc_try_again_later` (kept, not renamed, even for the Horizon caller:
 * it is the exact same underlying condition, and renaming it would be a
 * breaking change to an already-documented, already-tested result code).
 * `"ERROR"` means the node synchronously rejected the envelope — a
 * confirmed rejection, normalized to `tx_failed_undecoded` unless
 * `options.resultCode` (or `options.xdrDecoder`) resolves it further.
 *
 * @param {string} status One of {@link SUBMISSION_STATUSES}.
 * @param {object} fields
 * @param {string} [fields.hash]
 * @param {string} [fields.errorResultXdr] Raw, undecoded; only meaningful
 *   when `status` is `"ERROR"`.
 * @param {string[]} [fields.diagnosticEventsXdr] Raw, undecoded; only ever
 *   present on stellar-rpc's `sendTransaction` (Horizon's async submission
 *   response does not carry this field).
 * @param {object} options Same `options` the calling adapter received —
 *   `options.transactionHash` / `options.envelopeXdr` are used as
 *   fallbacks when the response itself doesn't carry them.
 * @returns {object}
 */
export function normalizeSubmissionStatus(status, fields, options) {
  const transactionHash = fields.hash || options.transactionHash;
  const raw = nonEmptyOrUndefined({
    errorResultXdr: fields.errorResultXdr,
    diagnosticEventsXdr: fields.diagnosticEventsXdr,
    envelopeXdr: options.envelopeXdr,
  });

  switch (status) {
    case "PENDING":
      return omitUndefined({
        transactionStatus: "PENDING",
        transactionHash,
        context: pickContext(options),
        observedState: NORMALIZED_STATE.PENDING,
        raw: nonEmptyOrUndefined({ envelopeXdr: options.envelopeXdr }),
      });

    case "DUPLICATE":
      return omitUndefined({
        transactionStatus: "PENDING",
        transactionHash,
        context: { ...pickContext(options), duplicateSubmission: true },
        observedState: NORMALIZED_STATE.DUPLICATE,
        raw: nonEmptyOrUndefined({ envelopeXdr: options.envelopeXdr }),
      });

    case "TRY_AGAIN_LATER":
      return omitUndefined({
        transactionStatus: "FAILED",
        resultCode: "rpc_try_again_later",
        transactionHash,
        context: pickContext(options),
        observedState: NORMALIZED_STATE.UNKNOWN,
        raw: nonEmptyOrUndefined({ envelopeXdr: options.envelopeXdr }),
      });

    case "ERROR":
      return omitUndefined({
        transactionStatus: "FAILED",
        resultCode: options.resultCode ?? "tx_failed_undecoded",
        operationResultCodes: options.operationResultCodes,
        transactionHash,
        context: pickContext(options),
        observedState: NORMALIZED_STATE.CONFIRMED_FAILURE,
        raw,
      });

    default:
      // Unreachable when callers guard with SUBMISSION_STATUSES.has() first.
      throw new TxGuardAdapterError(`Unhandled submission status "${status}".`);
  }
}
