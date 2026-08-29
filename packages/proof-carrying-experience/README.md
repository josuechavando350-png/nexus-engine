# @nexus/proof-carrying-experience

Proof-Carrying Experience binds a concrete experience artifact to independently verifiable evidence from Visual Algebra, Topology, Compositional Semantics, Originality Geodesics and the repository's existing Ed25519 evidence authority.

## What it proves

A verified proof establishes that the exact artifact descriptor, Visual Algebra term, Topology certificate, Semantic verification result, Originality assessment and signed evidence trust anchor are mutually linked by deterministic digests and provenance rules.

The proof layer does not create a second signing system. Cryptographic authenticity remains owned by `@nexus/evidence` and its Ed25519 `SignedEvidenceBundle`.

## Formal proof binding

Before signed evidence is attached, `formalExperienceProofDigest()` covers:

- artifact descriptor digest (subject, media type, revision and SHA-256 artifact bytes);
- Visual Algebra term digest;
- Topology certificate digest;
- Compositional Semantics certificate digest;
- Originality Geodesics assessment digest.

The signed evidence bundle must contain exactly one verified measured `RUNTIME` record with identity:

`proof:<sourceRevision>:<artifactDescriptorDigest>:<formalDigest>`

and must declare `RUNTIME` as a required source in addition to the repository delivery baseline (`CAPTURE`, `QUALITY`). Because that record is inside the Ed25519-signed bundle, a different internally valid Motor 1–5 chain cannot reuse an old signed artifact/delivery bundle.

## Provenance chain

A proof revalidates all of the following:

- Visual Algebra term digest;
- Topology certified result and its Visual Algebra source term;
- Compositional Semantics result and its Motor 1/2 lineage facts;
- Originality assessment, frozen manifold, kNN edges, direct guard, Dijkstra witness and assessment digest;
- originality candidate subject, term digest and complete eight-dimensional metrics against the carried Visual Algebra term;
- subject equality across the artifact and all carried engines;
- evidence trust anchor subject/revision/artifact/formal digest linkage;
- complete seven-gate signed delivery baseline;
- deterministic six-claim graph and root proof digest.

## Originality claim status

The `ORIGINALITY` claim is `VERIFIED` only when the carried assessment is `CLEAR`. `TOO_CLOSE` and `UNASSESSED` are valid evidence states but make the complete experience proof `REJECTED`. The proof layer never upgrades either state to success.

## Verification against delivered bytes

`verifySignedProofCarryingExperience(envelope, publicKey, content)` requires the actual bytes being verified. It re-hashes them and requires both the artifact SHA-256 and descriptor digest to match the carried proof before accepting the signed evidence anchor.

## Non-claims

A verified originality claim means only that the experience cleared the configured NEXUS structural separation policy over the supplied reference manifold. It does not prove legal originality, copyright non-infringement, plagiarism absence, authorship, aesthetic quality or independent creation.
