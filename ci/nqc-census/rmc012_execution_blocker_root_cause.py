#!/usr/bin/env python3
"""Source-authenticated RMC012 reject-root-cause/asset priorities; never token admission.

Preserves RMC008's BLOCKED token semantics, and RMC012's zero executable
candidates. The diagnostic cannot elevate nominal capacity to funded execution.
"""
from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import re
import zipfile

D08_OUTER_SHA = "9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913"
D12_OUTER_SHA = "bbe6a6365d563eb41125d9fcdba79ac384c21182f31f6761897e0ce2ee8fa3b8"
D08_TOKEN_SHA = "f7ada7b07f1efef31e3cd9d9d8ddcae0ecd1bfa6ced96e6d6ff94bc8ee48d65d"
D12_ACTION_SHA = "1c2d4ffe4970f418c495d917e9b28e34494d67f29052669d775583e2240f5baf"
D12_PROMOTION_SHA = "6bcba8925d60b30aa46f6772f6ffb1d1f6dfc5f3c0b3310efbfb50b09d6b1569"
EXPECTED_D08_TOKENS = 514_279
EXPECTED_ACTIONABLE = 432
EXPECTED_REJECTED_ACTIONABILITY = 42
EXPECTED_REQUIRED_UNDERLYINGS = 43
EXPECTED_DEBT_ASSETS = 27
EXPECTED_COLLATERAL_ASSETS = 33
EXPECTED_ANCHOR_BLOCK = 26095351
HEX40 = re.compile(r"0x[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")


def need(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(obj):
    return (json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def digest(data):
    return sha256(data).hexdigest()


def parse_unique(blob):
    def unique(items):
        d = {}
        for k, v in items:
            need(k not in d, "duplicate JSON field")
            d[k] = v
        return d
    return json.loads(blob, object_pairs_hook=unique)


def archive_sha(path: Path, expected: str):
    h=sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda:f.read(2**20),b""):
            h.update(chunk)
    need(h.hexdigest()==expected,"source ZIP outer SHA256 differs")
    return h.hexdigest()


def verify_manifest(text, contents, expected):
    names=set(expected)
    checked=set()
    for line in text.splitlines():
        need(re.fullmatch(r"[0-9a-f]{64}  [a-zA-Z0-9._-]+",line) is not None,
             "manifest line not canonical")
        h,name=line.split("  ")
        need(name in names and name not in checked,"missing/extra/duplicate required SHA entry")
        need(h==expected[name] and h==digest(contents[name]),"inner canonical SHA mismatch")
        checked.add(name)
    need(checked==names,"canonical evidence-manifest incomplete")


def read_d12(archive: Path):
    archive_sha(archive,D12_OUTER_SHA)
    with zipfile.ZipFile(archive) as z:
        names=z.namelist()
        need(len(names)==len(set(names)),"duplicate D12 ZIP members")
        expected=("actionability-records.jsonl","actionability-summary.json",
                  "capital-promotions.jsonl","portfolio-capacity.json",
                  "evidence-manifest.json","terminal-actionability-certification.json")
        need(set(names)==set(expected)|{"terminal-archive.sha256"},"unexpected D12 archive contents")
        data={k:z.read(k) for k in expected}
        manifest=z.read("terminal-archive.sha256").decode("ascii")
    signatures={name:digest(data[name]) for name in expected}
    verify_manifest(manifest,data,signatures)
    need(signatures["actionability-records.jsonl"]==D12_ACTION_SHA and
         signatures["capital-promotions.jsonl"]==D12_PROMOTION_SHA,
         "D12 actionability/capital source digests do not match terminal certificate")
    evidence=parse_unique(data["evidence-manifest.json"])
    ev_files={x["path"]:x["sha256"] for x in evidence["artifacts"]}
    need(all(ev_files.get(n)==signatures[n] for n in ("actionability-records.jsonl",
                    "actionability-summary.json","capital-promotions.jsonl",
                    "portfolio-capacity.json")),"D12 independent evidence-manifest digests drift")
    authority=parse_unique(data["terminal-actionability-certification.json"])
    summary=parse_unique(data["actionability-summary.json"])
    need(authority.get("status")=="RMC_012_TERMINAL_ACTIONABILITY_CERTIFIED"
         and authority.get("d11",{}).get("artifact_id")==11519115757
         and summary.get("status")=="RMC_012_ACTIONABILITY_PASS"
         and summary.get("principal_capital_feasible")==0
         and summary.get("principal_capital_rejected")==EXPECTED_ACTIONABLE
         and summary.get("gas_funding_certified") is False
         and summary.get("anchor",{}).get("block_number")==EXPECTED_ANCHOR_BLOCK
         and summary.get("economic_filters_applied") is False,
         "D12 terminal proof is not the exact negative actionability scope")
    actions=[parse_unique(l) for l in data["actionability-records.jsonl"].splitlines()]
    promotions=[parse_unique(l) for l in data["capital-promotions.jsonl"].splitlines()]
    need(len(actions)==EXPECTED_ACTIONABLE+EXPECTED_REJECTED_ACTIONABILITY
         and len(promotions)==EXPECTED_ACTIONABLE, "D12 candidate cardinality drift")
    return summary,actions,promotions


def parse_actionability(actions,promotions):
    admitted=[r for r in actions if r.get("status")=="ADMITTED"]
    rejected=[r for r in actions if r.get("status")=="REJECTED"]
    need(len(admitted)==EXPECTED_ACTIONABLE and len(rejected)==EXPECTED_REJECTED_ACTIONABILITY,
         "D12 432/42 actionability conservation mismatch")
    candidate_ids={r.get("candidate_id") for r in admitted}
    need(len(candidate_ids)==len(admitted),"duplicate admitted actionability candidate")
    promoted_ids={p.get("actionable_candidate_id") for p in promotions}
    need(len(promoted_ids)==len(promotions) and promoted_ids==candidate_ids,
         "capital-promoted candidate identities do not exactly match admitted actionability")
    need(all(p.get("capital_status")=="REJECTED" and
             p.get("rejection_reason")=="EXECUTION_BLOCKED" and
             p.get("funding_scope")=="PRINCIPAL_AND_FLASH_SETTLEMENT_ONLY_GAS_UNCERTIFIED" and
             p.get("gas_funding_certified") is False and
             p.get("allocations")==[] for p in promotions),
         "D12 capital rejections are not all the exact execution-blocked type")
    needed={a for r in admitted for a in (r.get("debt_asset"),r.get("collateral_asset"))}
    need(len(needed)==EXPECTED_REQUIRED_UNDERLYINGS
         and all(type(x) is str and HEX40.fullmatch(x) for x in needed),
         "actionability required asset universe drift")
    debt_counts=Counter(r["debt_asset"] for r in admitted)
    collateral_counts=Counter(r["collateral_asset"] for r in admitted)
    need(len(debt_counts)==EXPECTED_DEBT_ASSETS
         and len(collateral_counts)==EXPECTED_COLLATERAL_ASSETS,
         "D12 debt/collateral asset classification drift")
    gross=[]
    for row in admitted:
        c=row.get("oracle_collateral_value_base_wad")
        d=row.get("oracle_repayment_value_base_wad")
        need(type(c) is str and c.isdecimal() and type(d) is str and d.isdecimal(),
             "noncanonical oracle-base WAD valuation")
        gross.append(int(c)-int(d))
    return needed,debt_counts,collateral_counts,gross


def scan_d08_tokens(archive,required):
    archive_sha(archive,D08_OUTER_SHA)
    found={}
    statuses=Counter()
    h=sha256()
    count=0
    with zipfile.ZipFile(archive) as z:
        names=z.namelist()
        need(len(names)==len(set(names)),"duplicate D08 ZIP entries")
        evidence=parse_unique(z.read("closeout/evidence-manifest.json"))
        entry=[x for x in evidence.get("artifacts",[]) if x.get("path")=="token-admission.jsonl"]
        need(len(entry)==1 and entry[0]["sha256"]==D08_TOKEN_SHA
             and entry[0]["bytes"]==307907598,
             "D08 token manifest inventory binding drift")
        with z.open("closeout/token-admission.jsonl") as f:
            for line in f:
                h.update(line)
                count+=1
                row=parse_unique(line)
                address=row.get("token")
                need(type(address) is str and HEX40.fullmatch(address),
                     "D08 noncanonical token identity")
                compatibility=row.get("execution_compatibility")
                need(type(compatibility) is dict,"D08 missing execution compatibility")
                status=compatibility.get("status")
                blockers=compatibility.get("blockers")
                need(status in ("PROVEN_COMPATIBLE","BLOCKED")
                     and type(blockers) is list
                     and len(set(blockers))==len(blockers)
                     and ((status=="BLOCKED" and len(blockers)>0) or
                          (status=="PROVEN_COMPATIBLE" and blockers==[])),
                     "D08 inconsistent token blocker contract")
                statuses[status]+=1
                if address in required:
                    need(address not in found,"required token duplicated in D08")
                    found[address]=compatibility
    need(h.hexdigest()==D08_TOKEN_SHA and count==EXPECTED_D08_TOKENS
         and statuses=={"BLOCKED":EXPECTED_D08_TOKENS}
         and set(found)==required,
         "original D08 immutable 514279-token admission evidence drift")
    return found,statuses,h.hexdigest()


def summarize(required,debt_counts,collateral_counts,gross,found,statuses):
    need(len(required)==EXPECTED_REQUIRED_UNDERLYINGS
         and set(found)==required
         and len(gross)==EXPECTED_ACTIONABLE,
         "root-cause input conservation")
    blocker_types=Counter()
    weighted=Counter()
    rows=[]
    for token in sorted(required):
        c=found[token]
        need(c["status"]=="BLOCKED" and len(c["blockers"])>0,
             "underlying source unexpectedly promoted")
        debt=debt_counts[token]
        collateral=collateral_counts[token]
        for name in c["blockers"]:
            blocker_types[name]+=1
            weighted[name]+=debt
        rows.append({"token_address":token,
                     "actionable_debt_candidate_count":debt,
                     "actionable_collateral_candidate_count":collateral,
                     "source_execution_status":"BLOCKED",
                     "source_blocker_codes":sorted(c["blockers"]),
                     "nqc_execution_eligible":False})
    top=sorted((r for r in rows if r["actionable_debt_candidate_count"]>0),
               key=lambda r:(-r["actionable_debt_candidate_count"],r["token_address"]))
    return {
        "schema_version":1,
        "status":"RMC012_EXECUTION_BLOCKER_ROOT_CAUSE_DIAGNOSTIC_ONLY",
        "source_archive_sha256":{"RMC008":D08_OUTER_SHA,"RMC012":D12_OUTER_SHA},
        "source_token_admission_sha256":D08_TOKEN_SHA,
        "source_d12_actionability_sha256":D12_ACTION_SHA,
        "source_d12_capital_promotions_sha256":D12_PROMOTION_SHA,
        "canonical_anchor_block":EXPECTED_ANCHOR_BLOCK,
        "d08_token_records":sum(statuses.values()),
        "d08_token_status_counts":dict(sorted(statuses.items())),
        "d12_pairs_examined":EXPECTED_ACTIONABLE+EXPECTED_REJECTED_ACTIONABILITY,
        "d12_actionability_admitted":EXPECTED_ACTIONABLE,
        "d12_actionability_rejected":EXPECTED_REJECTED_ACTIONABILITY,
        "d12_principal_capital_feasible":0,
        "d12_principal_rejection_count":EXPECTED_ACTIONABLE,
        "d12_rejection_reason":"EXECUTION_BLOCKED",
        "debt_underlying_count":len(debt_counts),
        "collateral_underlying_count":len(collateral_counts),
        "distinct_required_underlying_count":len(required),
        "required_underlying_source_status":"ALL_BLOCKED_NOT_ADMITTED",
        "required_asset_blocker_frequency":dict(sorted(blocker_types.items())),
        "debt_candidate_weighted_blocker_frequency":dict(sorted(weighted.items())),
        "top_debt_asset_tiers":top[:12],
        "positive_arithmetic_oracle_spread_pairs":sum(g>0 for g in gross),
        "nonpositive_arithmetic_oracle_spread_pairs":sum(g<=0 for g in gross),
        "sum_nominal_pair_oracle_spreads_base_wad":str(sum(gross)),
        "max_nominal_pair_oracle_spread_base_wad":str(max(gross)),
        "arithmetic_pair_spreads_not_portfolio_profit":True,
        "actionability_no_full_cost_model":True,
        "d08_token_eligibility_modified":False,
        "d11_terminal_source_universe_complete":False,
        "independent_gas_sponsorship_proven":False,
        "nexus_executable_trades_proven":False,
        "nexus_net_profitability_proven":False,
        "real_market_census_closed":False,
        "reason_classification_limit":"EXECUTION_BLOCKED indicates sufficient nominal but non-execution-eligible observed source, not proof that a specific token blocker is the unique rejection cause; exact route-level root cause still requires source allocation witnesses.",
    }


def audit(d08_zip,d12_zip):
    summary,actions,promotions=read_d12(d12_zip)
    required,debt,collateral,gross=parse_actionability(actions,promotions)
    found,statuses,_=scan_d08_tokens(d08_zip,required)
    result=summarize(required,debt,collateral,gross,found,statuses)
    need(result["required_asset_blocker_frequency"].get("FEE_ON_TRANSFER_UNPROVEN")==43
         and result["required_asset_blocker_frequency"].get("TRANSFER_HOOKS_UNPROVEN")==43
         and result["debt_candidate_weighted_blocker_frequency"].get("FEE_ON_TRANSFER_UNPROVEN")==432
         and result["debt_candidate_weighted_blocker_frequency"].get("TRANSFER_HOOKS_UNPROVEN")==432,
         "important legacy token blockers missing; do not dilute original negative evidence")
    result["report_sha256"]=digest(canonical(result))
    return result


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--d08-zip",type=Path,required=True)
    p.add_argument("--d12-zip",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    need(not a.out.exists(),"diagnostic is append-only, never overwrite")
    result=audit(a.d08_zip,a.d12_zip)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(result))
    print(result["status"],"required_assets",result["distinct_required_underlying_count"],
          "all_blocked",result["required_underlying_source_status"],
          "execution_blocked",result["d12_principal_rejection_count"],
          "nexus_net_UNPROVEN")


if __name__=="__main__":
    main()
