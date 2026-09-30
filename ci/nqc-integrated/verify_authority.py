#!/usr/bin/env python3
"""Verify the integrated Real Market Census authority chain from immutable evidence.

Reads a declaration (`authority.json`) of certified nodes. Each node names its
exact code commit and tree, workflow run, artifact and digests. Everything is
re-derived, with no trust in the declaration itself:

- through the GitHub API: the run succeeded at the declared commit, the
  commit has the declared tree, and the artifact belongs to that run with
  the declared name and digest;
- by downloading the artifact ZIP: its SHA-256 is the declared digest, the
  evidence manifest has the declared SHA-256 and was written by the
  declared commit and tree, and every artifact the manifest lists
  (single-file or ordered segments) re-hashes to its entry;
- the declared anchor and claims are read from the evidence itself;
- each parent's commit is an ancestor of the node's commit (the code stack);
- each consumed file is present in the declared source node's artifact with
  the declared SHA-256;
- the node's committed pins name exactly the declared upstream nodes by full
  identity and pin exactly the consumed digests, and the node's closeout
  records those same upstream sources.

Any mismatch, missing node or unreadable fact is FAIL. Standard library only;
GitHub access is through the `gh` CLI with GH_TOKEN.
"""

import hashlib
import json
import os
import subprocess
import sys
import zipfile

REPO = os.environ.get("GITHUB_REPOSITORY", "josuechavando350-png/nexus-engine")


class Failure(Exception):
    pass


def gh(path, jq):
    out = subprocess.run(["gh", "api", f"repos/{REPO}/{path}", "--jq", jq],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise Failure(f"GitHub API {path}: {out.stderr.strip()}")
    return out.stdout.strip()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def pointer(document, path):
    value = document
    for key in path:
        if isinstance(value, list):
            value = value[int(key)]
        elif isinstance(value, dict) and key in value:
            value = value[key]
        else:
            raise Failure(f"no {'/'.join(map(str, path))}")
    return value


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True)


class Node:
    def __init__(self, spec, work):
        self.spec = spec
        self.id = spec["node"]
        self.root = os.path.join(work, self.id.replace("@", "_at_"))
        self.checks = []

    def check(self, name, ok, detail=""):
        self.checks.append({"check": name, "pass": bool(ok), "detail": detail})
        if not ok:
            raise Failure(f"{name}: {detail}")

    def file(self, relative):
        path = os.path.join(self.root, relative)
        if not os.path.isfile(path):
            raise Failure(f"{self.id} artifact has no {relative}")
        return path

    def json(self, relative):
        with open(self.file(relative)) as handle:
            return json.load(handle)

    def identity(self):
        s = self.spec
        run, artifact = s["workflow_run_id"], s["artifact_id"]
        head = gh(f"actions/runs/{run}", ".head_sha")
        self.check("run_head", head == s["code_commit"], f"run {run} head {head}")
        conclusion = gh(f"actions/runs/{run}", ".conclusion")
        self.check("run_success", conclusion == "success", f"run {run} {conclusion}")
        tree = gh(f"git/commits/{s['code_commit']}", ".tree.sha")
        self.check("commit_tree", tree == s["code_tree"], f"tree {tree}")
        owner = gh(f"actions/artifacts/{artifact}", ".workflow_run.id")
        self.check("artifact_run", owner == str(run), f"artifact of run {owner}")
        name = gh(f"actions/artifacts/{artifact}", ".name")
        self.check("artifact_name", name == s["artifact"], name)
        digest = gh(f"actions/artifacts/{artifact}", ".digest")
        self.check("artifact_digest_api", digest == s["artifact_digest"], digest)

    def download(self):
        s = self.spec
        os.makedirs(self.root, exist_ok=True)
        archive = self.root + ".zip"
        with open(archive, "wb") as handle:
            out = subprocess.run(["gh", "api", f"repos/{REPO}/actions/artifacts/{s['artifact_id']}/zip"],
                                 stdout=handle, stderr=subprocess.PIPE)
        if out.returncode != 0:
            raise Failure(f"download {s['artifact_id']}: {out.stderr.decode().strip()}")
        observed = "sha256:" + sha256_file(archive)
        self.check("artifact_zip_sha256", observed == s["artifact_digest"], observed)
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(self.root)
        os.remove(archive)

    def evidence(self):
        s = self.spec["evidence_manifest"]
        observed = sha256_file(self.file(s["path"]))
        self.check("evidence_manifest_sha256", observed == s["sha256"], observed)
        manifest = self.json(s["path"])
        self.check("evidence_manifest_commit",
                   (manifest.get("code_commit"), manifest.get("code_tree"))
                   == (self.spec["code_commit"], self.spec["code_tree"]),
                   f"{manifest.get('code_commit')} {manifest.get('code_tree')}")
        base = os.path.dirname(s["path"])
        for entry in manifest.get("artifacts", []):
            name = entry.get("path") or entry.get("name")
            observed = sha256_file(self.file(os.path.join(base, name)))
            self.check(f"manifest_entry:{name}", observed == entry["sha256"], observed)
        return manifest

    def anchor(self):
        a = self.spec["anchor"]
        document = self.json(a["evidence"]["path"])
        number = pointer(document, a["evidence"]["number"])
        block_hash = pointer(document, a["evidence"]["hash"])
        self.check("anchor", (int(number), str(block_hash).lower()) == (a["number"], a["hash"].lower()),
                   f"{number} {block_hash}")

    def claims(self):
        for claim in self.spec.get("claims", []):
            value = pointer(self.json(claim["path"]), claim["pointer"])
            self.check(f"claim:{claim['path']}:{'/'.join(map(str, claim['pointer']))}",
                       value == claim["equals"], json.dumps(value))


def identity_of(spec):
    return {key: spec[key] for key in ("code_commit", "code_tree", "workflow_run_id", "artifact_id",
                                       "artifact", "artifact_digest")} | {
        "evidence_manifest_sha256": spec["evidence_manifest"]["sha256"]}


def verify_pins(node, nodes):
    """The node's committed pins name exactly its declared upstream nodes by
    full identity, and pin exactly its declared consumed files (by role)."""
    pins = node.spec.get("pins")
    if not pins:
        return
    out = git("show", f"{node.spec['code_commit']}:{pins['path']}")
    node.check("pins_readable", out.returncode == 0, out.stderr.strip())
    document = json.loads(out.stdout)
    node.check("pins_status", document.get("status") == "PINNED", str(document.get("status")))
    declared = node.spec["upstream"]  # pin source key -> declared node id
    seen = set()
    for source in document["sources"]:
        key = source.get("node") or source.get("role")
        node.check(f"pin_source_declared:{key}", key in declared, str(key))
        expected = identity_of(nodes[declared[key]].spec)
        observed = {k: source.get(k) for k in expected}
        node.check(f"pin_source_identity:{key}", observed == expected, json.dumps(observed))
        seen.add(key)
    node.check("pin_sources_complete", seen == set(declared), json.dumps(sorted(seen)))
    consumed = {c["role"]: c["sha256"] for c in node.spec.get("consumes", []) if "role" in c}
    pinned = {e["role"]: e["sha256"] for e in document.get("files", []) + document.get("target_d06_files", [])}
    node.check("pin_files_are_the_consumed_files", pinned == consumed,
               json.dumps(sorted(set(pinned.items()) ^ set(consumed.items()))))


def verify_consumes(node, nodes):
    for item in node.spec.get("consumes", []):
        source = nodes.get(item["from"])
        node.check(f"consumes_source:{item['from']}", source is not None and not hasattr(source, "failure"),
                   item["from"])
        observed = sha256_file(source.file(item["path"]))
        node.check(f"consumes:{item['from']}:{item['path']}", observed == item["sha256"], observed)


def verify_parents(node, nodes):
    for parent in node.spec.get("parents", []):
        ancestor = nodes[parent].spec["code_commit"]
        for commit in (ancestor, node.spec["code_commit"]):
            git("fetch", "-q", "origin", commit)
        ok = git("merge-base", "--is-ancestor", ancestor, node.spec["code_commit"]).returncode == 0
        node.check(f"parent:{parent}", ok, f"{ancestor} is not an ancestor")


def verify_closeout_upstream(node, nodes, manifest):
    """A node whose closeout records its upstream sources (RMC-008 onward)
    names exactly the declared upstream nodes by full identity."""
    if not node.spec.get("closeout_records_upstream"):
        return
    recorded = manifest.get("upstream_sources")
    node.check("closeout_upstream_present", isinstance(recorded, list) and recorded, str(recorded)[:120])
    declared = node.spec["upstream"]
    keys = set()
    for source in recorded:
        key = source.get("node") or source.get("role")
        node.check(f"closeout_upstream_declared:{key}", key in declared, str(key))
        expected = identity_of(nodes[declared[key]].spec)
        observed = {k: source.get(k) for k in expected}
        node.check(f"closeout_upstream_identity:{key}", observed == expected, json.dumps(observed))
        keys.add(key)
    node.check("closeout_upstream_complete", keys == set(declared), json.dumps(sorted(keys)))


def main(declaration, work, report_path):
    declared = json.load(open(declaration))
    nodes = {spec["node"]: Node(spec, work) for spec in declared["nodes"]}
    results, failed = [], False
    order = list(nodes)
    manifests = {}
    for node_id in order:
        node = nodes[node_id]
        try:
            node.identity()
            node.download()
            manifests[node_id] = node.evidence()
            node.anchor()
            node.claims()
        except Failure as error:
            node.failure = str(error)
    for node_id in order:
        node = nodes[node_id]
        if not hasattr(node, "failure"):
            try:
                verify_parents(node, nodes)
                verify_consumes(node, nodes)
                verify_pins(node, nodes)
                verify_closeout_upstream(node, nodes, manifests[node_id])
            except Failure as error:
                node.failure = str(error)
        status = "FAIL" if hasattr(node, "failure") else "PASS"
        failed |= status == "FAIL"
        results.append({"node": node_id, "status": status, "failure": getattr(node, "failure", None),
                        "identity": identity_of(node.spec), "anchor": node.spec["anchor"],
                        "checks": node.checks})
        print(f"RMC_INTEGRATED_NODE node={node_id} status={status} checks={len(node.checks)}"
              + (f" failure={node.failure}" if status == "FAIL" else ""))
    required = set(declared["required_nodes"])
    missing = sorted(required - set(nodes))
    failed |= bool(missing)
    report = {"schema": "nqc-rmc-integrated-authority-report-v1",
              "declaration_sha256": sha256_file(declaration),
              "required_nodes": sorted(required), "missing_nodes": missing,
              "status": "FAIL" if failed else "PASS", "nodes": results}
    with open(report_path, "w") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"RMC_INTEGRATED_AUTHORITY status={report['status']} nodes={len(results)} "
          f"missing={','.join(missing) or 'none'} report_sha256={sha256_file(report_path)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:4]))
