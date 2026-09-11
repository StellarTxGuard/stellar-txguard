# Fixtures

Every JSON file under `horizon/` and `rpc/` in this directory is a
**synthetic, hand-constructed example** of the corresponding Horizon or
Stellar RPC response schema, **with one exception**:
[`horizon/real_testnet_op_no_destination.json`](horizon/real_testnet_op_no_destination.json)
is real Stellar Testnet data — see its own `_provenance` field for exactly
how it was obtained and independently verified (the payload was
cross-checked by re-decoding `envelope_xdr`/`result_xdr` with
`@stellar-txguard/xdr` and independently recomputing the transaction hash;
the signing secret key was never seen by, or provided to, the assistant
that added this fixture). Every other fixture in this directory was never
recorded from a real network, and no hash, account ID, or ledger number in
them corresponds to a real Stellar transaction or account.

Account IDs in the synthetic fixtures use an obviously placeholder
repeated-character pattern (e.g. `GAAAAAAAAAAAA...`), and hashes/XDR blobs
use short repeated-character or clearly-labeled placeholder strings. They
exist only to exercise `normalizeHorizonTransaction()` /
`normalizeRpcTransaction()` against response shapes that match the real
Horizon and stellar-rpc API schemas.
