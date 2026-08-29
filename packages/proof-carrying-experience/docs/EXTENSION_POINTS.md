# Extension points

1. `ExperienceArtifact` is the exact-byte artifact identity surface.
2. `EvidenceTrustAnchor` is a trust input; cryptographic construction belongs to `@nexus/evidence`.
3. `ExperienceProofClaim` is a closed deterministic claim record, not an arbitrary executable predicate.
4. `ExperienceProofBundle` carries full upstream engine evidence plus a digest-linked claim graph.
5. Motors 1–3 never depend on Motor 4.
6. `@nexus/evidence` may depend on Motor 4 to authenticate trust anchors; Motor 4 must not import `@nexus/evidence`.
7. Motor 5 may add originality claims through a future explicit versioned extension; V1 must not reinterpret them implicitly.
8. Artifact bytes, source revision, subjects and certificate digests are compatibility boundaries.
