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


# Ethereum Keccak-256, NOT hashlib.sha3_256. Self-contained so source
# receipt witnesses remain verifiable offline without pip/remote dependencies.
_KECCAK_RC=(
    0x0000000000000001,0x0000000000008082,0x800000000000808a,0x8000000080008000,
    0x000000000000808b,0x0000000080000001,0x8000000080008081,0x8000000000008009,
    0x000000000000008a,0x0000000000000088,0x0000000080008009,0x000000008000000a,
    0x000000008000808b,0x800000000000008b,0x8000000000008089,0x8000000000008003,
    0x8000000000008002,0x8000000000000080,0x000000000000800a,0x800000008000000a,
    0x8000000080008081,0x8000000000008080,0x0000000080000001,0x8000000080008008,
)
_KECCAK_RHO=(
    (0,1,62,28,27),(36,44,6,55,20),(3,10,43,25,39),
    (41,45,15,21,8),(18,2,61,56,14),
)
_MASK64=(1<<64)-1
DRIFT_TOPIC="0xe238684811f086aea189615aa2ab3f4e6f5f589a82de7c34d422725ea6783829"
_DRIFT_PPM_DENOM=1_000_000


def ethereum_keccak256(data):
    need(type(data) is bytes and len(data)<=2048,
         "invalid offline Ethereum keccak256 input")
    def rol(x,n):
        return (((x<<n)|(x>>(64-n)))&_MASK64) if n else x
    padded=bytearray(data)
    padded.append(1)
    while len(padded)%136!=135:
        padded.append(0)
    padded.append(0x80)
    a=[0]*25
    for offset in range(0,len(padded),136):
        for i in range(17):
            a[i]^=int.from_bytes(padded[offset+i*8:offset+i*8+8],"little")
        for rc in _KECCAK_RC:
            c=[a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20] for x in range(5)]
            for x in range(5):
                d=c[(x-1)%5]^rol(c[(x+1)%5],1)
                for y in range(5):
                    a[x+y*5]^=d
            b=[0]*25
            for x in range(5):
                for y in range(5):
                    b[y+5*((2*x+3*y)%5)]=rol(a[x+5*y],_KECCAK_RHO[y][x])
            for x in range(5):
                for y in range(5):
                    a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y])
            a[0]^=rc
    return b"".join(a[i].to_bytes(8,"little") for i in range(4))


def verify_next_synthetic_block_state(event,public_inputs,block_number):
    need(type(event) is dict and len(event.get("topics",[]))==1,
         "one-shot state drift witness topics must be unindexed")
    expected=public_inputs["NQC_PRESTATE_ABI"]
    need(type(expected) is str and
         re.fullmatch(r"0x[0-9a-fA-F]{384}",expected),
         "expected historic prewinner ABI absent")
    values=old._word_data(event.get("data"),15,"LocalOneShotStateDrift")
    expected_words=[int(expected[2+i*64:2+(i+1)*64],16) for i in range(6)]
    observed_words=values[8:14]
    need(values[2:8]==expected_words and
         values[0]==int.from_bytes(ethereum_keccak256(bytes.fromhex(expected[2:])),"big") and
         values[1]==int.from_bytes(ethereum_keccak256(
             b"".join(x.to_bytes(32,"big") for x in observed_words)),"big"),
         "local execution state hashes and original six ABI words differ")
    for i,(prior,actual) in enumerate(zip(expected_words,observed_words)):
        if i in (0,1,5):
            tolerance=prior//_DRIFT_PPM_DENOM+1
            need(prior>0 and prior-tolerance<=actual<=prior+tolerance,
                 "local one-block accrual exceeds expressly posthoc 1ppm")
        else:
            need(actual==prior,"non-accrual borrower configuration changed")
    need(0<expected_words[5]<10**18 and 0<observed_words[5]<10**18,
         "account not actually liquidatable on original and current states")
    need(block_number==old.PINNED_BLOCK+1,
         "one-shot transaction was not the very next synthetic block")
    timestamp=values[14]
    source_timestamp=int(public_inputs["NQC_WINNER_TIMESTAMP"])
    need(source_timestamp<=timestamp<=source_timestamp+60,
         "local synthetic block timestamp not pinned close to source")
    return {
        "historical_preoracle_winner_account_keccak256":"0x"+values[0].to_bytes(32,"big").hex(),
        "actual_next_block_account_keccak256":"0x"+values[1].to_bytes(32,"big").hex(),
        "original_six_abi_uint256_values":expected_words,
        "actual_six_abi_uint256_values":observed_words,
        "execution_minus_original_integer_deltas":[x-y for x,y in zip(observed_words,expected_words)],
        "hf_source_wad":expected_words[5],
        "hf_execution_wad":observed_words[5],
        "source_and_execution_hf_below_one":True,
        "actual_execution_state_1ppm_posthoc_guard_passed":True,
        "one_synthetic_block_after_source_oracle_tx0":True,
        "source_equals_execution_six_word_abi":observed_words==expected_words,
        "same_block_real_ethereum_execution_proven":False,
    }


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

    drift=unique(one_shot,DRIFT_TOPIC,"LocalOneShotStateDrift")
    drift_proof=verify_next_synthetic_block_state(
        drift,public_inputs,old.quantity(receipt.get("blockNumber"),"one-shot block"))

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
        "local_execution_one_block_state_drift":drift_proof,
        "local_original_exact_prestate_checked_before_synthetic_broadcast":True,
        "local_execution_uses_strict_1ppm_posthoc_drift_guard":True,
        "local_two_stage_erc20_profit_payout_to_test_eoa":True,
        "exact_local_usdc_profit_before_native_costs_base_units":EXPECTED_GROSS,
        "real_local_receipt_sha256":sha256(old.canonical(receipt)).hexdigest(),
        "real_local_34log_reference_not_reused_as_gas_quote":True,
        "no_three_post_trigger_setup_eoa_transactions":True,
        "no_pretrigger_contract_deployment_required_in_test_design":True,
        "one_backrun_body_tx_assumed_eligible_but_not_verified_by_svr":True,
        "real_mainnet_broadcast_or_inclusion":False,
    }


def authenticate_failed_loopback_receipt(receipt,tx_hash,operator):
    """A reverted or rejected local tx is NEVER a successful liquidation."""
    need(type(receipt) is dict and
         receipt.get("transactionHash","").lower()==tx_hash.lower() and
         receipt.get("from","").lower()==operator.lower() and
         receipt.get("status")=="0x0" and
         receipt.get("to") in (None,"") and
         receipt.get("contractAddress") in (None,""),
         "expected exact locally reverted EOA constructor receipt")
    g=old.quantity(receipt.get("gasUsed"),"reverted local gasUsed")
    p=old.quantity(receipt.get("effectiveGasPrice"),"reverted local price")
    need(g>21000 and p>0,"malformed local reverted gas")
    return {
        "status":"LOCALLY_MINED_EOA_CONSTRUCTOR_REVERTED_NO_PROFIT",
        "source":"127.0.0.1:18545_anvil_receipt_only",
        "transaction_hash":tx_hash,
        "receipt_block_hash":receipt.get("blockHash"),
        "gas_used_by_failed_local_tx":g,
        "effective_gas_price_wei":p,
        "hypothetical_local_synthetic_eth_gas_debit_wei":g*p,
        "receipt_sha256":sha256(old.canonical(receipt)).hexdigest(),
        "logs_empty_due_revert":receipt.get("logs")==[],
        "actual_profit_claimed":False,
        "nqc_realized_pnl_usd":"0",
        "real_mainnet_transaction":False,
    }



def authenticate_single_eoa_submission(tx,receipt,block,operator,public_inputs):
    """Prove recorded loopback tx fits Cancun CREATE-initcode and one block.

    This tests Ethereum-format/size *mechanics*, not private relay policy or
    searcher access. Caller can ONLY retrieve tx+block from isolated loopback.
    """
    need(type(tx) is dict and type(receipt) is dict and type(block) is dict,
         "transaction/receipt/local block witness missing")
    txhash=receipt.get("transactionHash")
    b_hash=receipt.get("blockHash")
    b_num=old.quantity(receipt.get("blockNumber"),"local receipt block")
    need(type(txhash) is str and old.HEX32.fullmatch(txhash)
         and type(b_hash) is str and old.HEX32.fullmatch(b_hash)
         and b_num==old.PINNED_BLOCK+1,
         "one-shot transaction is not local block immediately after tx0")
    need(tx.get("hash")==txhash and tx.get("blockHash")==b_hash
         and tx.get("blockNumber")==receipt["blockNumber"]
         and tx.get("to") is None and receipt.get("to") is None
         and tx.get("from","").lower()==operator.lower()
         and receipt.get("from","").lower()==operator.lower(),
         "EOA CREATE tx recipient, sender or mined identity mismatch")
    need(old.quantity(tx.get("chainId"),"one-shot chain")==1 and
         old.quantity(tx.get("nonce"),"new synthetic EOA nonce")==0 and
         old.quantity(tx.get("value"),"native value sent")==0,
         "wrong chain, reused real EOA or inventory supplied")
    need(old.quantity(tx.get("type"),"tx EIP2718 type")==2,
         "one-shot receipt not expected EIP-1559 typed CREATE")
    tx_limit=old.quantity(tx.get("gas"),"one-shot EOA gas limit")
    actual=old.quantity(receipt.get("gasUsed"),"one-shot receipt gasUsed")
    b_limit=old.quantity(block.get("gasLimit"),"isolated local block gas limit")
    b_used=old.quantity(block.get("gasUsed"),"isolated local block gas used")
    effective=old.quantity(receipt.get("effectiveGasPrice"),"effective paid wei/gas")
    cap=old.quantity(tx.get("maxFeePerGas"),"EOA fee cap")
    priority=old.quantity(tx.get("maxPriorityFeePerGas"),"EOA priority cap")
    need(0<actual<=tx_limit<=b_limit and b_used==actual and
         0<effective<=cap and priority<=cap,
         "invalid EIP-1559 gas, block or fee conservation")
    need(block.get("hash")==b_hash and block.get("number")==receipt["blockNumber"]
         and block.get("transactions")==[txhash],
         "Anvil newly mined local block contains zero or multiple EOA txs")
    raw=tx.get("input")
    need(type(raw) is str and raw.startswith("0x") and
         re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+",raw) is not None,
         "missing/malformed CREATE initcode and ABI arguments")
    calldata=bytes.fromhex(raw[2:])
    # EIP-3860 Cancun max initcode size: 2*EIP-170 runtime cap = 49,152.
    # A passing public EVM local receipt still does not prove relay acceptance.
    need(0<len(calldata)<=49152,"CREATE initcode exceeds canonical EIP-3860 max")
    src_word=public_inputs.get("NQC_PRESTATE_ABI")
    parent=public_inputs.get("NQC_PARENT_HASH")
    borrower=public_inputs.get("NQC_BORROWER")
    need(type(src_word) is str and type(parent) is str and
         type(borrower) is str and
         src_word.lower().startswith("0x") and
         src_word[2:].lower() in raw.lower() and
         parent[2:].lower() in raw.lower() and
         old.FORK_WINNER[2:].lower() in raw.lower() and
         ("0"*24+borrower[2:].lower()) in raw.lower(),
         "CREATE constructor calldata lacks immutable borrower, parent, winner or 6-word risk")
    need(actual<10_000_000,
         "more than 10M gas in local one-shot CREATE, reject oversized candidate")
    return {
        "one_and_only_local_block_tx_identity_verified":True,
        "local_block_number":b_num,
        "locally_mined_block_gas_limit_units":b_limit,
        "locally_mined_block_gas_used_units":b_used,
        "local_eoa_transaction_gas_limit_units":tx_limit,
        "local_eoa_receipt_gas_used_units":actual,
        "local_single_tx_fraction_of_block_gas_limit_bps_ceil":
            (actual*10_000+b_limit-1)//b_limit,
        "eip1559_transaction_type":2,
        "eoa_nonce":0,
        "eoa_native_value_wei":0,
        "local_eoa_max_fee_per_gas_wei":cap,
        "local_eoa_max_priority_fee_per_gas_wei":priority,
        "local_effective_gas_price_wei":effective,
        "eip3860_cancun_max_initcode_bytes":49152,
        "actual_create_initcode_and_constructor_args_bytes":len(calldata),
        "actual_create_initcode_and_args_sha256":sha256(calldata).hexdigest(),
        "constructor_args_embed_exact_source_hash_parent_borrower_and_abi":True,
        "no_second_eoa_in_locally_mined_block":True,
        "one_transaction_is_not_mev_share_svr_relay_admission":True,
        "original_same_block_competitor_slot_access_unproven":True,
        "source_is_post_oracle_tx0_next_synthetic_block_not_real_winner_slot":True,
        "nqc_paid_no_public_ethereum_gas":True,
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
        if command.returncode != 0:
            # First-run failed constructor evidence was previously censored:
            # Foundry exposed only "Transaction Failure: 0x<hash>". Query ONLY
            # the ephemeral loopback transaction receipt and optional trace.
            # Never interpret a reverted receipt as a profitable attempt.
            failed_hashes=re.findall(
                r"Transaction Failure:\s*(0x[0-9a-fA-F]{64})",lines)
            if len(failed_hashes)==1:
                bad_hash=failed_hashes[0]
                try:
                    local_failed=rpc.call("eth_getTransactionReceipt",[bad_hash])
                    result["unclassified_local_failure_receipt"]={
                        "source":"127.0.0.1:18545_only",
                        "original_failure_tx_hash":bad_hash,
                        "fields":{k:local_failed.get(k) for k in (
                            "transactionHash","blockHash","blockNumber",
                            "from","to","contractAddress",
                            "status","gasUsed","effectiveGasPrice",
                            "type","cumulativeGasUsed","revertReason")}
                            if type(local_failed) is dict else None,
                        "full_response_sha256":sha256(
                            old.canonical(local_failed)).hexdigest(),
                        "never_proof_of_renewable_profit":True,
                        "real_mainnet_transaction":False,
                    }
                    result["local_failure_receipt_witness"]=authenticate_failed_loopback_receipt(
                        local_failed,bad_hash,operator)
                except Exception as exc:
                    result["local_failure_receipt_lookup_error"]={
                        "type":type(exc).__name__,
                        "detail":str(exc).split("https://")[0][:160],
                    }
                try:
                    trace=subprocess.run([
                        str(cast),"run",bad_hash,"--rpc-url",
                        old.reject_nonlocal_url(LOCAL),"--trace-depth","20",
                    ],cwd=workspace,env=env,capture_output=True,text=True,timeout=90)
                    data=(trace.stdout+"\n"+trace.stderr).replace(
                        "0x"+"0"*64,"[INVALID_ZERO_HASH]")
                    (out/"cast-local-failure-trace.log").write_text(data[:300_000])
                    result["cast_local_failure_trace"]={
                        "exit_code":trace.returncode,
                        "sha256":sha256(data[:300_000].encode()).hexdigest(),
                        "only_loopback_anvil_replay":True,
                        "not_real_nqc_inclusion":True,
                    }
                except Exception as exc:
                    result["cast_local_failure_trace_error"]=type(exc).__name__
            else:
                result["source_transaction_failure_hashes_found"]=len(failed_hashes)
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
        # A receipt proves effect/gas; bind the *transaction envelope* as well.
        # Both RPC reads are on the already-validated localhost Anvil only.
        mined_tx=rpc.call("eth_getTransactionByHash",[receipt["transactionHash"]])
        mined_block=rpc.call("eth_getBlockByNumber",[receipt["blockNumber"],False])
        result["one_shot_eoa_submission_footprint"]=authenticate_single_eoa_submission(
            mined_tx,independent,mined_block,operator,inputs)
        result["full_original_local_transaction"]=mined_tx
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
