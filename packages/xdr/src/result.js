import { decodeXdrJson } from "./wasm.js";
import { TxGuardXdrDecodeError } from "./errors.js";
import { mapOperationResult, mapTransactionResultCode } from "./codes.js";

const FEE_BUMP_ARMS = new Set(["tx_fee_bump_inner_success", "tx_fee_bump_inner_failed"]);
const OPERATION_RESULT_ARMS = new Set(["tx_success", "tx_failed"]);

/**
 * @typedef {object} DecodedTransactionResult
 * @property {string} resultCode StellarTxGuard's `tx_*` vocabulary (see
 *   codes.js), or a raw XDR-JSON value with a `tx_` prefix stripped-and-
 *   restored as a last resort if this package has no mapping for it yet
 *   (see note below).
 * @property {boolean} feeBump Whether this is a fee-bump outer result.
 * @property {string[]} operationResults Per-operation `op_*` result codes,
 *   present when resultCode implies an operations array (`tx_success` /
 *   `tx_failed`, or the inner transaction's equivalent for a fee bump).
 *   Entries this package can't map to a known code are omitted rather than
 *   guessed at — check `raw.resultXdr` manually for full fidelity.
 * @property {string | null} innerResultCode Set when `feeBump` is true and
 *   the inner transaction's own outcome was decoded.
 * @property {string[] | null} innerOperationResults
 * @property {{ resultXdr: string }} raw
 */

/**
 * Decodes a base64 `TransactionResult` XDR value (Horizon's `result_xdr`,
 * stellar-rpc's `resultXdr`) into structured information.
 *
 * This function only decodes — it does not make a retry-safety decision.
 * Feed its output into `evaluateRetrySafety()` (directly, or via an
 * adapter's `xdrDecoder` option) for that.
 *
 * @param {string} resultXdr
 * @returns {Promise<DecodedTransactionResult>}
 * @throws {TxGuardXdrDecodeError} if `resultXdr` is not valid TransactionResult XDR.
 */
export async function decodeTransactionResultXdr(resultXdr) {
  const decoded = await decodeXdrJson("TransactionResult", resultXdr);
  const raw = { resultXdr };

  const result = decoded?.result;
  if (result === undefined) {
    throw new TxGuardXdrDecodeError(
      "Decoded TransactionResult was missing its `result` field.",
    );
  }

  if (typeof result === "string") {
    const mapped = mapTransactionResultCode(result);
    return {
      resultCode: mapped ?? result,
      feeBump: false,
      operationResults: [],
      innerResultCode: null,
      innerOperationResults: null,
      raw,
    };
  }

  const [armName] = Object.keys(result);

  if (OPERATION_RESULT_ARMS.has(armName)) {
    return {
      resultCode: armName,
      feeBump: false,
      operationResults: mapOperationResults(result[armName]),
      innerResultCode: null,
      innerOperationResults: null,
      raw,
    };
  }

  if (FEE_BUMP_ARMS.has(armName)) {
    const inner = result[armName]?.result;
    const innerResult = inner?.result;
    const { innerResultCode, innerOperationResults } = decodeInnerResult(innerResult);
    return {
      resultCode: armName,
      feeBump: true,
      operationResults: [],
      innerResultCode,
      innerOperationResults,
      raw,
    };
  }

  throw new TxGuardXdrDecodeError(
    `Decoded TransactionResult had an unrecognized result variant: "${armName}".`,
  );
}

function decodeInnerResult(innerResult) {
  if (innerResult === undefined) {
    return { innerResultCode: null, innerOperationResults: null };
  }
  if (typeof innerResult === "string") {
    return {
      innerResultCode: mapTransactionResultCode(innerResult) ?? innerResult,
      innerOperationResults: null,
    };
  }
  const [armName] = Object.keys(innerResult);
  if (OPERATION_RESULT_ARMS.has(armName)) {
    // armName is "tx_success" or "tx_failed" — the inner transaction's own
    // outcome, which is independent of the outer fee-bump arm (a fee-bump
    // reported as tx_fee_bump_inner_success always nests tx_success here,
    // and tx_fee_bump_inner_failed nests either tx_failed or one of the
    // plain transaction-level failure codes handled below).
    return {
      innerResultCode: armName,
      innerOperationResults: mapOperationResults(innerResult[armName]),
    };
  }
  return {
    innerResultCode: mapTransactionResultCode(armName) ?? armName,
    innerOperationResults: null,
  };
}

function mapOperationResults(operationResults) {
  if (!Array.isArray(operationResults)) {
    return [];
  }
  return operationResults
    .map((opResult) => mapOperationResult(opResult))
    .filter((code) => code !== null);
}
