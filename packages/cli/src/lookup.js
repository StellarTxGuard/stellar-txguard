import { normalizeHorizonTransaction, normalizeRpcTransaction } from "@stellar-txguard/core";
import { decodeTransactionEnvelopeXdr, decodeTransactionResultXdr } from "@stellar-txguard/xdr";

import { fetchHorizonTransaction } from "./horizonClient.js";
import { fetchRpcTransaction } from "./rpcClient.js";

const xdrDecoder = { decodeTransactionResultXdr, decodeTransactionEnvelopeXdr };

/**
 * Fetches a transaction by hash and normalizes it into
 * `evaluateRetrySafety()` input — the one lookup path both `inspect` and
 * `retry-safety` share, so neither command reimplements this.
 *
 * XDR decoding is always attempted when the source is Horizon or RPC
 * (`options.xdrDecoder` is always passed to the adapter) — this CLI already
 * depends on `@stellar-txguard/xdr`, so there is no dependency-weight
 * reason to make it opt-in here the way the library API does.
 *
 * @param {object} params
 * @param {"horizon"|"rpc"} params.source
 * @param {string} params.hash
 * @param {string} [params.horizonUrl]
 * @param {string} [params.rpcUrl]
 * @param {object} [params.context] Extra evaluator context
 *   (originalSequence, currentSequence, verifiedNoPriorSuccess, movesFunds).
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<{ normalized: object, sourceDescription: string }>}
 */
export async function lookupTransaction({
  source,
  hash,
  horizonUrl,
  rpcUrl,
  context = {},
  fetchImpl,
}) {
  if (source === "horizon") {
    const result = await fetchHorizonTransaction(horizonUrl, hash, { fetchImpl });
    const sourceDescription = `Horizon (${horizonUrl})`;

    if (result.status === "not_found") {
      return {
        sourceDescription,
        normalized: { submissionStatus: "NOT_FOUND", transactionHash: hash, context },
      };
    }
    if (result.status === "uncertain") {
      return {
        sourceDescription,
        normalized: { httpStatus: result.httpStatus, transactionHash: hash, context },
      };
    }

    const normalized = await normalizeHorizonTransaction(result.body, { xdrDecoder, ...context });
    return { sourceDescription, normalized };
  }

  if (source === "rpc") {
    const result = await fetchRpcTransaction(rpcUrl, hash, { fetchImpl });
    const normalized = await normalizeRpcTransaction(result, {
      xdrDecoder,
      transactionHash: hash,
      ...context,
    });
    return { sourceDescription: `RPC (${rpcUrl})`, normalized };
  }

  throw new Error(`Unknown source "${source}". Expected "horizon" or "rpc".`);
}
