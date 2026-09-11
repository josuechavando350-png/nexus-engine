# -*- coding: utf-8 -*-
"""SEO Avengers 1200 extended runtime.

This module intentionally does not fabricate handlers for reserved slots.
M001-M200 remain delegated to the existing seo-avengers-200 sidecar.
Only reviewed, executable post-200 modules are registered as implemented here.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse

INT64_MAX = 9_223_372_036_854_775_807
PPM_SCALE = 1_000_000
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
MODULE_ID_RE = re.compile(r"^M0*([1-9][0-9]*)$")

IMPLEMENTED_EXTENDED_MODULES = frozenset({
    "M901",
    "M902",
    "M1001",
    "M1002",
    "M1101",
    "M1102",
})

M902_KNOWN_ACTIONS = frozenset({
    "SEO_MUTATION",
    "PAGE_REMOVAL",
    "INDEX_REQUEST",
    "NOINDEX_REQUEST",
    "CANONICAL_TO_SELF",
    "REDIRECT_REQUEST",
    "PUBLISH_SNAPSHOT",
    "ROLLBACK_REQUEST",
})

M902_CONFLICT_PAIRS = frozenset({
    tuple(sorted(("SEO_MUTATION", "PAGE_REMOVAL"))),
    tuple(sorted(("INDEX_REQUEST", "NOINDEX_REQUEST"))),
    tuple(sorted(("CANONICAL_TO_SELF", "REDIRECT_REQUEST"))),
    tuple(sorted(("PUBLISH_SNAPSHOT", "ROLLBACK_REQUEST"))),
})


def canonical_hash(payload: Any) -> str:
    """Python-v1 canonical digest used by this runtime.

    This is deterministic inside the Python contract. A cross-runtime migration
    must use a new schema/algorithm version with a formal canonical JSON spec.
    """
    raw = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def normalize_integer(value: Any, max_limit: Optional[int] = None) -> Optional[int]:
    if value is None or type(value) is bool or not isinstance(value, int):
        return None
    limit = INT64_MAX if max_limit is None else max_limit
    if limit < 0 or not (0 <= value <= limit):
        return None
    return value


def div_round_half_even(numerator: int, denominator: int, scale: int) -> Optional[int]:
    if denominator <= 0 or numerator < 0 or scale < 0:
        return None
    if scale and numerator > INT64_MAX // scale:
        return None
    scaled = numerator * scale
    quotient, remainder = divmod(scaled, denominator)
    complement = denominator - remainder
    if remainder < complement:
        return quotient
    if remainder > complement:
        return quotient + 1
    return quotient if quotient % 2 == 0 else quotient + 1


def normalize_text(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = unicodedata.normalize("NFC", value)
    collapsed = " ".join(normalized.strip().split())
    return collapsed or None


def canonical_module_id(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    match = MODULE_ID_RE.fullmatch(value.strip().upper())
    if not match:
        return None
    number = int(match.group(1))
    if not 1 <= number <= 1200:
        return None
    return f"M{number}"


def canonicalize_url_or_path(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    raw = unicodedata.normalize("NFC", value).strip()
    if not raw or "\x00" in raw:
        return None
    try:
        if raw.startswith("/") and not raw.startswith("//"):
            parsed = urlparse("https://local.invalid" + raw)
            path = parsed.path or "/"
            return f"{path}?{parsed.query}" if parsed.query else path

        parsed = urlparse(raw)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"} or not parsed.hostname:
            return None

        host = parsed.hostname.lower()
        try:
            port = parsed.port
        except ValueError:
            return None
        if port is not None and not (
            (scheme == "http" and port == 80)
            or (scheme == "https" and port == 443)
        ):
            host = f"{host}:{port}"

        path = parsed.path or "/"
        base = f"{scheme}://{host}{path}"
        return f"{base}?{parsed.query}" if parsed.query else base
    except (TypeError, ValueError):
        return None


def tokenize_text_v1(text: str) -> List[str]:
    normalized = unicodedata.normalize("NFC", text).casefold()
    return sorted({token for token in re.findall(r"\w+", normalized, flags=re.UNICODE) if len(token) > 2})


def compile_receipt(
    module_id: str,
    algorithm: str,
    algorithm_version: int,
    schema_version: int,
    raw_input_hash: Optional[str],
    normalized_input_hash: Optional[str],
    module_config_hash: Optional[str],
    execution_status: str,
    finding_status: str,
    reason_code: str,
    output: Any,
) -> Dict[str, Any]:
    receipt = {
        "module": module_id,
        "algorithm": algorithm,
        "algorithm_version": algorithm_version,
        "schema_version": schema_version,
        "raw_input_hash": raw_input_hash,
        "normalized_input_hash": normalized_input_hash,
        "module_config_hash": module_config_hash,
        "execution_status": execution_status,
        "finding_status": finding_status,
        "reason_code": reason_code,
        "output": output,
    }
    receipt["evidence_hash"] = canonical_hash(receipt)
    return receipt


def module_registry() -> Dict[str, Dict[str, Any]]:
    registry: Dict[str, Dict[str, Any]] = {}
    for number in range(1, 1201):
        module_id = f"M{number}"
        if number <= 200:
            status = "DELEGATED_TO_SEO_AVENGERS_200"
        elif module_id in IMPLEMENTED_EXTENDED_MODULES:
            status = "IMPLEMENTED_PRODUCTION"
        else:
            status = "RESERVED"
        registry[module_id] = {
            "module": module_id,
            "status": status,
            "executable_here": module_id in IMPLEMENTED_EXTENDED_MODULES,
        }
    return registry


def run_m901(meta: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    raw_payload = {
        "server_cpu_utilization_percent": meta.get("server_cpu_utilization_percent") if isinstance(meta, dict) else None,
        "cloudflare_kv_latency_ms": meta.get("cloudflare_kv_latency_ms") if isinstance(meta, dict) else None,
    }
    try:
        raw_hash = canonical_hash(raw_payload)
    except (TypeError, ValueError):
        raw_hash = None

    cpu = normalize_integer(raw_payload["server_cpu_utilization_percent"], 100)
    kv_latency = normalize_integer(raw_payload["cloudflare_kv_latency_ms"], 86_400_000)

    safe_cpu = normalize_integer(config.get("m901_max_safe_cpu_percent", 80), 99)
    safe_kv = normalize_integer(config.get("m901_max_safe_kv_latency_ms", 150), 5_000)
    kv_saturation = normalize_integer(config.get("m901_kv_saturation_latency_ms", 1000), 60_000)

    norm_hash = canonical_hash({
        "server_cpu_utilization_percent": cpu,
        "cloudflare_kv_latency_ms": kv_latency,
    })
    cfg_hash = canonical_hash({
        "max_safe_cpu_percent": safe_cpu if safe_cpu is not None else "INVALID",
        "max_safe_kv_latency_ms": safe_kv if safe_kv is not None else "INVALID",
        "kv_saturation_latency_ms": kv_saturation if kv_saturation is not None else "INVALID",
    })

    if raw_hash is None:
        return compile_receipt("M901", "infrastructure_load_throttle_policy_engine", 4, 4, None, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {})
    if cpu is None or kv_latency is None:
        return compile_receipt("M901", "infrastructure_load_throttle_policy_engine", 4, 4, raw_hash, norm_hash, cfg_hash,
                               "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_INFRASTRUCTURE_TELEMETRY", {})
    if safe_cpu is None or safe_kv is None or kv_saturation is None or kv_saturation <= safe_kv:
        return compile_receipt("M901", "infrastructure_load_throttle_policy_engine", 4, 4, raw_hash, norm_hash, cfg_hash,
                               "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {})

    cpu_pressure = 0
    if cpu > safe_cpu:
        cpu_pressure = div_round_half_even(cpu - safe_cpu, 100 - safe_cpu, PPM_SCALE)
        if cpu_pressure is None:
            return compile_receipt("M901", "infrastructure_load_throttle_policy_engine", 4, 4, raw_hash, norm_hash, cfg_hash,
                                   "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {})
        cpu_pressure = min(PPM_SCALE, cpu_pressure)

    if kv_latency >= kv_saturation:
        kv_pressure = PPM_SCALE
    elif kv_latency > safe_kv:
        kv_pressure = div_round_half_even(kv_latency - safe_kv, kv_saturation - safe_kv, PPM_SCALE)
        if kv_pressure is None:
            kv_pressure = PPM_SCALE
    else:
        kv_pressure = 0

    recommended = max(cpu_pressure, kv_pressure)
    if cpu_pressure == kv_pressure == 0:
        dominant = "NONE"
    elif cpu_pressure == kv_pressure:
        dominant = "TIE"
    elif cpu_pressure > kv_pressure:
        dominant = "CPU"
    else:
        dominant = "CLOUDFLARE_KV_LATENCY"

    output = {
        "pressure_scale": PPM_SCALE,
        "cpu_pressure_ppm": cpu_pressure,
        "kv_pressure_ppm": kv_pressure,
        "recommended_throttle_ppm": recommended,
        "dominant_signal": dominant,
    }
    return compile_receipt(
        "M901",
        "infrastructure_load_throttle_policy_engine",
        4,
        4,
        raw_hash,
        norm_hash,
        cfg_hash,
        "SUCCESS",
        "FINDING" if recommended > 0 else "NO_FINDING",
        "THROTTLE_RECOMMENDED" if recommended > 0 else "LOAD_WITHIN_SAFE_HEADROOM",
        output,
    )


def run_m902(meta: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    raw_actions = meta.get("active_pipeline_actions_pool", []) if isinstance(meta, dict) else []
    try:
        raw_hash = canonical_hash({"active_pipeline_actions_pool": raw_actions})
    except (TypeError, ValueError):
        return compile_receipt(
            "M902", "algorithmic_contradiction_detector", 4, 4, None, None, None,
            "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {},
        )

    dedup: Set[Tuple[str, str, str]] = set()
    invalid_count = 0
    if not isinstance(raw_actions, list):
        invalid_count = 1
        raw_actions = []

    for item in raw_actions:
        if not isinstance(item, dict):
            invalid_count += 1
            continue
        action = item.get("action")
        resource = item.get("resource_id")
        scope = item.get("scope")
        if not all(isinstance(value, str) for value in (action, resource, scope)):
            invalid_count += 1
            continue
        clean_action = unicodedata.normalize("NFC", action).strip().upper()
        clean_resource = unicodedata.normalize("NFC", resource).strip()
        clean_scope = " ".join(unicodedata.normalize("NFC", scope).strip().casefold().split())
        if (
            clean_action not in M902_KNOWN_ACTIONS
            or not clean_resource
            or any(ch.isspace() for ch in clean_resource)
            or not clean_scope
        ):
            invalid_count += 1
            continue
        dedup.add((clean_action, clean_resource, clean_scope))

    dataset = [
        {"action": action, "resource": resource, "scope": scope}
        for action, resource, scope in sorted(dedup)
    ]
    norm_hash = canonical_hash({
        "valid_actions": dataset,
        "invalid_or_unknown_actions_count": invalid_count,
    })
    cfg_hash = canonical_hash({
        "policy_mode": "recommend_halt_on_resource_collision",
        "known_actions": sorted(M902_KNOWN_ACTIONS),
        "conflict_pairs": [list(pair) for pair in sorted(M902_CONFLICT_PAIRS)],
    })

    base_output = {
        "logical_contradiction_found": False,
        "override_halt_recommended": False,
        "invalid_or_unknown_actions_count": invalid_count,
        "detected_collisions": [],
    }
    if not dataset:
        return compile_receipt(
            "M902", "algorithmic_contradiction_detector", 4, 4, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_ACTION_POOL_CONTEXT", base_output,
        )

    grouped: Dict[Tuple[str, str], Set[str]] = {}
    for item in dataset:
        grouped.setdefault((item["resource"], item["scope"]), set()).add(item["action"])

    collisions: List[Dict[str, str]] = []
    for (resource, scope), actions in sorted(grouped.items()):
        ordered = sorted(actions)
        for index, source in enumerate(ordered):
            for target in ordered[index + 1:]:
                if tuple(sorted((source, target))) in M902_CONFLICT_PAIRS:
                    collisions.append({
                        "resource_path": resource,
                        "execution_scope": scope,
                        "conflicting_action_source": source,
                        "conflicting_action_target": target,
                    })

    collisions.sort(key=lambda row: (
        row["execution_scope"],
        row["resource_path"],
        row["conflicting_action_source"],
        row["conflicting_action_target"],
    ))
    found = bool(collisions)
    output = {
        "logical_contradiction_found": found,
        "override_halt_recommended": found,
        "invalid_or_unknown_actions_count": invalid_count,
        "detected_collisions": collisions,
    }
    return compile_receipt(
        "M902", "algorithmic_contradiction_detector", 4, 4, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if found else "NO_FINDING",
        "RESOURCE_CONTRADICTION_FOUND" if found else "DECISION_LOGIC_CONSISTENT",
        output,
    )


def run_m1001(images: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    try:
        raw_hash = canonical_hash({"raw_images": images})
    except (TypeError, ValueError):
        return compile_receipt(
            "M1001", "chromatic_diversity_ratio_auditor", 6, 6, None, None, None,
            "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {},
        )

    if not isinstance(images, list):
        return compile_receipt(
            "M1001", "chromatic_diversity_ratio_auditor", 6, 6, raw_hash, None, None,
            "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {},
        )

    registry: Dict[Tuple[str, str, int], int] = {}
    invalid_count = 0
    conflicts: List[Dict[str, Any]] = []

    for row in images:
        if not isinstance(row, dict):
            invalid_count += 1
            continue
        image_url = canonicalize_url_or_path(row.get("image_url"))
        occupied = normalize_integer(row.get("occupied_color_bins_count"), 16_777_216)
        total = normalize_integer(row.get("histogram_total_bins_count"), 16_777_216)
        algorithm = normalize_text(row.get("extractor_binning_algorithm"))
        if (
            not image_url
            or occupied is None
            or total is None
            or total <= 0
            or occupied < 1
            or occupied > total
            or not algorithm
        ):
            invalid_count += 1
            continue
        key = (image_url, algorithm, total)
        prior = registry.get(key)
        if prior is None:
            registry[key] = occupied
        elif prior != occupied:
            conflicts.append({
                "image_url": image_url,
                "extractor_binning_algorithm": algorithm,
                "histogram_total_bins_count": total,
                "first_occupied_color_bins_count": prior,
                "conflicting_occupied_color_bins_count": occupied,
            })

    dataset = [
        {
            "image_url": image_url,
            "extractor_binning_algorithm": algorithm,
            "histogram_total_bins_count": total,
            "occupied_color_bins_count": registry[(image_url, algorithm, total)],
        }
        for image_url, algorithm, total in sorted(registry)
    ]
    conflicts.sort(key=lambda row: (
        row["image_url"],
        row["extractor_binning_algorithm"],
        row["histogram_total_bins_count"],
        row["first_occupied_color_bins_count"],
        row["conflicting_occupied_color_bins_count"],
    ))

    norm_hash = canonical_hash({
        "measurements": dataset,
        "invalid_records_count": invalid_count,
        "measurement_conflicts": conflicts,
    })
    threshold = normalize_integer(config.get("m1001_min_chromatic_diversity_ppm", 1000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_chromatic_diversity_ppm": threshold if threshold is not None else "INVALID",
        "metric": "occupied_color_bins/histogram_total_bins",
        "ppm_scale": PPM_SCALE,
    })

    if threshold is None:
        return compile_receipt(
            "M1001", "chromatic_diversity_ratio_auditor", 6, 6, raw_hash, norm_hash, cfg_hash,
            "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {},
        )
    if conflicts:
        return compile_receipt(
            "M1001", "chromatic_diversity_ratio_auditor", 6, 6, raw_hash, norm_hash, cfg_hash,
            "ERROR", "FINDING", "DUPLICATE_MEASUREMENT_CONFLICT",
            {
                "invalid_records_count": invalid_count,
                "measurement_conflicts": conflicts,
            },
        )
    if not dataset:
        return compile_receipt(
            "M1001", "chromatic_diversity_ratio_auditor", 6, 6, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_IMAGE_RECORDS",
            {"invalid_records_count": invalid_count},
        )

    low: List[Dict[str, Any]] = []
    for item in dataset:
        diversity = div_round_half_even(
            item["occupied_color_bins_count"],
            item["histogram_total_bins_count"],
            PPM_SCALE,
        )
        if diversity is None:
            return compile_receipt(
                "M1001", "chromatic_diversity_ratio_auditor", 6, 6, raw_hash, norm_hash, cfg_hash,
                "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {},
            )
        if diversity < threshold:
            low.append({
                "image_url": item["image_url"],
                "calculated_diversity_ppm": diversity,
                "verified_algorithm": item["extractor_binning_algorithm"],
                "total_bins": item["histogram_total_bins_count"],
            })

    low.sort(key=lambda row: (
        row["calculated_diversity_ppm"],
        row["image_url"],
        row["verified_algorithm"],
        row["total_bins"],
    ))
    output = {
        "diversity_scale": PPM_SCALE,
        "analyzed_measurements_count": len(dataset),
        "invalid_records_count": invalid_count,
        "low_diversity_images": low,
    }
    return compile_receipt(
        "M1001", "chromatic_diversity_ratio_auditor", 6, 6, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if low else "NO_FINDING",
        "LOW_CHROMATIC_DIVERSITY_DETECTED" if low else "CHROMATIC_VARIETY_OPTIMAL",
        output,
    )


def run_m1002(images: Any, config: Dict[str, Any]) -> Dict[str, Any]:
    try:
        raw_hash = canonical_hash({"raw_images": images})
    except (TypeError, ValueError):
        return compile_receipt(
            "M1002", "alt_context_lexical_alignment_auditor", 6, 6, None, None, None,
            "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {},
        )
    if not isinstance(images, list):
        return compile_receipt(
            "M1002", "alt_context_lexical_alignment_auditor", 6, 6, raw_hash, None, None,
            "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {},
        )

    observations: Set[Tuple[str, str, str, Tuple[str, ...], Tuple[str, ...]]] = set()
    insufficient_count = 0

    for row in images:
        if not isinstance(row, dict):
            insufficient_count += 1
            continue
        image_url = canonicalize_url_or_path(row.get("image_url"))
        page_url = canonicalize_url_or_path(row.get("page_url_context"))
        alt = row.get("alt_text")
        context = row.get("page_context_keywords")
        explicit_occurrence = normalize_text(row.get("occurrence_id"))
        if not image_url or not page_url or not isinstance(alt, str) or not isinstance(context, str):
            insufficient_count += 1
            continue
        alt_tokens = tokenize_text_v1(alt)
        context_tokens = tokenize_text_v1(context)
        if not alt_tokens or not context_tokens:
            insufficient_count += 1
            continue

        if explicit_occurrence:
            occurrence_id = explicit_occurrence
        else:
            occurrence_id = canonical_hash({
                "image_url": image_url,
                "page_url_context": page_url,
                "alt_tokens": alt_tokens,
                "context_tokens": context_tokens,
            })
        observations.add((
            image_url,
            page_url,
            occurrence_id,
            tuple(alt_tokens),
            tuple(context_tokens),
        ))

    dataset = [
        {
            "image_url": row[0],
            "page_url_context": row[1],
            "occurrence_id": row[2],
            "alt_tokens": list(row[3]),
            "context_tokens": list(row[4]),
        }
        for row in sorted(observations)
    ]

    norm_hash = canonical_hash({
        "observations": dataset,
        "insufficient_metadata_count": insufficient_count,
    })
    threshold = normalize_integer(config.get("m1002_min_lexical_alignment_ppm", 200_000), PPM_SCALE)
    cfg_hash = canonical_hash({
        "min_lexical_alignment_ppm": threshold if threshold is not None else "INVALID",
        "tokenizer": "unicode_nfc_casefold_word_v1",
        "ppm_scale": PPM_SCALE,
    })
    if threshold is None:
        return compile_receipt(
            "M1002", "alt_context_lexical_alignment_auditor", 6, 6, raw_hash, norm_hash, cfg_hash,
            "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG", {},
        )
    if not dataset:
        return compile_receipt(
            "M1002", "alt_context_lexical_alignment_auditor", 6, 6, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "NO_ANALYZABLE_METADATA",
            {"insufficient_metadata_count": insufficient_count},
        )

    misaligned: List[Dict[str, Any]] = []
    for item in dataset:
        alt_set = set(item["alt_tokens"])
        context_set = set(item["context_tokens"])
        overlap = len(alt_set.intersection(context_set))
        alignment = div_round_half_even(overlap, len(alt_set), PPM_SCALE)
        if alignment is None:
            return compile_receipt(
                "M1002", "alt_context_lexical_alignment_auditor", 6, 6, raw_hash, norm_hash, cfg_hash,
                "ERROR", "NOT_APPLICABLE", "ARITHMETIC_RANGE_EXCEEDED", {},
            )
        if alignment < threshold:
            misaligned.append({
                "image_url": item["image_url"],
                "page_url_context": item["page_url_context"],
                "occurrence_id": item["occurrence_id"],
                "calculated_alignment_ppm": alignment,
            })

    misaligned.sort(key=lambda row: (
        row["calculated_alignment_ppm"],
        row["image_url"],
        row["page_url_context"],
        row["occurrence_id"],
    ))
    output = {
        "alignment_scale": PPM_SCALE,
        "analyzed_observations_count": len(dataset),
        "insufficient_metadata_count": insufficient_count,
        "misaligned_visual_metadata_observations": misaligned,
    }
    return compile_receipt(
        "M1002", "alt_context_lexical_alignment_auditor", 6, 6, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if misaligned else "NO_FINDING",
        "LEXICAL_ALIGNMENT_DISCONNECT_FOUND" if misaligned else "VISUAL_CONTEXT_SYNCHRONIZED",
        output,
    )


def _canonical_receipt_for_rehash(receipt_payload: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    candidate = dict(receipt_payload)
    embedded = candidate.pop("evidence_hash", None)
    if embedded is not None and (not isinstance(embedded, str) or not SHA256_RE.fullmatch(embedded)):
        return None, None
    return candidate, embedded


def inspect_evidence_m1101(evidence_rows: Any) -> Tuple[Dict[str, Any], Dict[str, Dict[str, Any]], int, int]:
    try:
        raw_hash = canonical_hash({"raw_evidence": evidence_rows})
    except (TypeError, ValueError):
        receipt = compile_receipt(
            "M1101", "edge_evidence_integrity_inspector", 3, 3, None, None, None,
            "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {},
        )
        return receipt, {}, 1, 0

    if not isinstance(evidence_rows, list):
        receipt = compile_receipt(
            "M1101", "edge_evidence_integrity_inspector", 3, 3, raw_hash, None, None,
            "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {},
        )
        return receipt, {}, 1, 0

    inspected: Dict[str, Dict[str, Any]] = {}
    invalid_count = 0
    duplicate_count = 0

    for row in evidence_rows:
        if not isinstance(row, dict):
            invalid_count += 1
            continue

        module_id = canonical_module_id(row.get("target_module_id"))
        reported_hash = normalize_text(row.get("reported_evidence_hash"))
        receipt_payload = row.get("receipt_payload")

        if not module_id or not reported_hash or not SHA256_RE.fullmatch(reported_hash) or not isinstance(receipt_payload, dict):
            invalid_count += 1
            continue

        receipt_for_hash, embedded_hash = _canonical_receipt_for_rehash(receipt_payload)
        if receipt_for_hash is None:
            invalid_count += 1
            continue

        payload_module = canonical_module_id(receipt_for_hash.get("module"))
        if payload_module != module_id:
            invalid_count += 1
            continue

        if embedded_hash is not None and embedded_hash != reported_hash:
            invalid_count += 1
            continue

        calculated_hash = canonical_hash(receipt_for_hash)
        if module_id in inspected:
            duplicate_count += 1
            continue
        inspected[module_id] = {
            "module_id": module_id,
            "reported_hash": reported_hash,
            "calculated_hash": calculated_hash,
        }

    dataset = [inspected[key] for key in sorted(inspected, key=lambda mid: int(mid[1:]))]
    norm_hash = canonical_hash({
        "dataset": dataset,
        "invalid_evidence_records_count": invalid_count,
        "duplicate_module_evidence_count": duplicate_count,
    })
    cfg_hash = canonical_hash({
        "signature_policy": "trusted_boundary_recomputation",
        "hash_algorithm": "sha256",
        "canonicalization": "python-json-v1",
    })

    mismatch = [
        {"module_id": item["module_id"], "integrity_compromised": True}
        for item in dataset
        if item["reported_hash"] != item["calculated_hash"]
    ]
    mismatch.sort(key=lambda row: int(row["module_id"][1:]))

    if not dataset and invalid_count == 0 and duplicate_count == 0:
        execution = "INSUFFICIENT_DATA"
        finding = "NOT_APPLICABLE"
        reason = "INSUFFICIENT_EVIDENCE_RECORDS"
    elif mismatch:
        execution = "SUCCESS"
        finding = "FINDING"
        reason = "EVIDENCE_HASH_MISMATCH_DETECTED"
    elif invalid_count or duplicate_count:
        execution = "SUCCESS"
        finding = "FINDING"
        reason = "EVIDENCE_SET_ANOMALY_DETECTED"
    else:
        execution = "SUCCESS"
        finding = "NO_FINDING"
        reason = "EDGE_EVIDENCE_INTEGRITY_VERIFIED"

    output = {
        "checked_modules_count": len(dataset),
        "invalid_records_count": invalid_count,
        "duplicate_records_count": duplicate_count,
        "mismatch_modules": mismatch,
    }
    receipt = compile_receipt(
        "M1101", "edge_evidence_integrity_inspector", 3, 3, raw_hash, norm_hash, cfg_hash,
        execution, finding, reason, output,
    )
    return receipt, inspected, invalid_count, duplicate_count


def _validate_manifest(value: Any) -> Tuple[bool, List[str]]:
    if not isinstance(value, list) or not value:
        return False, []
    normalized: List[str] = []
    for item in value:
        module_id = canonical_module_id(item)
        if module_id is None:
            return False, []
        normalized.append(module_id)
    if len(normalized) != len(set(normalized)):
        return False, []
    normalized.sort(key=lambda mid: int(mid[1:]))
    return True, normalized


def run_m1102(
    inspected: Dict[str, Dict[str, Any]],
    invalid_count: int,
    duplicate_count: int,
    required_manifest: Any,
    config: Dict[str, Any],
    raw_input_hash: Optional[str],
) -> Dict[str, Any]:
    manifest_valid, expected_ids = _validate_manifest(required_manifest)
    threshold = normalize_integer(config.get("m1102_max_failure_rate_ppm", 50_000), PPM_SCALE)

    dataset = [inspected[key] for key in sorted(inspected, key=lambda mid: int(mid[1:]))]
    norm_hash = canonical_hash({
        "dataset": dataset,
        "invalid_count": invalid_count,
        "duplicate_count": duplicate_count,
    })
    cfg_hash = canonical_hash({
        "max_failure_rate_ppm": threshold if threshold is not None else "INVALID",
        "required_module_ids": expected_ids if manifest_valid else "INVALID",
        "manifest_policy": "exact_required_set_fail_closed_v1",
    })

    if threshold is None or not manifest_valid:
        return compile_receipt(
            "M1102", "edge_deployment_integrity_gate_policy", 3, 3,
            raw_input_hash, norm_hash, cfg_hash,
            "ERROR", "NOT_APPLICABLE", "INVALID_MANIFEST_OR_CONFIG",
            {"deployment_halt_recommended": True},
        )

    expected = set(expected_ids)
    received = set(inspected)
    missing = sorted(expected - received, key=lambda mid: int(mid[1:]))
    unexpected = sorted(received - expected, key=lambda mid: int(mid[1:]))

    mismatch_modules = sorted(
        (
            module_id
            for module_id, item in inspected.items()
            if item["reported_hash"] != item["calculated_hash"]
        ),
        key=lambda mid: int(mid[1:]),
    )

    structural_failure = bool(
        missing or unexpected or invalid_count > 0 or duplicate_count > 0
    )
    total_faults = (
        len(mismatch_modules)
        + len(missing)
        + len(unexpected)
        + invalid_count
        + duplicate_count
    )

    failure_ppm = div_round_half_even(total_faults, len(expected_ids), PPM_SCALE)
    if failure_ppm is None:
        structural_failure = True
        failure_ppm = PPM_SCALE
    if structural_failure:
        failure_ppm = PPM_SCALE

    halt = structural_failure or failure_ppm > threshold
    output = {
        "failure_rate_scale": PPM_SCALE,
        "manifest_expected_count": len(expected_ids),
        "manifest_missing_count": len(missing),
        "manifest_unexpected_count": len(unexpected),
        "cryptographic_mismatches_count": len(mismatch_modules),
        "corrupt_records_count": invalid_count,
        "duplicate_records_count": duplicate_count,
        "calculated_failure_rate_ppm": failure_ppm,
        "deployment_halt_recommended": halt,
        "missing_modules_list": missing,
        "unexpected_modules_list": unexpected,
        "mismatch_modules_list": mismatch_modules,
    }
    return compile_receipt(
        "M1102", "edge_deployment_integrity_gate_policy", 3, 3,
        raw_input_hash, norm_hash, cfg_hash,
        "SUCCESS",
        "FINDING" if halt else "NO_FINDING",
        "DEPLOYMENT_HALT_RECOMMENDED" if halt else "DEPLOYMENT_GUARD_CRITERIA_PASSED",
        output,
    )


class SeoAvengers1200Runtime:
    """Deny-by-default extended runtime for the SEO Avengers 1200 namespace."""

    def __init__(self) -> None:
        self.registry = module_registry()

    def execute(self, payload: Any, config: Any) -> Dict[str, Any]:
        if not isinstance(config, dict) or config.get("CONFIG_SEO_AVENGERS_1200") is not True:
            return {
                "suite": "SEO_AVENGERS_1200",
                "enabled": False,
                "bypassed": True,
                "registry_size": 1200,
                "modules_executed": 0,
                "receipts": {},
            }
        if not isinstance(payload, dict):
            return {
                "suite": "SEO_AVENGERS_1200",
                "enabled": True,
                "bypassed": False,
                "registry_size": 1200,
                "modules_executed": 0,
                "error": "INVALID_INPUT_SCHEMA",
                "receipts": {},
            }

        meta = payload.get("meta_telemetry", {})
        images = payload.get("site_images_data", [])

        receipts: Dict[str, Dict[str, Any]] = {}
        receipts["M901"] = run_m901(meta, config)
        receipts["M902"] = run_m902(meta, config)
        receipts["M1001"] = run_m1001(images, config)
        receipts["M1002"] = run_m1002(images, config)

        evidence_rows: List[Any] = []
        upstream = payload.get("upstream_evidence", [])
        if isinstance(upstream, list):
            evidence_rows.extend(upstream)
        elif upstream is not None:
            evidence_rows.append(upstream)

        for module_id in ("M901", "M902", "M1001", "M1002"):
            receipt = receipts[module_id]
            evidence_rows.append({
                "target_module_id": module_id,
                "reported_evidence_hash": receipt["evidence_hash"],
                "receipt_payload": receipt,
            })

        m1101_receipt, inspected, invalid_count, duplicate_count = inspect_evidence_m1101(evidence_rows)
        receipts["M1101"] = m1101_receipt

        required_manifest = config.get(
            "m1102_required_module_ids",
            ["M901", "M902", "M1001", "M1002"],
        )
        gateway_raw_hash = canonical_hash({"raw_evidence": evidence_rows})
        receipts["M1102"] = run_m1102(
            inspected,
            invalid_count,
            duplicate_count,
            required_manifest,
            config,
            gateway_raw_hash,
        )

        executed = sum(
            1 for receipt in receipts.values()
            if receipt["execution_status"] == "SUCCESS"
        )
        return {
            "suite": "SEO_AVENGERS_1200",
            "enabled": True,
            "bypassed": False,
            "registry_size": 1200,
            "delegated_legacy_modules": 200,
            "implemented_extended_modules": sorted(
                IMPLEMENTED_EXTENDED_MODULES,
                key=lambda mid: int(mid[1:]),
            ),
            "modules_executed": executed,
            "receipts": receipts,
        }
