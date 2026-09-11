import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveNetwork } from "../src/networks.js";

test("defaults to testnet when nothing is specified", () => {
  const { network, horizonUrl } = resolveNetwork({});
  assert.equal(network, "testnet");
  assert.equal(horizonUrl, "https://horizon-testnet.stellar.org");
});

test("resolves the mainnet preset", () => {
  const { horizonUrl } = resolveNetwork({ network: "mainnet" });
  assert.equal(horizonUrl, "https://horizon.stellar.org");
});

test("resolves the futurenet preset", () => {
  const { horizonUrl } = resolveNetwork({ network: "futurenet" });
  assert.equal(horizonUrl, "https://horizon-futurenet.stellar.org");
});

test("--horizon-url overrides the network preset", () => {
  const { horizonUrl } = resolveNetwork({
    network: "mainnet",
    horizonUrl: "http://localhost:8000",
  });
  assert.equal(horizonUrl, "http://localhost:8000");
});

test("rpcUrl passes through untouched (no default is assumed)", () => {
  const { rpcUrl } = resolveNetwork({ rpcUrl: "https://example.com/rpc" });
  assert.equal(rpcUrl, "https://example.com/rpc");
});

test("an unknown network name throws, unless --horizon-url is also given", () => {
  assert.throws(() => resolveNetwork({ network: "bogus" }), /Unknown network/);
  assert.doesNotThrow(() =>
    resolveNetwork({ network: "bogus", horizonUrl: "http://localhost" }),
  );
});
