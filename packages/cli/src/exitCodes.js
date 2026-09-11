/**
 * CLI exit codes.
 *
 * `UNKNOWN` gets its own code, deliberately distinct from `ERROR`: an
 * analysis that correctly concludes "not enough evidence" is the tool
 * working as designed, not a process failure. Automation that wants to
 * treat UNKNOWN specially (e.g. escalate to a human) can branch on exit
 * code 2 without parsing output; automation that doesn't care can treat
 * any non-zero exit as "needs attention."
 */
export const EXIT_CODE = Object.freeze({
  /** Analysis completed; a decision was reached (SAFE_TO_RETRY, DO_NOT_RETRY, or RETRY_AFTER_ACTION). */
  OK: 0,
  /** CLI usage error, invalid input, decode failure, or network/runtime failure. */
  ERROR: 1,
  /** Analysis completed, but the decision itself is UNKNOWN. */
  UNKNOWN_RESULT: 2,
});
