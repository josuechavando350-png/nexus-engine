# V10 Clean-Room Bootstrap Runbook

## Purpose

This runbook proves that a qualified operator who did not build NEXUS can bring the system from repository checkout to a recoverable running state without undocumented oral knowledge.

A successful exercise must produce evidence for every stage below. Any missing critical step is a release-blocking V10 defect.

## Preconditions

The operator receives only:

- repository access;
- documented toolchain requirements;
- approved environment configuration and secrets through the supported secret-management path;
- this runbook and referenced architecture/operations documentation.

The operator must not rely on private messages, undocumented shell history, creator memory, or hidden local files.

## Acceptance flow

The required clean-room sequence is:

`clone -> install -> build -> test -> deploy -> seed -> execute -> observe -> backup -> restore -> rollback`

### 1. Clone

Clone the repository into a clean machine or disposable VM/container. Record repository commit SHA and operating-system/runtime metadata.

### 2. Install

Install the documented Node/pnpm and Rust toolchains. Dependency installation must use lockfiles. Secrets must not be committed into the repository.

### 3. Build

Run the TypeScript and Rust release builds through repository scripts. A build that depends on undocumented local state fails the exercise.

### 4. Test

Run lint, typecheck, unit/integration tests, V3->V10 architecture gates, security hygiene, Rust tests/lint/release and diff hygiene where applicable.

### 5. Deploy

Deploy into the documented non-production clean-room environment using only supported configuration. Record deployment version, environment and health result.

### 6. Seed

Load a synthetic tenant-scoped dataset. Real customer data is forbidden in the clean-room acceptance exercise.

### 7. Execute

Execute one permitted low-risk ontology Action end-to-end through authorization, transaction execution, event/audit generation and query verification.

Execute one denied action and verify that it produces no unauthorized mutation.

### 8. Observe

Confirm health status, operational signals, logs/metrics where configured, audit records, event sequence and scope isolation.

### 9. Backup

Create a tenant-scoped backup/snapshot using the supported backup path. Record backup identity, scope, timestamp and source version.

### 10. Restore

Restore the backup into an isolated recovery target. Verify object/relationship counts, critical identifiers and scope. Cross-scope restore must fail closed.

### 11. Rollback

Rollback the deployed version using the documented rollback path and verify service health and data integrity afterwards.

## Evidence packet

The exercise records at minimum:

- clean machine/environment descriptor;
- repository SHA;
- toolchain versions;
- command transcript or CI evidence;
- build/test results;
- deployment identity;
- health result;
- authorized and denied Action evidence;
- audit/event evidence;
- backup metadata;
- restore verification;
- rollback result;
- operator name/role and completion timestamp;
- every deviation from the runbook.

## Failure criteria

The clean-room exercise fails if any of the following is true:

- a critical step requires undocumented oral knowledge;
- the operator must contact the original creator for a hidden command or secret location;
- customer data is required to demonstrate operability;
- backup or restore cannot be completed from documented procedures;
- rollback cannot return the system to a healthy supported state;
- scope isolation is violated;
- an AI provider is required for core manual operations;
- evidence for a required stage is missing.

## Bus-factor acceptance

V10 does not pass transferability until at least one qualified operator who did not implement the relevant subsystem can complete this runbook from documentation alone and the evidence packet is retained.
