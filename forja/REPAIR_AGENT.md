# AXIOMA FORJA — bounded GAUSS repair candidate (experimental)

**Native mode needs no model, inference server, cloud API, credentials, subscription or third-party service.** If `engine` and `model` are omitted, the agent defaults to `engine: "native"`; the available native family and its strict source-shape limits are documented in [NATIVE_REPAIR.md](NATIVE_REPAIR.md). The earlier local-model adapter remains optional for separate evaluation, not a prerequisite. Neither mode is a general autonomous programmer or a certified GAUSS engine.

## Preconditions and no-model operation

Node 24, Git, a clean trusted checkout, a pre-existing failing regression test and separately passing independent guard tests. Run only on an unprivileged disposable isolated Linux environment with no secrets or production access. Detached Git worktrees are **not security sandboxes**: repository tests can run arbitrary host code and access the network regardless of whether a model is present. No deployments or writes to `main` occur.

Native task **shape** (replace these illustrative paths with genuinely tracked GAUSS files and tests; these are not claimed to exist in production):

```json
{
  "engine": "native",
  "objective": "Repair a bounded arithmetic regression without breaking independent behavior",
  "files": ["gauss/calc.mjs"],
  "tests": ["gauss/tests/calc.test.mjs"],
  "verificationTests": ["gauss/tests/guard.test.mjs"],
  "native": { "kind": "pure-binary-arithmetic", "exportName": "add" },
  "maxAttempts": 3
}
```

From the repository root: `node forja/verified-repair.mjs --task=/absolute/path/to/task.json`.

The native engine enumerates only three alternative operators for one uniquely identified pure two-operand exported arrow. Each candidate starts from the original committed bytes in a detached worktree, must reproduce the same named assertions and pass the targeted test, then must preserve separately passing verification tests before it is considered for manual review. It rejects dirty checkouts, symlinks/hardlinks, untracked or out-of-scope files, test edits, early-exit/omitted assertions and attempts beyond the fixed budget. A passing result contains the source Git SHA, workspace, exact diff and SHA-256. No staging, PR, merge or deployment occurs. A candidate that passes selected tests is **not** proof of comprehensive GAUSS correctness.

The earlier explicit `engine: "local-model"` mode can still run an operator-supplied executable or `forja/local-model.mjs` for separate experiments. It is not part of the no-model path, is not bundled with any weights/server, and must never be described as autonomous native reasoning. Model executables have arbitrary host-code privileges unless isolated independently.

To discard a reviewed worktree, run `git worktree remove --force <reported-workspace>` from the source repository and delete its empty temporary parent.

## Remaining engineering

This increment does not invent algorithms, write new test specifications, complete 100 GAUSS or LEIBNIZ capabilities, audit the whole monorepo, prove arbitrary precision, guarantee convergence or prove an OS sandbox. Before unattended operation, implement genuine process/filesystem/network isolation, resource controls, independent mathematical oracles, a wider set of *implemented and tested* native transformation families, full post-change gates and operator-approved PR generation. No production client, including CANO, is in scope.
