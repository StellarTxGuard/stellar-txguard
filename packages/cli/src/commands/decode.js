import {
  decodeTransactionEnvelopeXdr,
  decodeTransactionResultXdr,
  TxGuardXdrDecodeError,
} from "@stellar-txguard/xdr";

import { EXIT_CODE } from "../exitCodes.js";

const DECODERS = {
  result: { fn: decodeTransactionResultXdr, label: "TransactionResult" },
  envelope: { fn: decodeTransactionEnvelopeXdr, label: "TransactionEnvelope" },
};

/**
 * Implements `txguard decode <xdr>`.
 *
 * Decodes structured information out of raw XDR — never makes a
 * retry-safety decision. If `--type` isn't given, tries `TransactionResult`
 * first, then `TransactionEnvelope`; if both fail, reports both errors
 * concisely rather than a raw stack trace.
 *
 * Successful output goes to `print` (stdout); usage errors and decode
 * failures go to `printError` (stderr), matching the exit code (1) they
 * produce.
 *
 * @param {object} args
 * @param {string} args.xdr
 * @param {"result"|"envelope"} [args.type]
 * @param {boolean} [args.json]
 * @param {(text: string) => void} print
 * @param {(text: string) => void} printError
 * @returns {Promise<number>} exit code
 */
export async function runDecode(args, print, printError) {
  if (!args.xdr) {
    printError(
      "txguard decode: missing required argument <xdr>.\nUsage: txguard decode <xdr> [--type result|envelope] [--json]",
    );
    return EXIT_CODE.ERROR;
  }

  if (args.type) {
    const decoder = DECODERS[args.type];
    if (!decoder) {
      printError(`txguard decode: unknown --type "${args.type}". Expected "result" or "envelope".`);
      return EXIT_CODE.ERROR;
    }
    return decodeOne(decoder, args.xdr, args.json, print, printError);
  }

  // No --type: try TransactionResult, then TransactionEnvelope.
  try {
    const decoded = await DECODERS.result.fn(args.xdr);
    print(formatDecoded("TransactionResult", decoded, args.json));
    return EXIT_CODE.OK;
  } catch (resultError) {
    try {
      const decoded = await DECODERS.envelope.fn(args.xdr);
      print(formatDecoded("TransactionEnvelope", decoded, args.json));
      return EXIT_CODE.OK;
    } catch (envelopeError) {
      printError(formatDecodeFailure(resultError, envelopeError));
      return EXIT_CODE.ERROR;
    }
  }
}

async function decodeOne({ fn, label }, xdr, json, print, printError) {
  try {
    const decoded = await fn(xdr);
    print(formatDecoded(label, decoded, json));
    return EXIT_CODE.OK;
  } catch (error) {
    if (error instanceof TxGuardXdrDecodeError) {
      printError(
        json
          ? JSON.stringify({ error: error.message }, null, 2)
          : `Could not decode as ${label}: ${error.message}`,
      );
      return EXIT_CODE.ERROR;
    }
    throw error;
  }
}

function formatDecoded(label, decoded, json) {
  if (json) {
    return JSON.stringify({ type: label, ...decoded }, null, 2);
  }
  const lines = [`Decoded as: ${label}`, ""];
  for (const [key, value] of Object.entries(decoded)) {
    lines.push(`${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : value}`);
  }
  return lines.join("\n");
}

function formatDecodeFailure(resultError, envelopeError) {
  return [
    "Could not decode this XDR as either a TransactionResult or a TransactionEnvelope.",
    `  As TransactionResult: ${resultError.message}`,
    `  As TransactionEnvelope: ${envelopeError.message}`,
    "Pass --type result or --type envelope if you know which one this is.",
  ].join("\n");
}
