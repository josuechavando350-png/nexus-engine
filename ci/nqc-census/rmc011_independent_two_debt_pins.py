#!/usr/bin/env python3
"""Independent exact-source reauthentication of 2 bounded original D08 debt proofs.

Consumes the ORIGINAL producer ZIP bytes, original 5 upstream run/artifact/tree
metadata, and the NEW 9/13 source-universe Git blob. Neither this validator
nor its producer is a D11 terminal certification or a financing agreement.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
from zipfile import ZipFile

REPO = "josuechavando350-png/nexus-engine"
ORIGINAL_HEAD = "5b79e7be1c185cbb4924d592991b9c990fc0465a"
ORIGINAL_RUN_ID = 37832286518
ORIGINAL_ARTIFACT_ID = 11573678487
ORIGINAL_ZIP_SHA256 = "151847cdf85b1b49298d59b41d1bf939f6854d4556060a03ab7dd5a2e1359916"
ORIGINAL_WORKFLOW = "NQC RMC-011 Original D08 Debt Family Rejection Evidence (NO D11 CLOSE)"
ORIGINAL_ARTIFACT_NAME = (
    f"rmc011-original-d08-debt-rejections-{ORIGINAL_HEAD}-{ORIGINAL_RUN_ID}-1"
)
ORIGINAL_FAMILY_BLOBS = {
    "COLLATERALIZED_BORROWING": "78e130c871ecf881a90cbe37996046864cb7afc27d79a31dc36c2804a4ba052c",
    "PERSISTENT_DEBT": "b8b22443a5a3491a1ed64cb8c8c11958503784e42c6537877ac92b70e988b478",
}
CURRENT_SOURCE_BLOB = "c1b9f136a13f220af9dceaae50e5caa3105121eb"
ORIGINAL_PRODUCER_SOURCE_BLOB = "6754a74c5c1e348c0c731618332ba8feba96834e"
ORIGINAL_UPSTREAM_INPUT_BLOB = "1db0bbd78af36ee61dd6a44630a3b6614f3e9309"
REGISTRY_BLOB = "a9c1427bb05828d08ade537899ee1b8e43b97ed2"
PERMISSIONLESS_BLOB = "100fd25c99217e82f4d5b00bd67b9c87be3d1afa"
COLLATERAL_BLOB = "d21b0731f76658121fbf1daf63bf9e19f742840e"
FINAL_BLOB = "b1182b27b0ff3856b17a6f829ac3c693eab74400"
SCOPE = "NQC_ZERO_OWN_CAPITAL_EXECUTABLE_DEBT_UNIVERSE_AT_THIS_HEAD"
FOUR = {
    "AAVE_V3_FLASH_LOAN", "UNISWAP_V2_FLASH_SWAP",
    "BALANCER_V2_FLASH_LOAN", "UNISWAP_V3_FLASH",
}
DEBT = set(ORIGINAL_FAMILY_BLOBS)
BOUNDED = {
    "EXTERNAL_GAS_CREDIT","EXTERNAL_GAS_SPONSOR","TRANSIENT_EXTERNAL_CREDIT",
    "INVENTORY_REQUIREMENT","BOND_OR_STAKE","SOLVER_OR_BUILDER_DEPOSIT",
    "INTRA_BLOCK_TEMPORARY_LOCK",
}
BASIS = [
    "D08_AUTHENTICATED_AAVE_DEBT_DISCOVERY_COMPLETE",
    "AAVE_PROTOCOL_LIQUIDITY_NOT_NQC_CAPITAL_SOURCE",
    "AAVE_NQC_CAPITAL_SOURCE_COUNT_EQ_0",
    "AUTHORIZED_EXTERNAL_PROVIDER_COUNT_EQ_0",
    "DECLARED_PERMISSIONLESS_DEBT_FACILITY_COUNT_EQ_0",
    "ZERO_OWN_CAPITAL_COLLATERAL_PATH_COUNT_EQ_0",
]
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
STAGES = ("d06","d07","d08","d09","d10")


def need(value, message):
    if not value: raise ValueError(message)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def gitblob(raw):
    return hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()


def canonical(doc):
    return (json.dumps(doc,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def parse(raw):
    def unique(pairs):
        result={}
        for k,v in pairs:
            need(k not in result,"duplicate JSON field forbidden")
            result[k]=v
        return result
    result=json.loads(raw,object_pairs_hook=unique)
    need(type(result) is dict,"JSON root not object")
    return result


def source(path,gitsha):
    raw=Path(path).read_bytes()
    need(0<len(raw)<60000 and gitblob(raw)==gitsha,"original source Git blob drift: "+str(path))
    return parse(raw)


def verify_run_artifact(run,artifact,original_commit):
    need(type(run) is dict and type(run.get("id")) is int
         and run["id"]==ORIGINAL_RUN_ID
         and run.get("name")==ORIGINAL_WORKFLOW
         and run.get("head_sha")==ORIGINAL_HEAD
         and run.get("status")=="completed"
         and run.get("conclusion")=="success"
         and type(run.get("run_attempt")) is int and run["run_attempt"]==1,
         "original debt production Actions run was not exact-head success")
    need(type(artifact) is dict and type(artifact.get("id")) is int
         and artifact["id"]==ORIGINAL_ARTIFACT_ID
         and artifact.get("name")==ORIGINAL_ARTIFACT_NAME
         and artifact.get("digest")=="sha256:"+ORIGINAL_ZIP_SHA256
         and artifact.get("expired") is False
         and type(artifact.get("workflow_run")) is dict
         and artifact["workflow_run"].get("id")==ORIGINAL_RUN_ID
         and artifact["workflow_run"].get("head_sha")==ORIGINAL_HEAD,
         "original debt archive GH metadata id/name/SHA mismatch")
    tree=original_commit.get("tree")
    need(type(tree) is dict and type(tree.get("sha")) is str
         and HEX40.fullmatch(tree["sha"]),
         "original debt source producing git tree unavailable")
    return tree["sha"]


def verify_original_zip(raw):
    need(type(raw) is bytes and 0<len(raw)<80_000
         and sha256(raw)==ORIGINAL_ZIP_SHA256,
         "original debt ZIP missing or outer SHA256 differs")
    filenames={"SHA256SUMS","original-source-report.json"} | {
        f"debt-family-evidence/families/{family}/evidence.json"
        for family in DEBT
    }
    data={}
    with ZipFile(io.BytesIO(raw)) as archive:
        info=archive.infolist()
        names=[x.filename for x in info]
        need(len(names)==4 and len(set(names))==4 and set(names)==filenames,
             "unexpected/missing ZIP members")
        for entry in info:
            n=entry.filename
            need(not entry.is_dir() and not n.startswith("/")
                 and ".." not in PurePosixPath(n).parts and "\\" not in n
                 and entry.file_size<60_000
                 and ((entry.external_attr>>16)&0o170000)!=0o120000,
                 "untrusted ZIP member path/symlink/size")
            data[n]=archive.read(entry)
            need(len(data[n])==entry.file_size,"original member size mismatch")
    manifest={}
    for line in data["SHA256SUMS"].decode("ascii").splitlines():
        fields=line.split("  ",1)
        need(len(fields)==2 and HEX64.fullmatch(fields[0]),
             "malformed original member SHA256SUMS")
        path=fields[1].removeprefix("./")
        need(path in filenames-{"SHA256SUMS"} and path not in manifest,
             "duplicate/invalid original SHA256SUMS path")
        manifest[path]=fields[0]
    need(set(manifest)==filenames-{"SHA256SUMS"}
         and all(sha256(data[p])==digest for p,digest in manifest.items()),
         "original archived member SHA256SUMS does not replay")
    return data


def verify_stage_refs(upstream,stage_meta,source_input):
    need(type(upstream) is list and len(upstream)==5,
         "original five-stage frozen source references incomplete")
    need(type(stage_meta) is dict and set(stage_meta)==set(STAGES),
         "independent original stage metadata missing")
    need([v.get("key") for v in upstream]==list(STAGES),
         "original stage order mismatch")
    for i,key in enumerate(STAGES):
        row=upstream[i]
        src=source_input[key]
        original=stage_meta[key]
        need(type(row) is dict and type(original) is dict,
             f"{key}: original stage transport missing")
        expect_stage=f"RMC-{int(key[1:]):03d}"
        need(row.get("stage")==expect_stage
             and row.get("code_commit")==src["head_sha"]
             and row.get("run_id")==src["run_id"]
             and row.get("artifact_id")==src["artifact_id"]
             and row.get("artifact_sha256")==src["artifact_digest"][7:]
             and row.get("authority_file")==src["authority_file"]
             and type(row.get("authority_sha256")) is str
             and HEX64.fullmatch(row["authority_sha256"]),
             f"{key}: source-specific stage original run/head/ZIP contract changed")
        run,artifact,commit=original["run"],original["artifact"],original["commit"]
        need(type(run) is dict and run.get("id")==src["run_id"]
             and type(run.get("id")) is int
             and run.get("status")=="completed"
             and run.get("conclusion")=="success"
             and run.get("head_sha")==src["head_sha"]
             and run.get("name")==src["workflow_name"],
             f"{key}: independent run authentication failed")
        need(type(artifact) is dict and type(artifact.get("id")) is int
             and artifact.get("id")==src["artifact_id"]
             and artifact.get("expired") is False
             and artifact.get("name")==src["artifact_name"]
             and artifact.get("digest")==src["artifact_digest"]
             and artifact.get("workflow_run",{}).get("id")==src["run_id"]
             and artifact.get("workflow_run",{}).get("head_sha")==src["head_sha"],
             f"{key}: independent original artifact authenticity failed")
        tree=commit.get("tree",{}).get("sha")
        need(type(tree) is str and HEX40.fullmatch(tree)
             and row.get("code_tree")==tree,
             f"{key}: original code tree did not match immutable producer")
    return upstream[2]["authority_sha256"]


def inspect_original_report(archived,original_tree,inputs,stages):
    report=parse(archived["original-source-report.json"])
    declared=report.get("report_sha256")
    need(type(declared) is str and HEX64.fullmatch(declared) and
         sha256(canonical({k:v for k,v in report.items()
                           if k!="report_sha256"}))==declared,
         "original economic source report commitment mismatch")
    need(report.get("schema_version")==1 and type(report.get("schema_version")) is int
         and report.get("status")=="RMC011_ORIGINAL_D08_TWO_DEBT_REJECTIONS_AUTHENTICATED_NOT_D11"
         and report.get("claim_scope")==SCOPE
         and report.get("source_exact_head")==ORIGINAL_HEAD
         and report.get("source_code_tree")==original_tree
         and report.get("source_workflow_name")==ORIGINAL_WORKFLOW
         and report.get("source_run_id")==ORIGINAL_RUN_ID
         and report.get("source_run_attempt")==1
         and report.get("source_universe_sha1")==ORIGINAL_PRODUCER_SOURCE_BLOB
         and report.get("source_upstream_input_sha1")==ORIGINAL_UPSTREAM_INPUT_BLOB,
         "original producer status/schema/head/tree/scope promoted falsely")
    d08_authority=verify_stage_refs(
        report.get("five_original_upstream_stage_sources"),stages,inputs
    )
    need(report.get("observed_debt_original_D08_authority")=="0x"+d08_authority
         and report.get("observed_aave_debt_candidate_count")==67
         and type(report.get("observed_aave_debt_candidate_count")) is int
         and report.get("observed_aave_debt_facility_count")==67
         and report.get("observed_aave_debt_rejection_count")==0
         and type(report.get("aave_original_debt_coverage_commitment")) is str
         and len(report["aave_original_debt_coverage_commitment"])>0,
         "original Aave debt discovery counted or attributed falsely")
    need(report.get("nqc_authorized_external_gas_providers")==0
         and report.get("nqc_authorized_nonoperator_collateral_paths")==0
         and report.get("nqc_external_debt_executable_capacity_claimed") is False
         and report.get("global_external_credit_nonexistence_claimed") is False
         and report.get("original_127_winner_cost_ledger_recovered") is False
         and report.get("rmc011_terminal_closed") is False
         and report.get("real_market_census_closed") is False
         and report.get("nqc_realized_usd_wad")=="0",
         "original D08 report falsely promoted debt, global absence, or P&L")
    return report


def audit(archive_raw,source_raw,original_input_raw,provider_raw,
          permissionless_raw,collateral_raw,final_raw,
          original_run,original_artifact,original_commit,original_upstream_metadata):
    for raw,sha,label in [
        (source_raw,CURRENT_SOURCE_BLOB,"nine-family source universe"),
        (original_input_raw,ORIGINAL_UPSTREAM_INPUT_BLOB,"original upstream input"),
        (provider_raw,REGISTRY_BLOB,"configured provider registry"),
        (permissionless_raw,PERMISSIONLESS_BLOB,"permissionless catalog"),
        (collateral_raw,COLLATERAL_BLOB,"collateral path catalog"),
        (final_raw,FINAL_BLOB,"final D14 lock"),
    ]:
        need(gitblob(raw)==sha,"Git blob drift: "+label)
    source_doc=parse(source_raw)
    originals=parse(original_input_raw)
    registry=parse(provider_raw)
    permissionless=parse(permissionless_raw)
    collateral=parse(collateral_raw)
    final=parse(final_raw)
    need(registry.get("provider_count")==0
         and type(registry.get("provider_count")) is int
         and registry.get("providers")==[]
         and permissionless.get("facility_count")==0
         and permissionless.get("facilities")==[]
         and collateral.get("path_count")==0
         and collateral.get("paths")==[]
         and final.get("status")=="BLOCKED"
         and final.get("real_market_census_closed") is False
         and final.get("pinned_stages")==[],
         "NQC capital or Census source availability changed materially")
    need(originals.get("repository")==REPO and originals.get("schema_version")==3
         and set(originals)=={"repository","schema_version",*STAGES},
         "original five-stage input set changed")
    need(source_doc.get("schema_version")==2
         and source_doc.get("stage")=="RMC-011"
         and source_doc.get("status")=="BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
         and source_doc.get("d11_terminal_closed") is False
         and source_doc.get("terminal_claim_allowed") is False
         and source_doc.get("family_universe_discovery",{}).get("status")=="NOT_CERTIFIED"
         and source_doc.get("family_universe_discovery",{}).get("evidence") is None,
         "source lock promoted terminal D11 with only nine families")
    families=source_doc.get("families")
    need(type(families) is list and len(families)==13
         and all(type(v) is dict and type(v.get("id")) is str for v in families),
         "source lock has missing/malformed capital family")
    by_id={r["id"]:r for r in families}
    need(len(by_id)==13 and set(by_id)==FOUR|DEBT|BOUNDED
         and all(by_id[f].get("terminally_resolved") is False
                 and by_id[f].get("resolution_evidence") is None for f in FOUR)
         and all(by_id[f].get("terminally_resolved") is True for f in DEBT|BOUNDED),
         "four remaining native capital families falsely admitted")
    original_tree=verify_run_artifact(original_run,original_artifact,original_commit)
    archived=verify_original_zip(archive_raw)
    report=inspect_original_report(
        archived,original_tree,originals,original_upstream_metadata
    )
    hashes=report.get("original_two_bounded_debt_evidence_sha256")
    need(type(hashes) is dict and hashes==ORIGINAL_FAMILY_BLOBS,
         "original reported two debt-family evidence hashes differ")
    for family,expected in sorted(ORIGINAL_FAMILY_BLOBS.items()):
        file=f"debt-family-evidence/families/{family}/evidence.json"
        raw=archived[file]
        need(sha256(raw)==expected,
             family+": original evidence member bytes differ")
        d=parse(raw)
        need(d.get("schema_version")==1
             and d.get("stage")=="RMC-011"
             and d.get("kind")=="EXHAUSTIVE_REJECTION"
             and d.get("family")==family
             and d.get("scope")==SCOPE
             and d.get("basis")==BASIS
             and d.get("workflow_name")==ORIGINAL_WORKFLOW
             and d.get("head_sha")==ORIGINAL_HEAD
             and d.get("code_tree")==original_tree
             and d.get("run_id")==ORIGINAL_RUN_ID
             and d.get("run_attempt")==1
             and d.get("original_d08_run_id")==originals["d08"]["run_id"]
             and d.get("original_d08_archive_sha256")==originals["d08"]["artifact_digest"][7:]
             and d.get("d08_authority_artifact_sha256")==report["observed_debt_original_D08_authority"]
             and d.get("aave_coverage_commitment")==report["aave_original_debt_coverage_commitment"]
             and d.get("nonoperator_collateral_authorized") is False
             and d.get("nqc_borrowing_capacity_claimed") is False
             and d.get("global_nonexistence_claimed") is False
             and d.get("terminal_d11_closed") is False,
             family+": original evidence scope or negative proof changed")
        reference={
          "kind":"EXHAUSTIVE_REJECTION","repository":REPO,
          "workflow_name":ORIGINAL_WORKFLOW,"run_id":ORIGINAL_RUN_ID,
          "head_sha":ORIGINAL_HEAD,"artifact_id":ORIGINAL_ARTIFACT_ID,
          "artifact_name":ORIGINAL_ARTIFACT_NAME,
          "artifact_digest":"sha256:"+ORIGINAL_ZIP_SHA256,
          "file":file,"sha256":expected,
        }
        row=by_id[family]
        need(row.get("status")=="EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
             and row.get("terminally_resolved") is True
             and row.get("real_source_path") is None
             and row.get("resolution_evidence")==reference,
             family+": new source-universe row not exact original authenticated bytes")
    report={
      "schema_version":1,
      "status":"RMC011_TWO_ORIGINAL_D08_DEBT_REJECTIONS_INDEPENDENTLY_AUTHENTICATED_NOT_D11",
      "source_repository":REPO,
      "nine_family_source_universe_git_blob":CURRENT_SOURCE_BLOB,
      "seven_family_original_source_git_blob":ORIGINAL_PRODUCER_SOURCE_BLOB,
      "original_upstream_input_git_blob":ORIGINAL_UPSTREAM_INPUT_BLOB,
      "original_debt_workflow":ORIGINAL_WORKFLOW,
      "original_debt_run_id":ORIGINAL_RUN_ID,
      "original_debt_head":ORIGINAL_HEAD,
      "original_debt_code_tree":original_tree,
      "original_debt_artifact_id":ORIGINAL_ARTIFACT_ID,
      "original_debt_zip_sha256":ORIGINAL_ZIP_SHA256,
      "original_debt_member_sha256":dict(sorted(ORIGINAL_FAMILY_BLOBS.items())),
      "original_d08_historical_aave_facility_count":67,
      "bounded_capital_families_with_original_source_evidence":9,
      "native_protocol_families_not_terminally_resolved":sorted(FOUR),
      "remaining_unresolved_count":4,
      "family_universe_discovery_authenticated":False,
      "no_external_nqc_gas_credit_or_sponsor_admitted":True,
      "nqc_authorized_native_eth_gas_source_count":0,
      "global_debt_facility_nonexistence_proven":False,
      "rmc011_terminal_closed":False,
      "real_market_census_closed":False,
      "nqc_realized_usd_wad":"0",
    }
    report["report_sha256"]=sha256(canonical(report))
    return report


def main():
    parser=argparse.ArgumentParser()
    for opt in ("original-zip","run-meta","artifact-meta","commit-meta","original-upstream-dir","out"):
        parser.add_argument("--"+opt,required=True,type=Path)
    args=parser.parse_args()
    need(not args.out.exists(),"append-only independent audit output")
    stages={}
    for key in STAGES:
        root=args.original_upstream_dir
        stages[key]={
          "run":parse((root/f"{key}.run.json").read_bytes()),
          "artifact":parse((root/f"{key}.artifact.json").read_bytes()),
          "commit":parse((root/f"{key}.commit.json").read_bytes()),
        }
    r=audit(
      args.original_zip.read_bytes(),
      (Path("ci/nqc-census/rmc011-capital-source-universe.json")).read_bytes(),
      (Path("ci/nqc-census/rmc011-real-source-inputs.json")).read_bytes(),
      (Path("ci/nqc-census/rmc011-external-capital-provider-registry.json")).read_bytes(),
      (Path("ci/nqc-census/rmc011-permissionless-debt-facility-catalog.json")).read_bytes(),
      (Path("ci/nqc-census/rmc011-collateral-funding-path-catalog.json")).read_bytes(),
      (Path("ci/nqc-census/final-census-authority-lock.json")).read_bytes(),
      parse(args.run_meta.read_bytes()),parse(args.artifact_meta.read_bytes()),
      parse(args.commit_meta.read_bytes()),stages,
    )
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_bytes(canonical(r))
    print(r["status"],"SOURCE_PINNED_FAMILIES=9 UNRESOLVED=4",
          "NQC_GAS=0 D11_CLOSED=false CENSUS_CLOSED=false")


if __name__=="__main__":
    main()
