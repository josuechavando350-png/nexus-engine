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
D08_MARKET_SHA = "c64719793eed5fd5b09eb725f18b811746b1a50e101bfa00b9569be65282d19e"
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


def capital_principal_requirements(actions,promotions):
    action_by_id={r["candidate_id"]:r for r in actions if r.get("status")=="ADMITTED"}
    need(len(action_by_id)==EXPECTED_ACTIONABLE and len(promotions)==EXPECTED_ACTIONABLE,
         "capital actionability conservation missing")
    maxima={}
    for record in promotions:
        identifier=record.get("actionable_candidate_id")
        require=action_by_id.get(identifier)
        need(require is not None and record.get("debt_asset")==require["debt_asset"],
             "capital source/principal asset does not match borrower debt")
        raw=record.get("principal")
        need(type(raw) is str and re.fullmatch(r"[0-9a-f]{64}",raw) is not None,
             "original uint256 principal not exact 32-byte hexadecimal")
        amount=int(raw,16)
        need(amount>0,"empty historical capital requirement")
        asset=require["debt_asset"]
        maxima[asset]=max(maxima.get(asset,0),amount)
    need(len(maxima)==EXPECTED_DEBT_ASSETS,"missing per-debt-asset maxima")
    return maxima


def nominal_reserve_diagnostic(archive,required_debt):
    need(len(required_debt)==EXPECTED_DEBT_ASSETS,
         "nominal reserve demands not conserved")
    markets={}
    counts=Counter()
    h=sha256()
    with zipfile.ZipFile(archive) as z:
        evidence=parse_unique(z.read("closeout/evidence-manifest.json"))
        entry=[x for x in evidence.get("artifacts",[]) if x.get("path")=="market-state-manifest.jsonl"]
        need(len(entry)==1 and entry[0].get("sha256")==D08_MARKET_SHA and
             entry[0].get("bytes")==478607674,
             "D08 market state manifest provenance differs")
        with z.open("closeout/market-state-manifest.jsonl") as stream:
            for raw in stream:
                h.update(raw)
                if b'"protocol":"AAVE_V3"' in raw:
                    row=parse_unique(raw)
                    need(row.get("protocol")=="AAVE_V3",
                         "false Aave market state row identifier")
                    counts["aave"]+=1
                    asset=row.get("asset")
                    if asset in required_debt:
                        need(asset not in markets,"duplicated required Aave reserve state")
                        facts=row.get("protocol_facts")
                        need(type(facts) is dict and
                             row.get("lifecycle")=="CURRENT" and
                             row.get("stage_state_reconstructable")=="ADVANCE",
                             "Aave reserve not current or reconstructable")
                        avail=facts.get("available_liquidity")
                        need(type(avail) is str and avail.isdecimal()
                             and not (len(avail)>1 and avail[0]=="0"),
                             "noncanonical historical Aave underlying available liquidity")
                        need(type(facts.get("active")) is bool and
                             type(facts.get("paused")) is bool and
                             type(facts.get("flash_loan_enabled")) is bool,
                             "Aave reserve mode flags not Boolean")
                        markets[asset]={
                            "available_liquidity_raw_underlying":avail,
                            "active":facts["active"],
                            "paused":facts["paused"],
                            "flash_loan_enabled":facts["flash_loan_enabled"],
                        }
                else:
                    counts["non_aave"]+=1
    need(h.hexdigest()==D08_MARKET_SHA and counts["aave"]==67 and
         counts["non_aave"]==523424 and set(markets)==set(required_debt),
         "D08 exact original Aave market-state universe/hash drift")
    return nominal_liquidity_comparison(markets,required_debt)


def nominal_liquidity_comparison(markets,requirements):
    need(set(markets)==set(requirements) and len(markets)==EXPECTED_DEBT_ASSETS,
         "required Aave reserve capacity basis incomplete")
    rows=[]
    for asset in sorted(requirements):
        r=markets[asset]
        cap=int(r["available_liquidity_raw_underlying"])
        amount=requirements[asset]
        need(type(amount) is int and amount>0 and cap>=0,
             "invalid exact raw underlying liquidity/principal")
        rows.append({
            "debt_asset":asset,
            "source_available_liquidity_raw":str(cap),
            "largest_single_candidate_flash_principal_raw":str(amount),
            "nominal_single_candidate_capacity_sufficient":cap>=amount,
            "reserve_active_flash_enabled_and_unpaused":
                r["active"] and r["flash_loan_enabled"] and not r["paused"],
            "liquidity_not_an_execution_approval":True,
        })
    return {
        "source_d08_market_state_sha256":D08_MARKET_SHA,
        "single_candidate_nominal_liquidity_checked_assets":len(rows),
        "all_required_reserves_have_adequate_nominal_single_trade_liquidity":
            all(x["nominal_single_candidate_capacity_sufficient"] for x in rows),
        "required_reserves_active_flash_enabled_unpaused_count":
            sum(x["reserve_active_flash_enabled_and_unpaused"] for x in rows),
        "principal_source_eligible_for_execution_claimed":False,
        "simultaneous_liquidity_capacity_certified":False,
        "same_block_available_liquidity_guaranteed":False,
        "observations":rows,
    }


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
                    roles=row.get("roles")
                    need(type(roles) is list and all(type(x) is str for x in roles),
                         "required source token roles malformed")
                    if roles==["AAVE_RESERVE_UNDERLYING"]:
                        family="AAVE_RESERVE_UNDERLYING"
                    elif roles in (["V2_TOKEN0"],["V2_TOKEN1"],["V2_TOKEN0","V2_TOKEN1"]):
                        family="UNISWAP_V2_TOKEN"
                    else:
                        raise ValueError("unexpected required token source role")
                    family_observations=found.setdefault(address,{})
                    need(family not in family_observations,
                         "duplicate token source-family record, not a valid independent surface")
                    family_observations[family]=compatibility
    need(h.hexdigest()==D08_TOKEN_SHA and count==EXPECTED_D08_TOKENS
         and statuses=={"BLOCKED":EXPECTED_D08_TOKENS}
         and set(found)==required
         and all("AAVE_RESERVE_UNDERLYING" in x for x in found.values())
         and sum("UNISWAP_V2_TOKEN" in x for x in found.values())==32
         and sum(len(x) for x in found.values())==75,
         "original D08 immutable 514279-token admission/source-family conservation drift")
    return found,statuses,h.hexdigest()


def summarize(required,debt_counts,collateral_counts,gross,found,statuses):
    need(len(required)==EXPECTED_REQUIRED_UNDERLYINGS
         and set(found)==required
         and len(gross)==EXPECTED_ACTIONABLE,
         "root-cause input conservation")
    blocker_types=Counter()
    weighted=Counter()
    v2_types=Counter()
    rows=[]
    for token in sorted(required):
        surface=found[token]
        need(type(surface) is dict and "AAVE_RESERVE_UNDERLYING" in surface,
             "Aave reserve admission surface missing")
        c=surface["AAVE_RESERVE_UNDERLYING"]
        need(c["status"]=="BLOCKED" and len(c["blockers"])>0,
             "underlying Aave source unexpectedly promoted")
        v2=surface.get("UNISWAP_V2_TOKEN")
        if v2 is not None:
            need(v2["status"]=="BLOCKED" and len(v2["blockers"])>0,
                 "historical V2 token compatibility unexpectedly promoted")
            v2_types.update(v2["blockers"])
        debt=debt_counts[token]
        collateral=collateral_counts[token]
        for name in c["blockers"]:
            blocker_types[name]+=1
            weighted[name]+=debt
        rows.append({"token_address":token,
                     "actionable_debt_candidate_count":debt,
                     "actionable_collateral_candidate_count":collateral,
                     "aave_reserve_source_execution_status":"BLOCKED",
                     "aave_reserve_source_blocker_codes":sorted(c["blockers"]),
                     "distinct_additional_uniswap_v2_observation":v2 is not None,
                     "v2_source_blocker_codes":sorted(v2["blockers"]) if v2 is not None else [],
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
        "source_role_d08_required_aave_rows":len(found),
        "source_role_d08_required_uniswap_v2_rows":sum(
            "UNISWAP_V2_TOKEN" in x for x in found.values()),
        "source_role_d08_required_total_rows":sum(len(x) for x in found.values()),
        "source_role_comparison_not_token_deduplication":True,
        "required_asset_blocker_frequency":dict(sorted(blocker_types.items())),
        "additional_v2_source_blocker_frequency":dict(sorted(v2_types.items())),
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
        "reason_classification_limit":"EXECUTION_BLOCKED indicates adequate nominal but non-execution-eligible observed source; Aave-reserve and V2 token evidences have been kept separate. No specific token blocker can be asserted as the sole rejection cause without source allocation witnesses.",
    }


def audit(d08_zip,d12_zip):
    summary,actions,promotions=read_d12(d12_zip)
    required,debt,collateral,gross=parse_actionability(actions,promotions)
    found,statuses,_=scan_d08_tokens(d08_zip,required)
    max_principal=capital_principal_requirements(actions,promotions)
    nominal=nominal_reserve_diagnostic(d08_zip,max_principal)
    result=summarize(required,debt,collateral,gross,found,statuses)
    result["historical_aave_reserve_nominal_principal_diagnostic"]=nominal
    need(nominal["all_required_reserves_have_adequate_nominal_single_trade_liquidity"] is True
         and nominal["required_reserves_active_flash_enabled_unpaused_count"]==27,
         "Aave nominal reserve study disagrees with original anchored funding demands")
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
