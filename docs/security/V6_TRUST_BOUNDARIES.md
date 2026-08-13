# NEXUS V6 Trust Boundaries

1. **Node boundary** — a node may be compromised; node identity does not equal user authority.
2. **Cluster boundary** — cluster membership is explicit and epoch-versioned.
3. **Region boundary** — cross-region connectivity can fail independently.
4. **Federation boundary** — remote trust domains receive only explicit grants.
5. **Offline boundary** — disconnected edge state is untrusted until reconciled.
6. **Artifact boundary** — bytes are not trusted because transport was encrypted; release metadata/signature/provenance must verify.
7. **Scheduler boundary** — placement is not authorization.
8. **Mesh boundary** — secure transport is not permission to invoke an operation.
