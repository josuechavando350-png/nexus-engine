# `@nexus/mcp-server`

Remote, deterministic MCP control surface for NEXUS. It exposes the approved block 1–4 tools over Streamable HTTP at `POST /mcp`.

## Configuration

- `NEXUS_MCP_TOKEN_SHA256` (required): lowercase SHA-256 of the Bearer token. The raw token is not stored by the server.
- `NEXUS_MCP_WRITE_TOKEN_SHA256` (required to expose `nexus_project_new`): SHA-256 of a separate write-capable Bearer token. The read token never lists or invokes the creation tool.
- `NEXUS_REPOSITORY_ROOT` (optional): checkout root; defaults to the process working directory.
- `NEXUS_GITHUB_REPOSITORY` (optional): `owner/repository`; defaults to `josuechavando350-png/nexus-engine`.
- `NEXUS_GITHUB_TOKEN` (optional): read-only GitHub token used for PR/check state. Without it, `nexus_status` returns `NOT_TESTED` for the GitHub portion rather than claiming there are no PRs.
- `NEXUS_MCP_ALLOWED_HOSTS` (optional locally, required for deployment): comma-separated HTTP Host allowlist. Defaults to `localhost,127.0.0.1`; set it to the public service hostname when hosted.
- `NEXUS_MCP_ARTIFACT_ROOT` (optional): private capture storage; defaults to `.artifacts/mcp` in the checkout.
- `PORT` (optional): HTTP port, default `3000`.

Generate a token and its stored digest without putting either in git:

```sh
TOKEN="$(openssl rand -hex 32)"
printf '%s' "$TOKEN" | sha256sum
```

After `pnpm --filter @nexus/mcp-server build`, run from the repository root:

```sh
NEXUS_MCP_TOKEN_SHA256='<sha256>' node packages/mcp-server/dist/mcp-server/src/server.js
```

The unauthenticated `GET /healthz` response contains only service health/version. Every MCP request requires `Authorization: Bearer <token>`. The server registers no prompts, sampling, model calls, mutation tools, merge, deploy, or production access.


## Block 2 evidence behavior

- `nexus_gates` runs only fixed pnpm script names, records one log per executed gate, and requires an exact clean source SHA.
- `nexus_passport` reads only `.artifacts/quality-passports/<target>.json` (or an explicitly supplied path inside that directory) and delegates integrity verification to `@nexus/quality/quality-passport`. It never creates a Passport.
- `nexus_capture` starts a selected workspace app locally and delegates screenshots to `@nexus/capture/playwright`. Captures are downloadable through the authenticated `/artifacts/:requestId/:name` endpoint.
- Arbitrary public URL capture intentionally returns `NOT_TESTED` in this block. The existing capture adapter validates the initial HTTP(S) URL but does not yet enforce the approved SSRF policy across redirects and subresources; the MCP layer will not claim that unsafe gap is tested.

## Block 3 evidence behavior

- `nexus_build` requires an exact clean SHA and invokes `scripts/build-target-manifest.mjs`, which delegates target discovery, cache restoration, deterministic environment setup, build execution, cache storage, and output snapshotting to the existing `scripts/build-core.mjs` pipeline. The MCP layer does not implement a second builder.
- A successful build returns every generated artifact path, byte length, SHA-256, the existing pipeline output digest/build key, lockfile hash, toolchain versions, and a hash of the manifest itself.
- `nexus_comparator` is registered but returns `NOT_TESTED` with `NEXUS_CAPABILITY_MISSING: VISUAL_REGRESSION_GEOMETRY`. Repository inspection confirmed that pixel diff, mutation overflow measurements, and design-genome geometry observations exist, but no geometric comparator contract/implementation or permanent negative fixture exists. No counts or violations are synthesized.

## Block 4 project creation

- `nexus_project_new` is visible only with the separate write token. It requires complete confirmed business data and structured art direction; MCP schema validation rejects omissions and reserved, malformed, or traversal-like slugs before any write.
- Creation requires an exact clean `baseSha`, creates only a `nexus-mcp/*` branch, and delegates file creation to the existing `scripts/scaffold-client.mjs`. It never overwrites an app, merges, pushes, deploys, or writes outside `apps/<slug>`.
- The scaffold stores the supplied facts verbatim in `.nexus/project-spec.json`, marks the package with the existing `nexus.clientProject: true` admission signal, and excludes generated dependency/build directories from the seed copy.
- Before committing, the tool runs the new package's existing `lint`, `typecheck`, and `build` scripts and verifies admission through the same workspace discovery used by `nexus_projects`. A missing command/dependency is `NOT_TESTED`; an executed failure is `FAIL`.
