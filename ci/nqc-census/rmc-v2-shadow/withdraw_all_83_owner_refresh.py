#!/usr/bin/env python3
"""Recheck ALL 83 owners in immutable PR717 Aave Withdraw corpus, read-only.

This is a point-in-time, post-event risk reading. It is NOT a live opportunity,
mempool signal, NQC liquidation, profitable strategy or whole-Aave census.
No remote server, wallet, signature, transaction submission or expense.
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

import prospective_recent_withdraw_cohort as previous

PRODUCER_HEAD = "e0f589b8f1e47ffda04ef6e2c9031f695222fa42"
PRODUCER_TREE = "6e0ce2e5056d98f9b0218a0d788babd564ad2115"
PRODUCER_ZIP_SHA = "0cf05f5acf279948dbdf92b5b52183c129175850fdd311c13e3356d7ede289a2"
PRODUCER_ARTIFACT = 11905790765
PRODUCER_RUN = 38585339954
PRODUCER_REPORT = "withdraw-owner-risk.json"
EXPECTED_EVENTS = 149
EXPECTED_EVENT_BLOCKS = 106
EXPECTED_OWNERS = 83
EXPECTED_PRIOR_SELECTED = 64
EXPECTED_OMITTED = 19
MAX_ZIP_BYTES = 4_000_000
MAX_UNCOMPRESSED_BYTES = 25_000_000
MAX_SOURCE_MEMBERS = 36
PIN_DEPTH = 3
TIP_DRIFT_MAX = 12
MAX_AGE_SECONDS = 180
MAX_ACCOUNTS = 83
MAX_READ_CALLS_PER_SOURCE = 95
UINT = re.compile(r"(?:0|[1-9][0-9]*)\Z")
HEX32 = re.compile(r"0x[0-9a-fA-F]{64}\Z")
ADDR = re.compile(r"0x[0-9a-f]{40}\Z")
MANIFEST_LINE = re.compile(r"([0-9a-f]{64})  \./([A-Za-z0-9._/-]+)\Z")


class Rejected(ValueError):
    pass


def need(ok, why):
    if not ok:
        raise Rejected(why)


def now_epoch():
    return int(datetime.now(timezone.utc).timestamp())


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def canon(doc):
    return (json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=True)+"\n").encode()


def authenticate_zip(raw: bytes):
    need(type(raw) is bytes and 0<len(raw)<=MAX_ZIP_BYTES, "unexpected producer ZIP size/type")
    need(sha256(raw).hexdigest()==PRODUCER_ZIP_SHA,"PR717 immutable ZIP SHA changed")
    with zipfile.ZipFile(BytesIO(raw)) as z:
        entries=[x for x in z.infolist() if not x.is_dir()]
        names=[x.filename for x in entries]
        need(len(names)==len(set(names)) and len(names)<=MAX_SOURCE_MEMBERS,
             "duplicate/oversized ZIP member table")
        need(sum(x.file_size for x in entries)<=MAX_UNCOMPRESSED_BYTES,
             "ZIP decompression budget exceeded")
        for item in entries:
            name=item.filename
            p=PurePosixPath(name)
            mode=(item.external_attr>>16)
            need(name==str(p) and not p.is_absolute()
                 and ".." not in p.parts and "\\" not in name
                 and item.file_size<=8_000_000
                 and not stat.S_ISLNK(mode), "unsafe archive entry")
        need({PRODUCER_REPORT,"manifest.sha256","code-commit.txt","code-tree.txt"}<=set(names),
             "producer evidence incomplete")
        need(z.read("code-commit.txt").decode("ascii").strip()==PRODUCER_HEAD,
             "producer commit drift")
        need(z.read("code-tree.txt").decode("ascii").strip()==PRODUCER_TREE,
             "producer tree drift")
        expected={}
        for line in z.read("manifest.sha256").decode("ascii").splitlines():
            match=MANIFEST_LINE.fullmatch(line)
            need(match is not None, "malformed immutable manifest line")
            digest,name=match.groups()
            need(name not in expected and name!="manifest.sha256",
                 "duplicate/recursive hash entry")
            expected[name]=digest
        need(set(expected)==set(names)-{"manifest.sha256"} and
             len(expected)==18,"missing or duplicate PR717 source members")
        for name,digest in expected.items():
            need(sha256(z.read(name)).hexdigest()==digest,
                 "member hash mismatch: "+name)
        def pairs(items):
            out={}
            for k,v in items:
                need(k not in out,"duplicate evidence key "+k)
                out[k]=v
            return out
        evidence=json.loads(z.read(PRODUCER_REPORT),object_pairs_hook=pairs,
                            parse_constant=lambda v: (_ for _ in ()).throw(
                                Rejected("nonfinite JSON token "+v)))
    return evidence,{"source_head":PRODUCER_HEAD,
                     "source_tree":PRODUCER_TREE,
                     "producer_artifact_id":PRODUCER_ARTIFACT,
                     "producer_workflow_run":PRODUCER_RUN,
                     "producer_zip_sha256":PRODUCER_ZIP_SHA,
                     "manifest_members_sha256_verified":len(expected)}


def source_cohort(evidence):
    need(type(evidence) is dict and
         evidence.get("status")=="DUAL_RPC_RECENT_WITHDRAW_OWNERS_RISK_ONLY_NOT_P2" and
         evidence.get("chain_id")==1 and
         evidence.get("source_event_topic0")==previous.WITHDRAW_TOPIC and
         evidence.get("errors")==[] and
         evidence.get("verified_withdraw_event_count")==EXPECTED_EVENTS and
         evidence.get("verified_distinct_owner_count")==EXPECTED_OWNERS and
         evidence.get("verified_selected_owner_count")==EXPECTED_PRIOR_SELECTED and
         evidence.get("verified_active_debt_accounts")==9 and
         evidence.get("verified_hf_lt_one_count")==0,
         "previous source is not the scoped verified 149/83/64 evidence")
    for key in ("commercial_score_upgrade","RMC_closed","P2_shadow_certified",
                "canary_live_authorized","cold_gas_NQC_verified",
                "net_pnl_proven","competitive_capture_proven",
                "external_native_gas_sponsor_nonrecourse_proven"):
        need(evidence.get(key) is False,"prior source elevated commercial claims")
    need(evidence.get("nqc_realized_pnl_usd")=="0","prior source has NQC realized P&L")
    anchor=evidence.get("anchor")
    need(type(anchor) is dict and anchor.get("first_block")==26191104 and
         anchor.get("last_block")==26191487 and
         anchor.get("inclusive_blocks")==384 and
         anchor.get("state_block_after_event_window_end")==10,
         "original 384-block source anchor changed")
    src=evidence.get("source_reports")
    state=evidence.get("state_reports")
    need(type(src) is dict and type(state) is dict and
         set(src)==set(state)=={"drpc","publicnode"}, "previous source URLs changed")
    for prov in src:
        row=src[prov]
        need(row.get("status")=="COMPLETE_CANONICAL_WITHDRAW_EVENTS" and
             row.get("errors")==[] and row.get("shards_complete")==16 and
             row.get("event_blocks_verified")==EXPECTED_EVENT_BLOCKS and
             len(row.get("positive_receipts",[]))==2 and
             type(row.get("events")) is list and len(row["events"])==EXPECTED_EVENTS and
             type(row.get("canonical_header_partitions")) is list and
             sum(x["number_of_distinct_event_blocks"] for x in
                 row["canonical_header_partitions"])==EXPECTED_EVENT_BLOCKS and
             all(x.get("all_headers_authenticated") is True and
                 x.get("number_of_distinct_event_blocks",0)<=96
                 for x in row["canonical_header_partitions"]),
             "prior source never completed exhaustive header/event attestation")
        need(state[prov].get("status")=="COMPLETE_STATE" and
             len(state[prov].get("accounts",[]))==EXPECTED_PRIOR_SELECTED,
             "previous account data incomplete")
    need(src["drpc"]["events"]==src["publicnode"]["events"] and
         src["drpc"]["first_header"]==src["publicnode"]["first_header"] and
         src["drpc"]["last_header"]==src["publicnode"]["last_header"] and
         state["drpc"]["accounts"]==state["publicnode"]["accounts"],
         "prior dRPC/PublicNode parity changed")
    events=src["drpc"]["events"]
    ids=set()
    ordered=[]
    for e in sorted(events,key=previous.event_id,reverse=True):
        need(type(e) is dict and type(e.get("owner")) is str
             and ADDR.fullmatch(e["owner"])
             and type(e.get("block_number")) is int
             and anchor["first_block"]<=e["block_number"]<=anchor["last_block"]
             and type(e.get("log_index")) is int and e["log_index"]>=0
             and type(e.get("tx_index")) is int and e["tx_index"]>=0
             and type(e.get("tx_hash")) is str and HEX32.fullmatch(e["tx_hash"])
             and type(e.get("block_hash")) is str and HEX32.fullmatch(e["block_hash"])
             and type(e.get("raw_event_sha256")) is str and
             re.fullmatch(r"[0-9a-f]{64}",e["raw_event_sha256"])
             and e.get("source_event_is_not_automatically_effective_collateral") is True,
             "malformed previous Withdraw source event")
        identity=previous.event_id(e)
        need(identity not in ids,"duplicate canonical Withdraw event")
        ids.add(identity)
        if e["owner"] not in ordered:
            ordered.append(e["owner"])
    need(len(ordered)==EXPECTED_OWNERS,"not exactly 83 source-proven owners")
    original,selection=previous.select(events)
    need(type(original) is list and len(original)==EXPECTED_PRIOR_SELECTED and
         original==evidence.get("source_cohort") and
         selection==evidence.get("selection") and
         selection.get("owners_omitted_due_bounded_limit")==EXPECTED_OMITTED and
         [x["borrower"] for x in original]==ordered[:EXPECTED_PRIOR_SELECTED],
         "old 64 owner selection cannot be reproduced")
    previous_state=state["drpc"]["accounts"]
    need([x.get("borrower") for x in previous_state]==ordered[:EXPECTED_PRIOR_SELECTED],
         "earlier snapshot borrower ordering differs")
    event_block_set={e["block_number"] for e in events}
    need(len(event_block_set)==EXPECTED_EVENT_BLOCKS,
         "previous event-bearing header count inconsistent")
    omissions=ordered[EXPECTED_PRIOR_SELECTED:]
    need(len(omissions)==EXPECTED_OMITTED and
         sum(e["owner"] in set(omissions) for e in events)==24,
         "exactly 19 omitted owners / 24 withdraw events cannot be recovered")
    return ordered,previous_state,{"first":src["drpc"]["first_header"],
                                   "last":src["drpc"]["last_header"]}


def empty_report(provenance,owners):
    return {
        "schema_version":1,
        "status":"INCOMPLETE_ALL_83_WITHDRAW_OWNER_CURRENT_STATE",
        "source":provenance,
        "source_indexed_withdraw_events":EXPECTED_EVENTS,
        "source_distinct_withdraw_owners":EXPECTED_OWNERS,
        "previously_state_verified_owners":EXPECTED_PRIOR_SELECTED,
        "previously_unobserved_owners":EXPECTED_OMITTED,
        "previously_unobserved_owner_event_count":24,
        "selected_owner_count_before_any_new_HF_reads":len(owners),
        "owner_selection_rule":"ALL_83_FROM_PR717_CANONICAL_WITHDRAW_EVENTS",
        "selected_prior_to_current_risk_state":True,
        "prior_liquidation_winner_selection_not_used":True,
        "window_not_live_complete_aave_position_universe":True,
        "source_window_384_blocks":True,
        "source_canonical_evidence_from_pr717_not_new_log_scan":True,
        "source_intermediate_block_ancestry_not_independently_rechecked":True,
        "new_source_current_borrower_cohort_not_discovered":True,
        "current_chain_id":1,
        "fresh_pinned_block":None,
        "providers":{},
        "errors":[],
        "two_public_url_exact_account_parity":False,
        "verified_all_owner_accounts":None,
        "verified_19_omitted_accounts":None,
        "active_debt_count":None,
        "zero_debt_count":None,
        "hf_below_one_with_debt_count":None,
        "hf_1_to_1_005_count":None,
        "hf_1_005_to_1_02_count":None,
        "hf_1_02_to_1_10_count":None,
        "min_positive_debt_hf_wad":None,
        "omitted_19_active_debt_count":None,
        "omitted_19_hf_below_one_count":None,
        "omitted_19_near_200bps_count":None,
        "comparable_prior_64_with_debt_both_states":None,
        "comparable_64_hf_increased_count":None,
        "comparable_64_hf_decreased_count":None,
        "comparable_64_hf_unchanged_count":None,
        "prospective_pre_inclusion_observation_proven":False,
        "source_census_complete_aave_active_accounts":False,
        "liquidation_route_executable_proven":False,
        "cold_standalone_nqc_transaction_gas_verified":False,
        "competitive_inclusion_or_winrate_proven":False,
        "nonrecourse_native_gas_sponsor_proven":False,
        "net_profit_or_positive_ev_certified":False,
        "RMC_closed":False,"P2_shadow_certified":False,
        "canary_live_authorized":False,
        "commercial_score_upgrade":False,
        "nqc_realized_pnl_usd":"0",
    }


def read_one_source(provider,owners,anchor,old_headers,time_provider):
    rpc=previous.borrow.RPC(provider)
    sample={"provider":provider,"status":"INCOMPLETE_CURRENT_OWNER_SOURCE",
            "accounts":[],"errors":[]}
    allowed=set(owners)
    try:
        for kind in ("first","last"):
            expected=old_headers[kind]
            need(rpc.get_header(expected["number"])==expected,
                 "producer anchored historical boundary changed or reorged")
        observed=rpc.get_header(anchor["number"])
        need(observed==anchor,"fresh current header differs across sources")
        sample["fresh_block_header"]=observed
        need(0<=time_provider()-anchor["timestamp"]<=MAX_AGE_SECONDS,
             "fresh block was stale at beginning of risk read")
        for owner in owners:
            raw=rpc.call("eth_call",[
                {"to":previous.POOL,"data":previous.borrow.call_data(owner)},
                {"blockHash":anchor["hash"],"requireCanonical":True}],
                allowed_borrowers=allowed)
            risk=previous.borrow.decode_account(raw)
            sample["accounts"].append({
                "borrower":owner,
                "account":risk,
                "source_raw_abi_sha256":sha256(raw.lower().encode()).hexdigest(),
                "risk_at_pinned_post_event_state_only":True,
                "borrower_not_proof_of_actionable_trade":True,
            })
        need(rpc.get_header(anchor["number"])==anchor,
             "pinned block changed during 83-account read")
        need(0<=time_provider()-anchor["timestamp"]<=MAX_AGE_SECONDS,
             "fresh state aged out before complete cohort validation")
        need(len(sample["accounts"])==MAX_ACCOUNTS,
             "not all 83 source owners received valid state")
        sample["status"]="COMPLETE_83_OWNER_CURRENT_STATE"
    except Exception as exc:
        sample["errors"].append({"type":type(exc).__name__,
                                 "detail":str(exc).split("https://")[0][:220]})
    sample["calls_used"]=rpc.calls
    sample["rpc_transcript"]=rpc.transcript
    need(rpc.calls<=MAX_READ_CALLS_PER_SOURCE,
         "whole-source query quota violated")
    return sample


def complete_counts(out,owners,previous_states):
    need(out["providers"]["drpc"]["status"]==
         out["providers"]["publicnode"]["status"]=="COMPLETE_83_OWNER_CURRENT_STATE",
         "source not complete")
    a=out["providers"]["drpc"]["accounts"]
    b=out["providers"]["publicnode"]["accounts"]
    need(a==b and len(a)==len(b)==len(owners)==MAX_ACCOUNTS,
         "exact two-source raw account parity absent")
    needs=[x["account"] for x in a]
    stat_names=[x["status"] for x in needs]
    active=[x for x in needs if int(x["total_debt_base_raw"])>0]
    out["two_public_url_exact_account_parity"]=True
    out["status"]="TWO_URL_ALL_83_WITHDRAW_OWNER_HF_VERIFIED_NOT_P2"
    out["verified_all_owner_accounts"]=len(a)
    out["verified_19_omitted_accounts"]=EXPECTED_OMITTED
    out["active_debt_count"]=len(active)
    out["zero_debt_count"]=stat_names.count("NO_OUTSTANDING_DEBT_IN_PINNED_AAVE_SNAPSHOT")
    out["hf_below_one_with_debt_count"]=stat_names.count(
        "HF_LT_ONE_BORROWER_STATE_ONLY_NEEDS_ROUTE")
    out["hf_1_to_1_005_count"]=stat_names.count("HF_1_TO_1_005_PRIORITY_WATCH_ONLY")
    out["hf_1_005_to_1_02_count"]=stat_names.count("HF_1_005_TO_1_02_WATCH_ONLY")
    out["hf_1_02_to_1_10_count"]=stat_names.count("HF_1_02_TO_1_10_WATCH_ONLY")
    out["min_positive_debt_hf_wad"]=(
        min(int(x["health_factor_wad"]) for x in active) if active else None)
    omitted=needs[EXPECTED_PRIOR_SELECTED:]
    out["omitted_19_active_debt_count"]=sum(
        int(x["total_debt_base_raw"])>0 for x in omitted)
    out["omitted_19_hf_below_one_count"]=sum(
        x["status"]=="HF_LT_ONE_BORROWER_STATE_ONLY_NEEDS_ROUTE" for x in omitted)
    out["omitted_19_near_200bps_count"]=sum(
        x["status"] in ("HF_1_TO_1_005_PRIORITY_WATCH_ONLY",
                        "HF_1_005_TO_1_02_WATCH_ONLY") for x in omitted)
    old={x["borrower"]:x["risk"] for x in previous_states}
    comparable=[]
    for item in a[:EXPECTED_PRIOR_SELECTED]:
        pre=old[item["borrower"]]
        post=item["account"]
        if int(pre["total_debt_base_raw"])>0 and int(post["total_debt_base_raw"])>0:
            comparable.append((
                int(pre["health_factor_wad"]),
                int(post["health_factor_wad"])))
    out["comparable_prior_64_with_debt_both_states"]=len(comparable)
    out["comparable_64_hf_increased_count"]=sum(y>x for x,y in comparable)
    out["comparable_64_hf_decreased_count"]=sum(y<x for x,y in comparable)
    out["comparable_64_hf_unchanged_count"]=sum(y==x for x,y in comparable)
    need(len(active)+out["zero_debt_count"]==len(a) and
         len(comparable)==(out["comparable_64_hf_increased_count"]+
                           out["comparable_64_hf_decreased_count"]+
                           out["comparable_64_hf_unchanged_count"]),
         "risk count conservation failed")
    return out


def collect(evidence,provenance,transport_factory=None,time_provider=now_epoch):
    owners,previous_states,old_headers=source_cohort(evidence)
    out=empty_report(provenance,owners)
    out["started_at_utc"]=now_iso()
    rpc={}
    tips={}
    for name in ("drpc","publicnode"):
        try:
            rpc[name]=previous.borrow.RPC(
                name,transport_factory(name) if transport_factory else None)
            tips[name]=rpc[name].preflight() if False else None
        except Exception as exc:
            out["errors"].append({"stage":"tip","provider":name,
                                  "type":type(exc).__name__,"detail":str(exc)[:180]})
    # The Borrow RPC contract provides chainId and numbered block reads only;
    # preflight explicitly verifies chain and current tip before choosing one pin.
    for name,client in rpc.items():
        try:
            need(previous.borrow.qty(client.call("eth_chainId",[]),"chain")==1,
                 "non-Ethereum chain")
            tips[name]=previous.borrow.qty(client.call("eth_blockNumber",[]),"tip")
        except Exception as exc:
            out["errors"].append({"stage":"tip","provider":name,
                                  "type":type(exc).__name__,"detail":str(exc)[:180]})
    out["provider_tips"]=tips
    if set(tips)!={"drpc","publicnode"} or any(type(x) is not int for x in tips.values()) or \
       max(tips.values())-min(tips.values())>TIP_DRIFT_MAX:
        out["errors"].append({"stage":"anchor","detail":"source tip unavailable/divergent"})
        return out
    pinned=min(tips.values())-PIN_DEPTH
    need(pinned>=old_headers["last"]["number"],"new snapshot predates source")
    headers={}
    for name,client in rpc.items():
        try:headers[name]=client.get_header(pinned)
        except Exception as exc:
            out["errors"].append({"stage":"header","provider":name,
                                  "type":type(exc).__name__,"detail":str(exc)[:180]})
    if set(headers)!={"drpc","publicnode"} or headers["drpc"]!=headers["publicnode"]:
        out["errors"].append({"stage":"header","detail":"fresh pinned headers disagree"})
        return out
    anchor=headers["drpc"]
    out["fresh_pinned_block"]=anchor
    out["blocks_after_source_event_window"]=pinned-old_headers["last"]["number"]
    if not 0<=time_provider()-anchor["timestamp"]<=MAX_AGE_SECONDS:
        out["errors"].append({"stage":"freshness","detail":"pinned state too old/future"})
        return out

    # Execute the two independent RPC readers concurrently to preserve a
    # comparable pinned clock age; no large request burst on one provider.
    def task(name):
        client=rpc[name]
        sample={"provider":name,"status":"INCOMPLETE_CURRENT_OWNER_SOURCE",
                "accounts":[],"errors":[]}
        allowed=set(owners)
        try:
            for label in ("first","last"):
                need(client.get_header(old_headers[label]["number"])==old_headers[label],
                     "original canonical event boundary changed/reorged")
            need(client.get_header(anchor["number"])==anchor,
                 "current risk block identity changed")
            for address in owners:
                raw=client.call("eth_call",[
                    {"to":previous.POOL,"data":previous.borrow.call_data(address)},
                    {"blockHash":anchor["hash"],"requireCanonical":True}],
                    allowed_borrowers=allowed)
                sample["accounts"].append({
                    "borrower":address,
                    "account":previous.borrow.decode_account(raw),
                    "source_raw_abi_sha256":sha256(raw.lower().encode()).hexdigest(),
                    "risk_at_pinned_post_event_state_only":True,
                    "borrower_not_proof_of_actionable_trade":True})
            need(client.get_header(anchor["number"])==anchor,
                 "reorg during risk read")
            need(0<=time_provider()-anchor["timestamp"]<=MAX_AGE_SECONDS,
                 "state aged out during 83 accounts")
            need(len(sample["accounts"])==MAX_ACCOUNTS,
                 "one or more owner risk reads missing")
            sample["status"]="COMPLETE_83_OWNER_CURRENT_STATE"
        except Exception as exc:
            sample["errors"].append({"type":type(exc).__name__,
                                     "detail":str(exc).split("https://")[0][:200]})
        sample["calls_used"]=client.calls
        sample["rpc_transcript"]=client.transcript
        return sample
    with ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(task,"drpc")
        b=pool.submit(task,"publicnode")
        out["providers"]["drpc"]=a.result()
        out["providers"]["publicnode"]=b.result()
    if not all(s["status"]=="COMPLETE_83_OWNER_CURRENT_STATE"
               for s in out["providers"].values()):
        out["errors"].append({"stage":"accounts","detail":"one or both sources incomplete"})
        out["finished_at_utc"]=now_iso()
        return out
    if out["providers"]["drpc"]["accounts"]!=out["providers"]["publicnode"]["accounts"]:
        out["errors"].append({"stage":"parity","detail":"raw account data mismatched"})
        out["finished_at_utc"]=now_iso()
        return out
    complete_counts(out,owners,previous_states)
    out["finished_at_utc"]=now_iso()
    return out


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--producer-zip",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    need(args.out.is_absolute() and args.out.parent.is_dir() and
         not args.out.exists(),"fresh absolute output needed")
    report,source=authenticate_zip(args.producer_zip.read_bytes())
    result=collect(report,source)
    with args.out.open("xb") as fd:
        fd.write(canon(result))
    print(result["status"],"owners",result["verified_all_owner_accounts"],
          "new_19",result["verified_19_omitted_accounts"],
          "active_debt",result["active_debt_count"],
          "HF<1",result["hf_below_one_with_debt_count"],
          "min_HF_wad",result["min_positive_debt_hf_wad"],
          "errors",len(result["errors"]))
    return 0  # A valid negative/INCOMPLETE audit is not a trading certificate.


if __name__=="__main__":
    raise SystemExit(main())
