/**
 * Thin, read-only stellar-rpc JSON-RPC client. The only method this
 * module ever calls is `getTransaction` — never `sendTransaction`, and
 * never anything that signs or submits.
 *
 * `fetchImpl` is injectable so tests can run without real network access;
 * it defaults to the global `fetch` (available in Node 18+).
 */

import { formatUnreachableError } from "./networkError.js";

export class RpcRequestError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "RpcRequestError";
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Fetches a transaction by hash from a stellar-rpc endpoint via
 * `getTransaction`.
 *
 * @param {string} rpcUrl
 * @param {string} hash
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<object>} The JSON-RPC result payload (the
 *   `getTransaction` response body, suitable for `normalizeRpcTransaction`).
 * @throws {RpcRequestError} on a network failure, a non-2xx response, or a
 *   JSON-RPC-level error.
 */
export async function fetchRpcTransaction(rpcUrl, hash, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new RpcRequestError(
      "No fetch implementation available. This CLI requires Node 18+ (global fetch).",
    );
  }

  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: { hash },
      }),
    });
  } catch (cause) {
    throw new RpcRequestError(formatUnreachableError("RPC", rpcUrl, cause), {
      cause,
    });
  }

  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw new RpcRequestError(
      `RPC endpoint returned a response that was not valid JSON (HTTP ${response.status}).`,
      { cause },
    );
  }

  if (!response.ok) {
    throw new RpcRequestError(`RPC endpoint returned HTTP ${response.status}.`);
  }
  if (body.error) {
    throw new RpcRequestError(
      `RPC error ${body.error.code ?? ""}: ${body.error.message ?? "unknown error"}`.trim(),
    );
  }
  if (!body.result) {
    throw new RpcRequestError("RPC response did not include a result.");
  }

  return body.result;
}
