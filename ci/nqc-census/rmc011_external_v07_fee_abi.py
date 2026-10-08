#!/usr/bin/env python3
"""RMC011: real deployed SingletonPaymasterV7 public ERC20 fee primitives.

This is a read-only historical *mathematical* ABI witness, NOT a signed quote,
provider policy, token acceptance list, provider native-funding allocation,
postOp collection or a production fee offer to Nexus.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

from rmc016_probe_historical_rpc import rpc, PROVIDERS

BLOCK = 25938047
BLOCK_HASH = "0x42cf44b75185587327a1aa8fc859cc5f49a639e7256547511430d6068b6f09ab"
PAYMASTER = "0x777777777777aec03fd955926dbf81597e66834c"
ENTRYPOINT = "0x0000000071727de22e5e9d8baf0edac6f37da032"
PAYMASTER_CODE_SHA256 = "7072ea9287df0e632703bb6c410be3bbfbcaff40bdcb6e6136a982d05dac5bd1"
HISTORICAL_DEPLOYED_CODE_EVIDENCE_ZIP_SHA256 = "f647e86f3a53a33612df214987a09f89eb22f46f86629972247eb2f641b743f9"
UPSTREAM_SINGLETON_V07_SOURCE_BLOB_SHA1 = "344bde651e1f8a3954532b207f4bc11635100696"
UPSTREAM_SINGLETON_BASE_SOURCE_BLOB_SHA1 = "cc0fab63d188d6bfca6200236ff3e7e88c3f57b0"
UPSTREAM_PIMLICO_README_BLOB_SHA1 = "5454391aa7a37d464191772cc927ba1e5709be5c"
SELECTOR_GET_COST_IN_TOKEN = "0x5525dcfb"
SELECTOR_EXPECTED_PENALTY = "0xfeaf513e"
USER_OPERATION_WETH_SURPLUS_WEI = 90814117763741536
PRICE_WEI_PER_GAS = 2059451728  # Hypothetical TEST UserOp price in historic v0.7 fork.
ILLUSTRATIVE_GAS_ALREADY_SPENT_WEI = 1640905234415104
NO_EXTERNAL_QUOTE = "HISTORICAL_READONLY_ABI_SENSITIVITY_NOT_PIMLICO_OFFER"
RATE_WETH_FOR_1_ETH = 10**18
UINT_HEX = re.compile(r"0x(?:0|[1-9a-f][0-9a-f]*)\Z")
WORD32 = re.compile(r"0x[0-9a-fA-F]{64}\Z")
HEX32 = re.compile(r"0x[0-9a-f]{64}\Z")
RUNTIME = re.compile(r"0x(?:[0-9a-fA-F]{2})+\Z")

# A range of entirely *unsolicited hypothetical* test gas caps, NOT quotes.
SCENARIOS = (
    ("NO_EXTRA_LIMIT", 0, 0, 0),
    ("SMALL_LIMIT", 100_000, 450_000, 900_000),
    ("LARGE_LIMIT", 200_000, 450_000, 2_000_000),
    ("EXTREME_LIMIT", 300_000, 450_000, 2_400_000),
)


def need(ok, msg):
    if not ok:
        raise ValueError(msg)


def canonical(obj):
    return (json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)+"\n").encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def quantity(v, name):
    need(type(v) is str and UINT_HEX.fullmatch(v) is not None,
         name+": invalid canonical Ethereum quantity")
    return int(v,16)


def word(v, name):
    need(type(v) is str and WORD32.fullmatch(v) is not None,
         name+": invalid canonical uint256 ABI word")
    return int(v,16)


def encode(selector, *numbers):
    need(selector in (SELECTOR_GET_COST_IN_TOKEN, SELECTOR_EXPECTED_PENALTY),
         "unknown Ethereum contract ABI selector")
    need(all(type(x) is int and 0 <= x < 2**256 for x in numbers),
         "ABI uint argument not admissible")
    need(len(numbers) == (4 if selector == SELECTOR_GET_COST_IN_TOKEN else 5),
         "ABI arity mismatch")
    return selector + "".join(f"{x:064x}" for x in numbers)


def quote_cost_math(actual_gas_cost, post_op_gas, actual_fee_per_gas, exchange_rate):
    return (actual_gas_cost + post_op_gas*actual_fee_per_gas)*exchange_rate//10**18


def quote_penalty_math(actual_gas_cost, actual_fee_per_gas,
                       post_op_gas, pre_op_gas, execution_limit):
    need(actual_fee_per_gas>0,"gas price denominator zero")
    actual_gas = actual_gas_cost//actual_fee_per_gas + post_op_gas
    execution_used = max(0, actual_gas-pre_op_gas)
    penalty_gas = max(0, execution_limit-execution_used)*10//100
    return penalty_gas*actual_fee_per_gas


def observed_one(provider, *, call=rpc):
    key,operator,url=provider
    need(call(url,"eth_chainId",[])=="0x1","provider wrong network")
    block=call(url,"eth_getBlockByNumber",[hex(BLOCK),False])
    need(type(block) is dict and quantity(block.get("number"),"block")==BLOCK
         and block.get("hash")==BLOCK_HASH,"historical Ethereum block mismatch/reorg")
    for name in ("parentHash","stateRoot"):
        need(type(block.get(name)) is str and HEX32.fullmatch(block[name]) is not None,
             "historical block missing "+name)
    code=call(url,"eth_getCode",[PAYMASTER,hex(BLOCK)])
    need(type(code) is str and RUNTIME.fullmatch(code) is not None,
         "real paymaster historical bytecode absent")
    code_bytes=bytes.fromhex(code[2:])
    need(len(code_bytes)>=1000 and digest(code_bytes)==PAYMASTER_CODE_SHA256,
         "historical SingletonPaymasterV7 runtime source identity mismatch")

    rows=[]
    for name,postop,preop,limit in SCENARIOS:
        penalty_input=(ILLUSTRATIVE_GAS_ALREADY_SPENT_WEI,PRICE_WEI_PER_GAS,
                       postop,preop,limit)
        penalty_data=encode(SELECTOR_EXPECTED_PENALTY,*penalty_input)
        penalty=word(call(url,"eth_call",[
            {"to":PAYMASTER,"data":penalty_data},hex(BLOCK)
        ]),"real _expectedPenaltyGasCost")
        expected_penalty=quote_penalty_math(*penalty_input)
        need(penalty==expected_penalty,
             "real deployed paymaster penalty deviates from pinned source expression")
        inclusive_illustrative_cost=ILLUSTRATIVE_GAS_ALREADY_SPENT_WEI+penalty
        quote_input=(inclusive_illustrative_cost,postop,
                     PRICE_WEI_PER_GAS,RATE_WETH_FOR_1_ETH)
        quote_data=encode(SELECTOR_GET_COST_IN_TOKEN,*quote_input)
        quoted=word(call(url,"eth_call",[
            {"to":PAYMASTER,"data":quote_data},hex(BLOCK)
        ]),"real getCostInToken")
        expected_cost=quote_cost_math(*quote_input)
        need(quoted==expected_cost,
             "real deployed paymaster token price deviates from pinned source expression")
        rows.append({
            "illustrative_case":name,
            "illustrative_postop_gas_units":postop,
            "illustrative_preop_gas_approximation_units":preop,
            "illustrative_execution_gas_limit_units":limit,
            "real_abi_expected_penalty_gas_cost_wei":str(penalty),
            "real_abi_get_cost_in_weth_wei_at_1to1_test_rate":str(quoted),
            "illustrative_weth_after_deployed_math_before_all_other_costs_wei":
                str(USER_OPERATION_WETH_SURPLUS_WEI-quoted),
            "real_signed_provider_exchange_rate_used":False,
            "provider_signed_weth_userop_authorized":False,
            "premium_or_constant_fee_from_provider_known":False,
            "nqc_gas_sponsorship_or_production_execution_proven":False,
        })
    return {
        "provider_id":key,"operator":operator,
        "previous_block":BLOCK,"previous_block_hash":BLOCK_HASH,
        "historical_state_root":block["stateRoot"],
        "historical_parent_hash":block["parentHash"],
        "real_paymaster_runtime_sha256":digest(code_bytes),
        "real_mainnet_readonly_fee_abi_rows":rows,
    }


def assess(*, call=rpc, providers=None):
    providers=providers or [p for p in PROVIDERS if p[0] in ("drpc","blast")]
    need(len(providers)==2 and [p[0] for p in providers]==["drpc","blast"]
         and providers[0][1]!=providers[1][1] and providers[0][2]!=providers[1][2],
         "two independent Ethereum RPC operators and endpoints required")
    rows=[observed_one(p,call=call) for p in providers]
    observed_fields=("previous_block_hash","historical_state_root","historical_parent_hash",
                     "real_paymaster_runtime_sha256","real_mainnet_readonly_fee_abi_rows")
    need(all(rows[0][x]==rows[1][x] for x in observed_fields),
         "independent provider historic deployed-fee-ABI mismatch")
    report={
        "schema_version":1,
        "status":"RMC011_REAL_EXTERNAL_V07_ERC20_FEE_ABI_AND_PENALTY_PARITY_PASS_NOT_CREDIT",
        "ethereum_chain_id":1,
        "historical_source_block":BLOCK,
        "historical_source_block_hash":BLOCK_HASH,
        "real_paymaster_address":PAYMASTER,
        "real_entrypoint_v07_address":ENTRYPOINT,
        "historical_paymaster_code_sha256":PAYMASTER_CODE_SHA256,
        "source_prior_deployed_code_zip_sha256":HISTORICAL_DEPLOYED_CODE_EVIDENCE_ZIP_SHA256,
        "source_vendor_singleton_source_git_blob_sha1":UPSTREAM_SINGLETON_V07_SOURCE_BLOB_SHA1,
        "source_vendor_base_source_git_blob_sha1":UPSTREAM_SINGLETON_BASE_SOURCE_BLOB_SHA1,
        "source_vendor_readme_git_blob_sha1":UPSTREAM_PIMLICO_README_BLOB_SHA1,
        "real_deployed_pure_abi_functions_and_illustrative_math_agree":True,
        "four_illustrative_cost_cases":rows[0]["real_mainnet_readonly_fee_abi_rows"],
        "read_only_provider_operator_witnesses":rows,
        "real_historical_postop_or_signed_userop_executed":False,
        "provider_signed_exchange_rate_or_constant_fee_obtained":False,
        "nqc_specific_paymaster_signer_authorization_granted":False,
        "provider_reverted_gas_nonrecourse_liability_accepted":False,
        "operator_pimlico_balance_or_other_recourse_excluded":False,
        "third_party_native_gas_line_reserved_for_nqc":False,
        "pimlico_provider_total_eth_deposit_is_nqc_money":False,
        "contract_penalty_math_is_an_actual_pimlico_policy_quote":False,
        "nqc_executable_with_zero_own_capital":False,
        "nqc_realized_pnl_proven":False,
        "rmc011_terminal_closed":False,
        "real_market_census_closed":False,
        "economic_scope":"COST_PRIMITIVES_ONLY_NO_ACTIVE_PROVIDER_QUOTE_OR_MEV_CAPTURE",
    }
    report["report_sha256"]=digest(canonical(report))
    return report


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--out",type=Path,required=True)
    opt=parser.parse_args()
    need(not opt.out.exists(),"read-only evidence output must be append-only")
    out=assess()
    opt.out.parent.mkdir(parents=True,exist_ok=True)
    opt.out.write_bytes(canonical(out))
    print(out["status"],"cost_cases",
          [(x["illustrative_case"],x["real_abi_expected_penalty_gas_cost_wei"],
            x["real_abi_get_cost_in_weth_wei_at_1to1_test_rate"])
           for x in out["four_illustrative_cost_cases"]],
          "SIGNED_QUOTE=false", "NQC_NET_PNL=false")


if __name__=="__main__":
    main()
