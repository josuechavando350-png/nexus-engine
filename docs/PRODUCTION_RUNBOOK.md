# NEXUS Production Runbook

## Quality Passport signing policy

NEXUS uses **Ed25519** detached signatures. The private signing key is never committed. Production signing reads `NEXUS_PASSPORT_PRIVATE_KEY_PEM`; verification reads `NEXUS_PASSPORT_PUBLIC_KEY_PEM`. The signature envelope contains the SHA-256 of the exact passport bytes and a key ID derived from the public SPKI bytes.

Key policy:
- Generate a dedicated Ed25519 keypair for Quality Passport signing.
- Store the private PKCS#8 PEM only in the CI secret store used by the protected production environment.
- Distribute/pin the public SPKI PEM to verifiers. Public keys are not secrets.
- Rotate by introducing the new public key before switching the signer. Keep old public keys only for the retention period of passports they signed.
- Never reuse SSH, TLS, developer, cloud-account, or repository deploy keys.
- Verification is fail-closed on missing key, unknown algorithm, key-ID mismatch, payload hash mismatch, malformed JSON, or invalid signature.

Commands:

```bash
NEXUS_PASSPORT_PRIVATE_KEY_PEM="$(cat private.pem)" pnpm passport:sign -- artifacts/browser-capture/quality-passport-ci.json
NEXUS_PASSPORT_PUBLIC_KEY_PEM="$(cat public.pem)" pnpm passport:verify -- artifacts/browser-capture/quality-passport-ci.json
```

## CMS-lite

`@nexus/cms-lite` is deliberately adapter-free. It validates a small document envelope (`slug`, `locale`, optional `updatedAt`, `data`) and delegates domain validation to a caller-owned schema parser. This keeps Sanity/Contentful/Notion/filesystem adapters outside the engine core and prevents vendor lock-in.

## Client scaffold

Create a client from the approved experience seed:

```bash
pnpm scaffold -- cliente-ejemplo
```

The command refuses non-kebab-case names and existing targets, copies `apps/_experience-seed`, performs only the explicit `__NEXUS_CLIENT_SLUG__` token substitution, and writes `.nexus/scaffold-manifest.json` with deterministic SHA-256 entries.

## Release / operator sequence

1. Start from a clean checkout of the exact candidate SHA.
2. `corepack enable && corepack prepare pnpm@10.15.0 --activate`.
3. `pnpm install --frozen-lockfile`.
4. `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
5. Run browser evidence and the existing V10 gates.
6. Produce `quality-passport-ci.json`.
7. Sign it with the protected Ed25519 private key.
8. Verify the detached signature with the pinned public key.
9. Run `pnpm third-party-proof` from a clean clone or CI runner.
10. Require a clean Git working tree after validation.

## Third-party acceptance test

The third-party proof intentionally acts only through public CLI/package surfaces. It generates an independent ephemeral Ed25519 keypair, signs and verifies a passport, proves tampering is rejected, scaffolds a client, checks the scaffold manifest, removes the probe, and exits only on full success.

Acceptance marker: `THIRD_PARTY_PROOF_PASS`.
