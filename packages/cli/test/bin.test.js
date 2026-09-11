// Spawns the actual bin/txguard.js entrypoint as a real subprocess — proves
// the shebang, the bin wiring, and process.exitCode all work end to end,
// not just the runCli() function in isolation (covered by the other test
// files in this directory).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/txguard.js", import.meta.url));

test("bin/txguard.js --help exits 0 and prints usage", async () => {
  const { stdout, code } = await run(["--help"]);
  assert.ok(stdout.includes("Usage:"));
  assert.equal(code, 0);
});

test("bin/txguard.js decode <xdr> exits 0 and decodes", async () => {
  const { stdout, code } = await run(["decode", "AAAAAAAAAGT////7AAAAAA=="]);
  assert.ok(stdout.includes("tx_bad_seq"));
  assert.equal(code, 0);
});

test("bin/txguard.js decode <malformed> exits 1", async () => {
  const { code } = await run(["decode", "not-valid!!!"]);
  assert.equal(code, 1);
});

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    // execFile rejects on non-zero exit; the exit code is still useful.
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
  }
}
