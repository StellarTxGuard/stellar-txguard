# StellarTxGuard

Open-source reliability infrastructure for safer Stellar transaction
retries.

StellarTxGuard answers one specific question:

> **Given the current state of a Stellar transaction, is it safe to retry?**

## The problem

Retrying a failed or uncertain transaction sounds like a harmless recovery
step. On Stellar, it often isn't:

- A `tx_bad_seq` result can mean the account's sequence number simply moved
  on — or it can mean a previous submission for the same intent already
  succeeded. Rebuilding and resubmitting without checking which one it was
  can produce a **duplicate payment**.
- An HTTP timeout or `504` on submission tells you the request failed —
  not that the transaction failed. The transaction itself may still land
  in a later ledger. Immediately submitting a new one "just in case" is
  exactly how duplicate payments happen in practice.
- Errors like insufficient fee, insufficient balance, missing trustlines,
  or expired timebounds each call for a *different* corrective action —
  not a blind resubmit.

Most retry logic either resubmits unconditionally or gives up entirely.
Neither is safe by default. StellarTxGuard exists to make the "is this
actually safe to retry?" judgment explicit, evidence-based, and
inspectable, instead of leaving it to ad hoc `catch` blocks scattered
across an application.

### Core safety principle

> **If StellarTxGuard cannot prove that retrying is safe, it must not say
> that retrying is safe.**

Where evidence is insufficient, the engine returns `UNKNOWN` rather than
guessing. See [Why the engine is conservative](docs/architecture.md#why-the-engine-is-conservative)
for the reasoning behind each rule.

## What this is not

StellarTxGuard's purpose, stated precisely:

> **Determine whether retrying a Stellar transaction is safe, based on
> observable evidence.**

It is a single-purpose safety engine, not a general-purpose Stellar tool.
It is **not**:

- a blockchain explorer
- a transaction debugger
- another Stellar simulator
- a wallet
- a transaction signer
- a payment app
- a generic transaction retry SDK
- an AI chatbot

This holds for every part of the project, including the CLI
(`@stellar-txguard/cli`, see [CLI](#cli) below): it reads transaction state
and reports on it — it never holds a private key, never constructs a
signature, and never submits or resends a transaction. The only network
requests it ever makes are read-only lookups (Horizon's `GET
/transactions/{hash}`, or stellar-rpc's `getTransaction`).

## Installation

This repository is an npm workspace. The core engine is not yet published
to the npm registry — for now, use it as a workspace dependency or copy
`packages/core` into your project.

```bash
git clone https://github.com/StellarTxGuard/stellar-txguard.git
cd stellar-txguard
npm install
```

## Basic usage

```js
import { evaluateRetrySafety } from "@stellar-txguard/core";

const result = evaluateRetrySafety({
  transactionStatus: "FAILED",
  resultCode: "tx_bad_seq",
  context: {
    // Decimal strings, not numbers — Stellar sequence numbers routinely
    // exceed Number.MAX_SAFE_INTEGER (see "Sequence numbers" below).
    originalSequence: "123",
    currentSequence: "125",
  },
});

console.log(result.decision); // "DO_NOT_RETRY"
```

Try more scenarios with:

```bash
node examples/basic-evaluation.js
```

### Sequence numbers

`context.originalSequence` and `context.currentSequence` (wherever they
appear — direct `evaluateRetrySafety()` input, adapter `options`, or the
CLI's `--current-sequence` flag) are always **canonical decimal strings**
(e.g. `"19801804984287233"`), never JavaScript numbers.

This isn't a style preference. Stellar sequence numbers are 64-bit and are
built from `ledgerNumber << 32` — real accounts have exceeded
`Number.MAX_SAFE_INTEGER` (2^53-1) for years now on both Testnet and
Mainnet. `Number("19801804984287233")` silently rounds to a different
value; two distinct real sequence numbers can even collide into the same
`Number`. `evaluateRetrySafety()` rejects a non-string sequence value
outright (`TxGuardValidationError`) rather than accept a value that might
already be wrong before any rule sees it:

```js
import { evaluateRetrySafety, describeSequenceError } from "@stellar-txguard/core";

evaluateRetrySafety({
  transactionStatus: "FAILED",
  resultCode: "tx_bad_seq",
  context: { originalSequence: 123 }, // ✗ throws TxGuardValidationError — must be "123"
});

describeSequenceError("123");      // null — valid
describeSequenceError("-5");       // "\"-5\" is not a valid Stellar sequence number ..."
describeSequenceError(123);        // "must be a decimal string, got number"
```

Internally, rules that compare two sequence numbers (`tx_bad_seq`,
`tx_insufficient_fee`) use `compareSequences(a, b)`, which converts to
`BigInt` only for the duration of one exact comparison — a `BigInt` is
never stored on, or returned as part of, any public result (results stay
plain-JSON-serializable). See
[`packages/core/src/sequence.js`](packages/core/src/sequence.js) for the
full contract, including the exact validation rules (no sign, no leading
zeros, no decimal point, bounded to the real int64 range).

### Usage with a real Horizon or RPC response

Rather than hand-building the input object, adapt a real network response
directly:

```js
import {
  evaluateRetrySafety,
  normalizeHorizonTransaction,
} from "@stellar-txguard/core";

// horizonResponse is the JSON body Horizon returned — a transaction
// resource (GET /transactions/{hash}), a POST /transactions failure body,
// or a POST /transactions_async submission response (see below).
const normalized = normalizeHorizonTransaction(horizonResponse);

const result = evaluateRetrySafety(normalized);
```

The equivalent for a Stellar RPC (`soroban-rpc` / `stellar-rpc`) response,
from either `sendTransaction` or `getTransaction`:

```js
import {
  evaluateRetrySafety,
  normalizeRpcTransaction,
} from "@stellar-txguard/core";

const normalized = normalizeRpcTransaction(rpcResponse);

const result = evaluateRetrySafety(normalized);
```

Both adapters accept an optional second `options` argument for evidence
the response itself doesn't carry — most importantly the source account's
*current* sequence number (needed for a confident `tx_bad_seq` verdict) and
`verifiedNoPriorSuccess` (see [Currently supported
rules](#currently-supported-rules) below). Neither Horizon's transaction
resource nor stellar-rpc's `getTransaction` decode a failed transaction's
XDR result into a result code — both adapters normalize that case to the
synthetic code `tx_failed_undecoded`, which always evaluates to `UNKNOWN`,
unless you pass an already-decoded `options.resultCode`, or opt into
decoding it for you (see below). See
[`docs/architecture.md`](docs/architecture.md#adapters) for exactly which
response fields each adapter reads.

### Horizon async submission (`POST /transactions_async`)

`normalizeHorizonTransaction()` also accepts the response from Horizon's
asynchronous submission endpoint — note the route is `/transactions_async`
(an underscore, not a hyphen; verified against Horizon's own router
source). Its four possible outcomes (`PENDING`, `DUPLICATE`,
`TRY_AGAIN_LATER`, `ERROR`) are the exact same underlying stellar-core
classification as stellar-rpc's `sendTransaction`, normalized through
identical logic — see [Currently supported
rules](#currently-supported-rules) for what each one means. A handful of
rarer Horizon-level problem responses (a malformed request, a Horizon↔Core
communication failure) are recognized but not modeled as a transaction
state; `normalizeHorizonTransaction()` throws `TxGuardAdapterError` for
those, with a message naming which one, rather than guessing.

### Optional XDR decoding

`tx_failed_undecoded` doesn't have to be a dead end. The separate
`@stellar-txguard/xdr` package can decode raw XDR for you — install it
only if you need it:

```js
import { evaluateRetrySafety, normalizeHorizonTransaction } from "@stellar-txguard/core";
import { decodeTransactionResultXdr, decodeTransactionEnvelopeXdr } from "@stellar-txguard/xdr";

const normalized = await normalizeHorizonTransaction(horizonResponse, {
  xdrDecoder: { decodeTransactionResultXdr, decodeTransactionEnvelopeXdr },
});

const result = evaluateRetrySafety(normalized);
```

Passing `options.xdrDecoder` is the only way XDR decoding happens — it is
never on by default, and `@stellar-txguard/core` never imports
`@stellar-txguard/xdr` itself. This is also the only case where
`normalizeHorizonTransaction()` / `normalizeRpcTransaction()` return a
`Promise` instead of a plain object; without `xdrDecoder`, both stay fully
synchronous. `decodeTransactionResultXdr` and `decodeTransactionEnvelopeXdr`
are each independently optional on the object you pass — supply whichever
you want applied:

- `decodeTransactionResultXdr` resolves `tx_failed_undecoded` into a real
  result code, exactly as before.
- `decodeTransactionEnvelopeXdr` fills in `context.originalSequence` /
  `minTime` / `maxTime` from the transaction envelope — but *only* the
  ones nothing more authoritative already supplied (an explicit `options`
  value, or a field the response gave directly, always wins). This is most
  useful exactly where Horizon's response has no sequence-number field of
  its own to begin with — e.g. a `POST /transactions` failure body — so a
  `tx_bad_seq` verdict can cite the actual submitted sequence without you
  looking it up separately. For response shapes that don't echo the
  envelope back at all (async submissions), pass it yourself via
  `options.envelopeXdr` — you already have it, you just submitted it.

Run `node examples/xdr-decoding.js` to see the same response evaluated
both with and without decoding. See [XDR
decoding](docs/architecture.md#xdr-decoding) in the architecture doc for
the full trust boundary — what the decoder does and does not do, why it's
a separate package, why an unrecoverable decode throws rather than falling
back to a guess, and which dependency it uses and why.

## Example output

```js
{
  decision: "DO_NOT_RETRY",
  risk: "DUPLICATE_PAYMENT",
  reasonCode: "tx_bad_seq",
  confidence: "high",
  summary: "The transaction sequence is no longer current. Rebuilding and resubmitting without first confirming what happened to prior submissions could cause a duplicate payment.",
  evidence: [
    "The original transaction returned tx_bad_seq, meaning the submitted sequence number did not match the account's expected sequence number.",
    "The account sequence has advanced beyond the submitted sequence (submitted 123, current 125), which is consistent with another transaction having been applied."
  ],
  recommendedActions: [
    "Check recent transactions and effects for the source account.",
    "Verify whether the intended payment already succeeded under a different submission.",
    "Do not construct a new transaction for the same intent until the previous submission's outcome is understood."
  ]
}
```

Every result has this shape: a `decision`, a `risk` category, the
`reasonCode` it was based on, a `confidence` level, `evidence`, and
`recommendedActions`. See [`packages/core/src/evidence.js`](packages/core/src/evidence.js)
for the exact contract.

Malformed input (missing required fields, inconsistent status/result-code
pairs, wrong types) throws a `TxGuardValidationError` rather than being
silently classified as safe:

```js
import { evaluateRetrySafety, TxGuardValidationError } from "@stellar-txguard/core";

try {
  evaluateRetrySafety({ resultCode: "tx_bad_seq" }); // missing transactionStatus
} catch (err) {
  if (err instanceof TxGuardValidationError) {
    console.error("Bad input:", err.message);
  }
}
```

## Currently supported rules

**Transaction-level** (`resultCode`):

| Result code               | Decision           | Risk                 |
| -------------------------- | ------------------ | --------------------- |
| `tx_success`                | `DO_NOT_RETRY`      | `DUPLICATE_PAYMENT`\*  |
| `tx_bad_seq`                 | `DO_NOT_RETRY`\*\*   | `DUPLICATE_PAYMENT`   |
| `tx_insufficient_fee`        | `RETRY_AFTER_ACTION`| `NONE`                |
| `tx_insufficient_balance`    | `RETRY_AFTER_ACTION`| `FUNDS_STUCK`         |
| `tx_too_early`               | `RETRY_AFTER_ACTION`| `NONE`                |
| `tx_too_late`                | `RETRY_AFTER_ACTION`| `NONE`                |
| `tx_no_source_account`       | `DO_NOT_RETRY`      | `CONFIGURATION_ISSUE` |
| `tx_bad_auth`                | `RETRY_AFTER_ACTION`| `NONE`                |
| `tx_bad_auth_extra`          | `RETRY_AFTER_ACTION`| `NONE`                |
| `tx_missing_operation`       | `DO_NOT_RETRY`      | `CONFIGURATION_ISSUE` |
| `tx_fee_bump_inner_success`  | `DO_NOT_RETRY`      | `DUPLICATE_PAYMENT`\*  |
| `tx_fee_bump_inner_failed`   | delegates to `innerResultCode`; `UNKNOWN` if not supplied | — |
| `tx_failed_undecoded`\*\*\*     | `UNKNOWN`            | `UNKNOWN`              |
| `rpc_try_again_later`\*\*\*\*   | `RETRY_AFTER_ACTION`| `NONE`                |
| anything else                | `UNKNOWN`            | `UNKNOWN`              |

\* `NONE` if `context.movesFunds === false`.
\*\* `SAFE_TO_RETRY` if `context.verifiedNoPriorSuccess === true`.
\*\*\* Synthetic, adapter-only marker for a confirmed failure with no
decoded result code available — not a real Stellar/XDR code.
\*\*\*\* Synthetic marker for stellar-rpc `sendTransaction` status
`TRY_AGAIN_LATER` — not an XDR `TransactionResultCode`.

**Payment operation-level** (`operationResultCodes`, when `resultCode` is
`tx_failed`; these also apply to path-payment operations, which share most
of the same failure codes):

| Result code           | Decision            | Risk                  |
| ---------------------- | -------------------- | ---------------------- |
| `op_no_trust`            | `RETRY_AFTER_ACTION`  | `CONFIGURATION_ISSUE`  |
| `op_src_no_trust`        | `RETRY_AFTER_ACTION`  | `CONFIGURATION_ISSUE`  |
| `op_not_authorized`      | `RETRY_AFTER_ACTION`  | `CONFIGURATION_ISSUE`  |
| `op_src_not_authorized`  | `RETRY_AFTER_ACTION`  | `CONFIGURATION_ISSUE`  |
| `op_no_destination`      | `RETRY_AFTER_ACTION`  | `CONFIGURATION_ISSUE`  |
| `op_underfunded`         | `RETRY_AFTER_ACTION`  | `FUNDS_STUCK`          |
| `op_line_full`           | `RETRY_AFTER_ACTION`  | `CONFIGURATION_ISSUE`  |
| `op_no_issuer`           | `DO_NOT_RETRY`        | `CONFIGURATION_ISSUE`  |
| `op_malformed`           | `DO_NOT_RETRY`        | `CONFIGURATION_ISSUE`  |
| `op_too_few_offers`\*     | `RETRY_AFTER_ACTION`  | `NONE`                 |
| `op_cross_self`\*         | `RETRY_AFTER_ACTION`  | `NONE`                 |
| `op_over_source_max`\*    | `RETRY_AFTER_ACTION`  | `NONE`                 |
| `op_under_dest_min`\*     | `RETRY_AFTER_ACTION`  | `NONE`                 |

\* Path-payment-specific: these reflect the offer book / price bounds at
execution time, not account configuration, so retrying isn't unsafe — just
pointless until the underlying market condition changes.

**Fee-bump transactions**: see
[Fee-bump transactions](docs/architecture.md#fee-bump-transactions) in the
architecture doc. In short, `tx_fee_bump_inner_failed` requires
`innerResultCode` (the inner transaction's own result code) to reach a
decision, and delegates to the exact same rule that code would trigger on
its own — a fee-bump-wrapped `tx_bad_seq` carries the same
`DUPLICATE_PAYMENT` risk as an unwrapped one.

**Uncertain submissions** (not a confirmed transaction outcome):

```js
evaluateRetrySafety({
  submissionStatus: "TIMEOUT", // or "NOT_FOUND", or httpStatus: 502 | 503 | 504
  transactionHash: "…", // optional, but recommended
});
```

Always returns `UNKNOWN` / `UNCERTAIN_SUBMISSION`, and always recommends
checking the original transaction's actual status before submitting
anything new. `"NOT_FOUND"` (a stellar-rpc `getTransaction` outcome) is
kept distinct from `"TIMEOUT"`: it means the queried node has no record of
the transaction, which can mean it hasn't propagated yet or fell outside
that node's retention window — not that it failed.

A `"DUPLICATE"` submission status (this exact transaction was already known
to the node) — from stellar-rpc's `sendTransaction`, or from Horizon's
`POST /transactions_async` (same underlying status, same handling) — is
treated the same way as `"PENDING"` — poll and don't resubmit — but is not
silently folded into it: both adapters mark it with
`context.duplicateSubmission: true`, which shows up as distinct evidence
in the result.

This list will grow; see [Roadmap](#roadmap).

## CLI

`@stellar-txguard/cli` exposes the same engine as a command-line tool. It
never signs, submits, or resends a transaction — every command is
read-only analysis, calling the exact same `@stellar-txguard/core`
evaluator this README already describes (no separate safety logic lives in
the CLI).

Not yet published to npm (see [Installation](#installation)) — run it from
a clone:

```bash
node packages/cli/bin/txguard.js --help
node packages/cli/bin/txguard.js decode <xdr>
node packages/cli/bin/txguard.js retry-safety <transaction-hash>
```

Once linked (`npm install` at the repo root sets up the workspace `bin`),
the shorter form also works from within the repo:

```bash
npx txguard --help
```

See [CLI](docs/architecture.md#cli) in the architecture doc, or `txguard
--help`, for the full command reference (network selection, `--json`
output, exit codes, and the evidence flags like
`--verified-no-prior-success`).

## Architecture

Adapters translate real Horizon/RPC responses into a normalized shape,
optionally decoding raw XDR along the way; `evaluateRetrySafety()` then
runs a linear, deterministic pipeline over that shape: normalize input,
run rules, produce a decision with evidence. No network calls happen
inside the evaluator itself, no AI/LLM logic, no hidden state. See
[`docs/architecture.md`](docs/architecture.md) for the full breakdown,
including why each rule is as conservative as it is and the full XDR
decoding trust boundary.

## Dependencies

`@stellar-txguard/core` has **zero runtime dependencies** — this includes
the adapters, which never decode XDR on their own (see
[docs/architecture.md](docs/architecture.md#adapters)).

`@stellar-txguard/xdr` is a **separate, optional** package for callers who
want XDR decoded automatically instead of handling `tx_failed_undecoded`
themselves. It has exactly one dependency,
[`@stellar/stellar-xdr-json`](https://www.npmjs.com/package/@stellar/stellar-xdr-json)
(official, SDF-published, zero further transitive dependencies) — chosen
over `@stellar/stellar-sdk` specifically to avoid pulling in that SDK's
HTTP client dependencies for what is, here, pure struct decoding. See
[XDR decoding](docs/architecture.md#xdr-decoding) for the full reasoning,
including why `@stellar/stellar-base` was considered and rejected
(deprecated).

`@stellar-txguard/cli` depends on `@stellar-txguard/core` and
`@stellar-txguard/xdr` — nothing else. No argument-parsing framework (it
uses Node's built-in `node:util.parseArgs`) and no HTTP client library (it
uses Node's built-in `fetch`).

## Development / testing

```bash
npm install       # install workspace dependencies
npm test          # run all tests (Node's built-in test runner)
npm run lint       # syntax-check all source files
```

Tests use deterministic fixtures only — no live Stellar RPC/Horizon calls.
Adapter tests read synthetic, schema-representative response fixtures from
[`packages/core/test/fixtures/`](packages/core/test/fixtures/) (see that
directory's `README.md`); none of them are real recorded network data.
Real testnet fixtures may be added later as a separate, explicitly-marked
integration suite.

## Roadmap

This is an early-stage project. Near-term priorities, roughly in order:

- Further broaden operation-level rule coverage (e.g. `op_low_reserve` and
  other non-payment operation types as they come into scope).
- Publish `@stellar-txguard/core`, `@stellar-txguard/xdr`, and
  `@stellar-txguard/cli` to npm (currently workspace-only; see
  [Installation](#installation) / [CLI](#cli)).
- Real Stellar testnet integration fixtures, kept separate from the
  deterministic unit test suite that uses synthetic fixtures today —
  including exercising the CLI against a real (testnet) Horizon/RPC
  endpoint, which hasn't been possible in every development environment
  this project has been built in so far.
- A web application for interactively exploring a transaction's
  retry-safety (after the core engine's rule coverage is solid).
- An optional AI explanation layer on top of the (still deterministic)
  safety decision — for explaining a decision in plain language, not for
  making it.

Not currently planned: a wallet, a payment app, a browser extension, or
authentication/account systems within this repository.

## Contributing

Contributions are welcome, especially new deterministic rules backed by
real Stellar result codes and Node's built-in test runner (`node:test`)
coverage.

- Keep the core package (`packages/core`) dependency-free and
  framework-independent.
- Every new rule needs tests covering both the `decision` and the
  `recommendedActions`.
- When in doubt, prefer `UNKNOWN` over a guess. A rule that claims safety
  without evidence is worse than no rule at all.
- Open an issue before starting large changes so the approach can be
  discussed first.

## License

[MIT](LICENSE)
