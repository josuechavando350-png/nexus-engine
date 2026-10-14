#!/usr/bin/env python3
"""NQC V2 source-frozen public Aave active-debt watch — two future observed heads.

Precommit 9 source-authenticated old active-debt Aave borrowers BEFORE reading
ANY new Ethereum tip/HF, then read their exact canonical six-word Aave risk on
two Ethereum block heights, and record wallclock/monotonic decision seals.

IMPORTANT: PUBLIC HEADS ARE ALREADY MINED when we receive them. "Sealed
before next locally SEEN header" NEVER means before block actually mined,
before private SVR notice or builder cutoff. No execution, bid, signature, gas,
paid RPC, portfolio PnL, or NQC production authorization.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import stat
import time
import zipfile

import prospective_recent_borrow_cohort as borrow
import withdraw_all_83_owner_refresh as previous

OLD_ZIP_SHA = "551b50b111a2451a487a8cd73c2597cf83b119030162e53c4195a66ef1b3b2bf"
OLD_COMMIT = "4f790b91df324565e71bfa4f6002f46ae27f575b"
OLD_TREE = "dc49712f1711d759e6d2aa4614240720c431b4ab"
OLD_RUN = 38591219786
OLD_ARTIFACT = 11908200180
N_SOURCE_MEMBERS = 20
PREVIOUS_SOURCE_OWNERS = 83
PREVIOUS_ACTIVE = 9
PREVIOUS_ZERO_DEBT = 74
MAX_ZIP = 3_000_000
MAX_DECOMPRESSED = 30_000_000
MAX_WATCH_UNIX_AGE = 45
MAX_TIP_DIVERGENCE = 3
MAX_POLL_SECONDS = 160
MAX_POLL_ITERATIONS = 40
MAX_RPC_BUDGET = 110
MAX_HF_COHORT = 9
WAD = borrow.WAD

class Rejected(ValueError):
    pass

def need(valid, reason):
    if not valid:raise Rejected(reason)

def stamp():
    return datetime.now(timezone.utc).isoformat()

def clock():
    return {"utc_unix_ns":time.time_ns(), "local_monotonic_ns":time.monotonic_ns()}

def canon(obj):
    return (json.dumps(obj,ensure_ascii=True,sort_keys=True,separators=(",",":"))+"\n").encode()

def strict_json(raw):
    def pairs(items):
        out={}
        for k,v in items:
            need(k not in out,"duplicate source JSON property "+k)
            out[k]=v
        return out
    return json.loads(raw,object_pairs_hook=pairs,
        parse_constant=lambda s:(_ for _ in ()).throw(Rejected("non-finite JSON")))

def authenticate_old_source(blob):
    need(type(blob) is bytes and 0<len(blob)<=MAX_ZIP,
         "old evidence must be bounded bytes")
    need(sha256(blob).hexdigest()==OLD_ZIP_SHA,
         "original PR718 ZIP SHA changed")
    with zipfile.ZipFile(BytesIO(blob)) as z:
        infos=z.infolist()
        files=[i.filename for i in infos if not i.is_dir()]
        need(len(files)==len(set(files))==N_SOURCE_MEMBERS+1 and
             len(infos)==len(files) and
             sum(i.file_size for i in infos)<MAX_DECOMPRESSED,
             "old ZIP member table duplicate/unbounded/partial")
        for item in infos:
            p=PurePosixPath(item.filename)
            need(item.filename==str(p) and not p.is_absolute() and
                 ".." not in p.parts and "\\" not in item.filename and
                 not stat.S_ISLNK(item.external_attr>>16) and
                 item.file_size<=10_000_000,"unsafe original ZIP member")
        need(set(("manifest.sha256","code-commit.txt","code-tree.txt",
                  "11905790765.zip","all-83-withdraw-owner-risk.json"))<=set(files),
             "old source authority incomplete")
        need(z.read("code-commit.txt").decode("ascii").strip()==OLD_COMMIT and
             z.read("code-tree.txt").decode("ascii").strip()==OLD_TREE,
             "original code commit/tree drift")
        manifest={}
        for line in z.read("manifest.sha256").decode("ascii").splitlines():
            found=re.fullmatch(r"([0-9a-f]{64})  \./([A-Za-z0-9._/-]+)",line)
            need(found is not None,"malformed old source SHA256 manifest")
            digest,name=found.groups()
            need(name not in manifest,"duplicate old source member")
            manifest[name]=digest
        need(len(manifest)==N_SOURCE_MEMBERS and
             set(manifest)==set(files)-{"manifest.sha256"},
             "original source manifest incomplete")
        for name,digest in manifest.items():
            need(sha256(z.read(name)).hexdigest()==digest,
                 "source member data SHA mismatch "+name)
        earlier,pp=previous.authenticate_zip(z.read("11905790765.zip"))
        source_order,previous64,boundaries=previous.source_cohort(earlier)
        current=strict_json(z.read("all-83-withdraw-owner-risk.json"))
    need(current.get("status")=="TWO_URL_ALL_83_WITHDRAW_OWNER_HF_VERIFIED_NOT_P2" and
         current.get("source",{}).get("producer_zip_sha256")==previous.PRODUCER_ZIP_SHA and
         current.get("errors")==[] and
         current.get("verified_all_owner_accounts")==PREVIOUS_SOURCE_OWNERS and
         current.get("active_debt_count")==PREVIOUS_ACTIVE and
         current.get("zero_debt_count")==PREVIOUS_ZERO_DEBT and
         current.get("verified_19_omitted_accounts")==19 and
         current.get("omitted_19_active_debt_count")==0 and
         current.get("hf_below_one_with_debt_count")==0 and
         current.get("two_public_url_exact_account_parity") is True,
         "historical full 83 owners source or commercial claims invalid")
    for claim in ("commercial_score_upgrade","RMC_closed","P2_shadow_certified",
                  "canary_live_authorized","prospective_pre_inclusion_observation_proven",
                  "net_profit_or_positive_ev_certified",
                  "nonrecourse_native_gas_sponsor_proven"):
        need(current.get(claim) is False,
             "prior source promoted unproven future outcome "+claim)
    need(current.get("nqc_realized_pnl_usd")=="0",
         "old source changed actual NQC PnL")
    data=current.get("providers")
    need(type(data) is dict and set(data)=={"drpc","publicnode"} and
         data["drpc"]["status"]==data["publicnode"]["status"]==
           "COMPLETE_83_OWNER_CURRENT_STATE" and
         data["drpc"]["accounts"]==data["publicnode"]["accounts"],
         "prior 83 account two public source parity unavailable")
    actual=data["drpc"]["accounts"]
    need(len(actual)==PREVIOUS_SOURCE_OWNERS and
         [r.get("borrower") for r in actual]==source_order and
         [r.get("borrower") for r in previous64]==source_order[:64],
         "old owner order differs from authenticated pre-observation events")
    cohort=[]
    for row in actual:
        risk=row["account"]
        if int(risk["total_debt_base_raw"])>0:
            need(type(row["borrower"]) is str and
                 re.fullmatch(r"0x[0-9a-f]{40}",row["borrower"]) and
                 type(risk["health_factor_wad"]) is str and
                 int(risk["health_factor_wad"])>=WAD,
                 "wrong prior full cohort active debt identity or HF")
            cohort.append({
                "borrower":row["borrower"],
                "source_old_debt_base":risk["total_debt_base_raw"],
                "source_old_health_factor_wad":risk["health_factor_wad"],
                "source_old_account_raw_abi_sha256":row["source_raw_abi_sha256"],
            })
    need(len(cohort)==MAX_HF_COHORT and len({x["borrower"] for x in cohort})==len(cohort),
         "not exactly nine source-proven old active-debt owners")
    cohort.sort(key=lambda x:(int(x["source_old_health_factor_wad"]),x["borrower"]))
    return cohort,{
        "source_pr718_artifact_id":OLD_ARTIFACT,"source_pr718_run":OLD_RUN,
        "source_pr718_commit":OLD_COMMIT,"source_pr718_tree":OLD_TREE,
        "source_zip_sha256":OLD_ZIP_SHA,
        "source_manifest_entries_verified":N_SOURCE_MEMBERS,
        "underlying_event_pr717_zip_sha256":pp["producer_zip_sha256"],
        "active9_chosen_entirely_from_pr718_old_snapshot":True,
        "original_fixed_event_owner_universe":PREVIOUS_SOURCE_OWNERS,
        "source_old_block":current["fresh_pinned_block"]["number"],
        "source_old_state_not_recent_or_fresh_market_census":True,
    }

def bounded_rpc(clients,method,params,who=None):
    need(set(clients)=={"drpc","publicnode"},"two explicit public sources required")
    for client in clients.values():
        need(client.calls<=MAX_RPC_BUDGET,"exceeded source request budget")
    # All public calls go through the inherited exact method/arg allowlist.
    return {name:rpc.call(method,params,allowed_borrowers=who)
            for name,rpc in clients.items()}

def get_paired_header(clients,height):
    need(type(height) is int and height>0,"invalid Ethereum height")
    pairs={name:rpc.get_header(height) for name,rpc in clients.items()}
    need(set(pairs)=={"drpc","publicnode"} and
         pairs["drpc"]==pairs["publicnode"],
         "public providers disagree on canonical source block identity")
    return pairs["drpc"]

def current_tip(clients):
    heads={name:borrow.qty(client.call("eth_blockNumber",[]),"tip")
           for name,client in clients.items()}
    need(abs(heads["drpc"]-heads["publicnode"])<=MAX_TIP_DIVERGENCE,
         "public provider current block diverged")
    return heads

def watch_one_head(clients,height,cohort,now_fn=clock):
    target=get_paired_header(clients,height)
    onset=now_fn()
    need(0<=onset["utc_unix_ns"]//1_000_000_000-
         target["timestamp"]<=MAX_WATCH_UNIX_AGE,
         "first-seen public canonical head stale/future")
    allowed={r["borrower"] for r in cohort}
    def observer(name):
        rpc=clients[name]
        records=[]
        for person in cohort:
            raw=rpc.call("eth_call",[
                {"to":borrow.POOL,
                 "data":borrow.call_data(person["borrower"])},
                {"blockHash":target["hash"],"requireCanonical":True}],
                allowed_borrowers=allowed)
            records.append({
                "borrower":person["borrower"],
                "six_word_abi_sha256":sha256(bytes.fromhex(raw[2:])).hexdigest(),
                "risk":borrow.decode_account(raw),
            })
        need(rpc.get_header(height)==target,
             "risk state block changed/reorged during this source's read")
        return records
    with ThreadPoolExecutor(max_workers=2) as pool:
        future={name:pool.submit(observer,name) for name in clients}
        result={name:f.result() for name,f in future.items()}
    need(result["drpc"]==result["publicnode"] and
         len(result["drpc"])==len(cohort)==MAX_HF_COHORT,
         "incomplete/discordant current Aave user account data")
    end=now_fn()
    need(end["local_monotonic_ns"]>=onset["local_monotonic_ns"],
         "nonmonotonic wall clock time")
    n_active=sum(int(x["risk"]["total_debt_base_raw"])>0
                 for x in result["drpc"])
    count_below=sum(int(x["risk"]["total_debt_base_raw"])>0 and
                    x["risk"]["status"]=="HF_LT_ONE_BORROWER_STATE_ONLY_NEEDS_ROUTE"
                    for x in result["drpc"])
    payload={
        "chain_id":1,"height":height,
        "canonical_header":target,
        "public_block_first_seen_by_this_process":onset,
        "risk_snapshot_sealed_by_this_process":end,
        "source_proven_active_old_borrowers_consulted":len(cohort),
        "source_active_debt_now_count":n_active,
        "state_hf_lt_one_now_count":count_below,
        "source_two_public_url_raw_account_parity":True,
        "accounts":result["drpc"],
        "decision":{
            "eligible_risk_only_borrowers":[x["borrower"] for x in result["drpc"]
                if int(x["risk"]["total_debt_base_raw"])>0 and
                   x["risk"]["status"]=="HF_LT_ONE_BORROWER_STATE_ONLY_NEEDS_ROUTE"],
            "candidate_signal_is_post_public_header_only":True,
            "owner_was_preselected_before_run_public_state":True,
            "route_swap_funding_and_inclusion_verified":False,
            "profits_or_live_trades_claimed":False,
        },
    }
    payload["sealed_payload_sha256"]=sha256(canon(payload)).hexdigest()
    return payload

def wait_next_height(clients,old_height,now_fn=clock,sleeper=time.sleep):
    for step in range(MAX_POLL_ITERATIONS):
        began=now_fn()
        tips=current_tip(clients)
        if min(tips.values())>=old_height+1:
            head=get_paired_header(clients,old_height+1)
            seen=now_fn()
            return {
                "first_successor_public_poll_begin":began,
                "first_successor_public_header_seen_by_this_process":seen,
                "successor_header":head,"source_tips_at_successor_poll":tips,
                "successor_was_already_mined_when_this_process_saw_it":True,
                "does_not_prove_pre_builder_oracle_hints_or_access":True,
            }
        sleeper(2.0)
    raise Rejected("next Ethereum canonical header unavailable within bounded polling")

def collect(cohort,provenance,out_dir,transport_factory=None,
            now_fn=clock,sleeper=time.sleep):
    need(type(out_dir) is Path and out_dir.is_absolute() and
         out_dir.is_dir() and len(list(out_dir.iterdir()))==0,
         "new empty absolute evidence output directory required")
    report={
        "schema_version":1,
        "status":"INCOMPLETE_PUBLIC_HEAD_TIMING_NOT_MARKET_ABSENCE",
        "source":provenance,"owner_selection_rule":
            "ALL_9_OLD_ACTIVE_DEBT_ACCOUNTS_FIXED_FROM_PR718_BEFORE_LIVE_RPC",
        "chosen_owner_count":len(cohort),
        "previous_indexed_owner_universe_count":PREVIOUS_SOURCE_OWNERS,
        "precommit_source_snapshot":None,
        "observations":[],"first_local_successor_head":None,
        "errors":[],
        "all_public_sources_agreed_exact_canonical_EIP1898_state":False,
        "first_seen_is_after_canonical_block_inclusion":True,
        "sealed_before_first_local_successor_header_observation":False,
        "sealed_before_real_block_was_mined_proven":False,
        "private_SVR_or_MEV_share_first_seen_proven":False,
        "builder_deadline_known":False,
        "early_pending_feed_access_proven":False,
        "public_head_observation_is_not_live_opportunity_capture":True,
        "full_aave_borrower_census_or_no_market_claim_proven":False,
        "zero_trades_and_zero_signed_transactions":True,
        "competitive_win_or_pricing_route_proven":False,
        "nonrecourse_gas_sponsor_proven":False,
        "commercial_score_upgrade":False,"RMC_closed":False,
        "P2_shadow_certified":False,"canary_live_authorized":False,
        "OWN_CAPITAL_ZERO_INCLUDING_GAS_UNCHANGED":True,
        "user_mxn2000_spent":False,"nqc_realized_pnl_usd":"0",
    }
    frozen={
        "source":provenance,
        "committed_at":now_fn(),
        "fixed_selections":cohort,
        "no_current_ethereum_rpc_yet":True,
        "future_HF_or_competitor_outcome_not_used_for_selection":True,
    }
    freeze_path=out_dir/"cohort-before-network.json"
    freeze_path.write_bytes(canon(frozen))
    report["precommit_source_snapshot"]={
        "file":"cohort-before-network.json",
        "sha256":sha256(freeze_path.read_bytes()).hexdigest(),
        "precommit_utc_unix_ns":frozen["committed_at"]["utc_unix_ns"],
    }
    clients={}
    try:
        need(len(cohort)==MAX_HF_COHORT,
             "not exact precommitted 9 owner count")
        for provider in ("drpc","publicnode"):
            clients[provider]=borrow.RPC(
                provider,transport_factory(provider) if transport_factory else None,
                call_budget=MAX_RPC_BUDGET)
        tips={name:rpc.tip() for name,rpc in clients.items()}
        need(abs(tips["drpc"]-tips["publicnode"])<=MAX_TIP_DIVERGENCE,
             "initial provider tips too far apart")
        initial=min(tips.values())
        report["initial_public_tips"]=tips
        first=watch_one_head(clients,initial,cohort,now_fn)
        first_path=out_dir/"first-public-state-seal.json"
        first_path.write_bytes(canon(first))
        report["first_state_seal_sha256"]=sha256(first_path.read_bytes()).hexdigest()
        report["observations"].append(first)
        observed=wait_next_height(clients,initial,now_fn,sleeper)
        report["first_local_successor_head"]=observed
        report["sealed_before_first_local_successor_header_observation"]=(
            first["risk_snapshot_sealed_by_this_process"]["local_monotonic_ns"]<=
            observed["first_successor_public_header_seen_by_this_process"]["local_monotonic_ns"])
        need(report["sealed_before_first_local_successor_header_observation"],
             "source decision was not sealed before locally observing successor")
        second=watch_one_head(clients,initial+1,cohort,now_fn)
        second_path=out_dir/"second-public-state-seal.json"
        second_path.write_bytes(canon(second))
        report["second_state_seal_sha256"]=sha256(second_path.read_bytes()).hexdigest()
        report["observations"].append(second)
        report["all_public_sources_agreed_exact_canonical_EIP1898_state"]=True
        report["status"]="TWO_PUBLIC_CANONICAL_HEADS_AFTER_INCLUSION_ONLY_NO_CAPTURE"
        report["block_height_increment"]=1
        report["active_debt_at_each_public_height"]=[
            s["source_active_debt_now_count"] for s in report["observations"]]
        report["hf_lt_one_at_each_public_height"]=[
            s["state_hf_lt_one_now_count"] for s in report["observations"]]
        report["count_from_nine_old_accounts_not_whole_aave"]=True
    except Exception as exc:
        report["errors"].append({"stage":"public_watch",
            "type":type(exc).__name__,
            "detail":str(exc).split("https://")[0][:220]})
    report["rpc_source_transcripts"]={
        name:rpc.transcript for name,rpc in clients.items()}
    report["rpc_calls_per_source"]={name:rpc.calls for name,rpc in clients.items()}
    report["finished_at"]=now_fn()
    (out_dir/"public-watch-result.json").write_bytes(canon(report))
    return report

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--old-evidence-zip",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    need(args.out.is_absolute() and not args.out.exists() and
         args.out.parent.is_dir(),"fresh absolute output directory required")
    cohort,source=authenticate_old_source(args.old_evidence_zip.read_bytes())
    args.out.mkdir()
    result=collect(cohort,source,args.out)
    print(result["status"],"observed canonical public heads",
          len(result["observations"]),"HF<1",
          result.get("hf_lt_one_at_each_public_height"),"errors",len(result["errors"]))
    return 0  # Incomplete audits are censored in jq, never false MARKET_ZERO.

if __name__=="__main__":
    raise SystemExit(main())
