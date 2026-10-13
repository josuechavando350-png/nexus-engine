#!/usr/bin/env python3
"""Independent, READ-ONLY, fail-closed Aave borrower snapshot.

Requires agreement between two independent public Ethereum JSON-RPC services.
Never constructs, signs, broadcasts or simulates a transaction; never
certifies a prospective crossing, capital source or executable profit.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.request import Request, urlopen

CHAIN_ID = 1
AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
BORROWER = "0x08c14b32c8a48894e4b933090ebcc9ce33b21135"
# keccak256("getUserAccountData(address)")[:4]
SELECTOR = "0xbf92857c"
WAD = 10**18
RPCS = ("https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com")
FIELDS = ("total_collateral_base", "total_debt_base", "available_borrows_base",
          "current_liquidation_threshold", "ltv", "health_factor_wad")
HEX64 = re.compile(r"^0x[0-9a-fA-F]{64}$")


class EvidenceError(ValueError):
    pass


def demand(ok: bool, why: str) -> None:
    if not ok:
        raise EvidenceError(why)


def rpc(endpoint: str, method: str, params: list) -> object:
    # Only fixed read-only JSON-RPC methods are permitted.
    demand(method in {"eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_call"}, "unsupported RPC method")
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = Request(endpoint, data=body, method="POST", headers={"Content-Type": "application/json", "User-Agent": "NQC-RMC-V2-read-only-state-observer/1"})
    with urlopen(req, timeout=13) as response:
        demand(response.status == 200, "HTTP_NON_200")
        value = json.loads(response.read(1024 * 1024).decode())
    demand(isinstance(value, dict) and value.get("jsonrpc") == "2.0" and value.get("id") == 1, "invalid JSON-RPC response")
    demand("error" not in value and "result" in value, "RPC_ERROR_OR_MISSING_RESULT")
    return value["result"]


def calldata(borrower: str) -> str:
    demand(bool(re.fullmatch(r"0x[0-9a-fA-F]{40}", borrower)), "invalid borrower")
    return SELECTOR + ("0" * 24) + borrower[2:].lower()


def parse_account(result: object) -> dict[str, int]:
    demand(isinstance(result, str) and result.startswith("0x") and len(result) == 2 + 6 * 64, "Aave six-word return required")
    demand(bool(re.fullmatch(r"0x[0-9a-fA-F]+", result)), "invalid Aave hex result")
    values = [int(result[2 + i * 64:2 + (i + 1) * 64], 16) for i in range(6)]
    return dict(zip(FIELDS, values))


def check_block(b: object, height: int) -> dict:
    demand(isinstance(b, dict), "RPC returned no block")
    demand(int(b.get("number", "-1"), 16) == height, "wrong block height")
    demand(isinstance(b.get("hash"), str) and bool(HEX64.fullmatch(b["hash"])), "missing block hash")
    demand(isinstance(b.get("parentHash"), str) and bool(HEX64.fullmatch(b["parentHash"])), "missing parent hash")
    demand(isinstance(b.get("timestamp"), str) and b["timestamp"].startswith("0x"), "missing block timestamp")
    return {"number": height, "hash": b["hash"].lower(), "parent_hash": b["parentHash"].lower(), "timestamp": int(b["timestamp"], 16)}


def observe(endpoints: tuple[str, str] = RPCS) -> dict:
    demand(len(endpoints) == 2 and len(set(endpoints)) == 2, "two independent RPC endpoints required")
    chain = [rpc(p, "eth_chainId", []) for p in endpoints]
    demand(chain == [hex(CHAIN_ID)] * 2, "chain ID disagreement")
    heads = [int(rpc(p, "eth_blockNumber", []), 16) for p in endpoints]
    demand(abs(heads[0] - heads[1]) <= 12, "RPC head lag/divergence")
    height = min(heads) - 3
    demand(height > 0, "invalid common height")
    block_tag = hex(height)
    blocks = [check_block(rpc(p, "eth_getBlockByNumber", [block_tag, False]), height) for p in endpoints]
    demand(blocks[0] == blocks[1], "independent RPC block consensus failed")
    block = blocks[0]
    call = {"from": "0x0000000000000000000000000000000000000000", "to": AAVE_POOL, "data": calldata(BORROWER)}
    reads = [rpc(p, "eth_call", [call, block_tag]) for p in endpoints]
    demand(reads[0] == reads[1], "Aave account response disagrees across RPCs")
    account = parse_account(reads[0])
    demand(0 <= account["ltv"] <= 10_000 and 0 <= account["current_liquidation_threshold"] <= 10_000, "invalid reserve risk params")
    # Catch chain reorg during the two eth_call reads; block hash must still match.
    post = [check_block(rpc(p, "eth_getBlockByNumber", [block_tag, False]), height) for p in endpoints]
    demand(post == blocks, "block changed/reorg during snapshot")
    hf = account["health_factor_wad"]
    status = "HF_BELOW_ONE_STATE_OBSERVED" if account["total_debt_base"] > 0 and hf < WAD else "HF_NOT_BELOW_ONE_STATE_OBSERVED"
    result = {
        "schema_version": 1,
        "contract": "NQC_V2_DUAL_RPC_AAVE_STATE_WITNESS_READ_ONLY",
        "status": status,
        "observed_at_utc": datetime.now(timezone.utc).isoformat(),
        "chain_id": CHAIN_ID,
        "block": block,
        "source_rpc_domains": [p.split("/")[2] for p in endpoints],
        "rpc_head_blocks": heads,
        "aave_pool": AAVE_POOL,
        "borrower": BORROWER,
        "selector": SELECTOR,
        "account_data": {k: str(v) for k, v in account.items()},
        "health_factor_decimal": str(Decimal(hf) / WAD),
        "health_factor_lt_one": account["total_debt_base"] > 0 and hf < WAD,
        "raw_account_eth_call_sha256": hashlib.sha256(reads[0].lower().encode()).hexdigest(),
        "rpc_consensus": "TWO_ENDPOINT_IDENTICAL_AT_PINNED_BLOCK_WITH_POST_READ_REORG_CHECK",
        "non_claims": ["NOT_PROSPECTIVE_CROSSING_PROOF", "NOT_ROUTE_OR_CAPITAL_PROOF", "NOT_D11_D17_TERMINAL_AUTHORITY", "NOT_SHADOW_CAPTURE", "NOT_LIVE_PNL"],
    }
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    try:
        report = observe()
        ret = 0
    except Exception as exc:  # Preserve a negative artifact even on provider outage.
        report = {"schema_version": 1, "contract": "NQC_V2_DUAL_RPC_AAVE_STATE_WITNESS_READ_ONLY",
                  "status": "UNVERIFIED_RPC_OR_STATE", "observed_at_utc": datetime.now(timezone.utc).isoformat(),
                  "error_type": type(exc).__name__, "error": str(exc)[:300],
                  "health_factor_lt_one": None, "non_claims": ["NO_VERIFIED_HEALTH_FACTOR", "NOT_PROSPECTIVE_CROSSING_PROOF", "NOT_LIVE_PNL"]}
        ret = 2
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(report["status"] + " evidence=" + str(target))
    return ret


if __name__ == "__main__":
    sys.exit(main())
