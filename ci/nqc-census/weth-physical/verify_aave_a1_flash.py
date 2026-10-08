#!/usr/bin/env python3
"""Read-only two-operator Aave v3 Pool flash premium at RMC011 D08 A1 anchor.

This observes the premium, NOT a flash loan quote, a borrow capacity approval
or any third-party/native gas sponsorship.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re

from verify_weth_rpc import (
    BLOCK_NUMBER, BLOCK_HASH, PROVIDERS, CHAIN_ID,
    canonical, checked_header, digest, need, quantity, rpc,
)

POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
PREMIUM_SELECTOR = "0x074b2e43"
WORD32 = re.compile(r"0x[0-9a-fA-F]{64}\Z")
CODE = re.compile(r"0x(?:[0-9a-fA-F]{2})+\Z")


def observe_one(provider: tuple, call=rpc) -> dict:
    provider_id, operator, url = provider
    need(quantity(call(url, "eth_chainId", []), "chain") == CHAIN_ID, "wrong Aave Ethereum chain")
    header = checked_header(call(url, "eth_getBlockByNumber", [hex(BLOCK_NUMBER), False]))
    observed_code = call(url, "eth_getCode", [POOL, hex(BLOCK_NUMBER)])
    need(type(observed_code) is str and CODE.fullmatch(observed_code) is not None,
         "Aave Pool runtime code unavailable")
    raw_code = bytes.fromhex(observed_code[2:])
    need(100 <= len(raw_code) <= 32000, "Aave Pool runtime byte size implausible")
    result = call(
        url, "eth_call",
        [{"to": POOL, "data": PREMIUM_SELECTOR}, hex(BLOCK_NUMBER)],
    )
    need(type(result) is str and WORD32.fullmatch(result) is not None,
         "Aave Pool premium return not exactly one ABI uint")
    premium = int(result, 16)
    need(0 < premium <= 10000, "Aave flash premium outside tested positive bps domain")
    return {
        "provider_id": provider_id, "operator": operator, "anchor": header,
        "pool_code_sha256": hashlib.sha256(raw_code).hexdigest(),
        "pool_code_bytes": len(raw_code),
        "flashloan_premium_total_bps": premium,
    }


def assess(call=rpc, providers=PROVIDERS) -> dict:
    need(len(providers) == 2 and [x[0] for x in providers] == ["drpc", "blast"]
         and providers[0][1] != providers[1][1],
         "independent historical providers required")
    rows = [observe_one(x, call=call) for x in providers]
    need(
        all((r["anchor"], r["pool_code_sha256"], r["pool_code_bytes"],
             r["flashloan_premium_total_bps"]) ==
            (rows[0]["anchor"], rows[0]["pool_code_sha256"], rows[0]["pool_code_bytes"],
             rows[0]["flashloan_premium_total_bps"]) for r in rows),
        "independent providers disagree on historical Aave Pool code or premium",
    )
    r = {
        "schema_version": 1,
        "status": "RMC011_AAVE_POOL_A1_FLASH_PREMIUM_DUAL_OPERATOR_PASS",
        "chain_id": CHAIN_ID, "block_number": BLOCK_NUMBER, "block_hash": BLOCK_HASH,
        "pool": POOL, "weth": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        "premium_bps": rows[0]["flashloan_premium_total_bps"],
        "pool_code_sha256": rows[0]["pool_code_sha256"],
        "provider_evidence": rows,
        "protocol_fee_is_historical_previous_or_current_anchor_observation_only": True,
        "on_chain_liquidity_available_to_nexus_proven": False,
        "flash_principal_borrow_replayed": False,
        "gas_sponsorship_proven": False,
        "zero_own_capital_eligibility_proven": False,
        "complete_liquidation_or_positive_nexus_net_pnl_proven": False,
        "real_market_census_closed": False,
    }
    r["report_sha256"] = digest(canonical(r))
    return r


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    opt = ap.parse_args()
    need(not opt.out.exists(), "must create an append-only historical fee report")
    r = assess()
    opt.out.parent.mkdir(parents=True, exist_ok=True)
    opt.out.write_bytes(canonical(r))
    print(r["status"], "premium_bps", r["premium_bps"], "zero_own_capital_PROVEN=false")


if __name__ == "__main__":
    main()
