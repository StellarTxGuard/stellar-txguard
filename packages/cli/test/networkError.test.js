import assert from "node:assert/strict";
import { test } from "node:test";

import { describeNetworkFailure, formatUnreachableError } from "../src/networkError.js";

test("describeNetworkFailure: classifies connection refused from a nested fetch error", () => {
  const cause = new Error("connect ECONNREFUSED 127.0.0.1:443");
  cause.code = "ECONNREFUSED";
  const outer = new TypeError("fetch failed");
  outer.cause = cause;
  assert.equal(describeNetworkFailure(outer), "connection refused");
});

test("describeNetworkFailure: classifies timeout from TimeoutError / AbortError", () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.equal(describeNetworkFailure(timeout), "request timed out");

  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  assert.equal(describeNetworkFailure(abort), "request timed out");
});

test("describeNetworkFailure: classifies host-not-found and invalid URL", () => {
  assert.equal(describeNetworkFailure(new Error("getaddrinfo ENOTFOUND")), "host not found");
  const invalid = new TypeError("Failed to parse URL");
  assert.equal(describeNetworkFailure(invalid), "invalid URL");
});

test("formatUnreachableError: names the URL, the reason, and the flag to override it", () => {
  const horizon = formatUnreachableError(
    "Horizon",
    "https://horizon-testnet.stellar.org",
    new Error("connect ECONNREFUSED"),
  );
  assert.match(horizon, /Could not reach Horizon at https:\/\/horizon-testnet\.stellar\.org/);
  assert.match(horizon, /connection refused/);
  assert.match(horizon, /--horizon-url/);
  assert.ok(!horizon.includes("ECONNREFUSED"));

  const rpc = formatUnreachableError("RPC", "https://rpc.example", new Error("getaddrinfo ENOTFOUND"));
  assert.match(rpc, /Could not reach RPC endpoint at https:\/\/rpc\.example/);
  assert.match(rpc, /host not found/);
  assert.match(rpc, /--rpc-url/);
});
