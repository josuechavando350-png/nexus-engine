# RMC-003.2 — Log topic words

Additive, protocol-agnostic prerequisite to RMC-003 / RMC-003.1.

## Defect

RMC-003 typed every EVM log topic as `Hash32`, whose invariant is
"never all zero". That invariant is right for block, transaction, code and
configuration hashes, but a log topic is an ABI word: an indexed zero address,
zero amount or zero `bytes32` argument is a legitimate all-zero topic. The
chain-evidence decoder therefore rejected valid canonical logs with
`Identity(ZeroValue("hash32"))`.

Observed on exact head `5cbb3365` of RMC-006 (run 36520718316, step "Live
cross-provider historical reserve reconciliation"). The step failed on the
first configurator-lineage window, whose filter includes
`PoolConfiguratorUpdated(address indexed oldAddress, address indexed newAddress)`.
The initial update, emitted when the proxy is created, has `oldAddress = 0`.
The identical error string reproduces locally on the unmodified authority from
a synthetic log with a zero indexed address topic.

## Rule

- `LogTopic` is a 32-byte word that may be zero. It is distinct from `Hash32`:
  - `Hash32 -> LogTopic` is infallible (a hash is a valid word).
  - `LogTopic -> Hash32` is `TryFrom` and rejects zero.
  - `LogTopic == Hash32` compares bytes (e.g. topic 0 against an event
    signature); it constructs nothing.
- `RawLogEnvelope` stores `Vec<LogTopic>`.
  - `RawLogEnvelope::new` keeps its RMC-003 signature (`Vec<Hash32>` topics).
  - `RawLogEnvelope::with_topics` accepts arbitrary words.
  - The transaction hash stays `Hash32`.
- The canonical LOG payload bytes are unchanged: each topic is still exactly
  32 raw bytes. Canonical decode reads topics as words; the transaction hash,
  anchor hashes, semantics and provenance hashes still reject zero.
- `Hash32` and `identity.rs` are unchanged.

## Preservation

These must be byte-identical:

- the RMC-003 legacy RawLog digests;
- the RMC-003.1 typed-observation vectors;
- the RMC-003 / RMC-003.1 test files (`observation_pipeline.rs`,
  `typed_observations.rs`);
- the legacy digest code blocks the RMC-003.1 gate compares textually.

## Tests

`nqc-census-core/tests/log_topic_words.rs` (9 tests):

- zero indexed-address topic accepted, with golden digests produced
  independently by `ci/nqc-census/log_topic_word_vectors.py`;
- deterministic canonical round trip;
- nonzero-topic and legacy digests unchanged;
- `Hash32` still rejects zero; `LogTopic -> Hash32` rejects zero;
- a zero transaction hash or zero anchor block hash in canonical bytes is
  rejected;
- every topic tamper, including zeroing and un-zeroing, is rejected;
- LOG bytes never decode as a header and vice versa;
- strict topic hex; at most four topics.

`nqc-census-chain/tests/log_topic_words.rs` (2 tests):

- a zero-topic log is scanned, window-certified, replayed with no network and
  agreed across two providers;
- a provider's zero transaction hash or zero block hash is still rejected.

## Gates

`nqc-census-log-topic-words.yml` enforces the exact scope, the preservation
above, independent vector regeneration, the test counts, and that PFT,
RMC-001, RMC-002, RMC-004 and RMC-005 are untouched.

- `nqc-census-store.yml` pins `observation.rs` to the RMC-003.2 authority
  commit.
- `nqc-census-chain-evidence.yml` pins `nqc-census-core` to the same commit.
- Both first require the RMC-003.1 authority to be an ancestor of that
  commit.
