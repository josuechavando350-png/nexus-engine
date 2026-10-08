#!/usr/bin/env python3
"""RMC011: exact historical native gas funds/code of an external ERC4337 paymaster.

An actual third-party-owned EntryPoint deposit is NOT a sponsorship allocation
to NQC. Never infer provider signature, WETH support, quote, guarantee,
nonrecourse revert liability, execution inclusion or profitability from code
presence or gas deposit. Read-only RPC only. No calls to paymaster API.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

from rmc016_probe_historical_rpc import PROVIDERS, rpc

CHAIN_ID = 1
HISTORICAL_BLOCK = 25938047
HISTORICAL_HASH = "0x42cf44b75185587327a1aa8fc859cc5f49a639e7256547511430d6068b6f09ab"
PAYMASTER = "0x777777777777aec03fd955926dbf81597e66834c"
ENTRYPOINT = "0x0000000071727de22e5e9d8baf0edac6f37da032"
CODE_SOURCE = "SOURCIFY_ETHEREUM_CHAIN1_EXACT_MATCH_SINGLETONPAYMASTERV7_DEPLOY_BLOCK_22076092"
UINT_HEX = re.compile(r"0x(?:0|[1-9a-f][0-9a-f]*)\Z")
HASH32 = re.compile(r"0x[0-9a-f]{64}\Z")
BYTECODE = re.compile(r"0x(?:[0-9a-fA-F]{2})+\Z")
WORD32 = re.compile(r"0x[0-9a-fA-F]{64}\Z")
BALANCE_OF = "0x70a08231"


def need(ok: bool, message: str):
    if not ok:
        raise ValueError(message)


def integer_hex(value, label):
    need(type(value) is str and UINT_HEX.fullmatch(value) is not None,
         label + ": noncanonical Ethereum quantity")
    return int(value, 16)


def canon(obj):
    return (json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def hash256(payload):
    return hashlib.sha256(payload).hexdigest()


def header(raw):
    need(type(raw) is dict, "previous historical Ethereum header missing")
    need(integer_hex(raw.get("number"), "header block") == HISTORICAL_BLOCK,
         "historical block number wrong")
    need(raw.get("hash") == HISTORICAL_HASH, "canonical historical block/reorg mismatch")
    for key in ("parentHash", "stateRoot"):
        need(type(raw.get(key)) is str and HASH32.fullmatch(raw[key]) is not None,
             "missing canonical " + key)
    timestamp = integer_hex(raw.get("timestamp"), "timestamp")
    need(timestamp > 0, "zero timestamp")
    return {
        "number": HISTORICAL_BLOCK,
        "hash": HISTORICAL_HASH,
        "parent_hash": raw["parentHash"],
        "state_root": raw["stateRoot"],
        "timestamp": timestamp,
    }


def runtime(value, label):
    need(type(value) is str and BYTECODE.fullmatch(value) is not None,
         label + " missing runtime")
    raw = bytes.fromhex(value[2:])
    need(1000 <= len(raw) < 64000, label + " code length implausible")
    return {"sha256": hash256(raw), "bytes": len(raw)}


def eth_call_balance(value):
    need(type(value) is str and WORD32.fullmatch(value) is not None,
         "EntryPoint.balanceOf(paymaster) ABI malformed")
    return int(value, 16)


def observe(provider, *, call=rpc):
    key,operator,url = provider
    need(call(url,"eth_chainId",[]) == "0x1", "wrong RPC chain")
    block=header(call(url,"eth_getBlockByNumber",[hex(HISTORICAL_BLOCK),False]))
    paymaster=runtime(call(url,"eth_getCode",[PAYMASTER,hex(HISTORICAL_BLOCK)]),"Paymaster")
    entrypoint=runtime(call(url,"eth_getCode",[ENTRYPOINT,hex(HISTORICAL_BLOCK)]),"EntryPoint")
    data=BALANCE_OF+PAYMASTER[2:].rjust(64,"0")
    deposited=eth_call_balance(call(url,"eth_call",[
        {"to":ENTRYPOINT,"data":data},hex(HISTORICAL_BLOCK)
    ]))
    return {
        "provider_id":key,"operator":operator,"historical_block":block,
        "paymaster_code_sha256":paymaster["sha256"],
        "paymaster_code_length":paymaster["bytes"],
        "entrypoint_code_sha256":entrypoint["sha256"],
        "entrypoint_code_length":entrypoint["bytes"],
        "entrypoint_paymaster_total_deposit_native_wei":str(deposited),
    }


def assess(*, call=rpc, providers=None):
    providers=providers or [p for p in PROVIDERS if p[0] in ("drpc","blast")]
    need(len(providers)==2 and [p[0] for p in providers]==["drpc","blast"]
         and providers[0][1] != providers[1][1]
         and providers[0][2] != providers[1][2],
         "exact two independent provider operators/endpoints required")
    observed=[observe(p,call=call) for p in providers]
    a,b=observed
    for field in (
        "historical_block","paymaster_code_sha256","paymaster_code_length",
        "entrypoint_code_sha256","entrypoint_code_length",
        "entrypoint_paymaster_total_deposit_native_wei",
    ):
        need(a[field]==b[field], "two independent RPC operators disagree on " + field)
    balance=int(a["entrypoint_paymaster_total_deposit_native_wei"])
    report={
        "schema_version":1,
        "status":"RMC011_EXTERNAL_V07_PAYMASTER_CODE_AND_ENTRYPPOINT_DEPOSIT_OBSERVED_NOT_ADMITTED",
        "provider_implementation":"PIMLICO_SINGLETON_PAYMASTER_V7_PUBLIC_DEPLOYMENT",
        "public_contract_source_reference":CODE_SOURCE,
        "ethereum_chain_id":CHAIN_ID,
        "historical_block_number":HISTORICAL_BLOCK,
        "historical_block_hash":HISTORICAL_HASH,
        "pimlico_singleton_v7_paymaster_address":PAYMASTER,
        "actual_erc4337_entrypoint_v7_address":ENTRYPOINT,
        "paymaster_runtime_sha256":a["paymaster_code_sha256"],
        "entrypoint_runtime_sha256":a["entrypoint_code_sha256"],
        "real_entrypoint_paymaster_total_native_deposit_wei_at_historical_block":str(balance),
        "real_contract_code_and_total_deposit_dual_operator_consensus":True,
        "is_provider_total_deposit_positive_at_source_block":balance>0,
        "source_contains_proof_of_nqc_allocated_credit":False,
        "source_contains_provider_weth_quote":False,
        "source_contains_provider_erc20_payment_policy_approval":False,
        "source_contains_signed_operation_specific_paymaster_authorization":False,
        "source_contains_nqc_nonrecourse_success_and_revert_agreement":False,
        "source_contains_exclusive_native_gas_reservation_for_nqc":False,
        "real_erc20_postop_can_pay_with_future_liquidation_proceeds_proven":False,
        "real_provider_mainnet_weth_support_and_account_allowance_proven":False,
        "independent_external_gas_provider_execution_authorized":False,
        "nqc_capital_feasible_for_own_capital_zero":False,
        "source_is_current_live_availability_quote":False,
        "actual_real_entrypoint_paymaster_userop_executed":False,
        "nqc_ex_ante_liquidation_capture_proven":False,
        "nqc_net_profit_proven":False,
        "rmc011_terminal_closed":False,
        "real_market_census_closed":False,
        "rpc_operator_witnesses":observed,
    }
    report["report_sha256"]=hash256(canon(report))
    return report


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    need(not a.out.exists(),"append-only read-only provider diagnostic")
    report=assess()
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canon(report))
    print(report["status"],"deposit_native_wei",
          report["real_entrypoint_paymaster_total_native_deposit_wei_at_historical_block"],
          "nqc_allocation_proven_false")


if __name__=="__main__":
    main()
