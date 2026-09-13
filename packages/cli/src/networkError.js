/**
 * Turns a fetch/network failure into a short, actionable CLI message.
 * Never includes a stack trace or the raw undici/fetch error text — those
 * stay on `error.cause` for `TXGUARD_DEBUG`.
 */

/**
 * Walks `error.cause` so Node's `TypeError: fetch failed` wrapping an
 * `ECONNREFUSED` (or similar) is classified from the underlying code, not
 * the outer "fetch failed" string.
 *
 * @param {unknown} error
 * @returns {string}
 */
function collectErrorText(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current.name) parts.push(String(current.name));
    if (current.message) parts.push(String(current.message));
    if (current.code) parts.push(String(current.code));
    current = current.cause;
  }
  if (typeof error === "string") {
    parts.push(error);
  }
  return parts.join(" ");
}

/**
 * @param {unknown} cause
 * @returns {string} a short reason, e.g. "connection refused"
 */
export function describeNetworkFailure(cause) {
  const text = collectErrorText(cause);
  const name = cause && typeof cause === "object" ? cause.name : "";

  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /\bAbortError\b|\bTimeoutError\b|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timed out|\btimeout\b/i.test(
      text,
    )
  ) {
    return "request timed out";
  }
  if (/ERR_INVALID_URL|Invalid URL|Failed to parse URL/i.test(text)) {
    return "invalid URL";
  }
  if (/ENOTFOUND|getaddrinfo/i.test(text)) {
    return "host not found";
  }
  if (/ECONNREFUSED/i.test(text)) {
    return "connection refused";
  }
  if (/ENETUNREACH|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|UND_ERR_SOCKET/i.test(text)) {
    return "network unreachable";
  }
  return "network error";
}

/**
 * @param {"Horizon"|"RPC"} service
 * @param {string} url
 * @param {unknown} cause
 * @returns {string}
 */
export function formatUnreachableError(service, url, cause) {
  const reason = describeNetworkFailure(cause);
  const label = service === "Horizon" ? "Horizon" : "RPC endpoint";
  const flag = service === "Horizon" ? "--horizon-url" : "--rpc-url";
  return (
    `Could not reach ${label} at ${url} (${reason}). ` +
    `Check that the URL is correct and the network is reachable, or pass ${flag} to use a different endpoint.`
  );
}
