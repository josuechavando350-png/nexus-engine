from __future__ import annotations

import re
from typing import Any, Mapping

from .common import PPM, InvalidData, InsufficientData, hash_value

_SHA_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_ALLOWED_EXEC = {"SUCCESS", "INSUFFICIENT_DATA", "ERROR"}
_ALLOWED_FINDING = {"FINDING", "NO_FINDING", "NOT_APPLICABLE"}
_EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"
_RUNTIME_FALSE_FIELDS = (
    "new_external_api_required",
    "new_database_required",
    "new_queue_required",
    "new_secret_required",
    "new_cloud_resource_required",
    "new_daemon_required",
)

def _recompute_receipt(receipt: Mapping[str, Any]) -> bool:
    evidence_hash = receipt.get("evidence_hash")
    if not isinstance(evidence_hash, str) or not _SHA_RE.fullmatch(evidence_hash):
        return False
    body = dict(receipt)
    body.pop("evidence_hash", None)
    return hash_value(body) == evidence_hash

def _walk_strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for key, child in value.items():
            yield str(key)
            yield from _walk_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_strings(child)

def _range_from_spec(spec: Mapping[str, Any]) -> tuple[int, int, str]:
    params = spec.get("params")
    if not isinstance(params, Mapping):
        raise InvalidData("extended_release_params_missing")
    start = params.get("current_start")
    end = params.get("current_end")
    predecessor = params.get("predecessor_module")
    if isinstance(start, bool) or not isinstance(start, int):
        raise InvalidData("extended_release_current_start_invalid")
    if isinstance(end, bool) or not isinstance(end, int) or end < start:
        raise InvalidData("extended_release_current_end_invalid")
    if not isinstance(predecessor, str) or not predecessor:
        raise InvalidData("extended_release_predecessor_invalid")
    return start, end, predecessor

def _current_receipts(spec: Mapping[str, Any], prior_receipts: Mapping[str, Mapping[str, Any]]):
    start, end, _ = _range_from_spec(spec)
    expected = tuple(f"M{i}" for i in range(start, end + 1))
    missing = [module for module in expected if module not in prior_receipts]
    if missing:
        raise InsufficientData("extended_release_current_receipts_missing:" + ",".join(missing[:10]))
    return [(module, prior_receipts[module]) for module in expected]

def extended_release_guard(spec, normalized, config, prior_receipts):
    if prior_receipts is None:
        raise InsufficientData("extended_release_prior_receipts_missing")
    params = spec.get("params")
    if not isinstance(params, Mapping):
        raise InvalidData("extended_release_params_missing")
    mode = params.get("mode")
    start, end, predecessor_module = _range_from_spec(spec)
    current = _current_receipts(spec, prior_receipts)

    if mode == "predecessor_safe":
        receipt = prior_receipts.get(predecessor_module)
        if receipt is None:
            raise InsufficientData(f"{predecessor_module}_receipt_missing")
        safe = (
            _recompute_receipt(receipt)
            and receipt.get("execution_status") == "SUCCESS"
            and receipt.get("finding_status") == "NO_FINDING"
            and receipt.get("output", {}).get("release_safe") is True
        )
        return PPM if safe else 0, not safe, {
            "predecessor_module": predecessor_module,
            "predecessor_release_safe": safe,
            "predecessor_evidence_hash": receipt.get("evidence_hash"),
        }

    if mode == "current_hash_integrity":
        invalid = [module for module, receipt in current if not _recompute_receipt(receipt)]
        return PPM if not invalid else 0, bool(invalid), {
            "checked_receipt_count": len(current),
            "invalid_receipt_modules": invalid,
        }

    if mode == "current_execution_success":
        invalid_domain = []
        non_success = []
        for module, receipt in current:
            execution = receipt.get("execution_status")
            finding = receipt.get("finding_status")
            if execution not in _ALLOWED_EXEC or finding not in _ALLOWED_FINDING:
                invalid_domain.append(module)
            if execution != "SUCCESS":
                non_success.append({
                    "module": module,
                    "execution_status": execution,
                    "reason_code": receipt.get("reason_code"),
                })
        violation = bool(invalid_domain or non_success)
        return PPM if not violation else 0, violation, {
            "invalid_status_domain_modules": invalid_domain,
            "non_success_receipts": non_success,
        }

    if mode == "policy_action_metadata":
        invalid = [
            module for module, receipt in current
            if receipt.get("policy_status") != "SAFE_WHITE_HAT"
            or receipt.get("action_mode") != "OBSERVE_ONLY"
        ]
        return PPM if not invalid else 0, bool(invalid), {
            "invalid_policy_or_action_modules": invalid,
            "required_policy_status": "SAFE_WHITE_HAT",
            "required_action_mode": "OBSERVE_ONLY",
        }

    if mode == "forbidden_claims":
        forbidden_fragments = (
            "guaranteed_rank", "guaranteed ranking", "rank guarantee",
            "guaranteed_index", "guaranteed index", "guaranteed_crawl", "guaranteed crawl",
            "ban_proof", "penalty_proof", "manipulate_google", "google manipulation",
            "definitely_unindexed", "indexed_true", "indexed_false", "is_indexed",
            "doorway_generation_enabled", "link_scheme_enabled", "cloaking_enabled",
        )
        findings = []
        for module, receipt in current:
            for text in _walk_strings(receipt.get("output", {})):
                folded = text.casefold().replace("-", "_")
                if any(fragment in folded for fragment in forbidden_fragments):
                    findings.append({"module": module, "claim": text})
        return PPM if not findings else 0, bool(findings), {"forbidden_claims": findings}

    if mode == "zero_new_infrastructure":
        violations = []
        for module, receipt in current:
            output = receipt.get("output", {})
            contract = output.get("runtime_contract", {}) if isinstance(output, Mapping) else {}
            bad = [field for field in _RUNTIME_FALSE_FIELDS if contract.get(field) is not False]
            if bad:
                violations.append({"module": module, "invalid_fields": bad})
        return PPM if not violations else 0, bool(violations), {
            "checked_receipt_count": len(current),
            "infrastructure_contract_violations": violations,
        }

    if mode == "source_mapping_integrity":
        invalid = []
        for module, receipt in current:
            number = int(module[1:])
            expected_source = f"M{number + 1000}"
            if receipt.get("source_module") != expected_source:
                invalid.append({
                    "module": module,
                    "source_module": receipt.get("source_module"),
                    "expected_source_module": expected_source,
                })
        return PPM if not invalid else 0, bool(invalid), {"source_mapping_violations": invalid}

    if mode == "algorithm_uniqueness":
        algorithms = []
        operations = []
        malformed = []
        for module, receipt in current:
            algorithm = receipt.get("algorithm")
            operation = receipt.get("operation")
            if not isinstance(algorithm, str) or not algorithm.startswith(f"avengers2500_v1_{module.lower()}_"):
                malformed.append(module)
            else:
                algorithms.append(algorithm)
            if isinstance(operation, str) and operation:
                operations.append(operation)
            else:
                malformed.append(module)
        duplicate_algorithms = sorted({value for value in algorithms if algorithms.count(value) > 1})
        duplicate_operations = sorted({value for value in operations if operations.count(value) > 1})
        violation = bool(malformed or duplicate_algorithms or duplicate_operations)
        return PPM if not violation else 0, violation, {
            "malformed_algorithm_modules": sorted(set(malformed)),
            "duplicate_algorithms": duplicate_algorithms,
            "duplicate_operations": duplicate_operations,
            "checked_receipt_count": len(current),
        }

    if mode == "existing_contract_only":
        invalid = []
        for module, receipt in current:
            output = receipt.get("output", {})
            if not isinstance(output, Mapping) or output.get("evidence_contract") != _EVIDENCE_CONTRACT:
                invalid.append(module)
        return PPM if not invalid else 0, bool(invalid), {
            "checked_receipt_count": len(current),
            "invalid_evidence_contract_modules": invalid,
            "required_evidence_contract": _EVIDENCE_CONTRACT,
            "certified_current_range": [f"M{start}", f"M{end}"],
        }

    raise InvalidData(f"unsupported_extended_release_guard_mode:{mode}")

def extended_release_gate(spec, normalized, config, prior_receipts):
    if prior_receipts is None:
        raise InvalidData("extended_release_gate_prior_receipts_required")
    params = spec.get("params")
    if not isinstance(params, Mapping):
        raise InvalidData("extended_release_gate_params_missing")
    predecessor = params.get("predecessor_module")
    guard_start = params.get("guard_start")
    guard_end = params.get("guard_end")
    certified_start = params.get("certified_start")
    certified_end = params.get("certified_end")
    if not isinstance(predecessor, str) or not predecessor:
        raise InvalidData("extended_release_gate_predecessor_invalid")
    if isinstance(guard_start, bool) or not isinstance(guard_start, int):
        raise InvalidData("extended_release_gate_guard_start_invalid")
    if isinstance(guard_end, bool) or not isinstance(guard_end, int) or guard_end < guard_start:
        raise InvalidData("extended_release_gate_guard_end_invalid")
    if not isinstance(certified_start, str) or not isinstance(certified_end, str):
        raise InvalidData("extended_release_gate_certified_range_invalid")
    expected = (predecessor,) + tuple(f"M{i}" for i in range(guard_start, guard_end + 1))
    if tuple(prior_receipts) != expected:
        raise InvalidData("extended_release_gate_prior_receipt_range_drift")
    blocking = []
    hashes = []
    for module in expected:
        receipt = prior_receipts[module]
        if not _recompute_receipt(receipt):
            blocking.append({"module": module, "reason": "EVIDENCE_HASH_INVALID_OR_MISMATCH"})
            continue
        hashes.append(f"{module}:{receipt['evidence_hash']}")
        if receipt.get("execution_status") != "SUCCESS":
            blocking.append({"module": module, "reason": "EXECUTION_NOT_SUCCESS"})
        if receipt.get("finding_status") == "FINDING":
            blocking.append({"module": module, "reason": str(receipt.get("reason_code"))})
    return PPM if not blocking else 0, bool(blocking), {
        "checked_receipt_count": len(expected),
        "blocking_findings": blocking,
        "release_safe": not blocking,
        "prior_receipt_hashes_hash": hash_value(hashes),
        "certified_local_range": [certified_start, certified_end],
        "policy_status": "STRICT_WHITE_HAT_ONLY",
    }
