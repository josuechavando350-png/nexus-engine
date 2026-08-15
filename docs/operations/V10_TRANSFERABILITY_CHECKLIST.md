# NEXUS V10 Transferability and Operator Handoff Checklist

## Purpose

A sale, license, rental, managed deployment or ownership transfer must not depend on undocumented knowledge from the original creator. This checklist defines the minimum handoff package another qualified team must receive and successfully exercise.

## Product boundaries

The handoff must identify and separate:

- private NEXUS Core IP;
- licensed/public SDK and API surface;
- runtime/deployment components;
- customer-specific projects, adapters and configuration;
- customer-owned data;
- secrets and credentials;
- third-party dependencies and their licenses.

No transfer package may accidentally include unrelated customer data, credentials or proprietary material outside the agreed scope.

## Required technical package

- architecture overview and package dependency map;
- ADR index for material design decisions;
- API/SDK contract reference;
- supported-version and deprecation policy;
- environment/configuration reference with secrets excluded;
- install/bootstrap guide from a clean machine;
- deployment and rollback runbook;
- backup, restore and disaster-recovery runbooks;
- schema migration and rollback procedure;
- observability guide covering logs, metrics, traces and health checks;
- incident-response and severity model;
- data export/import and tenant offboarding procedure;
- dependency inventory, SBOM and supply-chain scanning procedure;
- licensing and third-party attribution inventory;
- known limitations and open risk register;
- ownership/contact map for operational responsibilities.

## Clean-room acceptance exercise

A non-authoring qualified operator must be able to complete, using only the repository, documented configuration and approved credentials:

clone -> install -> configure -> build -> test -> deploy -> seed -> execute -> observe -> backup -> restore -> rollback

The exercise must record elapsed time, undocumented steps discovered, failed assumptions and remediation commits. Any undocumented critical step is a release-blocking V10 defect.

## Failure-isolation acceptance

The handoff exercise must demonstrate that:

- Creative/WebGL failure does not stop critical Operational flows;
- AI provider failure leaves authorized manual/deterministic paths available;
- Evidence failure never converts missing evidence into trusted success;
- critical backend failure follows documented degraded/recovery behavior;
- tenant data remains isolated during backup, restore, export and offboarding.

## AI action acceptance

Mutating AI requests must follow the controlled path:

AI proposal -> typed Action -> policy -> authorization -> preconditions -> execution -> event -> audit -> evidence

High-risk actions require configurable human approval, idempotency, scope/rate limits and compensating/rollback behavior where feasible. AI receives no implicit superuser authority.

## Commercial handoff modes

The documentation must support at least these commercial modes without changing core architecture:

1. licensed SDK/API usage where NEXUS Core remains private;
2. managed/runtime service where customers consume capabilities without receiving core source;
3. source-code/IP transfer where the agreed core package, documentation and rights are explicitly enumerated;
4. customer offboarding where customer-owned data is exported without transferring unrelated NEXUS IP or other tenants' data.

## Acceptance evidence

Transferability is not accepted by prose alone. V10 closure requires recorded evidence of the clean-room exercise, backup/restore, rollback, tenant-isolated export/offboarding and operator handoff. The final Codex V1->V10 audit must verify that no unresolved critical/high transferability, bus-factor, disaster-recovery, AI-safety, tenant-isolation, supply-chain or IP-separation findings remain.
