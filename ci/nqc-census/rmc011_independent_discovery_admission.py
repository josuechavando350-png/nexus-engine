#!/usr/bin/env python3
"""Admit one independently published discovery witness, readiness authority only.

The original archive is immutable and binds the PRE-admission universe. Compare
that universe to the proposed document with exactly the allowed transition; do
not demand a circular certificate hash of its own future reference.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import re
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

REPOSITORY = "josuechavando350-png/nexus-engine"
HEAD = "377aca59a85abbccd57e4f1831973416b9399b83"
TREE = "f5285bae0a0cf3bbd295ab85e48d84214cb0669e"
RUN = 37841923756
ATTEMPT = 1
ARTIFACT = 11577503474
WORKFLOW = "NQC RMC-011 Family Discovery Evidence"
NAME = f"rmc011-family-discovery-{HEAD}-{RUN}-{ATTEMPT}"
ZIP_SHA = "9bd159b2d5f246fef9b62d7ad67c8cfa0010092a3e78f86548dba1da1cd8fbdc"
CERTIFICATE_SHA = "ea24166dd495115bea25fcf9dea1cad6c9d27cab78d58803aeb9e3cc13202632"
ORIGINAL_UNIVERSE_SHA = "c315cb0709d37b9f8a8fc39bfe07630a76954c8fd089c48907206a4bbc525e70"
ORIGINAL_SCOPE_CANONICAL_SHA = "c6ccfa9a61d12208273efd9584ef4bba943304287f3ed4dfad0b030033e69976"
DISCOVERY_SHA = "bab53e32f746ef8ee25c326d484cee4c8db3d97143496913b3463ec84786ab14"
FAMILIES = {
    "AAVE_V3_FLASH_LOAN", "UNISWAP_V2_FLASH_SWAP", "BALANCER_V2_FLASH_LOAN",
    "UNISWAP_V3_FLASH", "EXTERNAL_GAS_CREDIT", "EXTERNAL_GAS_SPONSOR",
    "TRANSIENT_EXTERNAL_CREDIT", "COLLATERALIZED_BORROWING", "PERSISTENT_DEBT",
    "INVENTORY_REQUIREMENT", "BOND_OR_STAKE", "SOLVER_OR_BUILDER_DEPOSIT",
    "INTRA_BLOCK_TEMPORARY_LOCK",
}
NATIVE_COUNTS = {"AAVE_V3_FLASH_LOAN": 67, "UNISWAP_V2_FLASH_SWAP": 1045392,
                 "BALANCER_V2_FLASH_LOAN": 67, "UNISWAP_V3_FLASH": 69748}
TRANSPORT_KEYS = {"repository", "workflow_name", "run_id", "head_sha", "artifact_id",
                  "artifact_name", "artifact_digest", "file", "sha256"}
BINDINGS = {
    "rmc011-capital-family-discovery.json": "discovery_contract_sha256",
    "rmc011-capital-source-universe.json": "source_universe_sha256",
    "rmc011-family-discovery-readiness.json": "readiness_sha256",
    "family-evidence-authentication.jsonl": "family_evidence_transport_sha256",
}
AUXILIARY = {
    11571178483: {"evidence-index.json", "rejection-report.json"},
    11573678487: {"original-source-report.json"},
    11576204678: {"four-native-source-summary.json", "adversarial-tests.txt", "producer-source.sha256"},
}
SHA_RE = re.compile(r"[0-9a-f]{64}\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def parse(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "duplicate JSON key")
            value[key] = item
        return value
    value = json.loads(raw, object_pairs_hook=unique)
    require(type(value) is dict, "JSON object required")
    return value


def witness():
    return {"kind": "AUTHENTICATED_DISCOVERY", "repository": REPOSITORY,
            "workflow_name": WORKFLOW, "run_id": RUN, "head_sha": HEAD,
            "artifact_id": ARTIFACT, "artifact_name": NAME,
            "artifact_digest": "sha256:" + ZIP_SHA, "file": "discovery-evidence.json",
            "sha256": CERTIFICATE_SHA}


def verify_metadata(run, artifact, commit):
    expected_run = {"id": RUN, "run_attempt": ATTEMPT, "head_sha": HEAD,
                    "name": WORKFLOW, "status": "completed", "conclusion": "success"}
    require(canonical({k: run.get(k) for k in expected_run}) == canonical(expected_run),
            "original discovery run/head/attempt/status mismatch")
    require(run.get("repository", {}).get("full_name") == REPOSITORY
            and run.get("head_repository", {}).get("full_name") == REPOSITORY,
            "original discovery repository mismatch")
    expected_artifact = {"id": ARTIFACT, "name": NAME, "digest": "sha256:" + ZIP_SHA,
                         "expired": False}
    require(canonical({k: artifact.get(k) for k in expected_artifact}) == canonical(expected_artifact),
            "original discovery artifact identity/digest/expiry mismatch")
    transport = artifact.get("workflow_run", {})
    require(type(transport.get("id")) is int and transport.get("id") == RUN
            and transport.get("head_sha") == HEAD, "original discovery artifact run/head mismatch")
    require(commit.get("sha") == HEAD and commit.get("tree", {}).get("sha") == TREE,
            "original discovery commit/tree mismatch")


def safe_name(name):
    return (isinstance(name, str) and name and "\\" not in name
            and not name.startswith("/") and ".." not in PurePosixPath(name).parts
            and str(PurePosixPath(name)) == name)


def open_archive(raw):
    require(type(raw) is bytes and 0 < len(raw) <= 1000000 and sha256(raw) == ZIP_SHA,
            "original discovery ZIP outer SHA256 mismatch")
    with ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        require(len(names) == 28 and len(set(names)) == len(names), "ZIP member count/duplicates")
        require(all(safe_name(x.filename) and not x.is_dir() and x.file_size <= 1000000
                    and ((x.external_attr >> 16) & 0o170000) != 0o120000 for x in entries)
                and sum(x.file_size for x in entries) <= 2000000, "unsafe ZIP members")
        return {entry.filename: archive.read(entry) for entry in entries}


def verify_manifest(members, manifest, required):
    require(manifest in members, "missing SHA256SUMS")
    prefix = manifest.rsplit("/", 1)[0] + "/" if "/" in manifest else ""
    declared = {}
    for line in members[manifest].decode("ascii").splitlines():
        parts = line.split("  ", 1)
        require(len(parts) == 2 and SHA_RE.fullmatch(parts[0]), "malformed SHA256SUMS")
        path = parts[1].removeprefix("./")
        require(safe_name(path), "unsafe manifest path")
        name = prefix + path
        require(name not in declared, "duplicate manifest member")
        declared[name] = parts[0]
    require(set(declared) == required, "omitted or extra manifest members")
    require(all(name in members and sha256(members[name]) == digest
                for name, digest in declared.items()), "manifest member SHA256 mismatch")


def verify_bound_members(members):
    """Semantic boundary, independently tested after the cryptographic envelope."""
    cert = parse(members["discovery-evidence.json"])
    expected = {"schema_version": 1, "stage": "RMC-011", "kind": "AUTHENTICATED_DISCOVERY",
                "status": "RMC011_FAMILY_DISCOVERY_AUTHENTICATED_COMPLETE",
                "workflow_name": WORKFLOW, "head_sha": HEAD, "run_id": RUN,
                "run_attempt": ATTEMPT, "family_count": 13, "unresolved_family_count": 0,
                "global_source_nonexistence_claimed": False, "d11_terminal_closed": False}
    require(set(cert) == set(expected) | set(BINDINGS.values()), "certificate field set mismatch")
    require(canonical({k: cert.get(k) for k in expected}) == canonical(expected),
            "certificate identity/count/nonclaims mismatch")
    require(all(name in members and sha256(members[name]) == cert[key]
                for name, key in BINDINGS.items()), "certificate input SHA256 binding mismatch")
    original = parse(members["rmc011-capital-source-universe.json"])
    require(original.get("status") == "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
            and original.get("terminal_claim_allowed") is False
            and original.get("d11_terminal_closed") is False
            and original.get("claim_scope") == "SOURCE_UNIVERSE_READINESS_ONLY"
            and original.get("family_universe_discovery") == {
                "status": "NOT_CERTIFIED", "terminal_requirement": "AUTHENTICATED_COMPLETE",
                "evidence": None}, "original discovery must bind pre-admission readiness only")
    rows = original.get("families", [])
    require(len(rows) == 13 and {row.get("id") for row in rows} == FAMILIES,
            "original family set/count/duplicates mismatch")
    expected_readiness_rows = []
    expected_ledger = []
    expected_members = {"SHA256SUMS", "discovery-evidence.json"} | set(BINDINGS)
    for artifact_id, extras in AUXILIARY.items():
        expected_members |= {f"artifacts/{artifact_id}/{name}" for name in extras | {"SHA256SUMS"}}
    for row in sorted(rows, key=lambda r: r["id"]):
        ref = row.get("resolution_evidence", {})
        require(row.get("terminally_resolved") is True
                and row.get("status") in {"AUTHENTICATED_REAL_SOURCE",
                    "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"}
                and set(ref) == TRANSPORT_KEYS | {"kind"}, "family terminal evidence mismatch")
        transport = {key: ref[key] for key in TRANSPORT_KEYS}
        expected_ledger.append({"family": row["id"], **transport})
        expected_readiness_rows.append({"family": row["id"], "status": row["status"], **ref})
        path = f"artifacts/{ref['artifact_id']}/{ref['file']}"
        require(safe_name(path) and path in members and sha256(members[path]) == ref["sha256"],
                "original family witness member SHA256 mismatch")
        record = parse(members[path])
        require(record.get("family") == row["id"] and record.get("kind") == ref["kind"],
                "original family witness identity mismatch")
        expected_members.add(path)
        if row["id"] in NATIVE_COUNTS:
            unknown = row["id"] in {"AAVE_V3_FLASH_LOAN", "UNISWAP_V2_FLASH_SWAP"}
            require(record.get("original_historical_source_count") == NATIVE_COUNTS[row["id"]]
                    and record.get("source_execution_eligibility_not_yet_reconstructed") is unknown
                    and (record.get("source_execution_eligible_count") is None if unknown else
                         type(record.get("source_execution_eligible_count")) is int and
                         record["source_execution_eligible_count"] == 0)
                    and record.get("original_native_gas_external_sponsor_count") == 0
                    and record.get("nqc_capital_or_profit_positive_claimed") is False
                    and record.get("global_source_nonexistence_claimed") is False
                    and record.get("terminal_d11_closed") is False,
                    "historical source eligibility unknown/zero or nonclaims changed")
    require(set(members) == expected_members, "missing or injected archive members")
    manifests = {name for name in expected_members if name.endswith("SHA256SUMS")}
    verify_manifest(members, "SHA256SUMS", expected_members - manifests)
    for artifact_id in AUXILIARY:
        prefix = f"artifacts/{artifact_id}/"
        included = {name for name in expected_members if name.startswith(prefix)} - manifests
        if artifact_id == 11576204678:
            included -= {prefix + "adversarial-tests.txt", prefix + "producer-source.sha256"}
        verify_manifest(members, prefix + "SHA256SUMS", included)
    ledger = [parse(line) for line in members["family-evidence-authentication.jsonl"].splitlines() if line]
    require(canonical(ledger) == canonical(expected_ledger), "family transport ledger set/order/bindings mismatch")
    ready = parse(members["rmc011-family-discovery-readiness.json"])
    expected_ready = {"schema_version": 1, "stage": "RMC-011",
                      "status": "RMC011_FAMILY_DISCOVERY_TRANSPORT_READY", "ready": True,
                      "already_authenticated": False, "family_count": 13, "resolved_count": 13,
                      "unresolved_count": 0, "unresolved_families": [],
                      "family_evidence": expected_readiness_rows,
                      "authenticated_complete_claimed": False, "d11_terminal_closed": False}
    require(canonical(ready) == canonical(expected_ready), "original readiness ledger/claims mismatch")
    return original


def verify(*, zip_raw, run, artifact, commit, source_universe, scope, discovery):
    verify_metadata(run, artifact, commit)
    members = open_archive(zip_raw)
    require(sha256(members.get("discovery-evidence.json", b"")) == CERTIFICATE_SHA,
            "original certificate member SHA256 mismatch")
    require(sha256(members.get("rmc011-capital-source-universe.json", b"")) == ORIGINAL_UNIVERSE_SHA,
            "original pre-admission universe SHA256 mismatch")
    require(sha256(discovery) == DISCOVERY_SHA
            and discovery == members.get("rmc011-capital-family-discovery.json"),
            "current discovery contract differs from original witness")
    original = verify_bound_members(members)
    expected = copy.deepcopy(original)
    expected["status"] = "CAPITAL_SOURCE_UNIVERSE_COMPLETE"
    expected["terminal_claim_allowed"] = True
    expected["family_universe_discovery"]["status"] = "AUTHENTICATED_COMPLETE"
    expected["family_universe_discovery"]["evidence"] = witness()
    require(canonical(parse(source_universe)) == canonical(expected),
            "admission changed original families/nonclaims or exact discovery reference")
    proposed_scope = parse(scope)
    require(proposed_scope.get("claims", {}).get("capital_source_universe_complete") is True,
            "admission requires matching readiness scope claim")
    proposed_scope["claims"]["capital_source_universe_complete"] = False
    require(sha256(canonical(proposed_scope)) == ORIGINAL_SCOPE_CANONICAL_SHA,
            "admission changed unrelated scope or widened terminal/economic claims")
    return {"schema_version": 1, "status": "RMC011_DISCOVERY_READINESS_ADMISSION_AUTHENTICATED",
            "claim_scope": "SOURCE_UNIVERSE_READINESS_ONLY", "producer_run": RUN,
            "producer_head": HEAD, "producer_tree": TREE, "artifact_id": ARTIFACT,
            "artifact_zip_sha256": ZIP_SHA, "certificate_sha256": CERTIFICATE_SHA,
            "family_count": 13, "family_universe_discovery_authenticated": True,
            "capital_source_universe_complete": True, "d11_terminal_closed": False,
            "global_capital_source_completeness": False, "executable_capital_proven": False,
            "aave_v3_and_uniswap_v2_execution_eligibility": "UNRECONSTRUCTED",
            "balancer_v2_and_uniswap_v3_execution_eligible_count": 0,
            "external_gas_sponsors_admitted": 0, "real_market_census_closed": False,
            "profitability_proven": False, "nqc_realized_pnl_usd_wad": "0"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("zip", "run", "artifact", "commit", "report"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    root = Path("ci/nqc-census")
    require(not args.report.exists(), "admission report is append-only")
    result = verify(zip_raw=args.zip.read_bytes(), run=parse(args.run.read_bytes()),
                    artifact=parse(args.artifact.read_bytes()), commit=parse(args.commit.read_bytes()),
                    source_universe=(root / "rmc011-capital-source-universe.json").read_bytes(),
                    scope=(root / "capital-census-scope.json").read_bytes(),
                    discovery=(root / "rmc011-capital-family-discovery.json").read_bytes())
    result["report_sha256"] = sha256(canonical(result))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_bytes(canonical(result))
    print(result["status"], "FAMILIES=13 D11_CLOSED=false EXECUTABLE=false PNL=0")


if __name__ == "__main__":
    main()
