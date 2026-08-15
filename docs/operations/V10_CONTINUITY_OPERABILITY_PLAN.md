# NEXUS V10 Continuity and Operability Plan

## Objective

NEXUS must remain operable if the original architect is unavailable. A competent senior engineering team must be able to understand, deploy, diagnose, update, back up, restore and roll back the system using repository documentation and approved credentials alone.

## Business-continuity invariants

- NEXUS may support critical business operations, but no creative, AI or visualization failure may stop core operational flows.
- AI outages must degrade to manual or deterministic non-AI paths for critical operations.
- Creative-domain failures must not take down orders, inventory, customers or other operational records.
- Every critical backend must have a replaceable port, export path and documented recovery procedure.
- Customer data must be tenant-isolated, exportable and recoverable independently of NEXUS IP.
- Secrets never live in source control.
- High-risk state mutations require explicit authorization, audit identity and idempotency controls.

## Bus-factor requirement

V10 is not complete until a clean-room operator who did not implement the target module can follow documentation to:

1. clone the repository;
2. install pinned dependencies;
3. configure approved secrets and environment variables;
4. build and run tests;
5. deploy a reference environment;
6. seed representative data;
7. execute a reference operational + creative flow;
8. inspect logs, metrics and health state;
9. create a backup;
10. restore the backup into a clean environment;
11. perform a rollback to the previous known-good version.

The exercise must record failures, missing knowledge and time-to-recovery.

## Required operational artifacts

- architecture map and package ownership map;
- ADRs for material technical decisions;
- installation and bootstrap guide;
- deployment and rollback runbook;
- backup and restore runbook;
- disaster-recovery plan with RPO/RTO targets per service class;
- incident-response runbook and severity model;
- health-check, logging, metrics and tracing conventions;
- schema migration and rollback procedure;
- dependency inventory and SBOM generation path;
- vulnerability and supply-chain scanning policy;
- secrets-management policy;
- data export/import procedure;
- tenant offboarding procedure;
- API/SDK compatibility and deprecation policy;
- ownership transfer and knowledge-transfer checklist.

## Failure isolation

Operational, Creative, AI and Measurement/Evidence domains share the Ontology Kernel but must be isolated at runtime boundaries. Failure propagation is denied by default.

Examples:

- WebGL failure -> operational domain remains available.
- Creative library failure -> operational transactions remain available.
- AI provider failure -> authorized manual actions remain available.
- Evidence pipeline failure -> mutations do not become implicitly trusted; evidence is marked unavailable/failed.
- Query backend outage -> recovery/degraded-mode behavior follows the relevant adapter runbook.

## AI action safety

AI is never a superuser. Mutating requests follow:

AI proposal -> typed Action -> policy evaluation -> authorization -> precondition validation -> execution adapter -> emitted event -> audit log -> evidence.

High-risk actions must support human approval where configured, idempotency keys, scope limits, rate limits and compensating/rollback behavior when feasible.

## IP and customer separation

The product boundary should support:

- private NEXUS Core IP;
- public or licensed SDK/API surface;
- deployment/runtime services that need not expose core source;
- customer-specific configuration/integrations kept separate from reusable core;
- customer-owned data stored and exported independently from NEXUS proprietary code.

A sale or license must not require handing over unrelated customer data or secrets.

## Transferability acceptance

A transfer package is acceptable only when another qualified team can operate the engine without undocumented oral knowledge from the original architect. Any undocumented critical step is a V10 defect.

## Final audit extension

The V1->V10 Codex audit must include:

- production readiness;
- bus-factor/key-person dependency;
- disaster recovery;
- backup/restore validation;
- runtime failure isolation;
- tenant isolation;
- authorization and AI action safety;
- dependency and software-supply-chain risk;
- data portability;
- IP/customer-data separation;
- clean-room bootstrap and rollback evidence.
