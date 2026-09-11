# Architecture

StellarTxGuard's core engine (`@stellar-txguard/core`) is intentionally small
and linear. Given a description of a transaction's current state, it
produces a retry-safety decision through a fixed pipeline:

```text
Stellar Horizon / Stellar RPC
            ↓
        Adapters    (adapters/horizon.js, adapters/rpc.js)
            ↓
      Normalized input
            ↓
Normalizer  (evaluator.js: assertValidInput / defaulting)
            ↓
Rule Engine (rules/transaction.js, rules/payment.js, rules/feeBump.js)
            ↓
Decision    (decisions.js: DECISION, RISK, CONFIDENCE)
            ↓
Evidence + Action (evidence.js: buildResult)
```

`evaluateRetrySafety()` — the Normalizer through Evidence + Action stages —
is the part of this pipeline covered by the conservatism guarantees
described below. Adapters are a separate, optional layer in front of it:
they translate real Horizon/RPC response shapes into the plain-object
input `evaluateRetrySafety()` expects, so callers don't have to hand-write
that translation themselves. You can call `evaluateRetrySafety()` directly
with a hand-built object (as in Milestone 1) without ever touching an
adapter — the two layers are independent.

## Collector

Not part of this package. Making the HTTP/RPC request to Horizon or
stellar-rpc, reading an account's sequence number, or catching a
submission timeout is the caller's job. This keeps the core engine free of
network code, API clients, or SDK version coupling, and keeps it testable
with pure data.

## Adapters

`adapters/horizon.js` (`normalizeHorizonTransaction`) and `adapters/rpc.js`
(`normalizeRpcTransaction`) sit between the Collector and the Normalizer.
Each accepts a real Horizon or stellar-rpc response object — auto-detecting
which of that API's response shapes it was given — and returns a plain
object in `evaluateRetrySafety()`'s input shape. They are pure functions
over their input (no network calls of their own); the JSDoc atop each file
documents exactly which response fields are read.

Two design constraints shape both adapters:

- **No XDR decoding by default.** Horizon's transaction *resource* (`GET
  /transactions/{hash}`) and stellar-rpc's `getTransaction` both expose a
  failed transaction's cause only as raw base64 XDR (`result_xdr` /
  `resultXdr`), not a decoded string. Neither adapter decodes that XDR on
  its own — doing so unconditionally would force every consumer of
  `@stellar-txguard/core` to carry an XDR-decoding dependency whether they
  need it or not. Where a decoded code isn't otherwise available, the
  adapter normalizes to the synthetic result code `tx_failed_undecoded`,
  which `evaluateRetrySafety()` always resolves to `UNKNOWN` — a real,
  documented limitation, not a gap papered over with a guess. There are two
  ways to resolve it, both opt-in: pass an already-decoded code yourself
  via `options.resultCode` / `options.operationResultCodes`, or pass
  `options.xdrDecoder` to have the adapter decode it for you using the
  separate `@stellar-txguard/xdr` package. See [XDR
  decoding](#xdr-decoding) below.
- **Context the response doesn't carry is opt-in, not invented.** Neither
  Horizon nor stellar-rpc's transaction responses include the source
  account's *current* sequence number, or whether a caller has already
  checked for a prior successful submission — these require a separate
  account lookup or application-level judgment. Adapters accept them as an
  optional second `options` argument (`currentSequence`,
  `verifiedNoPriorSuccess`, `movesFunds`, `now`, plus the XDR-decoding
  overrides above) rather than defaulting them to something that looks
  plausible.

Malformed or unrecognized adapter input throws `TxGuardAdapterError` (a
different class from `TxGuardValidationError` — the adapter never got far
enough to produce evaluator input at all).

### Horizon `transactions_async`

Horizon's asynchronous submission endpoint — `POST /transactions_async`
(an underscore, not a hyphen; this project initially assumed the hyphenated
form and corrected it after checking `stellar-horizon`'s own
`internal/httpx/router.go`) — returns one of exactly the same four
statuses as stellar-rpc's `sendTransaction`: `PENDING`, `DUPLICATE`,
`TRY_AGAIN_LATER`, `ERROR`. These are not a coincidence — both are thin
wrappers around the identical underlying stellar-core classification
(`stellarcore.TXStatus{Pending,Duplicate,TryAgainLater,Error}`, confirmed
by reading both `go-stellar-sdk/protocols/rpc/send_transaction.go` and
`go-stellar-sdk/protocols/horizon/main.go`'s
`AsyncTransactionSubmissionResponse`). So rather than a second
implementation, `adapters/horizon.js`'s async-submission branch and
`adapters/rpc.js`'s `sendTransaction` branch both call the same
`normalizeSubmissionStatus()` in `adapters/shared.js` — one rule set, two
callers, no duplicated (and potentially divergent) safety logic.

A handful of rarer `POST /transactions_async` responses are Horizon-level
problem+json bodies (`transaction_malformed`, `transaction_submission_failed`,
`transaction_submission_exception`, `transaction_submission_invalid_status`,
`transaction_submission_disabled`, `stale_history`) rather than a
stellar-core submission-outcome classification — a malformed request, or a
Horizon↔Core communication failure where Horizon itself doesn't know what
happened. These are recognized (so the error thrown names which one) but
deliberately not modeled as a normalized transaction state: neither
represents an outcome to reason about retry-safety for in the way the four
statuses above do, and guessing at one would be exactly the kind of
unjustified inference this project avoids elsewhere.

### Normalized transaction model

Both adapters produce the same shape `evaluateRetrySafety()` accepts
directly:`transactionStatus` / `resultCode` for a confirmed outcome, or
`submissionStatus` for an uncertain one, plus optional fee-bump fields
(`isFeeBump`, `innerResultCode`, `innerOperationResultCodes`,
`innerTransactionHash`, `feeBumpTransactionHash`) and a `context` object.
They also attach two extra, purely informational properties that
`evaluateRetrySafety()` ignores:

- `observedState`: one of `NORMALIZED_STATE`'s values (`CONFIRMED_SUCCESS`,
  `CONFIRMED_FAILURE`, `PENDING`, `DUPLICATE`, `NOT_FOUND`,
  `SUBMISSION_TIMEOUT`, `UNKNOWN`) — a human-labeled summary of what the
  network actually reported, for logging/debugging. This exists
  specifically so meaningfully different situations — a confirmed failure,
  a not-found lookup, a timed-out request, a fresh PENDING acceptance vs. a
  recognized DUPLICATE — are never collapsed into a single boolean (or into
  each other) anywhere in this pipeline, even for display purposes.
  `DUPLICATE` in particular: stellar-rpc's `sendTransaction` reports it
  when a submission exactly matches one the node already knows about. Its
  *safety decision* is identical to `PENDING` (poll, don't resubmit — see
  [Adapters](#adapters)'s `normalizeRpcTransaction`), but the underlying
  signal is different enough (a fresh acceptance vs. a recognized repeat)
  that folding it silently into `PENDING` would hide something a caller
  might want to know, e.g. to detect their own accidental retry loop. It
  also sets `context.duplicateSubmission: true`, which
  `evaluateRetrySafety()` surfaces as distinct evidence text.
- `raw`: whichever of `envelopeXdr`/`resultXdr`/`resultMetaXdr`/
  `diagnosticEventsXdr`/`errorResultXdr`/`ledger`/`createdAt` the response
  included, preserved verbatim and undecoded. This is exactly what
  `options.xdrDecoder` consumes when XDR decoding is opted into.

### Why the evaluator does not perform network requests

`evaluateRetrySafety()` takes a plain object, never a URL, hash, or
network client. This is deliberate, not an oversight to fix later:

- **Determinism.** The engine's core guarantee — same input, same output,
  always — is only meaningful if evaluation can't race against ledger
  state changing mid-call. A function that fetches its own data can return
  different answers for the "same" call depending on when it runs.
- **Testability.** Every rule in this package is tested with static
  fixtures and no network stack, mocking, or fake HTTP server. That's only
  possible because rules never reach past their arguments.
- **Composability.** Callers already have their own Horizon/RPC clients,
  retry/backoff policies, and connection pooling. A second, competing
  network client inside the safety engine would conflict with that rather
  than help it.

Adapters don't change this: they still take an already-fetched response
object as a plain argument. Fetching that response is the Collector's job,
one layer further out.

### Confirmed vs. uncertain transaction states

The single most consequential distinction this whole pipeline makes is
between **confirmed** and **uncertain** outcomes, and adapters exist partly
to make sure real API responses land on the correct side of that line
instead of being flattened into "it didn't work, so let's call it failed":

| Confirmed                                   | Uncertain                                      |
| -------------------------------------------- | ----------------------------------------------- |
| Horizon: `successful: true`/`false`, or a submission's `extras.result_codes` | Horizon: an HTTP 502/503/504, or a timed-out request |
| stellar-rpc: `getTransaction` status `SUCCESS`/`FAILED`, or `sendTransaction`/Horizon `transactions_async` status `ERROR` | stellar-rpc: `getTransaction` status `NOT_FOUND` |
| — | Either: `sendTransaction`/`transactions_async` status `TRY_AGAIN_LATER`/`PENDING`/`DUPLICATE` (nothing final happened yet) |
| → `transactionStatus: "SUCCESS"` / `"FAILED"` | → `submissionStatus: "TIMEOUT"` / `"NOT_FOUND"`, or `transactionStatus: "PENDING"` |
| → decision is one of `SAFE_TO_RETRY`, `DO_NOT_RETRY`, `RETRY_AFTER_ACTION`, or a confirmed-but-undecoded `UNKNOWN` | → decision is always `UNKNOWN` with risk `UNCERTAIN_SUBMISSION` |

Note `TRY_AGAIN_LATER` is table-classified as "uncertain" only loosely —
it is in fact a *confirmed* fact (the node definitely did not queue the
submission), which is why it alone among the "nothing final happened yet"
group gets a real `resultCode` (`rpc_try_again_later`, `RETRY_AFTER_ACTION`)
rather than `UNKNOWN`/`UNCERTAIN_SUBMISSION` — see
[`normalizeSubmissionStatus`](#horizon-transactions_async).

`NOT_FOUND` deserves special mention: it is easy to mistake for a
failure ("the node doesn't have it, so it must not have worked"), but a
stellar-rpc node reports `NOT_FOUND` both when a transaction hasn't
propagated yet *and* when it falls outside that node's retention window —
neither case rules out the transaction having succeeded or being about to.
Treating it as a confirmed failure is exactly the kind of shortcut that
produces duplicate payments, so it is routed through the same
`UNCERTAIN_SUBMISSION` path as a timeout, with evidence text that says so
explicitly (see [`evaluator.js`](../packages/core/src/evaluator.js)'s
`buildUncertainSubmissionResult`).

## XDR decoding

`@stellar-txguard/xdr` is a **separate, optional package**. Neither
`@stellar-txguard/core`'s `package.json` nor any file under its `src/`
directory references it — the two packages are connected only through
dependency injection, at the call site, by whoever wants the feature:

```js
import { decodeTransactionResultXdr, decodeTransactionEnvelopeXdr } from "@stellar-txguard/xdr";
import { normalizeHorizonTransaction, evaluateRetrySafety } from "@stellar-txguard/core";

const normalized = await normalizeHorizonTransaction(response, {
  xdrDecoder: { decodeTransactionResultXdr, decodeTransactionEnvelopeXdr },
});
const result = evaluateRetrySafety(normalized);
```

Passing `options.xdrDecoder` is the *only* way XDR decoding happens
anywhere in this pipeline. Omit it, and behavior is byte-for-byte what it
was before this package existed: `tx_failed_undecoded` → `UNKNOWN`. This
is why `normalizeHorizonTransaction()` / `normalizeRpcTransaction()`
conditionally return a `Promise` (only when `options.xdrDecoder` is
supplied, always in that case) rather than becoming unconditionally async
— a caller who never touches XDR decoding shouldn't have to start
`await`-ing calls that used to be synchronous.

**What the decoder does:** given base64 `TransactionResult` XDR (Horizon's
`result_xdr`, stellar-rpc's `resultXdr`), `decodeTransactionResultXdr()`
returns structured information —
`{ resultCode, feeBump, operationResults, innerResultCode, innerOperationResults, raw }`
— using StellarTxGuard's own `tx_*`/`op_*` string vocabulary (translated
from the raw XDR enum names; see below). `decodeTransactionEnvelopeXdr()`
does the same for `envelope_xdr`/`envelopeXdr`, extracting source account,
sequence number, time bounds, and fee-bump inner/outer accounts.

**How the two decode functions are wired independently:** `options.xdrDecoder`
is duck-typed — either function may be present without the other.
`adapters/shared.js`'s `applyXdrDecoder()` applies each independently:
`decodeTransactionResultXdr` only runs when the normalized result is still
`tx_failed_undecoded` and raw `resultXdr` is available (unchanged since
Milestone 3); `decodeTransactionEnvelopeXdr` only runs when raw
`envelopeXdr` is available, and only *fills gaps* in `context` — it sets
`context.originalSequence` / `minTime` / `maxTime` / `currentTime` only for
whichever of those the normalized object doesn't already have from a more
authoritative source (an explicit `options` value, or a field the
response itself supplied directly, e.g. Horizon's `source_account_sequence`
on a transaction resource). It never overwrites those. This precedence —
**explicit option > response's own field > decoded from XDR** — is what
makes envelope decoding safe to always attempt rather than something the
caller has to reason about per response shape.

This is most valuable exactly where the response has no sequence-number or
timebounds field of its own — a Horizon `POST /transactions` submission-
error body, for instance, carries `extras.envelope_xdr` but no
`source_account_sequence`, so without envelope decoding a `tx_bad_seq`
verdict there would have no sequence numbers to cite at all. For response
shapes that don't echo the envelope back (Horizon/stellar-rpc submission
acknowledgements never do — the caller already has the envelope, having
just submitted it), pass it explicitly via `options.envelopeXdr`, which
both adapters accept as a fallback source for `raw.envelopeXdr`.

**What the decoder does not do:** make any retry-safety judgment. It has
no notion of `DECISION`, `RISK`, or `CONFIDENCE` — those concepts don't
exist anywhere in `packages/xdr`. Its entire contract is "XDR in,
structured facts out." The safety decision is still made exclusively by
`evaluateRetrySafety()` in `@stellar-txguard/core`, using those facts as
ordinary input. This split exists so the core's conservatism guarantees
apply uniformly regardless of *how* a `resultCode` was obtained — hand-typed
in a test, read off Horizon's `extras.result_codes`, or decoded from raw
XDR — the evaluator can't tell the difference and doesn't need to.

**Why decoding is a separate package, and why that package owns the
dependency:** `@stellar-txguard/core` is used in contexts (a serverless
function classifying a webhook payload, a CI script, a small utility) where
pulling in a full Stellar SDK for one string-lookup would be disproportionate,
and *not* every caller has undecoded XDR to deal with in the first place —
many will only ever see already-decoded Horizon `result_codes`. Keeping the
dependency in a separate package means that cost is paid only by the
callers who actually need it.

**The dependency itself:** `@stellar-txguard/xdr` depends on
[`@stellar/stellar-xdr-json`](https://www.npmjs.com/package/@stellar/stellar-xdr-json),
published by the Stellar Development Foundation. It was chosen over the
two alternatives considered (evaluated during the Milestone 3 audit):

- `@stellar/stellar-base` — deprecated as of the version available at
  evaluation time ("rolled into `@stellar/stellar-sdk`"), so it fails the
  "actively maintained" bar on its own terms.
- `@stellar/stellar-sdk` — the maintained successor, but it bundles HTTP
  clients (`axios`, `eventsource`) and other SDK surface this package has
  no use for; installing it purely to decode two struct types is exactly
  the "unnecessary runtime weight" this design is trying to avoid.
- `@stellar/stellar-xdr-json` — zero JS dependencies, a `decode(type, xdrBase64)` /
  `encode(type, json)` API operating on the *canonical* XDR JSON Schema
  (generated directly from the same `stellar-xdr` definitions stellar-core
  itself uses, so it can't drift from the protocol independently of the
  network), and versioned to track the protocol version it supports. Its
  cost is a bundled ~3.5MB WebAssembly binary and one-time async
  initialization — real, but fully contained to installations of this one
  optional package.

`packages/xdr/src/codes.js` maps that canonical XDR-JSON vocabulary (e.g.
`"tx_no_account"`, unprefixed payment enum values like `"no_trust"`) onto
StellarTxGuard's `tx_*`/`op_*` strings, which intentionally match Horizon's
own developer-facing naming (e.g. `"tx_no_source_account"`) rather than
the raw XDR names — that mapping was verified directly against Horizon's
own `TransactionResultCode`/`OperationResultCode` → string conversion
source during this milestone's audit (see [Path payments](#path-payments)
for the two naming bugs that audit caught and fixed).

**What happens when XDR can't be decoded, and why `UNKNOWN` is
preferable to guessing:** `decodeTransactionResultXdr()` /
`decodeTransactionEnvelopeXdr()` throw `TxGuardXdrDecodeError` on
malformed base64, truncated bytes, or XDR of the wrong type — they never
return a best-guess structure. This is the same principle that governs
the rest of this package: **if StellarTxGuard cannot establish enough
evidence to determine that a retry is safe, it must not claim that the
retry is safe** — and an XDR blob that fails to decode is exactly a case
with *no* evidence, not weak evidence. When a caller opts into
`options.xdrDecoder` and decoding fails, that error propagates out of
`normalizeHorizonTransaction()` / `normalizeRpcTransaction()` rather than
silently falling back to `tx_failed_undecoded` — a decode failure on data
the caller expected to be valid is worth surfacing loudly, not hiding
behind a conservative-looking but misleading "unknown."

## Normalizer

`evaluateRetrySafety()` in [`evaluator.js`](../packages/core/src/evaluator.js)
validates the shape of the input before anything else runs. Invalid input
(wrong types, missing required fields, an internally inconsistent
`transactionStatus`/`resultCode` pair) throws a `TxGuardValidationError`
immediately. This is deliberately distinct from returning a decision of
`UNKNOWN`: a validation error means the input could not be understood, while
`UNKNOWN` means the input was understood but no rule could reach a confident
decision. Conflating the two would let malformed input silently produce a
plausible-looking (but meaningless) decision.

The normalizer also distinguishes two fundamentally different situations
before rules ever run:

- **A confirmed result.** `transactionStatus` is `SUCCESS` or `FAILED`, with
  a `resultCode` describing exactly what happened.
- **An uncertain submission.** The HTTP request that submitted the
  transaction itself failed or timed out (`submissionStatus: "TIMEOUT"`, or
  an `httpStatus` of 502/503/504). In this case, the transaction may or may
  not have reached the network — a confirmed failure and "we don't know"
  are not the same thing, and treating them the same is how duplicate
  payments happen. See [Why timeouts are special](#why-timeouts-are-special).

## Rule Engine

Rules live in [`rules/transaction.js`](../packages/core/src/rules/transaction.js)
(transaction-level result codes like `tx_bad_seq`),
[`rules/payment.js`](../packages/core/src/rules/payment.js) (operation-level
result codes like `op_underfunded`, including path-payment-specific codes
like `op_too_few_offers`), and
[`rules/feeBump.js`](../packages/core/src/rules/feeBump.js) (fee-bump
outer-envelope codes, which delegate to the other two modules for the
inner transaction — see [Fee-bump transactions](#fee-bump-transactions)
below). Each rule is a pure function: given the normalized input, it
returns a result or (if the code is unrecognized) `null`, which the
evaluator turns into an `UNKNOWN` decision.

Rules never perform I/O and never call out to an LLM or any other
non-deterministic process. The same input always produces the same output.
This is what makes the engine inspectable: a developer (or a future AI
explanation layer, see [Roadmap](../README.md#roadmap)) can point at the
exact rule that fired and the exact evidence it used.

## Decision

Every result carries three independent axes, defined in
[`decisions.js`](../packages/core/src/decisions.js):

- **`decision`** — what the caller should do (`SAFE_TO_RETRY`,
  `DO_NOT_RETRY`, `RETRY_AFTER_ACTION`, `UNKNOWN`).
- **`risk`** — what could go wrong if the caller ignores the decision and
  retries anyway (`DUPLICATE_PAYMENT`, `FUNDS_STUCK`,
  `CONFIGURATION_ISSUE`, `UNCERTAIN_SUBMISSION`, `NONE`, `UNKNOWN`).
- **`confidence`** — how much the decision should be trusted, given the
  evidence available (`high`, `medium`, `low`). A rule that depends on a
  caller-supplied attestation about the outside world (e.g. "I already
  checked transaction history") is capped at `medium`, since the engine
  cannot independently verify claims it wasn't given evidence for.

Keeping these separate (rather than one combined status) lets a caller
build their own policy on top — for example, treating any
`DUPLICATE_PAYMENT` risk as a hard stop regardless of decision, even in a
future version where more rules might be added.

## Evidence + Action

`evidence.js` defines `buildResult()`, the single place every rule
constructs its output through. It validates that the result's `decision`,
`risk`, and `confidence` are all recognized enum values, and that a
`summary` and `reasonCode` are present, so a malformed rule fails loudly
during development rather than producing an inconsistent result silently.

Every result includes:

- `evidence`: the specific facts the decision was based on (result codes,
  sequence numbers, provided context) — not a restatement of the decision.
- `recommendedActions`: concrete next steps, phrased as investigation or
  remediation, not as blanket permission to resubmit.

## Why the engine is conservative

The engine's guiding rule is: **if it cannot prove a retry is safe, it does
not say the retry is safe.** Concretely, this shows up in a few places:

- **`tx_bad_seq` defaults to `DO_NOT_RETRY`.** A stale sequence number is
  exactly the situation where another submission may have already
  succeeded. The engine only returns `SAFE_TO_RETRY` when the caller
  explicitly attests (`context.verifiedNoPriorSuccess: true`) that they
  checked account history and ruled that out — the engine will not infer
  this from sequence numbers alone, since advancing sequence numbers are
  consistent with both "a prior submission succeeded" and "an unrelated
  transaction happened to also advance it."
- **Sequence numbers are never passed through `Number(...)`.** Discovered
  via a real Stellar Testnet transaction whose `source_account_sequence`
  (`19801804984287233`) exceeds `Number.MAX_SAFE_INTEGER`: converting a
  sequence number with `JavaScript`'s `Number(...)` silently rounds it —
  two genuinely different real sequence numbers can even round to the
  same `Number`. `context.originalSequence` / `context.currentSequence`
  are canonical decimal strings end to end (validated by
  `evaluateRetrySafety()`, compared exactly via `BigInt` in
  [`sequence.js`](../packages/core/src/sequence.js)) — see [Sequence
  numbers](../README.md#sequence-numbers) in the README for the full
  contract. Accepting a plausible-but-imprecise number here would have
  been exactly the kind of silent, unverified inference this project
  exists to avoid.
- **Unrecognized result codes return `UNKNOWN`, not a guess.** A missing
  rule is a gap in coverage, not evidence of safety. `UNKNOWN` makes that
  gap visible instead of silently defaulting to something that might be
  wrong.
- **Operation-level payment failures are scoped to what atomicity actually
  guarantees.** Because Stellar transactions are atomic, a failed operation
  never moves funds by itself — so these rules don't carry
  `DUPLICATE_PAYMENT` risk. But they also never claim a plain retry is
  correct: `op_no_issuer` and `op_malformed`, for instance, indicate the
  transaction was constructed incorrectly, and resubmitting it unmodified
  will just fail again for the same reason. Path-payment-specific codes
  (`op_too_few_offers`, `op_cross_self`, `op_over_source_max`,
  `op_under_dest_min`) get `risk: NONE` rather than
  `CONFIGURATION_ISSUE`, deliberately: they reflect market/offer-book
  conditions at execution time, not an account misconfiguration, so a
  blind retry isn't unsafe, just probably pointless until the underlying
  price/liquidity has changed.
- **A confirmed failure with an undecoded cause stays `UNKNOWN`.** Horizon
  and stellar-rpc don't always hand back a decoded result code (see
  [Adapters](#adapters)); when only raw XDR is available, guessing at the
  cause from the transaction status alone is exactly the kind of
  unjustified inference this package refuses to make, so it returns
  `UNKNOWN` (`tx_failed_undecoded`) rather than picking the most likely
  code.

### Fee-bump transactions

A fee-bump transaction (CAP-15) has an outer envelope and an inner
transaction, and the network reports two separate outcomes for them:
whether the fee bump itself reached consensus (`tx_fee_bump_inner_success`
/ `tx_fee_bump_inner_failed`), and, if it did, whether the wrapped inner
transaction actually succeeded. Treating a fee-bump result as an ordinary
transaction result would silently discard that distinction — a caller
checking only the outer code could see `tx_fee_bump_inner_failed` and,
finding no matching rule, either mishandle it or fall through to a wrong
assumption.

`rules/feeBump.js` handles this explicitly:
`tx_fee_bump_inner_success` is treated like `tx_success` (with the same
`movesFunds`-gated `DUPLICATE_PAYMENT` risk). `tx_fee_bump_inner_failed`
requires the caller to supply `innerResultCode` (and
`innerOperationResultCodes`, if the inner transaction failed at the
operation level) — the module then delegates to the exact same
`evaluateTransactionRule` / `evaluatePaymentRule` functions used for
ordinary transactions, so a fee-bump-wrapped `tx_bad_seq` carries the same
`DUPLICATE_PAYMENT` risk and investigation guidance as a plain one would.
If `innerResultCode` is missing, the result is `UNKNOWN` — the engine will
not assume a fee-bump failure is benign just because the outer envelope
was accepted.

### Path payments

Path-payment operation result codes that describe account-level problems
(no trustline, not authorized, no destination, underfunded, line full, no
issuer, malformed) are identical in meaning to the equivalent `Payment`
operation codes and are handled by the same rules in `rules/payment.js`.
The codes unique to path payments (`op_too_few_offers`,
`op_cross_self`, `op_over_source_max`, `op_under_dest_min`) describe
the state of the offer book and the transaction's price bounds, not
account configuration — see the note under
[Why the engine is conservative](#why-the-engine-is-conservative) above
for why they carry `risk: NONE` instead of `CONFIGURATION_ISSUE`.

**Milestone 3 audit correction:** Milestone 2 shipped these two path-payment
codes under the wrong strings — `op_offer_cross_self` and `op_over_send_max`
— names that read plausibly but never appear in real Horizon output and so
would have silently fallen through to `UNKNOWN` for every real occurrence.
Verified against Horizon's own `PathPaymentStrictReceiveResultCode` /
`PathPaymentStrictSendResultCode` → string conversion
(`internal/codes/main.go` in `github.com/stellar/stellar-horizon`), the
correct strings are `op_cross_self` (shared with `ManageBuyOffer` /
`ManageSellOffer`'s identical CROSS_SELF code) and `op_over_source_max`.
Both are fixed in `rules/payment.js`, with regression tests asserting the
old, incorrect strings are *not* recognized (`packages/core/test/payment.test.js`).

### Why timeouts are special

An HTTP timeout or 504 on submission means the request that would tell you
whether the transaction succeeded never completed — not that the
transaction failed. Immediately building and submitting a brand new
transaction for the same intent, on the theory that "the first one
probably failed," is exactly the pattern that produces duplicate payments
in practice: the original transaction can still be included in a later
ledger. So `evaluateRetrySafety()` returns `UNKNOWN` with risk
`UNCERTAIN_SUBMISSION`, and its recommended actions always lead with
checking the original transaction's actual status (by hash if available,
otherwise via the account's sequence number and recent history) before
considering any new submission.

## CLI

`@stellar-txguard/cli` (`packages/cli`) is a thin presentation layer over
`@stellar-txguard/core` and `@stellar-txguard/xdr` — it introduces no new
safety logic. Its structure:

```text
bin/txguard.js          shebang entrypoint: parses process.argv, calls
                         src/cli.js, sets process.exitCode (never calls
                         process.exit() directly, so runCli() stays testable)
src/cli.js               argument parsing (node:util.parseArgs) + dispatch
src/commands/            one module per subcommand (decode, inspect,
                         retry-safety), plus shared.js for the logic they
                         share (hash validation, source/network resolution,
                         context-flag parsing)
src/lookup.js             the one place a hash gets turned into a normalized
                         object — both inspect and retry-safety call it,
                         neither reimplements it
src/horizonClient.js,
src/rpcClient.js          thin, read-only fetch wrappers (`fetchImpl` is
                         injectable, so tests never touch the network)
src/networks.js           testnet/mainnet/futurenet Horizon URL presets
src/output.js              formats a RetrySafetyResult for human/JSON output
src/exitCodes.js           the three exit codes (see below)
```

**Read-only by construction.** The CLI never signs or submits anything.
The only network calls it makes are `GET /transactions/{hash}` (Horizon)
and the `getTransaction` JSON-RPC method — both read-only lookups. There is
no code path anywhere in `packages/cli` that constructs a signature,
calls `sendTransaction`, or calls `POST /transactions` /
`POST /transactions_async`.

**No duplicate safety engine.** `retry-safety` calls the exact same
`evaluateRetrySafety()` this whole document describes; `decode` calls the
exact same `decodeTransactionResultXdr()` / `decodeTransactionEnvelopeXdr()`
from `@stellar-txguard/xdr`. The CLI's own code is limited to: turning argv
into a normalized object (fetch + adapter), and formatting that object's
result for a terminal.

**Horizon 404 → `NOT_FOUND`, not silence.** Horizon's transaction resource
has no `NOT_FOUND` concept of its own (unlike stellar-rpc's `getTransaction`)
— a nonexistent transaction is just an HTTP 404. `lookup.js` translates
that 404 into the same `submissionStatus: "NOT_FOUND"` shape
`normalizeRpcTransaction()` already produces for stellar-rpc, so a
not-yet-propagated (or unknown) transaction gets the same conservative
`UNKNOWN` / "don't submit something else" treatment regardless of which
backend answered. Horizon 502/503/504 similarly pass through as
`httpStatus`, reusing the core's existing uncertain-submission handling
rather than introducing a second way to express the same idea.

**Exit codes** (`src/exitCodes.js`):

| Code | Meaning |
| ---- | ------- |
| `0` | Analysis completed; a decision was reached (`SAFE_TO_RETRY`, `DO_NOT_RETRY`, or `RETRY_AFTER_ACTION`), or `decode` succeeded. |
| `1` | Usage error, invalid hash, decode failure, or network/runtime error. |
| `2` | Analysis completed, but the decision is `UNKNOWN`. |

`2` is deliberately distinct from `1`: reaching `UNKNOWN` is the tool
working correctly (insufficient evidence, honestly reported), not a
failure — scripts that want to branch on "TxGuard couldn't tell" can check
for exit code `2` specifically rather than treating every non-zero exit as
the same kind of problem.

**Error presentation.** Every command-level error goes to `printError`
(stderr) as a single concise line; stack traces are never shown unless
`TXGUARD_DEBUG` is set in the environment. This applies uniformly to usage
errors (missing/invalid arguments), decode failures, and network failures
— the CLI does not distinguish between them in how they're *displayed*
(all stderr, all exit `1`), only in the message text.
