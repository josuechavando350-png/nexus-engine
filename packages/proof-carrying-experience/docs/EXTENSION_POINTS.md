# Extension points

1. `ExperienceArtifact` is the exact-byte descriptor boundary: subject, media type, source revision and SHA-256 bytes.
2. `formalExperienceProofDigest()` is the pre-signature identity of artifact + Visual Algebra + Topology + Compositional Semantics + Originality Geodesics.
3. The signed `RUNTIME` identity `proof:<revision>:<descriptorDigest>:<formalDigest>` is the bridge into `@nexus/evidence`.
4. `@nexus/evidence` remains the only signing authority; Proof-Carrying Experience must not introduce a parallel signature format.
5. The six V2 claim kinds are closed by reconstruction: ARTIFACT, VISUAL_ALGEBRA, TOPOLOGY, COMPOSITIONAL_SEMANTICS, ORIGINALITY and SIGNED_EVIDENCE.
6. The originality claim requires a fully revalidated `OriginalityAssessment` whose candidate subject, term digest and metrics equal the carried Visual Algebra term.
7. `EvidenceTrustAnchor` binds the signed bundle, proof-binding record, artifact descriptor, formal digest and complete delivery gate set.
8. Final verification requires actual artifact bytes and re-hashes them; descriptor-only verification is insufficient.
9. Dependency direction is `visual-algebra -> originality-geodesics -> proof-carrying-experience -> evidence`; lower engines never import the proof or evidence layer.
10. Any weakening of baseline gates, RUNTIME requirement, originality linkage or cross-motor lineage is a compatibility break requiring a new authority/version.
