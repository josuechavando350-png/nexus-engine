# RMC-003.1 Typed Chain Observations

Status: additive extension of the RMC-003 observation authority. It does not
replace or modify `OBSERVATION_PIPELINE_CONTRACT.md`, which remains the D03
contract; this document only adds what D06 and later nodes need.

Parent authority:

- Protocol/Fork Truth certified commit: `5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf`
  (tree `ef3498da528f85cdb9fdd82222d64773a557f853`)
- RMC-001 identity merge: `cea25577edfcaf89dc8fc8bf60ee04bc01d01a3d`
- RMC-002 effective-source merge: `0d90ee7a7d439d2c658209c8fe176a8dda6bcbcb`
- RMC-003 observation merge: `765dc30fdd178a4960ade1e106669eb0b023fbeb`
- RMC-004 store merge: `ad6cb0366b42d4acc835545f3ba6c68324cadd89`
- RMC-005 admission merge: `5e856c3dc78902b055ed9878c117d3c1469a8fda`
- PR base (after the RMC-005 gate stabilization): `8032f55011625a106cf22a109dbd6af39cb1ecc4`

## 1. Problem closed

RMC-003 could bind only raw logs into an observation: `ObservationDigest` has
no public constructor and `CensusObservation::from_raw_log` was the only way to
obtain an envelope. Getter calls, runtime code and block headers, which every
discovery and state node needs, had no admissible representation. Adding a
second observation model elsewhere would have created a parallel evidence
authority, so the extension lives inside the existing RMC-003 module.

## 2. Observation classes

| class | payload | admissible provenance | raw digest domain |
| --- | --- | --- | --- |
| `LOG` | `RawLogEnvelope` | `ReceiptLog` | `NQC-CENSUS-RAW-LOG-V1` (unchanged) |
| `CONTRACT_CALL` | `ContractCallEnvelope` | `ContractCall` | `NQC-CENSUS-RAW-CONTRACT-CALL-V1` |
| `RUNTIME_CODE` | `RuntimeCodeEnvelope` | `CodeRead` | `NQC-CENSUS-RAW-RUNTIME-CODE-V1` |
| `BLOCK_HEADER` | `BlockHeaderEnvelope` | `BlockHeader` | `NQC-CENSUS-RAW-BLOCK-HEADER-V1` |

`ObservationPayload` is a sealed trait: only these four payloads exist. Their
digests are always computed inside the crate as
`SHA256(domain || 0x00 || canonical_payload_bytes)`. No caller can supply a
digest, and `ObservationDigest` still has no public constructor.

`CensusObservation::observe(anchor, semantics, provenance, payload)` is the
typed constructor. It rejects any provenance authority other than the one
admissible for the class (`ProvenanceClassMismatch`). The observation digest is
the unchanged RMC-003 envelope digest over anchor, semantics, provenance and
the class-separated raw-payload digest.

## 3. Payload semantics

All integers are unsigned big-endian. Addresses are exactly 20 bytes and hashes
exactly 32; zero addresses and zero hashes are rejected by RMC-001 types.
Variable-length values are `len:u32 || bytes`.

- `LOG`: `emitter || tx_hash || tx_index:u32 || log_index:u32 ||
  topic_count:u8 || topics || data || removed:u8`. This is exactly the byte
  sequence the RMC-003 raw-log digest has always hashed; the legacy digest
  function is not modified and golden vectors pin it.
- `CONTRACT_CALL`: `target || caller_flag:u8 [caller] || value:[32] ||
  gas_flag:u8 [gas:u64] || calldata || outcome:u8 || output`. Outcome `1` is
  RETURNED (return data) and `2` is REVERTED (revert data, possibly empty).
  The selector is the first four calldata bytes. Transport, rate-limit,
  provider, and missing-archive-state failures are not outcomes and cannot be
  represented; an adapter must record them as acquisition failures, never as
  chain observations. State overrides do not exist in this payload.
- `RUNTIME_CODE`: `account || code`. Empty code is a valid observation and
  proves absence of code at the anchor, which earliest-code boundary proofs
  require.
- `BLOCK_HEADER`: `encoding:u8 || hash || encoded_header`. For
  `EthereumRlp` (tag 1), construction recomputes `keccak256(encoded_header)`
  and rejects any claimed hash that differs (`HeaderHashMismatch`). Number,
  parent hash, state root, transactions root, receipts root, logs bloom and
  timestamp are parsed from the same bytes (positions 8, 0, 3, 4, 5, 6, 11).
  RLP decoding is strict: non-minimal lengths, single bytes wrapped in string
  prefixes, leading zeros in integers, nested lists, and trailing bytes are
  rejected. Positions 0..=14 are shared by every Ethereum era; later eras only
  append fields. Era-specific field counts are enforced by the chain adapter,
  not guessed here.

A header observation must agree with its anchor on number, hash, parent,
timestamp and state root (`HeaderAnchorMismatch`). `BlockHeaderEnvelope::anchor`
builds a `StateAnchor` from verified header bytes, so anchors need not trust
provider-claimed header fields.

`keccak256` is exported from the core crate as the single Keccak authority for
header binding and for selector/topic derivation from verified signatures.

## 4. Canonical typed encoding

```
"NQC-CENSUS-OBS" || schema:u16 = 1 || class:u8 ||
TLV(1, anchor) || TLV(2, semantics) || TLV(3, provenance) ||
TLV(4, payload) || TLV(5, raw_payload_digest) || TLV(6, observation_digest)
```

`TLV = tag:u8 || len:u32 || value`. Anchor is `chain_id:u64 || genesis ||
fork_lineage || number:u64 || hash || parent || timestamp:u64 || state_root`.
Semantics is `code_hash || configuration_hash`. Provenance is
`authority:u8 || namespace:u16 || locator || request || response`.

`decode_canonical` enforces magic, schema version, class, strict TLV order,
exact field widths, no trailing bytes, all constructor invariants, recomputed
raw and observation digests equal to the stored ones (`DigestMismatch`), and
byte-identical re-encoding. `canonical_bytes` refuses a legacy log observation
whose provenance authority is not `ReceiptLog`.

## 5. Required properties and their tests

`nqc-census-core/tests/typed_observations.rs`:

1. same 32 bytes as LOG data, CALL output, CODE, and HEADER extra data give
   four distinct raw digests and four distinct observation digests;
2. legacy RawLog raw and observation digests are byte-identical to values
   computed by RMC-003 at `8032f550` before this change;
3. canonical round trip and byte-identical re-encoding for every class, and
   replay stability;
4. header hash recomputed; claimed-hash and header-byte tampering rejected;
5. wrong block hash, number, parent, timestamp or state root in a header anchor
   rejected;
6. wrong chain rejected by `require_anchor` and changes the observation digest;
7. every non-admissible provenance authority rejected for every class;
8. every single-byte flip (two masks) of every class's canonical bytes rejected;
9. stale digests after a content change rejected;
10. truncation at every length, trailing bytes, bad magic, wrong schema,
    unknown class, wrong class, and reordered TLV rejected;
11. changed output byte, selector, target, call context or header changes the
    digest;
12. reverted calls keep status and revert bytes; empty code is preserved;
13. non-canonical or incomplete RLP headers rejected;
14. Keccak-256 reference vectors, including rate-boundary lengths.

`ci/nqc-census/typed_observation_vectors.py` is an independent Python
implementation (its own Keccak, RLP, encoders) that regenerates
`typed-observation-vectors.json` byte-for-byte; CI also checks that every
golden digest pinned in the Rust test appears in that file. All vectors are
synthetic serialization vectors, not chain evidence.

## 6. Boundaries

- No RPC, network, process, signer or protocol-specific code in the core.
- No Aave, V2 or other protocol semantics.
- The RMC-003 D03 contract, stage pipeline, capability matrix, and their tests
  are unchanged.
- The RMC-004 workflow previously pinned `observation.rs` to the RMC-004 base
  forever. This PR advances that single pin to the RMC-003.1 authority commit
  in an explicit, reviewable step; all other RMC-001..005 pins are unchanged.

## Exit condition

RMC-003.1 is complete only when the exact PR head passes its dedicated workflow
and every existing Census workflow it triggers: exact scope, PFT and
RMC-001..005 immutability, independent vector regeneration, the 14 typed tests,
full locked fmt/clippy/test/build.
