#!/usr/bin/env python3
"""Economic admission screen for a REAL LOCAL Anvil NQC full EOA receipt.

Authenticate PR723's 34-log atomic Aave+flash+USDC payout receipt and PR720's
on-chain competitor fee/Chainlink reference. Distinguish paid local synthetic
gas from a hypothetical mainnet fee quote. Price standalone execution AND
all three one-off EOA setup transactions. NO bid is placed, no sponsor exists,
and no future or production net P&L is inferred.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile

LOCAL_ZIP_SHA = "edae8d055655f0fc23c443dbdccdf9c4150311133a1966249d4957dcd80ed346"
LOCAL_HEAD = "95ac66423da56ddd0a6862a9a17bf2f66655cd2a"
LOCAL_TREE = "2b830164ad3d8f7c52261a93e7ba5935ae85cc51"
LOCAL_ARTIFACT_ID = 11922091704
LOCAL_RUN_ID = 38620588292
ECON_ZIP_SHA = "8675a4aeef42796f90b796c070d381a31df5f56af059ea7646a4cbf5537dab31"
ECON_HEAD = "eb58765724b9583c04c469c9ae387a78cc125f3c"
ECON_TREE = "ed52819926897a361782783e340a44d42c96dbad"
ECON_ARTIFACT_ID = 11909875203
ECON_RUN_ID = 38593985410
ROUTE_ZIP_SHA = "6778f8e190d13c739331f731ca532d8607e3f653ca000de746b058b4903c7d7d"
ORACLE_ZIP_SHA = "ca495ebdb9b8c7f8ed8438e5c3226b58b9c31c0d50e44ef35d6fce2cec232dde"
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
WINNER = "0x08db2e5d5f4e627f9fb4d12a780aac26aed725fab36b70fb9647119872d74625"
ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
CHAINLINK_RAW8 = 254164650000
GROSS_USDC_MICROS = 2273989378
EXEC_GAS = 917625
SETUP_GAS = (916432,1957983,43948)
LOCAL_EFFECTIVE_WEI_PER_GAS = 696037887
COMPETITOR_EFFECTIVE_WEI_PER_GAS = 1086577108
ORIGINAL_CALL_GROSS_GASLEFT = 1115038
USD_MICROS = 10**6
ETH_WEI = 10**18
CHAINLINK_DECIMALS = 10**8
MAX_COMPRESSED = 6_000_000
MAX_DECOMPRESSED = 220_000_000
PRICE_ASSUMPTIONS_WEI = (COMPETITOR_EFFECTIVE_WEI_PER_GAS,10**10,5*10**10)
MIN_NQC_USDC_MICROS = (25_000_000,100_000_000)
SPLIT_BPS = (0,2000)
OTHER_COST_USDC_MICROS = (0,50_000_000)
SHA_RE = re.compile(r"[0-9a-f]{64}\Z")
HEX32_RE = re.compile(r"0x[0-9a-f]{64}\Z")


class Rejected(ValueError):
    pass


def need(ok,reason):
    if not ok:raise Rejected(reason)


def positive(v,label):
    need(type(v) is int and 0<v<2**256,label+" invalid positive uint256")
    return v


def ceildiv(n,d):
    need(type(n) is int and type(d) is int and n>=0 and d>0,
         "invalid exact integer division")
    return (n+d-1)//d


def canon(obj):
    return (json.dumps(obj,sort_keys=True,separators=(",",":"),
                       ensure_ascii=True)+"\n").encode()


def read_json(raw):
    def pairs(rows):
        result={}
        for key,val in rows:
            need(key not in result,"duplicate evidence JSON key")
            result[key]=val
        return result
    return json.loads(raw,object_pairs_hook=pairs,
        parse_constant=lambda k:(_ for _ in ()).throw(Rejected("nonfinite JSON token")))


def authenticated_zip(raw,expected_sha,commit,tree,members):
    need(type(raw) is bytes and 0<len(raw)<MAX_COMPRESSED,
         "unexpected source ZIP size/type")
    need(sha256(raw).hexdigest()==expected_sha,
         "immutable original ZIP SHA256 drift")
    with zipfile.ZipFile(BytesIO(raw)) as z:
        infos=z.infolist()
        names=[f.filename for f in infos if not f.is_dir()]
        need(len(names)==len(set(names)) and len(infos)==members+1 and
             len(names)==len(infos) and
             sum(f.file_size for f in infos)<=MAX_DECOMPRESSED,
             "duplicate/missing/inflated ZIP member list")
        for f in infos:
            p=PurePosixPath(f.filename)
            need(f.filename==str(p) and not p.is_absolute() and
                 ".." not in p.parts and "\\" not in f.filename and
                 f.file_size<=25_000_000 and
                 not stat.S_ISLNK(f.external_attr>>16),
                 "unsafe source member")
        need("manifest.sha256" in names and
             z.read("code-commit.txt").decode("ascii").strip()==commit and
             z.read("code-tree.txt").decode("ascii").strip()==tree,
             "original source code commitment drift")
        manifest={}
        for line in z.read("manifest.sha256").decode("ascii").splitlines():
            match=re.fullmatch(r"([0-9a-f]{64})  (\./)?([A-Za-z0-9._/-]+)",line)
            need(match is not None,"invalid SHA256 manifest entry")
            hashval,_,name=match.groups()
            need(name not in manifest and name!="manifest.sha256","duplicate manifest item")
            manifest[name]=hashval
        need(set(manifest)==set(names)-{"manifest.sha256"} and len(manifest)==members,
             "not exact immutable source inventory")
        for name,digest in manifest.items():
            need(sha256(z.read(name)).hexdigest()==digest,
                 "source SHA256 mismatch "+name)
        data={name:z.read(name) for name in names}
    return data


def exact_u256_quantity(raw,label):
    need(type(raw) is str and re.fullmatch(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)",raw),
         "invalid Ethereum RPC quantity "+label)
    return int(raw,16)


def indexed_address(topic,label):
    need(type(topic) is str and HEX32_RE.fullmatch(topic.lower()) and
         int(topic[2:26],16)==0,"invalid indexed address "+label)
    return "0x"+topic[-40:].lower()


def authenticate_sources(localzip,econzip):
    local=authenticated_zip(localzip,LOCAL_ZIP_SHA,LOCAL_HEAD,LOCAL_TREE,36)
    econ=authenticated_zip(econzip,ECON_ZIP_SHA,ECON_HEAD,ECON_TREE,19)
    need(sha256(local["11865385506.zip"]).hexdigest()==ROUTE_ZIP_SHA and
         sha256(local["11871075488.zip"]).hexdigest()==ORACLE_ZIP_SHA and
         local["11865385506.zip"]==econ["11865385506.zip"] and
         local["11871075488.zip"]==econ["11871075488.zip"],
         "cross-producer funded-route/oracle archival bytes disagree")
    x=read_json(local["attempt/local-cold-receipt.json"])
    e=read_json(econ["competitor-native-gas-and-nqc-call-ledger.json"])
    need(x.get("status")=="HISTORICAL_LOCAL_ANVIL_FULL_EOA_RECEIPT_NO_MAINNET_CAPTURE" and
         x.get("errors")==[] and
         x.get("original_winner_block")==26142067 and
         x.get("original_winner_transaction")==WINNER and
         x.get("authenticated_pre_winner_fork",{}).get(
             "account_hex_matches_original_exactly") is True and
         x.get("authenticated_oracle_prefix",{}).get(
             "source_oracle_trigger_tx_index")==0 and
         x.get("authenticated_oracle_prefix",{}).get(
             "source_winner_tx_index_from_original_indexer")==1 and
         x.get("authenticated_oracle_prefix",{}).get(
             "eth_usd_chainlink_answer_after_oracle_tx0_raw_8_decimals")==CHAINLINK_RAW8 and
         x.get("authenticated_oracle_prefix",{}).get(
             "source_price_causality_not_prospective_svr_visibility") is True,
         "local causal EVM prewinner state not source-authenticated")
    for key in ("ethereum_mainnet_transaction_submitted",
                "ethereum_mainnet_native_gas_spent",
                "user_mxn_2000_gas_spent",
                "operator_private_key_or_funds_used",
                "nqc_cold_execution_mainnet_gas_used_proven",
                "nqc_live_capture_rate_proven",
                "nqc_complete_net_economics_proven",
                "external_nonrecourse_gas_sponsor_proven",
                "commercial_score_upgrade","RMC_closed",
                "P2_shadow_certified","canary_live_authorized"):
        need(x.get(key) is False,"local EOA source elevated claim "+key)
    need(x.get("nqc_realized_pnl_usd")=="0",
         "local source has NQC realized revenue")
    receipts=x.get("full_local_eoa_receipts")
    need(type(receipts) is dict and
         receipts.get("fork_only_execute_receipt_gas_used")==EXEC_GAS and
         receipts.get("fork_only_execute_receipt_effective_gas_price_wei")==
             LOCAL_EFFECTIVE_WEI_PER_GAS and
         receipts.get("fork_only_setup_transaction_receipt_gas_used")==list(SETUP_GAS) and
         receipts.get("source_original_gasleft_delta_after_test_setup")==
             ORIGINAL_CALL_GROSS_GASLEFT and
         receipts.get("fork_gas_fee_is_not_paid_on_public_ethereum") is True and
         receipts.get("real_execution_gas_fee_paid_from_user_or_operator") is False and
         receipts.get("three_setup_deployments_are_not_included_in_execute_receipt_gas") is True,
         "source cold full EOA gas/gas-cost boundary drift")
    raw_receipt=receipts.get("fork_only_full_local_execute_receipt")
    need(type(raw_receipt) is dict and
         raw_receipt.get("status")=="0x1" and
         raw_receipt.get("transactionHash")==receipts.get("fork_only_execute_receipt_hash") and
         raw_receipt.get("blockHash")==receipts.get("fork_only_execute_receipt_block_hash") and
         exact_u256_quantity(raw_receipt.get("gasUsed"),"receipt gasUsed")==EXEC_GAS and
         exact_u256_quantity(raw_receipt.get("effectiveGasPrice"),"receipt effectiveGasPrice")==
             LOCAL_EFFECTIVE_WEI_PER_GAS and
         receipts.get("fork_only_execute_receipt_native_wei_gas_charged")==
             EXEC_GAS*LOCAL_EFFECTIVE_WEI_PER_GAS,
         "original on-loopback EOA receipt expense mismatch")
    logs=raw_receipt.get("logs")
    ev=receipts.get("verified_atomic_execution_events")
    need(type(logs) is list and len(logs)==34 and
         receipts.get("fork_only_execute_receipt_log_count")==len(logs) and
         type(ev) is dict and
         ev.get("local_profit_asset_base_units")==GROSS_USDC_MICROS and
         ev.get("local_principal_repaid_base_units")==49017850405 and
         ev.get("local_expected_collateral_seized_wei")==20140477263386042567 and
         ev.get("not_a_mainnet_or_prospective_profit_witness") is True and
         all(ev.get(t) is True for t in (
             "authentic_local_aave_liquidation_event",
             "authentic_local_flash_loan_repaid_event",
             "authentic_local_funding_completed_event",
             "authentic_local_erc20_profit_transfer_to_ephemeral_eoa")) and
         ev.get("local_atomic_event_log_sha256")==sha256(canon(logs)).hexdigest() and
         ev.get("local_receipt_full_sha256")==sha256(canon(raw_receipt)).hexdigest(),
         "full raw EOA receipt logs and economic proof changed")
    coordinator=receipts.get("isolated_coordinator_contract_address")
    operator=receipts.get("cold_eoa_sender")
    need(type(coordinator) is str and type(operator) is str and
         re.fullmatch(r"0x[0-9a-f]{40}",coordinator) and
         re.fullmatch(r"0x[0-9a-f]{40}",operator) and
         raw_receipt.get("from")==operator and
         x.get("ephemeral_test_eoa_address")==operator,
         "source ephemeral operator or funded coordinator identity drift")
    payouts=[]
    for entry in logs:
        if type(entry) is not dict or entry.get("address")!=USDC or \
           type(entry.get("topics")) is not list or len(entry["topics"])!=3 or \
           entry["topics"][0]!=ERC20_TRANSFER_TOPIC:
            continue
        if indexed_address(entry["topics"][1],"payout from")==coordinator and \
           indexed_address(entry["topics"][2],"payout to")==operator:
            need(entry.get("transactionHash")==raw_receipt["transactionHash"] and
                 entry.get("blockHash")==raw_receipt["blockHash"],"profit receipt identity drift")
            payouts.append(int(entry["data"],16))
    need(payouts==[GROSS_USDC_MICROS],
         "no exact final USDC profit actually swept in local receipt")
    need(e.get("status")=="COMPETITOR_NATIVE_GAS_FACTS_AND_NQC_GAS_SENSITIVITY_NO_NET" and
         e.get("nqc_realized_pnl_usd")=="0" and
         e.get("commercial_score_upgrade") is False and
         e.get("no_nqc_cold_whole_transaction_receipt") is True and
         len(e.get("cases",[]))==2,
         "original competitor economics source scope changed")
    case=next((k for k in e["cases"]
               if k.get("label")=="WETH_COLLATERAL_USDC_DEBT"),None)
    need(type(case) is dict and
         case.get("historical_block")==26142067 and
         case.get("competitor_transaction_hash")==WINNER and
         case.get("chainlink_eth_usd_price_after_trigger_raw_8_decimals")==CHAINLINK_RAW8 and
         case.get("nqc_selected_historical_route_surplus_before_native_costs_micros")==
             GROSS_USDC_MICROS and
         case.get("competitor_effective_gas_price_wei")==COMPETITOR_EFFECTIVE_WEI_PER_GAS and
         case.get("historical_aave_block_base_fee_wei")==COMPETITOR_EFFECTIVE_WEI_PER_GAS and
         case.get("competitor_gas_is_not_nqc_gas") is True and
         case.get("nqc_competitive_capture_proven") is False,
         "exact same historical on-chain Chainlink price/competitor receipt not authenticated")
    return {
        "full_local_gas":EXEC_GAS,
        "setup_gas":sum(SETUP_GAS),
        "usdc_payout_micros":GROSS_USDC_MICROS,
        "historical_gas_price_wei":COMPETITOR_EFFECTIVE_WEI_PER_GAS,
        "local_only_gas_price_wei":LOCAL_EFFECTIVE_WEI_PER_GAS,
        "oracle_eth_usd_raw8":CHAINLINK_RAW8,
        "actual_local_receipt_transaction_hash":raw_receipt["transactionHash"],
        "local_receipt_events_sha256":ev["local_atomic_event_log_sha256"],
        "historical_competitor_tx_hash":WINNER,
        "source_provenance":{
            "local_immutable_zip_sha256":LOCAL_ZIP_SHA,
            "local_source_head":LOCAL_HEAD,"local_source_tree":LOCAL_TREE,
            "local_run":LOCAL_RUN_ID,"local_artifact":LOCAL_ARTIFACT_ID,
            "local_manifest_members_verified":36,
            "competitor_economics_zip_sha256":ECON_ZIP_SHA,
            "competitor_economics_head":ECON_HEAD,
            "competitor_economics_tree":ECON_TREE,
            "competitor_economics_run":ECON_RUN_ID,
            "competitor_economics_artifact":ECON_ARTIFACT_ID,
            "competitor_manifest_members_verified":19,
            "cross_source_identical_funded_route_and_oracle_bytes":True,
        }
    }


def cost_micros(gas_units,price_wei,oracle_raw8):
    for val,label in ((gas_units,"gas units"),
                      (price_wei,"price wei per gas"),
                      (oracle_raw8,"ETH USD price raw")):
        positive(val,label)
    return ceildiv(gas_units*price_wei*oracle_raw8*USD_MICROS,
                   ETH_WEI*CHAINLINK_DECIMALS)


def bid_headroom(gross,cost,other,minimum,split):
    for v in (gross,cost,minimum):positive(v,"economic term")
    need(type(other) is int and other>=0 and type(split) is int and
         0<=split<10000,"invalid nonnegative cost or sponsor split")
    leftover=gross-cost-other
    # If sponsor keeps split of strictly positive residual AFTER any bid,
    # NQC must retain >= minimum. Ceiling protects from rounding-up surplus.
    required_pre_split=ceildiv(minimum*10000,10000-split)
    return max(0,leftover-required_pre_split),leftover>=required_pre_split


def build(p):
    need(type(p) is dict and
         p.get("full_local_gas")==EXEC_GAS and
         p.get("setup_gas")==sum(SETUP_GAS) and
         p.get("usdc_payout_micros")==GROSS_USDC_MICROS and
         p.get("historical_gas_price_wei")==COMPETITOR_EFFECTIVE_WEI_PER_GAS and
         p.get("oracle_eth_usd_raw8")==CHAINLINK_RAW8,
         "incompatible/fabricated source cost identities")
    modes=[
        ("EXECUTE_ONLY_REQUIRES_PREDEPLOYED_BORROWER_SPECIFIC_CONTRACTS",EXEC_GAS,False),
        ("FULL_THREE_SETUP_TX_PLUS_EXECUTE_CHARGED_TO_ONE_OPPORTUNITY",
         EXEC_GAS+sum(SETUP_GAS),True),
    ]
    out=[]
    for mode,gas_units,includes_setup in modes:
        for price in PRICE_ASSUMPTIONS_WEI:
            charged=cost_micros(gas_units,price,CHAINLINK_RAW8)
            after=GROSS_USDC_MICROS-charged
            limits=[]
            for other in OTHER_COST_USDC_MICROS:
                for split in SPLIT_BPS:
                    for minimum in MIN_NQC_USDC_MICROS:
                        headroom,allowed=bid_headroom(
                            GROSS_USDC_MICROS,charged,other,minimum,split)
                        limits.append({
                            "other_failure_financing_operating_cost_usdc_micros_assumed":other,
                            "external_financier_revenue_share_bps_assumed":split,
                            "minimum_nqc_share_usdc_micros_required":minimum,
                            "maximum_additional_inclusion_payment_usdc_micros_assumed":headroom,
                            "headroom_feasible_at_assumed_costs":allowed,
                            "not_a_winning_builder_bid_or_available_private_orderflow":True,
                        })
            out.append({
                "mode":mode,
                "nqc_local_measured_full_execute_gas_used":EXEC_GAS,
                "local_measured_three_setup_receipt_gas_used":list(SETUP_GAS),
                "gas_units_billed_in_assumed_scenario":gas_units,
                "setup_cost_allocated_to_this_one_borrower_opportunity":includes_setup,
                "gas_price_wei_per_unit_assumed_for_ethereum_fee_quote":price,
                "gas_price_is_historical_competitor_observation":
                    price==COMPETITOR_EFFECTIVE_WEI_PER_GAS,
                "oracle_eth_usd_valuation_raw8_from_same_historical_block":CHAINLINK_RAW8,
                "ethereum_gas_cost_usdc_micros_if_usdc_usd_peg_one":charged,
                "historical_route_surplus_after_native_only_usdc_micros_if_peg_one":after,
                "bid_headroom_scenarios_not_capture_or_net_profit":limits,
                "requires_separate_pretrigger_deployment_and_funding_certification":not includes_setup,
                "three_setup_transactions_not_proven_insertable_between_oracle_and_winner":True,
                "reuse_of_borrower_specific_immutable_strategy_across_other_borrowers_proven":False,
            })
    return {
        "schema_version":1,
        "status":"AUTHENTIC_LOCAL_GAS_AND_HISTORICAL_PRICE_HEADROOM_ONLY_NO_NET",
        "source":p["source_provenance"],
        "historical_winner_tx_hash":WINNER,
        "nqc_historical_local_atomic_profit_transfer_usdc_micros":GROSS_USDC_MICROS,
        "nqc_historical_local_full_eoa_execute_receipt_gas_used":EXEC_GAS,
        "nqc_historical_local_three_setup_receipt_gas_used":list(SETUP_GAS),
        "nqc_historical_local_broadcast_restricted_to_127_0_0_1":True,
        "nqc_ethereum_mainnet_receipt_or_inclusion_proven":False,
        "nqc_historical_local_gas_effective_price_wei":LOCAL_EFFECTIVE_WEI_PER_GAS,
        "nqc_historical_local_receipt_fee_paid_from_synthetic_anvil_eoa_wei":
            EXEC_GAS*LOCAL_EFFECTIVE_WEI_PER_GAS,
        "nqc_local_receipt_events_sha256":p["local_receipt_events_sha256"],
        "onchain_competitor_effective_price_wei":COMPETITOR_EFFECTIVE_WEI_PER_GAS,
        "historical_chainlink_eth_usd_raw_8_decimals":CHAINLINK_RAW8,
        "economic_scenarios":out,
        "transferrable_surplus_pre_bid_not_net_profit":True,
        "per_borrower_setup_is_not_auto_reusable_across_positions":True,
        "predeployed_immutable_strategy_known_before_oracle_trigger_unverified":True,
        "three_setup_tx_cannot_be_assumed_to_fit_svr_single_backrun_slot":True,
        "synthetic_10_50gwei_are_not_future_gas_price_forecasts":True,
        "failure_rate_unknown_not_zero":True,
        "sponsor_nonrecourse_contract_and_reversion_payer_unknown":True,
        "builder_access_bid_and_competitor_capture_rate_unknown":True,
        "stablecoin_one_usd_peg_not_certified":True,
        "nothing_sent_to_mainnet_and_user_mxn2000_not_spent":True,
        "OWN_CAPITAL_ZERO_INCLUDING_GAS_UNCHANGED":True,
        "commercial_score_upgrade":False,
        "RMC_closed":False,"P2_shadow_certified":False,
        "canary_live_authorized":False,
        "nqc_realized_pnl_usd":"0",
    }


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--local-source-zip",type=Path,required=True)
    ap.add_argument("--economic-source-zip",type=Path,required=True)
    ap.add_argument("--out",type=Path,required=True)
    args=ap.parse_args()
    need(args.out.is_absolute() and args.out.parent.is_dir()
         and not args.out.exists(),"need fresh absolute output file")
    src=authenticate_sources(args.local_source_zip.read_bytes(),
                             args.economic_source_zip.read_bytes())
    report=build(src)
    with args.out.open("xb") as dest:dest.write(canon(report))
    for row in report["economic_scenarios"]:
        print(row["mode"],row["gas_price_wei_per_unit_assumed_for_ethereum_fee_quote"],
              "native_only_cost_usdc_micros",row["ethereum_gas_cost_usdc_micros_if_usdc_usd_peg_one"],
              "remaining_usdc_micros",row["historical_route_surplus_after_native_only_usdc_micros_if_peg_one"])
    return 0


if __name__=="__main__":
    raise SystemExit(main())
