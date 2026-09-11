import { decodeXdrJson } from "./wasm.js";
import { TxGuardXdrDecodeError } from "./errors.js";

/**
 * @typedef {object} DecodedTransactionEnvelope
 * @property {boolean} isFeeBump
 * @property {string} sourceAccount The outer transaction's source account
 *   (for a fee bump, this is the *inner* transaction's source account — the
 *   fee bump's own fee-paying account is `feeSourceAccount`).
 * @property {string} sequence The sequence number consumed by the
 *   transaction, as a decimal string (kept as a string — sequence numbers
 *   are 64-bit and can exceed `Number.MAX_SAFE_INTEGER`).
 * @property {string | null} feeSourceAccount Set when `isFeeBump` is true:
 *   the account paying the fee-bump's fee.
 * @property {{ minTime: number, maxTime: number } | null} timeBounds `null`
 *   when the transaction has no time bounds precondition (`PRECOND_NONE`)
 *   or has a `PRECOND_V2` precondition without time bounds set. `minTime`/
 *   `maxTime` of `0` mean "unset" per XDR convention, exactly as Horizon
 *   represents them.
 * @property {number} operationCount
 * @property {{ envelopeXdr: string }} raw
 */

/**
 * Decodes a base64 `TransactionEnvelope` XDR value (Horizon's/stellar-rpc's
 * `envelope_xdr` / `envelopeXdr`) into structured information.
 *
 * This function only decodes — it does not make a retry-safety decision.
 *
 * @param {string} envelopeXdr
 * @returns {Promise<DecodedTransactionEnvelope>}
 * @throws {TxGuardXdrDecodeError} if `envelopeXdr` is not valid TransactionEnvelope XDR.
 */
export async function decodeTransactionEnvelopeXdr(envelopeXdr) {
  const decoded = await decodeXdrJson("TransactionEnvelope", envelopeXdr);
  const raw = { envelopeXdr };

  if (decoded?.tx_fee_bump) {
    const feeBumpTx = decoded.tx_fee_bump.tx;
    const innerTx = feeBumpTx?.inner_tx?.tx?.tx;
    if (!innerTx) {
      throw new TxGuardXdrDecodeError(
        "Decoded fee-bump TransactionEnvelope was missing its inner transaction.",
      );
    }
    return {
      isFeeBump: true,
      sourceAccount: innerTx.source_account,
      sequence: String(innerTx.seq_num),
      feeSourceAccount: feeBumpTx.fee_source,
      timeBounds: extractTimeBounds(innerTx.cond),
      operationCount: Array.isArray(innerTx.operations) ? innerTx.operations.length : 0,
      raw,
    };
  }

  const tx = decoded?.tx?.tx;
  if (!tx) {
    throw new TxGuardXdrDecodeError(
      'Decoded TransactionEnvelope had an unrecognized envelope variant (expected "tx" or "tx_fee_bump").',
    );
  }

  return {
    isFeeBump: false,
    sourceAccount: tx.source_account,
    sequence: String(tx.seq_num),
    feeSourceAccount: null,
    timeBounds: extractTimeBounds(tx.cond),
    operationCount: Array.isArray(tx.operations) ? tx.operations.length : 0,
    raw,
  };
}

function extractTimeBounds(cond) {
  if (!cond || cond === "none") {
    return null;
  }
  const timeBounds = cond.time ?? cond.v2?.time_bounds;
  if (!timeBounds) {
    return null;
  }
  return {
    minTime: Number(timeBounds.min_time),
    maxTime: Number(timeBounds.max_time),
  };
}
