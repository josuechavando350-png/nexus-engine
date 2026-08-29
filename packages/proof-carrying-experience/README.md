# @nexus/proof-carrying-experience

Motor 4 binds a concrete experience artifact to independently verifiable evidence from Visual Algebra, Topology, Compositional Semantics and the repository's existing Ed25519 evidence authority.

## What it proves

A verified proof establishes that the exact artifact descriptor, Visual Algebra term, Topology certificate, Semantic verification result and signed evidence trust anchor are mutually linked by deterministic digests and provenance rules.

Motor 4 does not create a second signing system. Cryptographic authenticity remains owned by `@nexus/evidence` and its Ed25519 `SignedEvidenceBundle`.

## Formal proof binding

Before signed evidence is attached, Motor 4 computes `formalExperienceProofDigest()` over:

- artifact descriptor digest (which includes subject, media type, revision and SHA-256 artifact bytes);
- Visual Algebra term digest;
- Topology certificate digest;
- Compositional Semantics certificate digest.

The signed evidence bundle must contain exactly one verified measured `RUNTIME` record with identity:

`proof:<sourceRevision>:<artifactDescriptorDigest>:<formalDigest>`

and must declare `RUNTIME` as a required source in addition to the repository delivery baseline (`CAPTURE`, `QUALITY`). Because that record is inside the Ed25519-signed bundle, a different internally valid Motor 1–3 chain cannot reuse an old signed artifact/delivery bundle.

`createProofBindingEvidenceRecord()` is the canonical helper for producing that RUNTIME record before the evidence bundle is signed.

## Provenance chain

A proof revalidates all of the following:

- Visual Algebra term digest;
- Topology certified result and its Visual Algebra source term;
- Compositional Semantics result;
- Semantic initial-state `visual.termDigest`, `topology.certificateDigest` and `topology.sourceTermDigest`;
- subject equality across artifact and Motors 1–3;
- evidence trust anchor subject/revision/artifact/formal digest linkage;
- complete seven-gate signed delivery baseline;
- deterministic five-claim graph and root proof digest.

## Verification against delivered bytes

`verifySignedProofCarryingExperience(envelope, publicKey, content)` requires the actual bytes being verified. It re-hashes them and requires both the artifact SHA-256 and descriptor digest to match the carried proof before accepting the signed evidence anchor.

This prevents a valid envelope from being presented alongside modified output bytes.

## Status

`VERIFIED` means every Motor 4 claim is verified. Valid but failing upstream certifications are represented as `REJECTED`; malformed, replayed, unsigned or tampered evidence throws instead of being downgraded to a normal rejection.

## Non-claims

This motor does not prove aesthetic quality, legal originality, business truth or accessibility beyond explicit upstream/signed gate evidence. It does not implement Motor 5 originality geodesics and does not claim a unique mathematical derivation of an HTML/CSS artifact from a Visual Algebra term.
