# RMC-004 Durable Evidence Store Contract

Status: implementation contract for D04 of the Real Market Census dependency DAG
(controls 99 Checkpoint/Resume, 104 Compressed State Storage, 105 Deduplicated
Evidence Storage, plus the Chain/Fork Truth evidence discipline of controls 91
and 94 and the Certification hard rules 199, 200 and 202).

Parent authority:

- Protocol/Fork Truth certified commit: `5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf`
- Protocol/Fork Truth certified tree: `ef3498da528f85cdb9fdd82222d64773a557f853`
- RMC-001 canonical identity merge: `cea25577edfcaf89dc8fc8bf60ee04bc01d01a3d`
- RMC-002 effective-source merge: `0d90ee7a7d439d2c658209c8fe176a8dda6bcbcb`
- RMC-003 observation/stage merge (RMC-004 base): `765dc30fdd178a4960ade1e106669eb0b023fbeb`

Implementation: `nqc-census/crates/nqc-census-store` (library, offline verifier
binary `nqc-census-store-verify`, fixture example `rmc004_fixture`).

## 1. What RMC-004 closes and what it does not claim

RMC-004 provides a durable, deterministic, content-addressed evidence store that
survives crashes, resumes historical range work without silent gaps or overlaps,
reconstructs its own catalog cache from append-only authority, certifies only the
ranges it can prove, and can be verified offline from the directory alone.

It does **not** claim that any market, deployment, borrower or position exists,
that any stored range is the complete market universe, that any capital, route,
auction outcome, opportunity or P&L exists, or any Shadow, Canary, competitive,
top-tier or production property. All fixture data is synthetic and exists only to
exercise storage semantics. A certified range proves that evidence for those blocks
is durably stored with continuous lineage anchors; it does not prove that the
evidence content itself is complete or correct for any Census question. Those
proofs belong to later RMC stages that will consume this substrate.

## 2. Authority model

| Layer | Path | Authority | Mutation |
| --- | --- | --- | --- |
| Store policy | `STORE` | authoritative, sealed | write-once |
| Immutable CAS | `objects/chunks/**`, `objects/artifacts/**` | authoritative, content-addressed | write-once, never replaced |
| Stream scope | `streams/<scope>/SCOPE` | authoritative | write-once |
| Range catalog | `streams/<scope>/checkpoints/<seq>` | **the only authority for committed progress** | append-only, write-once |
| HEAD cache | `streams/<scope>/HEAD` | none (acceleration only) | atomically replaced |
| Staging | `tmp/*` | none | created and removed by writers |

Rules:

1. Committed progress is exactly the contiguous checkpoint prefix `0..=n`. A
   checkpoint is committed when its catalog name exists; that name only ever
   appears via `link(2)` of a fully written, fsynced staging file.
2. HEAD is a cache. It is never the sole source of any fact. It is validated
   against the checkpoint it names before use, rebuilt from the catalog when
   absent or structurally corrupt, and a well-sealed HEAD that contradicts the
   catalog (other scope, other identity, or a sequence that is not durable) is
   tamper evidence: recovery and commits fail closed and never overwrite it.
3. Staging files are never authoritative, even when they contain a valid object.

## 3. Canonical encoding

Every durable object is:

```
MAGIC "NQC-CENSUS-STORE" (16 bytes) || format_version u16-be = 1 || kind u8 || fields
field = tag u8 || length u32-be || value
```

Tags are non-zero and strictly increasing; the field set must equal one of the
listed sets exactly; unknown, missing, duplicated or reordered fields and trailing
bytes are rejected; integers are unsigned big-endian; hashes are 32 bytes and
addresses 20 bytes. This is the RMC-001 TLV discipline under a distinct magic, so
a store object can never be parsed as an identity object. After strict parsing,
decoders re-encode and require byte equality (one canonical encoding per value).

Digests use the RMC-001 domain-separation rule `SHA256(domain || 0x00 || payload)`:

| Identity | Definition |
| --- | --- |
| `ArtifactId` | **plain** `SHA256(logical bytes)` — the Protocol/Fork evidence-manifest convention (`artifact_digest_algorithm = sha256`) and the value carried by RMC-003 `EvidenceRef::Artifact` |
| `ChunkId` | `SHA256("NQC-CENSUS-STORE-CHUNK-V1" \|\| 0 \|\| raw chunk bytes)` |
| frame digest | `SHA256("NQC-CENSUS-STORE-FRAME-V1" \|\| 0 \|\| stored frame bytes)` |
| `ConfigId` | `SHA256("NQC-CENSUS-STORE-CONFIG-V1" \|\| 0 \|\| config fields 1..=6)` |
| `ScopeId` | `SHA256("NQC-CENSUS-STORE-SCOPE-V1" \|\| 0 \|\| scope bytes)` |
| `CheckpointId` | `SHA256("NQC-CENSUS-STORE-CHECKPOINT-V1" \|\| 0 \|\| checkpoint bytes)` |
| HEAD seal | `SHA256("NQC-CENSUS-STORE-HEAD-SEAL-V1" \|\| 0 \|\| HEAD fields 1..=3)` |
| gear entry `i` | first 8 bytes (big-endian) of `SHA256("NQC-CENSUS-STORE-GEAR-V1" \|\| 0 \|\| i)` |
| evidence root | `SHA256("NQC-CENSUS-STORE-EVIDENCE-ROOT-V1" \|\| 0 \|\| ConfigId \|\| for each stream in ScopeId order: ScopeId \|\| count u64 \|\| tip CheckpointId or 32 zero bytes)` |

Object kinds and fields:

- **CONFIG (0x01)** `1 chunker u8 = 1 (GEAR-CDC-V1)`, `2 chunk_min u32`,
  `3 chunk_mask_bits u8`, `4 chunk_max u32`, `5 compression u8 (1 RAW_ONLY,
  2 NQC_LZ_V1_WHEN_SMALLER)`, `6 max_artifact_bytes u64`. The `STORE` file adds
  `7 ConfigId` as a seal. Bounds: `64 <= chunk_min < chunk_max <= 4 MiB`,
  `4 <= chunk_mask_bits <= 24`, `1 <= max_artifact_bytes <= 1 GiB`,
  `ceil(max_artifact_bytes / chunk_min) <= 2^20`.
- **CHUNK FRAME (0x02)** `1 codec u8 (1 RAW, 2 NQC-LZ-V1)`, `2 raw_len u32`,
  `3 payload`. Stored at `objects/chunks/<id[0] hex>/<ChunkId hex>`.
- **MANIFEST (0x03)** `1 ConfigId`, `2 ArtifactId`, `3 logical_len u64`,
  `4 chunk table`: rows of `ChunkId(32) || raw_len u32 || stored_len u32 ||
  frame digest(32)`. Stored at `objects/artifacts/<id[0] hex>/<ArtifactId hex>`.
- **SCOPE (0x04)** `1 chain_id u64`, `2 genesis_hash`, `3 fork_lineage`,
  optional `4 DEPLOYMENT`, `5 stream namespace u16`, `6 stream version u16`,
  `7 stream semantics hash`, `8 origin block u64`, `9 origin parent hash`.
- **DEPLOYMENT (0x08)** `1 protocol family tag u16`, `2 deployment address`,
  `3 deployment instance`. Its chain domain must equal the scope's.
- **CHECKPOINT (0x05)** `1 ScopeId`, `2 sequence u64`, `3 predecessor
  CheckpointId` (present iff sequence > 0), `4 first ANCHOR`, `5 last ANCHOR`,
  `6 evidence`: strictly increasing `ArtifactId`s, 1..=65536.
- **ANCHOR (0x07)** the RMC-003 `StateAnchor` without its chain domain (bound by
  the scope): `1 block u64`, `2 block hash`, `3 parent hash`, `4 timestamp u64`,
  `5 state root`.
- **HEAD (0x06)** `1 ScopeId`, `2 sequence u64`, `3 CheckpointId`, `4 seal`.

## 4. Chunking, compression and the two integrity layers

**GEAR-CDC-V1.** For each chunk, `h = 0`; for every byte `b` from the chunk start,
`h = (h << 1) + GEAR[b] mod 2^64`; the chunk ends after the first byte at index
`i` with `i + 1 >= chunk_min` and `h & top_mask == 0`, where `top_mask` has the
top `chunk_mask_bits` bits set; it ends at `chunk_max` otherwise; a remainder of
at most `chunk_min` bytes is one chunk. Boundaries depend only on the last 64
bytes, so insertions and deletions disturb only nearby chunks and overlapping
snapshots deduplicate (tested: a 15-byte prefix insertion into 64 KiB reuses
at least 80 % of chunks).

**NQC-LZ-V1.** Token stream: `0b0LLLLLLL` + `L + 1` literals, or `0b1MMMMMMM,
d_hi, d_lo` copying `M + 4` bytes from `distance` back (1..=65535, overlap
allowed). The frozen encoder is a greedy single-candidate matcher over a
2^14-entry table keyed by `(u32_le(4 bytes) * 0x9E3779B1 mod 2^32) >> 18`, with
every position inside a match inserted, and literal runs split at 128. The
decoder never writes past the declared `raw_len`, rejects zero or out-of-window
distances, truncated tokens, trailing tokens and short output. A frame uses
NQC-LZ-V1 **exactly** when it is strictly smaller than raw under an
`NQC_LZ_V1_WHEN_SMALLER` policy; any other choice is non-canonical.

**Integrity.** Reading an artifact checks, per chunk: the stored length and frame
digest from the manifest (stored layer) **before** decoding; the decoded length
against both frame and manifest; the `ChunkId` of the decoded bytes (logical
layer); and finally the `ArtifactId` of the whole. A valid compressed frame can
therefore never decode to unverified logical bytes. Verification additionally
re-derives the manifest from the logical bytes and requires byte equality, which,
because the manifest pins each frame digest, proves that chunk boundaries and
codec choices are the canonical ones (no stored-form malleability).

## 5. Publication protocol and crash semantics

Write-once publication: write the bytes to a unique `tmp/` file created with
`O_CREAT|O_EXCL` (mode 0444), `fsync` it, `link(2)` it to its final name,
`fsync` the destination directory, then unlink the staging name. An existing
final name is compared byte for byte: identical bytes are made durable (file and
directory fsync, covering a writer that died before its own directory fsync) and
reported as already present; different bytes are an `ObjectConflict` and nothing
is overwritten. Creating **or adopting** an existing directory also fsyncs its
parent after validating that the directory is local, same-device and not a
symlink; another writer's `EEXIST` is never treated as proof that its directory
entry was durable. HEAD uses the same staging with `rename(2)` and a directory fsync.

Ordering guarantees:

- every chunk and manifest of an artifact is durable before `put_artifact` returns;
- `commit` re-verifies every evidence artifact (integrity and canonicality) and
  fsyncs each of its files and directories before the checkpoint is linked, so a
  checkpoint can never become durable ahead of its evidence;
- the checkpoint and its directory entry are durable before HEAD is touched;
- the predecessor of sequence `n` must exist when `n` is linked, so the catalog is
  always a contiguous prefix.

| Crash point (`FaultPoint`) | State after restart | Proven by |
| --- | --- | --- |
| `ObjectStaged` | staging garbage only; progress unchanged | `crash_during_artifact_publication_never_advances_progress` |
| `ObjectLinked` / `ObjectDurable` | complete, unreferenced object; progress unchanged | same |
| `CheckpointStaged` | durable orphan evidence; progress unchanged; retry creates once | `crash_before_checkpoint_link_does_not_commit` |
| `CheckpointLinked` / `CheckpointDurable` | checkpoint committed, HEAD stale; recovery finds it and repairs HEAD idempotently; retry is `AlreadyCommitted` | `crash_after_checkpoint_authority_recovers_and_repairs_head`, real `abort()` child test |
| `HeadStaged` | as above plus staging garbage | same |
| `HeadRenamed` | HEAD consistent | `crash_after_head_rename_is_consistent` |

Process-crash tests cannot observe power-loss durability. The CI syscall-trace
gate (`check_durability_trace.py`) therefore proves from `strace` that every
staged file is fsynced before it is named (R1) and that every destination
directory is fsynced after each link/rename and before any further publication
(R2). Mutants that drop either fsync are killed by that gate.

## 6. Supported filesystem model

Supported: Linux (Unix; `compile_error!` elsewhere) on a local POSIX filesystem
(ext4, xfs, btrfs; tmpfs gives atomicity without power-loss durability).

Relied upon, and validated where possible:

- `link(2)` atomically creates a name and refuses an existing target with
  `EEXIST` — **probed at store creation** (link, link count 2, second link must
  fail with `EEXIST`); a filesystem without it fails closed.
- `rename(2)` atomically replaces a name within one filesystem, and `link`/`rename`
  require one filesystem — **every store directory must have the root's
  `st_dev`**, checked on every open and by the verifier.
- `fsync` of a file persists its data; `fsync` of a directory persists its entries.
- No store path is a symbolic link — **checked before every read** (`lstat`);
  symlinked directories, files and roots are rejected, never followed.

Not supported: NFS/SMB/FUSE filesystems with weaker link or fsync semantics,
FAT/exFAT (no hard links; creation fails closed), non-Unix platforms, storage
that acknowledges fsync without persisting (a lying disk cache), and a hostile
local process racing the store with write access to its directory (at-rest
tampering is detected; concurrent active attack is out of the threat model).
The cross-device check can only be exercised through a symlinked directory
(tested); a genuine second mount requires privileges the test suite does not use.

## 7. Concurrency model

Correctness does not depend on locks. Multiple writers (threads or processes) may
share a store:

- same artifact, same bytes: one `link` wins, the others observe `EEXIST`, compare
  equal and return the same identity; no staging files leak;
- same checkpoint, same bytes: exactly one `Created`, the rest `AlreadyCommitted`;
- same sequence, different bytes: exactly one winner; every other writer gets
  `SequenceConflict`, deterministically on every retry;
- adjacent sequences from competing lineages: the losing lineage can never attach
  its next checkpoint (`PredecessorMismatch` or `SequenceConflict`), so the chain
  never forks or skips;
- HEAD may lag after racing writers (stale is legitimate); it never names a
  non-durable checkpoint because it is written only after the checkpoint is durable.

## 8. Stream scope, checkpoint chain and continuity

`StreamScope` binds the RMC-001 `ChainDomain` (chain id, genesis, fork lineage),
an optional RMC-001 `DeploymentKey` on that chain, the producer's versioned
`StreamKind` (namespace, version, semantics hash) and the origin (first block and
the parent hash it must extend). Each scope has its own catalog directory named by
its `ScopeId`; a checkpoint whose `ScopeId` or anchor chain differs is rejected.

Each checkpoint must satisfy, individually: anchors on the scope chain; `first <=
last`; a single-block range has identical anchors; an adjacent pair links parent to
child; timestamps do not regress; sequence 0 has no predecessor and starts at the
origin block and origin parent hash; evidence is non-empty. Between `prev` and
`next`: `next.sequence = prev.sequence + 1`, `next.predecessor = id(prev)`,
`next.first.block = prev.last.block + 1` (no gap, no overlap), `next.first.parent
= prev.last.hash` (lineage), and `next.first.timestamp >= prev.last.timestamp`.

A commit whose exact bytes are already committed is `AlreadyCommitted`; different
bytes at a committed sequence are `SequenceConflict`; a sequence whose predecessor
is not durable is `SequenceGap`.

Reorgs: a stream is append-only. A reorg below the durable tip makes the next
checkpoint discontinuous (its parent hash cannot match) and the stream stops,
fail-closed. Invalidation and re-anchoring of evidence after a reorg is a
follow-up (Chain/Fork Truth control 85 at Census scale); RMC-004 never rewrites
committed history.

## 9. Recovery and range certification

Both `recover(scope, Accelerated)` and `recover(scope, Full)` walk the
authoritative checkpoint prefix from sequence 0, revalidate every referenced
artifact, and re-establish checkpoint/catalog durability before publishing or
repairing HEAD. The mode name is retained for API compatibility, but no prefix is
trusted through HEAD: an authenticated skip structure does not exist yet, so HEAD
cannot suppress validation of earlier authority. Both modes repair an absent,
corrupt or stale HEAD idempotently and fail closed on a contradicting or ahead
HEAD.

`certify_range(scope, first, last)` walks from sequence 0, re-proves every link,
fully verifies every referenced artifact, and succeeds only if the contiguous chain
covers `first..=last` (`origin <= first <= last <= durable tip`). Partial history
never certifies a larger range: storing `100..=109` and requesting `100..=110`
fails with `RangeIncomplete { covered_last: Some(109) }`. The certificate names
the completing checkpoint, whose identity commits to the entire chain and its
evidence.

## 10. Offline verifier

`nqc-census-store-verify --store DIR [--require-range SCOPE:FIRST:LAST]...
[--expect-tip SCOPE:CHECKPOINT]...` reads only `DIR`. It requires the exact layout
(any undefined entry is an unknown state and fails), rejects symlinks and foreign
devices, re-derives every name from content, decodes and re-encodes every chunk,
manifest, scope, checkpoint and HEAD, re-proves every link from sequence 0, checks
that every referenced artifact exists and verifies, reports orphans and staging
files (legitimate crash leftovers without authority), fails on a corrupt,
contradicting or ahead HEAD, and prints a deterministic evidence root that is
independent of caches, orphans and staging. `--expect-tip` binds the result to an
externally recorded commitment, which is what detects a wholesale replacement of
the newest checkpoints. Exit status: `0` verified, `1` failed, `2` usage error.

`ci/nqc-census/verify_store_independent.py` is a second implementation of this
contract (Python standard library only, no shared code) that must accept the same
stores, reject the same tampering and print the same evidence root. GitHub Actions
runs both, but neither CI logs nor uploaded artifacts are the evidence authority:
the store directory and these two verifiers are.

## 11. Reuse and justified duplication

Reused authorities: RMC-001 `ChainDomain`, `DeploymentKey`, `Hash32`, `Address`,
`ProtocolFamily` and its domain-separation rule; RMC-003 `StateAnchor` validation
and `EvidenceRef::Artifact`; the Protocol/Fork plain-SHA-256 artifact digest.

Unavoidable duplication, each because `identity.rs` is byte-immutable under the
RMC-001 regression gate and keeps these private: the TLV encoder/decoder (same
rules, distinct magic), the canonical re-encoding of `ChainDomain`/`DeploymentKey`
fields inside a scope, and a `tag -> ProtocolFamily` table whose exhaustiveness is
enforced at compile time by a match in the crate's unit test.

No new dependency: only `nqc-census-core` (path) and the already pinned
`sha2 = "=0.10.9"`. `Cargo.lock` gains exactly one package, `nqc-census-store`.

## 12. Exit condition

RMC-004 closes D04 only when exact-head CI proves: exact PR scope against the
RMC-003 base; RMC-001/002/003 and Protocol/Fork authorities byte-identical; no new
external dependency; a network/secret/signer-free store and verifier source; locked
fmt/clippy/test/build green with the exact test inventory; deterministic fixture
builds; Rust and independent verifiers agreeing on the golden evidence root before
and after relocation and both rejecting the tamper matrix; the verifier running
with an empty environment and no network syscalls; the durability syscall-ordering
gate; every mutant of the mutation gate killed; and a clean tree.
