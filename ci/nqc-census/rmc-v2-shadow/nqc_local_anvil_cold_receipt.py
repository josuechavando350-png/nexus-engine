#!/usr/bin/env python3
"""Real local Anvil receipt gasUsed for authenticated historical NQC funded route.

ONLY eth_sendRawTransaction emitted by Foundry to 127.0.0.1 ephemeral Anvil.
Anvil forks real Ethereum as READ-ONLY history and never forwards local writes.
A generated test-only EOA is funded using Anvil's synthetic setBalance API.
No wallet/account/user funds, mainnet broadcast, deployment or gas expense.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import time
from urllib.request import Request, urlopen
import zipfile

import postwindow_economic_envelope as historical
import competitor_native_gas_vs_nqc_fork as oracle_evidence
import postwindow_competition_capacity_hurdle as original_index

LOCAL_URL = "http://127.0.0.1:18545"
UPSTREAM_READ_ONLY_RPC = "https://eth.drpc.org"
SOURCE_ZIP_SHA = historical.EXPECTED_ARTIFACT_SHA256
FORK_WINNER = "0x08db2e5d5f4e627f9fb4d12a780aac26aed725fab36b70fb9647119872d74625"
# Authenticated PR700 confirms this is the immediately preceding canonical
# tx index 0 Chainlink update; the selected winner is tx index 1.
# Anvil v1.8.5 --fork-transaction-hash replays the requested tx INCLUSIVELY.
# Fork at tx0 instead of tx1 to obtain the source-locked PRE-winner state.
FORK_ORACLE_TX0 = "0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b"
ORACLE_SOURCE_ZIP_SHA = oracle_evidence.ORACLE_ZIP_SHA
PINNED_BLOCK = 26_142_067
CASE = "WETH_COLLATERAL_USDC_DEBT"
POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
EXECUTOR_SOURCE_SHA = "1eb01ef850e8de52c89ef0825207f0a3086251f713313300a73aede1e450875e"
OLD_ROUTE_SOURCE_SHA = "b157b28d5da13923dfa724f569f790b9dc6396ac8b47a6826c49dd718d42ace9"
SOURCE_FOUNDRY_SHA = "1dcdefbf856d80cc3318131b7123c7d1e7a39e9fc3ac8c6fa5afa1742d9cd124"
EXPECTED_PRINCIPAL = 48_993_353_728
EXPECTED_FEE = 24_496_677
EXPECTED_COLLATERAL = 20_140_477_263_386_042_567
EXPECTED_SURPLUS_BEFORE_NATIVE = 2_273_989_378
MAX_RPC_CALLS = 22
MAX_RPC_REPLY_BYTES = 1_048_576
WAIT_UP_TO_SECONDS = 320
FORGE_UP_TO_SECONDS = 1000
ABI_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
HEX32 = re.compile(r"0x[0-9a-fA-F]{64}\Z")
EXPECTED_RECEIPTS = 4
FUNDING_COMPLETED_TOPIC = "0x28764d85ad04b5436000901ca0cb64944bbb7a48433836efc3ba71b61497178d"
FUNDING_LEG_REPAID_TOPIC = "0x48b852348ea48bd0bfc4960a40580365626f57968715e1b5e5889bd79b5e21ca"
AAVE_LIQUIDATION_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286"
ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


class Rejected(ValueError):
    pass


class PrestateDrift(Rejected):
    def __init__(self,witness):
        super().__init__("ANVIL_PRE_WINNER_AAVE_ACCOUNT_NOT_SOURCE_IDENTICAL")
        self.witness=witness


def need(ok, why):
    if not ok:
        raise Rejected(why)


def canonical(obj):
    return (json.dumps(obj, sort_keys=True, separators=(",",":"),
                       ensure_ascii=True)+"\n").encode()


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def sha_file(path):
    return sha256(path.read_bytes()).hexdigest()


def integer(v, name, positive=True):
    need(type(v) is int and ((v>0) if positive else (v>=0)),
         "invalid exact integer "+name)
    return v


def quantity(v, name):
    need(type(v) is str and re.fullmatch(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)",v),
         "invalid Ethereum hex quantity: "+name)
    return int(v,16)


def validate_original_zip(source_body:bytes):
    need(type(source_body) is bytes and
         sha256(source_body).hexdigest() == SOURCE_ZIP_SHA,
         "original immutable funded-route ZIP mismatch")
    original, proof = historical.authenticate_archive(source_body)
    cases=historical.authenticated_cases(original)
    case=next((x for x in cases if x["label"]==CASE),None)
    need(case is not None and case["surplus_asset_micros"]==
         EXPECTED_SURPLUS_BEFORE_NATIVE and
         case["gross_call_gas_not_receipt_gas"]==1_115_038 and
         case["block_base_fee_wei"]==1_086_577_108,
         "not exact original WETH/USDC positive route")
    with zipfile.ZipFile(BytesIO(source_body)) as z:
        need("attempt/weth_collateral_usdc_debt-drpc/public-inputs.json"
             in z.namelist(),"exact dRPC original inputs missing")
        raw=z.read("attempt/weth_collateral_usdc_debt-drpc/public-inputs.json")
        doc=historical.strict_json(raw)
    exact={
        "NQC_WINNER_TX": FORK_WINNER,
        "NQC_WINNER_BLOCK":str(PINNED_BLOCK),
        "NQC_PRINCIPAL":str(EXPECTED_PRINCIPAL),
        "NQC_COLLATERAL":str(EXPECTED_COLLATERAL),
        "NQC_DEBT_ASSET":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "NQC_RPC_URL":UPSTREAM_READ_ONLY_RPC,
    }
    for field,value in exact.items():
        need(doc.get(field)==value,"prior source input drift: "+field)
    need(type(doc.get("NQC_BORROWER")) is str and
         ABI_ADDRESS.fullmatch(doc["NQC_BORROWER"]) and
         type(doc.get("NQC_PARENT_HASH")) is str and
         HEX32.fullmatch(doc["NQC_PARENT_HASH"]) and
         type(doc.get("NQC_PRESTATE_ABI")) is str and
         re.fullmatch(r"0x[0-9a-fA-F]{384}",doc["NQC_PRESTATE_ABI"]) and
         int(doc["NQC_PRESTATE_ABI"][-64:],16)<10**18,
         "historical borrower prestate ABI not authenticated")
    return doc,proof



def authenticate_oracle_prefix(oracle_source_bytes, index_source_bytes):
    need(type(oracle_source_bytes) is bytes and
         sha256(oracle_source_bytes).hexdigest() == ORACLE_SOURCE_ZIP_SHA,
         "source oracle PR700 ZIP digest drift")
    cases, provenance = oracle_evidence.authenticate_oracle(oracle_source_bytes)
    indexed, rows, index_proof = original_index.authenticate_index_archive(index_source_bytes)
    winner_rows = [x for x in rows if x.get("tx_hash") == FORK_WINNER]
    need(type(indexed) is dict and indexed.get("indexed_event_count") == 53 and
         indexed.get("unique_indexed_winner_tx_count") == 47 and
         len(winner_rows) == 2 and
         all(x["block"] == PINNED_BLOCK and
             x["transaction_index"] == 1 for x in winner_rows),
         "PR693 source original winner is not canonical tx index 1")
    selected = cases.get(CASE)
    need(type(selected) is dict and
         selected.get("block") == PINNED_BLOCK and
         selected.get("historical_trigger_price_causal_only") is True and
         selected.get("eth_usd_chainlink_answer_raw_8_decimals") == 254_164_650_000,
         "oracle causal trigger changed or wrong block/price")
    need(FORK_ORACLE_TX0 == oracle_evidence.EXPECTED[CASE]["trigger"] and
         FORK_ORACLE_TX0 != FORK_WINNER and
         oracle_evidence.EXPECTED[CASE]["tx"] == FORK_WINNER,
         "source oracle tx0 / winner tx1 identities not canonical")
    return {
        "source": provenance,
        "indexer_original_winner":index_proof,
        "indexed_winner_number_of_liquidation_logs":len(winner_rows),
        "source_oracle_trigger_tx_index": 0,
        "source_winner_tx_index_from_original_indexer": 1,
        "fork_transaction_hash_last_included": FORK_ORACLE_TX0,
        "excluded_original_competitor_winner": FORK_WINNER,
        "eth_usd_chainlink_answer_after_oracle_tx0_raw_8_decimals":
            selected["eth_usd_chainlink_answer_raw_8_decimals"],
        "source_price_causality_not_prospective_svr_visibility": True,
        "anvil_tx_hash_prefix_is_inclusive_at_v185_verified_by_state_only": False,
    }


def reject_nonlocal_url(url):
    need(url==LOCAL_URL,"any non-loopback or altered RPC URL forbidden")
    return url


class LocalAnvil:
    def __init__(self,url=LOCAL_URL):
        self.url=reject_nonlocal_url(url)
        self.calls=0
        self.transcript=[]

    def call(self,method,params):
        need(self.calls < MAX_RPC_CALLS,"local Anvil RPC budget exceeded")
        need(method in {
            "eth_chainId","eth_blockNumber","eth_getBlockByNumber",
            "eth_getTransactionReceipt","eth_getBalance","eth_call",
            "anvil_nodeInfo","anvil_setBalance",
        },"outside audited local Anvil RPC allowlist")
        if method=="anvil_setBalance":
            need(type(params) is list and len(params)==2 and
                 type(params[0]) is str and ABI_ADDRESS.fullmatch(params[0]) and
                 params[1]=="0x3635c9adc5dea00000",
                 "only deterministic synthetic 1000 ETH local mint allowed")
        body=json.dumps({"jsonrpc":"2.0","id":95,"method":method,
                         "params":params},separators=(",",":")).encode()
        req=Request(self.url,method="POST",data=body,headers={
            "Content-Type":"application/json",
            "User-Agent":"NQC-V2-ANVIL-LOOPBACK-ONLY-NO-MAINNET-WRITES/1"})
        started=time.monotonic_ns()
        try:
            with urlopen(req,timeout=38) as resp:
                raw=resp.read(MAX_RPC_REPLY_BYTES+1)
            need(len(raw)<=MAX_RPC_REPLY_BYTES,
                 "local Anvil response exceeds budget")
            doc=historical.strict_json(raw)
            need(type(doc) is dict and doc.get("jsonrpc")=="2.0" and
                 doc.get("id")==95 and "error" not in doc and
                 "result" in doc,"Anvil RPC rejected request")
            self.calls+=1
            result=doc["result"]
            self.transcript.append({"method":method,
                "result_sha256":sha256(canonical(result)).hexdigest(),
                "elapsed_ns":time.monotonic_ns()-started})
            return result
        except Exception as exc:
            self.transcript.append({"method":method,
                "error":type(exc).__name__+":"+str(exc)[:130],
                "elapsed_ns":time.monotonic_ns()-started})
            raise


def check_fork_snapshot(rpc,public_inputs):
    need(quantity(rpc.call("eth_chainId",[]),"chain id")==1,
         "wrong historical Ethereum fork chainId")
    meta=rpc.call("anvil_nodeInfo",[])
    need(type(meta) is dict,"127.0.0.1 endpoint is not an Anvil node")
    block=rpc.call("eth_getBlockByNumber",["latest",False])
    need(type(block) is dict,"fork did not produce a block header")
    height=quantity(block.get("number"),"fork height")
    need(PINNED_BLOCK-1<=height<=PINNED_BLOCK+1,
         "fork not exactly before source winner transaction")
    borrower=public_inputs["NQC_BORROWER"].lower()
    source_data="0xbf92857c"+"0"*24+borrower[2:]
    raw=rpc.call("eth_call",[{"to":POOL,"data":source_data},"latest"])
    expected=public_inputs["NQC_PRESTATE_ABI"].lower()
    if type(raw) is not str or raw.lower()!=expected:
        got=(raw.lower() if type(raw) is str else "")
        source_words=[int(expected[2+i*64:2+(i+1)*64],16) for i in range(6)]
        real_words=([int(got[2+i*64:2+(i+1)*64],16) for i in range(6)]
                    if re.fullmatch(r"0x[0-9a-f]{384}",got) else None)
        raise PrestateDrift({
            "source_expected_prewinner_abi_sha256":
                sha256(bytes.fromhex(expected[2:])).hexdigest(),
            "anvil_observed_abi_sha256":
                sha256(bytes.fromhex(got[2:])).hexdigest()
                if re.fullmatch(r"0x[0-9a-f]{384}",got) else None,
            "source_expected_six_uint256_words":source_words,
            "anvil_observed_six_uint256_words":real_words,
            "observed_minus_expected_six_exact_integer_deltas":
                [b-a for a,b in zip(source_words,real_words)]
                if real_words is not None else None,
            "anvil_local_latest_block_number":height,
            "anvil_local_latest_block_timestamp":
                quantity(block.get("timestamp"),"local timestamp"),
            "anvil_local_latest_block_hash":block.get("hash"),
            "anvil_local_latest_parent_hash":block.get("parentHash"),
            "source_authenticated_parent_hash":public_inputs["NQC_PARENT_HASH"],
            "cannot_promote_any_nqc_route_or_full_transaction_gas":True,
        })
    return {"block_number":height,"block_hash":block.get("hash"),
            "borrower":borrower,
            "prewinner_account_sha256":sha256(bytes.fromhex(raw[2:])).hexdigest(),
            "account_hex_matches_original_exactly":True,
            "anvil_local_node_info_sha256":sha256(canonical(meta)).hexdigest(),
            "fork_winner_transaction_hash":FORK_WINNER}


def check_source_files(workspace):
    source=workspace/"src/NqcFlashFundingExecutor.sol"
    route=workspace/"test/NqcV2FundedRouteFork.t.sol"
    foundry=workspace/"foundry.toml"
    script=workspace/"script/NqcV2LocalColdReceipt.s.sol"
    need(all(p.is_file() and not p.is_symlink() for p in
             (source,route,foundry,script)),"missing isolated script sources")
    need(sha_file(source)==EXECUTOR_SOURCE_SHA and
         sha_file(route)==OLD_ROUTE_SOURCE_SHA and
         sha_file(foundry)==SOURCE_FOUNDRY_SHA,
         "local Foundry source changed from certified original")
    return {str(p.relative_to(workspace)):sha_file(p) for p
            in (source,route,foundry,script)}


def get_test_ephemeral_eoa(cast):
    private="0x"+secrets.token_hex(32)
    wallet=subprocess.run([str(cast),"wallet","address","--private-key",
                           private],text=True,capture_output=True,timeout=20)
    need(wallet.returncode==0,"cannot derive an ephemeral nonuser local EOA")
    addr=wallet.stdout.strip().lower()
    need(ABI_ADDRESS.fullmatch(addr),"generated local-only EOA invalid")
    return private,addr


def _topic_address(value,label):
    need(type(value) is str and re.fullmatch(r"0x0{24}[0-9a-fA-F]{40}",value),
         "noncanonical indexed address in "+label)
    return "0x"+value[-40:].lower()


def _word_data(value,length,label):
    need(type(value) is str and
         re.fullmatch(r"0x[0-9a-fA-F]{%d}"%(length*64),value),
         "invalid "+label+" fixed-width event ABI")
    return [int(value[2+i*64:2+i*64+64],16) for i in range(length)]


def _find_required_log(logs,emitter,topic0,label):
    found=[]
    for log in logs:
        if type(log) is not dict or type(log.get("address")) is not str or \
           type(log.get("topics")) is not list or not log["topics"]:
            continue
        topic=log["topics"][0]
        if type(topic) is str and topic.lower()==topic0 and \
           log["address"].lower()==emitter.lower():
            found.append(log)
    need(len(found)==1,"expected exactly one "+label+" in genuine Anvil execute receipt")
    return found[0]


def validate_local_atomic_route_receipt(executed,coordinator,strategy,operator,source):
    need(type(executed) is dict and type(executed.get("logs")) is list,
         "missing local complete atomic route receipt")
    logs=executed["logs"]
    need(6<=len(logs)<=2048,"invalid local Aave funding+swap route log set")
    ident=executed.get("transactionHash","").lower()
    blockhash=executed.get("blockHash","").lower()
    for label,emitter,topic in (
        ("FundingExecutionCompleted",coordinator,FUNDING_COMPLETED_TOPIC),
        ("FundingLegRepaid",coordinator,FUNDING_LEG_REPAID_TOPIC),
        ("Aave LiquidationCall",POOL,AAVE_LIQUIDATION_TOPIC),
        ("ERC20 USDC Transfer",source["NQC_DEBT_ASSET"],ERC20_TRANSFER_TOPIC)
    ):
        if label=="ERC20 USDC Transfer":
            # The receipt can contain many ERC20 transfers; final profit
            # transfer is selected below by exact indexed sender/recipient.
            continue
        log=_find_required_log(logs,emitter,topic,label)
        need(log.get("transactionHash","").lower()==ident and
             log.get("blockHash","").lower()==blockhash,
             "source route log belongs to wrong local EOA receipt: "+label)

    funded=_find_required_log(logs,coordinator,FUNDING_COMPLETED_TOPIC,
                              "FundingExecutionCompleted")
    need(len(funded["topics"])==4 and
         all(type(x) is str and HEX32.fullmatch(x) for x in funded["topics"]),
         "funded completion indexed topics mismatch")
    asset_word, principal, surplus, legs=_word_data(
        funded.get("data"),4,"FundingExecutionCompleted")
    need(asset_word >> 160 == 0 and
         "0x"+f"{asset_word:040x}" == source["NQC_DEBT_ASSET"].lower() and
         principal == EXPECTED_PRINCIPAL and
         surplus == EXPECTED_SURPLUS_BEFORE_NATIVE and legs==1,
         "source token/principal/profit/legs mismatch in real local funding receipt")

    repaid=_find_required_log(logs,coordinator,FUNDING_LEG_REPAID_TOPIC,
                              "FundingLegRepaid")
    need(len(repaid["topics"])==3 and
         all(type(x) is str and HEX32.fullmatch(x) for x in repaid["topics"]) and
         int(repaid["topics"][2],16)==0,
         "wrong Aave funding leg index or indexed event")
    kind,lender,amount,premium,repaid_amount=_word_data(
        repaid.get("data"),5,"FundingLegRepaid")
    need(kind==1 and lender >> 160 ==0 and
         "0x"+f"{lender:040x}"==POOL and
         amount==EXPECTED_PRINCIPAL and
         premium==EXPECTED_FEE and
         repaid_amount==EXPECTED_PRINCIPAL+EXPECTED_FEE,
         "Aave flash premium/repayment failed conservation")

    liquidated=_find_required_log(logs,POOL,AAVE_LIQUIDATION_TOPIC,
                                 "Aave LiquidationCall")
    need(len(liquidated["topics"])==4 and
         _topic_address(liquidated["topics"][1],"collateral")==
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" and
         _topic_address(liquidated["topics"][2],"debt")==
            source["NQC_DEBT_ASSET"].lower() and
         _topic_address(liquidated["topics"][3],"borrower")==
            source["NQC_BORROWER"].lower(),
         "wrong Aave collateral/debt/borrower in local liquidation")
    debt, collateral, liquidator, receive_atoken = _word_data(
        liquidated.get("data"),4,"Aave LiquidationCall")
    need(debt==EXPECTED_PRINCIPAL and
         collateral==EXPECTED_COLLATERAL and
         liquidator>>160==0 and
         "0x"+f"{liquidator:040x}"==strategy and
         receive_atoken==0,
         "wrong Aave liquidation amount, operator or collateral mode")

    final_transfers=[]
    for log in logs:
        if type(log) is not dict or type(log.get("topics")) is not list or \
           len(log["topics"])!=3 or type(log.get("address")) is not str or \
           log["address"].lower()!=source["NQC_DEBT_ASSET"].lower() or \
           type(log["topics"][0]) is not str or \
           log["topics"][0].lower()!=ERC20_TRANSFER_TOPIC:
            continue
        if (_topic_address(log["topics"][1],"transfer from")==coordinator and
            _topic_address(log["topics"][2],"transfer to")==operator):
            final_transfers.append(log)
    need(len(final_transfers)==1,
         "must witness exactly one final USDC surplus sweep to test EOA")
    profit_transfer=_word_data(final_transfers[0].get("data"),1,
                               "final EOA profit transfer")[0]
    need(profit_transfer==EXPECTED_SURPLUS_BEFORE_NATIVE,
         "local ERC20 payout does not equal funded execution surplus")

    return {
        "authentic_local_aave_liquidation_event":True,
        "authentic_local_flash_loan_repaid_event":True,
        "authentic_local_funding_completed_event":True,
        "authentic_local_erc20_profit_transfer_to_ephemeral_eoa":True,
        "local_profit_asset_base_units":EXPECTED_SURPLUS_BEFORE_NATIVE,
        "local_principal_repaid_base_units":EXPECTED_PRINCIPAL+EXPECTED_FEE,
        "local_expected_collateral_seized_wei":EXPECTED_COLLATERAL,
        "local_atomic_event_log_sha256":sha256(canonical(logs)).hexdigest(),
        "local_receipt_full_sha256":sha256(canonical(executed)).hexdigest(),
        "not_a_mainnet_or_prospective_profit_witness":True,
    }


def decode_local_receipts(result_file, rpc, operator, source, old_gas):
    need(result_file.is_file() and result_file.stat().st_size<2_000_000,
         "no bounded real Anvil Foundry broadcast transcript")
    obj=historical.strict_json(result_file.read_bytes())
    txs=obj.get("transactions")
    receipts=obj.get("receipts")
    need(type(txs) is list and len(txs)==EXPECTED_RECEIPTS and
         type(receipts) is list and len(receipts)==EXPECTED_RECEIPTS,
         "not exactly three setup + one execute EOA transactions")
    remote=[]
    seen=set()
    for i,record in enumerate(receipts):
        need(type(record) is dict,"receipt source not an object")
        h=record.get("transactionHash")
        need(type(h) is str and HEX32.fullmatch(h)
             and h not in seen, "transaction hash missing/duplicated")
        seen.add(h)
        local=rpc.call("eth_getTransactionReceipt",[h])
        need(type(local) is dict and
             local.get("transactionHash","").lower()==h.lower() and
             local.get("status")=="0x1",
             "real Anvil transaction did not mine and succeed")
        same_keys=("blockHash","transactionHash","gasUsed","to","from","contractAddress")
        for k in same_keys:
            need(str(local.get(k)).lower()==str(record.get(k)).lower(),
                 "Foundry JSON and Anvil JSON-RPC receipt differ: "+k)
        need(local["from"].lower()==operator,
             "unexpected EOA sent local transaction")
        unit=quantity(local.get("gasUsed"),"local full gasUsed")
        need(unit>21_000 and unit<12_000_000,"invalid receipt gasUsed")
        remote.append(local)
    strategy=remote[0].get("contractAddress")
    coordinator=remote[1].get("contractAddress")
    need(type(strategy) is str and ABI_ADDRESS.fullmatch(strategy)
         and type(coordinator) is str and ABI_ADDRESS.fullmatch(coordinator)
         and remote[2].get("to","").lower()==strategy.lower()
         and remote[3].get("to","").lower()==coordinator.lower()
         and remote[2]["contractAddress"] is None and
         remote[3]["contractAddress"] is None,
         "cold NQC setup/executor EOA target identity drift")
    executed=remote[3]
    gas_used=quantity(executed["gasUsed"],"full EOA execute tx gasUsed")
    gas_price=quantity(executed["effectiveGasPrice"],"local effective gas price")
    # PR698 gasleft() is a GROSS internal call delta; EIP-2200/3529
    # post-transaction refunds may reduce receipt gasUsed. Receipt gasUsed is
    # NET of refunds and adds intrinsic/entry gas. Comparing either direction
    # as a strict inequality is unsound. Preserve the signed difference.
    need(old_gas>0,"source gross call gas invalid")
    signed_difference=gas_used-old_gas
    logs=executed.get("logs")
    need(type(logs) is list and len(logs)>5,
         "missing real Aave flash/route receipt event logs")
    events = validate_local_atomic_route_receipt(
        executed,coordinator.lower(),strategy.lower(),operator.lower(),source)
    return {
        "verified_atomic_execution_events":events,
        # Original full local Anvil execute receipt, including every log
        # and hashes, is self-contained evidence. It is NOT a public Ethereum
        # tx receipt: the parent history was forked and 4 EOA txs were LOCAL.
        "fork_only_full_local_execute_receipt":executed,
        "fork_only_setup_transaction_receipt_gas_used":[
            quantity(x["gasUsed"],"setup gas") for x in remote[:3]],
        "fork_only_execute_receipt_gas_used":gas_used,
        "fork_only_execute_receipt_effective_gas_price_wei":gas_price,
        "fork_only_execute_receipt_native_wei_gas_charged":gas_used*gas_price,
        "fork_only_execute_receipt_hash":executed["transactionHash"],
        "fork_only_execute_receipt_block_hash":executed["blockHash"],
        "fork_only_execute_receipt_log_count":len(logs),
        "cold_eoa_sender":operator,
        "isolated_strategy_contract_address":strategy.lower(),
        "isolated_coordinator_contract_address":coordinator.lower(),
        "source_original_gasleft_delta_after_test_setup":old_gas,
        "full_receipt_minus_internal_call_gas":signed_difference,
        "full_receipt_minus_gross_call_is_signed_not_overhead":True,
        "refund_amount_not_directly_certified":True,
        "gross_gasleft_is_not_receipt_gas_used":True,
        "three_setup_deployments_are_not_included_in_execute_receipt_gas":True,
        "fork_gas_fee_is_not_paid_on_public_ethereum":True,
        "mainnet_competitive_inclusion_or_capture_proven":False,
        "real_execution_gas_fee_paid_from_user_or_operator":False,
    }


def run(source_zip, oracle_zip, index_zip, workspace, forge, anvil, cast, out):
    inputs,provenance=validate_original_zip(source_zip)
    oracle_prefix = authenticate_oracle_prefix(oracle_zip,index_zip)
    files=check_source_files(workspace)
    out.mkdir(parents=True,exist_ok=False)
    summary={
        "schema_version":1,
        "status":"INCOMPLETE_LOCAL_COLD_ANVIL_RECEIPT",
        "source":{"archive_sha256":SOURCE_ZIP_SHA,
                  "route_evidence":provenance,
                  "source_files_sha256":files},
        "experiment":"ANVIL_V185_AFTER_AUTHENTICATED_ORACLE_TX0_BEFORE_WINNER_TX1",
        "authenticated_oracle_prefix":oracle_prefix,
        "original_winner_transaction":FORK_WINNER,
        "original_winner_block":PINNED_BLOCK,
        "errors":[],
        "experimental_local_rpc_url":LOCAL_URL,
        "ethereum_mainnet_transaction_submitted":False,
        "ethereum_mainnet_native_gas_spent":False,
        "new_cloud_infrastructure_or_service_billed":False,
        "user_mxn_2000_gas_spent":False,
        "operator_private_key_or_funds_used":False,
        "isolated_test_eoa_only":True,
        "nqc_profit_realized_usd":"0",
        "nqc_realized_pnl_usd":"0",
        "RMC_closed":False,"P2_shadow_certified":False,
        "canary_live_authorized":False,
        "commercial_score_upgrade":False,
        "external_nonrecourse_gas_sponsor_proven":False,
        "source_transaction_known_in_hindsight":True,
        "nqc_cold_execution_mainnet_gas_used_proven":False,
        "nqc_live_capture_rate_proven":False,
        "nqc_complete_net_economics_proven":False,
        "no_claim_that_fork_deployments_are_production_authority":True,
        "started_at_utc":utc_now(),
    }
    process=None
    rpc=LocalAnvil()
    private=None
    try:
        need(str(forge.parent)==str(anvil.parent)==str(cast.parent),
             "Foundry binary tools not sourced from same installation")
        need(all(p.is_file() for p in (forge,anvil,cast)),
             "missing exact pinned Foundry binaries")
        cmd=[str(anvil),"--host","127.0.0.1",
             "--port","18545","--chain-id","1",
             "--fork-url",UPSTREAM_READ_ONLY_RPC,
             "--fork-transaction-hash",FORK_ORACLE_TX0,
             "--no-storage-caching","--compute-units-per-second","5",
             "--retries","0","--silent"]
        with (out/"anvil.log").open("w") as log:
            process=subprocess.Popen(cmd,cwd=workspace,stdout=log,stderr=subprocess.STDOUT)
        limit=time.monotonic()+WAIT_UP_TO_SECONDS
        while time.monotonic()<limit and process.poll() is None:
            try:
                snapshot=check_fork_snapshot(rpc,inputs)
                summary["authenticated_pre_winner_fork"]=snapshot
                summary["authenticated_oracle_prefix"]["anvil_tx_hash_prefix_is_inclusive_at_v185_verified_by_state_only"] = True
                break
            except PrestateDrift as exc:
                # Proven deterministically wrong prewinner state. Do not waste
                # 320 seconds pretending this is an RPC startup readiness issue.
                summary["failed_exact_prewinner_state_witness"]=exc.witness
                raise
            except Exception:
                time.sleep(3)
        else:
            raise Rejected("LOCAL_ANVIL_HISTORICAL_FORK_PRESTATE_NOT_VERIFIED")
        private, operator=get_test_ephemeral_eoa(cast)
        summary["ephemeral_test_eoa_address"]=operator
        rpc.call("anvil_setBalance",[operator,"0x3635c9adc5dea00000"])
        need(quantity(rpc.call("eth_getBalance",[operator,"latest"]),"local test balance")>=10**20,
             "Anvil did not mint test-only ETH to generated EOA")
        env={**os.environ,**inputs,
             "NQC_LOCAL_TEST_OPERATOR":operator,
             "ETH_RPC_URL":LOCAL_URL,
             "NQC_FLASH_FEE":str(EXPECTED_FEE)}
        # The generated local EOA key exists only as transient CLI argument.
        # This never accepts or reads the user's real account, wallet or mnemonic.
        command=[str(forge),"script",
                 "script/NqcV2LocalColdReceipt.s.sol:NqcV2LocalColdReceiptScript",
                 "--rpc-url",reject_nonlocal_url(LOCAL_URL),
                 "--private-key",private,"--broadcast","--slow",
                 "--non-interactive"]
        script=subprocess.run(command,cwd=workspace,env=env,
                              text=True,capture_output=True,
                              timeout=FORGE_UP_TO_SECONDS)
        log=(script.stdout+"\n"+script.stderr).replace(private,"[REDACTED_EPHEMERAL_KEY]")
        (out/"forge-script.log").write_text(log)
        private=None
        need(script.returncode==0,"LOCAL_ANVIL_FORGE_SCRIPT_OR_TX_FAILED")
        traces=list((workspace/"broadcast").glob(
            "NqcV2LocalColdReceipt.s.sol/*/run-latest.json"))
        need(len(traces)==1,"exactly one local Foundry broadcast receipt trace needed")
        gas=decode_local_receipts(traces[0],rpc,operator,
                                  inputs,1_115_038)
        summary["full_local_eoa_receipts"]=gas
        summary["status"]="HISTORICAL_LOCAL_ANVIL_FULL_EOA_RECEIPT_NO_MAINNET_CAPTURE"
    except Exception as exc:
        anvil_log=out/"anvil.log"
        logtail=""
        if anvil_log.exists():
            logtail=anvil_log.read_text(errors="replace")[-1400:]
        summary["errors"].append({
            "stage":"local_Anvil_source_or_broadcast",
            "type":type(exc).__name__,
            "message":str(exc).split("https://")[0][:240],
            "anvil_last_1400_log_characters":logtail,
        })
    finally:
        if process is not None:
            process.terminate()
            try:process.wait(timeout=12)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=12)
        summary["local_rpc_calls_recorded"]=rpc.calls
        summary["local_rpc_transcript"]=rpc.transcript
        summary["finished_at_utc"]=utc_now()
        (out/"local-cold-receipt.json").write_bytes(canonical(summary))
    return summary


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source-zip",type=Path,required=True)
    p.add_argument("--oracle-zip",type=Path,required=True)
    p.add_argument("--index-zip",type=Path,required=True)
    p.add_argument("--workspace",type=Path,required=True)
    p.add_argument("--forge",type=Path,required=True)
    p.add_argument("--anvil",type=Path,required=True)
    p.add_argument("--cast",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    need(args.out.is_absolute() and not args.out.exists() and
         args.out.parent.exists(),"unique absolute output dir required")
    doc=run(args.source_zip.read_bytes(),args.oracle_zip.read_bytes(),
            args.index_zip.read_bytes(),args.workspace,
            args.forge,args.anvil,args.cast,args.out)
    print(doc["status"],"local_eoa_receipt_gas",
          doc.get("full_local_eoa_receipts",{}).get(
              "fork_only_execute_receipt_gas_used"),
          "errors",doc["errors"])
    return 0 if doc["status"]=="HISTORICAL_LOCAL_ANVIL_FULL_EOA_RECEIPT_NO_MAINNET_CAPTURE" else 2


if __name__=="__main__":
    raise SystemExit(main())
