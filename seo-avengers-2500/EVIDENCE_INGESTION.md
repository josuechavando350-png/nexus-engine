# SEO Avengers 2500 — Read-only Evidence Ingestion

This layer is intentionally out of band from every client request path. The reader does not crawl a website, call Google, write to a client project, enqueue work, run SEO modules, publish results, or mutate the tenant control plane.

Its job is to expose already-published, tenant-isolated evidence to the sidecar after validating tenant authorization, generation binding, canonical paths and byte integrity.

## Authorization comes first

Evidence is never read for an unauthorized tenant.

`readTenantEvidenceSnapshot()` first reads the tenant control plane. Missing, disabled, killed, malformed, stale or corrupt control state returns `OFF`. Only a tenant with an integrity-valid current generation and `enabled=true`, `kill_switch=false` may proceed to evidence ingestion.

After all evidence bytes are read and verified, the control plane is read again. If authorization changed or the generation moved while the snapshot was being read, the result is not released as `READY`.

The sidecar independently rechecks the captured generation immediately before execution, after execution, and immediately before releasing a result.

## Reader/writer separation

The runtime reader remains write-free. `tenant-evidence.mjs` imports the versioned reader, which imports only `lstat`, `readFile`, `readdir` and `realpath` from `node:fs/promises`.

The publication authority is isolated in `versioned-evidence-writer.mjs`. A collector may use that writer, but the SEO Avengers sidecar and client-serving processes must not receive evidence-root write permission.

## Preferred versioned layout

New collectors should publish immutable versioned snapshots:

```text
<evidence-root>/tenants/<site-id>/
  HEAD.json
  snapshots/
    <manifest-sha256-hex>/
      manifest.json
      content_documents.json
      ...
```

`HEAD.json` has exactly:

```json
{
  "schema_version": 2,
  "site_id": "tenant-id",
  "control_generation": 7,
  "snapshot_id": "<64 lowercase hex>",
  "manifest_sha256": "sha256:<same 64 lowercase hex>"
}
```

The snapshot ID is the canonical manifest SHA-256. The manifest itself retains schema version 1 and binds dataset filenames and raw-byte SHA-256 digests.

The writer encodes datasets deterministically, writes a pending immutable snapshot with create-exclusive files, fsyncs files and the snapshot directory, atomically renames the snapshot into `snapshots/<id>`, fsyncs the snapshots directory, then create-exclusively writes/fsyncs a pending HEAD and atomically renames it to `HEAD.json` before fsyncing the tenant directory.

A pending HEAD marker is fail-closed. Existing immutable snapshots are byte-verified before reuse. A stale/tampered snapshot cannot be silently adopted merely because its directory name matches the desired ID.

The versioned reader rejects symlink traversal, unexpected tenant-level files, malformed HEAD/manifest data, cross-tenant binding, generation mismatch, missing or extra snapshot files, dataset digest mismatch and HEAD/manifest mismatch. It rereads HEAD after the snapshot and rejects a head change during the read.

## Legacy v1 compatibility

When no versioned `HEAD.json`, `snapshots/` or pending-head marker exists, the reader can still consume the original flat layout:

```text
<evidence-root>/tenants/<site-id>/manifest.json
<evidence-root>/tenants/<site-id>/search_performance_records.json
<evidence-root>/tenants/<site-id>/content_documents.json
...
```

Legacy v1 remains read-only and fail-closed. New real-site collectors should use the versioned layout rather than rewriting these files in place.

## Manifest contract

`manifest.json` has exactly these fields:

```json
{
  "schema_version": 1,
  "site_id": "tenant-id",
  "control_generation": 7,
  "datasets": [
    {
      "key": "search_performance_records",
      "file": "search_performance_records.json",
      "sha256": "sha256:<64 lowercase hex>"
    }
  ]
}
```

`control_generation` must equal the currently authorized control-plane generation. This prevents evidence captured under an older enable/kill state from silently becoming current after a later control mutation.

Each descriptor is unique by dataset key. Its filename is fixed to `<dataset-key>.json`; arbitrary relative paths and nested paths are not accepted. Every declared dataset file must exist and every byte digest must match the manifest.

Dataset payloads are JSON arrays because the 2500 suite consumes record collections. The ingestion layer verifies the transport/integrity envelope; module-specific semantic validation remains in the deterministic runtime. Empty arrays are valid transport and allow downstream modules to produce `INSUFFICIENT_DATA` instead of invented observations.

## Allowed existing dataset contracts

The reader accepts only the evidence contracts already declared by the 2500 suite:

- `search_performance_records`
- `content_documents`
- `local_business_records`
- `content_decay_records`
- `revenue_funnel_records`
- `revenue_attribution_records`
- `keyword_coverage_records`
- `traffic_window_records`
- `traffic_series_records`
- `upstream_evidence`
- `search_intent_records`
- `canonicalization_records`
- `persistence_state_records`
- `edge_gateway_records`
- `cwv_edge_records`
- `policy_audit_records`
- `semantic_text_records`

Unknown dataset names fail closed. Missing provider/search/business/revenue data is not fabricated.

## Result states

- `OFF`: tenant control authority does not permit ingestion.
- `INSUFFICIENT_DATA`: authorized tenant has no published evidence snapshot yet. This is absence, not corruption.
- `BLOCKED`: evidence root, HEAD, manifest, tenant binding, control generation, file set, symlink policy, JSON transport or SHA-256 integrity is invalid/unreadable.
- `READY`: the snapshot is transport-valid, tenant-bound, generation-bound and digest-valid.

`READY` does not mean that every SEO module has enough evidence or that any ranking/indexation/business outcome is guaranteed.

## Trust boundary

SHA-256 proves that bytes match the trusted manifest/HEAD chain. It is not a signature against an attacker who can rewrite the entire evidence authority and recompute all hashes.

The operational boundary therefore requires:

- client/request-serving processes: no write access to `controlRoot` or `evidenceRoot`;
- sidecar worker: no write access to `controlRoot` and read-only access to published evidence;
- collector: evidence publication authority only, never control-plane authority;
- control-plane writer: control authority only, not a source of fabricated SEO evidence.

Cross-tenant directory reuse is forbidden.

## Current scope

The merged sidecar consumes this reader. The NexusBotStudio canary branch adds a narrowly scoped public collector that may write only its versioned `content_documents` snapshot. It still does not put SEO Avengers in the website request path, mutate a site/CMS, call Google/provider APIs, write Cloudflare KV, or activate CANO.
