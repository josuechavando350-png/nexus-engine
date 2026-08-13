# ADR 0001 — Physical package boundaries

Status: Accepted

NEXUS uses a monorepo with physically separate `packages/core`, `packages/experimental`, and `apps/*`.

The purpose is to make dependency direction enforceable by tooling rather than relying on documentation alone.
