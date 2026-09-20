# AXIOMA FORJA — executable audit foundation

FORJA is a proposed, self-hostable engineering control plane for NEXUS. **This directory currently implements a tracked-file inventory and an explicit source-connection audit only.** It is not an autonomous agent, deployment platform, complete engine inventory, vulnerability scanner, formal verifier, or production monitoring system.

## Run the implemented components

From the repository root with Node 24 and Git:

```sh
node --test forja/tests/*.test.mjs
node forja/inventory.mjs
node forja/audit.mjs
```

The inventory uses `git ls-files` to enumerate tracked files and source extensions in the exact repository revision. It reports total tracked sources, how many are named in the explicit registry and **how many remain NOT_AUDITED**; untracked paths are outside its scope. A clean working tree is required for `RECORDED` (exit 0); a dirty tree returns `DIRTY_WORKTREE` (exit 1); invalid repository/index/manifest is an error (exit 2). A tracked source file is not necessarily a motor. The source inventory does **not** establish runtime connectivity or certify unregistered code.

The connection auditor exits 0 for PASS, 1 for a recorded finding, 2 for malformed input or execution error. It emits JSON including SHA-256 digests, checked-node and link counts, findings, and **explicit limitations**. Neither component edits the repository nor performs network calls. The workflow `.github/workflows/forja-audit.yml` runs the tests, inventory and source audit on every PR, main push, nightly schedule, and manual dispatch, recording both artifacts tied to the checked-out commit. The workflow does **not** modify branches, merge, deploy or self-repair.

`registry.json` declares five observed nodes and four direct references in the WALLE adapter → Nexus GAUSS CLI → GAUSS core / Quantum contributor → Quantum simulator chain. It is an **explicit subset** of the repository, not a claim that every current or future NEXUS engine is registered. A passing source-audit result proves only that registered files exist and that their declared single-line static ESM import or direct shell `node` invocation text is present. It does not prove calls execute, interfaces agree, a user journey works, or that security and performance pass. Dynamic imports, runtime service edges, TypeScript path aliases, Rust crates, multi-line imports, network and database connections are **not** audited by this implementation. Adding a node to the registry without a verified incoming edge causes FAIL.

The auditor enforces bounded regular files, real-path containment, unique node identities, declared endpoint validity and root reachability; adversarial tests exercise missing files/links, disconnected nodes, comments and dynamic imports, traversal, symlinks, oversize and malformed manifests. Inventory tests cover unregistered sources, dirty and untracked changes, missing registry entries and tracked symlinks. Neither tool claims to find all defects or guarantee zero vulnerabilities.

## Next independently verifiable increments

1. Extend the tracked-file inventory with syntax-aware graph extraction for ESM/TS imports, package exports, Rust crate dependencies and runtime contracts. Track every unregistered component as `NOT_AUDITED`, not PASS; detect intentionally unconnected components before requiring all to link to one runtime root.
2. Require machine-readable input/output contracts and prove real consumer execution for declared capabilities. Test missing implementations and incompatible payloads in an isolated probe.
3. Add an independent quality-policy evaluator for build, tests, security, perf, coverage changes and reviewer authorization. Protect `main` through actual repository rulesets; merely writing YAML does not enable branch protection.
4. Deploy an **authorized, persistent self-hosted** runner and observability stack, with least-privilege identities, secret management, explicit budget/time limits and recorded provenance. No infrastructure or GPUs are assumed to exist today.
5. Add hermetic incident reproduction and bounded chaos on dedicated non-production resources; then propose repair PRs. Keep validation/rollback control outside the repair agent and require approval for critical changes and production data migrations.
6. Pilot GitOps, progressive delivery and automated rollback on one explicitly approved service **after** there is a real Kubernetes environment and operational recovery plan. Shadow traffic must be scrubbed and isolated; do not replay private user payloads without authorization.

Self-hosted, locally running open-source components may reduce dependence on commercial **services**, but third-party code remains a supply-chain dependency requiring review, pinned versions, licenses and vulnerability response. `GAUSS` in this repository is a mathematical runtime; do not misrepresent it as an existing LLM that writes patches. Formal methods prove specified properties of their precise model and assumptions, not every possible state of a real distributed system. eBPF is observability, not a mechanism to inject arbitrary safe production business logic, and has measurable overhead. Uncontrolled infrastructure mutation and automatic production self-approval are deliberately excluded.

**No correctness score, zero-downtime guarantee, 12× speed claim, total coverage, or external certification is claimed.** Measure real work, repeat failures and only promote demonstrated capabilities.
