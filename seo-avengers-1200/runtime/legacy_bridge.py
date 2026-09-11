from __future__ import annotations

from typing import Any, Dict, List, Tuple

from .seo_avengers_1200 import (
    SHA256_RE,
    canonical_hash,
    canonical_module_id,
    compile_receipt,
)

LEGACY_CONTRACT = "SEO_AVENGERS_200_MODULE_EVIDENCE_V1"


def _invalid_row(raw_module_id: Any, reason: str) -> Dict[str, Any]:
    """Return a deliberately invalid evidence row so M1101 fails closed."""
    return {
        "target_module_id": raw_module_id if isinstance(raw_module_id, str) else "INVALID",
        "reported_evidence_hash": None,
        "receipt_payload": {
            "bridge_contract": LEGACY_CONTRACT,
            "bridge_error": reason,
        },
    }


def bridge_semantic200_module_evidence(value: Any) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Verify existing SEO Avengers 200 module evidence and bridge it to M1101.

    The current SEO Avengers 200 semantic service hashes each evidence record as
    canonical_hash({"module_id": numeric_id, **record_without_evidence_hash}).
    We reproduce that exact contract before creating a normal 1200 receipt. No
    legacy evidence is promoted merely because it exists; a hash mismatch is
    represented as invalid evidence so the downstream integrity gate fails closed.
    """
    if value is None:
        return [], {
            "contract": LEGACY_CONTRACT,
            "provided": False,
            "verified_records": 0,
            "rejected_records": 0,
        }
    if not isinstance(value, dict):
        return [_invalid_row("INVALID", "LEGACY_EVIDENCE_CONTAINER_NOT_OBJECT")], {
            "contract": LEGACY_CONTRACT,
            "provided": True,
            "verified_records": 0,
            "rejected_records": 1,
        }

    rows: List[Dict[str, Any]] = []
    verified = 0
    rejected = 0

    for raw_module_id in sorted(value.keys(), key=lambda item: str(item)):
        record = value[raw_module_id]
        module_id = canonical_module_id(raw_module_id)
        if module_id is None or int(module_id[1:]) > 200 or not isinstance(record, dict):
            rows.append(_invalid_row(raw_module_id, "INVALID_LEGACY_MODULE_RECORD"))
            rejected += 1
            continue

        reported_hash = record.get("evidence_hash")
        if not isinstance(reported_hash, str) or not SHA256_RE.fullmatch(reported_hash):
            rows.append(_invalid_row(module_id, "INVALID_LEGACY_EVIDENCE_HASH_FORMAT"))
            rejected += 1
            continue

        legacy_payload = dict(record)
        legacy_payload.pop("evidence_hash", None)
        legacy_numeric_id = int(module_id[1:])
        try:
            calculated_legacy_hash = canonical_hash({
                "module_id": legacy_numeric_id,
                **legacy_payload,
            })
            raw_record_hash = canonical_hash(record)
            normalized_hash = canonical_hash({
                "legacy_module_id": legacy_numeric_id,
                "legacy_record": legacy_payload,
            })
        except (TypeError, ValueError):
            rows.append(_invalid_row(module_id, "NON_CANONICAL_LEGACY_EVIDENCE"))
            rejected += 1
            continue

        if calculated_legacy_hash != reported_hash:
            rows.append(_invalid_row(module_id, "LEGACY_EVIDENCE_HASH_MISMATCH"))
            rejected += 1
            continue

        bridge_output = {
            "legacy_contract": LEGACY_CONTRACT,
            "legacy_evidence_hash": reported_hash,
            "legacy_status": legacy_payload.get("status"),
            "legacy_basis": legacy_payload.get("basis"),
        }
        bridge_receipt = compile_receipt(
            module_id,
            "seo_avengers_200_evidence_bridge",
            1,
            1,
            raw_record_hash,
            normalized_hash,
            canonical_hash({"legacy_contract": LEGACY_CONTRACT}),
            "SUCCESS",
            "NO_FINDING",
            "LEGACY_EVIDENCE_VERIFIED",
            bridge_output,
        )
        rows.append({
            "target_module_id": module_id,
            "reported_evidence_hash": bridge_receipt["evidence_hash"],
            "receipt_payload": bridge_receipt,
        })
        verified += 1

    return rows, {
        "contract": LEGACY_CONTRACT,
        "provided": True,
        "verified_records": verified,
        "rejected_records": rejected,
    }
