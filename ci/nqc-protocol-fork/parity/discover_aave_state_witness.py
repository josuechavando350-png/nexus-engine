#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CORPUS = ROOT / "ci" / "nqc-protocol-fork" / "corpus" / "manifest.json"
TRUTH = ROOT / "ci" / "nqc-protocol-fork" / "PROTOCOL_FORK_TRUTH_CONTRACT.json"
DISCOVERY = ROOT / "ci" / "nqc-protocol-fork" / "discovery" / "aave_candidates.json"
OUT = Path(os.environ.get("NQC_PFT_AAVE_STATE_OUT", "/tmp/nqc-pft-aave-state"))
REQUEST_TIMEOUT = 20
USER_AGENT = "nqc-protocol-fork-truth/aave-state-witness-v1"
SOURCE_SHA = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()

SIGNATURES = (
    "getUserConfiguration(address)",
    "getUserEMode(address)",
    "getUserAccountData(address)",
)


def fail(message: str) -> None:
    raise SystemExit(message)


def load(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception as exc:
        fail(f"{path}: invalid JSON: {exc}")


def rpc(url: str, method: str, params: list, request_id: int):
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
        separators=(",", ":"),
    ).encode()
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": USER_AGENT,
        },
        method="POST",
    )
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                body = json.loads(response.read())
            if "error" in body:
                raise RuntimeError(f"rpc error: {body['error']}")
            if "result" not in body:
                raise RuntimeError("missing result")
            return body["result"]
        except Exception as exc:
            last = exc
            if attempt != 2:
                time.sleep(1 + attempt)
    raise RuntimeError(str(last))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def address_arg(address: str) -> str:
    value = address.lower()
    if not value.startswith("0x") or len(value) != 42:
        raise ValueError(f"invalid address {address}")
    return value[2:].rjust(64, "0")


def decode_words(value: str, count: int, label: str) -> list[int]:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise RuntimeError(f"{label}: invalid ABI result")
    payload = value[2:]
    if len(payload) != count * 64:
        raise RuntimeError(
            f"{label}: expected {count} ABI words, received {len(payload) // 64}"
        )
    return [int(payload[i : i + 64], 16) for i in range(0, len(payload), 64)]


def exact_state_rpc(
    url: str,
    method: str,
    leading_params: list,
    block_hash: str,
    block_number: int,
    request_id: int,
):
    block_number_hex = hex(block_number)
    exact_hash = {"blockHash": block_hash, "requireCanonical": True}
    try:
        result = rpc(url, method, leading_params + [exact_hash], request_id)
        return result, "EIP1898_BLOCK_HASH"
    except Exception as hash_error:
        before = rpc(
            url,
            "eth_getBlockByNumber",
            [block_number_hex, False],
            request_id + 1,
        )
        if not before or before.get("hash", "").lower() != block_hash.lower():
            raise RuntimeError(
                f"EIP-1898 failure ({hash_error}); pre-call block-number hash guard failed"
            )
        result = rpc(
            url,
            method,
            leading_params + [block_number_hex],
            request_id + 2,
        )
        after = rpc(
            url,
            "eth_getBlockByNumber",
            [block_number_hex, False],
            request_id + 3,
        )
        if not after or after.get("hash", "").lower() != block_hash.lower():
            raise RuntimeError("post-call block-number hash guard failed")
        return result, "BLOCK_NUMBER_WITH_PRE_POST_HASH_GUARD"


def derive_selectors(providers: list[dict], minimum: int) -> tuple[dict, dict]:
    selectors = {}
    evidence = {}
    for signature_index, signature in enumerate(SIGNATURES, start=1):
        payload = "0x" + signature.encode().hex()
        observations = []
        for provider_index, provider in enumerate(providers, start=1):
            try:
                digest = rpc(
                    provider["url"],
                    "web3_sha3",
                    [payload],
                    10_000 + signature_index * 100 + provider_index,
                )
                if not isinstance(digest, str) or not digest.startswith("0x") or len(digest) != 66:
                    raise RuntimeError("invalid web3_sha3 digest")
                observations.append(
                    {
                        "provider_id": provider["id"],
                        "selector": digest[:10].lower(),
                        "digest": digest.lower(),
                    }
                )
            except Exception as exc:
                observations.append(
                    {"provider_id": provider["id"], "error": str(exc)}
                )

        successful = [item for item in observations if "selector" in item]
        if len(successful) < minimum:
            fail(
                f"{signature}: only {len(successful)} selector providers; "
                f"{minimum} required"
            )
        counts = Counter(item["selector"] for item in successful)
        selector, count = counts.most_common(1)[0]
        if count != len(successful):
            fail(f"{signature}: selector-provider dissent: {successful}")
        selectors[signature] = selector
        evidence[signature] = observations
    return selectors, evidence


def read_user_state(
    url: str,
    pool: str,
    borrower: str,
    selectors: dict,
    block_hash: str,
    block_number: int,
    request_id: int,
):
    encoded = address_arg(borrower)
    modes = []

    raw_config, mode = exact_state_rpc(
        url,
        "eth_call",
        [{"to": pool, "data": selectors["getUserConfiguration(address)"] + encoded}],
        block_hash,
        block_number,
        request_id,
    )
    modes.append(mode)
    config = decode_words(raw_config, 1, "getUserConfiguration")[0]

    raw_emode, mode = exact_state_rpc(
        url,
        "eth_call",
        [{"to": pool, "data": selectors["getUserEMode(address)"] + encoded}],
        block_hash,
        block_number,
        request_id + 10,
    )
    modes.append(mode)
    emode = decode_words(raw_emode, 1, "getUserEMode")[0]
    if emode > 255:
        raise RuntimeError(f"eMode category outside u8 range: {emode}")

    raw_account, mode = exact_state_rpc(
        url,
        "eth_call",
        [{"to": pool, "data": selectors["getUserAccountData(address)"] + encoded}],
        block_hash,
        block_number,
        request_id + 20,
    )
    modes.append(mode)
    account = decode_words(raw_account, 6, "getUserAccountData")

    return {
        "user_configuration_raw": str(config),
        "e_mode_category": emode,
        "total_collateral_base": str(account[0]),
        "total_debt_base": str(account[1]),
        "available_borrows_base": str(account[2]),
        "current_liquidation_threshold_bps": account[3],
        "ltv_bps": account[4],
        "health_factor_wad": str(account[5]),
        "state_access_modes": sorted(set(modes)),
    }


corpus = load(CORPUS)
truth = load(TRUTH)
discovery = load(DISCOVERY)
if corpus.get("schema_version") != 1:
    fail("corpus must be schema v1")
truth_status = truth.get("status")
if truth_status == "NOT_TESTED":
    if corpus.get("status") != "NOT_TESTED":
        fail("NOT_TESTED truth requires NOT_TESTED corpus")
    required_fixture_status = "NOT_TESTED"
elif truth_status == "RUNTIME_CLOSEOUT_CANDIDATE_READY":
    if corpus.get("status") != "PASS":
        fail("closeout-candidate truth requires PASS corpus")
    class_statuses = [
        item.get("status")
        for domain in corpus.get("required_classes", {}).values()
        for item in domain
    ]
    if not class_statuses or any(status != "PASS" for status in class_statuses):
        fail("closeout-candidate truth requires every corpus class PASS")
    required_fixture_status = "PASS"
else:
    fail(f"unsupported truth contract status {truth_status!r}")
if corpus.get("protocol_fork_truth") != "NOT_CLOSED":
    fail("Protocol/Fork Truth must remain NOT_CLOSED")
if not corpus.get("cases"):
    fail("Aave state witness requires admitted corpus cases")

providers = discovery.get("providers", [])
minimum = int(discovery["discovery_policy"]["minimum_exact_state_providers"])
if minimum < 2:
    fail("minimum exact-state provider threshold must be >=2")
pool = discovery["protocol"]["pool"].lower()

OUT.mkdir(parents=True, exist_ok=True)
(OUT / "cases").mkdir(exist_ok=True)

selectors, selector_evidence = derive_selectors(providers, minimum)
(OUT / "selector-consensus.json").write_text(
    json.dumps(
        {
            "schema_version": 1,
            "selectors": selectors,
            "observations": selector_evidence,
        },
        indent=2,
        sort_keys=True,
    )
    + "\n"
)

summaries = []
for case_index, rel in enumerate(corpus["cases"], start=1):
    fixture = load(ROOT / rel)
    if fixture.get("strategy_family") != "liquidation":
        continue
    if fixture["result"]["status"] != required_fixture_status:
        fail(
            f"{rel}: fixture status {fixture['result']['status']!r} does not match "
            f"truth phase requirement {required_fixture_status!r}"
        )
    if fixture["source_commit"] != corpus["source_binding"]["physical_checkpoint"]:
        fail(f"{rel}: fixture/source checkpoint mismatch")

    block_number = fixture["block_number"]
    block_hash = fixture["block_hash"].lower()
    parent_hash = fixture["parent_hash"].lower()
    borrowers = sorted(
        {entry["borrower"].lower() for entry in fixture["account"]["observed_liquidations"]}
    )
    provider_observations = []

    for provider_index, provider in enumerate(providers, start=1):
        record = {
            "provider_id": provider["id"],
            "provider_url_sha256": sha256_text(provider["url"]),
            "valid": False,
        }
        try:
            chain_id = int(
                rpc(provider["url"], "eth_chainId", [], case_index * 100_000 + provider_index),
                16,
            )
            if chain_id != fixture["chain_id"]:
                raise RuntimeError(f"chain id {chain_id} != {fixture['chain_id']}")

            block = rpc(
                provider["url"],
                "eth_getBlockByHash",
                [block_hash, False],
                case_index * 100_000 + provider_index + 100,
            )
            if not block:
                raise RuntimeError("block by hash unavailable")
            if int(block["number"], 16) != block_number:
                raise RuntimeError("block number mismatch")
            if block.get("parentHash", "").lower() != parent_hash:
                raise RuntimeError("parent hash mismatch")

            code, code_mode = exact_state_rpc(
                provider["url"],
                "eth_getCode",
                [pool],
                block_hash,
                block_number,
                case_index * 100_000 + provider_index + 200,
            )
            if code in ("0x", "0x0", ""):
                raise RuntimeError("Aave Pool code unavailable at exact anchor")

            states = {}
            for borrower_index, borrower in enumerate(borrowers, start=1):
                states[borrower] = read_user_state(
                    provider["url"],
                    pool,
                    borrower,
                    selectors,
                    block_hash,
                    block_number,
                    case_index * 1_000_000
                    + provider_index * 10_000
                    + borrower_index * 100,
                )

            record.update(
                {
                    "valid": True,
                    "block_number": block_number,
                    "block_hash": block_hash,
                    "parent_hash": parent_hash,
                    "timestamp": int(block["timestamp"], 16),
                    "pool_code_sha256": sha256_text(code.lower()),
                    "pool_code_access_mode": code_mode,
                    "borrowers": states,
                }
            )
        except Exception as exc:
            record["error"] = str(exc)
        provider_observations.append(record)

    valid = [record for record in provider_observations if record["valid"]]
    if len(valid) < minimum:
        fail(
            f"{fixture['case_id']}: only {len(valid)} exact-state providers; "
            f"{minimum} required"
        )

    anchor_keys = [
        (
            record["block_number"],
            record["block_hash"],
            record["parent_hash"],
            record["timestamp"],
            record["pool_code_sha256"],
        )
        for record in valid
    ]
    anchor, anchor_count = Counter(anchor_keys).most_common(1)[0]
    if anchor_count != len(valid):
        fail(f"{fixture['case_id']}: provider anchor/code dissent")

    consensus_users = {}
    for borrower in borrowers:
        states = [record["borrowers"][borrower] for record in valid]
        normalized = [
            (
                state["user_configuration_raw"],
                state["e_mode_category"],
                state["total_collateral_base"],
                state["total_debt_base"],
                state["available_borrows_base"],
                state["current_liquidation_threshold_bps"],
                state["ltv_bps"],
                state["health_factor_wad"],
            )
            for state in states
        ]
        state_key, state_count = Counter(normalized).most_common(1)[0]
        if state_count != len(valid):
            fail(
                f"{fixture['case_id']} {borrower}: canonical-state provider dissent"
            )
        consensus_users[borrower] = {
            "user_configuration_raw": state_key[0],
            "e_mode_category": state_key[1],
            "total_collateral_base": state_key[2],
            "total_debt_base": state_key[3],
            "available_borrows_base": state_key[4],
            "current_liquidation_threshold_bps": state_key[5],
            "ltv_bps": state_key[6],
            "health_factor_wad": state_key[7],
        }

    case_evidence = {
        "schema_version": 1,
        "gate": "AAVE_CANONICAL_STATE_WITNESS_DISCOVERY",
        "source_sha": SOURCE_SHA,
        "fixture_path": rel,
        "fixture_case_id": fixture["case_id"],
        "fixture_source_commit": fixture["source_commit"],
        "chain_id": fixture["chain_id"],
        "block_number": block_number,
        "block_hash": block_hash,
        "parent_hash": parent_hash,
        "pool": pool,
        "selector_consensus": selectors,
        "valid_provider_count": len(valid),
        "valid_providers": sorted(record["provider_id"] for record in valid),
        "borrower_count": len(borrowers),
        "canonical_users": consensus_users,
        "provider_observations": provider_observations,
        "fixture_result": fixture["result"]["status"],
        "nqc_reader_parity": "NOT_TESTED",
        "nqc_math_parity": "NOT_TESTED",
        "protocol_fork_truth": "NOT_CLOSED",
    }
    case_path = OUT / "cases" / f"{fixture['case_id']}.json"
    case_path.write_text(json.dumps(case_evidence, indent=2, sort_keys=True) + "\n")
    summaries.append(
        {
            "case_id": fixture["case_id"],
            "block_number": block_number,
            "block_hash": block_hash,
            "borrower_count": len(borrowers),
            "valid_provider_count": len(valid),
            "case_evidence_sha256": hashlib.sha256(case_path.read_bytes()).hexdigest(),
            "nqc_reader_parity": "NOT_TESTED",
        }
    )

summary = {
    "schema_version": 1,
    "gate": "AAVE_CANONICAL_STATE_WITNESS_DISCOVERY",
    "source_sha": SOURCE_SHA,
    "case_count": len(summaries),
    "cases": summaries,
    "selectors": selectors,
    "fixture_mutation": False,
    "aave_state_parity": "NOT_TESTED",
    "aave_math_parity": "NOT_TESTED",
    "revm_fork_parity": "NOT_TESTED",
    "protocol_fork_truth": "NOT_CLOSED",
    "real_market_census": "NOT_TESTED",
    "live_pnl_evidence": False,
    "production_certification": "NOT_CERTIFIED",
}
(OUT / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
print(json.dumps(summary, sort_keys=True))
