import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { EXIT_CODE } from "../src/exitCodes.js";

const xdrFixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../xdr/test/fixtures/fixtures.json", import.meta.url)),
    "utf8",
  ),
);

function capture() {
  const out = [];
  const err = [];
  return { print: (t) => out.push(t), printError: (t) => err.push(t), out, err };
}

test("decode: auto-detects a TransactionResult", async () => {
  const io = capture();
  const code = await runCli(["decode", xdrFixtures.results.bad_seq], io);
  assert.equal(code, EXIT_CODE.OK);
  assert.ok(io.out.join("\n").includes("Decoded as: TransactionResult"));
  assert.ok(io.out.join("\n").includes("tx_bad_seq"));
});

test("decode: auto-detects a TransactionEnvelope", async () => {
  const io = capture();
  const code = await runCli(["decode", xdrFixtures.envelopes.plain], io);
  assert.equal(code, EXIT_CODE.OK);
  assert.ok(io.out.join("\n").includes("Decoded as: TransactionEnvelope"));
});

test("decode --type result forces the result decoder", async () => {
  const io = capture();
  const code = await runCli(["decode", xdrFixtures.results.bad_seq, "--type", "result"], io);
  assert.equal(code, EXIT_CODE.OK);
  assert.ok(io.out.join("\n").includes("TransactionResult"));
});

test("decode --type envelope on result XDR reports a clear decode failure", async () => {
  const io = capture();
  const code = await runCli(["decode", xdrFixtures.results.bad_seq, "--type", "envelope"], io);
  assert.equal(code, EXIT_CODE.ERROR);
  assert.ok(io.err.join("\n").includes("Could not decode"));
});

test("decode --json produces valid, parseable JSON", async () => {
  const io = capture();
  const code = await runCli(["decode", xdrFixtures.results.bad_seq, "--json"], io);
  assert.equal(code, EXIT_CODE.OK);
  const parsed = JSON.parse(io.out.join("\n"));
  assert.equal(parsed.resultCode, "tx_bad_seq");
  assert.equal(parsed.type, "TransactionResult");
});

test("decode: malformed XDR reports a clear error, not a stack trace, exit 1", async () => {
  const io = capture();
  const code = await runCli(["decode", "not-valid-xdr!!!"], io);
  assert.equal(code, EXIT_CODE.ERROR);
  const message = io.err.join("\n");
  assert.ok(message.includes("Could not decode"));
  assert.ok(!/\n\s+at\s/.test(message), "should not leak a stack trace by default");
});

test("decode: missing xdr argument is a usage error", async () => {
  const io = capture();
  const code = await runCli(["decode"], io);
  assert.equal(code, EXIT_CODE.ERROR);
  assert.ok(io.err.join("\n").includes("missing required argument"));
});

test("decode: unknown --type value is a usage error", async () => {
  const io = capture();
  const code = await runCli(["decode", "AAAA", "--type", "bogus"], io);
  assert.equal(code, EXIT_CODE.ERROR);
  assert.ok(io.err.join("\n").includes('unknown --type "bogus"'));
});

test("decode: fee-bump result decodes and reports the inner result code", async () => {
  const io = capture();
  const code = await runCli([
    "decode",
    xdrFixtures.results.fee_bump_failed_bad_seq,
    "--json",
  ], io);
  assert.equal(code, EXIT_CODE.OK);
  const parsed = JSON.parse(io.out.join("\n"));
  assert.equal(parsed.resultCode, "tx_fee_bump_inner_failed");
  assert.equal(parsed.innerResultCode, "tx_bad_seq");
});
