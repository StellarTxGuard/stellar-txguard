/**
 * Maps raw XDR-JSON result values (as produced by `@stellar/stellar-xdr-json`,
 * which mirrors the XDR enum names directly, e.g. `"tx_no_account"`) to the
 * lowercase `tx_*` / `op_*` strings StellarTxGuard's core rules expect,
 * which follow Horizon's developer-facing naming convention instead (e.g.
 * `"tx_no_source_account"`).
 *
 * These two vocabularies genuinely differ in places — this is not a
 * formatting nuance. The mapping below was verified directly against
 * Horizon's own `TransactionResultCode`/`OperationResultCode` → string
 * conversion (`internal/codes/main.go` in github.com/stellar/stellar-horizon,
 * fetched and cross-checked during Milestone 3's audit), so a value decoded
 * from raw XDR here produces the exact same string a caller would have
 * gotten from Horizon's `extras.result_codes`, for any given underlying
 * outcome.
 */

/** Transaction-level result codes (`TransactionResultResult`'s plain-string arm). */
export const TRANSACTION_RESULT_CODE_MAP = Object.freeze({
  tx_too_early: "tx_too_early",
  tx_too_late: "tx_too_late",
  tx_missing_operation: "tx_missing_operation",
  tx_bad_seq: "tx_bad_seq",
  tx_bad_auth: "tx_bad_auth",
  tx_insufficient_balance: "tx_insufficient_balance",
  // Horizon deliberately renames txNO_ACCOUNT to "tx_no_source_account" for
  // clarity; the raw XDR-JSON value is "tx_no_account".
  tx_no_account: "tx_no_source_account",
  tx_insufficient_fee: "tx_insufficient_fee",
  tx_bad_auth_extra: "tx_bad_auth_extra",
  tx_internal_error: "tx_internal_error",
  tx_not_supported: "tx_not_supported",
  tx_bad_sponsorship: "tx_bad_sponsorship",
  // Horizon's string for this is "tx_bad_minseq_age_or_gap" (no underscore
  // between "bad" and "minseq"); the raw XDR-JSON value is
  // "tx_bad_min_seq_age_or_gap".
  tx_bad_min_seq_age_or_gap: "tx_bad_minseq_age_or_gap",
  tx_malformed: "tx_malformed",
  tx_soroban_invalid: "tx_soroban_invalid",
  tx_frozen_key_accessed: "tx_frozen_key_accessed",
});

/**
 * Operation-level result codes shared across Payment, PathPaymentStrictReceive,
 * and PathPaymentStrictSend (identical failure semantics, identical Horizon
 * string per code, verified against Horizon's PaymentResultCode /
 * PathPaymentStrictReceiveResultCode / PathPaymentStrictSendResultCode
 * mappings). Raw XDR-JSON values for these are unprefixed (e.g. "no_trust"),
 * nested under `op_inner.payment.<value>` or
 * `op_inner.path_payment_strict_receive.<value>` etc.
 */
export const PAYMENT_LIKE_RESULT_CODE_MAP = Object.freeze({
  malformed: "op_malformed",
  underfunded: "op_underfunded",
  src_no_trust: "op_src_no_trust",
  src_not_authorized: "op_src_not_authorized",
  no_destination: "op_no_destination",
  no_trust: "op_no_trust",
  not_authorized: "op_not_authorized",
  line_full: "op_line_full",
  no_issuer: "op_no_issuer",
});

/**
 * Result codes unique to path payments (both StrictReceive and StrictSend
 * share "too_few_offers" and "offer_cross_self"; "over_sendmax" is
 * StrictReceive-only, "under_destmin" is StrictSend-only).
 */
export const PATH_PAYMENT_ONLY_RESULT_CODE_MAP = Object.freeze({
  too_few_offers: "op_too_few_offers",
  // Horizon's string for this is "op_cross_self", not "op_offer_cross_self"
  // — it's shared with ManageBuyOffer/ManageSellOffer's identical code.
  offer_cross_self: "op_cross_self",
  // StrictReceive only. Horizon's string is "op_over_source_max", not
  // "op_over_send_max".
  over_sendmax: "op_over_source_max",
  // StrictSend only.
  under_destmin: "op_under_dest_min",
});

/** Operation-level codes that apply regardless of operation type (`OperationResult`'s plain-string arm). */
export const GENERIC_OPERATION_RESULT_CODE_MAP = Object.freeze({
  op_bad_auth: "op_bad_auth",
  op_no_account: "op_no_source_account",
  op_not_supported: "op_not_supported",
  op_too_many_subentries: "op_too_many_subentries",
  op_exceeded_work_limit: "op_exceeded_work_limit",
  op_too_many_sponsoring: "op_too_many_sponsoring",
});

/**
 * Translates one decoded `OperationResult` (already parsed from XDR-JSON)
 * into a Horizon-style `op_*` string. Returns `null` for an operation type
 * this package does not have a mapping for (StellarTxGuard's rules only
 * cover Payment and the two path-payment operations today).
 *
 * @param {unknown} operationResult A single element of `result.tx_success`
 *   / `result.tx_failed` from the decoded `TransactionResult` JSON.
 * @returns {string | null}
 */
export function mapOperationResult(operationResult) {
  if (typeof operationResult === "string") {
    return GENERIC_OPERATION_RESULT_CODE_MAP[operationResult] ?? null;
  }
  const inner = operationResult?.op_inner;
  if (!inner || typeof inner !== "object") {
    return null;
  }

  if ("payment" in inner) {
    return mapPaymentLikeValue(inner.payment);
  }
  if ("path_payment_strict_receive" in inner) {
    return mapPathPaymentValue(inner.path_payment_strict_receive);
  }
  if ("path_payment_strict_send" in inner) {
    return mapPathPaymentValue(inner.path_payment_strict_send);
  }
  return null;
}

function mapPaymentLikeValue(value) {
  // PaymentResult's every arm (including "success" and "no_issuer") is void
  // in the XDR, so the decoded JSON value is always a plain string.
  if (typeof value !== "string") {
    return null;
  }
  return PAYMENT_LIKE_RESULT_CODE_MAP[value] ?? null;
}

function mapPathPaymentValue(value) {
  // Unlike PaymentResult, PathPayment*Result's NO_ISSUER arm carries the
  // offending Asset as a payload, so it decodes as `{ no_issuer: <Asset> }`
  // rather than the plain string "no_issuer".
  if (typeof value !== "string") {
    if (value && typeof value === "object" && "no_issuer" in value) {
      return "op_no_issuer";
    }
    return null;
  }
  return (
    PAYMENT_LIKE_RESULT_CODE_MAP[value] ?? PATH_PAYMENT_ONLY_RESULT_CODE_MAP[value] ?? null
  );
}

/**
 * Translates a decoded transaction-level result code (the plain-string arm
 * of `TransactionResultResult`) into StellarTxGuard's `tx_*` vocabulary.
 *
 * @param {string} code
 * @returns {string | null}
 */
export function mapTransactionResultCode(code) {
  return TRANSACTION_RESULT_CODE_MAP[code] ?? null;
}
