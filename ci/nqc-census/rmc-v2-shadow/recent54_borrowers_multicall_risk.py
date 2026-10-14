#!/usr/bin/env python3
"""NQC V2: source-frozen 54 fresh Borrow debt accounts -> ONE Multicall3 eth_call.

PR715 observed 83 real Aave Borrow events, 58 beneficiaries, and 54 debt-active
accounts. Freeze EXACTLY the previous 54 before reading a new canonical block.
At that block, all 54 must match across two public RPCs in ONE aggregate3
eth_call per provider, plus five preselected independent direct EIP-1898 controls.

NO market-wide Aave census, SVR pre-inclusion report, profitable route, gas
sponsorship, live transaction or production capture is inferred.
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
import zipfile

import public_aave_multicall3_exact9_parity as base
import prospective_recent_borrow_cohort as borrow

ORIGINAL_HEAD="c236e6305fea16086c037772ffd9fbcbee2d526d"
ORIGINAL_TREE="0999aab56170c4825e5a6ce0ad4531ec24ff06d0"
ORIGINAL_ZIP_SHA="4451facc60edba8e512699a9e637320f62e18a391bba459def0990d2a7d7826e"
ORIGINAL_RUN=38575818030
ORIGINAL_ARTIFACT=11900775541
ORIGINAL_MANIFEST_MEMBERS=15
ORIGINAL_AAVE_BORROWS=83
ORIGINAL_RECIPIENTS=58
PREVIOUS_DEBT_ACTIVE=54
PREVIOUS_ZERO_DEBT=4
CHECK_INDICES=(0,1,2,27,53)
SOURCE_MULTICALL_CODE_HASH="2756d7c52baee85cacb504f6ee1df7aad6809ac8d94a4a111d76991f90d36d6e"
MAX_ARCHIVE=3_000_000
MAX_UNCOMPRESSED=20_000_000
MAX_HEAD_AGE=135
MAX_RPC_PER_SOURCE=20
NEAR_1_005=borrow.WAD*10050//10000
NEAR_1_02=borrow.WAD*10200//10000
NEAR_1_10=borrow.WAD*11000//10000
N=PREVIOUS_DEBT_ACTIVE
SUITABLE=b""
WORD=base.WORD_SIZE

class Rejected(ValueError):
    pass


def need(cond,why):
    if not cond:raise Rejected(why)


def canon(obj):
    return base.canon(obj)


def strict(raw):
    return base.strict_json(raw)


def now():
    return {"utc_ns":time.time_ns(),"monotonic_ns":time.monotonic_ns()}


def authenticate_old_source(blob):
    need(type(blob) is bytes and 0<len(blob)<=MAX_ARCHIVE and
         sha256(blob).hexdigest()==ORIGINAL_ZIP_SHA,
         "original PR715 immutable Borrow artifact SHA256 changed")
    with zipfile.ZipFile(BytesIO(blob)) as z:
        meta=z.infolist()
        names=[f.filename for f in meta if not f.is_dir()]
        need(len(meta)==len(names)==len(set(names))==
             ORIGINAL_MANIFEST_MEMBERS+1 and
             sum(f.file_size for f in meta)<=MAX_UNCOMPRESSED,
             "original source ZIP duplicates, inflated or missing")
        for item in meta:
            p=PurePosixPath(item.filename)
            need(item.filename==str(p) and not p.is_absolute() and
                 ".." not in p.parts and "\\" not in item.filename and
                 not stat.S_ISLNK(item.external_attr>>16) and
                 item.file_size<=10_000_000,
                 "unsafe archived member or symlink")
        need({"manifest.sha256","code-commit.txt","code-tree.txt",
              "recent-borrower-state.json"}<=set(names),
             "missing original canonical source")
        need(z.read("code-commit.txt").decode().strip()==ORIGINAL_HEAD and
             z.read("code-tree.txt").decode().strip()==ORIGINAL_TREE,
             "old producer code/tree drift")
        hashes={}
        for entry in z.read("manifest.sha256").decode().splitlines():
            m=re.fullmatch(r"([0-9a-f]{64})  \./([A-Za-z0-9._/-]+)",entry)
            need(m is not None and m.group(2) not in hashes,
                 "bad duplicate original manifest digest")
            hashes[m.group(2)]=m.group(1)
        need(len(hashes)==ORIGINAL_MANIFEST_MEMBERS and
             set(hashes)==set(names)-{"manifest.sha256"},
             "old source manifest not exhaustive")
        for filename,expected in hashes.items():
            need(sha256(z.read(filename)).hexdigest()==expected,
                 "old source member hash mismatch "+filename)
        source=strict(z.read("recent-borrower-state.json"))

    need(type(source) is dict and
         source.get("status")=="TWO_URL_RECENT_BORROW_COHORT_STATE_ONLY_NOT_P2" and
         source.get("chain_id")==1 and
         source.get("borrow_event_topic0")==borrow.BORROW_TOPIC and
         source.get("recent_borrow_event_count_quorum")==ORIGINAL_AAVE_BORROWS and
         source.get("recent_borrower_count_quorum")==ORIGINAL_RECIPIENTS and
         source.get("selected_recent_borrower_count_quorum")==ORIGINAL_RECIPIENTS and
         source.get("source_verified_debt_active_count")==PREVIOUS_DEBT_ACTIVE and
         source.get("source_verified_no_debt_count")==PREVIOUS_ZERO_DEBT and
         source.get("source_verified_hf_lt_one_count")==0 and
         source.get("borrower_accounts_exact_two_url_parity") is True and
         source.get("errors")==[] and
         source.get("anchor",{}).get("first_block")==26190783 and
         source.get("anchor",{}).get("last_block")==26191166 and
         source.get("anchor",{}).get("inclusive_blocks")==384 and
         source.get("prospective_observation_after_borrow_inclusion_not_before") is True and
         source.get("selection_is_recent_borrow_not_all_outstanding_positions") is True,
         "PR715 no longer source-complete for bounded Borrow sample")
    for field in ("commercial_score_upgrade","RMC_closed",
                  "canary_live_authorized","competitive_capture_probability_calibrated",
                  "nonrecourse_sponsor_for_own_capital_zero_certified",
                  "shadow_P2_certified","route_feasibility_proven"):
        need(source.get(field) is False,
             "source historic Borrow report falsely upgraded commerce")
    need(source.get("nqc_realized_pnl_usd")=="0",
         "original NQC source claim had nonzero income")
    sources=source.get("source_reports")
    states=source.get("state_reports")
    need(type(sources) is dict and type(states) is dict and
         set(sources)==set(states)=={"drpc","publicnode"},
         "source not exactly two canonical public URLs")
    for provider in sources:
        r=sources[provider]
        need(r.get("status")=="COMPLETE_CANONICAL_BORROW_EVENT_SOURCE" and
             r.get("errors")==[] and r.get("shards_complete")==16 and
             r.get("event_blocks_checked")==72 and
             len(r.get("events",[]))==ORIGINAL_AAVE_BORROWS and
             len(r.get("positive_receipt_controls",[]))==2 and
             states[provider].get("status")=="COMPLETE_STATE" and
             len(states[provider].get("accounts",[]))==ORIGINAL_RECIPIENTS,
             "original complete Borrow log/header/source account ledger changed")
    need(sources["drpc"]["events"]==sources["publicnode"]["events"] and
         states["drpc"]["accounts"]==states["publicnode"]["accounts"],
         "old dual-URL original Borrow source byte-parity disappeared")
    fixed=source.get("selected_source_cohort")
    rows=states["drpc"]["accounts"]
    need(type(fixed) is list and len(fixed)==ORIGINAL_RECIPIENTS and
         [x["borrower"] for x in fixed]==[x["borrower"] for x in rows] and
         source.get("truncation",{}).get("excess_distinct_receivers_not_reconstructed")==0,
         "PR715 old beneficiary selection drift")
    selected=[]
    for original,row in zip(fixed,rows):
        need(original.get("hindsight_liquidator_selection_used") is False and
             original.get("beneficiary_identity_from_indexed_topic_2") is True and
             original.get("borrower")==row["borrower"] and
             row.get("source_account_raw_sha256") and
             row.get("inclusion_after_latest_borrow_block") is True and
             row.get("route_execution_proven") is False,
             "old Borrow beneficiary source wrongly selected")
        risk=row["risk"]
        debt=int(risk["total_debt_base_raw"])
        if debt>0:
            need(int(risk["health_factor_wad"])>0 and
                 int(risk["health_factor_wad"])>=borrow.WAD,
                 "old borrower risk not healthy/valid when selected")
            selected.append({
                "borrower":row["borrower"],
                "source_old_HF_wad":risk["health_factor_wad"],
                "source_old_total_debt_base_raw":risk["total_debt_base_raw"],
                "source_old_account_raw_sha256":row["source_account_raw_sha256"],
                "source_last_Borrow_block":original["latest_borrow_block"],
            })
    need(len(selected)==PREVIOUS_DEBT_ACTIVE and
         len({x["borrower"] for x in selected})==PREVIOUS_DEBT_ACTIVE,
         "not exactly 54 prior debt-active beneficiaries")
    selected.sort(key=lambda r:(int(r["source_old_HF_wad"]),r["borrower"]))
    return selected,{
        "producer_pr715_sha256":ORIGINAL_ZIP_SHA,
        "producer_commit":ORIGINAL_HEAD,
        "producer_tree":ORIGINAL_TREE,
        "producer_run":ORIGINAL_RUN,
        "producer_artifact_id":ORIGINAL_ARTIFACT,
        "producer_manifest_verified":ORIGINAL_MANIFEST_MEMBERS,
        "original_Borrow_beneficiaries":ORIGINAL_RECIPIENTS,
        "original_debt_positive_accounts":PREVIOUS_DEBT_ACTIVE,
        "source_rule_all_54_prior_debt_active_before_current_RPC":True,
        "not_exhaustive_Aave_position_census":True,
    }


def encode_calls_54(owners):
    need(type(owners) is list and len(owners)==N and
         len(set(owners))==N and
         all(type(x) is str and re.fullmatch(r"0x[0-9a-f]{40}",x)
             for x in owners),
         "full 54 frozen borrowers required; never trim")
    tuples=[]
    for address in owners:
        call=bytes.fromhex(borrow.call_data(address)[2:])
        need(len(call)==36,"wrong Aave getUserAccountData ABI")
        tuples.append(
            base.u256(int(borrow.POOL,16))+base.u256(0)+base.u256(96)+
            base.u256(36)+call.ljust(64,b"\x00"))
    need(all(len(t)==base.CALL3_ELEMENT_SIZE for t in tuples),
         "Aave Call3 tuple ABI shape unsupported")
    offsets=b"".join(
        base.u256(N*WORD+i*base.CALL3_ELEMENT_SIZE) for i in range(N))
    raw=(bytes.fromhex(base.AGGREGATE3_SELECTOR[2:])+
         base.u256(32)+base.u256(N)+offsets+b"".join(tuples))
    need(len(raw)<15_000,"over-budget Multicall3 calldata")
    return "0x"+raw.hex()


def decode_result54(result):
    need(type(result) is str and base.HEXBIN.fullmatch(result),
         "invalid Multicall3 EIP-1898 result payload")
    raw=bytes.fromhex(result[2:])
    need(len(raw)==64+N*WORD+N*base.RESULT3_ELEMENT_SIZE and
         base.read_word(raw,0)==32 and
         base.read_word(raw,32)==N,
         "source aggregate3 return bytes truncated or misaligned")
    output=[]
    for i in range(N):
        offset=base.read_word(raw,64+i*WORD)
        need(offset==N*WORD+i*base.RESULT3_ELEMENT_SIZE,
             "aggregate3 result reordering/duplicate/noncanonical offset")
        start=64+offset
        need(base.read_word(raw,start)==1 and
             base.read_word(raw,start+32)==64 and
             base.read_word(raw,start+64)==192,
             "one Aave user account return missing or failed")
        payload=raw[start+96:start+288]
        need(len(payload)==192,"unexpected Aave six-word output length")
        buf="0x"+payload.hex()
        borrow.decode_account(buf)
        output.append(buf)
    need(len(output)==N,"all 54 returns required")
    return output


def collect(cohort,provenance,out,transport_factory=None,now_fn=now):
    need(isinstance(out,Path) and out.is_absolute() and out.is_dir() and
         not list(out.iterdir()),"fresh absolute empty output needed")
    result={
        "schema_version":1,
        "status":"INCOMPLETE_54_BORROWERS_MULTICALL_NOT_AAVE_MARKET_ZERO",
        "source":provenance,"precommit":None,
        "canonical_observed_mainnet_block":None,
        "multicall3_deployed_code_sha256":None,
        "selected_source_before_new_RPC_count":len(cohort),
        "direct_control_preselected_account_indices":list(CHECK_INDICES),
        "full_fiftyfour_EIP1898_source_parity":False,
        "errors":[],"per_provider_rpc_calls":None,
        "one_mainnet_Multicall3_eth_call_per_source":False,
        "eth_call_is_readonly_even_if_multicall_contract_not_view":True,
        "not_preinclusion_or_private_SVR_feed":True,
        "builder_inclusion_and_captured_opportunities_proven":False,
        "profit_route_or_flash_gas_quote_proven":False,
        "commercial_score_upgrade":False,
        "RMC_closed":False,"P2_shadow_certified":False,
        "canary_live_authorized":False,
        "OWN_CAPITAL_ZERO_INCLUDING_GAS_UNCHANGED":True,
        "user_mxn2000_spent":False,"nqc_realized_pnl_usd":"0",
    }
    frozen={
        "source":provenance,
        "selected_prior_debt_positive_accounts":cohort,
        "control_indices_before_new_HF":list(CHECK_INDICES),
        "committed_before_current_Ethereum_rpc":now_fn(),
        "historical_winner_and_current_profit_selection_not_used":True,
    }
    target=out/"54-cohort-committed-before-rpc.json"
    target.write_bytes(canon(frozen))
    result["precommit"]={
        "file":target.name,
        "sha256":sha256(target.read_bytes()).hexdigest(),
        "committed_utc_ns":frozen["committed_before_current_Ethereum_rpc"]["utc_ns"],
    }
    rpc={}
    try:
        need(len(cohort)==N,"53 or 55 accounts must not masquerade as full 54")
        for provider in ("drpc","publicnode"):
            transport=transport_factory(provider) if transport_factory else None
            rpc[provider]=base.AllowlistedRPC(provider,transport)
        tips={name:client.tip() for name,client in rpc.items()}
        result["source_public_tips"]=tips
        need(abs(tips["drpc"]-tips["publicnode"])<=3,"Ethereum sources tip divergence")
        height=min(tips.values())-2
        heads={name:client.header(height) for name,client in rpc.items()}
        need(heads["drpc"]==heads["publicnode"],
             "canonical header/hash/stateRoot mismatch")
        head=heads["drpc"]
        result["canonical_observed_mainnet_block"]=head
        need(0<=now_fn()["utc_ns"]//1_000_000_000-head["timestamp"]<=MAX_HEAD_AGE,
             "initial mainnet block too stale")
        owners=[x["borrower"] for x in cohort]
        calldata=encode_calls_54(owners)
        permitted=set(borrow.call_data(o) for o in owners)
        for client in rpc.values():
            client.allowed_multicall_calldata=calldata
            client.allowed_source_accounts=permitted
        source_code={}
        for provider,client in rpc.items():
            code=client.call("eth_getCode",[
                base.MULTICALL3,{"blockHash":head["hash"],"requireCanonical":True}])
            need(type(code) is str and base.HEXBIN.fullmatch(code) and
                 len(code[2:])//2==3808 and
                 sha256(bytes.fromhex(code[2:])).hexdigest()==SOURCE_MULTICALL_CODE_HASH,
                 "Multicall3 runtime not exact prior source-verified Ethereum code")
            source_code[provider]=code.lower()
        need(source_code["drpc"]==source_code["publicnode"],
             "two providers disagree on Multicall3 runtime bytes")
        result["multicall3_deployed_code_sha256"]=SOURCE_MULTICALL_CODE_HASH
        result["multicall3_calldata_sha256"]=sha256(
            bytes.fromhex(calldata[2:])).hexdigest()
        before=now_fn()
        def read_batch(provider):
            return rpc[provider].call("eth_call",[
                {"to":base.MULTICALL3,"data":calldata},
                {"blockHash":head["hash"],"requireCanonical":True}])
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies=list(pool.map(read_batch,("drpc","publicnode")))
        got={p:decode_result54(response) for p,response in
             zip(("drpc","publicnode"),replies)}
        ended=now_fn()
        need(got["drpc"]==got["publicnode"] and
             len(got["drpc"])==N,
             "not all 54 Aave raw ABI results have dual-source parity")
        result["batch_elapsed_monotonic_ns"]=(ended["monotonic_ns"]-
                                               before["monotonic_ns"])
        need(0<=result["batch_elapsed_monotonic_ns"]<=45_000_000_000,
             "slow/invalid same-state 54-account batch completion")
        controls={}
        def read_controls(provider):
            client=rpc[provider]
            values=[]
            for i in CHECK_INDICES:
                raw=client.call("eth_call",[
                    {"to":borrow.POOL,
                     "data":borrow.call_data(owners[i])},
                    {"blockHash":head["hash"],"requireCanonical":True}])
                need(type(raw) is str and raw.lower()==got[provider][i],
                     "fixed individual Aave control does not match Multicall3")
                values.append({
                    "source_original_index":i,"borrower":owners[i],
                    "matching_abi_sha256":sha256(bytes.fromhex(raw[2:])).hexdigest(),
                })
            return values
        with ThreadPoolExecutor(max_workers=2) as pool:
            rows=list(pool.map(read_controls,("drpc","publicnode")))
        controls=dict(zip(("drpc","publicnode"),rows))
        need(controls["drpc"]==controls["publicnode"],
             "individual control ABI hashes not identical across URLs")
        final={p:c.header(height) for p,c in rpc.items()}
        need(final["drpc"]==final["publicnode"]==head,
             "block no longer canonical after 54-account source read")
        need(0<=now_fn()["utc_ns"]//1_000_000_000-head["timestamp"]<=MAX_HEAD_AGE,
             "source block became stale before final report")
        items=[]
        for entry,raw in zip(cohort,got["drpc"]):
            items.append({
                "borrower":entry["borrower"],
                "source_old_HF_wad":entry["source_old_HF_wad"],
                "source_old_total_debt_base_raw":entry["source_old_total_debt_base_raw"],
                "new_canonical_risk":borrow.decode_account(raw),
                "new_exact_six_word_ABI_sha256":sha256(
                    bytes.fromhex(raw[2:])).hexdigest(),
            })
        positive=[r for r in items
                  if int(r["new_canonical_risk"]["total_debt_base_raw"])>0]
        need(len(positive)<=N,"impossible active debt count")
        result["full_fiftyfour_EIP1898_source_parity"]=True
        result["one_mainnet_Multicall3_eth_call_per_source"]=True
        result["all_fiftyfour_original_borrowers"]=items
        result["original_five_direct_controls"]=controls
        result["new_active_debt_count"]=len(positive)
        result["new_no_debt_count"]=N-len(positive)
        result["new_HF_below_one_count"]=sum(
            0<int(r["new_canonical_risk"]["health_factor_wad"])<borrow.WAD
            for r in positive)
        result["new_HF_1_to_1_02_count"]=sum(
            borrow.WAD<=int(r["new_canonical_risk"]["health_factor_wad"])<=NEAR_1_02
            for r in positive)
        result["new_HF_1_02_to_1_10_count"]=sum(
            NEAR_1_02<int(r["new_canonical_risk"]["health_factor_wad"])<=NEAR_1_10
            for r in positive)
        result["lowest_positive_debt_HF_wad"]=(
            min(int(r["new_canonical_risk"]["health_factor_wad"])
                for r in positive) if positive else None)
        result["per_provider_rpc_calls"]={p:c.calls for p,c in rpc.items()}
        need(all(c.calls<=MAX_RPC_PER_SOURCE for c in rpc.values()),
             "per-source read-only budget exhausted")
        result["status"]="FIFTYFOUR_PRIOR_DEBT_BORROWERS_MULTICALL_QUORUM_NO_P2"
    except Exception as exc:
        result["errors"].append({
            "type":type(exc).__name__,"detail":str(exc).split("https://")[0][:230]})
    result["rpc_source_transcripts"]={p:c.transcript for p,c in rpc.items()}
    result["finished"]=now_fn()
    (out/"recent54-active-debt-borrowers-risk.json").write_bytes(canon(result))
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--original-pr715-zip",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    need(a.out.is_absolute() and a.out.parent.is_dir() and not a.out.exists(),
         "fresh output path required")
    cohort,source=authenticate_old_source(a.original_pr715_zip.read_bytes())
    a.out.mkdir()
    doc=collect(cohort,source,a.out)
    print(doc["status"],"active",doc.get("new_active_debt_count"),
          "HF_lt_one",doc.get("new_HF_below_one_count"),
          "batch_elapsed_ns",doc.get("batch_elapsed_monotonic_ns"),
          "errors",doc["errors"])
    return 0 # INCOMPLETE remains censored, never market-wide absence.

if __name__=="__main__":
    raise SystemExit(main())
