import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { TxGuardXdrDecodeError } from "./errors.js";

/**
 * `@stellar/stellar-xdr-json` ships a WebAssembly module and needs a one-time
 * synchronous init before `decode`/`encode` can be called. Its default
 * `init()` export fetches the .wasm file via `fetch()`, which fails on
 * Node's `file://`-based module resolution (confirmed while building this
 * package — Node's `fetch` does not implement the `file:` scheme). We load
 * the bytes ourselves instead and initialize synchronously with `initSync`.
 */

let wasmModule = null;

function loadWasmBytes() {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("@stellar/stellar-xdr-json/stellar_xdr_json_bg.wasm");
  return readFileSync(wasmPath);
}

/**
 * Returns the initialized `@stellar/stellar-xdr-json` module, performing
 * one-time WASM initialization on first call.
 *
 * @returns {typeof import("@stellar/stellar-xdr-json")}
 */
export async function loadXdrJson() {
  if (wasmModule) {
    return wasmModule;
  }
  const mod = await import("@stellar/stellar-xdr-json");
  mod.initSync(loadWasmBytes());
  wasmModule = mod;
  return mod;
}

/**
 * Decodes `xdrBase64` as XDR type `typeVariant`, returning the parsed JSON
 * value. Throws {@link TxGuardXdrDecodeError} on any decode failure.
 *
 * @param {string} typeVariant e.g. "TransactionResult", "TransactionEnvelope"
 * @param {string} xdrBase64
 * @returns {Promise<unknown>}
 */
export async function decodeXdrJson(typeVariant, xdrBase64) {
  if (typeof xdrBase64 !== "string" || xdrBase64.length === 0) {
    throw new TxGuardXdrDecodeError(
      `${typeVariant} XDR must be a non-empty base64 string.`,
    );
  }
  const { decode } = await loadXdrJson();
  let json;
  try {
    json = decode(typeVariant, xdrBase64);
  } catch (cause) {
    throw new TxGuardXdrDecodeError(
      `Failed to decode ${typeVariant} XDR: ${cause}`,
      { cause },
    );
  }
  try {
    return JSON.parse(json);
  } catch (cause) {
    throw new TxGuardXdrDecodeError(
      `Decoded ${typeVariant} XDR was not valid JSON.`,
      { cause },
    );
  }
}
