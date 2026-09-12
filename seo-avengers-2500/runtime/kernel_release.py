from __future__ import annotations

import re
from typing import Any, Mapping

from .common import PPM, InvalidData, InsufficientData, hash_value

_SHA_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_ALLOWED_EXEC = {"SUCCESS", "INSUFFICIENT_DATA", "ERROR"}
_ALLOWED_FINDING = {"FINDING", "NO_FINDING", "NOT_APPLICABLE"}

def _recompute_receipt(receipt: Mapping[str, Any]) -> bool:
    evidence_hash = receipt.get("evidence_hash")
    if not isinstance(evidence_hash, str) or not _SHA_RE.fullmatch(evidence_hash):
        return False
    body = dict(receipt)
    body.pop("evidence_hash", None)
    return hash_value(body) == evidence_hash

def _current_receipts(prior_receipts: Mapping[str, Mapping[str, Any]]) -> list[tuple[str, Mapping[str, Any]]]:
    expected = tuple(f"M{i}" for i in range(1401, 1591))
    missing = [module for module in expected if module not in prior_receipts]
    if missing:
        raise InsufficientData("growth_release_current_receipts_missing:" + ",".join(missing[:10]))
    return [(module, prior_receipts[module]) for module in expected]

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

def growth_release_guard(spec, normalized, config, prior_receipts):
    if prior_receipts is None:
        raise InsufficientData("growth_release_prior_receipts_missing")
    mode = spec["params"]["mode"]
    current = _current_receipts(prior_receipts)

    if mode == "m1400_safe":
        receipt = prior_receipts.get("M1400")
        if receipt is None:
            raise InsufficientData("M1400_receipt_missing")
        safe = (
            _recompute_receipt(receipt)
            and receipt.get("execution_status") == "SUCCESS"
            and receipt.get("finding_status") == "NO_FINDING"
            and receipt.get("output", {}).get("release_safe") is True
        )
        return PPM if safe else 0, not safe, {"m1400_release_safe": safe, "m1400_evidence_hash": receipt.get("evidence_hash")}

    if mode == "current_hash_integrity":
        invalid = [module for module, receipt in current if not _recompute_receipt(receipt)]
        return PPM if not invalid else 0, bool(invalid), {"checked_receipt_count": len(current), "invalid_receipt_modules": invalid}

    if mode == "current_execution_integrity":
        invalid_domain = []
        non_success = []
        for module, receipt in current:
            if receipt.get("execution_status") not in _ALLOWED_EXEC or receipt.get("finding_status") not in _ALLOWED_FINDING:
                invalid_domain.append(module)
            if receipt.get("execution_status") != "SUCCESS":
                non_success.append({"module": module, "execution_status": receipt.get("execution_status"), "reason_code": receipt.get("reason_code")})
        violation = bool(invalid_domain or non_success)
        return PPM if not violation else 0, violation, {"invalid_status_domain_modules": invalid_domain, "non_success_receipts": non_success}

    if mode == "policy_action_metadata":
        invalid = []
        for module, receipt in current:
            if receipt.get("policy_status") != "SAFE_WHITE_HAT" or receipt.get("action_mode") != "OBSERVE_ONLY":
                invalid.append(module)
        return PPM if not invalid else 0, bool(invalid), {"invalid_policy_or_action_modules": invalid, "required_policy_status": "SAFE_WHITE_HAT", "required_action_mode": "OBSERVE_ONLY"}

    if mode == "forbidden_claims":
        forbidden_fragments = (
            "guaranteed_rank", "guaranteed ranking", "rank guarantee", "ban_proof",
            "penalty_proof", "manipulate_google", "google manipulation", "is_indexed",
            "indexed_true", "indexed_false", "definitely_unindexed",
        )
        findings = []
        for module, receipt in current:
            for text in _walk_strings(receipt.get("output", {})):
                folded = text.casefold().replace("-", "_")
                if any(fragment in folded for fragment in forbidden_fragments):
                    findings.append({"module": module, "claim": text})
        return PPM if not findings else 0, bool(findings), {"forbidden_claims": findings}

    if mode == "forecast_disclaimer":
        missing = []
        checked = 0
        priority_tokens = (
            "lead_priority", "close_priority", "conversion_priority",
            "zero_click_lead_priority", "rank_gap_lead_priority", "content_gap_lead_priority",
        )
        for module, receipt in current:
            operation = str(receipt.get("operation") or "")
            if not any(token in operation for token in priority_tokens):
                continue
            checked += 1
            output = receipt.get("output", {})
            if not isinstance(output, Mapping) or output.get("not_a_revenue_forecast") is not True:
                missing.append(module)
        if checked == 0:
            raise InsufficientData("conversion_priority_receipts_missing")
        return PPM if not missing else 0, bool(missing), {"checked_priority_receipt_count": checked, "missing_revenue_forecast_disclaimer_modules": missing}

    if mode == "zero_new_infrastructure":
        fields = (
            "new_external_api_required", "new_database_required", "new_queue_required",
            "new_secret_required", "new_cloud_resource_required", "new_daemon_required",
        )
        violations = []
        for module, receipt in current:
            output = receipt.get("output", {})
            contract = output.get("runtime_contract", {}) if isinstance(output, Mapping) else {}
            bad = [field for field in fields if contract.get(field) is not False]
            if bad:
                violations.append({"module": module, "invalid_fields": bad})
        return PPM if not violations else 0, bool(violations), {"checked_receipt_count": len(current), "infrastructure_contract_violations": violations}

    if mode == "source_mapping_integrity":
        invalid = []
        for module, receipt in current:
            number = int(module[1:])
            if receipt.get("source_module") != f"M{number + 1000}":
                invalid.append({"module": module, "source_module": receipt.get("source_module"), "expected_source_module": f"M{number + 1000}"})
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

    raise InvalidData(f"unsupported_growth_release_guard_mode:{mode}")

def growth_release_gate(spec, normalized, config, prior_receipts):
    if prior_receipts is None:
        raise InvalidData("M1600_prior_receipts_required")
    expected = ("M1400",) + tuple(f"M{i}" for i in range(1591, 1600))
    if tuple(prior_receipts) != expected:
        raise InvalidData("M1600_prior_receipt_range_drift")
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
        "certified_local_range": ["M1001", "M1600"],
        "policy_status": "STRICT_WHITE_HAT_ONLY",
    }
