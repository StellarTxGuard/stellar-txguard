/**
 * Thrown when XDR cannot be decoded — invalid base64, truncated/corrupt
 * bytes, or bytes that don't match the requested XDR type. Deliberately
 * never swallowed into a fallback value: per StellarTxGuard's core safety
 * principle, an input that can't be understood must produce a clear error,
 * not a guessed-at "safe-looking" structured result.
 */
export class TxGuardXdrDecodeError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "TxGuardXdrDecodeError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
