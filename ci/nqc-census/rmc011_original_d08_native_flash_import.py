#!/usr/bin/env python3
"""RMC011 source-only attempt: replay genuine complete D08/D09 via locked Rust.

Verifies original D08/D09 GitHub ZIP bytes and the independently source-checked
original D06..D10 authority supplied by #661/#662. The Rust production importer
(not this Python analyzer) classifies Aave V3 and Uniswap V2 capital sources.

No external RPC, source registration, gas, new provider, shadow trade or
positive NQC actionable net-PnL claims. Fail closed on OOM/missing originals.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from zipfile import ZipFile

import rmc011_original_d08_debt_producer as origin

REPO="josuechavando350-png/nexus-engine"
SOURCE_UNIVERSE_BLOB="c1b9f136a13f220af9dceaae50e5caa3105121eb"
INPUT_BLOB="1db0bbd78af36ee61dd6a44630a3b6614f3e9309"
PROVIDER_BLOB="a9c1427bb05828d08ade537899ee1b8e43b97ed2"
FINAL_BLOB="b1182b27b0ff3856b17a6f829ac3c693eab74400"
PRODUCER_RUN=37832286518
PRODUCER_HEAD="5b79e7be1c185cbb4924d592991b9c990fc0465a"
PRODUCER_ARTIFACT=11573678487
PRODUCER_ZIP="151847cdf85b1b49298d59b41d1bf939f6854d4556060a03ab7dd5a2e1359916"
PRODUCER_WORKFLOW="NQC RMC-011 Original D08 Debt Family Rejection Evidence (NO D11 CLOSE)"
D08_FLASH_FAMILIES=("AAVE_V3_FLASH_LOAN","UNISWAP_V2_FLASH_SWAP")
OTHER_NATIVE=("BALANCER_V2_FLASH_LOAN","UNISWAP_V3_FLASH")
HEX40=re.compile(r"[0-9a-f]{40}\Z")
HEX64=re.compile(r"[0-9a-f]{64}\Z")


def need(ok,why):
    if not ok:raise ValueError(why)


def canonical(obj):
    return (json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def original_source_catalog():
    d=origin.verified_source(
        origin.ROOT/"rmc011-real-source-inputs.json",INPUT_BLOB
    )
    c=origin.verified_source(
        origin.ROOT/"rmc011-capital-source-universe.json",SOURCE_UNIVERSE_BLOB
    )
    registry=origin.verified_source(
        origin.ROOT/"rmc011-external-capital-provider-registry.json",PROVIDER_BLOB
    )
    final=origin.verified_source(
        origin.ROOT/"final-census-authority-lock.json",FINAL_BLOB
    )
    need(d.get("schema_version")==3 and d.get("repository")==REPO
         and set(d)=={"schema_version","repository",*origin.STAGES},
         "original exact D06-D10 input source missing")
    families=c.get("families")
    need(type(families) is list and len(families)==13
         and c.get("status")=="BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
         and c.get("terminal_claim_allowed") is False
         and c.get("d11_terminal_closed") is False
         and c.get("family_universe_discovery",{}).get("status")=="NOT_CERTIFIED"
         and sum(row.get("terminally_resolved") is True for row in families)==9
         and {row["id"] for row in families if row["terminally_resolved"] is False}
             ==set(D08_FLASH_FAMILIES)|set(OTHER_NATIVE),
         "current 9/13 partial RMC011 admission contract drifted")
    need(registry.get("provider_count")==0
         and registry.get("providers")==[]
         and final.get("status")=="BLOCKED"
         and final.get("real_market_census_closed") is False,
         "external gas or terminal Census authority has changed")
    return d,c


def obtain_first_stage_witness(work:Path,d:dict):
    run=origin.gh(f"repos/{REPO}/actions/runs/{PRODUCER_RUN}")
    artifact=origin.gh(f"repos/{REPO}/actions/artifacts/{PRODUCER_ARTIFACT}")
    need(run.get("id")==PRODUCER_RUN and run.get("head_sha")==PRODUCER_HEAD
         and run.get("name")==PRODUCER_WORKFLOW and run.get("conclusion")=="success"
         and run.get("status")=="completed",
         "original five-stage authority producer did not PASS")
    need(artifact.get("id")==PRODUCER_ARTIFACT
         and artifact.get("digest")=="sha256:"+PRODUCER_ZIP
         and artifact.get("expired") is False
         and artifact.get("workflow_run",{}).get("id")==PRODUCER_RUN
         and artifact.get("workflow_run",{}).get("head_sha")==PRODUCER_HEAD,
         "original five-stage witness artifact is not authenticated")
    original_zip=work/"original-five-stage-authority.zip"
    token=os.environ["GH_TOKEN"]
    subprocess.run(
        ["curl","--fail","--silent","--show-error","--location",
         "--retry","2","--max-time","90",
         "-H",f"Authorization: Bearer {token}",
         "-H","Accept: application/vnd.github+json",
         f"https://api.github.com/repos/{REPO}/actions/artifacts/{PRODUCER_ARTIFACT}/zip",
         "-o",str(original_zip)],check=True
    )
    data=original_zip.read_bytes()
    need(sha256(data)==PRODUCER_ZIP,"original source witness ZIP raw digest changed")
    with ZipFile(io.BytesIO(data)) as z:
        members=z.infolist()
        need(len(members)==4 and len({x.filename for x in members})==4,
             "original debt witness member population changed")
        report=origin.json_object(z.read("original-source-report.json"))
    digest=report.get("report_sha256")
    need(type(digest) is str
         and digest==sha256(canonical({k:v for k,v in report.items()
                                      if k!="report_sha256"})),
         "original witness report self-hash disagrees with immutable source")
    need(report.get("status")=="RMC011_ORIGINAL_D08_TWO_DEBT_REJECTIONS_AUTHENTICATED_NOT_D11"
         and report.get("source_exact_head")==PRODUCER_HEAD
         and report.get("source_universe_sha1")==origin.SOURCE_UNIVERSE_BLOB
         and report.get("source_upstream_input_sha1")==INPUT_BLOB
         and report.get("rmc011_terminal_closed") is False
         and report.get("real_market_census_closed") is False,
         "original source witness reports unapproved scope")
    upstream=report.get("five_original_upstream_stage_sources")
    need(type(upstream) is list and len(upstream)==5
         and [row.get("key") for row in upstream]==list(origin.STAGES),
         "original upstream 5-stage identities missing")
    for key,row in zip(origin.STAGES,upstream):
        src=d[key]
        need(row.get("code_commit")==src["head_sha"]
             and row.get("run_id")==src["run_id"]
             and row.get("artifact_id")==src["artifact_id"]
             and row.get("artifact_sha256")==src["artifact_digest"][7:]
             and row.get("authority_file")==src["authority_file"]
             and HEX40.fullmatch(row.get("code_tree",""))
             and HEX64.fullmatch(row.get("authority_sha256","")),
             key+": authentic original stage authority changed")
    print("RMC011_FIVE_ORIGINAL_SOURCE_IDENTITIES_READ_ONLY_REUSED",flush=True)
    return upstream


def original_d08_d09_and_lock(work:Path,d:dict,upstream:list[dict]):
    staged={}
    for key in ("d08","d09"):
        staged[key]=origin.acquire_source(key,d[key],work,os.environ["GH_TOKEN"])
        witness=upstream[list(origin.STAGES).index(key)]
        need(staged[key]["authority_sha256"]==witness["authority_sha256"] and
             staged[key]["code_tree"]==witness["code_tree"],
             key+": original observed authority SHA/tree conflicts")
    original_manifest=origin.json_object(
        (work/"d08-raw"/d["d08"]["authority_file"]).read_bytes()
    )
    anchor=original_manifest.get("observation_anchor")
    fields=("chain_id","genesis_hash","fork_lineage","block_number",
            "block_hash","parent_hash","timestamp","state_root")
    need(type(anchor) is dict and all(x in anchor for x in fields),
         "genuine D08 block identity unavailable")
    declared={
        "schema_version":1,
        "observation_anchor":{x:anchor[x] for x in fields},
        "stages":[{
            "stage":x["stage"],"code_commit":x["code_commit"],
            "code_tree":x["code_tree"],
            "artifact_sha256":"0x"+x["authority_sha256"],
        } for x in upstream],
    }
    candidate=work/"native-d08-authority-candidate.json"
    candidate.write_bytes(canonical(declared))
    lock=work/"native-d08-authority-lock.json"
    origin.command(
        str(origin.CAPITAL/"target/release/nqc-rmc011-authority-lock-build"),
        "--input",str(candidate),"--output",str(lock)
    )
    source_lock=origin.json_object(lock.read_bytes())
    need(source_lock.get("schema_version")==1 and len(source_lock.get("stages",[]))==5,
         "genuine five-stage authority could not be rebuilt")
    for key in ("d08","d09"):
        row=staged[key]
        origin.command(
            "python3",str(origin.ROOT/"verify_rmc011_upstream_authority.py"),
            "--stage",row["stage"],
            "--artifact-root",str(work/f"{key}-raw"),
            "--authority-file",row["authority_file"],
            "--lock",str(lock),
            "--expected-code-commit",row["code_commit"],
            "--expected-code-tree",row["code_tree"],
        )
    for key,files in (
        ("d08",("market_state_manifest","oracle_manifest","token_admission",
                "pool_and_factory_facts","authority_file")),
        ("d09",("account_manifest","account_summary","authority_file"))
    ):
        path=work/key
        path.mkdir(exist_ok=False)
        for field in files:
            rel=d[key][field]
            orig=work/f"{key}-raw"/rel
            need(orig.is_file(),"original "+key+" source missing: "+rel)
            shutil.copyfile(orig,path/Path(rel).name)
    print("RMC011_D08_D09_ORIGINAL_FROZEN_SOURCE_LOCK_REBUILT",flush=True)
    return lock,staged


def run_real_import(work:Path,lock:Path):
    output=work/"native-import"
    code=subprocess.run(
        ["bash",str(origin.ROOT/"run-rmc011-real-source-closeout.sh"),
         str(work/"d08"),str(work/"d09"),str(lock),str(output)],
        cwd=Path.cwd(),
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        text=True,timeout=3000
    )
    if code.returncode!=0:
        print("RMC011_AUTHENTIC_D08_NATIVE_RUST_IMPORT_FAILED"
              +" return="+str(code.returncode)
              +" stderr_tail="+repr(code.stderr[-1800:])
              +" stdout_tail="+repr(code.stdout[-400:]),flush=True)
        raise ValueError("original full D08 native family importer did not replay")
    summary=origin.json_object((output/"capital-census-summary.json").read_bytes())
    closeout=origin.json_object((output/"capital-real-source-closeout.json").read_bytes())
    need(summary.get("real_source_certification") is False
            and summary.get("profitability_claimed") is False
            and closeout.get("real_source_certification") is True
            and closeout.get("terminal_capital_census_complete") is False
            and closeout.get("global_capital_source_completeness_claimed") is False
            and closeout.get("real_pnl_claimed") is False,
            "D08 two-protocol import overstates terminal economics")
    classes=summary.get("sources_by_class")
    need(type(classes) is dict and
            type(summary.get("source_count")) is int and
            type(closeout.get("d08_source_count")) is int and
            all(type(v) is int and v>=0 for v in classes.values()) and
            sum(classes.values())==summary.get("source_count") and
            closeout.get("d08_source_count")==summary["source_count"],
            "exact original D08 source count not conserved")
    return summary,closeout


def publish(work:Path,upstream:list[dict],native:list[dict],summary,closeout,head,run_id):
    classes=summary["sources_by_class"]
    aave=classes.get("PROTOCOL_NATIVE_FLASH_LOAN",0)
    v2=classes.get("FLASH_SWAP",0)
    need(type(aave) is int and type(v2) is int and aave>=0 and v2>=0
            and type(summary.get("source_count")) is int
            and sum(classes.values())==summary["source_count"],
            "noncanonical native capital class count")
    report={
        "schema_version":1,
        "status":"RMC011_ORIGINAL_D08_AAVE_V3_AND_UNISWAP_V2_SOURCE_IMPORT_REPLAY_ONLY",
        "scope":"EXACT_FROZEN_D08_D09_NATIVE_SOURCE_OBSERVATION_NOT_TERMINAL_D11",
        "producer_code_head":head,
        "source_run_id":run_id,
        "source_code_tree":origin.command("git","rev-parse","HEAD^{tree}"),
        "source_universe_blob":SOURCE_UNIVERSE_BLOB,
        "original_input_blob":INPUT_BLOB,
        "original_witness_producing_head":PRODUCER_HEAD,
        "original_witness_artifact_id":PRODUCER_ARTIFACT,
        "original_witness_zip_sha256":PRODUCER_ZIP,
        "original_upstream_stage_identities":upstream,
        "original_d08_zip_sha256":native[0]["artifact_sha256"],
        "original_d09_zip_sha256":native[1]["artifact_sha256"],
        "d08_source_count":summary["source_count"],
        "d08_source_classes":classes,
        "aave_v3_flash_source_count_observed_not_execution_count":aave,
        "uniswap_v2_flash_source_count_observed_not_execution_count":v2,
        "d08_import_deterministically_replay_verified":True,
        "d11_balancer_native_source_family_authenticated":False,
        "d11_uniswap_v3_native_source_family_authenticated":False,
        "native_source_universe_family_authentication_pinned":False,
        "source_family_universe_discovery_authenticated":False,
        "d11_terminal_closed":False,
        "external_nqc_native_gas_sponsors_approved":0,
        "nqc_capture_competition_calibrated":False,
        "nqc_realized_pnl_usd_wad":"0",
        "census_closed":False,
    }
    report["report_sha256"]=sha256(canonical(report))
    folder=work/"public"
    folder.mkdir(exist_ok=False)
    (folder/"native-d08-source-report.json").write_bytes(canonical(report))
    print(report["status"],"AAVE_V3",aave,"UNI_V2",v2,
          "GAS_PROVIDER=0 D11_TERMINAL=false",flush=True)
    return report


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--root",type=Path,required=True)
    parser.add_argument("--head",required=True)
    parser.add_argument("--run-id",type=int,required=True)
    args=parser.parse_args()
    need(args.head==origin.command("git","rev-parse","HEAD")
         and HEX40.fullmatch(args.head)
         and args.run_id>0
         and os.environ.get("GITHUB_REPOSITORY")==REPO
         and os.environ.get("GH_TOKEN"),
         "producer must use authorized read-only Actions in canonical repo and exact head")
    d,_=original_source_catalog()
    work=args.root.resolve()
    need(not work.exists(),"append-only native source output root")
    work.mkdir(parents=True)
    upstream=obtain_first_stage_witness(work,d)
    lock,stage=original_d08_d09_and_lock(work,d,upstream)
    summary,closeout=run_real_import(work,lock)
    publish(work,upstream,[stage["d08"],stage["d09"]],
            summary,closeout,args.head,args.run_id)


if __name__=="__main__":
    main()
