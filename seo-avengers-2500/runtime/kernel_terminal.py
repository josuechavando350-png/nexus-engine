from __future__ import annotations

from typing import Any, Mapping

from .common import PPM, InvalidData, InsufficientData, hash_value

EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"
_RUNTIME_FALSE_FIELDS = (
    "new_external_api_required",
    "new_database_required",
    "new_queue_required",
    "new_secret_required",
    "new_cloud_resource_required",
    "new_daemon_required",
)
_CERTIFIER_CHAIN = (
    "M1200", "M1400", "M1600", "M1700", "M1800",
    "M1900", "M2000", "M2100", "M2200", "M2300", "M2400",
)

def _recompute_receipt(receipt: Mapping[str, Any]) -> bool:
    evidence_hash = receipt.get("evidence_hash")
    if not isinstance(evidence_hash, str) or not evidence_hash.startswith("sha256:") or len(evidence_hash) != 71:
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

def _expected_receipts(prior_receipts: Mapping[str, Mapping[str, Any]], end: int) -> list[tuple[str, Mapping[str, Any]]]:
    expected = tuple(f"M{i}" for i in range(1001, end + 1))
    if tuple(prior_receipts) != expected:
        missing = [module for module in expected if module not in prior_receipts]
        extra = [module for module in prior_receipts if module not in expected]
        raise InvalidData(
            "global_receipt_range_drift:"
            + f"expected={expected[0]}-{expected[-1]};missing={','.join(missing[:5])};extra={','.join(extra[:5])}"
        )
    return [(module, prior_receipts[module]) for module in expected]

def _guard_details(score: int, violation: bool, mode: str, **details: Any):
    return score, violation, {
        "mode": mode,
        "observe_only": True,
        "strict_white_hat_only": True,
        "evidence_contract": EVIDENCE_CONTRACT,
        "global_composition_guard": True,
        **details,
    }

def global_composition_guard(spec, normalized, config, prior_receipts):
    if prior_receipts is None:
        raise InsufficientData("global_composition_prior_receipts_missing")
    params = spec.get("params")
    if not isinstance(params, Mapping):
        raise InvalidData("global_composition_params_missing")
    mode = params.get("mode")
    if not isinstance(mode, str) or not mode:
        raise InvalidData("global_composition_mode_missing")

    current = _expected_receipts(prior_receipts, 2490)

    if mode == "exact_local_receipt_range":
        return _guard_details(PPM, False, mode, checked_receipt_count=len(current), exact_range=["M1001", "M2490"])

    if mode == "global_receipt_hash_integrity":
        invalid = [module for module, receipt in current if not _recompute_receipt(receipt)]
        return _guard_details(PPM if not invalid else 0, bool(invalid), mode, invalid_receipt_modules=invalid, checked_receipt_count=len(current))

    if mode == "global_execution_integrity":
        invalid = []
        insufficient = []
        for module, receipt in current:
            execution = receipt.get("execution_status")
            if execution == "INSUFFICIENT_DATA":
                insufficient.append(module)
            elif execution != "SUCCESS":
                invalid.append({"module": module, "execution_status": execution, "reason_code": receipt.get("reason_code")})
        return _guard_details(
            PPM if not invalid else 0,
            bool(invalid),
            mode,
            invalid_execution_receipts=invalid,
            insufficient_data_modules=insufficient,
            checked_receipt_count=len(current),
        )

    if mode == "global_policy_action_integrity":
        invalid = [
            module for module, receipt in current
            if receipt.get("policy_status") != "SAFE_WHITE_HAT" or receipt.get("action_mode") != "OBSERVE_ONLY"
        ]
        return _guard_details(PPM if not invalid else 0, bool(invalid), mode, invalid_policy_or_action_modules=invalid)

    if mode == "global_runtime_contract_integrity":
        invalid = []
        for module, receipt in current:
            if receipt.get("execution_status") != "SUCCESS":
                continue
            output = receipt.get("output")
            if not isinstance(output, Mapping):
                invalid.append({"module": module, "invalid_fields": list(_RUNTIME_FALSE_FIELDS)})
                continue
            contract = output.get("runtime_contract")
            if not isinstance(contract, Mapping):
                invalid.append({"module": module, "invalid_fields": list(_RUNTIME_FALSE_FIELDS)})
                continue
            bad = [field for field in _RUNTIME_FALSE_FIELDS if contract.get(field) is not False]
            if bad:
                invalid.append({"module": module, "invalid_fields": bad})
        return _guard_details(PPM if not invalid else 0, bool(invalid), mode, runtime_contract_violations=invalid)

    if mode == "global_operation_algorithm_uniqueness":
        operations = [receipt.get("operation") for _, receipt in current]
        algorithms = [receipt.get("algorithm") for _, receipt in current]
        malformed = [
            module for module, receipt in current
            if not isinstance(receipt.get("operation"), str)
            or not isinstance(receipt.get("algorithm"), str)
            or not str(receipt.get("algorithm")).startswith(f"avengers2500_v1_{module.lower()}_")
        ]
        duplicate_operations = sorted({value for value in operations if isinstance(value, str) and operations.count(value) > 1})
        duplicate_algorithms = sorted({value for value in algorithms if isinstance(value, str) and algorithms.count(value) > 1})
        violation = bool(malformed or duplicate_operations or duplicate_algorithms)
        return _guard_details(
            PPM if not violation else 0, violation, mode,
            malformed_modules=malformed,
            duplicate_operations=duplicate_operations,
            duplicate_algorithms=duplicate_algorithms,
            checked_receipt_count=len(current),
        )

    if mode == "global_source_mapping_integrity":
        invalid = []
        for module, receipt in current:
            expected_source = f"M{int(module[1:]) + 1000}"
            if receipt.get("source_module") != expected_source:
                invalid.append({"module": module, "expected": expected_source, "actual": receipt.get("source_module")})
        return _guard_details(PPM if not invalid else 0, bool(invalid), mode, source_mapping_violations=invalid)

    if mode == "global_forbidden_claim_absence":
        forbidden = (
            "guaranteed ranking", "guaranteed_rank", "rank guarantee",
            "guaranteed index", "guaranteed_index", "guaranteed crawl", "guaranteed_crawl",
            "ban proof", "ban_proof", "penalty proof", "penalty_proof",
            "cloaking enabled", "cloaking_enabled", "doorway generation enabled", "doorway_generation_enabled",
            "link scheme enabled", "link_scheme_enabled", "fake review enabled", "fake location enabled",
            "manipulate google", "google manipulation",
        )
        findings = []
        for module, receipt in current:
            for text in _walk_strings(receipt.get("output", {})):
                folded = text.casefold()
                if any(fragment in folded for fragment in forbidden):
                    findings.append({"module": module, "claim": text})
        return _guard_details(PPM if not findings else 0, bool(findings), mode, forbidden_claims=findings)

    if mode == "certifier_chain_and_compliance_safe":
        blocking = []
        for module in _CERTIFIER_CHAIN:
            receipt = prior_receipts.get(module)
            if receipt is None or not _recompute_receipt(receipt):
                blocking.append({"module": module, "reason": "CERTIFIER_MISSING_OR_HASH_INVALID"})
                continue
            output = receipt.get("output", {})
            if receipt.get("execution_status") != "SUCCESS" or receipt.get("finding_status") != "NO_FINDING" or not isinstance(output, Mapping) or output.get("release_safe") is not True:
                blocking.append({"module": module, "reason": "CERTIFIER_NOT_RELEASE_SAFE"})
        for number in range(2401, 2491):
            module = f"M{number}"
            receipt = prior_receipts[module]
            if receipt.get("execution_status") != "SUCCESS" or receipt.get("finding_status") != "NO_FINDING":
                blocking.append({"module": module, "reason": "COMPLIANCE_SLICE_NOT_CLEAN"})
        return _guard_details(
            PPM if not blocking else 0, bool(blocking), mode,
            checked_certifier_chain=list(_CERTIFIER_CHAIN),
            compliance_slice=["M2401", "M2490"],
            blocking=blocking,
        )

    raise InvalidData(f"unsupported_global_composition_guard_mode:{mode}")

def terminal_composition_certifier(spec, normalized, config, prior_receipts):
    if prior_receipts is None:
        raise InvalidData("terminal_prior_receipts_required")
    current = _expected_receipts(prior_receipts, 2499)

    invalid_hashes = [module for module, receipt in current if not _recompute_receipt(receipt)]
    guard_modules = tuple(f"M{i}" for i in range(2491, 2500))
    guard_blocking = []
    for module in guard_modules:
        receipt = prior_receipts[module]
        if receipt.get("execution_status") != "SUCCESS" or receipt.get("finding_status") != "NO_FINDING":
            guard_blocking.append({"module": module, "reason": receipt.get("reason_code")})

    from .manifest import FINGERPRINTS, MODULE_SPECS
    from .catalog import module_registry

    expected_specs = tuple(f"M{i}" for i in range(1001, 2501))
    spec_range_ok = tuple(MODULE_SPECS) == expected_specs and len(MODULE_SPECS) == 1500
    operation_unique = len({item["operation"] for item in MODULE_SPECS.values()}) == 1500
    fingerprint_unique = len(set(FINGERPRINTS.values())) == 1500
    policy_safe = all(item.get("policy_status") == "SAFE_WHITE_HAT" for item in MODULE_SPECS.values())
    action_safe = all(item.get("action_mode") == "OBSERVE_ONLY" for item in MODULE_SPECS.values())
    source_mapping_ok = all(MODULE_SPECS[f"M{i}"].get("source_module") == f"M{i + 1000}" for i in range(1001, 2501))

    registry = module_registry()
    registry_exact = tuple(registry) == tuple(f"M{i}" for i in range(1, 2501))
    delegated_exact = all(
        registry[f"M{i}"].get("status") == "DELEGATED_PRODUCTION"
        and registry[f"M{i}"].get("delegated_runtime") == "seo-avengers-1000"
        for i in range(1, 1001)
    )
    local_exact = all(
        registry[f"M{i}"].get("status") == "IMPLEMENTED_PRODUCTION"
        and registry[f"M{i}"].get("executable_here") is True
        for i in range(1001, 2501)
    )
    m2501_absent = "M2501" not in registry

    predecessor = prior_receipts.get("M2400")
    predecessor_safe = (
        isinstance(predecessor, Mapping)
        and _recompute_receipt(predecessor)
        and predecessor.get("execution_status") == "SUCCESS"
        and predecessor.get("finding_status") == "NO_FINDING"
        and isinstance(predecessor.get("output"), Mapping)
        and predecessor["output"].get("release_safe") is True
    )

    blocking = []
    if invalid_hashes:
        blocking.append({"reason": "LOCAL_RECEIPT_HASH_INTEGRITY_FAILED", "modules": invalid_hashes[:20]})
    if guard_blocking:
        blocking.append({"reason": "GLOBAL_GUARD_BLOCKING", "guards": guard_blocking})
    checks = {
        "manifest_exact_m1001_m2500": spec_range_ok,
        "local_operation_uniqueness": operation_unique,
        "local_functional_fingerprint_uniqueness": fingerprint_unique,
        "local_policy_safe": policy_safe,
        "local_action_observe_only": action_safe,
        "local_source_mapping_exact": source_mapping_ok,
        "registry_exact_m1_m2500": registry_exact,
        "delegated_m1_m1000_exact": delegated_exact,
        "implemented_m1001_m2500_exact": local_exact,
        "m2501_absent": m2501_absent,
        "m2400_predecessor_release_safe": predecessor_safe,
    }
    failed_checks = [name for name, value in checks.items() if value is not True]
    if failed_checks:
        blocking.append({"reason": "COMPOSITION_INVARIANT_FAILED", "checks": failed_checks})

    release_safe = not blocking
    score = PPM if release_safe else 0
    return score, not release_safe, {
        "observe_only": True,
        "strict_white_hat_only": True,
        "release_safe": release_safe,
        "suite": "SEO_AVENGERS_2500",
        "certified_exact_range": ["M1", "M2500"],
        "delegated_production_range": ["M1", "M1000"],
        "local_implemented_range": ["M1001", "M2500"],
        "checked_prior_receipt_range": ["M1001", "M2499"],
        "checked_prior_receipt_count": len(current),
        "global_guard_range": ["M2491", "M2499"],
        "composition_checks": checks,
        "blocking_findings": blocking,
        "delegated_runtime": "seo-avengers-1000",
        "delegated_verifier_contract": "seo-avengers-2500/scripts/verify.sh MUST run seo-avengers-1000/scripts/verify.sh first",
        "no_google_scraping": True,
        "no_site_mutation": True,
        "no_page_generation": True,
        "no_external_link_creation": True,
        "not_a_rank_guarantee": True,
        "not_an_indexation_guarantee": True,
        "not_a_penalty_immunity_guarantee": True,
        "evidence_contract": EVIDENCE_CONTRACT,
        "prior_receipt_hashes_hash": hash_value([f"{module}:{receipt.get('evidence_hash')}" for module, receipt in current]),
    }
