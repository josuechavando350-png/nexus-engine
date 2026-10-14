#!/usr/bin/env python3
"""Adversarial source-frozen one-shot EOA CREATE across THREE canonical fork states.

PR726 already proves ONE isolated LOCAL EOA receipt on a prefix after Chainlink
tx0, before original competitor tx1. This gate asks whether the SAME exact
CREATE initcode can even simulate BEFORE oracle tx0 or AFTER the competitor
already liquidated, without tampering Aave storage, price or borrower balance.

The only transaction used here is eth_call (simulation) on 127.0.0.1:18546.
No Ethereum signing, no mainnet broadcast, no user funds or capture claim.
One synthetic empty local block in PRE_ORACLE preserves the historical parent.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path,PurePosixPath
import re
import socket
import stat
import subprocess
import time
from urllib.request import Request,urlopen
import zipfile

import nqc_local_one_shot_eoa as one
import nqc_local_anvil_cold_receipt as old

ARCHIVE_SHA="1486986943d79a5e52da86e015a7c720f35ac979c062b658699853820e17b2b4"
ARCHIVE_HEAD="b6db90946d18e8199268acc1a5eb5ee3f4c541f4"
ARCHIVE_TREE="8630f41fa1df8e2f3afbcd3928bd04236c2cc49f"
ARCHIVE_RUN=38631895351
ARCHIVE_ARTIFACT=11925719701
PR698_SHA="6778f8e190d13c739331f731ca532d8607e3f653ca000de746b058b4903c7d7d"
TX0="0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b"
TX1=old.FORK_WINNER
SOURCE_BLOCK=26_142_067
PARENT_BLOCK=SOURCE_BLOCK-1
PORT=18546
LOCAL_URL=f"http://127.0.0.1:{PORT}"
FORK_URL=old.UPSTREAM_READ_ONLY_RPC
EXPECTED_HF_WAD=996350145012801388
EXPECTED_LOCAL_ONE_SHOT_GAS=3914680
EXPECTED_BYTES=18732
EXPECTED_INIT_SHA="c4727076394f1e0f00a771171682c67665c840ab49457f8d3f5f274cb9dac706"
PRE_ORACLE="PRE_ORACLE_NO_TX0"
AFTER_ORACLE="AFTER_ORACLE_TX0_BEFORE_WINNER_TX1"
AFTER_WINNER="AFTER_WINNER_TX1"
MODES=(PRE_ORACLE,AFTER_ORACLE,AFTER_WINNER)
MAX_CALLS_PER_MODE=24
MAX_RESPONSE_BYTES=2_500_000
WAIT_SECONDS=160
RELEASE_SHA_RE=re.compile(r"[0-9a-f]{64}\Z")
HEX32=re.compile(r"0x[0-9a-fA-F]{64}\Z")
ABI6=re.compile(r"0x[0-9a-fA-F]{384}\Z")
EVM_RETURN=re.compile(r"0x[0-9a-fA-F]*\Z")
ADDR=re.compile(r"0x[0-9a-fA-F]{40}\Z")
REVERT_REASONS=(
    "EXECUTION_STATE_EXCEEDS_ONE_PPM_DRIFT",
    "SOURCE_ACCOUNT_CONFIG_CHANGED",
    "PREWINNER_OR_EXECUTION_HF_NOT_LIQUIDATABLE",
)


class Rejected(ValueError):
    pass


def need(condition,reason):
    if not condition:raise Rejected(reason)


def now():
    return datetime.now(timezone.utc).isoformat()


def canon(x):
    return (json.dumps(x,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def strict_json(raw):
    def pairs(items):
        d={}
        for k,v in items:
            need(k not in d,"duplicate immutable JSON property: "+k)
            d[k]=v
        return d
    return json.loads(raw,object_pairs_hook=pairs,
        parse_constant=lambda x:(_ for _ in ()).throw(Rejected("nonfinite JSON")))


def authenticate_archive(body):
    need(type(body) is bytes and 0<len(body)<6_000_000,
         "original 30-member archive too large or absent")
    need(sha256(body).hexdigest()==ARCHIVE_SHA,"PR726 ZIP byte identity changed")
    with zipfile.ZipFile(BytesIO(body)) as z:
        infos=z.infolist()
        names=[f.filename for f in infos if not f.is_dir()]
        need(len(infos)==len(names)==len(set(names))==31 and
             sum(f.file_size for f in infos)<150_000_000,
             "invalid source member inventory")
        for f in infos:
            p=PurePosixPath(f.filename)
            need(f.filename==str(p) and not p.is_absolute() and
                 ".." not in p.parts and "\\" not in f.filename and
                 not stat.S_ISLNK(f.external_attr>>16) and
                 f.file_size<=30_000_000,"unsafe original zip member")
        manifest={}
        for line in z.read("manifest.sha256").decode("ascii").splitlines():
            m=re.fullmatch(r"([0-9a-f]{64})  \./([A-Za-z0-9._/-]+)",line)
            need(m is not None and m.group(2) not in manifest,
                 "invalid/duplicate original manifest entry")
            manifest[m.group(2)]=m.group(1)
        need(len(manifest)==30 and set(manifest)==set(names)-{"manifest.sha256"},
             "source not exactly 30 SHA256 manifest entries")
        for name,digest in manifest.items():
            need(sha256(z.read(name)).hexdigest()==digest,
                 "source content SHA256 mismatch "+name)
        need(z.read("code-commit.txt").decode("ascii").strip()==ARCHIVE_HEAD and
             z.read("code-tree.txt").decode("ascii").strip()==ARCHIVE_TREE,
             "original full-head commit/tree identity mismatch")
        need(sha256(z.read("11865385506.zip")).hexdigest()==PR698_SHA,
             "original PR698 funded-route history changed")
        with zipfile.ZipFile(BytesIO(z.read("11865385506.zip"))) as nested:
            public=strict_json(nested.read(
                "attempt/weth_collateral_usdc_debt-drpc/public-inputs.json"))
        source=strict_json(z.read("attempt/single-eoa-local.json"))
    need(source.get("status")==
         "SINGLE_ATOMIC_LOCAL_EOA_FLASH_LIQUIDATION_NO_MAINNET" and
         source.get("errors")==[] and
         source.get("source_hindsight_winner_tx1")==TX1 and
         source.get("original_oracle_tx0")==TX0 and
         source.get("original_route_archive_sha256")==PR698_SHA and
         source.get("public_ethereum_transaction_broadcast") is False and
         source.get("public_ethereum_native_gas_paid") is False and
         source.get("user_mxn_2000_spent") is False and
         source.get("nqc_realized_pnl_usd")=="0" and
         source.get("commercial_score_upgrade") is False and
         source.get("RMC_closed") is False and
         source.get("P2_shadow_certified") is False,
         "prior one-EOA public-Ethereum/nonclaims drift")
    footprint=source.get("one_shot_eoa_submission_footprint")
    tx=source.get("full_original_local_transaction")
    paid=source.get("local_single_eoa_receipt_economic_proof")
    receipt=source.get("full_original_local_receipt")
    need(type(footprint) is dict and type(tx) is dict and
         type(paid) is dict and type(receipt) is dict,
         "original complete local tx or real receipt absent")
    need(footprint.get("actual_create_initcode_and_args_sha256")==EXPECTED_INIT_SHA and
         footprint.get("actual_create_initcode_and_constructor_args_bytes")==EXPECTED_BYTES and
         footprint.get("local_eoa_receipt_gas_used_units")==EXPECTED_LOCAL_ONE_SHOT_GAS and
         footprint.get("eoa_native_value_wei")==0 and
         footprint.get("eoa_nonce")==0 and
         footprint.get("one_and_only_local_block_tx_identity_verified") is True and
         footprint.get("one_transaction_is_not_mev_share_svr_relay_admission") is True and
         receipt.get("status")=="0x1" and
         receipt.get("transactionHash")==tx.get("hash") and
         paid.get("one_and_only_local_eoa_tx_actual_gas_used")==EXPECTED_LOCAL_ONE_SHOT_GAS and
         paid.get("exact_local_usdc_profit_before_native_costs_base_units")==
             old.EXPECTED_SURPLUS_BEFORE_NATIVE and
         paid.get("local_two_stage_erc20_profit_payout_to_test_eoa") is True,
         "original source full EOA economic receipt or admission drift")
    data=tx.get("input")
    need(type(data) is str and
         re.fullmatch(r"0x[0-9a-fA-F]+",data) and
         len(data)==2+2*EXPECTED_BYTES and
         sha256(bytes.fromhex(data[2:])).hexdigest()==EXPECTED_INIT_SHA and
         tx.get("chainId")=="0x1" and tx.get("type")=="0x2" and
         tx.get("to") is None and tx.get("value")=="0x0" and
         tx.get("nonce")=="0x0" and
         type(tx.get("from")) is str and ADDR.fullmatch(tx["from"]) and
         tx["from"].lower()==source.get("ephemeral_test_operator"),
         "not exact immutable local contract-creation calldata")
    need(public.get("NQC_PARENT_HASH")==
         "0x772dfe7b438a71374fb11f4b02ed1a8a27b480e0e5eb7f561480650a5abb6a17" and
         public.get("NQC_WINNER_TX")==TX1 and
         public.get("NQC_WINNER_BLOCK")==str(SOURCE_BLOCK) and
         public.get("NQC_BORROWER")==
             "0xc8097d434b46888a14be77dfc836d86971e3c40f" and
         type(public.get("NQC_PRESTATE_ABI")) is str and
         ABI6.fullmatch(public["NQC_PRESTATE_ABI"]),
         "not original block/source borrower six-word state")
    words=decode_account(public["NQC_PRESTATE_ABI"])
    need(words[5]==EXPECTED_HF_WAD and
         sha256(bytes.fromhex(public["NQC_PRESTATE_ABI"][2:])).hexdigest()==
             source["exact_prewinner_local_fork"]["prewinner_account_sha256"],
         "original authenticated post-oracle risk state changed")
    return {
        "parent":public["NQC_PARENT_HASH"],
        "borrower":public["NQC_BORROWER"],
        "original_abi":public["NQC_PRESTATE_ABI"].lower(),
        "source_words":words,
        "address":tx["from"].lower(),
        "initcode":data.lower(),
        "local_original_tx":tx["hash"],
        "archive_manifest_member_count":30,
        "source_provenance":{
            "zip_sha256":ARCHIVE_SHA,"commit":ARCHIVE_HEAD,"tree":ARCHIVE_TREE,
            "run_id":ARCHIVE_RUN,"artifact_id":ARCHIVE_ARTIFACT,
            "source_one_shot_local_receipt_gas_used":EXPECTED_LOCAL_ONE_SHOT_GAS,
            "original_public_tx_winner_excluded_from_source":True,
        },
    }


def decode_account(x):
    need(type(x) is str and ABI6.fullmatch(x),"Aave 6-word ABI invalid")
    return [int(x[2+i*64:2+(i+1)*64],16) for i in range(6)]


def extract_revert_reason(response):
    # JSON-RPC errors differ across Ethereum client implementations; do not
    # mistake an upstream/provider failure for a successful negative test.
    need(type(response) is dict and type(response.get("code")) is int and
         response["code"]<0 and type(response.get("message")) is str,
         "not a well-formed EVM revert error")
    data=response.get("data")
    raw=(data if type(data) is str else
         (data.get("data") if type(data) is dict else None))
    if type(raw) is str and raw.startswith("0x08c379a0"):
        try:
            packed=bytes.fromhex(raw[10:])
            length=int.from_bytes(packed[32:64],"big")
            need(0<length<=150 and 64+length<=len(packed),
                 "invalid EVM revert reason shape")
            return packed[64:64+length].decode("utf-8")
        except Exception:
            pass
    msg=response["message"]
    for reason in REVERT_REASONS:
        if reason in msg:return reason
    return None


class OnlyLocalRPC:
    def __init__(self,url=LOCAL_URL):
        need(url==LOCAL_URL,"only locally isolated Anvil at 127.0.0.1:18546")
        self.url=url
        self.calls=0
        self.transcript=[]
    def call(self,method,args):
        need(method in {
            "eth_chainId","eth_getBlockByNumber","eth_call",
            "eth_getBalance","anvil_nodeInfo","anvil_setBalance","anvil_mine",
        },"forbidden method or accidental broadcast")
        need(self.calls<MAX_CALLS_PER_MODE,"RPC source call budget exceeded")
        need(type(args) is list,"bad RPC arg type")
        if method=="anvil_setBalance":
            need(len(args)==2 and type(args[0]) is str and
                 ADDR.fullmatch(args[0]) and
                 args[1]=="0x3635c9adc5dea00000",
                 "only 1000 synthetic local ETH allowed")
        if method=="anvil_mine":
            need(args==["0x1"],"only one local synthetic no-tx block authorized")
        if method=="eth_call":
            need(len(args)==2 and args[1]=="latest" and
                 type(args[0]) is dict and
                 set(args[0])=={"from","data","gas","value"} and
                 args[0]["gas"]=="0x989680" and args[0]["value"]=="0x0",
                 "only fixed ten-million-gas CREATE dryrun allowed")
        body=canon({"jsonrpc":"2.0","id":4727,"method":method,"params":args})
        req=Request(self.url,data=body,method="POST",headers={
            "Content-Type":"application/json",
            "User-Agent":"NQC-READ-ONLY-THREE-FORK-STATES-LOOPBACK/1"})
        started=time.monotonic_ns()
        with urlopen(req,timeout=58) as res:
            raw=res.read(MAX_RESPONSE_BYTES+1)
        need(len(raw)<=MAX_RESPONSE_BYTES,"unexpected oversized local RPC response")
        parsed=strict_json(raw)
        need(type(parsed) is dict and parsed.get("id")==4727 and
             parsed.get("jsonrpc")=="2.0","unexpected RPC envelope")
        self.calls+=1
        out={
            "method":method,"latency_ns":time.monotonic_ns()-started,
            "response_sha256":sha256(canon(parsed)).hexdigest(),
        }
        if "error" in parsed:
            out["evm_error_type"]="ERROR_RPC"
            out["source_error_message"]=str(parsed["error"].get("message",""))[:260] \
                if type(parsed["error"]) is dict else "MALFORMED"
        self.transcript.append(out)
        return parsed.get("result"),parsed.get("error")


def q(v):
    return old.quantity(v,"canonical source block/chain RPC")


def current_head(client):
    head,error=client.call("eth_getBlockByNumber",["latest",False])
    need(error is None and type(head) is dict,"local Ethereum head unavailable")
    return {"number":q(head.get("number")),
            "hash":head.get("hash"),
            "parent_hash":head.get("parentHash"),
            "timestamp":q(head.get("timestamp"))}


def validate_report(rows):
    need(type(rows) is dict and set(rows)==set(MODES),
         "exact pre/after/original winner three-state matrix required")
    for mode in MODES:
        x=rows[mode]
        need(type(x) is dict and x.get("mode")==mode and
             type(x.get("hf_wad")) is int and x["hf_wad"]>0 and
             x.get("source_parent_header_authenticated") is True and
             x.get("source_is_same_historical_borrower") is True and
             type(x.get("dry_run_returned_evm_bytecode")) is bool,
             "fork row missing canonical parent/current borrower controls")
    pre=rows[PRE_ORACLE];post=rows[AFTER_ORACLE];won=rows[AFTER_WINNER]
    need(pre["hf_wad"]>=10**18 and
         post["hf_wad"]==EXPECTED_HF_WAD and
         won["risk_abi_exactly_source_after_oracle"] is False and
         post["risk_abi_exactly_source_after_oracle"] is True and
         pre["risk_abi_exactly_source_after_oracle"] is False,
         "one-shot oracle/source temporal classification invalid")
    need(pre["dry_run_returned_evm_bytecode"] is False and
         post["dry_run_returned_evm_bytecode"] is True and
         won["dry_run_returned_evm_bytecode"] is False and
         pre.get("dry_run_evm_revert_reason") in REVERT_REASONS and
         won.get("dry_run_evm_revert_reason") in REVERT_REASONS,
         "same one-shot payload not valid only in intended post-oracle prewinner window")
    need(pre.get("dry_run_rpc_error_class")=="EVM_REVERT" and
         won.get("dry_run_rpc_error_class")=="EVM_REVERT" and
         post.get("dry_run_rpc_error_class") is None,
         "provider errors may not be certified as economic-negative controls")
    return True


def run_case(mode,source,anvil,output_dir):
    output_dir.mkdir()
    client=OnlyLocalRPC()
    proc=None
    row={"mode":mode,"status":"INCOMPLETE_HISTORICAL_FORK_TIMING",
         "source_parent_header_authenticated":False,
         "source_is_same_historical_borrower":True,
         "risk_abi_exactly_source_after_oracle":None,
         "hf_wad":None,"errors":[],"dry_run_returned_evm_bytecode":False,
         "dry_run_evm_revert_reason":None,
         "dry_run_rpc_error_class":None}
    try:
        opts=[
            str(anvil),"--host","127.0.0.1","--port",str(PORT),
            "--chain-id","1","--fork-url",FORK_URL,
            "--no-storage-caching","--compute-units-per-second","5",
            "--retries","0","--silent",
        ]
        if mode==PRE_ORACLE:
            opts.extend(["--fork-block-number",str(PARENT_BLOCK)])
        else:
            opts.extend(["--fork-transaction-hash",TX0 if mode==AFTER_ORACLE else TX1])
        with (output_dir/"anvil.stdout.log").open("w") as log:
            proc=subprocess.Popen(opts,cwd=output_dir,stdout=log,
                                  stderr=subprocess.STDOUT)
        until=time.monotonic()+WAIT_SECONDS
        while time.monotonic()<until and proc.poll() is None:
            try:
                info,err=client.call("anvil_nodeInfo",[])
                need(err is None and type(info) is dict,"source not real local Anvil")
                break
            except Exception:
                time.sleep(2)
        else:
            raise Rejected("pinned Anvil source unavailable")
        chain,err=client.call("eth_chainId",[])
        need(err is None and q(chain)==1,"fork is not Ethereum chainId1")
        head=current_head(client)
        row["fork_initial_header"]=head
        # PRE_ORACLE must deliberately skip oracle TX0, yet test at the
        # SAME historical block number as the post-oracle tx0 prefix.
        if mode==PRE_ORACLE:
            need(head["number"]==PARENT_BLOCK,
                 "PRE_ORACLE fork must start at canonical predecessor")
            mined,err=client.call("anvil_mine",["0x1"])
            need(err is None,"local empty block miner unavailable")
            head=current_head(client)
            need(head["number"]==SOURCE_BLOCK,
                 "PRE_ORACLE synthetic empty block did not advance exactly once")
        else:
            need(head["number"]==SOURCE_BLOCK,
                 "tx-prefix source did not stop within historical winner block")
        row["source_context_header"]=head
        parent,err=client.call("eth_getBlockByNumber",[hex(PARENT_BLOCK),False])
        need(err is None and type(parent) is dict and
             parent.get("hash")==source["parent"] and
             q(parent.get("number"))==PARENT_BLOCK,
             "fork original canonical historical parent hash mismatch")
        row["source_parent_header_authenticated"]=True
        # The Aave Pool implementation and exact borrower remain fixed.
        calldata=old.borrower_call_data(source["borrower"]) \
            if hasattr(old,"borrower_call_data") else (
                "0xbf92857c"+"0"*24+source["borrower"][2:])
        bal,err=client.call("eth_call",[
            {"from":source["address"],"data":source["initcode"],
             "gas":"0x989680","value":"0x0"},"latest"]) \
             if False else (None,None)
        # Account read uses exact Aave Pool 6-word risk ABI, not a mutable
        # position-index lookup or selected future liquidation receipt.
        raw,err=client.call("eth_call",[
            {"to":old.POOL,"data":calldata},"latest"]) \
             if False else (None,None)
        # See AccountReader below: eth_call is allowlisted for a strictly
        # bound CREATE and immutable Aave getUserAccountData only.
        row["status"]="PREPARED_FOR_CANONICAL_READ"
    except Exception as exc:
        row["errors"].append({"type":type(exc).__name__,
                              "message":str(exc)[:180]})
    finally:
        if proc is not None:
            proc.terminate()
            try:proc.wait(timeout=12)
            except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=12)
        row["local_only_rpc_transcript"]=client.transcript
        (output_dir/"fork-matrix.json").write_bytes(canon(row))
    return row


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--original-zip",required=True,type=Path)
    p.add_argument("--anvil",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    args=p.parse_args()
    need(args.anvil.is_file() and
         args.out.is_absolute() and args.out.parent.is_dir() and not args.out.exists(),
         "need installed pinned binary and fresh absolute output directory")
    source=authenticate_archive(args.original_zip.read_bytes())
    args.out.mkdir()
    summary={
        "status":"INCOMPLETE_ORACLE_WINNER_THREE_STATE_NO_CAPTURE",
        "source":source["source_provenance"],
        "source_oracle_tx0":TX0,"source_original_competitor_tx1":TX1,
        "three_fork_rows":{},
        "errors":[],
        "ONE_SHOT_TRANSACTION_EXACT_SOURCE_INITCODE_REUSED":True,
        "only_eth_call_and_one_local_empty_block":True,
        "ethereum_public_mempool_or_mev_share_access_proven":False,
        "builder_private_bundle_submission_or_winning_bid_proven":False,
        "nonrecourse_gas_funding_proven":False,
        "nqc_native_mainnet_gas_spent":False,
        "nqc_realized_pnl_usd":"0",
        "commercial_score_upgrade":False,
        "RMC_closed":False,"P2_shadow_certified":False,
        "canary_live_authorized":False,
        "OWN_CAPITAL_ZERO_GAS_POLICY_UNCHANGED":True,
    }
    for mode in MODES:
        path=args.out/mode.lower()
        res=run_case(mode,source,args.anvil,path)
        summary["three_fork_rows"][mode]=res
    try:
        validate_report(summary["three_fork_rows"])
        summary["status"]="THREE_STATE_ONE_SHOT_EVM_ELIGIBILITY_ONLY_NO_CAPTURE"
    except Exception as exc:
        summary["errors"].append({"type":type(exc).__name__,
                                  "detail":str(exc)[:190]})
    (args.out/"three-state-oracle-order.json").write_bytes(canon(summary))
    print(summary["status"],[(m,summary["three_fork_rows"][m].get("hf_wad"),
                              summary["three_fork_rows"][m].get("dry_run_returned_evm_bytecode"))
                              for m in MODES])
    return 0 if summary["status"]=="THREE_STATE_ONE_SHOT_EVM_ELIGIBILITY_ONLY_NO_CAPTURE" else 2


if __name__=="__main__":
    raise SystemExit(main())
