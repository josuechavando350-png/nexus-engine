# `@nexus/mcp-server`

Remote, deterministic MCP control surface for NEXUS. It exposes the approved tools over Streamable HTTP at `POST /mcp` and supports two explicit authentication modes:

1. OAuth 2.1 protected-resource authentication for ChatGPT/Codex MCP clients.
2. Pre-shared Bearer token hashes for controlled internal/API clients that can supply a token directly.

Neither mode disables the repository's tool allowlist, source-SHA binding, isolated worktrees, operator scope checks, or write authorization.

## ChatGPT / OAuth mode

ChatGPT-authenticated deployment uses the MCP authorization contract rather than a custom API key. Configure:

- `NEXUS_MCP_OAUTH_RESOURCE` (required for OAuth): canonical public HTTPS origin of this MCP resource server.
- `NEXUS_MCP_OAUTH_AUTHORIZATION_SERVERS` (required for OAuth): comma-separated exact OAuth issuer identifiers. Nexus does not normalize issuer identifiers because OAuth clients compare them exactly.
- `NEXUS_MCP_OAUTH_INTROSPECTION_ENDPOINT` (required for OAuth): HTTPS RFC 7662 token introspection endpoint for the trusted authorization server.
- `NEXUS_MCP_OAUTH_INTROSPECTION_CLIENT_ID` and `NEXUS_MCP_OAUTH_INTROSPECTION_CLIENT_SECRET` (required for OAuth): resource-server credentials used only when Nexus introspects an incoming access token.
- `NEXUS_MCP_OAUTH_READ_SCOPE` (optional, default `nexus:read`).
- `NEXUS_MCP_OAUTH_WRITE_SCOPE` (optional, default `nexus:write`). It must differ from the read scope.
- `NEXUS_MCP_OAUTH_RESOURCE_DOCUMENTATION` (optional): public HTTPS documentation URL advertised in protected-resource metadata.

When OAuth mode is configured, Nexus exposes unauthenticated `GET /.well-known/oauth-protected-resource`. Unauthorized MCP requests include a `WWW-Authenticate` challenge pointing at that metadata document. The configured authorization server remains responsible for its OAuth discovery document, authorization-code flow, PKCE `S256`, client identification/registration (CIMD, DCR, or a predefined client), user authentication and consent.

Nexus introspects every presented OAuth access token and fails closed unless all of the following are true:

- introspection succeeds and returns `active: true`;
- the token audience contains the exact `NEXUS_MCP_OAUTH_RESOURCE` value;
- the token is not expired when an `exp` value is present;
- the token contains the configured read scope;
- write capability is granted only when the configured write scope is also present.

The OAuth client secret is never sent to ChatGPT. It is a server-to-server credential between Nexus and the configured authorization server.

If `nexus_operator` is enabled, also configure the server-owned scope:

- `NEXUS_OPERATOR_TENANT_ID`
- `NEXUS_OPERATOR_ORGANIZATION_ID`
- `NEXUS_OPERATOR_BRAND_ID`

The repository is fixed to `NEXUS_GITHUB_REPOSITORY` (default `josuechavando350-png/nexus-engine`) and is included in the operator scope. OAuth authentication does not let an MCP client supply or widen that server-owned scope.

## Shared-token mode

- `NEXUS_MCP_TOKEN_SHA256` (optional when OAuth is configured): lowercase SHA-256 of the read Bearer token. The raw token is not stored by the server.
- `NEXUS_MCP_WRITE_TOKEN_SHA256` (optional): SHA-256 of a separate write-capable Bearer token. The read and write hashes must differ.

Generate a fresh random token and its stored SHA-256 locally, without putting either in git or a chat:

```sh
pnpm --filter @nexus/mcp-server token:generate
```

## Common configuration

- `NEXUS_REPOSITORY_ROOT` (optional): checkout root; defaults to the process working directory.
- `NEXUS_GITHUB_REPOSITORY` (optional): `owner/repository`; defaults to `josuechavando350-png/nexus-engine`.
- `NEXUS_GITHUB_TOKEN` (optional): read-only GitHub token used for PR/check state. Without it, `nexus_status` returns `NOT_TESTED` for the GitHub portion rather than claiming there are no PRs.
- `NEXUS_MCP_ALLOWED_HOSTS` (optional locally, required for deliberate deployment policy): comma-separated HTTP Host allowlist. In OAuth mode, the OAuth resource hostname must be included. When omitted in OAuth mode, Nexus uses the resource hostname; otherwise the local default is `localhost,127.0.0.1`.
- `NEXUS_MCP_ARTIFACT_ROOT` (optional): private capture storage; defaults to `.artifacts/mcp` in the checkout.
- `NEXUS_MCP_ENABLED_TOOLS` (optional): comma-separated capability allowlist. It defaults to `nexus_status,nexus_projects`; no execution or mutation tool is remotely exposed by default.
- `NEXUS_MCP_MAX_CONCURRENCY` (optional, default `2`, range `1..16`): maximum simultaneous MCP tool calls. Excess work fails with HTTP 429 and is never queued silently.
- `NEXUS_MCP_EXECUTION_TIMEOUT_MS` (optional, range `1000..900000`): explicit execution-timeout override used by gates, builds and project validation commands.
- `NEXUS_MCP_MAX_ARTIFACT_BYTES` (optional, default `26214400`, range `1024..104857600`).
- `NEXUS_MCP_MAX_PROCESS_OUTPUT_BYTES` (optional, default `8388608`, range `1024..16777216`).
- `NEXUS_MCP_CHILD_ENV_ALLOW` (optional): comma-separated names selected from the reviewed extension allowlist exported by `child-env.ts`. Arbitrary names and secret-like names are rejected.
- `PORT` (optional): HTTP port, default `3000`.

Every MCP child process receives a private temporary `HOME`, private XDG config/cache directories, an empty npm user-config path, and `GIT_TERMINAL_PROMPT=0`; the server's real `HOME` and user credential/config files are not inherited.

After `pnpm --filter @nexus/mcp-server build`, run the built server from the repository root with either a configured OAuth environment or the shared-token environment:

```sh
node packages/mcp-server/dist/mcp-server/src/server.js
```

The unauthenticated `GET /healthz` response contains only service health/version. OAuth protected-resource metadata contains only the configured public resource/issuer/scope contract. All repository data, artifacts and MCP operations require authentication.

The server registers no prompts, sampling, model calls, merge, deploy, push, force-push, branch deletion, or production access. `nexus_project_new` is the explicit repository mutation tool and requires write authorization. The governed `nexus_operator` can dispatch only its typed allowlisted actions and cannot turn free-form text into shell/GitHub/deployment commands.

This package contains the MCP service and authentication boundary; it does not claim that a public HTTPS deployment or a ChatGPT app registration exists. Those are deployment/account operations outside the repository and must be verified against the running service rather than inferred from this source tree.

## Remote readiness

- The initial exposure policy registers only `nexus_status` and `nexus_projects`. Existing execution tools remain implemented but require an explicit `NEXUS_MCP_ENABLED_TOOLS` allowlist entry.
- Every enabled tool call is concurrency-limited. Gates, builds, captures and project creation execute in a detached ephemeral Git worktree at the request's source SHA. Dependencies are linked into that worktree by a frozen offline pnpm install, existing derived outputs are copied rather than shared, and the worktree is forcibly removed and pruned after the response.
- Gates, builds and captures publish request-scoped artifact records through `ArtifactStore`. The default `LocalArtifactStore` writes `.artifacts/mcp/<requestId>/manifest.json`; every record contains media type, byte length, SHA-256, metadata and an authenticated download URL.
- Local storage is an explicit first adapter, not a cloud fallback. A remote deployment may provide another `ArtifactStore` without changing tool contracts.
- `packages/mcp-server/Dockerfile` is a reproducible Node 24 / pnpm 10.15.0 execution definition. It is not itself deployment or hosting configuration.

## Evidence behavior

- `nexus_gates` runs fixed pnpm scripts for non-build checks; its target `build` gate shares the single-build, SHA-bound manifest path used by `nexus_build`.
- `nexus_passport` reads only the configured Quality Passport source of truth and delegates integrity verification to `@nexus/quality/quality-passport`. It never fabricates a Passport.
- `nexus_capture` starts a selected workspace app locally and delegates screenshots to `@nexus/capture/playwright`. Captures are downloadable through the authenticated `/artifacts/:requestId/:name` endpoint.
- `nexus_build` requires an exact clean SHA and delegates target discovery, cache restoration, deterministic environment setup, build execution, cache storage, and output snapshotting to the existing build pipeline.
- `nexus_project_new` requires complete confirmed business data and structured art direction, creates only a `nexus-mcp/*` branch, and delegates project compilation to the existing scaffold/compiler path. It never merges, pushes, deploys, or writes outside the confined project/lockfile surface.
