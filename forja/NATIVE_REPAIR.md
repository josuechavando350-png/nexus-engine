# AXIOMA FORJA — native bounded repair (first executable family)

**No LLM, model weights, model server, API, API key, paid service or inference dependency is required for this mode.** The native engine is deterministic code in `forja/native-transform.mjs`, executed inside the existing FORJA repair runner; it is *not* a general autonomous programmer. The earlier local-model path remains an optional, independent legacy mode, not a prerequisite.

## What this first family can do

On one explicitly declared, tracked `gauss/` source file, select exactly one *pure, one-line* `export const functionName = (a, b) => a OP b;` where `OP` is one of `+`, `-`, `*`, `/`. The engine rejects missing, duplicated, ambiguous, impure or reversed-argument targets; it never edits tests, CANO, or another source function. It enumerates only the three alternative arithmetic operators in fixed order, starting each attempt from the unchanged committed source, without generating arbitrary code or running a model. It reproduces an existing failing test, compares executed test identities before/after each attempted edit, and returns a diff and SHA-256 only when the selected regression passes. If no candidate works, it returns `REPAIR_UNRESOLVED` rather than inventing an implementation.

Use `forja/verified-repair.mjs` for the independent pre-existing passing regression guard; otherwise a targeted test alone might overfit. The guard must pass on the original revision, execute the same named assertions on the candidate, and preserve source/test digests and a clean original Git checkout. A broken independent guard yields `CANDIDATE_REJECTED_REGRESSION`. **Even a guard-pass candidate is not a proof of general mathematical correctness**; independent mathematical oracles, metamorphic/property tests and full project gates remain mandatory before any merge.

## Minimal task format

The following names illustrate a *shape* and do not assert that a matching `gauss/calc.mjs` exists in the production GAUSS repository. Replace them with a verified, existing operator and regression tests. A failing test and a separately passing guard must already exist and be committed.

```json
{
  "engine": "native",
  "objective": "Repair a wrong arithmetic operator without changing independent behavior",
  "files": ["gauss/calc.mjs"],
  "tests": ["gauss/tests/calc.test.mjs"],
  "verificationTests": ["gauss/tests/guard.test.mjs"],
  "native": { "kind": "pure-binary-arithmetic", "exportName": "add" },
  "maxAttempts": 3
}
```

Run from a clean Git root with Node 24 and Git:

```bash
node forja/verified-repair.mjs --task=/absolute/path/to/native-task.json
```

Omitting `engine` and `model` also selects the native engine. The runner never stages, commits, opens a PR, merges or deploys; candidate changes remain in a detached temporary worktree with the original SHA and diff digest. Delete a reviewed candidate worktree using `git worktree remove --force <reported-workspace>` from the source repository.

**Security:** A Git worktree is not an OS sandbox. Even with no model, repository tests execute arbitrary JavaScript on the host; run only on an unprivileged disposable isolated Linux environment without secrets, client data or production access. This first mode does not provide process/network isolation, arbitrary algorithm synthesis, broad AST transformations, a finished GAUSS-100 audit, or any LEIBNIZ implementation. Supporting LEIBNIZ later requires its actual specifications, tests, explicit path scope and independently verified operators; do not claim that 100 capabilities are completed by adding 100 names.
