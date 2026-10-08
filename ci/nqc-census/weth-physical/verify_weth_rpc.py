#!/usr/bin/env python3
"""Independent historical WETH9 code/anchor witness at the RMC-008 A1 snapshot.

Read-only calls on fixed public RPCs. Does not fund, send, sign or execute a
transaction, certify D08 token admission or claim Nexus realized profitability.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

CHAIN_ID = 1
BLOCK_NUMBER = 26095351
BLOCK_HASH = "0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781"
WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
PROVIDERS = (
    ("drpc", "dRPC", "https://eth.drpc.org"),
    ("blast", "BlastAPI", "https://eth-mainnet.public.blastapi.io"),
)
HEX32 = re.compile(r"0x[0-9a-f]{64}\Z")
HEX_BYTES = re.compile(r"0x(?:[0-9a-f]{2})+\Z")
HEX_QUANTITY = re.compile(r"0x(?:0|[1-9a-f][0-9a-f]*)\Z")
MAX_JSON = 5_000_000


def need(ok: bool, reason: str) -> None:
    if not ok:
        raise ValueError(reason)


def canonical(obj: object) -> bytes:
    return (json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def quantity(value: object, name: str) -> int:
    need(type(value) is str and HEX_QUANTITY.fullmatch(value) is not None, name + " invalid")
    return int(value, 16)


def checked_header(raw: object) -> dict:
    need(type(raw) is dict, "historical block header absent")
    need(quantity(raw.get("number"), "block number") == BLOCK_NUMBER, "wrong block number")
    need(raw.get("hash") == BLOCK_HASH, "historical block hash/reorg mismatch")
    parent = raw.get("parentHash")
    root = raw.get("stateRoot")
    need(type(parent) is str and HEX32.fullmatch(parent) is not None, "parent hash malformed")
    need(type(root) is str and HEX32.fullmatch(root) is not None, "state root malformed")
    timestamp = quantity(raw.get("timestamp"), "block timestamp")
    need(timestamp > 0, "block timestamp missing")
    return {
        "block_number": BLOCK_NUMBER, "block_hash": BLOCK_HASH,
        "parent_hash": parent, "state_root": root, "timestamp": timestamp,
    }


def checked_weth_code(raw: object) -> dict:
    need(type(raw) is str and HEX_BYTES.fullmatch(raw) is not None, "WETH runtime code malformed")
    code = bytes.fromhex(raw[2:])
    need(len(code) >= 100 and len(code) <= 32000, "WETH runtime code length implausible")
    return {"runtime_sha256": digest(code), "runtime_bytes": len(code)}


def rpc(url: str, method: str, params: list) -> object:
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        separators=(",", ":"),
    ).encode()
    req = Request(
        url, data=payload, method="POST",
        headers={"Accept": "application/json", "Content-Type": "application/json",
                 "User-Agent": "NQC-RMC011-Historical-WETH-ReadOnly/1.0"},
    )
    for attempt in range(2):
        try:
            with urlopen(req, timeout=22) as stream:
                raw = stream.read(MAX_JSON + 1)
            need(len(raw) <= MAX_JSON, "RPC response exceeds 5MB")
            doc = json.loads(raw)
            need(type(doc) is dict and doc.get("jsonrpc") == "2.0" and doc.get("id") == 1,
                 "JSON RPC envelope malformed")
            need("error" not in doc and "result" in doc, "historical RPC returned error")
            return doc["result"]
        except (HTTPError, URLError, TimeoutError, ValueError) as exc:
            if attempt == 1 or isinstance(exc, HTTPError) and exc.code in (400, 401, 403, 404):
                raise ValueError(method + " transport unavailable: " +
                                 type(exc).__name__ + ": " + str(exc)[:160]) from exc
            time.sleep(2)
    raise AssertionError("unreachable")


def query_operator(provider: tuple, call=rpc) -> dict:
    name, operator, url = provider
    need(quantity(call(url, "eth_chainId", []), "chain id") == CHAIN_ID, "wrong Ethereum chain")
    header = checked_header(call(url, "eth_getBlockByNumber", [hex(BLOCK_NUMBER), False]))
    code = checked_weth_code(call(url, "eth_getCode", [WETH, hex(BLOCK_NUMBER)]))
    return {"provider_id": name, "operator": operator, "anchor": header, **code}


def assess(call=rpc, providers=PROVIDERS) -> dict:
    need(len(providers) == 2 and [p[0] for p in providers] == ["drpc", "blast"] and
         len({p[1] for p in providers}) == 2, "two distinct canonical provider operators required")
    results = [query_operator(p, call=call) for p in providers]
    first, second = results
    need(
        (first["anchor"], first["runtime_sha256"], first["runtime_bytes"]) ==
        (second["anchor"], second["runtime_sha256"], second["runtime_bytes"]),
        "independent operators disagree on WETH code or historical block state",
    )
    report = {
        "schema_version": 1,
        "status": "RMC011_WETH_ANCHORED_DUAL_OPERATOR_RUNTIME_WITNESS_PASS",
        "source_scope": "SINGLE_ETHEREUM_A1_BLOCK_WETH_CODE_IDENTITY_ONLY",
        "chain_id": CHAIN_ID, "block_number": BLOCK_NUMBER, "block_hash": BLOCK_HASH,
        "weth_address": WETH,
        "operators": results,
        "cross_operator_code_identity_and_header_consensus": True,
        "weth_runtime_sha256": first["runtime_sha256"],
        "weth_runtime_bytes": first["runtime_bytes"],
        "actual_transfer_approval_deposit_withdraw_fork_replayed": False,
        "nqc_token_execution_admission_certified": False,
        "nqc_flash_loan_or_liquidation_proven": False,
        "external_gas_sponsorship_proven": False,
        "own_capital_zero_execution_proven": False,
        "nexus_realized_pnl_proven": False,
        "real_market_census_closed": False,
    }
    report["report_sha256"] = digest(canonical(report))
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    options = parser.parse_args()
    need(not options.out.exists(), "append-only evidence output required")
    report = assess()
    options.out.parent.mkdir(parents=True, exist_ok=True)
    options.out.write_bytes(canonical(report))
    print(report["status"], "block", BLOCK_NUMBER, "runtime_sha256",
          report["weth_runtime_sha256"], "token_admission=false")


if __name__ == "__main__":
    main()
