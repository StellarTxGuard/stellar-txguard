import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { EXIT_CODE } from "../src/exitCodes.js";

const HASH = "a".repeat(64);

function capture() {
  const out = [];
  const err = [];
  return { print: (t) => out.push(t), printError: (t) => err.push(t), out, err };
}

function jsonFetch(body, status = 200) {
  return async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  });
}

test("retry-safety: a confirmed failure reaches a definite decision, exit 0", async () => {
  const io = capture();
  const fetchImpl = jsonFetch({
    id: "x",
    hash: HASH,
    successful: false,
    ledger: 1,
    source_account_sequence: "5",
    result_xdr: "AAAAAAAAAGT////7AAAAAA==", // synthetic tx_bad_seq
  });

  const code = await runCli(["retry-safety", HASH], { ...io, fetchImpl });

  assert.equal(code, EXIT_CODE.OK);
  const text = io.out.join("\n");
  assert.ok(text.includes("Decision: DO_NOT_RETRY"));
  assert.ok(text.includes("Risk: DUPLICATE_PAYMENT"));
  assert.ok(text.includes("Confidence: HIGH"));
  assert.ok(text.includes("Evidence:"));
  assert.ok(text.includes("Recommended action"));
});

test("retry-safety: --json outputs the exact evaluator result shape", async () => {
  const io = capture();
  const fetchImpl = jsonFetch({
    id: "x",
    hash: HASH,
    successful: true,
    ledger: 1,
  });

  const code = await runCli(["retry-safety", HASH, "--json"], { ...io, fetchImpl });

  assert.equal(code, EXIT_CODE.OK);
  assert.equal(io.err.join(""), "");
  const text = io.out.join("\n");
  assert.ok(!text.includes("Decision:"), "--json must not mix the human report into stdout");
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "confidence",
    "decision",
    "evidence",
    "reasonCode",
    "recommendedActions",
    "risk",
    "summary",
  ]);
  assert.equal(parsed.decision, "DO_NOT_RETRY");
});

test("retry-safety: unknown transaction (404) -> UNKNOWN decision, exit code 2", async () => {
  const io = capture();
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });

  const code = await runCli(["retry-safety", HASH], { ...io, fetchImpl });

  assert.equal(code, EXIT_CODE.UNKNOWN_RESULT);
  assert.ok(io.out.join("\n").includes("Decision: UNKNOWN"));
});

test("retry-safety: a gateway 503 also produces UNKNOWN, not a guess", async () => {
  const io = capture();
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });

  const code = await runCli(["retry-safety", HASH], { ...io, fetchImpl });

  assert.equal(code, EXIT_CODE.UNKNOWN_RESULT);
  assert.ok(io.out.join("\n").includes("UNCERTAIN_SUBMISSION"));
});

test("retry-safety: network failure is a runtime error, exit code 1, no stack trace by default", async () => {
  const io = capture();
  const fetchImpl = async () => {
    throw new Error("connect ECONNREFUSED");
  };

  const code = await runCli(["retry-safety", HASH], { ...io, fetchImpl });

  assert.equal(code, EXIT_CODE.ERROR);
  assert.equal(io.out.join(""), "");
  const message = io.err.join("\n");
  assert.ok(message.includes("Could not reach Horizon"));
  assert.ok(message.includes("connection refused"));
  assert.ok(message.includes("--horizon-url"));
  assert.ok(!message.includes("connect ECONNREFUSED"), "should not dump the raw fetch error");
  assert.ok(!/\n\s+at\s/.test(message), "should not leak a stack trace by default");
});

test("retry-safety: a timed-out Horizon request is a clear timeout error, not a raw abort", async () => {
  const io = capture();
  const fetchImpl = async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  };

  const code = await runCli(["retry-safety", HASH, "--json"], { ...io, fetchImpl });

  assert.equal(code, EXIT_CODE.ERROR);
  assert.equal(io.out.join(""), "", "--json errors must not write partial JSON to stdout");
  const message = io.err.join("\n");
  assert.ok(message.includes("Could not reach Horizon"));
  assert.match(message, /timed out/);
  assert.ok(message.includes("--horizon-url"));
  assert.ok(!/\n\s+at\s/.test(message), "should not leak a stack trace by default");
});

test("retry-safety: an unreachable RPC endpoint is an actionable stderr error", async () => {
  const io = capture();
  const fetchImpl = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };

  const code = await runCli(
    ["retry-safety", HASH, "--rpc-url", "https://rpc.example.invalid"],
    { ...io, fetchImpl },
  );

  assert.equal(code, EXIT_CODE.ERROR);
  assert.equal(io.out.join(""), "");
  const message = io.err.join("\n");
  assert.ok(message.includes("Could not reach RPC endpoint"));
  assert.ok(message.includes("https://rpc.example.invalid"));
  assert.ok(message.includes("host not found"));
  assert.ok(message.includes("--rpc-url"));
  assert.ok(!/\n\s+at\s/.test(message), "should not leak a stack trace by default");
});

test("retry-safety: invalid transaction hash is rejected before any network call", async () => {
  const io = capture();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("should not be called");
  };

  const code = await runCli(["retry-safety", "not-a-hash"], { ...io, fetchImpl });

  assert.equal(code, EXIT_CODE.ERROR);
  assert.equal(called, false);
  assert.equal(io.out.join(""), "");
  const message = io.err.join("\n");
  assert.ok(message.includes("not-a-hash"));
  assert.ok(message.includes("not a valid transaction hash"));
  assert.ok(message.includes("64"));
});

test("retry-safety: missing hash argument is a usage error", async () => {
  const io = capture();
  const code = await runCli(["retry-safety"], io);
  assert.equal(code, EXIT_CODE.ERROR);
});

test("retry-safety: --verified-no-prior-success + --current-sequence can flip tx_bad_seq to SAFE_TO_RETRY", async () => {
  const io = capture();
  const fetchImpl = jsonFetch({
    status: 400,
    extras: {
      result_codes: { transaction: "tx_bad_seq" },
    },
  });

  const code = await runCli(
    [
      "retry-safety",
      HASH,
      "--verified-no-prior-success",
      "--current-sequence",
      "999",
    ],
    { ...io, fetchImpl },
  );

  assert.equal(code, EXIT_CODE.OK);
  assert.ok(io.out.join("\n").includes("Decision: SAFE_TO_RETRY"));
});

test("retry-safety: --current-sequence accepts a value exceeding Number.MAX_SAFE_INTEGER exactly", async () => {
  // Stellar sequence numbers routinely exceed 2^53-1 — this must never be
  // silently rounded via Number(...). 19801804984287233 is a real
  // Testnet value (see packages/core/test/real-testnet.test.js).
  const io = capture();
  const HUGE = "19801804984287233";
  const fetchImpl = jsonFetch({
    status: 400,
    extras: { result_codes: { transaction: "tx_bad_seq" } },
  });

  const code = await runCli(
    ["retry-safety", HASH, "--verified-no-prior-success", "--current-sequence", HUGE],
    { ...io, fetchImpl },
  );

  // No --original-sequence flag exists (only --current-sequence), so the
  // tx_bad_seq rule doesn't have both values to cite in evidence text —
  // what matters here is that a sequence number this large is accepted
  // and reaches a decision at all, rather than being silently rejected or
  // mishandled. See the "inspect" tests for direct proof the exact string
  // survives into normalized context without precision loss.
  assert.equal(code, EXIT_CODE.OK);
  assert.ok(io.out.join("\n").includes("Decision: SAFE_TO_RETRY"));
});

test("retry-safety: --current-sequence rejects a non-integer value before any network call", async () => {
  const io = capture();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("should not be called");
  };

  const code = await runCli(
    ["retry-safety", HASH, "--current-sequence", "123.45"],
    { ...io, fetchImpl },
  );

  assert.equal(code, EXIT_CODE.ERROR);
  assert.equal(called, false);
  assert.equal(io.out.join(""), "");
  const message = io.err.join("\n");
  assert.ok(message.includes("--current-sequence"));
  assert.ok(message.includes("123.45"));
  assert.ok(message.includes("not a valid Stellar sequence number"));
});

test("retry-safety: --current-sequence rejects a negative value before any network call", async () => {
  const io = capture();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("should not be called");
  };

  // A standalone "-5" token is parsed as another flag (`--current-sequence=-5`
  // is how a leading-dash value has to be written for parseArgs).
  const code = await runCli(["retry-safety", HASH, "--current-sequence=-5"], {
    ...io,
    fetchImpl,
  });

  assert.equal(code, EXIT_CODE.ERROR);
  assert.equal(called, false);
  assert.equal(io.out.join(""), "");
  const message = io.err.join("\n");
  assert.ok(message.includes("--current-sequence"));
  assert.ok(message.includes("-5"));
  assert.ok(message.includes("not a valid Stellar sequence number"));
});

test("retry-safety: --current-sequence rejects a value with an implicit-conversion-style format (leading zero)", async () => {
  const io = capture();
  const code = await runCli(["retry-safety", HASH, "--current-sequence", "0123"], io);

  assert.equal(code, EXIT_CODE.ERROR);
  assert.equal(io.out.join(""), "");
  const message = io.err.join("\n");
  assert.ok(message.includes("--current-sequence"));
  assert.ok(message.includes("0123"));
  assert.ok(message.includes("not a valid Stellar sequence number"));
});

test("retry-safety: --moves-funds rejects a value that is not true or false", async () => {
  const io = capture();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("should not be called");
  };

  const code = await runCli(["retry-safety", HASH, "--moves-funds", "maybe"], {
    ...io,
    fetchImpl,
  });

  assert.equal(code, EXIT_CODE.ERROR);
  assert.equal(called, false);
  assert.equal(io.out.join(""), "");
  const message = io.err.join("\n");
  assert.ok(message.includes("--moves-funds"));
  assert.ok(message.includes("maybe"));
  assert.ok(message.includes("true") && message.includes("false"));
});

test("retry-safety: --json of an UNKNOWN decision is still parseable JSON, exit 2", async () => {
  const io = capture();
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });

  const code = await runCli(["retry-safety", HASH, "--json"], { ...io, fetchImpl });

  assert.equal(code, EXIT_CODE.UNKNOWN_RESULT);
  assert.equal(io.err.join(""), "");
  const parsed = JSON.parse(io.out.join("\n"));
  assert.equal(parsed.decision, "UNKNOWN");
  assert.equal(parsed.risk, "UNCERTAIN_SUBMISSION");
});

test("retry-safety: --source rpc without --rpc-url is a clear usage error", async () => {
  const io = capture();
  const code = await runCli(["retry-safety", HASH, "--source", "rpc"], io);
  assert.equal(code, EXIT_CODE.ERROR);
  assert.ok(io.err.join("\n").includes("requires --rpc-url"));
});

test("retry-safety: --source rpc with --rpc-url queries the RPC endpoint", async () => {
  const io = capture();
  let requestedUrl;
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { status: "NOT_FOUND" },
      }),
    };
  };

  const code = await runCli(
    ["retry-safety", HASH, "--rpc-url", "https://example.com/rpc"],
    { ...io, fetchImpl },
  );

  assert.equal(requestedUrl, "https://example.com/rpc");
  assert.equal(code, EXIT_CODE.UNKNOWN_RESULT);
});
