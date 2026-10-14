#!/usr/bin/env python3
"""NQC V2 bounded A/B public Aave account-read latency, source-frozen, no trades.

A/B and B/A tests on the SAME already-mined canonical Ethereum block:
  pass 1: sequential 9 accounts -> 3-lane concurrent 9 accounts
  pass 2: concurrent 9 accounts -> sequential 9 accounts.
Both public providers must agree on every six-word Aave state in every pass.
No result is an advance private-oracle signal, inclusion win or revenue forecast.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path,PurePosixPath
import re
import stat
from threading import Lock
import time
import zipfile

import prospective_recent_borrow_cohort as borrow
import public_two_head_sealed_watch as sealed

SOURCE_SHA="605211ce433d9e89af5f88ab97145450eb9338f94f202186207ededc21859193"
SOURCE_HEAD="d41a4b36b8b4c1034a3e1cb669d8046166b103ca"
SOURCE_TREE="25461395e94ff28bb7b72a8103d9013d4bab6073"
SOURCE_RUN=38639157922
SOURCE_ARTIFACT=11928798163
SOURCE_PR718_SHA=sealed.OLD_ZIP_SHA
EXPECTED_SOURCE_MEMBERS=20
N_ACCOUNTS=9
PROVIDERS=("drpc","publicnode")
LANES_PER_PROVIDER=3
MIN_SPACING_SEC=0.40
MAX_CALLS_PER_PROVIDER=60
MAX_HEAD_AGE_SEC=120
MAX_TIP_DIFFERENCE=3
MAX_LOCAL_DURATION_SEC=115
MAX_ARCHIVE_SIZE=2_000_000
MAX_ARCHIVE_UNCOMPRESSED=30_000_000
MANIFEST=re.compile(r"([0-9a-f]{64})  \./([A-Za-z0-9._/-]+)\Z")
ADDR=re.compile(r"0x[0-9a-f]{40}\Z")


class Rejected(ValueError):
    pass


def need(ok, why):
    if not ok:
        raise Rejected(why)


def canon(doc):
    return (json.dumps(doc,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def stamp():
    return {"utc_unix_ns":time.time_ns(),
            "process_monotonic_ns":time.monotonic_ns()}


def strict_json(raw):
    def unique(pairs):
        d={}
        for k,v in pairs:
            need(k not in d,"duplicate JSON source property")
            d[k]=v
        return d
    return json.loads(raw,object_pairs_hook=unique,
                      parse_constant=lambda z:(_ for _ in ()).throw(
                          Rejected("nonfinite JSON value")))


def authenticate_source(zip_bytes):
    need(type(zip_bytes) is bytes and 0<len(zip_bytes)<=MAX_ARCHIVE_SIZE,
         "unbounded/missing producer ZIP")
    need(sha256(zip_bytes).hexdigest()==SOURCE_SHA,
         "PR728 whole source archive SHA256 drift")
    with zipfile.ZipFile(BytesIO(zip_bytes)) as z:
        members=z.infolist()
        names=[m.filename for m in members if not m.is_dir()]
        need(len(names)==len(set(names)) and len(members)==len(names)==
             EXPECTED_SOURCE_MEMBERS+1 and
             sum(i.file_size for i in members)<MAX_ARCHIVE_UNCOMPRESSED,
             "duplicated, inflated or incomplete source ZIP")
        for m in members:
            p=PurePosixPath(m.filename)
            need(m.filename==str(p) and not p.is_absolute() and
                 ".." not in p.parts and "\\" not in m.filename and
                 m.file_size<=20_000_000 and
                 not stat.S_ISLNK(m.external_attr>>16),
                 "source ZIP unsafe path or symlink")
        need({"manifest.sha256","code-commit.txt","code-tree.txt",
              "11908200180.zip",
              "attempt/cohort-before-network.json",
              "attempt/public-watch-result.json"}<=set(names),
             "original PR728 evidence incomplete")
        need(z.read("code-commit.txt").decode("ascii").strip()==SOURCE_HEAD and
             z.read("code-tree.txt").decode("ascii").strip()==SOURCE_TREE,
             "wrong PR728 producer commit/tree")
        manifest={}
        for line in z.read("manifest.sha256").decode("ascii").splitlines():
            match=MANIFEST.fullmatch(line)
            need(match is not None,"invalid old SHA256 manifest")
            digest,name=match.groups()
            need(name not in manifest,"duplicate source manifest entry")
            manifest[name]=digest
        need(len(manifest)==EXPECTED_SOURCE_MEMBERS and
             set(manifest)==set(names)-{"manifest.sha256"},
             "source manifest not exhaustive")
        for name,digest in manifest.items():
            need(sha256(z.read(name)).hexdigest()==digest,
                 "original source member hash mismatch "+name)
        nested=z.read("11908200180.zip")
        frozen_raw=z.read("attempt/cohort-before-network.json")
        frozen=strict_json(frozen_raw)
        result=strict_json(z.read("attempt/public-watch-result.json"))
    need(sha256(nested).hexdigest()==SOURCE_PR718_SHA,
         "original 83-account producer ZIP drift")
    cohort,original_source=sealed.authenticate_old_source(nested)
    need(len(cohort)==N_ACCOUNTS and
         frozen.get("fixed_selections")==cohort and
         frozen.get("source")==original_source and
         frozen.get("no_current_ethereum_rpc_yet") is True and
         frozen.get("future_HF_or_competitor_outcome_not_used_for_selection") is True,
         "original nine-account selection wasn't frozen prior to source reads")
    need(result.get("status")=="TWO_PUBLIC_CANONICAL_HEADS_AFTER_INCLUSION_ONLY_NO_CAPTURE" and
         result.get("errors")==[] and
         result.get("source")==original_source and
         result.get("chosen_owner_count")==N_ACCOUNTS and
         result.get("precommit_source_snapshot",{}).get("sha256")==
            sha256(frozen_raw).hexdigest() and
         result.get("all_public_sources_agreed_exact_canonical_EIP1898_state") is True and
         result.get("sealed_before_real_block_was_mined_proven") is False and
         result.get("private_SVR_or_MEV_share_first_seen_proven") is False and
         result.get("early_pending_feed_access_proven") is False and
         result.get("commercial_score_upgrade") is False and
         result.get("nqc_realized_pnl_usd")=="0",
         "original producer source response promoted prospective authority")
    need([x["height"] for x in result.get("observations",[])]==
         [26193380,26193381] and
         all(x["source_two_public_url_raw_account_parity"] is True
             for x in result["observations"]),
         "original two canonical blocks observation differs")
    return cohort,{
        "producer_pr728_sha256":SOURCE_SHA,
        "producer_commit":SOURCE_HEAD,
        "producer_tree":SOURCE_TREE,
        "producer_run_id":SOURCE_RUN,
        "producer_artifact_id":SOURCE_ARTIFACT,
        "producer_manifest_members_verified":EXPECTED_SOURCE_MEMBERS,
        "prior_pr718_source_sha256":SOURCE_PR718_SHA,
        "cohort_fixed_using_prior_debt_snapshot":True,
        "cohort_old_borrowers_with_debt":N_ACCOUNTS,
        "source_is_not_new_or_exhaustive_aave_borrower_census":True,
    }


class ProviderRateGate:
    """Per-provider global 400 ms dispatch spacing shared by all A/B lanes."""
    def __init__(self, transport, interval_sec=MIN_SPACING_SEC,
                 clock=time.monotonic, sleeper=time.sleep):
        need(callable(transport) and callable(clock) and callable(sleeper),
             "invalid transport/throttle clock")
        need(type(interval_sec) in (float,int) and interval_sec>=MIN_SPACING_SEC,
             "do not disable per-provider RPC pacing")
        self.transport=transport
        self.interval=interval_sec
        self.clock=clock
        self.sleeper=sleeper
        self.guard=Lock()
        self.next_at=0.0
        self.dispatches=0

    def __call__(self,url,method,args):
        with self.guard:
            t=self.clock()
            if t<self.next_at:
                self.sleeper(self.next_at-t)
                t=self.clock()
            self.next_at=t+self.interval
            self.dispatches+=1
        return self.transport(url,method,args)


def normalized_accounts(rows,cohort):
    need(type(rows) is list and len(rows)==len(cohort)==N_ACCOUNTS,
         "incomplete nine-owner risk rows")
    ids=[x["borrower"] for x in cohort]
    need([x.get("borrower") for x in rows]==ids and
         len(set(ids))==N_ACCOUNTS,"future-selected or duplicate account identity")
    for row in rows:
        need(type(row.get("raw_abi_hex")) is str and
             borrow.decode_account(row["raw_abi_hex"])==row["risk"] and
             row["risk"]["health_factor_wad"].isdigit() and
             row["risk"]["total_debt_base_raw"].isdigit() and
             row["risk"]["total_collateral_base_raw"].isdigit() and
             row["raw_abi_sha256"]==
                 sha256(bytes.fromhex(row["raw_abi_hex"][2:])).hexdigest(),
             "risk words/raw ABI mismatch")
    return rows


def make_reader(provider,transport):
    return borrow.RPC(provider,transport=transport,
                      call_budget=MAX_CALLS_PER_PROVIDER)


def one_account(client,person,block_hash,allowed):
    raw=client.call("eth_call",[
        {"to":borrow.POOL,"data":borrow.call_data(person["borrower"])},
        {"blockHash":block_hash,"requireCanonical":True}
    ],allowed_borrowers=allowed)
    return {
        "borrower":person["borrower"],
        "raw_abi_hex":raw.lower(),
        "raw_abi_sha256":sha256(bytes.fromhex(raw[2:])).hexdigest(),
        "risk":borrow.decode_account(raw),
    }


def run_trial(mode,cohort,header,transports,now_fn=stamp):
    need(mode in ("SEQUENTIAL","THREE_LANES"),"unapproved A/B mode")
    allowed={p["borrower"] for p in cohort}
    need(len(allowed)==len(cohort)==N_ACCOUNTS,
         "missing/duplicate frozen old active-debt account")
    since=now_fn()
    providers={}
    histories={}
    calls={}
    def runner(provider):
        if mode=="SEQUENTIAL":
            client=make_reader(provider,transports[provider])
            items=[one_account(client,x,header["hash"],allowed)
                   for x in cohort]
            return normalized_accounts(items,cohort),[client.transcript],client.calls
        # Each worker uses a SEPARATE inherited RPC client and strict budget,
        # never races on a shared mutable RPC call counter.
        segments=[[(i,cohort[i]) for i in range(N_ACCOUNTS) if
                   i%LANES_PER_PROVIDER==slot]
                  for slot in range(LANES_PER_PROVIDER)]
        def lane(tasks):
            client=make_reader(provider,transports[provider])
            vals=[(i,one_account(client,x,header["hash"],allowed))
                  for i,x in tasks]
            return vals,client.transcript,client.calls
        with ThreadPoolExecutor(max_workers=LANES_PER_PROVIDER) as ex:
            results=list(ex.map(lane,segments))
        indexed={i:x for items,_,_ in results for i,x in items}
        need(len(indexed)==N_ACCOUNTS and set(indexed)==set(range(N_ACCOUNTS)),
             "parallel account partition skipped/duplicated")
        items=[indexed[i] for i in range(N_ACCOUNTS)]
        return normalized_accounts(items,cohort),[logs for _,logs,_ in results],sum(n for _,_,n in results)

    with ThreadPoolExecutor(max_workers=2) as e:
        results=list(e.map(runner,PROVIDERS))
    for provider,(records,logs,count) in zip(PROVIDERS,results):
        providers[provider]=records
        histories[provider]=logs
        calls[provider]=count
    need(providers["drpc"]==providers["publicnode"],
         "one of the two public sources disagreed on Aave ABI")
    ended=now_fn()
    duration=ended["process_monotonic_ns"]-since["process_monotonic_ns"]
    need(type(duration) is int and duration>=0 and
         duration<=MAX_LOCAL_DURATION_SEC*1_000_000_000,
         "clock defect or abnormally slow result")
    return {
        "mode":mode,
        "begin":since,"complete":ended,
        "elapsed_monotonic_ns":duration,
        "fixed_canonical_state_height":header["number"],
        "fixed_canonical_state_hash":header["hash"],
        "raw_abi_records_identical_between_sources":True,
        "accounts":providers["drpc"],
        "source_rpc_calls":calls,
        "source_rpc_transcript":histories,
        "has_private_pending_oracle_signal":False,
        "read_after_canonical_head_was_already_mined":True,
    }


def report_costs(trials,cohort,header):
    need(len(trials)==4 and
         [x["mode"] for x in trials]==[
            "SEQUENTIAL","THREE_LANES","THREE_LANES","SEQUENTIAL"],
         "wrong randomized-looking A/B execution order")
    expected=trials[0]["accounts"]
    for trial in trials:
        need(trial["accounts"]==expected and
             trial["fixed_canonical_state_hash"]==header["hash"] and
             trial["fixed_canonical_state_height"]==header["number"] and
             trial["raw_abi_records_identical_between_sources"] is True and
             all(n==N_ACCOUNTS for n in trial["source_rpc_calls"].values()),
             "source or mode discrepancy in benchmark, no speed claim")
    sequential=[x["elapsed_monotonic_ns"] for x in trials if x["mode"]=="SEQUENTIAL"]
    parallel=[x["elapsed_monotonic_ns"] for x in trials if x["mode"]=="THREE_LANES"]
    need(len(sequential)==len(parallel)==2,"incomplete AB BA benchmark")
    return {
        "sequential_trial_elapsed_ns":sequential,
        "three_lane_trial_elapsed_ns":parallel,
        "mean_sequential_elapsed_ns_integer":sum(sequential)//2,
        "mean_three_lane_elapsed_ns_integer":sum(parallel)//2,
        "three_lanes_faster_in_this_specific_two_round_sample":
            sum(parallel)<sum(sequential),
        "one_trial_is_not_a_reliable_speed_distribution":True,
        "network_order_provider_cache_and_load_confound_results":True,
        "actual_remote_rtt_and_queued_rate_limit_are_included":True,
        "eth_call_count_per_provider":N_ACCOUNTS*4,
        "risk_accounts_in_each_trial":len(cohort),
        "hf_below_one_count_in_this_small_frozen_cohort":sum(
            int(x["risk"]["total_debt_base_raw"])>0 and
            x["risk"]["status"]=="HF_LT_ONE_BORROWER_STATE_ONLY_NEEDS_ROUTE"
            for x in expected),
        "risk_state_is_not_a_verified_liquidation_route":True,
    }


def collect(cohort,source,out,transport_factory=None,now_fn=stamp):
    need(type(out) is Path or isinstance(out,Path),
         "expected pathlib evidence path")
    need(out.is_absolute() and out.is_dir() and not list(out.iterdir()),
         "fresh empty absolute evidence directory required")
    report={
        "schema_version":1,
        "status":"INCOMPLETE_READ_LATENCY_BENCHMARK_NOT_MARKET_ABSENCE",
        "source":source,
        "source_chosen_prior_to_current_RPC":True,
        "cohort_size":len(cohort),
        "precommit":None,
        "pinned_header":None,
        "mode_order":["SEQUENTIAL","THREE_LANES","THREE_LANES","SEQUENTIAL"],
        "trials":[],"latency_comparison":None,"errors":[],
        "public_already_mined_head_only":True,
        "builder_deadline_or_preinclusion_observation_proven":False,
        "private_chainlink_SVR_mevshare_access_proven":False,
        "nqc_profit_or_route_feasible_proven":False,
        "one_sample_is_not_fullday_shadow_or_full_aave_market":True,
        "real_ethereum_mainnet_tx_broadcast":False,
        "fees_user_mxn2000_or_operator_funds_spent":False,
        "nonrecourse_gas_sponsorship_proven":False,
        "OWN_CAPITAL_ZERO_INCLUDING_GAS_UNCHANGED":True,
        "commercial_score_upgrade":False,
        "RMC_closed":False,"P2_shadow_certified":False,
        "canary_live_authorized":False,
        "nqc_realized_pnl_usd":"0",
    }
    freeze={"source":source,"nine_frozen_debt_owners":cohort,
            "committed":now_fn(),
            "before_current_Ethereum_RPC":True,
            "no_second_head_or_future_HF_selection":True}
    dest=out/"cohort-sealed-before-new-network.json"
    dest.write_bytes(canon(freeze))
    report["precommit"]={"file":dest.name,"sha256":sha256(dest.read_bytes()).hexdigest(),
                         "committed_utc_unix_ns":freeze["committed"]["utc_unix_ns"]}
    limiter={}
    clients={}
    try:
        need(len(cohort)==N_ACCOUNTS and
             len({x["borrower"] for x in cohort})==N_ACCOUNTS,
             "nonfixed or truncated cohort")
        for p in PROVIDERS:
            base=(transport_factory(p) if transport_factory else borrow.RPC.network)
            limiter[p]=ProviderRateGate(base)
            clients[p]=make_reader(p,limiter[p])
        tips={p:clients[p].tip() for p in PROVIDERS}
        report["provider_tips_at_pin"]=tips
        need(abs(tips["drpc"]-tips["publicnode"])<=MAX_TIP_DIFFERENCE,
             "public source tips diverged")
        height=min(tips.values())-2
        need(height>0,"invalid tip-2 height")
        heads={p:clients[p].get_header(height) for p in PROVIDERS}
        need(heads["drpc"]==heads["publicnode"],
             "two sources disagree on exact pinned block")
        head=heads["drpc"]
        report["pinned_header"]=head
        begun=now_fn()
        need(0<=begun["utc_unix_ns"]//1_000_000_000-head["timestamp"]
             <=MAX_HEAD_AGE_SEC,"public block initially too old/future")
        for mode in report["mode_order"]:
            trial=run_trial(mode,cohort,head,limiter,now_fn)
            report["trials"].append(trial)
            now=now_fn()
            need(0<=now["utc_unix_ns"]//1_000_000_000-head["timestamp"]
                 <=MAX_HEAD_AGE_SEC,"pinned block aged out during A/B comparison")
        # Old block must remain canonical across BOTH sources after all modes.
        check={p:clients[p].get_header(height) for p in PROVIDERS}
        need(check["drpc"]==check["publicnode"]==head,
             "source canonical pinned header replaced/reorged")
        report["latency_comparison"]=report_costs(report["trials"],cohort,head)
        report["read_dispatches_per_provider"]={
            p:limiter[p].dispatches for p in PROVIDERS}
        report["preflight_and_recheck_rpc_transcripts"]={
            p:clients[p].transcript for p in PROVIDERS}
        need(all(limiter[p].dispatches<=MAX_CALLS_PER_PROVIDER
                 for p in PROVIDERS),"public requests exceeded hard budget")
        report["status"]="SOURCE_AUTHENTIC_AB_BA_PUBLIC_HEAD_LATENCY_NOT_SVR_ACCESS"
    except Exception as exc:
        report["errors"].append({"type":type(exc).__name__,
                                 "detail":str(exc).split("https://")[0][:260]})
    report["finished"]=now_fn()
    (out/"public-AB-BA-latency-result.json").write_bytes(canon(report))
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source-zip",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    x=p.parse_args()
    need(x.out.is_absolute() and not x.out.exists() and
         x.out.parent.is_dir(),"fresh absolute output directory required")
    cohort,source=authenticate_source(x.source_zip.read_bytes())
    x.out.mkdir()
    result=collect(cohort,source,x.out)
    print(result["status"],"trials",len(result["trials"]),
          "latency",result.get("latency_comparison"),"errors",result["errors"])
    return 0 # INCOMPLETE is a valid negative artifact but NEVER speed certification.

if __name__=="__main__":
    raise SystemExit(main())
