# V10 Transfer / Handoff Package

## Objective

A buyer, licensee, managed-service operator, or successor engineering team must be able to determine exactly what NEXUS contains, what is proprietary, what belongs to a customer, how to operate the system, and how to leave the relationship without hidden lock-in.

## Product boundaries

The handoff package distinguishes five classes of assets:

1. **NEXUS Core private IP** — ontology/runtime architecture, reusable engines, internal libraries and proprietary implementation.
2. **SDK/API surface** — documented contracts intentionally exposed to integrators.
3. **Managed Runtime** — operated capability that may be licensed without transferring Core source.
4. **Customer Projects / Configuration** — tenant/brand/project-specific implementation and configuration.
5. **Customer Data** — customer-owned operational and content data, exportable independently of NEXUS Core IP.

No commercial handoff may silently collapse these boundaries.

## Required package contents

A transferable release includes or references:

- architecture overview and domain boundaries;
- ADR index and major design decisions;
- supported toolchain and dependency lockfiles;
- API/port contracts and compatibility policy;
- environment/configuration matrix with no embedded production secrets;
- deployment and rollback procedure;
- backup/restore and disaster-recovery procedure;
- clean-room bootstrap runbook;
- operator health/observability runbook;
- schema/versioning/migration procedure;
- tenant and scope-isolation rules;
- AI authorization and human-approval boundaries;
- SBOM generation path and dependency/security checks;
- release/CI gates;
- known limitations and unsupported paths;
- data export and customer offboarding procedure;
- ownership manifest distinguishing NEXUS IP from customer IP/data.

## Commercial handoff modes

### Licensed SDK/API usage

The customer receives supported SDK/API contracts and documentation but not automatically the NEXUS Core source. Customer data remains exportable and separable.

### Managed/runtime service

NEXUS operates the runtime. The customer receives service interfaces, operational commitments, export capability and an offboarding path. Managed service does not imply transfer of Core IP.

### Source-code/IP transfer

A full transfer explicitly identifies repositories, branches/tags, documentation, build assets, licenses, third-party notices, SBOM, trademarks/patents if any, customer exclusions and transition obligations. A buyer must be able to reproduce the accepted release from the package.

### Customer offboarding

Offboarding must provide the customer's exportable data/configuration in documented formats, revoke credentials/access, preserve required audit/retention records, and demonstrate that unrelated tenants and NEXUS Core IP were not included in the export.

## Acceptance exercises

### Clean-room acceptance

A qualified operator who did not build the subsystem completes the V10 Clean-Room Bootstrap Runbook without undocumented oral knowledge.

### Failure-isolation acceptance

Demonstrate that Creative, AI and Measurement failures do not independently destroy the Operational Domain. Core manual operations remain available when AI is unavailable.

### AI action acceptance

Demonstrate a permitted low-risk action, a denied action, and a HIGH/CRITICAL action requiring human approval. Direct AI mutation outside the Action boundary is prohibited.

### Backup/restore acceptance

Create and restore an isolated tenant-scoped snapshot and verify that cross-scope restore fails closed.

### Customer offboarding acceptance

Export one synthetic tenant without including another tenant's data or private Core implementation.

## Knowledge-transfer standard

A handoff is incomplete if successful operation depends on creator memory, private chat history, undocumented credentials, undocumented cloud-console state, or an unrecorded recovery command.

Any undocumented critical step is a release-blocking V10 defect.

## Final evidence

The transferability evidence packet records:

- release/commit identity;
- package inventory;
- operator identity/role;
- clean-room result;
- backup/restore result;
- rollback result;
- AI boundary acceptance;
- isolation/offboarding result;
- outstanding limitations;
- unresolved Critical/High audit findings (must be zero for V10 closure).
