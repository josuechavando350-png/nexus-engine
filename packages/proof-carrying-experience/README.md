# @nexus/proof-carrying-experience

Motor 4 binds a concrete experience artifact to independently verifiable evidence from Visual Algebra, Topology, Compositional Semantics and a cryptographic trust anchor.

## What it proves

A verified proof establishes that the supplied artifact descriptor, Visual Algebra term, Topology certificate, Semantic verification result and evidence trust anchor are mutually linked by deterministic digests and provenance rules. The proof graph is deterministic and has no clock, randomness, network or hidden mutable state.

A standalone proof validates structural and engine-level integrity. Cryptographic authenticity of the evidence anchor is intentionally delegated to `@nexus/evidence`, which already owns Ed25519 signed evidence bundles. The adapter `@nexus/evidence/proof-carrying-experience` verifies the signature, exact revision delivery gates and an exact artifact-binding RUNTIME record before constructing the trust anchor.

## Artifact binding

Artifacts are SHA-256 digested from exact bytes. The signed evidence adapter requires exactly one verified measured record with identity:

`artifact:<sourceRevision>:<sha256 artifact digest>`

This prevents a proof for one artifact from being replayed against different bytes while keeping the existing evidence source model unchanged.

## Provenance chain

A proof verifies all of the following:

- Visual Algebra term digest is recomputed.
- Topology certified result is fully revalidated and must reference the Visual Algebra term digest.
- Compositional Semantics result is fully revalidated and its initial state must contain the Visual Algebra term digest and Topology certificate digest.
- All engine subjects must equal the artifact subject.
- Evidence trust anchor must bind the same subject, source revision and artifact digest.
- Claims and root proof ID are deterministic digests of the verified chain.

## Status

`VERIFIED` means every claim is verified. Valid but failing upstream certifications are represented as `REJECTED`; malformed or tampered evidence throws instead of being downgraded to a normal rejection.

## Non-claims

This motor does not prove aesthetic quality, legal originality, business truth or accessibility beyond the explicit upstream evidence. It does not replace Ed25519 verification, and it does not implement Motor 5 originality geodesics.
