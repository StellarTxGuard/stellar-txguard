import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { EXIT_CODE } from "../src/exitCodes.js";

function capture() {
  const out = [];
  const err = [];
  return {
    print: (text) => out.push(text),
    printError: (text) => err.push(text),
    out,
    err,
  };
}

test("no arguments prints help and exits with an error code", async () => {
  const io = capture();
  const code = await runCli([], io);
  assert.equal(code, EXIT_CODE.ERROR);
  assert.ok(io.out.join("\n").includes("Usage:"));
});

test("--help prints help and exits 0", async () => {
  const io = capture();
  const code = await runCli(["--help"], io);
  assert.equal(code, EXIT_CODE.OK);
  assert.ok(io.out.join("\n").includes("txguard decode"));
});

test("-h is an alias for --help", async () => {
  const io = capture();
  const code = await runCli(["-h"], io);
  assert.equal(code, EXIT_CODE.OK);
});

test("--version prints a version string and exits 0", async () => {
  const io = capture();
  const code = await runCli(["--version"], io);
  assert.equal(code, EXIT_CODE.OK);
  assert.match(io.out[0], /^\d+\.\d+\.\d+$/);
});

test("unknown command exits with an error and shows help", async () => {
  const io = capture();
  const code = await runCli(["frobnicate"], io);
  assert.equal(code, EXIT_CODE.ERROR);
  assert.ok(io.err.join("\n").includes('unknown command "frobnicate"'));
});

test("unrecognized flag produces a clean usage error, not a stack trace", async () => {
  const io = capture();
  const code = await runCli(["decode", "AAAA", "--not-a-real-flag"], io);
  assert.equal(code, EXIT_CODE.ERROR);
  assert.ok(io.err.join("\n").startsWith("txguard:"));
  assert.ok(!/\n\s+at\s/.test(io.err.join("\n")), "should not leak a stack trace by default");
});
