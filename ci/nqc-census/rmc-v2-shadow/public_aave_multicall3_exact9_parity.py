#!/usr/bin/env python3
"""NQC V2: exactly NINE Aave getUserAccountData in ONE Multicall3 eth_call.

Controls: nine individual calls vs ONE 9-subcall aggregate3, A/B B/A, same
already-mined Ethereum canonical blockHash, byte-identical Aave six-word state
on public dRPC AND PublicNode. No trades, gas spend or private price signal.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path,PurePosixPath
import re
import stat
import time
from urllib.request import Request,urlopen
import zipfile

import public_aave_9account_rpc_latency_ab as prior
import prospective_recent_borrow_cohort as borrow

PRIOR_HEAD="222f3c3c67ea2b2217886783731ff1a04debc72e"
PRIOR_TREE="79abaf15598ccce39f3e1ca0260cdee78fd4e3dc"
PRIOR_SHA="cd26e9863aae362f7bda90e4a1343ee1fefa63a5cf66e4384dc33aa31646332c"
PRIOR_RUN=38642172907
PRIOR_ARTIFACT=11931141484
PRIOR_MANIFEST_COUNT=20
MULTICALL3="0xca11bde05977b3631167028862be2a173976ca11"
AGGREGATE3_SELECTOR="0x82ad56cb"
N=9
POLL_AGE_SECONDS=140
MAX_TWO_SOURCE_TIP_DRIFT=3
MAX_CALLS_PER_PROVIDER=30
MAX_REQUEST_BYTES=26000
MAX_RESPONSE_BYTES=320000
MAX_RTT_SECONDS=45
MAX_TOTAL_DECOMPRESSED=30_000_000
HEXBIN=re.compile(r"0x(?:[0-9a-fA-F]{2})*\Z")
WORD_SIZE=32
UINT_MAX=2**256-1
CALL3_ELEMENT_SIZE=192
RESULT3_ELEMENT_SIZE=288
GAP=.40


class Rejected(ValueError):
    pass


def need(valid,why):
    if not valid:raise Rejected(why)


def canon(d):
    return (json.dumps(d,sort_keys=True,separators=(",",":"),
                       ensure_ascii=True)+"\n").encode()


def clock():
    return {"utc_ns":time.time_ns(),"monotonic_ns":time.monotonic_ns()}


def strict_json(raw):
    def unique(items):
        result={}
        for k,v in items:
            need(k not in result,"duplicated JSON source key")
            result[k]=v
        return result
    return json.loads(raw,object_pairs_hook=unique,
        parse_constant=lambda x:(_ for _ in ()).throw(Rejected("invalid JSON number")))


def authenticate_previous_zip(raw):
    need(type(raw) is bytes and 0<len(raw)<=3_000_000,
         "missing/oversized original benchmark ZIP")
    need(sha256(raw).hexdigest()==PRIOR_SHA,
         "previous A/B archive SHA256 drift")
    with zipfile.ZipFile(BytesIO(raw)) as z:
        info=z.infolist()
        names=[i.filename for i in info if not i.is_dir()]
        need(len(info)==len(names)==len(set(names))==PRIOR_MANIFEST_COUNT+1 and
             sum(i.file_size for i in info)<MAX_TOTAL_DECOMPRESSED,
             "original benchmark source inventory bad")
        for entry in info:
            p=PurePosixPath(entry.filename)
            need(str(p)==entry.filename and not p.is_absolute() and
                 ".." not in p.parts and "\\" not in entry.filename and
                 not stat.S_ISLNK(entry.external_attr>>16) and
                 entry.file_size<=20_000_000,
                 "unsafe previous benchmark source member")
        manifest={}
        for line in z.read("manifest.sha256").decode("ascii").splitlines():
            m=re.fullmatch(r"([0-9a-f]{64})  \./([A-Za-z0-9._/-]+)",line)
            need(m is not None and m.group(2) not in manifest,
                 "bad/duplicate original SHA256 manifest entry")
            manifest[m.group(2)]=m.group(1)
        need(len(manifest)==PRIOR_MANIFEST_COUNT and
             set(manifest)==set(names)-{"manifest.sha256"},
             "original benchmark manifest incomplete")
        for name,digest in manifest.items():
            need(sha256(z.read(name)).hexdigest()==digest,
                 "bad previous evidence member "+name)
        need(z.read("code-commit.txt").decode().strip()==PRIOR_HEAD and
             z.read("code-tree.txt").decode().strip()==PRIOR_TREE,
             "previous benchmark code head/tree changed")
        need({"11928798163.zip","attempt/cohort-sealed-before-new-network.json",
              "attempt/public-AB-BA-latency-result.json"}<=set(names),
             "missing previous benchmark source/decision")
        older=z.read("11928798163.zip")
        old_seal=strict_json(z.read(
            "attempt/cohort-sealed-before-new-network.json"))
        prior_result=strict_json(z.read(
            "attempt/public-AB-BA-latency-result.json"))
    cohort,source=prior.authenticate_source(older)
    need(old_seal.get("nine_frozen_debt_owners")==cohort and
         old_seal.get("before_current_Ethereum_RPC") is True and
         old_seal.get("no_second_head_or_future_HF_selection") is True and
         prior_result.get("status")==
            "SOURCE_AUTHENTIC_AB_BA_PUBLIC_HEAD_LATENCY_NOT_SVR_ACCESS" and
         prior_result.get("errors")==[] and
         prior_result.get("source")==source and
         prior_result.get("precommit",{}).get("sha256")==
            sha256(canon(old_seal)).hexdigest() and
         prior_result.get("mode_order")==[
            "SEQUENTIAL","THREE_LANES","THREE_LANES","SEQUENTIAL"] and
         len(prior_result.get("trials",[]))==4 and
         prior_result.get("public_already_mined_head_only") is True and
         prior_result.get("builder_deadline_or_preinclusion_observation_proven") is False and
         prior_result.get("private_chainlink_SVR_mevshare_access_proven") is False and
         prior_result.get("nqc_realized_pnl_usd")=="0",
         "prior source benchmark not source-authentic and zero-commerce")
    need(len(cohort)==N and len({x["borrower"] for x in cohort})==N,
         "source missing nine fixed old debt owners")
    return cohort,{
        "previous_ABBA_zip_sha256":PRIOR_SHA,
        "previous_ABBA_artifact":PRIOR_ARTIFACT,
        "previous_ABBA_run":PRIOR_RUN,
        "previous_ABBA_head":PRIOR_HEAD,
        "previous_ABBA_tree":PRIOR_TREE,
        "previous_ABBA_manifest_sha256_members":PRIOR_MANIFEST_COUNT,
        "nested_old_public_Aave_source_sha256":source["producer_pr728_sha256"],
        "selection_known_before_current_RPC":True,
        "sample_is_old_Withdraw_debt_owners_not_all_Aave":True,
    }


def u256(v):
    need(type(v) is int and 0<=v<=UINT_MAX,"bad uint256")
    return v.to_bytes(32,"big")


def read_word(buf,pos):
    need(type(buf) is bytes and type(pos) is int and
         pos>=0 and pos%32==0 and pos+32<=len(buf),
         "malformed noncanonical ABI word offset")
    return int.from_bytes(buf[pos:pos+32],"big")


def encode_aggregate3(owners):
    need(type(owners) is list and len(owners)==N and
         len(set(owners))==N and
         all(type(a) is str and re.fullmatch(r"0x[0-9a-f]{40}",a) for a in owners),
         "aggregate3 must contain EXACTLY 9 source authenticated borrowers")
    elements=[]
    for owner in owners:
        calldata=bytes.fromhex(borrow.call_data(owner)[2:])
        need(len(calldata)==36 and
             calldata[:4]==bytes.fromhex("bf92857c"),
             "wrong Aave canonical selector/ABI")
        elements.append(
            u256(int(borrow.POOL,16)) +
            u256(0) + # bool allowFailure=false; missing ANY read must revert.
            u256(96) +
            u256(36) + calldata.ljust(64,b"\x00"))
    need(all(len(e)==CALL3_ELEMENT_SIZE for e in elements),
         "bad Call3 tuple ABI elements")
    # Dynamic-array offsets are relative to START OF ELEMENTS head (after len).
    offsets=b"".join(u256(N*32+i*CALL3_ELEMENT_SIZE) for i in range(N))
    body=(u256(32)+u256(N)+offsets+b"".join(elements))
    calldata="0x"+AGGREGATE3_SELECTOR[2:]+body.hex()
    need(len(bytes.fromhex(calldata[2:]))<=MAX_REQUEST_BYTES,
         "aggregate3 batch calldata oversized")
    return calldata


def decode_aggregate3(raw):
    need(type(raw) is str and HEXBIN.fullmatch(raw),
         "malformed aggregate3 RPC ABI bytes")
    buf=bytes.fromhex(raw[2:])
    expected_size=64+N*32+N*RESULT3_ELEMENT_SIZE
    need(len(buf)==expected_size and read_word(buf,0)==32 and
         read_word(buf,32)==N,
         "unexpected ABI aggregate3 output length or array offset")
    # Tuple offsets are relative to the array ELEMENTS section immediately
    # after the length word, not after the full nine-element offset table.
    dynamic_base=64
    result=[]
    for i in range(N):
        off=read_word(buf,64+i*32)
        need(off==N*32+i*RESULT3_ELEMENT_SIZE,
             "noncanonical/misordered aggregate3 result offset")
        start=dynamic_base+off
        need(read_word(buf,start)==1 and
             read_word(buf,start+32)==64 and
             read_word(buf,start+64)==192,
             "Multicall3 subcall failed or returned wrong Aave six-word ABI")
        data=buf[start+96:start+288]
        need(len(data)==192,"partial Aave aggregate3 account data")
        borrow.decode_account("0x"+data.hex())
        result.append("0x"+data.hex())
    need(len(result)==N,"not all nine ABI results present")
    return result


class AllowlistedRPC:
    def __init__(self,provider,transport=None):
        need(provider in borrow.RPC_ENDPOINTS,
             "RPC source outside NQC public two-source allowlist")
        self.provider=provider
        self.url=borrow.RPC_ENDPOINTS[provider]
        self.transport=transport or self.network
        self.gate=(prior.ProviderRateGate(self.transport)
                   if transport is None else None)
        self.calls=0
        self.transcript=[]
        self.allowed_source_accounts=None
        self.allowed_multicall_calldata=None

    @staticmethod
    def network(url,method,args):
        need(url in set(borrow.RPC_ENDPOINTS.values()),
             "RPC URL outside original public provider scope")
        need(method in {"eth_chainId","eth_blockNumber",
                        "eth_getBlockByNumber","eth_getCode","eth_call"},
             "write / non-admission RPC forbidden")
        raw_request=canon({"jsonrpc":"2.0","id":735,"method":method,"params":args})
        need(len(raw_request)<=MAX_REQUEST_BYTES,"outgoing JSON-RPC too large")
        req=Request(url,method="POST",data=raw_request,headers={
            "Content-Type":"application/json",
            "User-Agent":"NQC-V2-PUBLIC-MULTICALL3-CANONICAL-RISK-RESEARCH/1"})
        with urlopen(req,timeout=MAX_RTT_SECONDS) as response:
            raw=response.read(MAX_RESPONSE_BYTES+1)
        need(len(raw)<=MAX_RESPONSE_BYTES,"provider reply oversized")
        msg=strict_json(raw)
        need(type(msg) is dict and msg.get("jsonrpc")=="2.0" and
             msg.get("id")==735 and "error" not in msg and "result" in msg,
             "RPC source rejected or returned untrusted result")
        return msg["result"]

    def call(self,method,args):
        need(self.calls<MAX_CALLS_PER_PROVIDER,
             "public RPC hard call budget reached")
        if method in ("eth_chainId","eth_blockNumber"):
            need(args==[],"bad chain or tip arguments")
        elif method=="eth_getBlockByNumber":
            need(type(args) is list and len(args)==2 and
                 type(args[0]) is str and borrow.HEXQ.fullmatch(args[0]) and
                 args[1] is False,"only canonical numbered block header")
        elif method=="eth_getCode":
            need(type(args) is list and len(args)==2 and
                 args[0]==MULTICALL3 and type(args[1]) is dict and
                 set(args[1])=={"blockHash","requireCanonical"} and
                 args[1]["requireCanonical"] is True and
                 borrow.HEX32.fullmatch(args[1]["blockHash"]),
                 "only known Ethereum Multicall3 runtime at exact blockHash")
        elif method=="eth_call":
            need(type(args) is list and len(args)==2 and
                 type(args[0]) is dict and
                 set(args[0])=={"to","data"} and
                 type(args[1]) is dict and
                 set(args[1])=={"blockHash","requireCanonical"} and
                 args[1]["requireCanonical"] is True and
                 borrow.HEX32.fullmatch(args[1]["blockHash"]),
                 "only two source-bound EIP-1898 eth_calls")
            tx=args[0]
            is_direct=(tx["to"]==borrow.POOL and
                      type(tx["data"]) is str and
                      self.allowed_source_accounts is not None and
                      tx["data"] in self.allowed_source_accounts)
            is_batch=(tx["to"]==MULTICALL3 and
                      self.allowed_multicall_calldata is not None and
                      tx["data"]==self.allowed_multicall_calldata)
            need(is_direct or is_batch,
                 "unapproved contract calldata/borrower or multicall payload")
        else:
            raise Rejected("forbidden write or unknown JSON-RPC method")
        self.calls+=1
        started=time.monotonic_ns()
        entry={"provider":self.provider,"method":method,
               "params_sha256":sha256(canon(args)).hexdigest(),
               "at_utc_ns":time.time_ns()}
        try:
            if self.gate:
                reply=self.gate(self.url,method,args)
            else:
                reply=self.transport(self.url,method,args)
            entry["result_sha256"]=sha256(canon(reply)).hexdigest()
            return reply
        except Exception as exc:
            entry["error_type"]=type(exc).__name__
            entry["error_detail"]=str(exc).split("https://")[0][:180]
            raise
        finally:
            entry["elapsed_ns"]=time.monotonic_ns()-started
            self.transcript.append(entry)

    def tip(self):
        need(borrow.qty(self.call("eth_chainId",[]),"chain")==1,
             "RPC not Ethereum chain1")
        return borrow.qty(self.call("eth_blockNumber",[]),"tip")

    def header(self,n):
        return borrow.header(self.call("eth_getBlockByNumber",[hex(n),False]),n)


def run_trial(mode,clients,cohort,header,full_calldata,now_fn=clock):
    need(mode in ("SEQUENTIAL","MULTICALL3"),"unexpected source mode")
    begun=now_fn()
    owners=[x["borrower"] for x in cohort]
    def one(provider):
        rpc=clients[provider]
        if mode=="SEQUENTIAL":
            source=[rpc.call("eth_call",[
                {"to":borrow.POOL,"data":borrow.call_data(owner)},
                {"blockHash":header["hash"],"requireCanonical":True}])
                for owner in owners]
            return [x.lower() for x in source]
        batch=rpc.call("eth_call",[
            {"to":MULTICALL3,"data":full_calldata},
            {"blockHash":header["hash"],"requireCanonical":True}])
        return decode_aggregate3(batch)
    with ThreadPoolExecutor(max_workers=2) as e:
        values=list(e.map(one,("drpc","publicnode")))
    for provider,rows in zip(("drpc","publicnode"),values):
        need(len(rows)==N,"missing one or more nine Aave account responses")
        need(all(type(r) is str and re.fullmatch(r"0x[0-9a-f]{384}",r)
                 and borrow.decode_account(r) for r in rows),
             "not exact raw six-word Aave result")
    need(values[0]==values[1],
         "Multicall/direct two-source original ABI does not match")
    finished=now_fn()
    ns=finished["monotonic_ns"]-begun["monotonic_ns"]
    need(type(ns) is int and 0<=ns<=120_000_000_000,
         "unbounded or invalid observation interval")
    return {
        "mode":mode,"begin":begun,"finished":finished,
        "elapsed_monotonic_ns":ns,
        "account_count":N,
        "canonical_block_hash":header["hash"],
        "rpc_calls_per_provider_in_trial":9 if mode=="SEQUENTIAL" else 1,
        "raw_Aave_account_ABI_from_both_providers_identical":True,
        "raw_result_sha256":sha256(canon(values[0])).hexdigest(),
        "account_risk":[{
            "borrower":owner,
            "raw_abi_hex":abi,
            "source_abi_sha256":sha256(bytes.fromhex(abi[2:])).hexdigest(),
            "six_word_aave_risk":borrow.decode_account(abi)}
            for owner,abi in zip(owners,values[0])],
        "after_canonical_inclusion_only":True,
    }


def verdict(trials,head):
    need(len(trials)==4 and [t["mode"] for t in trials]==[
        "SEQUENTIAL","MULTICALL3","MULTICALL3","SEQUENTIAL"],
        "ABBA modes omitted/changed")
    digest=trials[0]["raw_result_sha256"]
    need(all(t["raw_result_sha256"]==digest and
             t["canonical_block_hash"]==head["hash"] and
             t["raw_Aave_account_ABI_from_both_providers_identical"] is True
             for t in trials),
         "one of four source snapshots mismatched byte-for-byte")
    seq=[t["elapsed_monotonic_ns"] for t in trials if t["mode"]=="SEQUENTIAL"]
    bat=[t["elapsed_monotonic_ns"] for t in trials if t["mode"]=="MULTICALL3"]
    return {
        "sequential_elapsed_ns":seq,
        "multicall3_elapsed_ns":bat,
        "sequential_mean_ns":sum(seq)//2,
        "multicall3_mean_ns":sum(bat)//2,
        "batched_faster_only_in_this_exact_two_pair_sample":
            sum(bat)<sum(seq),
        "speedup_ratio_approx_not_calibrated":
            round(sum(seq)/sum(bat),4) if sum(bat)>0 else None,
        "two_trials_per_mode_insufficient_for_latency_distribution":True,
        "source_cache_latency_throttle_regime_uncontrolled":True,
        "no_private_mev_orderflow_or_winning_builder_inclusion":True,
    }


def collect(cohort,source,out,transport_factory=None,now_fn=clock):
    need(isinstance(out,Path) and out.is_absolute() and out.is_dir() and
         not list(out.iterdir()),"new absolute empty evidence folder required")
    doc={
        "schema_version":1,
        "status":"INCOMPLETE_MULTICALL3_PUBLIC_RISK_NOT_MARKET_ZERO",
        "source":source,
        "precommit":None,"eth_mainnet_source_block":None,
        "multicall3_deployment_code":None,
        "trial_order":["SEQUENTIAL","MULTICALL3","MULTICALL3","SEQUENTIAL"],
        "trials":[],"comparison":None,"errors":[],
        "all_nine_old_debt_owner_accounts_source_frozen":True,
        "contract_writes_or_mainnet_tx_submitted":False,
        "multicall3_only_simulated_eth_call_not_contract_write":True,
        "private_SVR_or_before_block_builder_access_proven":False,
        "public_canonical_head_already_mined_before_snapshot":True,
        "independent_provider_operator_or_mev_searcher_verified":False,
        "economic_liquidation_route_or_flash_funding_verified":False,
        "commercial_score_upgrade":False,"RMC_closed":False,
        "P2_shadow_certified":False,"canary_live_authorized":False,
        "nonrecourse_native_gas_sponsor_proven":False,
        "OWN_CAPITAL_ZERO_INCLUDING_GAS_UNCHANGED":True,
        "user_mxn2000_spent":False,
        "nqc_realized_pnl_usd":"0",
    }
    seal={"source":source,"nine_frozen_account_addresses":[x["borrower"] for x in cohort],
          "selected_prior_to_current_Ethereum_RPC":True,
          "precommitted":now_fn(),
          "recent_winner_or_current_HF_never_used_for_selection":True}
    dest=out/"cohort-precommitted-before-RPC.json"
    dest.write_bytes(canon(seal))
    doc["precommit"]={"sha256":sha256(dest.read_bytes()).hexdigest(),
                      "file":dest.name,
                      "committed_utc_ns":seal["precommitted"]["utc_ns"]}
    clients={}
    try:
        need(len(cohort)==N and len({x["borrower"] for x in cohort})==N,
             "not source-defined nine debt owners")
        for provider in ("drpc","publicnode"):
            network=(transport_factory(provider) if transport_factory
                     else None)
            clients[provider]=AllowlistedRPC(provider,network)
        tips={p:clients[p].tip() for p in clients}
        doc["source_public_tips"]=tips
        need(abs(tips["drpc"]-tips["publicnode"])<=MAX_TWO_SOURCE_TIP_DRIFT,
             "public providers tip too divergent")
        height=min(tips.values())-2
        heads={p:clients[p].header(height) for p in clients}
        need(heads["drpc"]==heads["publicnode"],
             "two providers disagree on exact same canonical block")
        head=heads["drpc"]
        doc["eth_mainnet_source_block"]=head
        begun=now_fn()
        need(0<=begun["utc_ns"]//1_000_000_000-head["timestamp"]<=POLL_AGE_SECONDS,
             "Aave source header stale/future")
        owners=[x["borrower"] for x in cohort]
        full=encode_aggregate3(owners)
        need(full.startswith(AGGREGATE3_SELECTOR),"wrong exact Multicall3 method selector")
        doc["exact_allowlisted_multicall3_input_sha256"]=sha256(
            bytes.fromhex(full[2:])).hexdigest()
        doc["multicall3_call3_targets"]=N
        code={}
        for p,rpc in clients.items():
            rpc.allowed_source_accounts={
                borrow.call_data(owner) for owner in owners}
            rpc.allowed_multicall_calldata=full
            val=rpc.call("eth_getCode",[
                MULTICALL3,{"blockHash":head["hash"],"requireCanonical":True}])
            need(type(val) is str and HEXBIN.fullmatch(val) and
                 500<=len(val[2:])//2<=30000,
                 "Multicall3 canonical deployed runtime code absent/invalid")
            code[p]=val.lower()
        need(code["drpc"]==code["publicnode"],
             "independent public URLs disagree on Multicall3 bytecode")
        doc["multicall3_deployment_code"]={
            "ethereum_address":MULTICALL3,
            "runtime_byte_length":len(code["drpc"][2:])//2,
            "both_source_runtime_sha256":sha256(
                bytes.fromhex(code["drpc"][2:])).hexdigest(),
            "pinned_blockHash":head["hash"],
            "same_runtime_code_on_two_public_sources":True,
            "contract_source_code_proven_by_two_RPC_code_bytes_alone":False,
        }
        # A/B and B/A eliminate the most obvious one-way order artifact.
        for mode in doc["trial_order"]:
            trial=run_trial(mode,clients,cohort,head,full,now_fn)
            doc["trials"].append(trial)
            t=now_fn()
            need(0<=t["utc_ns"]//1_000_000_000-head["timestamp"]<=POLL_AGE_SECONDS,
                 "pinned public header aged out during test")
        after={p:clients[p].header(height) for p in clients}
        need(after["drpc"]==after["publicnode"]==head,
             "canonical source block changed after reading")
        doc["comparison"]=verdict(doc["trials"],head)
        doc["per_provider_RPC_calls"]={p:rpc.calls for p,rpc in clients.items()}
        need(all(rpc.calls<=MAX_CALLS_PER_PROVIDER for rpc in clients.values()),
             "public RPC quota/unknown burst exceeded")
        doc["status"]="ONE_MULTICALL3_PUBLIC_AAVE_NINE_RISK_ABBA_PARITY_NO_SVR"
    except Exception as exc:
        doc["errors"].append({
            "type":type(exc).__name__,"detail":str(exc).split("https://")[0][:230]})
    doc["RPC_source_transcripts"]={p:r.transcript for p,r in clients.items()}
    doc["finished"]=now_fn()
    (out/"multicall-vs-single-RPC.json").write_bytes(canon(doc))
    return doc


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--prior-evidence-zip",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    need(a.out.is_absolute() and a.out.parent.is_dir() and not a.out.exists(),
         "fresh absolute evidence output path")
    cohort,source=authenticate_previous_zip(a.prior_evidence_zip.read_bytes())
    a.out.mkdir()
    report=collect(cohort,source,a.out)
    comp=report.get("comparison") or {}
    print(report["status"],"sequential_ns",comp.get("sequential_mean_ns"),
          "batched_ns",comp.get("multicall3_mean_ns"),
          "ratio",comp.get("speedup_ratio_approx_not_calibrated"),
          "errors",len(report["errors"]))
    return 0 # Valid negative/unavailable observation is not false market-zero.

if __name__=="__main__":
    raise SystemExit(main())
