# Extension points

1. `ExperienceArtifact` is the exact-byte descriptor boundary: subject, media type, source revision and SHA-256 bytes.
2. `formalExperienceProofDigest()` is the pre-signature identity of artifact + Motors 1–3.
3. The signed `RUNTIME` identity `proof:<revision>:<descriptorDigest>:<formalDigest>` is the bridge into `@nexus/evidence`.
4. `@nexus/evidence` remains the only Motor 4 signing authority; Motor 4 must not introduce a parallel signature format.
5. The five V1 claim kinds are closed by reconstruction. Dependency or status tampering changes deterministic claim/root identities.
6. `EvidenceTrustAnchor` binds the signed bundle, proof-binding record, artifact descriptor, formal digest and complete delivery gate set.
7. Final verification requires actual artifact bytes and re-hashes them; descriptor-only verification is insufficient.
8. Lower motors never depend on Motor 4.
9. Motor 5 may add originality evidence in a later version but Motor 4 V1 must not infer or simulate it.
10. Any weakening of baseline gates, RUNTIME requirement or cross-motor lineage is a compatibility break requiring a new authority/version.
