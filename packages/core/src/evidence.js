import {
  VALID_CONFIDENCE_LEVELS,
  VALID_DECISIONS,
  VALID_RISKS,
} from "./decisions.js";

/**
 * @typedef {object} RetrySafetyResult
 * @property {string} decision One of DECISION.
 * @property {string} risk One of RISK.
 * @property {string} reasonCode The normalized result code this decision was based on.
 * @property {string} confidence One of CONFIDENCE.
 * @property {string} summary A short, human-readable explanation of the decision.
 * @property {string[]} evidence The specific facts that led to the decision.
 * @property {string[]} recommendedActions Concrete next steps for the caller.
 */

/**
 * Builds a {@link RetrySafetyResult}, validating that every rule produces a
 * consistent, complete shape. This is the single place where the result
 * contract is enforced, so every rule module goes through it rather than
 * constructing plain object literals independently.
 *
 * @param {object} params
 * @param {string} params.decision
 * @param {string} params.risk
 * @param {string} params.reasonCode
 * @param {string} params.confidence
 * @param {string} params.summary
 * @param {string[]} [params.evidence]
 * @param {string[]} [params.recommendedActions]
 * @returns {RetrySafetyResult}
 */
export function buildResult({
  decision,
  risk,
  reasonCode,
  confidence,
  summary,
  evidence = [],
  recommendedActions = [],
}) {
  if (!VALID_DECISIONS.has(decision)) {
    throw new Error(`Internal error: invalid decision "${decision}".`);
  }
  if (!VALID_RISKS.has(risk)) {
    throw new Error(`Internal error: invalid risk "${risk}".`);
  }
  if (!VALID_CONFIDENCE_LEVELS.has(confidence)) {
    throw new Error(`Internal error: invalid confidence "${confidence}".`);
  }
  if (typeof reasonCode !== "string" || reasonCode.length === 0) {
    throw new Error("Internal error: reasonCode must be a non-empty string.");
  }
  if (typeof summary !== "string" || summary.length === 0) {
    throw new Error("Internal error: summary must be a non-empty string.");
  }

  return {
    decision,
    risk,
    reasonCode,
    confidence,
    summary,
    evidence: [...evidence],
    recommendedActions: [...recommendedActions],
  };
}
