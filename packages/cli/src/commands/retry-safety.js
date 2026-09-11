import { evaluateRetrySafety } from "@stellar-txguard/core";

import { resolveNetwork } from "../networks.js";
import { lookupTransaction } from "../lookup.js";
import { formatRetrySafetyReport } from "../output.js";
import { EXIT_CODE } from "../exitCodes.js";
import { buildContextFromArgs, resolveSource, validateHash } from "./shared.js";

/**
 * Implements `txguard retry-safety <hash>` — fetches a transaction,
 * normalizes it, and runs it through `evaluateRetrySafety()`. This command
 * never computes a safety decision itself; it only calls the existing core
 * evaluator and presents its result.
 *
 * @param {object} args
 * @param {(text: string) => void} print
 * @param {(text: string) => void} printError
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<number>} exit code — EXIT_CODE.OK if a definite
 *   decision was reached, EXIT_CODE.UNKNOWN_RESULT if the decision is
 *   UNKNOWN, EXIT_CODE.ERROR on a usage/lookup failure.
 */
export async function runRetrySafety(args, print, printError, fetchImpl) {
  if (!args.hash) {
    printError("txguard retry-safety: missing required argument <transaction-hash>.");
    return EXIT_CODE.ERROR;
  }

  validateHash(args.hash);

  const { horizonUrl, rpcUrl } = resolveNetwork(args);
  const source = resolveSource(args);
  if (source === "rpc" && !rpcUrl) {
    printError(
      "txguard retry-safety: --source rpc requires --rpc-url (no default RPC endpoint is assumed).",
    );
    return EXIT_CODE.ERROR;
  }

  const { normalized, sourceDescription } = await lookupTransaction({
    source,
    hash: args.hash,
    horizonUrl,
    rpcUrl,
    context: buildContextFromArgs(args),
    fetchImpl,
  });

  const result = evaluateRetrySafety(normalized);

  print(
    args.json
      ? JSON.stringify(result, null, 2)
      : formatRetrySafetyReport(result, {
          transactionHash: args.hash,
          source: sourceDescription,
        }),
  );

  return result.decision === "UNKNOWN" ? EXIT_CODE.UNKNOWN_RESULT : EXIT_CODE.OK;
}
