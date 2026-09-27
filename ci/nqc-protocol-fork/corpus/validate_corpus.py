#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CORPUS = ROOT / "ci" / "nqc-protocol-fork" / "corpus"
MANIFEST = CORPUS / "manifest.json"
SCHEMA = CORPUS / "fixture.schema.json"
CONTRACT = ROOT / "ci" / "nqc-protocol-fork" / "PROTOCOL_FORK_TRUTH_CONTRACT.json"

HEX32 = re.compile(r"^0x[0-9a-fA-F]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
CASE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{2,95}$")
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
HEX_QUANTITY = re.compile(r"^0x[0-9a-fA-F]+$")
DECIMAL_UINT = re.compile(r"^[0-9]+$")
ALLOWED_STATUS = {"PASS", "FAIL", "NOT_TESTED"}
ALLOWED_FAMILY = {"liquidation", "backrun"}

EXPECTED_CLASSES = {
    "aave": {
        "ordinary_liquidation",
        "emode_account",
        "close_factor_boundary",
        "multiple_collateral_debt_pairs",
        "interest_index_sensitive",
        "dust_boundary",
        "liquidation_bonus_path",
        "protocol_fee_path",
        "oracle_dependent_valuation",
        "flash_loan_premium_accounting",
    },
    "token_execution": {
        "standard_erc20",
        "fee_on_transfer_rejection",
        "non_standard_erc20_behavior",
    },
    "v2": {
        "single_hop_route",
        "multi_hop_route",
        "sync_reserve_update",
        "zero_liquidity_death_revival",
        "route_continuity",
        "reorged_reserve_state",
    },
}


def die(message: str) -> None:
    raise SystemExit(message)


def load(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception as exc:
        die(f"{path}: invalid JSON: {exc}")


def reject_moving_head(value, path="fixture"):
    if isinstance(value, dict):
        for key, nested in value.items():
            reject_moving_head(nested, f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            reject_moving_head(nested, f"{path}[{index}]")
    elif isinstance(value, str) and value.strip().lower() == "latest":
        die(f"{path}: moving head selector is forbidden")


manifest = load(MANIFEST)
load(SCHEMA)
contract = load(CONTRACT)

if manifest.get("schema_version") != 1:
    die("manifest schema_version must be 1")
if manifest.get("tranche") != "T39_PROTOCOL_FORK_TRUTH_55_TO_62":
    die("manifest tranche mismatch")
if manifest.get("status") not in ALLOWED_STATUS:
    die("manifest status must be PASS, FAIL, or NOT_TESTED")
if manifest.get("protocol_fork_truth") != "NOT_CLOSED":
    die("protocol_fork_truth must remain NOT_CLOSED while hard source blockers are open")

blockers = contract.get("current_blockers", [])
open_hard = [
    blocker
    for blocker in blockers
    if blocker.get("severity") == "HARD" and blocker.get("status") == "OPEN"
]
expected_blockers = {"PFT-SRC-001", "PFT-SRC-002", "PFT-SRC-003"}
if {blocker.get("id") for blocker in open_hard} != expected_blockers:
    die("hard source blocker set changed; corpus admission requires explicit review")

source_binding = manifest.get("source_binding", {})
if source_binding.get("physical_checkpoint") != "2b640ccdeadeb8bf7b0ffc0e07ce861305cf11b9":
    die("manifest physical checkpoint mismatch")
if not HEX40.fullmatch(source_binding.get("repository_head", "")):
    die("source_binding.repository_head must be a full 40-hex commit")
if source_binding.get("fixture_schema") != "ci/nqc-protocol-fork/corpus/fixture.schema.json":
    die("fixture schema path mismatch")

provider_contract = manifest.get("provider_contract", {})
for key in (
    "must_serve_exact_historical_state",
    "block_hash_pin_required",
    "nearby_block_substitution_forbidden",
    "moving_head_selector_forbidden",
):
    if provider_contract.get(key) is not True:
        die(f"provider_contract.{key} must be true")

classes = manifest.get("required_classes", {})
if set(classes) != set(EXPECTED_CLASSES):
    die("required class domains changed without contract update")

flat_classes = set()
class_status = {}
for domain, expected in EXPECTED_CLASSES.items():
    entries = classes.get(domain)
    if not isinstance(entries, list):
        die(f"required_classes.{domain} must be a list")
    ids = {entry.get("id") for entry in entries}
    if ids != expected:
        die(f"required_classes.{domain} does not match the required coverage set")
    for entry in entries:
        status = entry.get("status")
        if status not in ALLOWED_STATUS:
            die(f"class {entry.get('id')} has invalid status {status!r}")
        if entry["id"] in flat_classes:
            die(f"duplicate class id {entry['id']}")
        flat_classes.add(entry["id"])
        class_status[entry["id"]] = status

cases = manifest.get("cases")
if not isinstance(cases, list):
    die("manifest cases must be a list")

seen_ids = set()
seen_anchors = set()
coverage_pass = {class_id: 0 for class_id in flat_classes}
coverage_any = {class_id: 0 for class_id in flat_classes}
status_counts = {"PASS": 0, "FAIL": 0, "NOT_TESTED": 0}

for rel in cases:
    if not isinstance(rel, str):
        die("each cases entry must be a fixture path string")
    path = ROOT / rel
    if not path.is_file():
        die(f"missing fixture {rel}")
    fixture = load(path)
    reject_moving_head(fixture, rel)

    if fixture.get("schema_version") != 1:
        die(f"{rel}: schema_version must be 1")
    case_id = fixture.get("case_id", "")
    if not CASE_ID.fullmatch(case_id):
        die(f"{rel}: invalid case_id")
    if case_id in seen_ids:
        die(f"{rel}: duplicate case_id {case_id}")
    seen_ids.add(case_id)
    expected_path = f"ci/nqc-protocol-fork/corpus/cases/{case_id}.json"
    if rel != expected_path:
        die(f"{rel}: fixture path must be {expected_path}")

    family = fixture.get("strategy_family")
    if family not in ALLOWED_FAMILY:
        die(f"{rel}: invalid strategy_family")

    tags = fixture.get("class_tags")
    if not isinstance(tags, list) or not tags or len(tags) != len(set(tags)):
        die(f"{rel}: class_tags must be a non-empty unique list")
    unknown = set(tags) - flat_classes
    if unknown:
        die(f"{rel}: unknown class tags {sorted(unknown)}")

    chain_id = fixture.get("chain_id")
    block_number = fixture.get("block_number")
    block_hash = fixture.get("block_hash", "")
    parent_hash = fixture.get("parent_hash", "")
    if not isinstance(chain_id, int) or chain_id <= 0:
        die(f"{rel}: chain_id must be positive integer")
    if not isinstance(block_number, int) or block_number <= 0:
        die(f"{rel}: block_number must be positive integer")
    if not HEX32.fullmatch(block_hash) or not HEX32.fullmatch(parent_hash):
        die(f"{rel}: block_hash and parent_hash must be exact 32-byte hashes")
    anchor = (chain_id, block_number, block_hash.lower())
    if anchor in seen_anchors:
        die(f"{rel}: duplicate canonical anchor")
    seen_anchors.add(anchor)

    source_commit = fixture.get("source_commit", "")
    if not HEX40.fullmatch(source_commit):
        die(f"{rel}: source_commit must be full 40-hex SHA")
    if source_commit != source_binding["physical_checkpoint"]:
        die(
            f"{rel}: source_commit must equal the physically recovered "
            "checkpoint until source_binding is explicitly revised"
        )

    if family == "liquidation":
        account = fixture.get("account")
        if not isinstance(account, dict):
            die(f"{rel}: liquidation fixture requires account identity")
        observed = account.get("observed_liquidations")
        total_logs = account.get("total_liquidation_log_count")
        if not isinstance(observed, list) or not observed:
            die(f"{rel}: liquidation fixture requires observed_liquidations")
        if not isinstance(total_logs, int) or total_logs < len(observed):
            die(f"{rel}: invalid total_liquidation_log_count")
        seen_log_indexes = set()
        for liquidation in observed:
            if not isinstance(liquidation, dict):
                die(f"{rel}: observed liquidation must be an object")
            for key in ("borrower", "collateral_asset", "debt_asset", "liquidator"):
                if not ADDRESS.fullmatch(liquidation.get(key, "")):
                    die(f"{rel}: invalid liquidation address {key}")
            for key in ("debt_to_cover", "liquidated_collateral_amount"):
                if not DECIMAL_UINT.fullmatch(liquidation.get(key, "")):
                    die(f"{rel}: invalid decimal uint {key}")
            log_index = liquidation.get("log_index", "")
            if not HEX_QUANTITY.fullmatch(log_index):
                die(f"{rel}: invalid liquidation log_index")
            if log_index.lower() in seen_log_indexes:
                die(f"{rel}: duplicate liquidation log_index")
            seen_log_indexes.add(log_index.lower())
            if not isinstance(liquidation.get("receive_atoken"), bool):
                die(f"{rel}: receive_atoken must be boolean")

        provenance = fixture.get("provenance")
        if not isinstance(provenance, dict):
            die(f"{rel}: liquidation fixture requires discovery provenance")
        tx_hash = provenance.get("transaction_hash", "")
        if not HEX32.fullmatch(tx_hash):
            die(f"{rel}: transaction_hash must be exact 32-byte hash")
        if not HEX40.fullmatch(provenance.get("discovery_source_sha", "")):
            die(f"{rel}: discovery_source_sha must be full 40-hex SHA")
        for key in (
            "discovery_artifact_sha256",
            "candidate_discovery_sha256",
            "provider_observations_sha256",
        ):
            if not SHA256.fullmatch(provenance.get(key, "")):
                die(f"{rel}: {key} must be SHA-256")
        if provenance.get("fixture_admitted") is not True:
            die(f"{rel}: admitted corpus fixture must set fixture_admitted=true")

    provider = fixture.get("provider")
    if not isinstance(provider, dict):
        die(f"{rel}: provider object required")
    if provider.get("kind") not in {"owned_reth", "archive_rpc", "fork_snapshot"}:
        die(f"{rel}: unsupported provider.kind")
    identity = provider.get("identity")
    if not isinstance(identity, str) or not identity.strip():
        die(f"{rel}: provider.identity required")
    if not SHA256.fullmatch(provider.get("identity_sha256", "")):
        die(f"{rel}: provider.identity_sha256 must be SHA-256")
    if provider.get("historical_state_served") is not True:
        die(f"{rel}: provider must prove exact historical state was served")

    protocol = fixture.get("protocol")
    if not isinstance(protocol, dict) or not protocol:
        die(f"{rel}: non-empty protocol identity is required")

    result = fixture.get("result")
    if not isinstance(result, dict):
        die(f"{rel}: result object required")
    status = result.get("status")
    if status not in ALLOWED_STATUS:
        die(f"{rel}: invalid result.status")
    status_counts[status] += 1
    evidence_sha = result.get("evidence_sha256")
    if status == "PASS" and not SHA256.fullmatch(evidence_sha or ""):
        die(f"{rel}: PASS requires content-addressed evidence_sha256")
    if status == "FAIL" and not result.get("failure_artifact"):
        die(f"{rel}: FAIL requires failure_artifact")

    for tag in tags:
        coverage_any[tag] += 1
        if status == "PASS":
            coverage_pass[tag] += 1

if not cases:
    if manifest["status"] != "NOT_TESTED":
        die("empty corpus must remain NOT_TESTED")
    non_not_tested = [class_id for class_id, status in class_status.items() if status != "NOT_TESTED"]
    if non_not_tested:
        die("empty corpus cannot advance any class beyond NOT_TESTED")
else:
    for class_id, status in class_status.items():
        if status == "PASS" and coverage_pass[class_id] == 0:
            die(f"class {class_id} marked PASS without a passing executed fixture")
        if status == "FAIL" and coverage_any[class_id] == 0:
            die(f"class {class_id} marked FAIL without a represented fixture")

if open_hard and manifest["status"] == "PASS":
    die("corpus cannot be globally PASS while hard source blockers remain open")

summary = {
    "schema_version": 1,
    "gate": "IMMUTABLE_HISTORICAL_CORPUS_CONTRACT",
    "tranche": manifest["tranche"],
    "manifest_status": manifest["status"],
    "protocol_fork_truth": manifest["protocol_fork_truth"],
    "case_count": len(cases),
    "unique_block_hashes": len({anchor[2] for anchor in seen_anchors}),
    "fixture_status_counts": status_counts,
    "required_class_count": len(flat_classes),
    "represented_class_count": sum(1 for value in coverage_any.values() if value),
    "passing_class_count": sum(1 for value in coverage_pass.values() if value),
    "open_hard_source_blockers": sorted(expected_blockers),
    "manifest_sha256": hashlib.sha256(MANIFEST.read_bytes()).hexdigest(),
    "schema_sha256": hashlib.sha256(SCHEMA.read_bytes()).hexdigest(),
}
print(json.dumps(summary, sort_keys=True))
