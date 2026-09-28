# RMC-004 Durable CAS, Checkpoints, and Offline Verifier

Status: implementation contract for D04 from the Real Market Census CENSUS-0 dependency DAG.

Parent:
- RMC-003 merge: `765dc30fdd178a4960ade1e106669eb0b023fbeb`

Protocol/Fork Truth remains closed and immutable:
- certified commit: `5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf`
- certified tree: `ef3498da528f85cdb9fdd82222d64773a557f853`

RMC-004 addresses RMC-GAP-022 and the early evidence/verifier foundation of RMC-GAP-024. It does not scan real markets or certify Census completeness.

## 1. Evidence CAS

Authoritative input/evidence bytes are stored under a SHA-256 content-addressed namespace.

A logical artifact is split into fixed-size chunks. Each chunk is deterministically encoded:

- RUN_LENGTH when the deterministic run-length representation is smaller;
- RAW otherwise.

Both the stored bytes and decompressed bytes have independent SHA-256 digests. A canonical immutable artifact manifest binds:

- schema version;
- original byte length;
- configured chunk size;
- whole-payload SHA-256;
- ordered chunk codecs;
- raw/stored lengths;
- raw/stored SHA-256 digests.

The manifest itself is a CAS object. Its SHA-256 is the artifact identity.

Identical content is deduplicated by address. Existing objects are accepted only if their bytes still hash to the requested identity.

## 2. Durable object publication

New objects are never streamed directly into their final path.

The writer:

1. creates a unique file under the store's temporary directory with create-new semantics;
2. writes all bytes;
3. fsyncs the file;
4. publishes the file atomically with a same-filesystem hard link;
5. verifies an already-existing destination rather than overwriting it;
6. removes the temporary file;
7. fsyncs the destination directory and temporary directory.

This makes a partially written CAS object non-authoritative.

## 3. Persisted store configuration

`STORE_CONFIG` is durable store authority, not a caller default. It binds schema version and chunk size.

Reopening a store reads this configuration. A second process cannot silently choose a different chunking policy and create a second artifact identity regime inside the same store.

## 4. Range scope

Every checkpoint stream has a stable `ScopeId` derived from:

- complete `ChainDomain`;
- deployment identity digest;
- non-zero stream namespace.

A scope is therefore not merely a chain ID or human market name.

## 5. Append-only checkpoint evidence

A checkpoint binds:

- scope;
- monotonic sequence;
- inclusive block range;
- hash immediately before the range;
- final block hash;
- immutable artifact reference;
- previous checkpoint object digest.

The checkpoint bytes are themselves a CAS object.

A committed checkpoint becomes authoritative only when an append-only `NNNN.ref` file has been durably published. `HEAD` is explicitly only a rebuildable cache.

## 6. No-gap / no-overlap / parent-linked continuation

For every checkpoint after the first:

- `sequence = previous.sequence + 1`;
- `from_block = previous.to_block + 1`;
- `parent_before_from_hash = previous.end_block_hash`;
- `previous_checkpoint = previous checkpoint CAS digest`.

Any gap, overlap, parent drift, predecessor drift, scope mismatch, or sequence conflict fails closed.

Completion claims require the verifier's first and last boundaries to equal the caller's explicitly requested range. A partial 500..509 store cannot satisfy a 500..510 request.

## 7. Crash semantics and idempotence

Two failure injection points are part of the contract:

- after the immutable checkpoint object is durable but before the reference exists;
- after the append-only reference is durable but before `HEAD` is updated.

Consequences:

- object-only crashes leave an orphan CAS object, not a committed range;
- reference-durable crashes are recoverable by scanning `.ref` files;
- retrying the exact same committed checkpoint is idempotent and repairs `HEAD`;
- retrying the same sequence with different content is a hard conflict.

A crash cannot turn an uncommitted range into silently accepted progress.

## 8. Rebuildable catalog

The checkpoint directory is reconstructable exclusively from immutable checkpoint objects plus append-only references.

`HEAD` is never the sole authority. `rebuild_head` verifies the chain first and then recreates the cache atomically.

This separation is deliberate:

- CAS = immutable evidence;
- checkpoint refs = durable append-only catalog;
- HEAD = disposable/rebuildable acceleration.

## 9. Offline verification

`nqc-census-store-verify` opens an existing store without RPC, credentials, SaaS, or network authority and verifies:

- store configuration;
- reference syntax;
- checkpoint object SHA-256;
- checkpoint decoding;
- scope identity;
- contiguous sequence;
- contiguous ranges;
- parent linkage;
- previous-checkpoint linkage;
- every referenced artifact manifest;
- every chunk stored digest;
- decompression;
- every chunk raw digest;
- whole-artifact digest;
- requested range boundaries.

A successful invocation emits only:

`RMC_STORE_VERIFY_PASS ...`

and a failure exits non-zero with:

`RMC_STORE_VERIFY_FAIL ...`

CI is an attestation that the verifier works; CI artifacts are not the evidence authority.

## 10. Explicit non-goals

RMC-004 does not claim:

- real market discovery;
- deployment admission;
- borrower coverage;
- oracle freshness;
- token safety;
- capital availability;
- executable routes;
- positive EV;
- competitive capture;
- Shadow readiness;
- Canary readiness;
- production authority.

D05 consumes this durable evidence substrate to build deployment registry/admission.

## Exit condition

RMC-004 closes D04 only when exact-head CI proves:

- exact PR scope;
- RMC-001 identity bytes remain immutable;
- RMC-003 observation/stage core remains regression-green;
- Protocol/Fork inputs remain untouched;
- deterministic chunking/compression and deduplication;
- byte-perfect artifact round-trip across reopen;
- CAS tampering fails closed;
- store chunking configuration survives restart;
- contiguous parent-linked checkpoints survive restart;
- gaps and parent drift fail closed;
- crash after object does not commit progress;
- crash after durable reference is recovered idempotently;
- conflicting same-sequence content fails closed;
- partial-range completion claims fail closed;
- tampered references fail closed;
- the offline verifier binary builds;
- locked fmt/clippy/test/build are green.
