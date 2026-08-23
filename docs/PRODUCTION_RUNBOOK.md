# NEXUS Production Runbook

## Release rule

A release is valid only when the exact candidate SHA passes the real workflows. Environment variables or manually asserted flags are not evidence. Missing evidence is a failure.

## Quality Passport signing

Production signing is intentionally **disabled pending the owner decision** recorded in `docs/SIGNING_DECISION.md`. The accidental file-secret Ed25519 implementation from PR #84 is not authoritative and must not be used.

Whichever model is selected must satisfy all of these invariants:
- the private signing capability is never committed to the repository;
- ordinary test/build jobs cannot sign;
- signing identity is bound to the exact candidate SHA and Quality Passport bytes;
- a third party can verify without trusting NEXUS servers;
- tampering, identity mismatch, missing evidence and malformed bundles fail closed;
- historical verification remains possible after rotation or provider changes.

## CMS-lite

`lib/cms-lite.mjs` provides a deliberately small vendor-neutral content envelope: `slug`, `locale`, optional `updatedAt`, and caller-validated `data`. It contains no vendor SDK and no remote write path. Domain validation stays with the client application.

## Client scaffold

```bash
pnpm scaffold -- cliente-ejemplo
```

The command requires a kebab-case name, refuses an existing target, copies `apps/_experience-seed`, performs only the explicit client-slug token substitution, and writes `.nexus/scaffold-manifest.json` containing deterministic SHA-256 entries.

Every real client enters `apps/` from the start of delivery.

## Release / operator sequence

1. Start from a clean checkout of the exact candidate SHA.
2. Enable pinned pnpm and run `pnpm install --frozen-lockfile`.
3. Run `pnpm security-hygiene` and the retained V3 runtime-boundary gate.
4. Run `pnpm verify:assets`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
5. Run `pnpm build` once. Preserve `.artifacts/web-build` together with `.artifacts/web-build-identity.json`; do not rebuild per environment.
6. Upload and download that artifact pair, then run `pnpm verify:artifact -- --artifact-root <downloaded-web-build> --manifest <downloaded-identity.json> --source-revision <candidate-sha>`. Any added, removed, or byte-modified file is a release failure.
7. Run real Chromium/WebKit evidence with `pnpm test:browser` and the browser-quality workflow.
8. Run locked Rust tests, lint, release build and optional adapter compilation.
9. Run `pnpm operability:h07` from the clean-room workflow.
10. Run `pnpm third-party-proof` through public surfaces only.
11. Require a clean working tree and exact source SHA before merge/release.
12. After a signing model is approved, add the signature verification step as an additional required proof; it never replaces the checks above.

## Third-party acceptance proof

`pnpm third-party-proof` validates CMS-lite, creates a temporary client only through the public scaffold CLI, verifies the generated manifest, runs the declared-asset guard, removes its probe and exits only on success.

Until the signing model is selected it prints `PASSPORT_SIGNATURE_PROOF_PENDING_KEY_MODEL_DECISION`; this is deliberately not a PASS for passport signing.

Acceptance marker for the currently implemented public surfaces: `THIRD_PARTY_PROOF_PASS`.
