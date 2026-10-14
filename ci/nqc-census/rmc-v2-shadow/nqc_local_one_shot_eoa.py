#!/usr/bin/env python3
"""ONE complete contract-creation EOA liquidation tx against isolated 127.0.0.1 Anvil.

Authenticates same PR698 Aave funded route, PR700 Chainlink oracle tx0 and PR693
original winning tx1 as PR723. This EXPERIMENT replaces four after-trigger EOA
transactions with one atomic constructor deploy+flash+swap+USDC payout EOA tx.

No mainnet broadcast, user EOA, real native gas, deployment, SVR access or profit.
All writes are to loopback ephemeral Anvil with synthetic ETH only.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
import time

import nqc_local_anvil_cold_receipt as old

ONE_SHOT_SCRIPT = "script/NqcV2OneShotAtomicLocal.s.sol:NqcV2OneShotBroadcastScript"
LOCAL = old.LOCAL_URL
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
SOURCE_WINNER = old.FORK_WINNER
EXPECTED_GROSS = old.EXPECTED_SURPLUS_BEFORE_NATIVE


class Rejected(ValueError):
    pass


def need(ok,why):
    if not ok:raise Rejected(why)


def report_source(receipt,public_inputs,operator):
    need(type(receipt) is dict and
         receipt.get("status")=="0x1" and
         receipt.get("from","").lower()==operator and
         receipt.get("to") in (None,"") and
         type(receipt.get("contractAddress")) is str and
         old.ABI_ADDRESS.fullmatch(receipt["contractAddress"]),
         "not one successful local EOA CREATE receipt")
    one_shot=receipt["contractAddress"].lower()
    logs=receipt.get("logs")
    need(type(logs) is list and 6<=len(logs)<=200,
         "missing bounded original Aave liquidation logs")
    txhash=receipt.get("transactionHash")
    blockhash=receipt.get("blockHash")
    need(type(txhash) is str and old.HEX32.fullmatch(txhash) and
         type(blockhash) is str and old.HEX32.fullmatch(blockhash),
         "invalid local transaction/block identity")
    for row in logs:
        need(type(row) is dict and row.get("transactionHash")==txhash and
             row.get("blockHash")==blockhash,
             "source log does not belong to one EOA tx")
    def unique(emitter,topic,name):
        rows=[r for r in logs if r["address"].lower()==emitter and
              type(r.get("topics")) is list and r["topics"] and
              r["topics"][0].lower()==topic]
        need(len(rows)==1,"missing/duplicated "+name)
        return rows[0]

    # Static Ethereum keccak256 event selector checked independently against
    # a Keccak-f[1600] implementation, no optional Crypto dependency.
    one_topic="0x24e59545e75cb035e07191d48b8d7e75163aebd237dafa18ff0aae720a7c00ec"
    log=unique(one_shot,one_topic,"one-shot constructor completion event")
    need(len(log["topics"])==4 and
         old._topic_address(log["topics"][1],"operator")==operator,
         "one-shot caller event not ephemeral local EOA")
    strategy=old._topic_address(log["topics"][2],"strategy")
    coordinator=old._topic_address(log["topics"][3],"coordinator")
    winner,profit,source_block=old._word_data(log.get("data"),3,"OneShot")
    need(winner==int(SOURCE_WINNER,16) and profit==EXPECTED_GROSS and
         old.PINNED_BLOCK<=source_block<=old.PINNED_BLOCK+8 and
         source_block==old.quantity(receipt.get("blockNumber"),"one-shot receipt block"),
         "one-shot original winner/profit/block mismatch")

    aave=unique(old.POOL,old.AAVE_LIQUIDATION_TOPIC,"Aave LiquidationCall")
    need(len(aave["topics"])==4 and
         old._topic_address(aave["topics"][1],"collateral")==
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" and
         old._topic_address(aave["topics"][2],"debt")==USDC and
         old._topic_address(aave["topics"][3],"borrower")==
            public_inputs["NQC_BORROWER"].lower(),
         "wrong Aave source collateral/debt/borrower")
    principal,seized,liquidator,atoken=old._word_data(
        aave.get("data"),4,"LiquidationCall")
    need(principal==old.EXPECTED_PRINCIPAL and
         seized==old.EXPECTED_COLLATERAL and
         liquidator==int(strategy,16) and atoken==0,
         "Aave source amounts/borrower liquidator drift")

    repaid=unique(coordinator,old.FUNDING_LEG_REPAID_TOPIC,"FundingLegRepaid")
    need(len(repaid["topics"])==3 and
         int(repaid["topics"][2],16)==0,"wrong flash funding leg")
    kind,lender,amount,premium,total=old._word_data(
        repaid.get("data"),5,"FundingLegRepaid")
    need(kind==1 and lender==int(old.POOL,16) and
         amount==old.EXPECTED_PRINCIPAL and
         premium==old.EXPECTED_FEE and total==amount+premium,
         "flash principal+premium not actually repaid")
    completed=unique(coordinator,old.FUNDING_COMPLETED_TOPIC,"FundingExecutionCompleted")
    asset,committed_principal,profit,legs=old._word_data(
        completed.get("data"),4,"FundingExecutionCompleted")
    need(asset==int(USDC,16) and committed_principal==amount and
         profit==EXPECTED_GROSS and legs==1,
         "coordinator final funded surplus not certified")
    transfers=[]
    for log in logs:
        if log.get("address","").lower()!=USDC or \
           type(log.get("topics")) is not list or len(log["topics"])!=3 or \
           log["topics"][0].lower()!=old.ERC20_TRANSFER_TOPIC:
            continue
        transfers.append({
            "from":old._topic_address(log["topics"][1],"from"),
            "to":old._topic_address(log["topics"][2],"to"),
            "amount":old._word_data(log.get("data"),1,"transfer")[0],
        })
    require1=sum(x=={"from":coordinator,"to":one_shot,
                     "amount":EXPECTED_GROSS} for x in transfers)
    require2=sum(x=={"from":one_shot,"to":operator,
                     "amount":EXPECTED_GROSS} for x in transfers)
    need(require1==1 and require2==1,
         "exact USDC profit was not swept coordinator→oneShot→local EOA")
    used=old.quantity(receipt.get("gasUsed"),"one EOA creation gasUsed")
    fee=old.quantity(receipt.get("effectiveGasPrice"),"local gas price")
    need(21_000<used<30_000_000 and fee>0,
         "unbounded/zero local EOA gas")
    return {
        "one_and_only_local_eoa_tx_actual_gas_used":used,
        "local_actual_effective_gas_price_wei":fee,
        "synthetic_local_eoa_paid_wei":used*fee,
        "one_shot_contract_created_address":one_shot,
        "local_operator":operator,
        "coordinator_deployed_in_same_eoa_tx":coordinator,
        "borrower_specific_strategy_deployed_in_same_eoa_tx":strategy,
        "local_source_aave_liquidation_event_verified":True,
        "local_source_flash_repaid_event_verified":True,
        "local_source_funded_completion_event_verified":True,
        "local_two_stage_erc20_profit_payout_to_test_eoa":True,
        "exact_local_usdc_profit_before_native_costs_base_units":EXPECTED_GROSS,
        "real_local_receipt_sha256":sha256(old.canonical(receipt)).hexdigest(),
        "real_local_34log_reference_not_reused_as_gas_quote":True,
        "no_three_post_trigger_setup_eoa_transactions":True,
        "no_pretrigger_contract_deployment_required_in_test_design":True,
        "one_backrun_body_tx_assumed_eligible_but_not_verified_by_svr":True,
        "real_mainnet_broadcast_or_inclusion":False,
    }


def run(funded_zip,oracle_zip,index_zip,workspace,forge,anvil,cast,out):
    inputs,provenance=old.validate_original_zip(funded_zip)
    oracle_source=old.authenticate_oracle_prefix(oracle_zip,index_zip)
    hashes=old.check_source_files(workspace)
    script_source=workspace/"script/NqcV2OneShotAtomicLocal.s.sol"
    need(script_source.is_file() and not script_source.is_symlink(),
         "new isolated one-shot Solidity source absent")
    hashes[str(script_source.relative_to(workspace))]=old.sha_file(script_source)
    need(not out.exists() and out.is_absolute() and out.parent.is_dir(),
         "out dir not new/absolute")
    out.mkdir()
    result={
        "schema_version":1,
        "status":"INCOMPLETE_LOCAL_SINGLE_EOA_ORACLE_BACKRUN",
        "original_route_archive_sha256":old.SOURCE_ZIP_SHA,
        "original_oracle_archive_sha256":old.ORACLE_SOURCE_ZIP_SHA,
        "original_indexed_corpus_sha256":old.original_index.INDEX_ARTIFACT_SHA,
        "source_files_sha256":hashes,
        "original_funded_source":provenance,
        "oracle_source":oracle_source,
        "errors":[],
        "source_hindsight_winner_tx1":SOURCE_WINNER,
        "original_oracle_tx0":old.FORK_ORACLE_TX0,
        "test_only_rpc":LOCAL,
        "public_ethereum_transaction_broadcast":False,
        "user_wallet_or_private_key_used":False,
        "public_ethereum_native_gas_paid":False,
        "user_mxn_2000_spent":False,
        "production_pretrigger_access_proven":False,
        "actual_mev_share_or_svr_inclusion_proven":False,
        "mainnet_net_ev_or_profit_proven":False,
        "nonrecourse_external_gas_sponsor_proven":False,
        "P2_shadow_certified":False,"RMC_closed":False,
        "canary_live_authorized":False,
        "commercial_score_upgrade":False,
        "nqc_realized_pnl_usd":"0",
    }
    process=None;private=None
    rpc=old.LocalAnvil()
    try:
        need(forge.parent==anvil.parent==cast.parent and
             all(x.is_file() for x in (forge,anvil,cast)),
             "not three pinned same-release Foundry binaries")
        with (out/"anvil.log").open("w") as log:
            process=subprocess.Popen([
                str(anvil),"--host","127.0.0.1",
                "--port","18545","--chain-id","1",
                "--fork-url",old.UPSTREAM_READ_ONLY_RPC,
                "--fork-transaction-hash",old.FORK_ORACLE_TX0,
                "--no-storage-caching","--compute-units-per-second","5",
                "--retries","0","--silent",
            ],cwd=workspace,stdout=log,stderr=subprocess.STDOUT)
        limit=time.monotonic()+old.WAIT_UP_TO_SECONDS
        while time.monotonic()<limit and process.poll() is None:
            try:
                result["exact_prewinner_local_fork"]=old.check_fork_snapshot(rpc,inputs)
                break
            except old.PrestateDrift as exc:
                result["failed_original_borrower_state_witness"]=exc.witness
                raise
            except Exception:
                time.sleep(3)
        else:
            raise Rejected("ONE_SHOT_LOCAL_ANVIL_PREWINNER_STATE_NOT_VERIFIED")
        private,operator=old.get_test_ephemeral_eoa(cast)
        result["ephemeral_test_operator"]=operator
        rpc.call("anvil_setBalance",[operator,"0x3635c9adc5dea00000"])
        need(old.quantity(rpc.call("eth_getBalance",[operator,"latest"]),
                          "synthetic gas balance")>=10**20,
             "no local-only test ETH")
        env={**os.environ,**inputs,"NQC_FLASH_FEE":str(old.EXPECTED_FEE),
             "NQC_LOCAL_TEST_OPERATOR":operator,"ETH_RPC_URL":LOCAL}
        cmd=[str(forge),"script",ONE_SHOT_SCRIPT,
             "--rpc-url",old.reject_nonlocal_url(LOCAL),
             "--private-key",private,"--broadcast","--slow","--non-interactive"]
        command=subprocess.run(cmd,cwd=workspace,env=env,
                               capture_output=True,text=True,
                               timeout=old.FORGE_UP_TO_SECONDS)
        lines=(command.stdout+"\n"+command.stderr).replace(
            private,"[REDACTED_EPHEMERAL_ONE_SHOT_KEY]")
        (out/"forge-script.log").write_text(lines)
        private=None
        need(command.returncode==0,
             "ONE_SHOT_FORGE_TRANSACTION_CREATION_OR_EXECUTION_FAILED")
        outputs=list((workspace/"broadcast").glob(
            "NqcV2OneShotAtomicLocal.s.sol/*/run-latest.json"))
        need(len(outputs)==1,"not exactly one one-shot Foundry broadcast trace")
        doc=old.historical.strict_json(outputs[0].read_bytes())
        txs=doc.get("transactions")
        receipts=doc.get("receipts")
        need(type(txs) is list and len(txs)==1 and
             type(receipts) is list and len(receipts)==1,
             "one-shot execution unexpectedly emitted 2+ EOA transactions")
        receipt=receipts[0]
        need(type(receipt) is dict and
             type(receipt.get("transactionHash")) is str and
             old.HEX32.fullmatch(receipt["transactionHash"]),
             "missing local receipt hash")
        independent=rpc.call("eth_getTransactionReceipt",[receipt["transactionHash"]])
        need(type(independent) is dict,"Anvil did not return actual local receipt")
        for field in ("transactionHash","blockHash","gasUsed","effectiveGasPrice",
                      "from","to","contractAddress"):
            need(str(receipt.get(field)).lower()==str(independent.get(field)).lower(),
                 "Foundry transcript disagrees with Anvil receipt "+field)
        result["local_single_eoa_receipt_economic_proof"]=report_source(
            independent,inputs,operator)
        result["full_original_local_receipt"]=independent
        result["status"]="SINGLE_ATOMIC_LOCAL_EOA_FLASH_LIQUIDATION_NO_MAINNET"
    except Exception as exc:
        result["errors"].append({
            "type":type(exc).__name__,
            "message":str(exc).split("https://")[0][:220]})
    finally:
        private=None
        if process is not None:
            process.terminate()
            try:process.wait(timeout=12)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=12)
        result["local_anvil_rpc_transcript"]=rpc.transcript
        (out/"single-eoa-local.json").write_bytes(old.canonical(result))
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for arg in ("source_zip","oracle_zip","index_zip","workspace",
                "forge","anvil","cast","out"):
        p.add_argument("--"+arg.replace("_","-"),required=True,type=Path)
    args=p.parse_args()
    d=run(args.source_zip.read_bytes(),args.oracle_zip.read_bytes(),
          args.index_zip.read_bytes(),args.workspace,
          args.forge,args.anvil,args.cast,args.out)
    print(d["status"],"gas",d.get(
        "local_single_eoa_receipt_economic_proof",{}).get(
        "one_and_only_local_eoa_tx_actual_gas_used"),
        "errors",d["errors"])
    return 0 if d["status"]=="SINGLE_ATOMIC_LOCAL_EOA_FLASH_LIQUIDATION_NO_MAINNET" else 2


if __name__=="__main__":
    raise SystemExit(main())
