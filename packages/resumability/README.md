# @nexus/resumability

Serialized JSON state + symbol manifest + delegated events + exact lazy import for explicitly extracted handlers. The runtime resumes from bound state/manifest payloads and does **not** replay whole-tree hydration.

This is a NEXUS resumability runtime inspired by the architectural goal of resumability; it is not a clone of the Qwik optimizer. V1 requires handlers and captured state IDs to be explicitly declared at build time.

## Trust boundary

Both state and manifest are replay-validated before rendering or attaching listeners. A manifest digest is a deterministic integrity checksum over declared metadata, not proof that downloaded module bytes match `buildDigest`. `buildDigest` remains a caller-supplied release identity; module-byte authenticity still belongs to the deployment/supply-chain layer.

The manifest carries `NEXUS_RESUMABILITY_EXPLICIT_HANDLER_RUNTIME_NOT_QWIK_OPTIMIZER_OR_MODULE_INTEGRITY_PROOF` to prevent the internal runtime from being represented as an optimizer clone or cryptographic module-integrity system.

## Runtime guarantees

- JSON-only state with bounded depth, node count, value count and payload bytes;
- canonical state/manifest digests and deterministic replay validation;
- strict IDs, symbol exports, event names, duplicate detection and binding-to-symbol checks;
- root-relative `.js`/`.mjs` module declarations and same-origin resolution before import;
- captured state IDs must exist before payload rendering/resumption;
- `submit` interception requires `preventDefault=true`, which is applied before any lazy import;
- handlers load only when their delegated event occurs; no handler import happens during `resumeDocument()`;
- state access is capability-scoped to the IDs captured by the active binding;
- lazy import failures are removed from cache so later events may retry, and errors are contained through `onError`;
- `dispose()` removes delegated listeners and clears the import cache.

Operational audit consumer: `node scripts/audit-resumability.mjs --spec <resume.json>`. It validates state + manifest, verifies their cross-binding and emits the safe serialized payload.
