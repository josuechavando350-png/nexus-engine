#!/usr/bin/env python3
"""RMC-017: current source-locked Census gate readiness, never terminal authority.

An evidence readiness ledger is NOT a terminal certificate. In particular it
does not promote green code CI, a historical flash-liquidation fork, an external
paymaster with its own balance, or a D16 zero-capture capacity report.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

SOURCES={
    "rmc011_source_universe":(
        "ci/nqc-census/rmc011-capital-source-universe.json",
        "8f42e9ab127cc567409c20383de3fea4e3618e5f"),
    "rmc011_approved_providers":(
        "ci/nqc-census/rmc011-external-capital-provider-registry.json",
        "a9c1427bb05828d08ade537899ee1b8e43b97ed2"),
    "rmc012_terminal_inputs":(
        "ci/nqc-census/rmc012-terminal-inputs.json",
        "5f2694c73568938099a62978476eae37a32db9bb"),
    "rmc013_terminal_inputs":(
        "ci/nqc-census/rmc013-terminal-inputs.json",
        "72b1e612732aec8118bed320bc4e55e9f206514d"),
    "rmc014_structural_lock":(
        "ci/nqc-census/final-census-authority-lock.json",
        "b1182b27b0ff3856b17a6f829ac3c693eab74400"),
    "rmc015_trigger_inputs":(
        "ci/nqc-census/rmc015-trigger-inputs.json",
        "6859795b3d976db4a5f7dd64ffb6eabcd4a7baad"),
    "rmc016_capacity_inputs":(
        "ci/nqc-census/rmc016-capacity-inputs.json",
        "7fec5200a97ed56cb07501af5f66b66cfcb758c6"),
    "rmc016_real_evidence":(
        "ci/nqc-census/rmc016-production-evidence.json",
        "5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa"),
}
D17_SOURCE_COMMIT = "eda95cbb90aa12ae69a13b4fbc41f1e0b9cba2a3"
D17_SOURCE_BLOB = "3cf64b2bdfb9891033850683d8aecf056612d4cb"
D17_FOUNDATION_URI = "ci/nqc-census/rmc017-final-inputs.json"
REQUIRED_STAGE_NAMES=tuple(f"RMC-{x:03d}" for x in range(6,14))
REQUIRED_GAS_FAMILIES=("EXTERNAL_GAS_CREDIT","EXTERNAL_GAS_SPONSOR")


def need(ok,msg):
    if not ok:raise ValueError(msg)


def gitblob(raw):
    return hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canon(d):
    return (json.dumps(d,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def read_json(raw):
    def unique_pairs(pairs):
        result={}
        for k,v in pairs:
            need(k not in result,"duplicate authoritative JSON field")
            result[k]=v
        return result
    d=json.loads(raw,object_pairs_hook=unique_pairs)
    need(type(d) is dict,"authority input not object")
    return d


def read_stage_sources(repo_root):
    out={}
    for name,(path,expected) in SOURCES.items():
        p=repo_root/path
        need(p.is_file(),"missing exact source authority: "+path)
        raw=p.read_bytes()
        need(0<len(raw)<50000 and gitblob(raw)==expected,
             "RMC source Git blob drift: "+name)
        out[name]=read_json(raw)
    return out


def validate_local_sources(data, d17):
    need(set(data)==set(SOURCES),"readiness requires exact eight local source inputs")
    u=data["rmc011_source_universe"]
    need(u.get("schema_version")==2 and type(u.get("schema_version")) is int
         and u.get("stage")=="RMC-011"
         and u.get("status")=="BLOCKED_INCOMPLETE_SOURCE_UNIVERSE"
         and u.get("terminal_claim_allowed") is False
         and u.get("d11_terminal_closed") is False
         and u.get("family_universe_discovery",{}).get("status")=="NOT_CERTIFIED",
         "RMC011 source family universe not in audited blocked condition")
    families=u.get("families")
    need(type(families) is list and len(families)==13
         and len({x.get("id") for x in families})==13
         and all(x.get("terminally_resolved") is False and
                 x.get("resolution_evidence") is None for x in families),
         "RMC011 13 real provider/permissionless family source claims changed")
    gas_families={x["id"] for x in families if x.get("capital_class")=="GAS_FUNDING"}
    need(gas_families==set(REQUIRED_GAS_FAMILIES),
         "exact gas funder classes not conserved")
    external=data["rmc011_approved_providers"]
    need(external.get("stage")=="RMC-011" and external.get("schema_version")==1
         and external.get("status")=="DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE"
         and external.get("provider_count")==0 and type(external.get("provider_count")) is int
         and external.get("providers")==[]
         and all(f in external.get("provider_backed_families",[]) for f in REQUIRED_GAS_FAMILIES)
         and "EMPTY_REGISTRY_IS_NOT_GLOBAL_PROVIDER_NONEXISTENCE" in external.get("non_claims",[]),
         "zero authorized provider source not exact")
    d12=data["rmc012_terminal_inputs"]
    need(d12.get("schema_version")==2 and type(d12.get("schema_version")) is int
         and d12.get("status")=="BLOCKED_AWAITING_CERTIFIED_RMC011"
         and d12.get("d11") is None,
         "RMC012 source dependency incorrectly promoted")
    d13=data["rmc013_terminal_inputs"]
    need(d13.get("status")=="BLOCKED_AWAITING_CERTIFIED_RMC012_AND_EXECUTION_EVIDENCE"
         and d13.get("d12") is None and d13.get("execution_evidence") is None
         and len(d13.get("blocking_reasons",[]))==2,
         "RMC013 unsupported economics admission")
    d14=data["rmc014_structural_lock"]
    need(d14.get("schema_version")==3 and type(d14.get("schema_version")) is int
         and d14.get("status")=="BLOCKED"
         and d14.get("required_terminal_stages")==list(REQUIRED_STAGE_NAMES)
         and d14.get("pinned_stages")==[]
         and d14.get("pipeline_counts") is None
         and d14.get("economic_boundary") is None
         and d14.get("terminal_evidence")==[]
         and d14.get("rmc014_structural_chain_certified") is False
         and d14.get("real_market_census_closed") is False
         and d14.get("final_census_authority_stage")=="RMC-017"
         and d14.get("downstream_authorities_required")==["RMC-015","RMC-016","RMC-017"]
         and len(d14.get("blocking_reasons",[]))==7,
         "RMC014 structural lock falsely claimed terminal pinned")
    d15=data["rmc015_trigger_inputs"]
    need(d15.get("status")=="BLOCKED_AWAITING_RMC014_STRUCTURAL_AND_HISTORICAL_WINDOW"
         and d15.get("rmc014") is None and d15.get("historical_window") is None
         and d15.get("provider_authorities")==[]
         and len(d15.get("blocking_reasons",[]))==4
         and "NO_CENSUS_CLOSEOUT" in d15.get("non_claims",[]),
         "RMC015 temporal full-window authority falsely claimed")
    d16=data["rmc016_capacity_inputs"]
    need(d16.get("status")=="PINNED"
         and d16.get("conservative_realizable_capacity_only") is True
         and d16.get("capture_probability")=="UNCALIBRATED"
         and d16.get("capture_adjusted_capacity_claimed") is False
         and d16.get("global_market_maximum_claimed") is False
         and d16.get("production_evidence",{}).get("path")==
             "ci/nqc-census/rmc016-production-evidence.json",
         "RMC016 D16 source includes unsubstantiated capture")
    econ=data["rmc016_real_evidence"]
    risk=econ.get("authority",{})
    need(econ.get("status")=="RMC016_CONSERVATIVE_REALIZABLE_CAPACITY_PASS"
         and econ.get("schema_version")==1 and type(econ.get("schema_version")) is int
         and risk.get("nqc_capture_probability_lower_bound_wad")=="0"
         and risk.get("nqc_conservative_realizable_monthly_capacity_usd_wad")=="0"
         and risk.get("nqc_conservative_realizable_daily_capacity_usd_wad")=="0"
         and risk.get("nqc_conservative_realizable_capacity_usd_wad")=="0"
         and risk.get("definite_episode_count")==139
         and risk.get("definite_transaction_count")==127
         and risk.get("month1_300k_target_proven") is False
         and risk.get("zero_own_capital_not_overridden") is True
         and "NO_NQC_REALIZED_PNL" in risk.get("non_claims",[]),
         "positive NQC capacity/realized PnL is not source-supported")
    need(type(d17) is dict and d17.get("schema_version")==1
         and type(d17.get("schema_version")) is int
         and d17.get("status")=="BLOCKED_AWAITING_RMC014_RMC015_RMC016"
         and d17.get("rmc014") is None and d17.get("rmc015") is None
         and d17.get("rmc016") is None
         and d17.get("real_market_census_closed") is False
         and d17.get("blocking_reasons")==[
            "RMC014_STRUCTURAL_AUTHORITY_NOT_PINNED",
            "RMC015_TEMPORAL_AUTHORITY_NOT_PINNED",
            "RMC016_CAPACITY_AUTHORITY_NOT_PINNED",
         ],"separate D17 source foundation cannot claim terminal admission")
    return {
       "schema_version":1,
       "status":"RMC017_READINESS_EVIDENCE_BLOCKED_NO_TERMINAL_CERTIFICATE",
       "source_git_blobs":{name:objid for name,(_,objid) in sorted(SOURCES.items())},
       "d17_independent_foundation_commit":D17_SOURCE_COMMIT,
       "d17_independent_foundation_blob_sha1":D17_SOURCE_BLOB,
       "pft_certified_commit":d14["pft_certified_commit"],
       "pft_certified_tree":d14["pft_certified_tree"],
       "rmc011_required_capital_families":len(families),
       "rmc011_terminally_resolved_families":0,
       "rmc011_approved_external_providers":0,
       "rmc011_global_external_provider_nonexistence_proven":False,
       "rmc012_terminal_authority_obtained":False,
       "rmc013_complete_execution_economics_authority_obtained":False,
       "rmc014_required_structural_stages":len(REQUIRED_STAGE_NAMES),
       "rmc014_structural_stage_pins_in_canonical_source_lock":0,
       "rmc014_structural_blockers_declared":len(d14["blocking_reasons"]),
       "rmc015_temporal_authority_pinned":False,
       "rmc015_historical_window_declared":False,
       "rmc015_structural_and_provider_sources_ready":False,
       "rmc016_pre_shadow_conservative_model_report_pass":True,
       "rmc016_127_historical_competitor_receipts_observed":risk["definite_transaction_count"],
       "rmc016_nqc_ex_ante_capture_probability_calibrated":False,
       "rmc016_conservative_nqc_monthly_capacity_usd_wad":"0",
       "rmc017_final_all_three_authorities_pinned":False,
       "rmc017_ready_for_terminal_certificate":False,
       "nqc_zero_owned_capital_production_liquidation_authorized":False,
       "nqc_realized_profitability_proven":False,
       "real_market_census_closed":False,
       "engineering_percentage_certifiable_from_these_locks":False,
       "next_reconciliations_in_dependency_order":[
           "D11_REAL_CAPITAL_FAMILY_RESOLUTION_WITH_AUTHENTICATED_REJECTIONS_OR_PROVIDER_EVIDENCE",
           "D12_SOURCE_REPLAY_TERMINAL_ACTIONABILITY_AFTER_D11",
           "D13_EXHAUSTIVE_EXECUTION_ECONOMICS_AFTER_D12",
           "D14_REAUTHENTICATE_AND_PIN_ALL_EIGHT_STRUCTURAL_AUTHORITIES",
           "D15_PIN_HISTORICAL_WINDOW_DUAL_RPC_TEMPORAL_EPISODES_NO_LOOKAHEAD",
           "D16_REAUTHENTICATE_CONSERVATIVE_REALIZABLE_CAPACITY_NO_CAPTURE_OVERCLAIM",
           "D17_INDEPENDENT_THREE_AUTHORITY_CERTIFICATE_ONLY_WHEN_ALL_PASS",
       ],
       "important_distinctions":[
           "A_REAL_EXTERNAL_PAYMASTER_DEPOSIT_IS_NOT_ALLOCATED_NATIVE_ETH_TO_NQC",
           "TECHNICAL_FORK_PROFIT_AFTER_FLASH_IS_NOT_CAPTURED_NQC_NET_PNL",
           "ZERO_MONTHLY_CERTIFIED_CAPACITY_IS_A_LOWER_BOUND_NOT_GLOBAL_ZERO_PROFIT_PREDICTION",
           "GREEN_FOUNDATION_AND_AUXILIARY_CI_ARE_NOT_TERMINAL_CENSUS_CERTIFICATES",
           "CONSERVATIVE_NEGATIVE_CENSUS_IS_A_VALID_RESULT_AFTER_EXHAUSTIVE_RECONCILIATION",
       ],
    }


def assess(repo_root: Path, d17_path: Path):
    stage=read_stage_sources(repo_root)
    raw=d17_path.read_bytes()
    need(0<len(raw)<4000 and gitblob(raw)==D17_SOURCE_BLOB,
         "independent RMC017 foundation source Git blob drift")
    report=validate_local_sources(stage,read_json(raw))
    report["report_sha256"]=digest(canon(report))
    return report


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--repo-root",type=Path,default=Path("."))
    parser.add_argument("--d17-source-file",type=Path,required=True)
    parser.add_argument("--out",type=Path,required=True)
    options=parser.parse_args()
    need(not options.out.exists(),"append-only readiness ledger")
    result=assess(options.repo_root,options.d17_source_file)
    options.out.parent.mkdir(parents=True,exist_ok=True)
    options.out.write_bytes(canon(result))
    print(result["status"],"D11 unresolved families",result["rmc011_required_capital_families"],
          "D14 stages pinned",result["rmc014_structural_stage_pins_in_canonical_source_lock"],
          "NQC independent gas sources",result["rmc011_approved_external_providers"],
          "NQC certified monthly PnL capacity WAD",result["rmc016_conservative_nqc_monthly_capacity_usd_wad"],
          "CENSUS_CLOSED=false")


if __name__=="__main__":
    main()
