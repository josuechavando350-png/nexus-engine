#!/usr/bin/env python3
"""Independent GH-original 4 native source pins: 13/13 SOURCE-TRANSPORT ONLY.

Does not decide executable opportunity, gas funding, collateral repayment,
capital capacity, original borrower economics or D11 terminal certification.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
from pathlib import Path
from zipfile import ZipFile

REPO="josuechavando350-png/nexus-engine"
ORIGINAL_RUN=37839794172
ORIGINAL_HEAD="0d6f9c685033500614e9f05d0d99965783f96659"
ORIGINAL_TREE="6670a843db982cbed7ba4eb7a2c43f57bfc5afe9"
ORIGINAL_ARTIFACT=11576204678
ORIGINAL_WORKFLOW="NQC RMC-011 Four Native Source Witness Producer (NOT D11 CLOSE)"
ORIGINAL_NAME=f"rmc011-four-native-source-certification-{ORIGINAL_HEAD}-{ORIGINAL_RUN}-1"
ORIGINAL_ZIP="16856326b33d92c679e7cd070c947bcf6628653d8bea4d3ebb851222bbf354eb"
ORIGINAL_SUMMARY="9a5e5698fa570d1be40b0b16e42deb33078d4564a8736f097d53a754437c67a0"
SOURCE_BLOB="9dee5fe5035fad450ede25462728eba26beffb49"
PRIOR_SOURCE_BLOB="c1b9f136a13f220af9dceaae50e5caa3105121eb"
GAS_REGISTRY_BLOB="a9c1427bb05828d08ade537899ee1b8e43b97ed2"
FINAL_LOCK_BLOB="b1182b27b0ff3856b17a6f829ac3c693eab74400"
ORIGINAL_D08_MANIFEST_SHA="1276491d349176fdd0ac63aaaa2c326c002c1a17384ba1e6db4704687842a279"
D08_AUDIT={
 "run_id":37836967374,
 "head":"fdf0ecd08bf17bd5812c92371f17c5f1f69b7f8f",
 "workflow":"NQC RMC-011 Original D08 D09 Full Native Flash Import (NOT D11 CLOSE)",
 "artifact_id":11576077535,
 "artifact_name":"rmc011-original-d08-native-flash-source-import-fdf0ecd08bf17bd5812c92371f17c5f1f69b7f8f",
 "artifact_sha256":"96fa8894c17722c29ff763d302b57f8db9c24b44bdd3b1c7b789dd530a833bd2",
 "report_file":"native-d08-source-report.json",
 "report_sha256":"34d3ee012d5649e90522509c6e23babcae8297bdf8d9995c0188191e6159b5e4",
 "report_status":"RMC011_ORIGINAL_D08_AAVE_V3_AND_UNISWAP_V2_SOURCE_IMPORT_REPLAY_ONLY",
}
DUAL_AUDIT={
 "run_id":37839036277,
 "head":"2b0c5ed1d7ca8def40f25d3f14674a61f9f6f485",
 "workflow":"NQC RMC-011 Original Native Dual Provider Audit (NOT D11 CLOSE)",
 "artifact_id":11577315781,
 "artifact_name":"rmc011-original-native-dual-source-2b0c5ed1d7ca8def40f25d3f14674a61f9f6f485",
 "artifact_sha256":"6019f244e80dfb157939b47e43fc8d3c48f432a61ea127237f0e4ae37a67f2c5",
 "report_file":"native-source-report.json",
 "report_sha256":"275e3e84eb053f8df9f85c873347e99167fd3ad94801bf0ce6bcbbc0cd3a5886",
 "report_status":"RMC011_ORIGINAL_DUAL_PROVIDER_NATIVE_FLASH_OBSERVED_ZERO_EXECUTABLE_NOT_D11",
}
FAMILIES={
 "AAVE_V3_FLASH_LOAN":{
   "sha256":"a4f979f07d54080feacef371f92f85a41df3469739487d65f6df9410aa6490ee",
   "role":"d08", "count":67,"path":"RMC008_AAVE_V3",
 },
 "UNISWAP_V2_FLASH_SWAP":{
   "sha256":"dfee6380be7a222e27c7808a66b07578944f78a7e4008754da33e409d4130da3",
   "role":"d08","count":1045392,"path":"RMC008_UNISWAP_V2",
 },
 "BALANCER_V2_FLASH_LOAN":{
   "sha256":"1152d08e5fabbd09c91ec7f6c2782dbda2d30c4855d3c81d91c136923c9a6b5c",
   "role":"dual","count":67,"path":"nqc-census/crates/nqc-census-capital/src/balancer_live.rs",
 },
 "UNISWAP_V3_FLASH":{
   "sha256":"8943448a890bf9db757d706727273f91e0c68364902118ca4886834252e5e9c5",
   "role":"dual","count":69748,"path":"nqc-census/crates/nqc-census-capital/src/permissionless_atomic.rs",
 },
}
SCOPED_BOUND_REJECTIONS={
 "BOND_OR_STAKE","INTRA_BLOCK_TEMPORARY_LOCK","INVENTORY_REQUIREMENT",
 "SOLVER_OR_BUILDER_DEPOSIT","EXTERNAL_GAS_CREDIT","EXTERNAL_GAS_SPONSOR",
 "TRANSIENT_EXTERNAL_CREDIT"
}
DEBT_REJECTIONS={"COLLATERALIZED_BORROWING","PERSISTENT_DEBT"}
SHA64=re.compile(r"[0-9a-f]{64}\Z")


def require(ok,msg):
    if not ok: raise ValueError(msg)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def gitblob(raw):
    return hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest()


def canonical(obj):
    return (json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def parse(raw):
    def unique(pairs):
        out={}
        for k,v in pairs:
            require(k not in out,"duplicate source JSON keys are forbidden")
            out[k]=v
        return out
    v=json.loads(raw,object_pairs_hook=unique)
    require(type(v) is dict,"expected canonical JSON object")
    return v


def require_metadata(run,artifact,role):
    cfg={
        "new":dict(run_id=ORIGINAL_RUN,head=ORIGINAL_HEAD,workflow=ORIGINAL_WORKFLOW,
                   artifact_id=ORIGINAL_ARTIFACT,artifact_name=ORIGINAL_NAME,
                   artifact_sha256=ORIGINAL_ZIP),
        "d08":D08_AUDIT,"dual":DUAL_AUDIT,
    }[role]
    rid=cfg.get("run_id")
    head=cfg.get("head")
    if role=="new":head=ORIGINAL_HEAD
    need=cfg.get("workflow")
    aid=cfg.get("artifact_id")
    name=cfg.get("artifact_name")
    digest=cfg.get("artifact_sha256")
    require(type(run) is dict and type(run.get("id")) is int
            and run.get("id")==rid and run.get("head_sha")==head
            and run.get("name")==need and run.get("status")=="completed"
            and run.get("conclusion")=="success",
            role+": original producing run not independently authenticated")
    require(type(artifact) is dict and type(artifact.get("id")) is int
            and artifact.get("id")==aid
            and artifact.get("name")==name
            and artifact.get("digest")=="sha256:"+digest
            and artifact.get("expired") is False
            and type(artifact.get("workflow_run")) is dict
            and artifact["workflow_run"].get("id")==rid
            and artifact["workflow_run"].get("head_sha")==head,
            role+": original immutable artifact/head/SHA identity invalid")


def opened_zip(raw,expected_sha,maxbytes=35000):
    require(type(raw) is bytes and 0<len(raw)<=maxbytes
            and sha256(raw)==expected_sha,"immutable source audit ZIP outer SHA256 mismatch")
    with ZipFile(io.BytesIO(raw)) as z:
        info=z.infolist()
        names=[x.filename for x in info]
        require(0<len(names)<=12 and len(set(names))==len(names),
                "audit ZIP member count or duplicate entry")
        require(all(not x.is_dir() and not x.filename.startswith("/")
                    and ".." not in Path(x.filename).parts and "\\" not in x.filename
                    and x.file_size<25000
                    and ((x.external_attr>>16)&0o170000)!=0o120000
                    for x in info),"unsafe original source audit ZIP member")
        return {entry.filename:z.read(entry) for entry in info}


def parent_audit(raw,role):
    cfg=D08_AUDIT if role=="d08" else DUAL_AUDIT
    members=opened_zip(raw,cfg["artifact_sha256"])
    path=cfg["report_file"]
    require(path in members and sha256(members[path])==cfg["report_sha256"],
            role+": original independently audited source report SHA mismatch")
    report=parse(members[path])
    committed=report.get("report_sha256")
    require(type(committed) is str and SHA64.fullmatch(committed)
            and sha256(canonical({k:v for k,v in report.items()
                                  if k!="report_sha256"}))==committed,
            role+": original parent report self-commitment invalid")
    require(report.get("status")==cfg["report_status"],role+": original audit status invalid")
    if role=="d08":
        require(report.get("source_universe_blob")==PRIOR_SOURCE_BLOB
                and report.get("producer_code_head")==D08_AUDIT["head"]
                and report.get("d08_source_count")==1045459
                and report.get("d08_source_classes")=={
                    "FLASH_SWAP":1045392,"PROTOCOL_NATIVE_FLASH_LOAN":67}
                and report.get("d08_import_deterministically_replay_verified") is True
                and report.get("d11_terminal_closed") is False
                and report.get("native_source_universe_family_authentication_pinned") is False
                and report.get("external_nqc_native_gas_sponsors_approved")==0
                and report.get("nqc_realized_pnl_usd_wad")=="0",
                "D08 parent report claims unbacked executable market or gas")
    else:
        sources=report.get("original_source_family_evidence")
        require(report.get("original_d08_manifest_sha256")==ORIGINAL_D08_MANIFEST_SHA
                and report.get("original_workflow_conclusion")=="failure"
                and report.get("original_acquisition_job_conclusion")=="success"
                and report.get("total_native_historical_sources")==69815
                and report.get("historical_sources_recorded_execution_eligible")==0
                and report.get("historical_sources_recorded_executable_capital")==0
                and type(sources) is dict
                and all(sources[f].get("source_count_historical")==FAMILIES[f]["count"]
                        and sources[f].get("currently_execution_eligible_count")==0
                        and sources[f].get("positive_executable_capital_sources")==0
                        for f in ("BALANCER_V2_FLASH_LOAN","UNISWAP_V3_FLASH"))
                and report.get("nqc_externally_authorized_gas_sponsors")==0
                and report.get("rmc011_terminal_closed") is False
                and report.get("real_market_census_closed") is False,
                "dual-provider parent source report overstates eligibility or funding")
    return report


def verify_source_package(zip_raw):
    members=opened_zip(zip_raw,ORIGINAL_ZIP)
    expected={"SHA256SUMS","four-native-source-summary.json","adversarial-tests.txt",
              "producer-source.sha256"}|{
                  f"protocol-family-evidence/families/{name}/evidence.json"
                  for name in FAMILIES
              }
    require(set(members)==expected,
            "new four-family source archive has missing or injected entries")
    declared={}
    for line in members["SHA256SUMS"].decode("ascii").splitlines():
        fields=line.split("  ",1)
        require(len(fields)==2 and SHA64.fullmatch(fields[0]),
                "invalid original source SHA256SUMS")
        path=fields[1].removeprefix("./")
        require(path not in declared and path in expected-{"SHA256SUMS",
               "adversarial-tests.txt","producer-source.sha256"},
               "unrecognized/duplicate original per-family SHA manifest path")
        declared[path]=fields[0]
    needed=expected-{"SHA256SUMS","adversarial-tests.txt","producer-source.sha256"}
    require(set(declared)==needed and
            all(sha256(members[p])==digest for p,digest in declared.items()),
            "original four source member SHA256SUMS mismatch")
    require(sha256(members["four-native-source-summary.json"])==ORIGINAL_SUMMARY,
            "original four-source summary exact SHA mismatch")
    summary=parse(members["four-native-source-summary.json"])
    commitment=summary.get("report_sha256")
    require(type(commitment) is str and SHA64.fullmatch(commitment)
            and sha256(canonical({k:v for k,v in summary.items()
                                  if k!="report_sha256"}))==commitment,
            "producer summary internal commitment differs")
    require(summary.get("status")=="RMC011_FOUR_ORIGINAL_NATIVE_SOURCE_EVIDENCE_READY_NOT_TERMINAL"
            and summary.get("source_family_count")==4
            and summary.get("source_families")=={
                family:{"historically_observed_count":cfg["count"],
                        "evidence_member_sha256":cfg["sha256"]}
                for family,cfg in FAMILIES.items()}
            and summary.get("source_universe_git_blob")==PRIOR_SOURCE_BLOB
            and summary.get("code_commit")==ORIGINAL_HEAD
            and summary.get("code_tree")==ORIGINAL_TREE
            and summary.get("run_id")==ORIGINAL_RUN
            and summary.get("run_attempt")==1
            and summary.get("original_d08_manifest_sha256")==ORIGINAL_D08_MANIFEST_SHA
            and summary.get("original_balancer_and_univ3_execution_eligible_sources")==0
            and summary.get("original_d08_aave_and_univ2_execution_eligibility_certified_here") is False
            and summary.get("external_native_eth_gas_sponsors_admitted")==0
            and summary.get("family_universe_discovery_closed") is False
            and summary.get("rmc011_terminal_closed") is False
            and summary.get("real_market_census_closed") is False
            and summary.get("nqc_realized_net_usd_wad")=="0",
            "four-source witness producer summary is noncanonical or too strong")
    for family,cfg in FAMILIES.items():
        path=f"protocol-family-evidence/families/{family}/evidence.json"
        require(sha256(members[path])==cfg["sha256"],family+": immutable source member differs")
        record=parse(members[path])
        role=cfg["role"]
        parent=D08_AUDIT if role=="d08" else DUAL_AUDIT
        audit=record.get("source_independent_audit")
        need={
          "run_id":parent["run_id"],"head_sha":parent["head"],
          "artifact_id":parent["artifact_id"],
          "artifact_zip_sha256":parent["artifact_sha256"],
          "raw_report_sha256":parent["report_sha256"],
        }
        require(record.get("kind")=="AUTHENTICATED_REAL_SOURCE"
                and record.get("schema_version")==1
                and record.get("stage")=="RMC-011"
                and record.get("status")==
                  "HISTORICALLY_OBSERVED_PROTOCOL_SOURCE_NOT_EXECUTION_FINANCING"
                and record.get("family")==family
                and record.get("canonical_source_path")==cfg["path"]
                and record.get("source_scope")==
                  "FROZEN_D08_OR_D11_NATIVE_PROTOCOL_SOURCE_ONLY"
                and record.get("original_historical_source_count")==cfg["count"]
                and record.get("original_d08_authority_sha256")==ORIGINAL_D08_MANIFEST_SHA
                and record.get("original_observation_block_number")==26095351
                and audit==need
                and record.get("source_execution_eligible_count")==
                  (None if role=="d08" else 0)
                and record.get("source_execution_eligibility_not_yet_reconstructed") is
                  (role=="d08")
                and record.get("two_distinct_rpc_operators_verified") is
                  (role=="dual")
                and record.get("original_native_gas_external_sponsor_count")==0
                and record.get("nqc_capital_or_profit_positive_claimed") is False
                and record.get("global_source_nonexistence_claimed") is False
                and record.get("terminal_d11_closed") is False
                and record.get("workflow_name")==ORIGINAL_WORKFLOW
                and record.get("head_sha")==ORIGINAL_HEAD
                and record.get("code_tree")==ORIGINAL_TREE
                and record.get("run_id")==ORIGINAL_RUN
                and record.get("run_attempt")==1,
                family+": source does not match original claim/provenance/nonclaims")
    return summary


def verify(*,new_zip,d08_zip,dual_zip,runs,artifacts,
           source_universe,gas_registry,final_lock):
    require(gitblob(source_universe)==SOURCE_BLOB,
            "13-family source-universe Git blob does not match declared authority")
    require(gitblob(gas_registry)==GAS_REGISTRY_BLOB,
            "NQC external gas funding registry diverged")
    require(gitblob(final_lock)==FINAL_LOCK_BLOB,
            "RMC014 final Census source lock changed")
    u=parse(source_universe)
    g=parse(gas_registry)
    lock=parse(final_lock)
    by_id={r.get("id"):r for r in u.get("families",[]) if type(r) is dict}
    require(u.get("stage")=="RMC-011"
            and u.get("status")=="BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
            and u.get("d11_terminal_closed") is False
            and u.get("terminal_claim_allowed") is False
            and u.get("family_universe_discovery",{}).get("status")=="NOT_CERTIFIED"
            and u.get("family_universe_discovery",{}).get("evidence") is None
            and len(u.get("families",[]))==13 and len(by_id)==13
            and set(by_id)==set(FAMILIES)|SCOPED_BOUND_REJECTIONS|DEBT_REJECTIONS
            and all(r.get("terminally_resolved") is True for r in by_id.values())
            and all(by_id[f].get("status")==
                    "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
                    for f in SCOPED_BOUND_REJECTIONS|DEBT_REJECTIONS)
            and g.get("provider_count")==0 and g.get("providers")==[]
            and lock.get("status")=="BLOCKED"
            and lock.get("pinned_stages")==[]
            and lock.get("real_market_census_closed") is False,
            "13 source-family references are not bounded or D11 terminal was promoted")
    for role in ("new","d08","dual"):
        require_metadata(runs[role],artifacts[role],role)
    parent_audit(d08_zip,"d08")
    parent_audit(dual_zip,"dual")
    summary=verify_source_package(new_zip)
    for family,cfg in FAMILIES.items():
        ref=by_id[family].get("resolution_evidence")
        expect={
            "kind":"AUTHENTICATED_REAL_SOURCE",
            "repository":REPO,
            "workflow_name":ORIGINAL_WORKFLOW,
            "run_id":ORIGINAL_RUN,
            "head_sha":ORIGINAL_HEAD,
            "artifact_id":ORIGINAL_ARTIFACT,
            "artifact_name":ORIGINAL_NAME,
            "artifact_digest":"sha256:"+ORIGINAL_ZIP,
            "file":f"protocol-family-evidence/families/{family}/evidence.json",
            "sha256":cfg["sha256"],
        }
        require(by_id[family].get("status")=="AUTHENTICATED_REAL_SOURCE"
                and by_id[family].get("terminally_resolved") is True
                and by_id[family].get("real_source_path")==cfg["path"]
                and ref==expect,
                family+": canonical RMC011 source row disagrees with original four-family evidence")
    report={
        "schema_version":1,
        "status":"RMC011_THIRTEEN_SOURCE_FAMILY_TRANSPORT_REAUTHENTICATED_DISCOVERY_PENDING",
        "source_repo":REPO,
        "source_universe_blob_sha1":SOURCE_BLOB,
        "original_four_source_head":ORIGINAL_HEAD,
        "original_four_source_run":ORIGINAL_RUN,
        "original_four_source_artifact":ORIGINAL_ARTIFACT,
        "original_four_source_zip_sha256":ORIGINAL_ZIP,
        "parent_d08_audit_run":D08_AUDIT["run_id"],
        "parent_d08_report_sha256":D08_AUDIT["report_sha256"],
        "parent_dual_audit_run":DUAL_AUDIT["run_id"],
        "parent_dual_report_sha256":DUAL_AUDIT["report_sha256"],
        "source_family_count":13,
        "source_family_evidence_rows_addressed":13,
        "new_native_family_original_member_sha256":{
            family:cfg["sha256"] for family,cfg in sorted(FAMILIES.items())
        },
        "original_native_flash_source_observation_counts":{
            family:cfg["count"] for family,cfg in sorted(FAMILIES.items())
        },
        "original_d08_eligibility_for_aave_and_univ2_adjudicated":False,
        "original_d11_eligibility_for_balancer_univ3_positive":False,
        "family_universe_discovery_authenticated":False,
        "nqc_external_native_gas_provider_count":0,
        "economic_feasibility_terminally_certified":False,
        "positive_executable_pnl_certified":False,
        "nqc_realized_usd_wad":"0",
        "d11_terminal_closed":False,
        "real_market_census_closed":False,
    }
    report["report_sha256"]=sha256(canonical(report))
    return report


def main():
    parser=argparse.ArgumentParser()
    for key in ("new-zip","d08-zip","dual-zip","new-run","d08-run","dual-run",
                "new-artifact","d08-artifact","dual-artifact","report"):
        parser.add_argument("--"+key,type=Path,required=True)
    opts=parser.parse_args()
    require(not opts.report.exists(),"independent evidence append-only")
    paths={
        "new":(opts.new_run,opts.new_artifact),
        "d08":(opts.d08_run,opts.d08_artifact),
        "dual":(opts.dual_run,opts.dual_artifact),
    }
    result=verify(
        new_zip=opts.new_zip.read_bytes(),
        d08_zip=opts.d08_zip.read_bytes(),
        dual_zip=opts.dual_zip.read_bytes(),
        runs={k:parse(p[0].read_bytes()) for k,p in paths.items()},
        artifacts={k:parse(p[1].read_bytes()) for k,p in paths.items()},
        source_universe=Path("ci/nqc-census/rmc011-capital-source-universe.json").read_bytes(),
        gas_registry=Path("ci/nqc-census/rmc011-external-capital-provider-registry.json").read_bytes(),
        final_lock=Path("ci/nqc-census/final-census-authority-lock.json").read_bytes(),
    )
    opts.report.parent.mkdir(parents=True,exist_ok=True)
    opts.report.write_bytes(canonical(result))
    print(result["status"],"13_SOURCE_WITNESSES=TRUE DISCOVERY_AUTH=false",
          "D11_CLOSED=false GAS=0 PNL=0")


if __name__=="__main__":
    main()
