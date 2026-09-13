import { parseArgs } from "node:util";

import { EXIT_CODE } from "./exitCodes.js";
import { runDecode } from "./commands/decode.js";
import { runInspect } from "./commands/inspect.js";
import { runRetrySafety } from "./commands/retry-safety.js";

const VERSION = "0.1.0";

const HELP = `txguard — analyze whether retrying a Stellar transaction is safe.

StellarTxGuard is an analysis tool. It never signs, submits, or resends a
transaction; it only reads transaction state and explains whether a retry
would be safe, given observable evidence.

Usage:
  txguard decode <xdr> [--type result|envelope] [--json]
  txguard inspect <transaction-hash> [network options] [--json]
  txguard retry-safety <transaction-hash> [network options] [--json]
  txguard --help
  txguard --version

Commands:
  decode          Decode TransactionResult/TransactionEnvelope XDR into
                  structured information. Makes no safety judgment.
  inspect         Fetch and normalize a transaction (by hash), and print
                  what TxGuard observed, without evaluating retry safety.
  retry-safety    Fetch, normalize, and evaluate a transaction: prints the
                  decision (SAFE_TO_RETRY / DO_NOT_RETRY / RETRY_AFTER_ACTION
                  / UNKNOWN), risk, confidence, evidence, and recommended
                  actions.

Network options (inspect, retry-safety):
  --network <name>       testnet (default) | mainnet | futurenet
  --horizon-url <url>     Overrides the Horizon endpoint for --network.
  --rpc-url <url>         RPC endpoint (required for --source rpc; no
                          default is assumed).
  --source <horizon|rpc>  Which backend to query. Defaults to "horizon",
                          or "rpc" if --rpc-url is given without --horizon-url.

Evaluation context (inspect, retry-safety) — evidence only you can supply:
  --current-sequence <n>         The source account's current sequence number,
                                 as a decimal integer (e.g. 19801804984287233).
                                 Stellar sequence numbers exceed what a double-
                                 precision float can represent exactly, so this
                                 is parsed as an exact integer, never a
                                 JavaScript number.
  --verified-no-prior-success   You've checked history; no prior submission
                                 for this intent succeeded.
  --moves-funds <true|false>    Whether the operation moves value (default true).

Other options:
  --json          Machine-readable JSON on stdout only (no extra text).
                  Errors still go to stderr.
  --help, -h      Show this help.
  --version       Show the CLI version.

Exit codes:
  0   Analysis completed; a decision was reached (or decode succeeded).
  1   Usage error, decode failure, or network/runtime error.
  2   Analysis completed, but the decision is UNKNOWN.
`;

/**
 * Runs the CLI against a parsed argv (excluding the node/script path
 * entries — i.e. `process.argv.slice(2)`). Never calls `process.exit()`
 * itself, so it can be called from tests.
 *
 * @param {string[]} argv
 * @param {object} [io]
 * @param {(text: string) => void} [io.print] Defaults to `console.log`.
 * @param {(text: string) => void} [io.printError] Defaults to `console.error`.
 * @param {typeof fetch} [io.fetchImpl] Injectable for tests.
 * @returns {Promise<number>} exit code
 */
export async function runCli(argv, io = {}) {
  const print = io.print ?? console.log;
  const printError = io.printError ?? console.error;
  const fetchImpl = io.fetchImpl;

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    print(HELP);
    return argv.length === 0 ? EXIT_CODE.ERROR : EXIT_CODE.OK;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    print(VERSION);
    return EXIT_CODE.OK;
  }

  const [command, ...rest] = argv;

  let args;
  try {
    args = parseCommandArgs(command, rest);
  } catch (error) {
    printError(`txguard: ${error.message}`);
    return EXIT_CODE.ERROR;
  }

  try {
    switch (command) {
      case "decode":
        return await runDecode(args, print, printError);
      case "inspect":
        return await runInspect(args, print, printError, fetchImpl);
      case "retry-safety":
        return await runRetrySafety(args, print, printError, fetchImpl);
      default:
        printError(`txguard: unknown command "${command}".\n\n${HELP}`);
        return EXIT_CODE.ERROR;
    }
  } catch (error) {
    printError(`txguard: ${error.message}`);
    if (process.env.TXGUARD_DEBUG) {
      printError(error.stack);
    }
    return EXIT_CODE.ERROR;
  }
}

const OPTION_SPECS = {
  decode: {
    type: { type: "string" },
    json: { type: "boolean" },
  },
  inspect: {
    network: { type: "string" },
    "horizon-url": { type: "string" },
    "rpc-url": { type: "string" },
    source: { type: "string" },
    "current-sequence": { type: "string" },
    "verified-no-prior-success": { type: "boolean" },
    "moves-funds": { type: "string" },
    json: { type: "boolean" },
  },
};
OPTION_SPECS["retry-safety"] = OPTION_SPECS.inspect;

function parseCommandArgs(command, rest) {
  const spec = OPTION_SPECS[command];
  if (!spec) {
    // Let the caller report "unknown command"; still try to surface a
    // parse error for genuinely malformed input rather than crash later.
    return { _positionals: rest.filter((a) => !a.startsWith("-")) };
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: spec,
    allowPositionals: true,
    strict: true,
  });

  return {
    xdr: positionals[0],
    hash: positionals[0],
    type: values.type,
    network: values.network,
    horizonUrl: values["horizon-url"],
    rpcUrl: values["rpc-url"],
    source: values.source,
    currentSequence: values["current-sequence"],
    verifiedNoPriorSuccess: values["verified-no-prior-success"],
    movesFunds: values["moves-funds"],
    json: values.json ?? false,
  };
}
