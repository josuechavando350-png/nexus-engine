#!/usr/bin/env python3
"""Independent verification of actual historical RMC011 Balancer/UniV3 sources.

Input: one existing, immutable GitHub Actions original 443-MB ZIP. The
original acquisition JOB succeeded but its encompassing workflow RUN FAILED
in a later closeout job. We authenticate that distinction, all 30,030
original member hashes, both capture operators, full exact source census,
and zero executable token capacity under the admitted historic token truth.

No RPC, on-chain tx, operator-owned funding, gas sponsorship, borrower upload,
or RMC-011/Census terminal authority may be claimed from this audit.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from zipfile import ZipFile

REPOSITORY="josuechavando350-png/nexus-engine"
PRODUCER_RUN_ID=37689816997
PRODUCER_JOB_ID=113026823480
PRODUCER_HEAD="ea488b9dc13b690921416dd11c4369cfb76912e5"
PRODUCER_TREE="095942bdca0ef08b835d66e6807f30ccb8d601ff"
PRODUCER_WORKFLOW="NQC RMC-011 Real Source Certification"
PRODUCER_JOB="authoritative-real-source-certification"
SOURCE_ARTIFACT_ID=11514391050
SOURCE_ARTIFACT_NAME=f"rmc011-live-acquisition-{PRODUCER_HEAD}"
SOURCE_ZIP_SHA256="a0ab50b41f5653e7749dc7360eb8006f3f088477372654ade9d966b3373f006f"
SOURCE_UNIVERSE_BLOB="c1b9f136a13f220af9dceaae50e5caa3105121eb"
PROVIDER_BLOB="a9c1427bb05828d08ade537899ee1b8e43b97ed2"
FINAL_LOCK_BLOB="b1182b27b0ff3856b17a6f829ac3c693eab74400"
PINNED_ANCHOR={
    "chain_id":1,
    "block_number":26095351,
    "block_hash":"0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781",
    "state_root":"0x295ca34af4c1652ded4210d6353703c7acea726c04c27978df4a3a88d9e7bbfd",
    "timestamp":1790832215,
}
AUTHORITY_LOCK_SHA256="7f48d35f0373785ff2fbd6f84b385efe58dbb831f6c3cc7953adb50e3c999d95"
D08_MANIFEST_SHA256="1276491d349176fdd0ac63aaaa2c326c002c1a17384ba1e6db4704687842a279"
FAMILIES={
    "BALANCER_V2_FLASH_LOAN":{
        "prefix":"rmc011-balancer-v2",
        "status":"RMC011_BALANCER_V2_DUAL_PROVIDER_RECONCILED",
        "source_count":67,
        "providers":("blastapi-public","mevblocker-rpc"),
        "capture_files":("capture-blastapi-public.json","capture-mevblocker-rpc.json"),
        "capture_digests":(
            "5bf392664e82b0ad6ca9e9db8238e699cae68f43a5db8511cb103ff494c9f712",
            "468d5cb87b2b19f6c8f69c69192bcb9358d08246ccadf2e6539c0af41a9ee1d5",
        ),
        "reconciliation_sha256":"bf93eb4ee786995123781241e8f159ffe50cb4cfbb909b814ebc2c495f690b02",
        "zero_liquidity_rows":0,
    },
    "UNISWAP_V3_FLASH":{
        "prefix":"rmc011-uniswap-v3",
        "status":"RMC011_UNISWAP_V3_DUAL_PROVIDER_RECONCILED",
        "source_count":69748,
        "providers":("mevblocker-rpc","tenderly-public"),
        "capture_files":("capture-mevblocker-rpc.json","capture-tenderly-public.json"),
        "capture_digests":(
            "97e12a00e98891f51ff0ceeb2aba5d998198fb1f24ca91bbbe31786f5d2f8263",
            "4be3f830f0ab48af8122265026044a4cdded64d5033a0a65225a3a43f15a039d",
        ),
        "reconciliation_sha256":"6337a671a405e427a7ae9f2479651e3d4e2e96da55bed652999c4b452e542143",
        "zero_liquidity_rows":28235,
    }
}
REQUIRED_TOKEN_BLOCKERS={
    "FEE_ON_TRANSFER_UNPROVEN","REBASING_UNPROVEN","TRANSFER_HOOKS_UNPROVEN"
}
H64=re.compile("[0-9a-f]{64}\\Z")
H40=re.compile("[0-9a-f]{40}\\Z")


def need(ok,why):
    if not ok: raise ValueError(why)


def canonical(d):
    return (json.dumps(d,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def gitblob(b):
    return hashlib.sha1(b"blob "+str(len(b)).encode()+b"\0"+b).hexdigest()


def json_obj(raw):
    def unique(pairs):
        out={}
        for k,v in pairs:
            need(k not in out,"duplicate JSON object key")
            out[k]=v
        return out
    doc=json.loads(raw,object_pairs_hook=unique)
    need(type(doc) is dict,"JSON root is not object")
    return doc


def verify_producer(run,job,artifact,commit):
    need(type(run) is dict and type(run.get("id")) is int
         and run["id"]==PRODUCER_RUN_ID and run.get("status")=="completed"
         and run.get("conclusion")=="failure" and run.get("event")=="push"
         and run.get("head_sha")==PRODUCER_HEAD
         and run.get("name")==PRODUCER_WORKFLOW
         and type(run.get("run_attempt")) is int and run["run_attempt"]==1,
         "original overall run must be recorded as FAILED, not falsely certified")
    need(type(job) is dict and type(job.get("id")) is int
         and job["id"]==PRODUCER_JOB_ID and job.get("run_id")==PRODUCER_RUN_ID
         and job.get("name")==PRODUCER_JOB
         and job.get("status")=="completed" and job.get("conclusion")=="success",
         "original acquisition producing job not independently successful")
    need(type(artifact) is dict and type(artifact.get("id")) is int
         and artifact["id"]==SOURCE_ARTIFACT_ID and artifact.get("expired") is False
         and artifact.get("name")==SOURCE_ARTIFACT_NAME
         and artifact.get("digest")=="sha256:"+SOURCE_ZIP_SHA256
         and type(artifact.get("workflow_run")) is dict
         and artifact["workflow_run"].get("id")==PRODUCER_RUN_ID
         and artifact["workflow_run"].get("head_sha")==PRODUCER_HEAD,
         "original immutable artifact identity/digest/head mismatch")
    need(type(commit) is dict and commit.get("sha")==PRODUCER_HEAD
         and type(commit.get("tree")) is dict
         and commit["tree"].get("sha")==PRODUCER_TREE,
         "original D11 capture code commit/tree changed")


def verify_archive(archive_path:Path):
    need(archive_path.is_file() and 0<archive_path.stat().st_size<650_000_000,
         "original ZIP unavailable or unsafe size")
    h=hashlib.sha256()
    with archive_path.open("rb") as stream:
        for chunk in iter(lambda:stream.read(8*1024*1024),b""):
            h.update(chunk)
    need(h.hexdigest()==SOURCE_ZIP_SHA256,
         "original 443MB archive outer SHA-256 differs")
    with ZipFile(archive_path) as archive:
        members=archive.infolist()
        names=[f.filename for f in members]
        need(len(names)==30031 and len(set(names))==30031,
             "original 30031 ZIP member identity incomplete or duplicated")
        need(set(n.split("/",1)[0] for n in names)=={
             "LIVE-ACQUISITION-SHA256SUMS","rmc011-balancer-v2","rmc011-uniswap-v3"},
             "unexpected original source root")
        need(sum(m.file_size for m in members)<600_000_000,
             "original ZIP uncompressed files exceed audited safety boundary")
        for m in members:
            n=m.filename
            need(not m.is_dir() and n and not n.startswith("/")
                 and "\\" not in n and ".." not in PurePosixPath(n).parts
                 and m.file_size<250_000_000
                 and ((m.external_attr>>16)&0o170000)!=0o120000,
                 "unsafe original archived symlink/path/oversized member")
        lines=archive.read("LIVE-ACQUISITION-SHA256SUMS").decode("ascii").splitlines()
        digests={}
        for line in lines:
            parts=line.split("  ",1)
            need(len(parts)==2 and bool(H64.fullmatch(parts[0])),
                 "invalid original 30030-member SHA256SUMS")
            path=parts[1].removeprefix("./")
            need(path not in digests,"duplicate SHA256SUMS path")
            digests[path]=parts[0]
        need(set(digests)==set(names)-{"LIVE-ACQUISITION-SHA256SUMS"}
             and len(digests)==30030,
             "original manifest member set incomplete")
        for member in members:
            path=member.filename
            if path=="LIVE-ACQUISITION-SHA256SUMS":continue
            hasher=hashlib.sha256()
            with archive.open(member) as stream:
                for chunk in iter(lambda:stream.read(1024*1024),b""):
                    hasher.update(chunk)
            need(hasher.hexdigest()==digests[path],
                 "original 30030-member manifest byte mismatch")
        result={}
        for family,contract in FAMILIES.items():
            captures=[]
            for filename,expected_hash,provider in zip(
                    contract["capture_files"],contract["capture_digests"],
                    contract["providers"]):
                path=contract["prefix"]+"/"+filename
                need(digests.get(path)==expected_hash,
                     "original two-provider capture SHA mismatch")
                d=json_obj(archive.read(path))
                need(d.get("schema_version")==1 and type(d.get("schema_version")) is int
                     and d.get("stage")=="RMC-011" and d.get("family")==family
                     and d.get("provider_id")==provider
                     and type(d.get("provider_operator")) is str
                     and d.get("authority_lock_sha256")==AUTHORITY_LOCK_SHA256
                     and d.get("d08_evidence_manifest_sha256")==D08_MANIFEST_SHA256
                     and type(d.get("anchor")) is dict
                     and all(d["anchor"].get(k)==v for k,v in PINNED_ANCHOR.items()),
                     family+": original provider is not authenticated to canonical D08 block")
                if family=="UNISWAP_V3_FLASH":
                    need(d.get("pool_universe_sha256")==
                         "3fce7100280a5358ddde433347338b4c4684be3691fd87ebd8801ce65077c9e7"
                         and type(d.get("pools")) is list and len(d["pools"])==69287,
                         "UniV3 original pool-event universe mismatch")
                else:
                    need(d.get("asset_universe_sha256")==
                         "805b74260db9c7d7c03fe575e04269e603b9c5624f3eabd552e05178ed780fad"
                         and type(d.get("assets")) is list and len(d["assets"])==67,
                         "Balancer original source asset universe mismatch")
                captures.append({
                    "provider_id":provider,
                    "provider_operator":d["provider_operator"],
                    "rpc_endpoint_hash":d["rpc_endpoint_hash"],
                    "raw_capture_sha256":expected_hash,
                })
                del d
            need(captures[0]["provider_operator"]!=captures[1]["provider_operator"]
                 and captures[0]["rpc_endpoint_hash"]!=captures[1]["rpc_endpoint_hash"],
                 family+": duplicated provider operator or RPC endpoint")
            reconciliation_path=contract["prefix"]+"/reconciled-rust.json"
            need(digests.get(reconciliation_path)==contract["reconciliation_sha256"],
                 family+": original Rust reconciliation SHA not independently sourced")
            obj=json_obj(archive.read(reconciliation_path))
            sources=obj.get("sources")
            need(obj.get("schema_version")==1 and type(obj.get("schema_version")) is int
                 and obj.get("stage")=="RMC-011" and obj.get("status")==contract["status"]
                 and obj.get("family")==family and obj.get("provider_count")==2
                 and type(obj.get("provider_count")) is int
                 and obj.get("first_capture_sha256")==contract["capture_digests"][0]
                 and obj.get("second_capture_sha256")==contract["capture_digests"][1]
                 and type(obj.get("source_count")) is int
                 and obj["source_count"]==contract["source_count"]
                 and type(sources) is list and len(sources)==contract["source_count"],
                 family+": source conservation or dual-provider reconciliation false")
            ids=set()
            keys=set()
            blocks=Counter()
            for item in sources:
                need(type(item) is dict and type(item.get("source_id")) is str
                     and type(item.get("source_key_id")) is str
                     and item["source_id"] not in ids and item["source_key_id"] not in keys,
                     family+": duplicate source identifier")
                ids.add(item["source_id"])
                keys.add(item["source_key_id"])
                blockers=item.get("execution_blockers")
                need(item.get("execution_eligible") is False
                     and item.get("executable_capacity")=="0"*64
                     and type(blockers) is list
                     and all(type(x) is str for x in blockers)
                     and REQUIRED_TOKEN_BLOCKERS<=set(blockers),
                     family+": original historic source mistakenly treated executable")
                blocks.update(blockers)
            need(blocks.get("UNISWAP_V3_ZERO_ACTIVE_LIQUIDITY",0)==
                 contract["zero_liquidity_rows"],family+": original zero-liquidity count differs")
            result[family]={
                "source_count_historical":contract["source_count"],
                "source_id_unique_count":len(ids),
                "source_key_unique_count":len(keys),
                "currently_execution_eligible_count":0,
                "positive_executable_capital_sources":0,
                "capture_witnesses":captures,
                "reconciled_rust_sha256":contract["reconciliation_sha256"],
                "execution_blocker_counts":dict(sorted(blocks.items())),
            }
            del obj
    return result


def audit(*,archive_path,run,job,artifact,commit,
          capital_source_universe,provider_registry,final_census_lock):
    need(gitblob(capital_source_universe)==SOURCE_UNIVERSE_BLOB,
         "nine-family source universe input drifted")
    need(gitblob(provider_registry)==PROVIDER_BLOB,
         "NQC external gas provider source changed")
    need(gitblob(final_census_lock)==FINAL_LOCK_BLOB,
         "final Census source authority changed")
    u=json_obj(capital_source_universe)
    registry=json_obj(provider_registry)
    final=json_obj(final_census_lock)
    need(u.get("stage")=="RMC-011"
         and u.get("status")=="BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
         and u.get("d11_terminal_closed") is False
         and u.get("terminal_claim_allowed") is False
         and len(u.get("families",[]))==13
         and sum(x.get("terminally_resolved") is True for x in u["families"])==9
         and {x["id"] for x in u["families"] if not x["terminally_resolved"]}==
            {"AAVE_V3_FLASH_LOAN","UNISWAP_V2_FLASH_SWAP",*FAMILIES},
         "nine-of-thirteen capital family boundary drifted")
    need(registry.get("provider_count")==0 and type(registry.get("provider_count")) is int
         and registry.get("providers")==[]
         and final.get("status")=="BLOCKED"
         and final.get("real_market_census_closed") is False
         and final.get("pinned_stages")==[],
         "NQC gas sponsor/Census authority falsely admitted")
    verify_producer(run,job,artifact,commit)
    families=verify_archive(Path(archive_path))
    report={
        "schema_version":1,
        "status":"RMC011_ORIGINAL_DUAL_PROVIDER_NATIVE_FLASH_OBSERVED_ZERO_EXECUTABLE_NOT_D11",
        "source_repository":REPOSITORY,
        "original_capture_producer_run_id":PRODUCER_RUN_ID,
        "original_capture_producer_job_id":PRODUCER_JOB_ID,
        "original_capture_producer_head":PRODUCER_HEAD,
        "original_capture_producer_tree":PRODUCER_TREE,
        "original_workflow_conclusion":"failure",
        "original_acquisition_job_conclusion":"success",
        "original_artifact_id":SOURCE_ARTIFACT_ID,
        "original_artifact_zip_sha256":SOURCE_ZIP_SHA256,
        "original_internal_sha256_manifest_entries":30030,
        "original_observation_anchor":PINNED_ANCHOR,
        "original_authority_lock_sha256":AUTHORITY_LOCK_SHA256,
        "original_d08_manifest_sha256":D08_MANIFEST_SHA256,
        "original_source_family_evidence":families,
        "total_native_historical_sources":sum(v["source_count_historical"] for v in families.values()),
        "historical_sources_recorded_execution_eligible":0,
        "historical_sources_recorded_executable_capital":0,
        "native_families_present_in_historic_capture_only":sorted(FAMILIES),
        "independently_admitted_family_terminal_closeout":False,
        "global_protocol_liquidity_nonexistence_claimed":False,
        "current_market_capture_claimed":False,
        "nqc_externally_authorized_gas_sponsors":0,
        "nqc_realized_profit_usd_wad":"0",
        "rmc011_terminal_closed":False,
        "real_market_census_closed":False,
    }
    report["report_sha256"]=sha256(canonical(report))
    return report


def main():
    cli=argparse.ArgumentParser()
    for field in ("zip","run-meta","job-meta","artifact-meta","commit-meta","report"):
        cli.add_argument("--"+field,required=True,type=Path)
    opts=cli.parse_args()
    need(not opts.report.exists(),"append-only source truth report destination")
    report=audit(
        archive_path=opts.zip,
        run=json_obj(opts.run_meta.read_bytes()),
        job=json_obj(opts.job_meta.read_bytes()),
        artifact=json_obj(opts.artifact_meta.read_bytes()),
        commit=json_obj(opts.commit_meta.read_bytes()),
        capital_source_universe=Path("ci/nqc-census/rmc011-capital-source-universe.json").read_bytes(),
        provider_registry=Path("ci/nqc-census/rmc011-external-capital-provider-registry.json").read_bytes(),
        final_census_lock=Path("ci/nqc-census/final-census-authority-lock.json").read_bytes(),
    )
    opts.report.parent.mkdir(parents=True,exist_ok=True)
    opts.report.write_bytes(canonical(report))
    print(report["status"],"SOURCES",report["total_native_historical_sources"],
          "EXECUTION_ELIGIBLE=0 REALIZED_PNL=0 D11_CLOSED=false")


if __name__=="__main__":
    main()
