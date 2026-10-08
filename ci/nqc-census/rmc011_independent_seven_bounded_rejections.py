#!/usr/bin/env python3
"""Independently reauthenticate 7 original RMC011 rejection bytes (NOT D11).

A successful report certifies only that seven bounded source references
match one real, immutable GitHub Actions archive and the unchanged zero-funded
NQC plan/provider catalogs. It does NOT prove global provider absence,
executable liquidations, native ETH gas sponsorship or Census closeout.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

REPO="josuechavando350-png/nexus-engine"
WORKFLOW="NQC RMC-011 Bounded Family Rejection Evidence"
HEAD="e7e33cb96935ecf9effaab601d105b097c700671"
RUN_ID=37826819250
ARTIFACT_ID=11571178483
ARTIFACT_NAME=f"rmc011-bounded-family-rejections-{HEAD}-{RUN_ID}-1"
ARCHIVE_SHA="83a22012952b41dea2061134007a65fb6da76b63c0cf7836ea0804828a2a2d5d"
SOURCE_UNIVERSE_BLOB="6754a74c5c1e348c0c731618332ba8feba96834e"
PROVIDER_BLOB="a9c1427bb05828d08ade537899ee1b8e43b97ed2"
PLANS_BLOB="53aacf43fac87bbf4a5438ceeab7530d9287e88f"
EXTERNAL={"EXTERNAL_GAS_CREDIT","EXTERNAL_GAS_SPONSOR","TRANSIENT_EXTERNAL_CREDIT"}
PLAN={"BOND_OR_STAKE","INTRA_BLOCK_TEMPORARY_LOCK","INVENTORY_REQUIREMENT","SOLVER_OR_BUILDER_DEPOSIT"}
BOUNDED=EXTERNAL|PLAN
PENDING={
 "AAVE_V3_FLASH_LOAN","UNISWAP_V2_FLASH_SWAP",
 "BALANCER_V2_FLASH_LOAN","UNISWAP_V3_FLASH",
 "COLLATERALIZED_BORROWING","PERSISTENT_DEBT"
}
HEX64=re.compile(r"[0-9a-f]{64}\Z")
SHA1=re.compile(r"[0-9a-f]{40}\Z")


def need(condition,why):
    if not condition: raise ValueError(why)


def canonical(obj):
    return (json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def gitblob(raw):
    return hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\x00"+raw).hexdigest()


def decode(raw):
    def pairs_unique(pairs):
        obj={}
        for k,v in pairs:
            need(k not in obj,"duplicate JSON key forbidden")
            obj[k]=v
        return obj
    doc=json.loads(raw,object_pairs_hook=pairs_unique)
    need(type(doc) is dict,"root must be JSON object")
    return doc


def verify_metadata(run,artifact):
    need(type(run) is dict and
         run.get("id")==RUN_ID and type(run.get("id")) is int and
         run.get("status")=="completed" and run.get("conclusion")=="success" and
         run.get("name")==WORKFLOW and run.get("head_sha")==HEAD and
         run.get("run_attempt")==1 and type(run.get("run_attempt")) is int,
         "original producing run result or exact head not authenticated")
    need(type(artifact) is dict and
         artifact.get("id")==ARTIFACT_ID and type(artifact.get("id")) is int and
         artifact.get("name")==ARTIFACT_NAME and
         artifact.get("digest")=="sha256:"+ARCHIVE_SHA and
         artifact.get("expired") is False and
         type(artifact.get("workflow_run")) is dict and
         artifact["workflow_run"].get("id")==RUN_ID and
         artifact["workflow_run"].get("head_sha")==HEAD,
         "original GitHub artifact name/head/digest or run identity mismatch")
    return True


def verified_zip(raw):
    need(type(raw) is bytes and 0<len(raw)<100_000 and sha256(raw)==ARCHIVE_SHA,
         "original seven-family artifact bytes fail exact outer SHA-256")
    expect={"SHA256SUMS","evidence-index.json","rejection-report.json"}|{
        f"families/{family}/evidence.json" for family in BOUNDED
    }
    contents={}
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        members=z.infolist()
        names=[m.filename for m in members]
        need(len(names)==len(expect) and set(names)==expect and
             len(set(names))==len(names),"archive missing or injected members")
        for member in members:
            need(not member.is_dir() and
                 member.filename in expect and
                 not member.filename.startswith("/") and
                 ".." not in Path(member.filename).parts and
                 "\\" not in member.filename and
                 member.file_size<20_000 and
                 ((member.external_attr>>16)&0o170000)!=0o120000,
                 "unsafe or oversized archive member")
            contents[member.filename]=z.read(member)
            need(len(contents[member.filename])==member.file_size,
                 "original archived member size mismatch")
    declared={}
    for line in contents["SHA256SUMS"].decode("ascii").splitlines():
        fields=line.split("  ",1)
        need(len(fields)==2 and HEX64.fullmatch(fields[0]),
             "invalid original SHA256SUMS line")
        rel=fields[1].removeprefix("./")
        need(rel in expect-{"SHA256SUMS"} and rel not in declared,
             "missing/duplicate original SHA256SUMS member path")
        declared[rel]=fields[0]
    need(set(declared)==expect-{"SHA256SUMS"} and all(
        sha256(contents[k])==digest for k,digest in declared.items()
    ),"original internal archive SHA-256 manifest mismatch")
    return contents


def audit(*,original_zip,source_bytes,provider_bytes,plan_bytes,run,artifact):
    verify_metadata(run,artifact)
    need(gitblob(source_bytes)==SOURCE_UNIVERSE_BLOB,
         "canonical seven-pinned source Git blob changed")
    need(gitblob(provider_bytes)==PROVIDER_BLOB,
         "approved external NQC provider registry changed")
    need(gitblob(plan_bytes)==PLANS_BLOB,
         "declared NQC plan requirements changed")
    u=decode(source_bytes)
    p=decode(provider_bytes)
    q=decode(plan_bytes)
    need(p.get("provider_count")==0 and type(p.get("provider_count")) is int and
         p.get("providers")==[] and
         p.get("status")=="DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE",
         "source registry no longer proves zero NQC-authorized providers")
    need(q.get("plan_count")==0 and type(q.get("plan_count")) is int and
         q.get("plans")==[] and
         q.get("status")=="DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE",
         "source execution-plan catalog no longer proves zero supported plans")
    need(u.get("stage")=="RMC-011" and u.get("schema_version")==2 and
         type(u.get("schema_version")) is int and
         u.get("status")=="BLOCKED_INCOMPLETE_SOURCE_UNIVERSE" and
         u.get("terminal_claim_allowed") is False and
         u.get("d11_terminal_closed") is False and
         u.get("family_universe_discovery",{}).get("status")=="NOT_CERTIFIED" and
         u.get("family_universe_discovery",{}).get("evidence") is None,
         "source falsely promotes terminal family universe")
    rows=u.get("families")
    need(type(rows) is list and len(rows)==13 and
         all(type(r) is dict and type(r.get("id")) is str for r in rows) and
         len({r["id"] for r in rows})==13,
         "original RMC011 source family population invalid")
    by_id={r["id"]:r for r in rows}
    need(set(by_id)==BOUNDED|PENDING,"13-family universe not conserved")
    need(all(r["terminally_resolved"] is False and
             r["resolution_evidence"] is None for f,r in by_id.items()
             if f in PENDING),
         "pending native flash/debt family promoted without source")
    archive=verified_zip(original_zip)
    index=decode(archive["evidence-index.json"])
    rejection=decode(archive["rejection-report.json"])
    need(index.get("status")=="RMC011_BOUNDED_FAMILY_REJECTION_EVIDENCE_INDEX" and
         index.get("head_sha")==HEAD and index.get("run_id")==RUN_ID and
         index.get("run_attempt")==1 and index.get("workflow_name")==WORKFLOW and
         index.get("family_count")==7 and
         index.get("d11_terminal_closed") is False and
         index.get("artifact_metadata_pending_upload") is True,
         "original archive evidence index failed producing-run binding")
    need(rejection.get("status")=="RMC011_BOUNDED_FAMILY_REJECTIONS_READY" and
         rejection.get("family_count")==7 and
         rejection.get("global_nonexistence_claimed") is False and
         rejection.get("source_availability_claimed") is False and
         rejection.get("d11_terminal_closed") is False and
         rejection.get("claim_scope")==
           "NQC_EXECUTION_AUTHORIZED_EXTERNAL_AND_SUPPORTED_REQUIREMENT_UNIVERSE_AT_THIS_HEAD",
         "bounded rejection report overclaims global nonexistence")
    ix=index.get("families")
    need(type(ix) is list and len(ix)==7 and
         {r.get("family") for r in ix if type(r) is dict}==BOUNDED,
         "seven original family member index incomplete or duplicated")
    source_rows={}
    for item in ix:
        family=item["family"]
        path=f"families/{family}/evidence.json"
        need(item.get("file")==path and
             type(item.get("sha256")) is str and
             HEX64.fullmatch(item["sha256"]),
             "original family member index path/hash invalid")
        original=archive[path]
        need(sha256(original)==item["sha256"],
             "original per-family evidence SHA256 mismatch")
        record=decode(original)
        expected_scope=(
            "NQC_EXECUTION_AUTHORIZED_EXTERNAL_PROVIDER_UNIVERSE_AT_THIS_HEAD"
            if family in EXTERNAL else
            "NQC_SUPPORTED_EXECUTION_PLAN_REQUIREMENT_UNIVERSE_AT_THIS_HEAD"
        )
        need(record.get("schema_version")==1 and
             type(record.get("schema_version")) is int and
             record.get("stage")=="RMC-011" and
             record.get("family")==family and
             record.get("kind")=="EXHAUSTIVE_REJECTION" and
             record.get("scope")==expected_scope and
             type(record.get("basis")) is list and
             len(record["basis"])>=2 and
             "EXTERNAL_PROVIDER_COUNT_EQ_0" in record["basis"] and
             record.get("workflow_name")==WORKFLOW and
             record.get("head_sha")==HEAD and record.get("run_id")==RUN_ID and
             record.get("run_attempt")==1 and
             record.get("global_nonexistence_claimed") is False and
             record.get("source_availability_claimed") is False and
             record.get("d11_terminal_closed") is False,
             "original family evidence not the bounded exact-head rejection")
        candidate=by_id[family]
        expected_ref={
          "kind":"EXHAUSTIVE_REJECTION","repository":REPO,
          "workflow_name":WORKFLOW,"run_id":RUN_ID,"head_sha":HEAD,
          "artifact_id":ARTIFACT_ID,"artifact_name":ARTIFACT_NAME,
          "artifact_digest":"sha256:"+ARCHIVE_SHA,
          "file":path,"sha256":item["sha256"]
        }
        need(candidate.get("status")==
             "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE" and
             candidate.get("terminally_resolved") is True and
             candidate.get("real_source_path") is None and
             candidate.get("resolution_evidence")==expected_ref,
             "source-universe family does not match authenticated original member")
        source_rows[family]=item["sha256"]
    need(len(source_rows)==7,"seven original family members not conserved")
    report={
      "schema_version":1,
      "status":"RMC011_SEVEN_BOUNDED_REJECTIONS_INDEPENDENTLY_REAUTHENTICATED_NOT_D11",
      "source_repo":REPO,
      "source_family_universe_blob_sha1":SOURCE_UNIVERSE_BLOB,
      "source_provider_registry_blob_sha1":PROVIDER_BLOB,
      "source_plan_catalog_blob_sha1":PLANS_BLOB,
      "original_run_id":RUN_ID,
      "original_exact_head_sha":HEAD,
      "original_artifact_id":ARTIFACT_ID,
      "original_artifact_name":ARTIFACT_NAME,
      "original_artifact_zip_sha256":ARCHIVE_SHA,
      "original_bounded_evidence_members_sha256":dict(sorted(source_rows.items())),
      "rejected_families_within_nqc_configured_scope":7,
      "remaining_native_flash_or_debt_families":sorted(PENDING),
      "remaining_unresolved_families":6,
      "family_universe_discovery_certified":False,
      "capital_truth_D11_terminal_closed":False,
      "global_external_funding_nonexistence_proven":False,
      "nqc_approved_external_gas_provider_count":0,
      "nqc_nonrecourse_native_gas_authorized":False,
      "original_ledger_127_cost_rows_recovered_by_this_gate":False,
      "nqc_realized_net_usd_wad":"0",
      "real_market_census_closed":False,
    }
    report["report_sha256"]=sha256(canonical(report))
    return report


def main():
    cli=argparse.ArgumentParser()
    cli.add_argument("--archive",required=True,type=Path)
    cli.add_argument("--source-universe",default="ci/nqc-census/rmc011-capital-source-universe.json",type=Path)
    cli.add_argument("--provider-registry",default="ci/nqc-census/rmc011-external-capital-provider-registry.json",type=Path)
    cli.add_argument("--plan-catalog",default="ci/nqc-census/rmc011-execution-plan-requirement-catalog.json",type=Path)
    cli.add_argument("--run-meta",required=True,type=Path)
    cli.add_argument("--artifact-meta",required=True,type=Path)
    cli.add_argument("--out",required=True,type=Path)
    args=cli.parse_args()
    need(not args.out.exists(),"append-only independent source report")
    result=audit(
      original_zip=args.archive.read_bytes(),
      source_bytes=args.source_universe.read_bytes(),
      provider_bytes=args.provider_registry.read_bytes(),
      plan_bytes=args.plan_catalog.read_bytes(),
      run=decode(args.run_meta.read_bytes()),
      artifact=decode(args.artifact_meta.read_bytes()),
    )
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_bytes(canonical(result))
    print(result["status"],
          "PINNED_BOUNDED=7 REMAINING_UNRESOLVED=6",
          "GAS_SPONSORS_AUTHORIZED=0 CENSUS_CLOSED=false")


if __name__=="__main__":
    main()
