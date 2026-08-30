# @nexus/proof-carrying-experience

Proof-Carrying Experience binds a concrete experience artifact to independently verifiable evidence from Visual Algebra, Topology, Compositional Semantics, Originality Geodesics and the repository's existing Ed25519 evidence authority.

## Trust boundary

The package deliberately distinguishes **structural proof validation** from **cryptographic authentication**.

`createExperienceProof()` and `validateExperienceProof()` prove deterministic internal linkage only. Every raw `ExperienceProofBundle` carries `authentication: "STRUCTURAL_ONLY"`; a raw bundle must never be treated as proof that an Ed25519 authority actually signed the evidence. Cryptographic authenticity remains owned by `@nexus/evidence` and its signed proof-carrying envelope.

`verifySignedProofCarryingExperience()` is the authenticated boundary. It verifies the Ed25519 bundle with the supplied trusted public key, binds the proof to a SHA-256 fingerprint of that exact public key and to a digest of the exact signature, reconstructs the evidence trust anchor, and re-hashes the delivered artifact bytes before success.

This package does not create a second signing system.

## What the structural proof establishes

A structurally verified proof establishes that the exact artifact descriptor, Visual Algebra term, Topology certificate, Semantic verification result, Originality assessment and evidence trust anchor are mutually linked by deterministic digests and provenance rules.

An evidence trust anchor may be structurally represented without signing metadata for formal/unit use. Authenticated signed envelopes require both `signingKeyFingerprint` and `signatureDigest`; `validateAuthenticatedEvidenceTrustAnchor()` fails closed when either is absent.

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
- Compositional Semantics result, including deterministic replay, and its Motor 1/2 lineage facts;
- Originality assessment, frozen manifold, kNN edges, direct guard, Dijkstra witness and assessment digest;
- originality candidate subject, term digest and complete eight-dimensional metrics against the carried Visual Algebra term;
- subject equality across the artifact and all carried engines;
- evidence trust anchor subject/revision/artifact/formal digest linkage;
- complete seven-gate signed delivery baseline;
- deterministic six-claim graph and root proof digest.

The proof root also binds the explicit `STRUCTURAL_ONLY` authentication marker so callers cannot silently relabel a raw formal proof as cryptographically authenticated.

## Originality claim status

The `ORIGINALITY` claim is `VERIFIED` only when the carried assessment is `CLEAR`. `TOO_CLOSE` and `UNASSESSED` are valid evidence states but make the complete experience proof `REJECTED`. The proof layer never upgrades either state to success.

## Verification against delivered bytes

`validateExperienceProofAgainstContent(proof, content)` first validates the entire structural proof and then hashes the supplied bytes, requiring the resulting SHA-256 to equal the carried artifact digest.

`verifySignedProofCarryingExperience(envelope, publicKey, content)` performs that byte-level check in addition to signed-evidence verification and signing-key fingerprint binding. A valid proof for different bytes, a different public key, or a different signature anchor fails closed.

## Key identity

`keyId` is an evidence-system label. The authenticated proof boundary does not use that mutable label as the cryptographic identity of the signer. Instead it derives `signingKeyFingerprint = SHA-256(SPKI DER public key)` from the actual public key that successfully verifies the Ed25519 bundle and binds that fingerprint into the trust anchor and signed proof envelope.

## Non-claims

A verified originality claim means only that the experience cleared the configured NEXUS structural separation policy over the supplied reference manifold. It does not prove legal originality, copyright non-infringement, plagiarism absence, authorship, aesthetic quality or independent creation.

Likewise, `validateExperienceProof()` alone is not a signature-verification API. Only the signed evidence boundary may make an authenticated delivery claim.
