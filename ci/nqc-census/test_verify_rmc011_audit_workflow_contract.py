#!/usr/bin/env python3
"""Offline workflow regressions; synthetic fixtures are never Census authority.

Run from any directory with Python 3, Bash, jq, and the normal runner utilities.
No YAML dependency or network is needed. The deliberately narrow extractor
rejects changed step layouts instead of silently testing an empty script.
NQC_AUDIT_WORKFLOW_ROOT can target immutable baseline bytes for red/green proof.
"""

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(os.environ.get("NQC_AUDIT_WORKFLOW_ROOT", Path(__file__).resolve().parents[2]))
WORKFLOWS = ROOT / ".github/workflows"
TERMINAL = "nqc-census-capital-terminal-readiness.yml"
DISCOVERY = "nqc-census-capital-family-discovery-evidence.yml"
TEST_PATH = "ci/nqc-census/test_verify_rmc011_audit_workflow_contract.py"
EXACT_HEAD_EXPRESSION = "${{ github.event.pull_request.head.sha || github.sha }}"
REPOSITORY = "fixture-owner/fixture-repository"
PR_HEAD = "1" * 40
MERGE_HEAD = "2" * 40
DISPATCH_HEAD = "3" * 40


def step_blocks(filename):
    source = (WORKFLOWS / filename).read_text()
    matches = list(re.finditer(r"^      - name: (.+)$", source, re.MULTILINE))
    if not matches:
        raise AssertionError(f"No named workflow steps in {filename}")
    blocks = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(source)
        name = match.group(1)
        if name in blocks:
            raise AssertionError(f"Duplicate step {name}")
        blocks[name] = source[match.start():end]
    return blocks


def step_script(filename, name):
    block = step_blocks(filename)[name]
    match = re.search(r"^        run: (.*)$", block, re.MULTILINE)
    if not match:
        raise AssertionError(f"No run script in {name}")
    if match.group(1) != "|":
        return match.group(1) + "\n"
    lines = block[match.end() + 1:].splitlines()
    if any(line and not line.startswith("          ") for line in lines):
        raise AssertionError(f"Unexpected run block layout in {name}")
    return "\n".join(line[10:] if line else "" for line in lines) + "\n"


def field(block, name):
    matches = re.findall(r"^          " + re.escape(name) + r": (.+)$", block, re.MULTILINE)
    if len(matches) != 1:
        raise AssertionError(f"Expected one {name}: field")
    return matches[0]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class AuditWorkflowContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for executable in ("bash", "jq", "python3", "sha256sum", "awk", "find", "sort", "xargs"):
            if shutil.which(executable) is None:
                raise RuntimeError(f"Required test executable missing: {executable}")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="rmc011-audit-workflow-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.ci = self.root / "ci/nqc-census"
        self.ci.mkdir(parents=True)
        self.runner = self.root / "runner"
        self.runner.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        # Replace gh with a strict local fixture transport. No real auth or API.
        gh = self.bin / "gh"
        gh.write_text("""#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
args = sys.argv[1:]
with (root / 'gh-calls.jsonl').open('a') as stream:
    stream.write(json.dumps(args) + '\\n')
if len(args) == 2 and args[0] == 'api':
    base = 'repos/' + os.environ['REPOSITORY'] + '/actions/'
    if args[1] == base + 'runs/101':
        print((root / 'run.json').read_text()); sys.exit(0)
    if args[1] == base + 'artifacts/202':
        print((root / 'artifact.json').read_text()); sys.exit(0)
if (len(args) == 9 and args[:3] == ['run', 'download', '101']
    and args[3:5] == ['--repo', os.environ['REPOSITORY']]
    and args[5:7] == ['--name', 'fixture artifact with spaces']
    and args[7] == '--dir'):
    shutil.copytree(root / 'payload', args[8], dirs_exist_ok=True); sys.exit(0)
print('Unrecognized fixture transport request: ' + repr(args), file=sys.stderr)
sys.exit(91)
""")
        gh.chmod(0o755)
        self.env = {key: value for key, value in os.environ.items()
                    if key not in {"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"}}
        self.env.update(PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        FIXTURE_ROOT=str(self.root), RUNNER_TEMP=str(self.runner),
                        REPOSITORY=REPOSITORY, EXACT_HEAD=PR_HEAD,
                        GITHUB_SHA=MERGE_HEAD, GITHUB_RUN_ID="303", GITHUB_RUN_ATTEMPT="2",
                        GITHUB_WORKFLOW="NQC RMC-011 Family Discovery Evidence")
        self.doc = json.loads((ROOT / "ci/nqc-census/rmc011-capital-source-universe.json").read_text())

    def run_step(self, filename, name):
        script = step_script(filename, name)
        # Only relocate the workflow's fixed scratch TSV to isolate concurrent tests.
        script = script.replace("/tmp/rmc011-terminal-evidence.tsv", str(self.runner / "terminal.tsv"))
        return subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                              cwd=self.root, env=self.env, capture_output=True, text=True)

    def write_doc(self, doc):
        (self.ci / "rmc011-capital-source-universe.json").write_text(json.dumps(doc))

    def terminal_result(self, doc):
        self.write_doc(doc)
        return self.run_step(TERMINAL, "Enforce terminal claim boundary")

    def fixture_claim(self):
        doc = copy.deepcopy(self.doc)
        doc.update(terminal_claim_allowed=True, claim_scope="SOURCE_UNIVERSE_READINESS_ONLY",
                   status="CAPITAL_SOURCE_UNIVERSE_COMPLETE", d11_terminal_closed=False,
                   unknown_family_count=0)
        payload = self.root / "payload"
        payload.mkdir(exist_ok=True)
        evidence_file = "evidence with spaces.json"
        data = b'{"synthetic_test_fixture": true}\n'
        (payload / evidence_file).write_bytes(data)
        evidence = dict(repository=REPOSITORY, workflow_name="Fixture source workflow with spaces",
                        run_id=101, head_sha=PR_HEAD, artifact_id=202,
                        artifact_name="fixture artifact with spaces", artifact_digest="sha256:" + "a" * 64,
                        file=evidence_file, sha256=sha256(data))
        for family in doc["families"]:
            family.update(terminally_resolved=True, resolution_evidence=copy.deepcopy(evidence))
        doc["family_universe_discovery"].update(status="AUTHENTICATED_COMPLETE", evidence=evidence)
        run = dict(status="completed", conclusion="success", head_sha=PR_HEAD, name=evidence["workflow_name"])
        artifact = dict(expired=False, name=evidence["artifact_name"], digest=evidence["artifact_digest"],
                        workflow_run={"id": 101})
        (self.root / "run.json").write_text(json.dumps(run))
        (self.root / "artifact.json").write_text(json.dumps(artifact))
        return doc

    def assert_rejected(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("RMC011_SOURCE_UNIVERSE_READINESS=PASS", result.stdout)

    def test_every_embedded_shell_script_parses(self):
        for filename in (TERMINAL, DISCOVERY):
            for name, block in step_blocks(filename).items():
                if not re.search(r"^        run: ", block, re.MULTILINE):
                    continue
                with self.subTest(workflow=filename, step=name):
                    result = subprocess.run(["bash", "-n"], input=step_script(filename, name),
                                            text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_both_workflows_run_regression_and_trigger_on_test_changes(self):
        for filename in (TERMINAL, DISCOVERY):
            with self.subTest(workflow=filename):
                source = (WORKFLOWS / filename).read_text()
                self.assertEqual(source.count(f'      - "{TEST_PATH}"'), 2)
                self.assertEqual(step_script(filename, "Validate audit workflow contract"),
                                 f"python3 {TEST_PATH} -v\n")

    def test_discovery_pr_and_dispatch_exact_head_identity(self):
        source = (WORKFLOWS / DISCOVERY).read_text()
        self.assertIn("      EXACT_HEAD: " + EXACT_HEAD_EXPRESSION, source)
        blocks = step_blocks(DISCOVERY)
        self.assertEqual(field(blocks["Checkout exact head"], "ref"), EXACT_HEAD_EXPRESSION)
        name = field(blocks["Upload immutable family discovery evidence"], "name")
        # Resolve only the declared identity variables; unsupported expressions fail.
        for event, pull_head, github_sha in (("pull_request", PR_HEAD, MERGE_HEAD),
                                            ("workflow_dispatch", None, DISPATCH_HEAD),
                                            ("push", None, DISPATCH_HEAD)):
            with self.subTest(event=event):
                exact = pull_head or github_sha
                resolved = name
                for key, value in {"env.EXACT_HEAD": exact, "github.sha": github_sha,
                                   "github.run_id": "303", "github.run_attempt": "2"}.items():
                    resolved = resolved.replace("${{ " + key + " }}", value)
                self.assertEqual(resolved, f"rmc011-family-discovery-{exact}-303-2")

    def test_terminal_checkout_and_verification_use_exact_head(self):
        blocks = step_blocks(TERMINAL)
        self.assertEqual(field(blocks["Checkout exact head"], "ref"), EXACT_HEAD_EXPRESSION)
        self.assertIn("EXACT_HEAD: " + EXACT_HEAD_EXPRESSION, blocks["Verify exact head identity"])
        self.assertIn('test "$(git rev-parse HEAD)" = "$EXACT_HEAD"',
                      step_script(TERMINAL, "Verify exact head identity"))

    def test_exact_checkout_rejects_mismatched_head_and_dirty_discovery(self):
        git = self.bin / "git"
        git.write_text("""#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'rev-parse HEAD' ]]; then
  printf '%s\\n' "$FIXTURE_GIT_HEAD"
elif [[ "$*" == 'status --porcelain --untracked-files=no' ]]; then
  printf '%s' "$FIXTURE_GIT_STATUS"
else
  exit 92
fi
""")
        git.chmod(0o755)
        self.env["FIXTURE_GIT_STATUS"] = ""
        for filename in (TERMINAL, DISCOVERY):
            for head in (PR_HEAD, DISPATCH_HEAD):
                with self.subTest(workflow=filename, head=head):
                    self.env.update(EXACT_HEAD=head, FIXTURE_GIT_HEAD=head)
                    result = self.run_step(filename, "Verify exact head identity")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.env["FIXTURE_GIT_HEAD"] = MERGE_HEAD
                    self.assertNotEqual(self.run_step(filename, "Verify exact head identity").returncode, 0)
        self.env.update(FIXTURE_GIT_HEAD=DISPATCH_HEAD, FIXTURE_GIT_STATUS=" M tracked-file")
        self.assertNotEqual(self.run_step(DISCOVERY, "Verify exact head identity").returncode, 0)

    def test_unresolved_ledger_remains_blocked_without_transport(self):
        doc = copy.deepcopy(self.doc)
        doc.update(terminal_claim_allowed=False, d11_terminal_closed=False)
        doc["families"][0]["terminally_resolved"] = False
        doc["family_universe_discovery"]["status"] = "NOT_CERTIFIED"
        result = self.terminal_result(doc)
        self.assert_rejected(result)
        self.assertIn("BLOCKED_INCOMPLETE_SOURCE_UNIVERSE", result.stderr)
        self.assertFalse((self.root / "gh-calls.jsonl").exists())

    def test_unresolved_discovery_exits_one(self):
        (self.runner / "rmc011-family-discovery-readiness.json").write_text(
            json.dumps({"ready": False, "already_authenticated": False, "unresolved_families": ["AAVE_V3_FLASH_LOAN"]}))
        result = self.run_step(DISCOVERY, "Fail closed while family discovery is unresolved")
        self.assertEqual(result.returncode, 1)
        self.assertIn("BLOCKED_UNRESOLVED_FAMILIES", result.stderr)
        self.assertIn("AAVE_V3_FLASH_LOAN", result.stderr)
        self.assertFalse((self.root / "gh-calls.jsonl").exists())

    def test_discovery_fail_closed_and_upload_guards_are_preserved(self):
        blocks = step_blocks(DISCOVERY)
        self.assertIn("if: steps.readiness.outputs.ready != 'true' && steps.readiness.outputs.already_authenticated != 'true'",
                      blocks["Fail closed while family discovery is unresolved"])
        for name in ("Authenticate all thirteen family evidence transports",
                     "Build authenticated family discovery evidence package",
                     "Upload immutable family discovery evidence"):
            self.assertIn("if: steps.readiness.outputs.ready == 'true'", blocks[name])
        self.assertEqual(field(blocks["Upload immutable family discovery evidence"], "if-no-files-found"), "error")

    def test_terminal_reads_tabs_without_splitting_workflow_or_file_spaces(self):
        doc = self.fixture_claim()
        result = self.terminal_result(doc)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("RMC011_SOURCE_UNIVERSE_READINESS=PASS", result.stdout)
        self.assertEqual(result.stdout.count("RMC011_TERMINAL_EVIDENCE_AUTHENTICATED"), len(doc["families"]) + 1)
        calls = [json.loads(line) for line in (self.root / "gh-calls.jsonl").read_text().splitlines()]
        self.assertEqual(len(calls), 3 * (len(doc["families"]) + 1))

    def test_terminal_rejects_run_identity_and_status_mutations(self):
        for key, value in (("status", "in_progress"), ("conclusion", "failure"),
                           ("head_sha", MERGE_HEAD), ("name", "Different workflow")):
            with self.subTest(field=key):
                doc = self.fixture_claim()
                path = self.root / "run.json"
                run = json.loads(path.read_text()); run[key] = value; path.write_text(json.dumps(run))
                self.assert_rejected(self.terminal_result(doc))

    def test_terminal_rejects_artifact_identity_and_expiry_mutations(self):
        for key, value in (("expired", True), ("name", "Wrong artifact"),
                           ("digest", "sha256:" + "b" * 64), ("workflow_run", {"id": 999})):
            with self.subTest(field=key):
                doc = self.fixture_claim()
                path = self.root / "artifact.json"
                artifact = json.loads(path.read_text()); artifact[key] = value; path.write_text(json.dumps(artifact))
                self.assert_rejected(self.terminal_result(doc))

    def test_terminal_rejects_foreign_repository(self):
        doc = self.fixture_claim()
        doc["families"][0]["resolution_evidence"]["repository"] = "foreign/repository"
        self.assert_rejected(self.terminal_result(doc))
        self.assertFalse((self.root / "gh-calls.jsonl").exists())

    def test_terminal_rejects_missing_or_tampered_download(self):
        for mutation in ("missing", "tampered"):
            with self.subTest(mutation=mutation):
                doc = self.fixture_claim()
                path = self.root / "payload/evidence with spaces.json"
                if mutation == "missing":
                    path.unlink()
                else:
                    path.write_bytes(b"tampered")
                self.assert_rejected(self.terminal_result(doc))

    def test_terminal_rejects_invalid_claim_scope_or_completion_flags(self):
        for key, value in (("claim_scope", "TERMINAL_D11"), ("status", "INCOMPLETE"),
                           ("d11_terminal_closed", True), ("unknown_family_count", 1)):
            with self.subTest(field=key):
                doc = self.fixture_claim(); doc[key] = value
                self.assert_rejected(self.terminal_result(doc))

    def test_terminal_rejects_unresolved_family_or_unauthenticated_discovery(self):
        for mutation in ("family", "discovery"):
            with self.subTest(mutation=mutation):
                doc = self.fixture_claim()
                if mutation == "family":
                    doc["families"][0]["terminally_resolved"] = False
                else:
                    doc["family_universe_discovery"]["status"] = "NOT_CERTIFIED"
                self.assert_rejected(self.terminal_result(doc))

    def test_discovery_package_binds_exact_head_and_keeps_nonclaims(self):
        self.write_doc(self.doc)
        (self.ci / "rmc011-capital-family-discovery.json").write_text('{"synthetic_test_fixture": true}\n')
        (self.runner / "rmc011-family-discovery-readiness.json").write_text('{"synthetic_test_fixture": true}\n')
        transport = self.runner / "rmc011-family-discovery-transport"
        (transport / "artifacts").mkdir(parents=True)
        (transport / "family-evidence-authentication.jsonl").write_text('{"synthetic_test_fixture": true}\n')
        for event, head in (("pull_request", PR_HEAD), ("workflow_dispatch", DISPATCH_HEAD)):
            with self.subTest(event=event):
                self.env["EXACT_HEAD"] = head
                result = self.run_step(DISCOVERY, "Build authenticated family discovery evidence package")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                package = self.runner / "rmc011-family-discovery-evidence"
                certificate = json.loads((package / "discovery-evidence.json").read_text())
                self.assertEqual(certificate["head_sha"], head)
                self.assertEqual((certificate["run_id"], certificate["run_attempt"]), (303, 2))
                self.assertIs(certificate["d11_terminal_closed"], False)
                self.assertIs(certificate["global_source_nonexistence_claimed"], False)
                self.assertEqual(certificate["source_universe_sha256"],
                                 sha256((package / "rmc011-capital-source-universe.json").read_bytes()))


if __name__ == "__main__":
    unittest.main()
