#!/usr/bin/env python3
"""NQC: audit actual historical one-shot against SVR bid/gas prerequisites.

Purely offline and content-addressed. NO signing, simulation, deployment, RPC,
wallet, bundle construction, trading permission, bid execution or income claim.
"""
from __future__ import annotations

import argparse
from hashlib import sha1, sha256
import json
from pathlib import Path
import re

ONE_SHOT_PATH = "ci/nqc-census/weth-physical/script/NqcV2OneShotAtomicLocal.s.sol"
# Known on the exact PR738 ancestor; Git blob is independently returned by GitHub.
ONE_SHOT_GIT_BLOB = "129c1bef538c2a459a1a9d393efa837d698bb965"
CERT = {
    "one_shot_local_source_PR": 725,
    "one_shot_envelope_source_PR": 726,
    "causal_EVM_source_PR": 727,
    "local_receipt_gas_used": 3_914_680,
    "local_transaction_gas_limit": 5_089_056,
    "local_surplus_USDC_base_units": 2_273_989_378,
    "local_surplus_already_net_of_flash_and_swap": True,
    "historical_execution_block": 26_142_068,
    "onchain_profit_attributable_to_NQC_USD": "0",
}
HARD_EVIDENCE = (
    'contract NqcV2OneShotAtomicLocal {',
    'FIRST_HISTORICAL_BLOCK = 26_142_067',
    'block.number == FIRST_HISTORICAL_BLOCK ||',
    'block.number == FIRST_HISTORICAL_BLOCK + 1',
    '"HISTORICAL_LOCAL_FORK_ONLY"',
    'originalParentHash',
    'blockhash(FIRST_HISTORICAL_BLOCK - 1)',
    'EXPECTED_USDC_SURPLUS = 2_273_989_378',
    'IERC20FlashMinimal(USDC).transfer(msg.sender, finalProfit)',
    '"LOCAL_ONE_SHOT_TEST_NO_SPONSOR"',
)
WEI = 10**18
GWEI = 10**9
USDC = 10**6
USD_PRICE_SCALE = 10**8


class Reject(ValueError):
    pass


def need(condition: bool, message: str) -> None:
    if not condition:
        raise Reject(message)


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=True) + "\n").encode()


def git_blob(data: bytes) -> str:
    need(type(data) is bytes, "source must be exact bytes")
    return sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def source_truth(data: bytes, *, expected_blob: str = ONE_SHOT_GIT_BLOB) -> dict:
    need(type(data) is bytes and 0 < len(data) <= 250_000,
         "absent/oversized source")
    need(re.fullmatch("[0-9a-f]{40}", expected_blob) is not None,
         "invalid expected source Git object")
    actual = git_blob(data)
    need(actual == expected_blob, "one-shot original source blob drift: no authority")
    try:
        code = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise Reject("invalid original source encoding") from exc
    for anchor in HARD_EVIDENCE:
        need(anchor in code, "missing source-locked original constructor evidence")
    # The constructor has NO dedicated explicit builder ETH payout. A priority
    # fee may nevertheless be specified by an external EIP-1559 tx; this test
    # does not claim all possible validator compensation is literally zero.
    need("block.coinbase" not in code, "unexpected new direct coinbase code")
    return {
        "source_path": ONE_SHOT_PATH,
        "source_sha256": sha256(data).hexdigest(),
        "git_blob_sha1": actual,
        "exact_previously_tested_source": True,
        "hardcoded_historical_block_guard": True,
        "hardcoded_historical_parent_hash_gate": True,
        "hardcoded_exact_USDC_surplus_gate": True,
        "full_profit_swept_to_local_EOA_as_USDC": True,
        "explicit_native_coinbase_payment_in_constructor": False,
        "external_gas_sponsor_certified_by_source": False,
        "production_current_block_admissible": False,
        "source_only_not_full_transitive_import_or_runtime_analysis": True,
    }


def ceil_div(a: int, b: int) -> int:
    need(type(a) is int and type(b) is int and a >= 0 and b > 0,
         "ceil requires positive integer denominator")
    return (a + b - 1) // b


def gas_scenario(*, gas_used: int, gas_limit: int,
                 base_wei: int, tip_wei: int, max_fee_wei: int,
                 eth_usd_raw: int, gross_usdc_base: int,
                 builder_bid_usdc_base: int = 0,
                 financing_usdc_base: int = 0,
                 failure_reserve_usdc_base: int = 0) -> dict:
    vals = (gas_used,gas_limit,base_wei,tip_wei,max_fee_wei,
            eth_usd_raw,gross_usdc_base,builder_bid_usdc_base,
            financing_usdc_base,failure_reserve_usdc_base)
    need(all(type(n) is int and n >= 0 for n in vals),
         "float, negative, bool or noninteger economic field forbidden")
    need(0 < gas_used <= gas_limit <= 40_000_000,
         "invalid certified EVM resource use")
    need(base_wei > 0 and max_fee_wei >= base_wei + tip_wei,
         "EIP1559 fee cap must cover base fee plus chosen priority fee")
    need(eth_usd_raw > 0 and gross_usdc_base > 0,
         "unpriced gas or missing gross source surplus")
    # Fee already covers EIP1559 priority (do not subtract again). The known
    # USDC surplus already includes Aave flash premium + Uniswap swap fee.
    effective = base_wei + tip_wei
    gas_paid_wei = gas_used * effective
    upfront_escrow_wei = gas_limit * max_fee_wei
    conversion_den = WEI * USD_PRICE_SCALE
    gas_usdc_base = ceil_div(gas_paid_wei * eth_usd_raw * USDC, conversion_den)
    external_escrow_usdc_base = ceil_div(upfront_escrow_wei * eth_usd_raw * USDC,
                                         conversion_den)
    margin = (gross_usdc_base - gas_usdc_base - builder_bid_usdc_base -
              financing_usdc_base - failure_reserve_usdc_base)
    headroom = (gross_usdc_base - gas_usdc_base - financing_usdc_base -
                failure_reserve_usdc_base)
    return {
        "gas_used": gas_used,
        "transaction_gas_limit": gas_limit,
        "base_fee_wei_assumed": str(base_wei),
        "priority_fee_wei_assumed": str(tip_wei),
        "max_fee_per_gas_wei_assumed": str(max_fee_wei),
        "eth_usd_raw_8_decimals_assumed": str(eth_usd_raw),
        "local_surplus_USDC_base_units": str(gross_usdc_base),
        "gas_cost_wei_at_assumed_effective_fee": str(gas_paid_wei),
        "minimum_EOA_upfront_gas_escrow_wei_at_max_fee": str(upfront_escrow_wei),
        "minimum_EOA_upfront_gas_escrow_USDC_equivalent_illustrative": str(external_escrow_usdc_base),
        "gas_cost_USDC_base_units_rounded_up": str(gas_usdc_base),
        "explicit_builder_payment_USDC_base_units_assumed": str(builder_bid_usdc_base),
        "sponsor_fee_USDC_base_units_assumed": str(financing_usdc_base),
        "failure_reserve_USDC_base_units_assumed": str(failure_reserve_usdc_base),
        "max_builder_bid_headroom_USDC_base_units_only_if_other_costs_exact": str(max(0,headroom)),
        "hypothetical_residual_USDC_base_units": str(margin),
        "positive_math_not_transaction_admissibility": True,
        "independent_gas_sponsor_verified": False,
        "bid_competitiveness_verified": False,
        "has_received_authorized_oracle_hint_before_cutoff": False,
        "mainnet_inclusion_or_profit_proven": False,
    }


def audit(data: bytes) -> dict:
    truth = source_truth(data)
    scenarios = [
        # Scenarios in gwei, illustrative ETH price $2,500, not original
        # Ethereum source block's authenticated native USD quote.
        {"name":"LOW_BASE_FEE_ILLUSTRATIVE", "base":1, "tip":1, "max":3, "bid":0},
        {"name":"MID_BASE_FEE_WITH_BUILDER_BID_ILLUSTRATIVE",
         "base":5,"tip":2,"max":10,"bid":100*USDC},
        {"name":"HIGH_BASE_FEE_WITH_BUILDER_BID_ILLUSTRATIVE",
         "base":20,"tip":5,"max":35,"bid":500*USDC},
    ]
    results=[]
    for case in scenarios:
        row=gas_scenario(
            gas_used=CERT["local_receipt_gas_used"],
            gas_limit=CERT["local_transaction_gas_limit"],
            base_wei=case["base"]*GWEI,tip_wei=case["tip"]*GWEI,
            max_fee_wei=case["max"]*GWEI,
            eth_usd_raw=2500*USD_PRICE_SCALE,
            gross_usdc_base=CERT["local_surplus_USDC_base_units"],
            builder_bid_usdc_base=case["bid"],
            financing_usdc_base=0,failure_reserve_usdc_base=0)
        row["scenario_name"] = case["name"]
        row["eth_price_is_purely_illustrative_not_historical_source"] = True
        row["builder_bid_not_implemented_by_historical_constructor"] = case["bid"] > 0
        row["unknown_failure_sponsor_ops_costs_excluded"] = True
        results.append(row)
    return {
        "schema_version":1,
        "classification":"BLOCKED_NOT_A_PRODUCTION_SVR_BID_EXECUTOR",
        "source_authority":truth,
        "one_shot_local_evidence":CERT,
        "auction_requirements": {
            "one_oracle_event_hash_followed_by_one_signed_liquidation_tx":True,
            "mev_share_at_most_one_backrun_tx":True,
            "needs_prospective_source_local_hint":True,
            "needs_mainnet_current_block_eligible_route":True,
            "needs_executable_native_gas_payer_or_sponsor":True,
            "needs_competitive_builder_auction_value":True,
            "needs_builder_cutoff_authority":True,
        },
        "financial_experiments_only":results,
        "source_bridge_to_production": {
            "historical_guard_must_be_replaced_and_recertified":True,
            "current_evm_execution_replay_on_out_of_sample_account_required":True,
            "full_candidate_net_ev_after_bid_and_finance_required":True,
            "native_gas_payer_no_recourse_contract_required":True,
            "bid_path_in_execution_atomicity_must_be_proven":True,
            "live_signed_bundle_canary_authorized":False,
        },
        "PFT_closed":True,
        "RMC_closed":False,
        "Shadow_P2_certified":False,
        "LIVE_authorized":False,
        "OWN_CAPITAL_zero_including_gas_mandate_unchanged":True,
        "NQC_realized_PNL_USD":"0",
        "commercial_score_upgraded":False,
        "external_transactions_sent":False,
        "wallet_or_private_keys_used":False,
        "signed_transactions_or_bids_made":False,
        "new_paid_provider_or_infrastructure":False,
    }


def main() -> None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--source",required=True,type=Path)
    parser.add_argument("--out",required=True,type=Path)
    args=parser.parse_args()
    need(args.source.is_file(),"missing original source")
    need(not args.out.exists() and args.out.parent.is_dir(),
         "output must be new file under existing directory")
    result=audit(args.source.read_bytes())
    with args.out.open("xb") as stream:
        stream.write(canonical(result))
    print(result["classification"],"scenarios",len(result["financial_experiments_only"]))

if __name__ == "__main__":
    main()
