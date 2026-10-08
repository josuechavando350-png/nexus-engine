#!/usr/bin/env python3
"""Source-locked aggregation of four REAL native protocol families from TWO existing audits.

The two independent source validators have already checked original D08/D09
capital imports and original D11 Balancer/UniV3 multi-provider capture bytes.
This producer only authenticates and joins their immutable reports, preserving
per-family evidence. No RPC, gas funding, execution, expected P&L or D11 closeout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
from zipfile import ZipFile

REPO="josuechavando350-png/nexus-engine"
SOURCE_LOCK="c1b9f136a13f220af9dceaae50e5caa3105121eb"
PROVIDER_LOCK="a9c1427bb05828d08ade537899ee1b8e43b97ed2"
FINAL_LOCK="b1182b27b0ff3856b17a6f829ac3c693eab74400"
D08_RUN=37836967374
D08_HEAD="fdf0ecd08bf17bd5812c92371f17c5f1f69b7f8f"
D08_ARTIFACT=11576077535
D08_NAME=f"rmc011-original-d08-native-flash-source-import-{D08_HEAD}"
D08_ZIP="96fa8894c17722c29ff763d302b57f8db9c24b44bdd3b1c7b789dd530a833bd2"
D08_REPORT="34d3ee012d5649e90522509c6e23babcae8297bdf8d9995c0188191e6159b5e4"
D08_WORKFLOW="NQC RMC-011 Original D08 D09 Full Native Flash Import (NOT D11 CLOSE)"
DUAL_RUN=37839036277
DUAL_HEAD="2b0c5ed1d7ca8def40f25d3f14674a61f9f6f485"
DUAL_ARTIFACT=11577315781
DUAL_NAME=f"rmc011-original-native-dual-source-{DUAL_HEAD}"
DUAL_ZIP="6019f244e80dfb157939b47e43fc8d3c48f432a61ea127237f0e4ae37a67f2c5"
DUAL_REPORT="275e3e84eb053f8df9f85c873347e99167fd3ad94801bf0ce6bcbbc0cd3a5886"
DUAL_WORKFLOW="NQC RMC-011 Original Native Dual Provider Audit (NOT D11 CLOSE)"
D08_ORIGINAL_MANIFEST_SHA="1276491d349176fdd0ac63aaaa2c326c002c1a17384ba1e6db4704687842a279"
PINNED_BLOCK=26095351
FAMILIES={
    "AAVE_V3_FLASH_LOAN":("d08",67,"RMC008_AAVE_V3"),
    "UNISWAP_V2_FLASH_SWAP":("d08",1045392,"RMC008_UNISWAP_V2"),
    "BALANCER_V2_FLASH_LOAN":("dual",67,"nqc-census/crates/nqc-census-capital/src/balancer_live.rs"),
    "UNISWAP_V3_FLASH":("dual",69748,"nqc-census/crates/nqc-census-capital/src/permissionless_atomic.rs"),
}
HEXDIG=re.compile(r"[a-f0-9]{64}\Z")
HEADID=re.compile(r"[a-f0-9]{40}\Z")


def need(value,reason):
    if not value: raise ValueError(reason)


def hash_bytes(raw):
    return hashlib.sha256(raw).hexdigest()


def git_blob(raw):
    return hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest()


def canonical(obj):
    return (json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def load(raw):
    def unique(pairs):
        out={}
        for k,v in pairs:
            need(k not in out,"duplicate source JSON field")
            out[k]=v
        return out
    val=json.loads(raw,object_pairs_hook=unique)
    need(type(val) is dict,"source JSON must be object")
    return val


def check_run_and_artifact(run,artifact,role):
    id_,head,aid,name,digest,workflow=(
        (D08_RUN,D08_HEAD,D08_ARTIFACT,D08_NAME,D08_ZIP,D08_WORKFLOW)
        if role=="d08" else
        (DUAL_RUN,DUAL_HEAD,DUAL_ARTIFACT,DUAL_NAME,DUAL_ZIP,DUAL_WORKFLOW)
    )
    need(type(run) is dict and type(run.get("id")) is int and run["id"]==id_
         and run.get("head_sha")==head and run.get("status")=="completed"
         and run.get("conclusion")=="success" and run.get("name")==workflow,
         role+": original independent source workflow not successfully authenticated")
    need(type(artifact) is dict and type(artifact.get("id")) is int
         and artifact["id"]==aid and artifact.get("expired") is False
         and artifact.get("name")==name and artifact.get("digest")=="sha256:"+digest
         and type(artifact.get("workflow_run")) is dict
         and artifact["workflow_run"].get("id")==id_
         and artifact["workflow_run"].get("head_sha")==head,
         role+": original independent source artifact/head/bytes mismatch")


def exact_report(zip_path,role):
    name,expected_zip,report_name,expected_report=(
        ("d08",D08_ZIP,"native-d08-source-report.json",D08_REPORT)
        if role=="d08" else
        ("dual",DUAL_ZIP,"native-source-report.json",DUAL_REPORT)
    )
    raw=Path(zip_path).read_bytes()
    need(0<len(raw)<35_000 and hash_bytes(raw)==expected_zip,
         role+": immutable original audit ZIP digest differs")
    with ZipFile(Path(zip_path)) as z:
        names=z.namelist()
        need(0<len(names)<=8 and len(names)==len(set(names))
             and report_name in names and
             all(".." not in n.split("/") and not n.startswith("/") for n in names),
             role+": malformed independent source ZIP member set")
        b=z.read(report_name)
    need(hash_bytes(b)==expected_report,role+": actual report member SHA256 differs")
    report=load(b)
    expected_self=report.get("report_sha256")
    need(type(expected_self) is str and HEXDIG.fullmatch(expected_self)
         and hash_bytes(canonical({k:v for k,v in report.items()
                                   if k!="report_sha256"}))==expected_self,
         role+": original independent report self-commitment differs")
    return report


def validate_sources(d08,dual,universe,providers,final):
    need(git_blob(universe)==SOURCE_LOCK,"9/13 canonical family source lock drifted")
    need(git_blob(providers)==PROVIDER_LOCK,"zero-authorized-gas provider registry drifted")
    need(git_blob(final)==FINAL_LOCK,"blocked final Census lock drifted")
    u=load(universe)
    p=load(providers)
    f=load(final)
    need(u.get("stage")=="RMC-011" and u.get("status")=="BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
         and u.get("d11_terminal_closed") is False
         and u.get("terminal_claim_allowed") is False
         and u.get("family_universe_discovery",{}).get("status")=="NOT_CERTIFIED"
         and len(u.get("families",[]))==13
         and {v["id"] for v in u["families"] if v.get("terminally_resolved") is False}==
             set(FAMILIES),
         "four-family evidence must not self-certify D11 source universe")
    need(p.get("provider_count")==0 and p.get("providers")==[]
         and f.get("status")=="BLOCKED" and f.get("pinned_stages")==[]
         and f.get("real_market_census_closed") is False,
         "native gas or stage terminal authority incorrectly promoted")

    need(d08.get("status")==
         "RMC011_ORIGINAL_D08_AAVE_V3_AND_UNISWAP_V2_SOURCE_IMPORT_REPLAY_ONLY"
         and d08.get("producer_code_head")==D08_HEAD
         and d08.get("source_universe_blob")==SOURCE_LOCK
         and d08.get("d08_source_count")==1045459
         and d08.get("d08_source_classes")=={
             "PROTOCOL_NATIVE_FLASH_LOAN":67,
             "FLASH_SWAP":1045392}
         and d08.get("d08_import_deterministically_replay_verified") is True
         and d08.get("d11_terminal_closed") is False
         and d08.get("census_closed") is False
         and d08.get("external_nqc_native_gas_sponsors_approved")==0
         and d08.get("nqc_realized_pnl_usd_wad")=="0"
         and d08.get("native_source_universe_family_authentication_pinned") is False,
         "D08 historic source evidence claiming executable capital or D11")
    original_stages=d08.get("original_upstream_stage_identities")
    need(type(original_stages) is list and len(original_stages)==5
         and [x.get("key") for x in original_stages]==["d06","d07","d08","d09","d10"],
         "five historical source authority identities not retained")
    d08_source=original_stages[2]
    need(d08_source.get("authority_sha256")==D08_ORIGINAL_MANIFEST_SHA
         and d08_source.get("artifact_sha256")==
             "9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913",
         "original RMC008 admission anchor/digest differ")

    need(dual.get("status")==
         "RMC011_ORIGINAL_DUAL_PROVIDER_NATIVE_FLASH_OBSERVED_ZERO_EXECUTABLE_NOT_D11"
         and dual.get("original_artifact_zip_sha256")==
             "a0ab50b41f5653e7749dc7360eb8006f3f088477372654ade9d966b3373f006f"
         and dual.get("original_workflow_conclusion")=="failure"
         and dual.get("original_acquisition_job_conclusion")=="success"
         and dual.get("original_internal_sha256_manifest_entries")==30030
         and dual.get("original_d08_manifest_sha256")==D08_ORIGINAL_MANIFEST_SHA
         and dual.get("original_observation_anchor",{}).get("block_number")==PINNED_BLOCK
         and dual.get("total_native_historical_sources")==69815
         and dual.get("historical_sources_recorded_execution_eligible")==0
         and dual.get("historical_sources_recorded_executable_capital")==0
         and dual.get("nqc_externally_authorized_gas_sponsors")==0
         and dual.get("rmc011_terminal_closed") is False
         and dual.get("real_market_census_closed") is False
         and dual.get("nqc_realized_profit_usd_wad")=="0",
         "original dual-provider evidence overstates execution or differs from D08 authority")
    natives=dual.get("original_source_family_evidence")
    need(type(natives) is dict and set(natives)=={
        "BALANCER_V2_FLASH_LOAN","UNISWAP_V3_FLASH"},
        "original two native providers source coverage incomplete")
    for family in natives:
        item=natives[family]
        need(type(item) is dict and item.get("source_count_historical")==FAMILIES[family][1]
             and item.get("currently_execution_eligible_count")==0
             and item.get("positive_executable_capital_sources")==0
             and item.get("source_id_unique_count")==FAMILIES[family][1]
             and item.get("source_key_unique_count")==FAMILIES[family][1]
             and type(item.get("reconciled_rust_sha256")) is str
             and HEXDIG.fullmatch(item["reconciled_rust_sha256"]),
             family+": original independent dual source records not verified")
    return d08_source


def make_package(*,source1,source2,run1,art1,run2,art2,
                 universe,providers,final,head,tree,run_id,attempt):
    need(type(head) is str and HEADID.fullmatch(head)
         and type(tree) is str and HEADID.fullmatch(tree)
         and type(run_id) is int and run_id>0
         and type(attempt) is int and attempt>0,
         "invalid current evidence producing commit/head/tree/run identity")
    check_run_and_artifact(run1,art1,"d08")
    check_run_and_artifact(run2,art2,"dual")
    d08_source=validate_sources(source1,source2,universe,providers,final)
    family_hashes={}
    family_bytes={}
    for family in sorted(FAMILIES):
        role,count,source_path=FAMILIES[family]
        provenance=(
          {"run_id":D08_RUN,"head_sha":D08_HEAD,"artifact_id":D08_ARTIFACT,
           "artifact_zip_sha256":D08_ZIP,"raw_report_sha256":D08_REPORT}
          if role=="d08" else
          {"run_id":DUAL_RUN,"head_sha":DUAL_HEAD,"artifact_id":DUAL_ARTIFACT,
           "artifact_zip_sha256":DUAL_ZIP,"raw_report_sha256":DUAL_REPORT}
        )
        record={
          "schema_version":1,"stage":"RMC-011",
          "kind":"AUTHENTICATED_REAL_SOURCE",
          "status":"HISTORICALLY_OBSERVED_PROTOCOL_SOURCE_NOT_EXECUTION_FINANCING",
          "family":family,
          "canonical_source_path":source_path,
          "source_scope":"FROZEN_D08_OR_D11_NATIVE_PROTOCOL_SOURCE_ONLY",
          "original_historical_source_count":count,
          "original_d08_authority_sha256":D08_ORIGINAL_MANIFEST_SHA,
          "original_observation_block_number":PINNED_BLOCK,
          "source_independent_audit":provenance,
          "source_execution_eligible_count":(
            0 if role=="dual" else None),
          "source_execution_eligibility_not_yet_reconstructed":role=="d08",
          "two_distinct_rpc_operators_verified":role=="dual",
          "original_native_gas_external_sponsor_count":0,
          "nqc_capital_or_profit_positive_claimed":False,
          "global_source_nonexistence_claimed":False,
          "terminal_d11_closed":False,
          "workflow_name":os.environ["GITHUB_WORKFLOW"],
          "head_sha":head,"code_tree":tree,"run_id":run_id,"run_attempt":attempt,
        }
        file=f"protocol-family-evidence/families/{family}/evidence.json"
        b=canonical(record)
        family_bytes[file]=b
        family_hashes[family]=hash_bytes(b)
    summary={
       "schema_version":1,
       "status":"RMC011_FOUR_ORIGINAL_NATIVE_SOURCE_EVIDENCE_READY_NOT_TERMINAL",
       "source_repository":REPO,
       "code_commit":head,"code_tree":tree,"run_id":run_id,"run_attempt":attempt,
       "source_universe_git_blob":SOURCE_LOCK,
       "original_two_independent_auditors":{
          "d08":{"run":D08_RUN,"artifact":D08_ARTIFACT,"report_sha256":D08_REPORT},
          "dual":{"run":DUAL_RUN,"artifact":DUAL_ARTIFACT,"report_sha256":DUAL_REPORT},
       },
       "original_d08_manifest_sha256":D08_ORIGINAL_MANIFEST_SHA,
       "source_family_count":4,
       "source_families":{family:{"historically_observed_count":FAMILIES[family][1],
                                  "evidence_member_sha256":family_hashes[family]}
                          for family in sorted(FAMILIES)},
       "original_balancer_and_univ3_execution_eligible_sources":0,
       "original_d08_aave_and_univ2_execution_eligibility_certified_here":False,
       "external_native_eth_gas_sponsors_admitted":0,
       "all_native_families_terminally_source_pinned_here":False,
       "family_universe_discovery_closed":False,
       "rmc011_terminal_closed":False,"real_market_census_closed":False,
       "global_protocol_source_nonexistence_claimed":False,
       "nqc_realized_net_usd_wad":"0",
    }
    summary["report_sha256"]=hash_bytes(canonical(summary))
    family_bytes["four-native-source-summary.json"]=canonical(summary)
    return family_bytes,summary


def main():
    cli=argparse.ArgumentParser()
    for x in ("d08-zip","d08-run","d08-artifact","dual-zip","dual-run",
              "dual-artifact","out","head","tree","run-id","run-attempt"):
        if x in {"d08-zip","d08-run","d08-artifact","dual-zip","dual-run",
                 "dual-artifact","out"}:
            cli.add_argument("--"+x,required=True,type=Path)
        elif x in {"run-id","run-attempt"}:
            cli.add_argument("--"+x,required=True,type=int)
        else:
            cli.add_argument("--"+x,required=True)
    args=cli.parse_args()
    need(not args.out.exists(),"append-only source evidence destination")
    need(os.environ.get("GITHUB_REPOSITORY")==REPO,
         "source producer must be canonical Nexus repository")
    run1=load(args.d08_run.read_bytes())
    art1=load(args.d08_artifact.read_bytes())
    run2=load(args.dual_run.read_bytes())
    art2=load(args.dual_artifact.read_bytes())
    d08=exact_report(args.d08_zip,"d08")
    dual=exact_report(args.dual_zip,"dual")
    files,summary=make_package(
        source1=d08,source2=dual,run1=run1,art1=art1,run2=run2,art2=art2,
        universe=Path("ci/nqc-census/rmc011-capital-source-universe.json").read_bytes(),
        providers=Path("ci/nqc-census/rmc011-external-capital-provider-registry.json").read_bytes(),
        final=Path("ci/nqc-census/final-census-authority-lock.json").read_bytes(),
        head=args.head,tree=args.tree,run_id=args.run_id,attempt=args.run_attempt,
    )
    args.out.mkdir(parents=True)
    for path,raw in files.items():
        f=args.out/path
        f.parent.mkdir(parents=True,exist_ok=True)
        f.write_bytes(raw)
    (args.out/"SHA256SUMS").write_text(
        "".join(f"{hash_bytes(raw)}  {path}\n"
                for path,raw in sorted(files.items())))
    print(summary["status"],
          "4_SOURCE_FAMILIES_WITH_ORIGINAL_PROVENANCE GAS=0 D11_CLOSED=false")


if __name__=="__main__":
    main()
