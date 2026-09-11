/**
 * Thrown when an adapter is given a response that does not match any
 * recognized shape for that network API (not a structurally invalid
 * `evaluateRetrySafety()` input — see `TxGuardValidationError` for that).
 */
export class TxGuardAdapterError extends Error {
  constructor(message) {
    super(message);
    this.name = "TxGuardAdapterError";
  }
}
