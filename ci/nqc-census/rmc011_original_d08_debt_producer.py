#!/usr/bin/env python3
"""Produce actual D08-backed bounded Aave debt rejection evidence from original ZIPs.

Read-only: frozen D06..D10 Actions artifacts, exact run and archive SHA256,
no Ethereum RPC, provider registration, native ETH, transaction, or gas sponsor.
No terminal RMC011 / Census claim. The original source evidence is required;
a synthetic replay cannot satisfy the gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
from zipfile import ZipFile

REPOSITORY = "josuechavando350-png/nexus-engine"
SOURCE_INPUT_BLOB = "1db0bbd78af36ee61dd6a44630a3b6614f3e9309"
SOURCE_UNIVERSE_BLOB = "6754a74c5c1e348c0c731618332ba8feba96834e"
PROVIDER_REGISTRY_BLOB = "a9c1427bb05828d08ade537899ee1b8e43b97ed2"
PERMISSIONLESS_BLOB = "100fd25c99217e82f4d5b00bd67b9c87be3d1afa"
COLLATERAL_BLOB = "d21b0731f76658121fbf1daf63bf9e19f742840e"
FINAL_LOCK_BLOB = "b1182b27b0ff3856b17a6f829ac3c693eab74400"
NATIVE_OR_DEBT = {
    "AAVE_V3_FLASH_LOAN", "UNISWAP_V2_FLASH_SWAP",
    "BALANCER_V2_FLASH_LOAN", "UNISWAP_V3_FLASH",
    "COLLATERALIZED_BORROWING", "PERSISTENT_DEBT",
}
DEBT = {"COLLATERALIZED_BORROWING", "PERSISTENT_DEBT"}
STAGES = ("d06", "d07", "d08", "d09", "d10")
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
ROOT = Path("ci/nqc-census")
CAPITAL = Path("nqc-census")


def require(ok: object, msg: str) -> None:
    if not ok:
        raise ValueError(msg)


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def gitblob(raw: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()


def canonical(o: object) -> bytes:
    return (json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def json_object(raw: bytes) -> dict:
    def unique(pairs):
        out = {}
        for k, v in pairs:
            require(k not in out, "duplicate authoritative JSON key")
            out[k] = v
        return out
    value = json.loads(raw, object_pairs_hook=unique)
    require(type(value) is dict, "JSON root must be object")
    return value


def verified_source(path: Path, expected_blob: str) -> dict:
    raw = path.read_bytes()
    require(0 < len(raw) < 50000 and gitblob(raw) == expected_blob,
            "source Git blob changed: " + str(path))
    return json_object(raw)


def validate_sources():
    paths = {
        "inputs": (ROOT / "rmc011-real-source-inputs.json", SOURCE_INPUT_BLOB),
        "universe": (ROOT / "rmc011-capital-source-universe.json", SOURCE_UNIVERSE_BLOB),
        "providers": (ROOT / "rmc011-external-capital-provider-registry.json", PROVIDER_REGISTRY_BLOB),
        "permissionless": (ROOT / "rmc011-permissionless-debt-facility-catalog.json", PERMISSIONLESS_BLOB),
        "collateral": (ROOT / "rmc011-collateral-funding-path-catalog.json", COLLATERAL_BLOB),
        "final": (ROOT / "final-census-authority-lock.json", FINAL_LOCK_BLOB),
    }
    d = {label: verified_source(*pair) for label, pair in paths.items()}
    input_file = d["inputs"]
    require(input_file.get("schema_version") == 3 and type(input_file.get("schema_version")) is int
            and input_file.get("repository") == REPOSITORY
            and set(input_file) == {"schema_version", "repository", *STAGES},
            "original exact upstream D06–D10 inputs changed")
    for key in STAGES:
        source = input_file[key]
        require(type(source) is dict and type(source.get("run_id")) is int
                and source["run_id"] > 0 and type(source.get("artifact_id")) is int
                and source["artifact_id"] > 0
                and type(source.get("head_sha")) is str and HEX40.fullmatch(source["head_sha"])
                and type(source.get("artifact_digest")) is str
                and source["artifact_digest"].startswith("sha256:")
                and HEX64.fullmatch(source["artifact_digest"][7:])
                and type(source.get("artifact_name")) is str
                and source["head_sha"] in source["artifact_name"]
                and type(source.get("authority_file")) is str
                and not source["authority_file"].startswith("/")
                and "\\" not in source["authority_file"]
                and ".." not in PurePosixPath(source["authority_file"]).parts,
                f"{key}: invalid exact upstream artifact commitment")
    u = d["universe"]
    families = u.get("families")
    require(u.get("schema_version") == 2 and u.get("stage") == "RMC-011"
            and u.get("status") == "BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
            and u.get("terminal_claim_allowed") is False
            and u.get("d11_terminal_closed") is False
            and u.get("family_universe_discovery", {}).get("status") == "NOT_CERTIFIED"
            and type(families) is list and len(families) == 13,
            "canonical seven-pinned source universe no longer partial")
    by_id = {row.get("id"): row for row in families}
    require(len(by_id) == 13
            and all(by_id[name].get("terminally_resolved") is False
                    and by_id[name].get("resolution_evidence") is None
                    for name in NATIVE_OR_DEBT)
            and sum(x.get("terminally_resolved") is True for x in families) == 7,
            "six unadmitted capital families misrepresented")
    for label, key, count_field, rows_field in (
        ("providers", "DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE", "provider_count", "providers"),
        ("permissionless", "DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE", "facility_count", "facilities"),
        ("collateral", "DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE", "path_count", "paths"),
    ):
        doc = d[label]
        require(doc.get("status") == key and type(doc.get(count_field)) is int
                and doc[count_field] == 0 and doc.get(rows_field) == [],
                f"non-operator {label} configuration gained an unverified source")
    lock = d["final"]
    require(lock.get("status") == "BLOCKED"
            and lock.get("real_market_census_closed") is False
            and lock.get("pinned_stages") == [],
            "final Census authority promoted prematurely")
    return d


def original_run_and_artifact(run: dict, artifact: dict, source: dict) -> None:
    rid = source["run_id"]
    aid = source["artifact_id"]
    head = source["head_sha"]
    require(type(run) is dict and run.get("id") == rid
            and type(run.get("id")) is int and run.get("status") == "completed"
            and run.get("conclusion") == "success"
            and run.get("head_sha") == head
            and run.get("name") == source["workflow_name"],
            "original producer workflow/head is not successful and exact")
    require(type(artifact) is dict and type(artifact.get("id")) is int
            and artifact.get("id") == aid
            and artifact.get("name") == source["artifact_name"]
            and artifact.get("digest") == source["artifact_digest"]
            and artifact.get("expired") is False
            and type(artifact.get("workflow_run")) is dict
            and artifact["workflow_run"].get("id") == rid
            and artifact["workflow_run"].get("head_sha") == head,
            "original ZIP identity, byte commitment, or expiration differs")


def verified_zip_members(z: ZipFile) -> None:
    rows = z.infolist()
    require(0 < len(rows) < 6000 and len({r.filename for r in rows}) == len(rows),
            "original archive has no members, duplicates or too many members")
    require(sum(r.file_size for r in rows) < 6_000_000_000,
            "original archived uncompressed source too large")
    for row in rows:
        n = row.filename
        require(not n.startswith("/") and "\\" not in n and
                ".." not in PurePosixPath(n).parts and
                row.file_size < 3_000_000_000 and
                ((row.external_attr >> 16) & 0o170000) != 0o120000,
                "original archived member path/symlink invalid")


def command(*args: str, cwd: Path | None = None) -> str:
    x = subprocess.run(list(args), cwd=cwd, check=True, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return x.stdout.strip()


def gh(path: str) -> dict:
    return json_object(command("gh", "api", path).encode())


def acquire_source(key: str, src: dict, work: Path, token: str) -> dict:
    require(key in STAGES, "non-declared upstream source")
    rid, aid, head = src["run_id"], src["artifact_id"], src["head_sha"]
    run = gh(f"repos/{REPOSITORY}/actions/runs/{rid}")
    art = gh(f"repos/{REPOSITORY}/actions/artifacts/{aid}")
    original_run_and_artifact(run, art, src)
    tree = gh(f"repos/{REPOSITORY}/git/commits/{head}").get("tree", {}).get("sha")
    require(type(tree) is str and HEX40.fullmatch(tree), f"{key}: original code tree unknown")
    archive = work / f"{key}-original.zip"
    raw_dir = work / f"{key}-raw"
    raw_dir.mkdir(exist_ok=False)
    url = f"https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{aid}/zip"
    # curl never uses --location-trusted, so Authorization is not forwarded
    # when GitHub redirects to a different host for the signed archive.
    subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location",
                    "--retry", "2", "--connect-timeout", "15", "--max-time", "240",
                    "-H", f"Authorization: Bearer {token}",
                    "-H", "Accept: application/vnd.github+json",
                    url, "-o", str(archive)], check=True)
    require(archive.stat().st_size > 0 and archive.stat().st_size < 200_000_000,
            f"{key}: original ZIP missing/oversize")
    original_sha = src["artifact_digest"][7:]
    require(digest(archive.read_bytes()) == original_sha,
            f"{key}: ORIGINAL artifact ZIP fails exact SHA256")
    with ZipFile(archive) as z:
        verified_zip_members(z)
        z.extractall(raw_dir)
    authority_path = raw_dir / src["authority_file"]
    require(authority_path.is_file(), f"{key}: required original authority manifest missing")
    authority_sha = digest(authority_path.read_bytes())
    stage = f"RMC-{int(key[1:]):03d}"
    print(f"RMC011_FROZEN_ORIGINAL_ARCHIVE_AUTHENTICATED stage={stage} run={rid} artifact={aid}", flush=True)
    return {"key": key, "stage": stage, "code_commit": head, "code_tree": tree,
            "artifact_sha256": original_sha, "run_id": rid, "artifact_id": aid,
            "authority_file": src["authority_file"], "authority_sha256": authority_sha}


def restore_anchor_authority(src: dict, rows: list[dict], work: Path) -> Path:
    d08 = json_object((work / "d08-raw" / src["d08"]["authority_file"]).read_bytes())
    anchor = d08.get("observation_anchor")
    fields=("chain_id","genesis_hash","fork_lineage","block_number",
            "block_hash","parent_hash","timestamp","state_root")
    require(type(anchor) is dict and all(field in anchor for field in fields),
            "original D08 authority missing canonical full block anchor")
    require([r["stage"] for r in rows] ==
            ["RMC-006","RMC-007","RMC-008","RMC-009","RMC-010"],
            "five upstream stages missing or reordered")
    candidate={
        "schema_version":1,
        "observation_anchor":{k:anchor[k] for k in fields},
        "stages":[{
            "stage":r["stage"],"code_commit":r["code_commit"],
            "code_tree":r["code_tree"],
            "artifact_sha256":"0x"+r["authority_sha256"]
        } for r in rows],
    }
    authority_candidate=work/"authority-candidate.json"
    authority=work/"authority-lock.json"
    authority_candidate.write_bytes(canonical(candidate))
    command(str(CAPITAL/"target/release/nqc-rmc011-authority-lock-build"),
            "--input", str(authority_candidate), "--output", str(authority))
    output=json_object(authority.read_bytes())
    require(output.get("schema_version")==1
            and type(output.get("stages")) is list and len(output["stages"])==5,
            "original upstream authority lock failed canonical Rust compilation")
    for key, row in zip(STAGES, rows):
        command("python3",str(ROOT/"verify_rmc011_upstream_authority.py"),
                "--stage",row["stage"],
                "--artifact-root",str(work/f"{key}-raw"),
                "--authority-file",row["authority_file"],
                "--lock",str(authority),
                "--expected-code-commit",row["code_commit"],
                "--expected-code-tree",row["code_tree"])
    print("RMC011_FIVE_ORIGINAL_STAGE_AUTHORITIES_RECONCILED", flush=True)
    return authority


def discover_d08_debt(src: dict, authority: Path, work: Path) -> dict:
    d08=work/"d08"
    d08.mkdir(exist_ok=False)
    for field in ("market_state_manifest","oracle_manifest",
                  "token_admission","pool_and_factory_facts","authority_file"):
        rel=src["d08"].get(field)
        require(type(rel) is str and rel.startswith("closeout/")
                and ".." not in PurePosixPath(rel).parts,
                f"D08 {field} original source path unavailable")
        orig=work/"d08-raw"/rel
        require(orig.is_file(),f"D08 {field} original raw bytes not published")
        shutil.copyfile(orig,d08/Path(rel).name)
    output=[]
    for suffix in ("first","second"):
        target=work/f"aave-debt-discovery-{suffix}.json"
        command(str(CAPITAL/"target/release/nqc-rmc011-aave-debt-discovery"),
                "--d08-market-state",str(d08/"market-state-manifest.jsonl"),
                "--d08-token-admission",str(d08/"token-admission.jsonl"),
                "--d08-pool-and-factory-facts",str(d08/"pool-and-factory-facts.json"),
                "--d08-evidence-manifest",str(d08/"evidence-manifest.json"),
                "--authority-lock",str(authority),
                "--out",str(target))
        output.append(target.read_bytes())
    require(output[0]==output[1],"original D08 Aave debt discovery replay nondeterministic")
    discovery=json_object(output[0])
    require(discovery.get("status")=="RMC011_AAVE_DEBT_DISCOVERY_PASS"
            and discovery.get("claim_scope")=="PROTOCOL_SIDE_DEBT_FACILITY_DISCOVERY_ONLY"
            and type(discovery.get("candidate_count")) is int
            and type(discovery.get("facility_count")) is int
            and type(discovery.get("rejected_count")) is int
            and discovery["candidate_count"]==
                discovery["facility_count"]+discovery["rejected_count"]
            and discovery.get("capital_source_count")==0
            and discovery.get("nqc_borrowing_capacity_claimed") is False
            and discovery.get("zero_own_capital_collateral_path_claimed") is False,
            "D08 historical protocol-side capacity falsely promoted to Nexus credit")
    reports=[]
    for suffix in ("first","second"):
        outfile=work/f"debt-family-resolution-{suffix}.json"
        command("python3",str(ROOT/"verify-rmc011-debt-family-resolution.py"),
                str(work/f"aave-debt-discovery-{suffix}.json"),str(outfile))
        reports.append(outfile.read_bytes())
    require(reports[0]==reports[1],"two-family debt bounded rejection nondeterministic")
    result=json_object(reports[0])
    require(result.get("status")=="RMC011_DEBT_FAMILY_EXHAUSTIVE_REJECTION_READY"
            and result.get("family_count")==2
            and {r["family"] for r in result.get("families",[])}==DEBT
            and all(r.get("outcome")=="EXHAUSTIVE_REJECTION"
                    for r in result["families"])
            and result.get("external_provider_count")==0
            and result.get("permissionless_debt_facility_count")==0
            and result.get("zero_own_capital_collateral_path_count")==0
            and result.get("global_nonexistence_claimed") is False
            and result.get("nqc_borrowing_capacity_claimed") is False
            and result.get("terminal_d11_closed") is False,
            "historical D08 results cannot support both scoped debt rejection proofs")
    print("RMC011_AUTHENTIC_ORIGINAL_D08_DEBT_REJECTIONS_READY=2 NQC_BORROWING=0",flush=True)
    return result


def publish(work: Path, rows: list[dict], result: dict, head: str, run_id: int, attempt: int):
    public=work/"public"
    public.mkdir(exist_ok=False)
    tree=command("git","rev-parse","HEAD^{tree}")
    member_hashes={}
    for row in result["families"]:
        family=row["family"]
        require(family in DEBT, "unexpected debt family emission")
        target=public/"debt-family-evidence"/"families"/family
        target.mkdir(parents=True,exist_ok=False)
        record={
            "schema_version":1,"stage":"RMC-011",
            "kind":"EXHAUSTIVE_REJECTION",
            "family":family,"scope":row["scope"],"basis":row["basis"],
            "workflow_name":os.environ["GITHUB_WORKFLOW"],
            "head_sha":head,"code_tree":tree,"run_id":run_id,"run_attempt":attempt,
            "original_d08_run_id":rows[2]["run_id"],
            "original_d08_archive_sha256":rows[2]["artifact_sha256"],
            "d08_authority_artifact_sha256":result["d08_authority_artifact_sha256"],
            "aave_coverage_commitment":result["aave_coverage_commitment"],
            "nonoperator_collateral_authorized":False,
            "nqc_borrowing_capacity_claimed":False,
            "global_nonexistence_claimed":False,
            "terminal_d11_closed":False
        }
        raw=canonical(record)
        (target/"evidence.json").write_bytes(raw)
        member_hashes[family]=digest(raw)
    require(len(member_hashes)==2,"exact two-family evidence count")
    report={
        "schema_version":1,
        "status":"RMC011_ORIGINAL_D08_TWO_DEBT_REJECTIONS_AUTHENTICATED_NOT_D11",
        "claim_scope":"NQC_ZERO_OWN_CAPITAL_EXECUTABLE_DEBT_UNIVERSE_AT_THIS_HEAD",
        "source_exact_head":head,"source_code_tree":tree,
        "source_workflow_name":os.environ["GITHUB_WORKFLOW"],
        "source_run_id":run_id,"source_run_attempt":attempt,
        "source_universe_sha1":SOURCE_UNIVERSE_BLOB,
        "source_upstream_input_sha1":SOURCE_INPUT_BLOB,
        "five_original_upstream_stage_sources":rows,
        "observed_aave_debt_candidate_count":result["aave_candidate_count"],
        "observed_aave_debt_facility_count":result["aave_facility_count"],
        "observed_aave_debt_rejection_count":result["aave_rejected_count"],
        "observed_debt_original_D08_authority":result["d08_authority_artifact_sha256"],
        "aave_original_debt_coverage_commitment":result["aave_coverage_commitment"],
        "original_two_bounded_debt_evidence_sha256":dict(sorted(member_hashes.items())),
        "nqc_authorized_external_gas_providers":0,
        "nqc_authorized_nonoperator_collateral_paths":0,
        "nqc_external_debt_executable_capacity_claimed":False,
        "global_external_credit_nonexistence_claimed":False,
        "original_127_winner_cost_ledger_recovered":False,
        "rmc011_terminal_closed":False,
        "nqc_realized_usd_wad":"0",
        "real_market_census_closed":False,
    }
    report["report_sha256"]=digest(canonical(report))
    (public/"original-source-report.json").write_bytes(canonical(report))
    files=sorted(f for f in public.rglob("*") if f.is_file())
    hashes=[f"{digest(f.read_bytes())}  {f.relative_to(public).as_posix()}" for f in files]
    (public/"SHA256SUMS").write_text("\n".join(hashes)+"\n")
    print("RMC011_ORIGINAL_D08_TWO_DEBT_REJECTIONS_SOURCE_ONLY D11_CLOSED=false",flush=True)


def run():
    parser=argparse.ArgumentParser()
    parser.add_argument("--work",type=Path,required=True)
    parser.add_argument("--exact-head",required=True)
    parser.add_argument("--run-id",type=int,required=True)
    parser.add_argument("--run-attempt",type=int,required=True)
    args=parser.parse_args()
    require(HEX40.fullmatch(args.exact_head)
            and args.exact_head==command("git","rev-parse","HEAD")
            and args.run_id>0 and args.run_attempt>0,
            "run must bind exact checked-out source head")
    require(os.environ.get("GITHUB_REPOSITORY")==REPOSITORY,
            "source repository differs")
    token=os.environ.get("GH_TOKEN")
    require(token,"read-only GitHub Actions token required")
    docs=validate_sources()
    work=args.work.resolve()
    require(not work.exists(),"append-only output root required")
    work.mkdir(parents=True)
    rows=[acquire_source(key,docs["inputs"][key],work,token) for key in STAGES]
    authority=restore_anchor_authority(docs["inputs"],rows,work)
    result=discover_d08_debt(docs["inputs"],authority,work)
    publish(work,rows,result,args.exact_head,args.run_id,args.run_attempt)


if __name__=="__main__":
    run()
