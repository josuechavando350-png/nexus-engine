# ADR 0004 — Separate Experience Engine package

## Decision

Create `packages/experience` as a pure TypeScript orchestration layer independent from both Core and app implementations.

## Why

Putting Experience DNA, Recipes or compiler logic in Core would turn stable engineering infrastructure into art-direction machinery. Putting it only in apps would make it non-reusable and untestable as shared IP.

## Consequence

Apps may consume `@nexus/core` and `@nexus/experience`; neither package depends on the other.
