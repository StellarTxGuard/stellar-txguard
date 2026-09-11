import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { EXIT_CODE } from "../src/exitCodes.js";

const HASH = "b".repeat(64);

function capture() {
  const out = [];
  const err = [];
  return { print: (t) => out.push(t), printError: (t) => err.push(t), out, err };
}

test("inspect: prints the normalized object, not a safety decision", async () => {
  const io = capture();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      id: "x",
      hash: HASH,
      successful: true,
      ledger: 1,
      source_account_sequence: "42",
    }),
  });

  const code = await runCli(["inspect", HASH], { ...io, fetchImpl });

  assert.equal(code, EXIT_CODE.OK);
  const text = io.out.join("\n");
  assert.ok(!text.includes("Decision:"), "inspect must not evaluate retry safety");
  const jsonStart = text.indexOf("{");
  const parsed = JSON.parse(text.slice(jsonStart));
  assert.equal(parsed.transactionStatus, "SUCCESS");
  assert.equal(parsed.context.originalSequence, "42");
  assert.equal(parsed.observedState, "CONFIRMED_SUCCESS");
});

test("inspect: a sequence number exceeding Number.MAX_SAFE_INTEGER survives to --json output exactly", async () => {
  // 19801804984287233 is a real Testnet value (see
  // packages/core/test/real-testnet.test.js) that exceeds 2^53-1 and
  // would be silently rounded by Number(...). This must not happen.
  const HUGE = "19801804984287233";
  const io = capture();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      id: "x",
      hash: HASH,
      successful: false,
      ledger: 1,
      source_account_sequence: HUGE,
      result_xdr: "AAAAAAAAAGT////7AAAAAA==",
    }),
  });

  const code = await runCli(["inspect", HASH], { ...io, fetchImpl });

  assert.equal(code, EXIT_CODE.OK);
  const text = io.out.join("\n");
  const parsed = JSON.parse(text.slice(text.indexOf("{")));
  assert.equal(parsed.context.originalSequence, HUGE);
  assert.equal(typeof parsed.context.originalSequence, "string");
  // Prove it round-trips through JSON.stringify/JSON.parse (as the raw
  // CLI output text does) without ever becoming a JS number: the exact
  // digit string must be present verbatim in the printed text.
  assert.ok(text.includes(`"originalSequence": "${HUGE}"`));
});

test("inspect: reports the network source used", async () => {
  const io = capture();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: "x", hash: HASH, successful: true, ledger: 1 }),
  });

  await runCli(["inspect", HASH, "--network", "mainnet"], { ...io, fetchImpl });

  assert.ok(io.out.join("\n").includes("horizon.stellar.org"));
});

test("inspect: invalid --network without an override is a usage error", async () => {
  const io = capture();
  const code = await runCli(["inspect", HASH, "--network", "not-a-real-network"], io);
  assert.equal(code, EXIT_CODE.ERROR);
  assert.ok(io.err.join("\n").includes("Unknown network"));
});
