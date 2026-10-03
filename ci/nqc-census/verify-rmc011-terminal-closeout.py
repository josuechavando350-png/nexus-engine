#!/usr/bin/env python3
"""Build and verify the terminal RMC-011 Capital Census closeout.

This is deliberately a layer above capital-real-source-closeout.json.
The real-source closeout certifies the exact observed source set and MUST
remain narrower than terminal D11. This terminal closeout is emitted only
after the independent source-universe contract is 13/13 terminally resolved
and its family-universe discovery is authenticated.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^(?:0x)?[0-9a-f]{64}$")
TERMINAL_STATUSES = {
    "AUTHENTICATED_REAL_SOURCE",
    "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE",
}
EXPECTED_FAMILIES = {
    "AAVE_V3_FLASH_LOAN",
    "UNISWAP_V2_FLASH_SWAP",
    "BALANCER_V2_FLASH_LOAN",
    "UNISWAP_V3_FLASH",
    "EXTERNAL_GAS_CREDIT",
    "EXTERNAL_GAS_SPONSOR",
    "TRANSIENT_EXTERNAL_CREDIT",
    "COLLATERALIZED_BORROWING",
    "PERSISTENT_DEBT",
    "INVENTORY_REQUIREMENT",
    "BOND_OR_STAKE",
    "SOLVER_OR_BUILDER_DEPOSIT",
    "INTRA_BLOCK_TEMPORARY_LOCK",
}
EXPECTED_FAMILY_COUNT = len(EXPECTED_FAMILIES)
EXPECTED_REPOSITORY = "josuechavando350-png/nexus-engine"
EXPECTED_CHAIN_ID = 1
EXPECTED_A1_BLOCK = 26095351
EXPECTED_A1_HASH = "0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781"


class TerminalCloseoutError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise TerminalCloseoutError(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_digest(value: object, label: str) -> str:
    require(isinstance(value, str) and HEX64.fullmatch(value) is not None, f"{label} invalid")
    return value[2:] if value.startswith("0x") else value


def load_json(path: Path) -> tuple[bytes, dict]:
    raw = path.read_bytes()
    doc = json.loads(raw)
    require(isinstance(doc, dict), f"{path}: JSON root must be an object")
    return raw, doc


def canonical_bytes(value: dict) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def validate_source_universe(doc: dict) -> dict:
    require(doc.get("schema_version") == 2, "source-universe schema differs")
    require(doc.get("stage") == "RMC-011", "source-universe stage differs")
    require(
        doc.get("contract") == "NQC_RMC011_CAPITAL_SOURCE_UNIVERSE_V1",
        "source-universe contract differs",
    )
    require(doc.get("status") == "CAPITAL_SOURCE_UNIVERSE_COMPLETE", "source universe is not complete")
    require(doc.get("terminal_claim_allowed") is True, "terminal claim is not allowed")
    require(doc.get("unknown_family_count") == 0, "unknown family count is nonzero")
    require(doc.get("d11_terminal_closed") is False, "readiness file must not self-close D11")
    require(doc.get("claim_scope") == "SOURCE_UNIVERSE_READINESS_ONLY", "source-universe scope differs")

    families = doc.get("families")
    require(isinstance(families, list) and len(families) == EXPECTED_FAMILY_COUNT, "family count differs")
    ids: set[str] = set()
    for row in families:
        require(isinstance(row, dict), "family row must be an object")
        family = row.get("id")
        require(isinstance(family, str) and family, "family id missing")
        require(family not in ids, f"duplicate family: {family}")
        ids.add(family)
        require(row.get("terminally_resolved") is True, f"{family}: not terminally resolved")
        require(row.get("status") in TERMINAL_STATUSES, f"{family}: nonterminal status")
        evidence = row.get("resolution_evidence")
        require(isinstance(evidence, dict), f"{family}: terminal evidence missing")
        require(
            evidence.get("kind") in {"AUTHENTICATED_REAL_SOURCE", "EXHAUSTIVE_REJECTION"},
            f"{family}: terminal evidence kind invalid",
        )
        require(evidence.get("repository") == EXPECTED_REPOSITORY, f"{family}: evidence repository differs")
        require(isinstance(evidence.get("workflow_name"), str) and evidence["workflow_name"], f"{family}: workflow missing")
        require(isinstance(evidence.get("run_id"), int) and evidence["run_id"] > 0, f"{family}: run id invalid")
        require(isinstance(evidence.get("head_sha"), str) and HEX40.fullmatch(evidence["head_sha"]) is not None, f"{family}: head sha invalid")
        require(isinstance(evidence.get("artifact_id"), int) and evidence["artifact_id"] > 0, f"{family}: artifact id invalid")
        require(isinstance(evidence.get("artifact_name"), str) and evidence["artifact_name"], f"{family}: artifact name missing")
        require(isinstance(evidence.get("artifact_digest"), str) and re.fullmatch(r"sha256:[0-9a-f]{64}", evidence["artifact_digest"]), f"{family}: artifact digest invalid")
        require(isinstance(evidence.get("file"), str) and evidence["file"], f"{family}: evidence file missing")
        require(isinstance(evidence.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", evidence["sha256"]), f"{family}: evidence sha invalid")

    require(ids == EXPECTED_FAMILIES, "terminal source-universe family set differs")

    discovery = doc.get("family_universe_discovery")
    require(isinstance(discovery, dict), "family-universe discovery missing")
    require(discovery.get("status") == "AUTHENTICATED_COMPLETE", "family-universe discovery incomplete")
    evidence = discovery.get("evidence")
    require(isinstance(evidence, dict), "family-universe discovery evidence missing")
    require(evidence.get("kind") == "AUTHENTICATED_DISCOVERY", "family-universe discovery evidence kind differs")
    require(evidence.get("repository") == EXPECTED_REPOSITORY, "discovery evidence repository differs")
    require(isinstance(evidence.get("workflow_name"), str) and evidence["workflow_name"], "discovery workflow missing")
    require(isinstance(evidence.get("run_id"), int) and evidence["run_id"] > 0, "discovery run id invalid")
    require(isinstance(evidence.get("head_sha"), str) and HEX40.fullmatch(evidence["head_sha"]) is not None, "discovery head sha invalid")
    require(isinstance(evidence.get("artifact_id"), int) and evidence["artifact_id"] > 0, "discovery artifact id invalid")
    require(isinstance(evidence.get("artifact_name"), str) and evidence["artifact_name"], "discovery artifact name missing")
    require(isinstance(evidence.get("artifact_digest"), str) and re.fullmatch(r"sha256:[0-9a-f]{64}", evidence["artifact_digest"]), "discovery artifact digest invalid")
    require(evidence.get("file") == "discovery-evidence.json", "discovery evidence file differs")
    require(isinstance(evidence.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", evidence["sha256"]), "discovery evidence sha invalid")
    terminal_evidence = {
        row["id"]: {
            "run_id": row["resolution_evidence"]["run_id"],
            "artifact_id": row["resolution_evidence"]["artifact_id"],
            "head_sha": row["resolution_evidence"]["head_sha"],
            "file_sha256": row["resolution_evidence"]["sha256"],
        }
        for row in families
    }
    terminal_evidence["FAMILY_UNIVERSE_DISCOVERY"] = {
        "run_id": evidence["run_id"],
        "artifact_id": evidence["artifact_id"],
        "head_sha": evidence["head_sha"],
        "file_sha256": evidence["sha256"],
    }
    return {
        "family_count": len(families),
        "family_universe_discovery_sha256": evidence["sha256"],
        "terminal_evidence": terminal_evidence,
    }


def validate_real_source_closeout(doc: dict) -> dict:
    require(doc.get("schema_version") == 3, "real-source closeout schema differs")
    require(doc.get("status") == "RMC_011_REAL_SOURCE_CLOSEOUT_PASS", "real-source closeout is not PASS")
    require(doc.get("real_source_certification") is True, "real-source certification flag is false")
    require(isinstance(doc.get("source_count"), int) and doc["source_count"] > 0, "source census is empty")
    require(doc.get("global_capital_source_completeness_claimed") is False, "narrow closeout overclaims global completeness")
    require(doc.get("terminal_capital_census_complete") is False, "narrow closeout must remain nonterminal")
    require(doc.get("actionable_requirement_coverage_complete") is False, "D11 cannot claim D12 actionability")
    for field in ("profitability_claimed", "shadow_eligibility_claimed", "canary_claimed", "real_pnl_claimed", "portfolio_concurrent_capacity_claimed"):
        require(doc.get(field) is False, f"real-source closeout overclaims {field}")

    code_commit = doc.get("code_commit")
    code_tree = doc.get("code_tree")
    require(isinstance(code_commit, str) and HEX40.fullmatch(code_commit) is not None, "code commit invalid")
    require(isinstance(code_tree, str) and HEX40.fullmatch(code_tree) is not None, "code tree invalid")
    require(isinstance(doc.get("generated_at"), str) and doc["generated_at"], "generated_at missing")
    anchor = doc.get("observation_anchor")
    require(isinstance(anchor, dict), "observation anchor missing")
    require(anchor.get("chain_id") == EXPECTED_CHAIN_ID, "observation anchor chain differs from A1")
    require(anchor.get("block_number") == EXPECTED_A1_BLOCK, "observation anchor block differs from A1")
    require(anchor.get("block_hash") == EXPECTED_A1_HASH, "observation anchor hash differs from A1")
    for field in ("requirement_count", "feasible_count"):
        require(isinstance(doc.get(field), int) and not isinstance(doc[field], bool) and doc[field] >= 0, f"{field} invalid")
    require(isinstance(doc.get("zero_own_capital_proven"), bool), "zero_own_capital_proven invalid")
    for field in ("capital_commitment", "upstream_authority_commitment"):
        normalize_digest(doc.get(field), field)
    normalize_digest(doc.get("upstream_authority_lock_sha256"), "closeout authority-lock sha256")
    normalize_digest(doc.get("upstream_authority_lock_commitment"), "closeout authority-lock commitment")
    return {
        "code_commit": code_commit,
        "code_tree": code_tree,
        "generated_at": doc["generated_at"],
        "observation_anchor": doc["observation_anchor"],
        "source_count": doc["source_count"],
        "requirement_count": doc.get("requirement_count"),
        "feasible_count": doc.get("feasible_count"),
        "zero_own_capital_proven": doc.get("zero_own_capital_proven"),
        "capital_commitment": doc.get("capital_commitment"),
        "upstream_authority_commitment": doc.get("upstream_authority_commitment"),
        "upstream_authority_lock_commitment": doc.get("upstream_authority_lock_commitment"),
    }


def validate_authority_lock(doc: dict, raw: bytes, closeout: dict) -> dict:
    require(doc.get("schema_version") == 1, "authority-lock schema differs")
    stages = doc.get("stages")
    require(isinstance(stages, list) and len(stages) == 5, "authority lock must bind D06-D10")
    commitment = normalize_digest(doc.get("authority_lock_commitment"), "authority-lock commitment")
    observed_sha = sha256_bytes(raw)
    require(
        observed_sha == normalize_digest(closeout.get("upstream_authority_lock_sha256"), "closeout authority-lock sha256"),
        "authority-lock bytes differ from real-source closeout",
    )
    require(
        commitment == normalize_digest(closeout.get("upstream_authority_lock_commitment"), "closeout authority-lock commitment"),
        "authority-lock commitment differs from real-source closeout",
    )
    return {"sha256": observed_sha, "commitment": commitment}


def validate_transport_auth(
    tsv_raw: bytes,
    marker_raw: bytes,
    expected_evidence: dict[str, dict],
) -> dict:
    try:
        text = tsv_raw.decode("utf-8")
        marker = marker_raw.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise TerminalCloseoutError("transport-auth evidence is not UTF-8") from exc

    observed = sha256_bytes(tsv_raw)
    marker_parts = marker.split()
    require(marker_parts and marker_parts[0] == observed, "transport-auth marker differs from TSV bytes")

    labels: set[str] = set()
    for number, line in enumerate(text.splitlines(), 1):
        parts = line.split("\t")
        require(len(parts) == 5, f"transport-auth row {number} has wrong width")
        label, run_id, artifact_id, head_sha, file_sha = parts
        require(label not in labels, f"duplicate transport-auth label: {label}")
        labels.add(label)
        require(run_id.isdigit() and int(run_id) > 0, f"{label}: transport run id invalid")
        require(artifact_id.isdigit() and int(artifact_id) > 0, f"{label}: transport artifact id invalid")
        require(HEX40.fullmatch(head_sha) is not None, f"{label}: transport head sha invalid")
        require(re.fullmatch(r"[0-9a-f]{64}", file_sha) is not None, f"{label}: transport file sha invalid")
        expected_row = expected_evidence.get(label)
        require(isinstance(expected_row, dict), f"{label}: no source-universe evidence binding")
        require(int(run_id) == expected_row.get("run_id"), f"{label}: transport run differs from source universe")
        require(int(artifact_id) == expected_row.get("artifact_id"), f"{label}: transport artifact differs from source universe")
        require(head_sha == expected_row.get("head_sha"), f"{label}: transport head differs from source universe")
        require(file_sha == expected_row.get("file_sha256"), f"{label}: transport file sha differs from source universe")

    expected = set(EXPECTED_FAMILIES)
    expected.add("FAMILY_UNIVERSE_DISCOVERY")
    require(labels == expected, "transport-auth label set differs from terminal source universe")
    return {"sha256": observed, "count": len(labels)}


def build_terminal_closeout(
    source_raw: bytes,
    source: dict,
    closeout_raw: bytes,
    closeout: dict,
    lock_raw: bytes,
    lock: dict,
    transport_tsv_raw: bytes,
    transport_marker_raw: bytes,
) -> dict:
    universe = validate_source_universe(source)
    real = validate_real_source_closeout(closeout)
    authority = validate_authority_lock(lock, lock_raw, closeout)
    transport = validate_transport_auth(
        transport_tsv_raw,
        transport_marker_raw,
        universe["terminal_evidence"],
    )

    payload = {
        "schema_version": 1,
        "stage": "RMC-011",
        "status": "D11_TERMINAL_CLOSED",
        "claim_scope": "D11_CAPITAL_SOURCE_CENSUS_ONLY",
        "generated_at": real["generated_at"],
        "generated_at_basis": "OBSERVATION_ANCHOR_BLOCK_TIMESTAMP",
        "observation_anchor": real["observation_anchor"],
        "code_commit": real["code_commit"],
        "code_tree": real["code_tree"],
        "family_count": universe["family_count"],
        "resolved_family_count": universe["family_count"],
        "unknown_family_count": 0,
        "capital_source_universe_complete": True,
        "family_universe_discovery_authenticated": True,
        "source_universe_transport_auth_count": transport["count"],
        "source_universe_transport_auth_sha256": transport["sha256"],
        "terminal_capital_census_complete": True,
        "d11_terminal_closed": True,
        "source_count": real["source_count"],
        "requirement_count": real["requirement_count"],
        "feasible_count": real["feasible_count"],
        "zero_own_capital_proven": real["zero_own_capital_proven"],
        "source_universe_sha256": sha256_bytes(source_raw),
        "family_universe_discovery_sha256": universe["family_universe_discovery_sha256"],
        "real_source_closeout_sha256": sha256_bytes(closeout_raw),
        "upstream_authority_lock_sha256": authority["sha256"],
        "upstream_authority_lock_commitment": "0x" + authority["commitment"],
        "capital_commitment": real["capital_commitment"],
        "upstream_authority_commitment": real["upstream_authority_commitment"],
        "actionable_requirement_coverage_complete": False,
        "repayment_cashflow_sufficiency_claimed": False,
        "portfolio_concurrent_capacity_claimed": False,
        "profitability_claimed": False,
        "shadow_eligibility_claimed": False,
        "canary_claimed": False,
        "real_pnl_claimed": False,
        "non_claims": [
            "ACTIONABLE_REQUIREMENT_COVERAGE_DEFERRED_TO_RMC012",
            "REPAYMENT_CASHFLOW_SUFFICIENCY_NOT_CERTIFIED",
            "PORTFOLIO_CONCURRENT_CAPACITY_NOT_CERTIFIED",
            "PROFITABILITY_NOT_CERTIFIED",
            "SHADOW_NOT_CERTIFIED",
            "CANARY_NOT_CERTIFIED",
            "REAL_PNL_NOT_CERTIFIED",
        ],
    }
    commitment = sha256_bytes(canonical_bytes(payload))
    payload["terminal_closeout_commitment"] = "0x" + commitment
    return payload


def main(argv: list[str]) -> int:
    if len(argv) != 7:
        print(
            "usage: verify-rmc011-terminal-closeout.py <source-universe.json> <capital-real-source-closeout.json> <capital-upstream-authority-lock.json> <source-universe-transport-auth.tsv> <source-universe-transport-auth.sha256> <out.json>",
            file=sys.stderr,
        )
        return 2
    source_path, closeout_path, lock_path, transport_tsv_path, transport_marker_path, out_path = map(Path, argv[1:])
    try:
        source_raw, source = load_json(source_path)
        closeout_raw, closeout = load_json(closeout_path)
        lock_raw, lock = load_json(lock_path)
        transport_tsv_raw = transport_tsv_path.read_bytes()
        transport_marker_raw = transport_marker_path.read_bytes()
        terminal = build_terminal_closeout(
            source_raw,
            source,
            closeout_raw,
            closeout,
            lock_raw,
            lock,
            transport_tsv_raw,
            transport_marker_raw,
        )
        encoded = canonical_bytes(terminal)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(encoded)

        # Read-back verification proves deterministic bytes and commitment.
        reread = json.loads(out_path.read_text(encoding="utf-8"))
        commitment = reread.pop("terminal_closeout_commitment")
        require(
            commitment == "0x" + sha256_bytes(canonical_bytes(reread)),
            "terminal closeout commitment read-back mismatch",
        )
    except (OSError, json.JSONDecodeError, TerminalCloseoutError, TypeError, KeyError) as exc:
        print(f"RMC011_TERMINAL_CLOSEOUT_INVALID {exc}", file=sys.stderr)
        return 1

    print(
        "D11_TERMINAL_CLOSED=PASS "
        f"families={terminal['resolved_family_count']}/{terminal['family_count']} "
        f"sources={terminal['source_count']} "
        f"head={terminal['code_commit']} "
        f"tree={terminal['code_tree']} "
        f"commitment={terminal['terminal_closeout_commitment']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
