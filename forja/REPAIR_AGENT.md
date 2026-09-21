# AXIOMA FORJA — bounded GAUSS repair candidate (experimental)

This is the first **working, test-driven repair loop**, not a general autonomous programmer or a certified GAUSS engine. It runs a **user-supplied local model executable** with a JSON stdin/stdout protocol, or the included loopback-only OpenAI-compatible inference adapter. No weights or model server are bundled. The model is not claimed to be accurate; deterministic fixture-model tests validate the repair plumbing, and a mock HTTP server validates transport, **not real model quality**.

## Preconditions

Node 24, Git and a clean, trusted checkout. An operator must supply a real **locally running** inference model and a *pre-existing failing regression test*. Run only on an unprivileged, disposable Linux environment with no secrets or access to production resources. Detached Git worktrees are **not security sandboxes**: model executables and repository tests can run arbitrary code or access the host/network. The adapter only initiates HTTP to `127.0.0.1`, but the locally installed model server is outside FORJA's control. Do not use this on a sensitive machine. No deployments or Git writes to `main` occur.

Sample task JSON (replace file/test paths and the local model name with verified real ones; this is an **example**, not a claim those paths exist in GAUSS):

```json
{
  "objective": "Fix a failing arithmetic regression without changing its contract",
  "files": ["gauss/calc.mjs"],
  "tests": ["gauss/tests/calc.test.mjs"],
  "maxAttempts": 2,
  "model": {
    "executable": "/absolute/path/to/node",
    "args": ["forja/local-model.mjs", "--url=http://127.0.0.1:8080/v1/chat/completions", "--model=your-installed-local-model"]
  }
}
```

From the repo root: `node forja/repair-agent.mjs --task=/absolute/path/to/task.json`.

The agent rejects a dirty source checkout, nontracked paths, symlinks, hard-linked files, paths outside `gauss/`, edits to `gauss/tests/`, missing/baseline-passing tests and unsafe model output. It makes a detached temporary Git worktree, runs the selected regression tests before each repair, sends their diagnostics and the **at-most-eight explicitly allowed source files** to the local model, writes only approved full-file replacements and reruns the tests. At most three iterations are permitted. The model receives no arbitrary shell tool, PR permission or deployment capability. A passing run returns `CANDIDATE_TESTS_PASS`, exact source Git SHA, workspace, and the diff and its SHA-256; failures remain unmerged. Inspect the diff and independently run GAUSS/monorepo tests before any PR. A passing *selected test* is not whole-GAUSS certification or mathematical accuracy proof.

The temporary candidate is retained for review. To discard after review, use `git worktree remove --force /path/reported/in/workspace` from the original repository and remove the now-empty temporary parent. No automatic staging, commits, GitHub access, merge or deployment.

## Scope and remaining engineering

This first increment does not schedule 100 GAUSS implementations, write new test specifications, audit all GAUSS modules, run full monorepo gates, prove isolated execution, guarantee convergence, prove mathematical correctness or replace operator-controlled approval. Its selected tests may execute arbitrary code. Before unattended operation, add actual process/filesystem/network isolation, model installation and evaluation with real GAUSS tasks, broader post-change gates, resource controls, audit logs and human-approved PR generation.
