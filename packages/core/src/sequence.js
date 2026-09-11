/**
 * Stellar account sequence numbers are the XDR type `SequenceNumber`
 * (`typedef int64 SequenceNumber`) — signed 64-bit integers, always
 * non-negative in practice. A real value is built from the ledger number
 * an account was created in: roughly `ledgerNumber << 32`. Once the
 * network's ledger number exceeds about 2^21 (~2 million — mainnet and
 * long-lived testnets passed this years ago), that construction routinely
 * exceeds `Number.MAX_SAFE_INTEGER` (2^53-1). Converting such a value with
 * `Number(...)` silently rounds it — `Number("19801804984287233")` is
 * `19801804984287230`, off by 3 — which is exactly the kind of unverified
 * inference this project refuses to make elsewhere. This module is the
 * one place sequence-number representation and comparison rules live, so
 * every rule and adapter that touches a sequence number uses it instead
 * of reimplementing (and potentially reintroducing this bug).
 *
 * **Public/serialized representation: decimal string.** `evaluateRetrySafety()`
 * results are JSON-oriented — `JSON.stringify`/`JSON.parse` have no
 * `BigInt` support at all (they throw / silently drop), so a `BigInt` in
 * `context.originalSequence` would break the moment a caller serialized a
 * result. A canonical decimal string round-trips through JSON perfectly
 * and is exactly what Horizon and stellar-rpc already hand back (Horizon's
 * `source_account_sequence` is `int64,string`-tagged XDR-to-JSON; this
 * package's own `@stellar-txguard/xdr` already returns envelope sequence
 * numbers as strings for the same reason).
 *
 * **Internal comparisons: `BigInt`.** `compareSequences()` below converts
 * to `BigInt` only for the duration of one comparison, and never returns
 * or stores a `BigInt` — nothing outside this module ever holds one.
 */

/** Stellar's `SequenceNumber` is `int64`; this is `2^63 - 1`. */
export const MAX_SEQUENCE = 9223372036854775807n;

const CANONICAL_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

/**
 * Checks whether `value` is a canonical decimal-string Stellar sequence
 * number: digits only, no sign, no leading zeros (other than the single
 * digit `"0"`), no decimal point, no surrounding whitespace, and within
 * `[0, 2^63-1]`.
 *
 * @param {unknown} value
 * @returns {string | null} a human-readable description of what's wrong
 *   with `value`, or `null` if it's valid.
 */
export function describeSequenceError(value) {
  if (typeof value !== "string") {
    return `must be a decimal string, got ${value === null ? "null" : typeof value}`;
  }
  if (!CANONICAL_DECIMAL_PATTERN.test(value)) {
    return `"${value}" is not a valid Stellar sequence number (expected a non-negative integer in canonical decimal form: digits only, no sign, no leading zeros, no decimal point, no whitespace)`;
  }
  if (BigInt(value) > MAX_SEQUENCE) {
    return `"${value}" exceeds the maximum possible Stellar sequence number (2^63-1 = ${MAX_SEQUENCE})`;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {boolean} `true` iff `describeSequenceError(value) === null`.
 */
export function isValidSequence(value) {
  return describeSequenceError(value) === null;
}

/**
 * Exactly compares two sequence-number strings via `BigInt` — never via
 * `Number` or `<`/`>` on the strings themselves (which would compare
 * lexicographically, not numerically). Both arguments must already be
 * valid per {@link isValidSequence}; this function does not itself
 * validate (callers are expected to have gone through
 * `evaluateRetrySafety()`'s input validation, which does).
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1} negative if `a < b`, zero if equal, positive if `a > b`.
 */
export function compareSequences(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  if (x === y) return 0;
  return x > y ? 1 : -1;
}
