# RMC Chain-Evidence Layer (shared by D06–D11)

Status: protocol-agnostic acquisition layer. It adds no identity, observation,
evidence-store, checkpoint, or admission authority: it produces RMC-003 typed
observations, persists them in the RMC-004 store, and advances RMC-004
checkpoints.

Parent authority: `b5b5ef5c32203f0eaeb1238c32a0aa160affeb78` (RMC-003.1 merge,
tree `956793d8042e0eba3195a66e3509f1e90b22f2aa`).

## 1. Trust model

Remote JSON-RPC providers are transports, never authorities.

- **Headers** are rebuilt as canonical RLP from the provider's block object and
  accepted only if `keccak256(rlp)` equals the claimed hash (RMC-003
  `BlockHeaderEnvelope`). Field sets follow explicit mainnet eras: London (block
  12,965,000, base fee), Shanghai (timestamp 1,681,338,455, withdrawals root),
  Cancun (1,710,338,135, blob gas fields and beacon root), Prague
  (1,746,612,311, requests hash). The block object must carry exactly its era's
  optional fields, as a prefix in consensus order. Any unknown member fails with
  `UnsupportedHeaderField`, so a future fork cannot be absorbed silently. Probes
  confirmed these field sets on four providers through block 26,079,547.
- **Chain domain**: chain id 1, the declared genesis, and the DAO-fork lineage
  block 1,920,000. All three are re-verified from keccak-checked headers;
  `fork_lineage = sha256("NQC-CENSUS-FORK-LINEAGE-V1" || 0 || chain_id ||
  genesis || 1920000 || lineage_hash)`.
- **State reads** (`eth_getCode`, `eth_call`) are pinned by EIP-1898
  `{blockHash, requireCanonical: true}`, or by number bracketed by header-hash
  checks for providers that lack EIP-1898.
- **Logs** are decoded strictly: only the known members are allowed, `removed`
  must be false, coordinates must be unique, and every log must lie inside the
  requested range and filter. Each log is bound to the verified header of its
  block; a log whose block hash differs is an orphan and fails closed
  (`REORG_LINEAGE_INVALID`).
- **Reverts**: a revert with bytes becomes a REVERTED call observation. Every
  other JSON-RPC error has a deterministic class (`RANGE_TOO_LARGE`,
  `ARCHIVE_STATE_UNAVAILABLE`, `AMBIGUOUS_REVERT`, `PROVIDER_ERROR`) and is
  never an observation. Rate limits and transport failures are retried on a
  fixed schedule and never recorded.
- **Consensus** is byte equality of provider-independent canonical results,
  with at least two providers. There is no voting: any difference becomes an
  UNEXPLAINED `PROVIDER_MISMATCH` record and the dependent claim fails closed.
- **Independence**: providers must differ in namespace, label, URL and declared
  operator. Infrastructure independence is recorded as NOT_PROVEN; client
  versions are recorded as provenance. `rpc-providers.json` records what the
  probes observed.

## 2. Deterministic jobs

A job is a pure function of the replies it receives.

- Request ids are content-derived (sha256 of method and canonical params,
  below 2^53), so every rerun sends identical request bytes.
- Every well-formed reply is recorded before it is interpreted.
- Every typed observation stores
  `provenance = (authority, provider namespace, provider locator, sha256(request),
  sha256(response))`.
- The job manifest (canonical JSON) binds the job descriptor, the ordered
  exchanges, the observations and the canonical result.

Persistence:

- **Point jobs** commit one RMC-004 checkpoint `[anchor, anchor]` whose evidence
  is the manifest plus every artifact.
- **Log scans** commit contiguous window checkpoints over `[first, last]`.
  RMC-004 itself enforces that each window's first header extends the previous
  window's last header, and `certify_range` must cover the whole plan.
- **Unanchored jobs** (bootstrap, anchor resolution) establish what a checkpoint
  needs. They are persisted as artifacts and must be named by the caller's run
  report.

Resume and verification:

- Resume never refetches committed work. It re-executes the job against the
  recorded exchanges (`ReplayTransport`, which fails closed on any unrecorded
  request) and requires the manifest to reproduce byte-for-byte.
- Offline verification is the same replay.
- RMC-004 exposes no public checkpoint reader, so committed checkpoints are read
  through the documented catalog layout (`streams/<scope>/checkpoints/<seq>`).
  They are decoded with the public `Checkpoint::decode` and accepted only after
  `certify_range` and a tip commitment match.

## 3. Primitives

- strict RFC 8259 JSON with canonical writer (sorted keys, duplicate keys
  rejected);
- strict hex (minimal quantities);
- ABI selector/topic derivation and canonical word/array decoding;
- EVM bytecode scan that skips push data and the Solidity metadata tail
  (selector/topic/PUSH20/opcode presence as evidence, not proof);
- earliest-code boundary search with predecessor proof;
- batched and windowed `eth_getLogs` honoring provider limits.

The monotonicity of code presence is a separate claim for callers, e.g. a
self-destruct-free code closure.

## 4. Adversarial tests (`tests/chain_evidence.rs`, 19)

- JSON, hex, JSON-RPC, ABI and bytecode strictness;
- error classes never become observations;
- the real mainnet header 25,437,474 re-hashes exactly, and tampered, unknown,
  missing and padded fields are rejected;
- bootstrap agreement, and a wrong genesis is rejected;
- a point job resumes by replay with zero network requests;
- window-checkpointed scans are certified;
- an omitted log is an UNEXPLAINED mismatch, not a vote;
- an orphan log fails closed;
- an interrupted scan resumes to the identical RMC-004 evidence root;
- a reorg inside a committed window is rejected by RMC-004 as `Discontinuity`;
- a range hole is never certified;
- the earliest-code boundary has its predecessor proof;
- archive gaps and rate limits are typed;
- consensus needs two distinct providers.

`testkit` is a synthetic JSON-RPC chain with keccak-valid headers. It is
never evidence.

## 5. Boundaries

- No signer, private key, or transaction submission (`eth_send*`, `eth_sign*`,
  `personal_*`).
- Live HTTP only in `transport.rs` via the system `curl`; no Rust
  network, TLS or async dependency.
- No new external crate: the workspace lock may only gain the local
  `nqc-census-chain` package.
- No protocol semantics, no economic claim.

## Exit condition

Exact-head CI passes:

- scope and immutability of Protocol/Fork and RMC-001..005 (including
  RMC-003.1);
- the dependency and boundary gates;
- fmt, clippy and the 19 tests;
- a live bootstrap on every declared provider that agrees on the chain domain
  and the 25,437,474 anchor;
- offline replay of that bootstrap from the store.
