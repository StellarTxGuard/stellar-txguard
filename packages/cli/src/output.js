/**
 * Human-readable formatting for a `RetrySafetyResult` (the object
 * `evaluateRetrySafety()` returns). This is presentation only — every
 * field printed here comes directly from that result object; nothing is
 * computed or asserted independently of it.
 */

/**
 * @param {import("@stellar-txguard/core").RetrySafetyResult} result
 * @param {object} [meta]
 * @param {string} [meta.transactionHash]
 * @param {string} [meta.source] e.g. "Horizon (https://horizon-testnet.stellar.org)"
 * @returns {string}
 */
export function formatRetrySafetyReport(result, meta = {}) {
  const lines = [];

  if (meta.transactionHash) {
    lines.push(`Transaction: ${meta.transactionHash}`);
  }
  if (meta.source) {
    lines.push(`Source: ${meta.source}`);
  }
  if (lines.length > 0) {
    lines.push("");
  }

  lines.push(`Decision: ${result.decision}`);
  lines.push(`Risk: ${result.risk}`);
  lines.push(`Confidence: ${result.confidence.toUpperCase()}`);
  lines.push("");
  lines.push("Reason:");
  lines.push(wrap(result.summary));

  if (result.evidence.length > 0) {
    lines.push("");
    lines.push("Evidence:");
    for (const item of result.evidence) {
      lines.push(`  - ${item}`);
    }
  }

  if (result.recommendedActions.length > 0) {
    lines.push("");
    lines.push(result.recommendedActions.length === 1 ? "Recommended action:" : "Recommended actions:");
    for (const action of result.recommendedActions) {
      lines.push(`  - ${action}`);
    }
  }

  return lines.join("\n");
}

/**
 * @param {import("@stellar-txguard/core") ? object : object} normalized The
 *   normalized `evaluateRetrySafety()` input (from an adapter).
 * @param {object} [meta]
 * @returns {string}
 */
export function formatInspection(normalized, meta = {}) {
  const lines = [];
  if (meta.source) {
    lines.push(`Source: ${meta.source}`);
    lines.push("");
  }
  lines.push(JSON.stringify(normalized, null, 2));
  return lines.join("\n");
}

function wrap(text, width = 78) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if (current.length > 0 && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current.length > 0 ? `${current} ${word}` : word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.join("\n");
}
