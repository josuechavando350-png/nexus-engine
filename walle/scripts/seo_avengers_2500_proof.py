#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
from typing import Any, Mapping

SCHEMA_VERSION = 1
EXPECTED_MODULE_IDS = tuple(f"M{i}" for i in range(1, 2501))
EXPECTED_SET = set(EXPECTED_MODULE_IDS)
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
STATUS_EXECUTED = "EXECUTED"
STATUS_FAILED = "FAILED"
STATUS_BLOCKED = "BLOCKED"
STATUS_NOT_TESTED = "NOT_TESTED"
VALID_STATUSES = {STATUS_EXECUTED, STATUS_FAILED, STATUS_BLOCKED, STATUS_NOT_TESTED}
RANGE_SPECS = (
    ("M001-M200", 1, 200, "seo-avengers-200-local-mirror"),
    ("M201-M400", 201, 400, "seo-avengers-400"),
    ("M401-M600", 401, 600, "seo-avengers-600"),
    ("M601-M800", 601, 800, "seo-avengers-800"),
    ("M801-M1000", 801, 1000, "seo-avengers-1000"),
    ("M1001-M2500", 1001, 2500, "seo-avengers-2500-sidecar"),
)
TERMINAL_SAFETY_MODULES = tuple(f"M{i}" for i in range(2491, 2501))


def _canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _sha256_value(value: Any) -> str:
    return _sha256_bytes(_canonical_json_bytes(value))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_canonical_json_bytes(value) + b"\n")


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _inside(child: Path, parent: Path) -> bool:
    child_resolved = child.resolve()
    parent_resolved = parent.resolve()
    try:
        child_resolved.relative_to(parent_resolved)
    except ValueError:
        return False
    return True


def _safe_module_id(number: int) -> str:
    return f"M{number}"


def _normalize_execution_status(receipt: Mapping[str, Any]) -> tuple[str, str]:
    raw = str(receipt.get("execution_status", receipt.get("status", ""))).upper()
    finding = str(receipt.get("finding_status", "NO_FINDING")).upper()
    if raw in {"SKIP", "SKIPPED", "NOT_TESTED", "NOT TESTED"}:
        return STATUS_NOT_TESTED, raw or "NOT_TESTED"
    if raw in {"INSUFFICIENT_DATA", "BLOCKED", "STALE", "UNAVAILABLE"}:
        return STATUS_BLOCKED, raw
    if raw in {"ERROR", "FAILED", "FAIL", "FAILURE"}:
        return STATUS_FAILED, raw
    if raw == "SUCCESS":
        return STATUS_EXECUTED, "SUCCESS_WITH_FINDING" if finding == "FINDING" else "SUCCESS"
    return STATUS_BLOCKED, f"UNKNOWN_EXECUTION_STATUS:{raw or 'MISSING'}"


def _subprocess_outcome(
    command: list[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    timeout_seconds: float,
    stdout_path: Path,
    stderr_path: Path,
) -> dict[str, Any]:
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    started_command = [str(part) for part in command]
    return_code: int | None = None
    timed_out = False
    try:
        with stdout_path.open("wb") as stdout_handle, stderr_path.open("wb") as stderr_handle:
            process = subprocess.Popen(
                command,
                cwd=cwd,
                env=dict(env),
                stdout=stdout_handle,
                stderr=stderr_handle,
                start_new_session=True,
            )
            try:
                return_code = process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
    except OSError as exc:
        return {
            "command": started_command,
            "status": "BLOCKED",
            "reason": f"SPAWN_ERROR:{type(exc).__name__}:{exc}",
            "exit_code": None,
            "timed_out": False,
            "skip_detected": False,
            "stdout_sha256": _sha256_file(stdout_path) if stdout_path.exists() else None,
            "stderr_sha256": _sha256_file(stderr_path) if stderr_path.exists() else None,
        }
    if timed_out:
        return {
            "command": started_command,
            "status": "BLOCKED",
            "reason": "TIMEOUT",
            "exit_code": None,
            "timed_out": True,
            "skip_detected": False,
            "stdout_sha256": _sha256_file(stdout_path) if stdout_path.exists() else None,
            "stderr_sha256": _sha256_file(stderr_path) if stderr_path.exists() else None,
        }
    stdout_text = stdout_path.read_text(encoding="utf-8", errors="replace")
    stderr_text = stderr_path.read_text(encoding="utf-8", errors="replace")
    skip_detected = bool(
        re.search(r"(^|\s)SKIP(?:PED)?($|\s|:)", stdout_text + "\n" + stderr_text, re.IGNORECASE)
    )
    status = "PASS" if return_code == 0 and not skip_detected else "FAIL"
    reason = "OK"
    if skip_detected:
        status = "NOT_TESTED"
        reason = "SKIP_DETECTED"
    elif return_code != 0:
        reason = f"EXIT_{return_code}"
    return {
        "command": started_command,
        "status": status,
        "reason": reason,
        "exit_code": return_code,
        "timed_out": False,
        "skip_detected": skip_detected,
        "stdout_sha256": _sha256_file(stdout_path),
        "stderr_sha256": _sha256_file(stderr_path),
    }


def _python_range_snippet(suite: str) -> str:
    snippets = {
        "seo-avengers-400": r'''
import json
from runtime.service import execute_avengers_400
from test_suite_400 import complete_payload
result = execute_avengers_400(complete_payload(), {"CONFIG_SEO_AVENGERS_400": True})
expected = tuple(f"M{i}" for i in range(201, 401))
if result.get("executed_new_modules") != 200 or tuple(result.get("receipts", {})) != expected:
    raise RuntimeError("M201-M400 execution cardinality drift")
print(json.dumps({"schema_version":1,"receipt_count":200,"receipts":result["receipts"]},sort_keys=True,separators=(",",":")))
''',
        "seo-avengers-600": r'''
import json
from runtime.service import execute_avengers_600
from fixture import rich_payload
result = execute_avengers_600(rich_payload(), {"CONFIG_SEO_AVENGERS_600": True})
expected = tuple(f"M{i}" for i in range(401, 601))
if result.get("executed_new_modules") != 200 or tuple(result.get("receipts", {})) != expected:
    raise RuntimeError("M401-M600 execution cardinality drift")
print(json.dumps({"schema_version":1,"receipt_count":200,"receipts":result["receipts"]},sort_keys=True,separators=(",",":")))
''',
        "seo-avengers-800": r'''
import json
from runtime.service import execute_avengers_800
from fixture import rich_payload
result = execute_avengers_800(rich_payload(), {"CONFIG_SEO_AVENGERS_800": True})
expected = tuple(f"M{i}" for i in range(601, 801))
if result.get("executed_new_modules") != 200 or tuple(result.get("receipts", {})) != expected:
    raise RuntimeError("M601-M800 execution cardinality drift")
print(json.dumps({"schema_version":1,"receipt_count":200,"receipts":result["receipts"]},sort_keys=True,separators=(",",":")))
''',
        "seo-avengers-1000": r'''
import json
from runtime.service import execute_avengers_1000
from fixture import full_payload
result = execute_avengers_1000(full_payload(), {"CONFIG_SEO_AVENGERS_1000": True})
expected = tuple(f"M{i}" for i in range(801, 1001))
if result.get("executed_new_modules") != 200 or tuple(result.get("receipts", {})) != expected:
    raise RuntimeError("M801-M1000 execution cardinality drift")
print(json.dumps({"schema_version":1,"receipt_count":200,"receipts":result["receipts"]},sort_keys=True,separators=(",",":")))
''',
        "seo-avengers-2500": r'''
import json
from sidecar.execute_suite import execute_request
from test_batch_2201_2400 import fixture
payload, config = fixture()
# WALLE's proof fixture extends the existing deterministic test corpus only to
# exercise evidence-dependent branches that correctly return INSUFFICIENT_DATA
# when their observations are absent. These rows are controlled synthetic test
# evidence, never production/client measurements and never a ranking claim.
config["local_brand_terms"] = list(config.get("local_brand_terms", [])) + ["walle proof"]
payload["content_documents"] = list(payload.get("content_documents", [])) + [{
    "document_id":"/walle-proof",
    "text":"walle proof abogado consulta defensa penal fraude audiencia inicial cdmx ciudad de mexico urgente que hacer como cuando evidencia controlada"
}]
payload["search_performance_records"] = list(payload.get("search_performance_records", [])) + [
    {"query":"walle proof abogado penal cdmx urgente que hacer","page_url":"/walle-proof","clicks":0,"impressions":80,"average_position_milli":2000},
    {"query":"walle proof consulta fraude ciudad de mexico urgente como","page_url":"/walle-proof","clicks":0,"impressions":80,"average_position_milli":6000},
    {"query":"walle proof defensa audiencia inicial cdmx urgente cuando","page_url":"/walle-proof","clicks":0,"impressions":80,"average_position_milli":25000},
]
result = execute_request({"schema_version":1,"payload":payload,"config":config})
expected = tuple(f"M{i}" for i in range(1001, 2501))
if result.get("receipt_count") != 1500 or tuple(result.get("receipts", {})) != expected:
    raise RuntimeError("M1001-M2500 execution cardinality drift")
print(json.dumps(result,sort_keys=True,separators=(",",":")))
''',
    }
    return snippets[suite]


def _parse_json_stdout(stdout_path: Path, output_path: Path) -> None:
    text = stdout_path.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("empty_runtime_output")
    lines = [line for line in text.splitlines() if line.strip()]
    payload = json.loads(lines[-1])
    _write_json(output_path, payload)


def _collect_verifier_gates(
    gate_evidence_path: Path,
    evidence_root: Path,
    source_revision: str,
    source_tree: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    errors: list[str] = []
    try:
        raw = _load_json(gate_evidence_path)
    except Exception as exc:
        return [], [f"invalid_verifier_gate_evidence:{type(exc).__name__}:{exc}"]
    if not isinstance(raw, Mapping):
        return [], ["verifier_gate_evidence_not_object"]
    if raw.get("schema_version") != SCHEMA_VERSION:
        errors.append("verifier_gate_schema_mismatch")
    if raw.get("source_revision") != source_revision or raw.get("source_tree") != source_tree:
        errors.append("verifier_gate_source_mismatch")
    gates = raw.get("gates")
    if not isinstance(gates, list):
        return [], errors + ["verifier_gates_not_list"]
    expected_names = {"CHAINED_VERIFIER_M201_M2500", "ORIGINAL_VERIFIER_M001_M200"}
    names = {str(item.get("name")) for item in gates if isinstance(item, Mapping)}
    if names != expected_names or len(gates) != 2:
        errors.append("verifier_gate_set_mismatch")
    normalized: list[dict[str, Any]] = []
    gate_dir = evidence_root / "gates"
    gate_dir.mkdir(parents=True, exist_ok=True)
    for item in gates:
        if not isinstance(item, Mapping):
            errors.append("verifier_gate_not_object")
            continue
        name = str(item.get("name", "UNKNOWN"))
        exit_code = item.get("exit_code")
        skip_detected = item.get("skip_detected")
        gate_status = "PASS" if exit_code == 0 and skip_detected is False else "FAIL"
        if gate_status != "PASS":
            errors.append(f"verifier_gate_failed:{name}")
        safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", name.lower())
        copied: dict[str, Any] = {
            "name": name,
            "status": gate_status,
            "exit_code": exit_code,
            "skip_detected": skip_detected,
        }
        for stream in ("stdout", "stderr"):
            source_value = item.get(f"{stream}_path")
            declared_hash = item.get(f"{stream}_sha256")
            if (
                not isinstance(source_value, str)
                or not isinstance(declared_hash, str)
                or SHA256_RE.fullmatch(declared_hash) is None
            ):
                errors.append(f"invalid_verifier_gate_log_metadata:{name}:{stream}")
                continue
            source_path = Path(source_value).resolve()
            if not source_path.is_file():
                errors.append(f"missing_verifier_gate_log:{name}:{stream}")
                continue
            actual_hash = _sha256_file(source_path)
            if actual_hash != declared_hash:
                errors.append(f"verifier_gate_log_hash_mismatch:{name}:{stream}")
                continue
            destination = gate_dir / f"{safe_name}.{stream}.log"
            shutil.copyfile(source_path, destination)
            copied[f"{stream}_sha256"] = actual_hash
            copied[f"{stream}_file"] = str(destination.relative_to(evidence_root))
        normalized.append(copied)
    return normalized, errors


def _execute_evidence_collection(
    repo_root: Path,
    source_revision: str,
    source_tree: str,
    evidence_root: Path,
) -> list[dict[str, Any]]:
    ranges_root = evidence_root / "ranges"
    logs_root = evidence_root / "logs"
    ranges_root.mkdir(parents=True, exist_ok=True)
    logs_root.mkdir(parents=True, exist_ok=True)
    base_env = os.environ.copy()
    base_env["PYTHONDONTWRITEBYTECODE"] = "1"
    pycache = evidence_root / "pycache"
    pycache.mkdir(parents=True, exist_ok=True)
    base_env["PYTHONPYCACHEPREFIX"] = str(pycache)
    outcomes: list[dict[str, Any]] = []

    m200_output = ranges_root / "m001-m200.json"
    m200_env = dict(base_env)
    m200_env["WALLE_SOURCE_REVISION"] = source_revision
    m200_env["WALLE_M200_EVIDENCE_OUTPUT"] = str(m200_output)
    m200_env["WALLE_M200_SITE_ID"] = "walle-proof-probe"
    m200_python_dir = m200_env.get("WALLE_M200_PYTHON_DIR")
    if m200_python_dir:
        m200_env["PATH"] = m200_python_dir + os.pathsep + m200_env.get("PATH", "")
    outcome = _subprocess_outcome(
        ["bash", "seo-avengers-200/scripts/local-mirror-e2e.sh"],
        cwd=repo_root,
        env=m200_env,
        timeout_seconds=900,
        stdout_path=logs_root / "m001-m200.stdout.log",
        stderr_path=logs_root / "m001-m200.stderr.log",
    )
    outcome.update({"range": "M001-M200", "evidence_file": str(m200_output.relative_to(evidence_root))})
    outcomes.append(outcome)

    for suite, label, output_name, timeout_seconds in (
        ("seo-avengers-400", "M201-M400", "m201-m400.json", 180),
        ("seo-avengers-600", "M401-M600", "m401-m600.json", 180),
        ("seo-avengers-800", "M601-M800", "m601-m800.json", 180),
        ("seo-avengers-1000", "M801-M1000", "m801-m1000.json", 180),
        ("seo-avengers-2500", "M1001-M2500", "m1001-m2500.json", 900),
    ):
        stdout_path = logs_root / f"{output_name[:-5]}.stdout.log"
        stderr_path = logs_root / f"{output_name[:-5]}.stderr.log"
        suite_root = repo_root / suite
        env = dict(base_env)
        env["PYTHONPATH"] = os.pathsep.join([str(suite_root), str(suite_root / "tests")])
        outcome = _subprocess_outcome(
            [sys.executable, "-c", _python_range_snippet(suite)],
            cwd=repo_root,
            env=env,
            timeout_seconds=timeout_seconds,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
        )
        output_path = ranges_root / output_name
        if outcome["status"] == "PASS":
            try:
                _parse_json_stdout(stdout_path, output_path)
            except Exception as exc:
                outcome["status"] = "FAIL"
                outcome["reason"] = f"MALFORMED_RUNTIME_OUTPUT:{type(exc).__name__}:{exc}"
        outcome.update({"range": label, "evidence_file": str(output_path.relative_to(evidence_root))})
        outcomes.append(outcome)

    _write_json(
        evidence_root / "execution-outcomes.json",
        {
            "schema_version": SCHEMA_VERSION,
            "source_revision": source_revision,
            "source_tree": source_tree,
            "outcomes": outcomes,
        },
    )
    return outcomes


def _receipt_from_m200(
    raw: Mapping[str, Any], module_id: str, source_revision: str
) -> tuple[dict[str, Any] | None, str, str]:
    receipts = raw.get("receipts")
    if not isinstance(receipts, Mapping):
        return None, STATUS_BLOCKED, "MISSING_RECEIPTS_MAP"
    receipt = receipts.get(module_id)
    if not isinstance(receipt, Mapping):
        return None, STATUS_BLOCKED, "MISSING_RECEIPT"
    if receipt.get("error") not in {None, ""}:
        return dict(receipt), STATUS_FAILED, f"JOB_ERROR:{receipt.get('error')}"
    evidence = receipt.get("evidence")
    if not isinstance(evidence, Mapping):
        return dict(receipt), STATUS_BLOCKED, "MISSING_CONTRACT_EVIDENCE"
    if evidence.get("source_revision") != source_revision:
        return dict(receipt), STATUS_BLOCKED, "SOURCE_REVISION_MISMATCH"
    try:
        expected_number = int(module_id[1:])
    except ValueError:
        return dict(receipt), STATUS_BLOCKED, "INVALID_MODULE_ID"
    if evidence.get("module_id") != expected_number or receipt.get("module_id") != expected_number:
        return dict(receipt), STATUS_BLOCKED, "MODULE_ID_MISMATCH"
    execution = str(evidence.get("execution", "")).upper()
    state = str(evidence.get("state", "")).upper()
    if execution in {"SKIP", "SKIPPED", "NOT_TESTED"} or state in {
        "SKIP",
        "SKIPPED",
        "NOT_TESTED",
    }:
        return dict(receipt), STATUS_NOT_TESTED, "SKIP_REPORTED"
    if not isinstance(evidence.get("evidence_hash"), str) or SHA256_RE.fullmatch(
        str(evidence.get("evidence_hash"))
    ) is None:
        return dict(receipt), STATUS_BLOCKED, "INVALID_EVIDENCE_HASH"
    if not isinstance(receipt.get("output_hash"), str) or SHA256_RE.fullmatch(
        str(receipt.get("output_hash"))
    ) is None:
        return dict(receipt), STATUS_BLOCKED, "INVALID_OUTPUT_HASH"
    return dict(receipt), STATUS_EXECUTED, "CONTRACT_EVALUATED"


def _build_module_records(
    evidence_root: Path,
    source_revision: str,
    source_tree: str,
    outcomes: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    outcome_by_range = {item["range"]: item for item in outcomes}
    records: list[dict[str, Any]] = []
    errors: list[str] = []
    for label, first, last, runtime in RANGE_SPECS:
        outcome = outcome_by_range.get(label)
        if outcome is None:
            errors.append(f"missing_outcome:{label}")
            for number in range(first, last + 1):
                records.append(
                    {
                        "module_id": _safe_module_id(number),
                        "range": label,
                        "runtime": runtime,
                        "status": STATUS_NOT_TESTED,
                        "reason": "RANGE_NOT_RUN",
                        "native_execution_status": None,
                        "finding_status": "UNREPORTED",
                        "source_revision": source_revision,
                        "source_tree": source_tree,
                        "receipt_sha256": None,
                        "evidence_hash": None,
                    }
                )
            continue
        evidence_file = evidence_root / str(outcome["evidence_file"])
        if outcome.get("status") != "PASS" or not evidence_file.is_file():
            range_status = STATUS_NOT_TESTED if outcome.get("status") == "NOT_TESTED" else STATUS_BLOCKED
            reason = str(outcome.get("reason", "RANGE_EXECUTION_FAILED"))
            for number in range(first, last + 1):
                records.append(
                    {
                        "module_id": _safe_module_id(number),
                        "range": label,
                        "runtime": runtime,
                        "status": range_status,
                        "reason": reason,
                        "native_execution_status": None,
                        "finding_status": "UNREPORTED",
                        "source_revision": source_revision,
                        "source_tree": source_tree,
                        "receipt_sha256": None,
                        "evidence_hash": None,
                    }
                )
            continue
        try:
            raw = _load_json(evidence_file)
        except Exception as exc:
            errors.append(f"corrupt_range_evidence:{label}:{type(exc).__name__}")
            raw = {}
        raw_receipts = raw.get("receipts") if isinstance(raw, Mapping) else None
        if not isinstance(raw_receipts, Mapping):
            raw_receipts = {}
        expected_count = last - first + 1
        declared_count = raw.get("receipt_count") if isinstance(raw, Mapping) else None
        if declared_count != expected_count:
            errors.append(f"range_cardinality_mismatch:{label}:{declared_count}:{expected_count}")
        if len(raw_receipts) != expected_count:
            errors.append(
                f"range_receipt_map_cardinality_mismatch:{label}:{len(raw_receipts)}:{expected_count}"
            )
        for number in range(first, last + 1):
            module_id = _safe_module_id(number)
            receipt: dict[str, Any] | None
            status: str
            reason: str
            native_execution_status: str | None = None
            finding_status = "UNREPORTED"
            if first == 1:
                receipt, status, reason = _receipt_from_m200(raw, module_id, source_revision)
                if receipt is not None:
                    native_execution_status = "CONTRACT_EVALUATED"
            else:
                value = raw_receipts.get(module_id)
                if not isinstance(value, Mapping):
                    receipt, status, reason = None, STATUS_BLOCKED, "MISSING_RECEIPT"
                else:
                    receipt = dict(value)
                    native_execution_status = str(
                        receipt.get("execution_status", receipt.get("status", ""))
                    ).upper() or None
                    finding_status = str(receipt.get("finding_status", "UNREPORTED")).upper()
                    status, reason = _normalize_execution_status(receipt)
            receipt_sha = _sha256_value(receipt) if receipt is not None else None
            evidence_hash = receipt.get("evidence_hash") if receipt is not None else None
            if first == 1 and receipt is not None and isinstance(receipt.get("evidence"), Mapping):
                evidence_hash = receipt["evidence"].get("evidence_hash")
            if receipt is not None and (
                not isinstance(evidence_hash, str) or SHA256_RE.fullmatch(evidence_hash) is None
            ):
                status = STATUS_BLOCKED
                reason = "INVALID_EVIDENCE_HASH"
            records.append(
                {
                    "module_id": module_id,
                    "range": label,
                    "runtime": runtime,
                    "status": status,
                    "reason": reason,
                    "native_execution_status": native_execution_status,
                    "finding_status": finding_status,
                    "source_revision": source_revision,
                    "source_tree": source_tree,
                    "receipt_sha256": receipt_sha,
                    "evidence_hash": evidence_hash,
                    "receipt_file": str(evidence_file.relative_to(evidence_root)),
                }
            )
    return records, errors


def _finding_counts(modules: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in modules:
        value = str(item.get("finding_status", "UNREPORTED")).upper()
        counts[value] = counts.get(value, 0) + 1
    return {key: counts[key] for key in sorted(counts)}


def validate_proof_document(proof: Mapping[str, Any], evidence_root: Path) -> list[str]:
    errors: list[str] = []
    if proof.get("schema_version") != SCHEMA_VERSION:
        errors.append("unsupported_schema_version")
    source_revision = proof.get("source_revision")
    source_tree = proof.get("source_tree")
    if not isinstance(source_revision, str) or GIT_SHA_RE.fullmatch(source_revision) is None:
        errors.append("invalid_source_revision")
    if not isinstance(source_tree, str) or GIT_SHA_RE.fullmatch(source_tree) is None:
        errors.append("invalid_source_tree")
    modules = proof.get("modules")
    if not isinstance(modules, list):
        return errors + ["modules_not_list"]
    if len(modules) != 2500:
        errors.append(f"cardinality_not_2500:{len(modules)}")
    seen: set[str] = set()
    duplicates: set[str] = set()
    for item in modules:
        if not isinstance(item, Mapping):
            errors.append("module_record_not_object")
            continue
        module_id = item.get("module_id")
        if not isinstance(module_id, str):
            errors.append("module_id_missing")
            continue
        if module_id in seen:
            duplicates.add(module_id)
        seen.add(module_id)
        if item.get("status") not in VALID_STATUSES:
            errors.append(f"invalid_status:{module_id}")
        if item.get("source_revision") != source_revision or item.get("source_tree") != source_tree:
            errors.append(f"source_binding_mismatch:{module_id}")
        receipt_sha = item.get("receipt_sha256")
        if item.get("status") == STATUS_EXECUTED:
            if not isinstance(receipt_sha, str) or SHA256_RE.fullmatch(receipt_sha) is None:
                errors.append(f"invalid_receipt_sha:{module_id}")
            evidence_hash = item.get("evidence_hash")
            if not isinstance(evidence_hash, str) or SHA256_RE.fullmatch(evidence_hash) is None:
                errors.append(f"invalid_evidence_hash:{module_id}")
            receipt_file = item.get("receipt_file")
            if not isinstance(receipt_file, str):
                errors.append(f"missing_receipt_file:{module_id}")
            else:
                path = (evidence_root / receipt_file).resolve()
                if not _inside(path, evidence_root) or not path.is_file():
                    errors.append(f"missing_receipt_container:{module_id}")
    if duplicates:
        errors.append("duplicate_modules:" + ",".join(sorted(duplicates)))
    missing = EXPECTED_SET - seen
    extra = seen - EXPECTED_SET
    if missing:
        errors.append(f"missing_modules:{len(missing)}")
    if extra:
        errors.append(f"unexpected_modules:{len(extra)}")
    receipt_shas = [
        item.get("receipt_sha256")
        for item in modules
        if isinstance(item, Mapping) and item.get("status") == STATUS_EXECUTED
    ]
    valid_receipt_shas = [
        value for value in receipt_shas if isinstance(value, str) and SHA256_RE.fullmatch(value)
    ]
    if len(valid_receipt_shas) != len(set(valid_receipt_shas)):
        errors.append("duplicate_receipt_hash")
    counts = {status: 0 for status in VALID_STATUSES}
    for item in modules:
        if isinstance(item, Mapping) and item.get("status") in counts:
            counts[str(item["status"])] += 1
    if proof.get("counts") != counts:
        errors.append("count_summary_mismatch")
    comparable_modules = [dict(item) for item in modules if isinstance(item, Mapping)]
    if proof.get("finding_counts") != _finding_counts(comparable_modules):
        errors.append("finding_count_summary_mismatch")
    return errors


def _validate_claim(proof: Mapping[str, Any], base_errors: list[str]) -> list[str]:
    counts = proof.get("counts")
    expected = (
        not base_errors
        and isinstance(counts, Mapping)
        and counts.get(STATUS_EXECUTED) == 2500
        and counts.get(STATUS_FAILED) == 0
        and counts.get(STATUS_BLOCKED) == 0
        and counts.get(STATUS_NOT_TESTED) == 0
    )
    return [] if proof.get("full_execution_claim") is expected else ["claim_derivation_mismatch"]


def _validate_range_containers(proof: Mapping[str, Any], evidence_root: Path) -> list[str]:
    errors: list[str] = []
    expected_by_path: dict[str, tuple[int, int]] = {}
    for item in proof.get("modules", []):
        if not isinstance(item, Mapping):
            continue
        receipt_file = item.get("receipt_file")
        module_id = item.get("module_id")
        if not isinstance(receipt_file, str) or not isinstance(module_id, str):
            continue
        try:
            number = int(module_id[1:])
        except (TypeError, ValueError):
            continue
        for _, first, last, _ in RANGE_SPECS:
            if first <= number <= last:
                expected_by_path[receipt_file] = (first, last)
                break
    for receipt_file, (first, last) in expected_by_path.items():
        path = (evidence_root / receipt_file).resolve()
        if not _inside(path, evidence_root) or not path.is_file():
            errors.append(f"missing_receipt_container:{receipt_file}")
            continue
        try:
            raw = _load_json(path)
        except Exception:
            errors.append(f"corrupt_receipt_container:{receipt_file}")
            continue
        if not isinstance(raw, Mapping):
            errors.append(f"receipt_container_not_object:{receipt_file}")
            continue
        receipts = raw.get("receipts")
        if not isinstance(receipts, Mapping):
            errors.append(f"receipt_map_missing:{receipt_file}")
            continue
        expected_ids = {_safe_module_id(i) for i in range(first, last + 1)}
        actual_ids = set(receipts)
        if actual_ids != expected_ids:
            errors.append(
                f"receipt_container_range_mismatch:{receipt_file}:"
                f"missing={len(expected_ids-actual_ids)}:extra={len(actual_ids-expected_ids)}"
            )
        expected_count = last - first + 1
        if raw.get("receipt_count") != expected_count:
            errors.append(f"receipt_container_cardinality_mismatch:{receipt_file}")
        if first == 1 and raw.get("source_revision") != proof.get("source_revision"):
            errors.append(f"receipt_container_source_mismatch:{receipt_file}")
        if first == 1001:
            if raw.get("first_module") != "M1001" or raw.get("last_module") != "M2500":
                errors.append(f"sidecar_range_metadata_mismatch:{receipt_file}")
            execution_hash = raw.get("execution_hash")
            if not isinstance(execution_hash, str) or SHA256_RE.fullmatch(execution_hash) is None:
                errors.append(f"sidecar_execution_hash_invalid:{receipt_file}")
            terminal_hash = raw.get("terminal_evidence_hash")
            terminal = receipts.get("M2500")
            expected_terminal_hash = terminal.get("evidence_hash") if isinstance(terminal, Mapping) else None
            if (
                terminal_hash != expected_terminal_hash
                or not isinstance(terminal_hash, str)
                or SHA256_RE.fullmatch(terminal_hash) is None
            ):
                errors.append(f"sidecar_terminal_hash_mismatch:{receipt_file}")
    return errors


def _validate_terminal_safety(proof: Mapping[str, Any], evidence_root: Path) -> list[str]:
    errors: list[str] = []
    modules = proof.get("modules")
    if not isinstance(modules, list):
        return ["terminal_safety_modules_not_list"]
    m2500 = next(
        (item for item in modules if isinstance(item, Mapping) and item.get("module_id") == "M2500"),
        None,
    )
    if not isinstance(m2500, Mapping):
        return ["terminal_safety_m2500_missing"]
    receipt_file = m2500.get("receipt_file")
    if not isinstance(receipt_file, str):
        return ["terminal_safety_receipt_file_missing"]
    path = (evidence_root / receipt_file).resolve()
    if not _inside(path, evidence_root) or not path.is_file():
        return ["terminal_safety_receipt_container_missing"]
    try:
        raw = _load_json(path)
    except Exception:
        return ["terminal_safety_receipt_container_corrupt"]
    receipts = raw.get("receipts") if isinstance(raw, Mapping) else None
    if not isinstance(receipts, Mapping):
        return ["terminal_safety_receipts_missing"]
    for module_id in TERMINAL_SAFETY_MODULES:
        receipt = receipts.get(module_id)
        if not isinstance(receipt, Mapping):
            errors.append(f"terminal_safety_receipt_missing:{module_id}")
            continue
        if receipt.get("execution_status") != "SUCCESS":
            errors.append(f"terminal_safety_execution_not_success:{module_id}")
        if receipt.get("finding_status") != "NO_FINDING":
            errors.append(f"terminal_safety_finding:{module_id}")
        if receipt.get("action_mode") != "OBSERVE_ONLY":
            errors.append(f"terminal_safety_action_mode:{module_id}")
        if receipt.get("policy_status") != "SAFE_WHITE_HAT":
            errors.append(f"terminal_safety_policy_status:{module_id}")
    terminal = receipts.get("M2500")
    output = terminal.get("output") if isinstance(terminal, Mapping) else None
    if not isinstance(output, Mapping):
        errors.append("terminal_safety_m2500_output_missing")
    else:
        for key in ("release_safe", "strict_white_hat_only", "no_google_scraping", "observe_only"):
            if output.get(key) is not True:
                errors.append(f"terminal_safety_m2500_{key}_not_true")
    return errors


def _validate_verifier_gates(proof: Mapping[str, Any], evidence_root: Path) -> list[str]:
    errors: list[str] = []
    gates = proof.get("verifier_gates")
    if not isinstance(gates, list):
        return ["verifier_gates_not_list"]
    expected_names = {"CHAINED_VERIFIER_M201_M2500", "ORIGINAL_VERIFIER_M001_M200"}
    names = {str(item.get("name")) for item in gates if isinstance(item, Mapping)}
    if len(gates) != 2 or names != expected_names:
        errors.append("verifier_gate_set_mismatch")
    for item in gates:
        if not isinstance(item, Mapping):
            errors.append("verifier_gate_not_object")
            continue
        name = str(item.get("name", "UNKNOWN"))
        if item.get("status") != "PASS" or item.get("exit_code") != 0 or item.get("skip_detected") is not False:
            errors.append(f"verifier_gate_not_pass:{name}")
        for stream in ("stdout", "stderr"):
            rel = item.get(f"{stream}_file")
            expected_hash = item.get(f"{stream}_sha256")
            if (
                not isinstance(rel, str)
                or not isinstance(expected_hash, str)
                or SHA256_RE.fullmatch(expected_hash) is None
            ):
                errors.append(f"invalid_verifier_gate_evidence:{name}:{stream}")
                continue
            path = (evidence_root / rel).resolve()
            if not _inside(path, evidence_root) or not path.is_file():
                errors.append(f"missing_verifier_gate_evidence:{name}:{stream}")
                continue
            if _sha256_file(path) != expected_hash:
                errors.append(f"verifier_gate_evidence_hash_mismatch:{name}:{stream}")
    return errors


def _validate_raw_receipt_hashes(proof: Mapping[str, Any], evidence_root: Path) -> list[str]:
    errors: list[str] = []
    cache: dict[Path, Mapping[str, Any]] = {}
    for item in proof.get("modules", []):
        if not isinstance(item, Mapping) or item.get("status") != STATUS_EXECUTED:
            continue
        module_id = str(item.get("module_id"))
        receipt_file = item.get("receipt_file")
        if not isinstance(receipt_file, str):
            continue
        path = (evidence_root / receipt_file).resolve()
        if path not in cache:
            try:
                loaded = _load_json(path)
                cache[path] = loaded if isinstance(loaded, Mapping) else {}
            except Exception:
                errors.append(f"corrupt_receipt_container:{module_id}")
                continue
        raw_receipts = cache[path].get("receipts")
        if not isinstance(raw_receipts, Mapping):
            errors.append(f"receipt_map_missing:{module_id}")
            continue
        raw_receipt = raw_receipts.get(module_id)
        if not isinstance(raw_receipt, Mapping):
            errors.append(f"receipt_missing:{module_id}")
            continue
        if _sha256_value(raw_receipt) != item.get("receipt_sha256"):
            errors.append(f"receipt_hash_mismatch:{module_id}")
    return errors


def _build_and_write_proof(
    evidence_root: Path,
    source_revision: str,
    source_tree: str,
    outcomes: list[dict[str, Any]],
    verifier_gates: list[dict[str, Any]],
    gate_errors: list[str],
) -> tuple[dict[str, Any], list[str]]:
    modules, collection_errors = _build_module_records(evidence_root, source_revision, source_tree, outcomes)
    counts = {status: sum(item["status"] == status for item in modules) for status in VALID_STATUSES}
    finding_counts = _finding_counts(modules)
    draft = {
        "schema_version": SCHEMA_VERSION,
        "workload": "seo-avengers-2500",
        "environment": "CONTROLLED_TEST_FIXTURES",
        "source_revision": source_revision,
        "source_tree": source_tree,
        "expected_module_count": 2500,
        "expected_unique_module_count": 2500,
        "verifier_gates": verifier_gates,
        "counts": counts,
        "finding_counts": finding_counts,
        "full_execution_claim": False,
        "modules": modules,
    }
    base_errors = (
        gate_errors
        + collection_errors
        + validate_proof_document(draft, evidence_root)
        + _validate_verifier_gates(draft, evidence_root)
        + _validate_range_containers(draft, evidence_root)
        + _validate_terminal_safety(draft, evidence_root)
        + _validate_raw_receipt_hashes(draft, evidence_root)
    )
    draft["full_execution_claim"] = (
        not base_errors
        and counts[STATUS_EXECUTED] == 2500
        and counts[STATUS_FAILED] == 0
        and counts[STATUS_BLOCKED] == 0
        and counts[STATUS_NOT_TESTED] == 0
    )
    final_errors = base_errors + _validate_claim(draft, base_errors)
    draft["validation_errors"] = final_errors
    _write_json(evidence_root / "proof.json", draft)
    summary = {
        "schema_version": SCHEMA_VERSION,
        "workload": draft["workload"],
        "environment": draft["environment"],
        "source_revision": source_revision,
        "source_tree": source_tree,
        "counts": counts,
        "finding_counts": finding_counts,
        "full_execution_claim": draft["full_execution_claim"],
        "validation_errors": final_errors,
        "proof_sha256": _sha256_file(evidence_root / "proof.json"),
    }
    _write_json(evidence_root / "proof-summary.json", summary)
    return draft, final_errors


def _write_manifest(evidence_root: Path) -> str:
    entries: list[str] = []
    for path in sorted(
        p for p in evidence_root.rglob("*") if p.is_file() and p.name != "evidence-manifest.sha256"
    ):
        rel = path.relative_to(evidence_root).as_posix()
        entries.append(f"{_sha256_file(path).removeprefix('sha256:')}  {rel}")
    manifest_path = evidence_root / "evidence-manifest.sha256"
    manifest_path.write_text("\n".join(entries) + "\n", encoding="utf-8")
    return _sha256_file(manifest_path)


def _print_result(proof: Mapping[str, Any], proof_sha: str, manifest_sha: str) -> None:
    counts = proof["counts"]
    finding_counts = proof["finding_counts"]
    print("WALLE_ENGINE=WALLE")
    print("WALLE_WORKLOAD=seo-avengers-2500")
    print(f"WALLE_SOURCE_HEAD={proof['source_revision']}")
    print(f"WALLE_SOURCE_TREE={proof['source_tree']}")
    print("WALLE_MODULE_EXPECTED=2500")
    print(f"WALLE_MODULE_EXECUTED={counts[STATUS_EXECUTED]}")
    print(f"WALLE_MODULE_FAILED={counts[STATUS_FAILED]}")
    print(f"WALLE_MODULE_BLOCKED={counts[STATUS_BLOCKED]}")
    print(f"WALLE_MODULE_NOT_TESTED={counts[STATUS_NOT_TESTED]}")
    print(f"WALLE_MODULE_FINDINGS={finding_counts.get('FINDING', 0)}")
    print(f"WALLE_MODULE_NO_FINDING={finding_counts.get('NO_FINDING', 0)}")
    print(f"WALLE_MODULE_NOT_APPLICABLE={finding_counts.get('NOT_APPLICABLE', 0)}")
    print(f"WALLE_PROOF_SHA256={proof_sha}")
    print(f"WALLE_EVIDENCE_MANIFEST_SHA256={manifest_sha}")
    print(f"WALLE_FULL_EXECUTION_CLAIM={'true' if proof['full_execution_claim'] else 'false'}")


def execute_command(args: argparse.Namespace) -> int:
    repo_root = Path(args.repo_root).resolve()
    evidence_root = Path(args.evidence_root).resolve()
    if _inside(evidence_root, repo_root):
        print("WALLE_AVENGERS_ERROR=evidence_root_inside_source_tree", file=sys.stderr)
        return 2
    if not GIT_SHA_RE.fullmatch(args.source_revision) or not GIT_SHA_RE.fullmatch(args.source_tree):
        print("WALLE_AVENGERS_ERROR=invalid_source_identity", file=sys.stderr)
        return 2
    evidence_root.mkdir(parents=True, exist_ok=False)
    verifier_gates, gate_errors = _collect_verifier_gates(
        Path(args.gate_evidence).resolve(), evidence_root, args.source_revision, args.source_tree
    )
    outcomes = _execute_evidence_collection(repo_root, args.source_revision, args.source_tree, evidence_root)
    proof, errors = _build_and_write_proof(
        evidence_root,
        args.source_revision,
        args.source_tree,
        outcomes,
        verifier_gates,
        gate_errors,
    )
    proof_sha = _sha256_file(evidence_root / "proof.json")
    manifest_sha = _write_manifest(evidence_root)
    _print_result(proof, proof_sha, manifest_sha)
    if errors:
        print("WALLE_FULL_EXECUTION_ERRORS=" + json.dumps(errors, separators=(",", ":")), file=sys.stderr)
    return 0 if proof["full_execution_claim"] else 2


def validate_command(args: argparse.Namespace) -> int:
    evidence_root = Path(args.evidence_root).resolve()
    proof_path = Path(args.proof).resolve()
    try:
        proof = _load_json(proof_path)
    except Exception as exc:
        print(f"invalid proof: {type(exc).__name__}:{exc}", file=sys.stderr)
        return 2
    base_errors = (
        validate_proof_document(proof, evidence_root)
        + _validate_verifier_gates(proof, evidence_root)
        + _validate_range_containers(proof, evidence_root)
        + _validate_terminal_safety(proof, evidence_root)
        + _validate_raw_receipt_hashes(proof, evidence_root)
    )
    errors = base_errors + _validate_claim(proof, base_errors)
    if errors:
        print(json.dumps(errors, separators=(",", ":")), file=sys.stderr)
        return 2
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Walle SEO Avengers 2500 execution proof")
    subparsers = parser.add_subparsers(dest="command", required=True)
    execute = subparsers.add_parser("execute")
    execute.add_argument("--repo-root", required=True)
    execute.add_argument("--source-revision", required=True)
    execute.add_argument("--source-tree", required=True)
    execute.add_argument("--evidence-root", required=True)
    execute.add_argument("--gate-evidence", required=True)
    execute.set_defaults(func=execute_command)
    validate = subparsers.add_parser("validate")
    validate.add_argument("--proof", required=True)
    validate.add_argument("--evidence-root", required=True)
    validate.set_defaults(func=validate_command)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
