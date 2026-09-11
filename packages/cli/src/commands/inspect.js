import { resolveNetwork } from "../networks.js";
import { lookupTransaction } from "../lookup.js";
import { formatInspection } from "../output.js";
import { EXIT_CODE } from "../exitCodes.js";
import { buildContextFromArgs, resolveSource, validateHash } from "./shared.js";

/**
 * Implements `txguard inspect <hash>` — fetches and normalizes a
 * transaction, but stops before making a safety decision. Useful for
 * seeing exactly what evidence TxGuard has to work with (and what it
 * doesn't).
 *
 * @param {object} args
 * @param {(text: string) => void} print
 * @param {(text: string) => void} printError
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<number>} exit code
 */
export async function runInspect(args, print, printError, fetchImpl) {
  if (!args.hash) {
    printError("txguard inspect: missing required argument <transaction-hash>.");
    return EXIT_CODE.ERROR;
  }

  validateHash(args.hash);

  const { horizonUrl, rpcUrl } = resolveNetwork(args);
  const source = resolveSource(args);
  if (source === "rpc" && !rpcUrl) {
    printError(
      "txguard inspect: --source rpc requires --rpc-url (no default RPC endpoint is assumed).",
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

  print(formatInspection(normalized, { source: sourceDescription }));
  return EXIT_CODE.OK;
}
