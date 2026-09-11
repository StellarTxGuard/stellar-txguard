/**
 * Thin, read-only Horizon client. Never submits or signs anything — the
 * only request this module ever makes is `GET /transactions/{hash}`.
 *
 * `fetchImpl` is injectable so tests can run without real network access;
 * it defaults to the global `fetch` (available in Node 18+).
 */
export class HorizonRequestError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "HorizonRequestError";
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Fetches a transaction by hash from Horizon.
 *
 * @param {string} horizonUrl Base URL, e.g. "https://horizon-testnet.stellar.org".
 * @param {string} hash
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ status: "found", body: object } | { status: "not_found" } | { status: "uncertain", httpStatus: number }>}
 * @throws {HorizonRequestError} on a network failure or an unexpected response.
 */
export async function fetchHorizonTransaction(horizonUrl, hash, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new HorizonRequestError(
      "No fetch implementation available. This CLI requires Node 18+ (global fetch).",
    );
  }

  const url = `${horizonUrl.replace(/\/+$/, "")}/transactions/${encodeURIComponent(hash)}`;

  let response;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    throw new HorizonRequestError(`Could not reach Horizon at ${horizonUrl}: ${cause.message}`, {
      cause,
    });
  }

  if (response.status === 404) {
    return { status: "not_found" };
  }
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return { status: "uncertain", httpStatus: response.status };
  }

  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw new HorizonRequestError(
      `Horizon returned a response that was not valid JSON (HTTP ${response.status}).`,
      { cause },
    );
  }

  if (!response.ok) {
    throw new HorizonRequestError(
      `Horizon returned HTTP ${response.status}${body?.title ? `: ${body.title}` : ""}${body?.detail ? ` — ${body.detail}` : ""}`,
    );
  }

  return { status: "found", body };
}
