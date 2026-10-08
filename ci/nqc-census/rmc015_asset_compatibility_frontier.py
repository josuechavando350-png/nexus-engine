#!/usr/bin/env python3
"""Read-only, anchor-bound asset compatibility triage over authenticated RMC008/009.

This is neither an execution admission nor a profitable opportunity claim.
All ranks measure unique watchlist-account participation, NOT position value.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
from hashlib import sha256
import json
from pathlib import Path
from zipfile import ZipFile

from rmc015_material_frontier import (
    ADDRESS, audit, canonical_bytes, exact_uint, load_manifest, require,
    verify_member,
)


def _positive_assets(positions: object, label: str) -> set[str]:
    require(isinstance(positions, list), f"{label}: positions must be array")
    found = set()
    seen = set()
    for position in positions:
        require(isinstance(position, dict), f"{label}: position must be object")
        asset = position.get("asset")
        require(isinstance(asset, str) and ADDRESS.fullmatch(asset) is not None,
                f"{label}: invalid asset address")
        amount = exact_uint(position.get("balance"), f"{label}.balance")
        require(asset not in seen, f"{label}: duplicate asset position {asset}")
        seen.add(asset)
        # Zeroed positions remain in structural position counts, but do not
        # count as financial participation. This is not an economic valuation.
        if amount > 0:
            found.add(asset)
    return found


def participation(rows: list[dict], watchlist: list[dict]) -> tuple[Counter, Counter, dict[str, set[str]]]:
    watch = {x["account"]: x for x in watchlist}
    require(len(watch) == len(watchlist), "duplicate watchlist account")
    seen = set()
    debt = Counter()
    supply = Counter()
    debt_sets = defaultdict(set)
    for row in rows:
        account = row.get("account")
        if account not in watch:
            continue
        require(account not in seen, "duplicate watched account in D09")
        seen.add(account)
        require(row.get("classification") == "POSITION_HOLDER",
                "watched account lost position-holder classification")
        raw_debt = row.get("debt_positions")
        raw_supply = row.get("supply_positions")
        require(isinstance(raw_debt, list) and isinstance(raw_supply, list),
                "watched account position lists unavailable")
        require(len(raw_debt) == watch[account]["debt_position_count"] and
                len(raw_supply) == watch[account]["supply_position_count"],
                "watched account position cardinality differs")
        data = row.get("account_data")
        require(isinstance(data, list) and len(data) == 6,
                "watched account data missing")
        require(data[1] == watch[account]["debt_base_units"],
                "watched account debt changed")
        da = _positive_assets(raw_debt, "debt")
        sa = _positive_assets(raw_supply, "supply")
        require(bool(da), "watched debt account has no positive debt asset")
        debt.update(da)
        supply.update(sa)
        for asset in da:
            debt_sets[asset].add(account)
    require(seen == set(watch), "selected account set not conserved")
    return debt, supply, dict(debt_sets)


def rank_asset_rows(counts: Counter, evidence: dict[str, dict]) -> list[dict]:
    ranked=[]
    for asset,n in sorted(counts.items(),key=lambda pair:(-pair[1],pair[0])):
        require(type(n) is int and n>0,"invalid participating account count")
        witness=evidence.get(asset)
        require(witness is not None, f"missing Aave underlying token witness: {asset}")
        compat=witness.get("execution_compatibility")
        require(isinstance(compat,dict) and compat.get("status") in {"BLOCKED", "ADMITTED"},
                f"noncanonical compatibility status: {asset}")
        require(isinstance(compat.get("blockers"),list) and
                all(isinstance(x,str) and x for x in compat["blockers"]),
                f"compatibility blocker list is invalid: {asset}")
        if compat["status"]=="BLOCKED":
            require(bool(compat["blockers"]),"BLOCKED token has no explicit evidence gap")
        else:
            require(not compat["blockers"],"ADMITTED token has unresolved blockers")
        proxy=witness.get("proxy")
        runtime=witness.get("runtime")
        require(isinstance(proxy,dict) and isinstance(runtime,dict),
                f"missing token code/proxy provenance: {asset}")
        ranked.append({
            "asset":asset,
            "participating_watchlist_accounts":n,
            "execution_compatibility_status":compat["status"],
            "unresolved_execution_evidence":sorted(set(compat["blockers"])),
            "runtime_identity_kind":runtime.get("kind"),
            "proxy_kind":proxy.get("kind"),
            # DO NOT promote admission based on partial runtime identity.
            "execution_authority_claimed":False,
        })
    return ranked


def create(d08_path:Path,d09_path:Path,d08_sha:str,d09_sha:str,
           *,d08_commit:str,d09_commit:str,evaluation_start_block:int,
           top_k:int=4) -> dict:
    require(type(top_k) is int and 1<=top_k<=64,"top_k must be integer in 1..64")
    # First reauthenticate entire parent risk frontier, outer ZIP SHA, exact
    # canonical manifests, oracle currency and 246929-account conservation.
    risk, watchlist = audit(d08_path,d09_path,d08_sha,d09_sha,
                            expected_d08_commit=d08_commit,
                            expected_d09_commit=d09_commit,
                            emit_watchlist=True,
                            evaluation_start_block=evaluation_start_block)
    require(risk["retrospective_backtest_admitted"] is False,
            "historical hindsight selection forbidden")
    require(len(watchlist) == risk["material_risk_frontier"]["account_count"],
            "risk-watchlist count mismatch")
    with ZipFile(d09_path) as d09, ZipFile(d08_path) as d08:
        _,m09=load_manifest(d09)
        _,m08=load_manifest(d08)
        verify_member(d09,"closeout/account-manifest.jsonl",m09)
        verify_member(d08,"closeout/token-admission.jsonl",m08)
        with d09.open("closeout/account-manifest.jsonl") as rows:
            def accounts():
                for line in rows:
                    require(line.endswith(b"\n") and line.strip(),"invalid D09 JSONL record")
                    yield json.loads(line)
            debt,supply,sets=participation(accounts(),watchlist)
        token_witness={};total_token_rows=0;all_blocked=0; aave_underlying_count=0
        with d08.open("closeout/token-admission.jsonl") as rows:
            for line in rows:
                require(line.endswith(b"\n") and line.strip(),"invalid D08 token JSONL record")
                token=json.loads(line);total_token_rows+=1
                compat=token.get("execution_compatibility")
                require(isinstance(compat,dict),"missing token execution-compatibility facts")
                if compat.get("status")=="BLOCKED":all_blocked+=1
                roles=token.get("roles")
                require(isinstance(roles,list),"missing token roles")
                if "AAVE_RESERVE_UNDERLYING" in roles:
                    addr=token.get("token")
                    require(isinstance(addr,str) and ADDRESS.fullmatch(addr) is not None,
                            "noncanonical Aave token address")
                    require(addr not in token_witness,"duplicate underlying token witness")
                    token_witness[addr]=token
                    aave_underlying_count+=1
        require(bool(debt) and bool(supply) and aave_underlying_count>0,
                "incomplete financial/token universe")
        debt_rank=rank_asset_rows(debt,token_witness)
        supply_rank=rank_asset_rows(supply,token_witness)
        focus=debt_rank[:top_k]
        focus_assets={x["asset"] for x in focus}
        focus_accounts=set().union(*(sets[a] for a in focus_assets))
        require(len(focus_accounts)<=len(watchlist),"focus coverage overcounts borrowers")
        doc={
            "schema_version":1,
            "status":"RMC015_AUXILIARY_COMPATIBILITY_TRIAGE_VERIFIED",
            "terminal_authority":False,
            "execution_eligibility_certified":False,
            "realized_profitability_proven":False,
            "snapshot_only":True,
            "retrospective_backtest_admitted":False,
            "lookahead_used":False,
            "earliest_ex_ante_evaluation_block":risk["earliest_ex_ante_evaluation_block"],
            "observation_anchor":risk["anchor"],
            "authenticated_risk_frontier_commitment_sha256":risk["authority_commitment_sha256"],
            "authenticated_watchlist_commitment_sha256":risk["watchlist_commitment_sha256"],
            "source_artifacts":risk["source_artifacts"],
            "unique_watchlist_accounts":len(watchlist),
            "distinct_debt_underlyings":len(debt),
            "distinct_supply_underlyings":len(supply),
            "aave_underlying_token_witness_count":aave_underlying_count,
            "token_admission_record_count":total_token_rows,
            "blocked_token_admission_record_count":all_blocked,
            "focus_top_k_debt_assets":len(focus),
            "focus_unique_account_count":len(focus_accounts),
            "focus_account_coverage_denominator":len(watchlist),
            "top_debt_underlyings":focus,
            "top_supply_underlyings":supply_rank[:top_k],
            "ordered_all_debt_underlyings":debt_rank,
            "ordered_all_supply_underlyings":supply_rank,
            "count_semantics":"UNIQUE_WATCHLIST_ACCOUNTS_PER_ASSET_NOT_VALUE_OR_PNL; CROSS_ASSET_SUMS_CAN_DOUBLE_COUNT; FOCUS_USES_UNION",
            "non_claims":["NO_TOKEN_EXECUTION_ADMISSION", "NO_FEASIBLE_FLASH_GAS_ROUTE",
                          "NO_LIQUIDATABLE_ACCOUNT_CLAIM", "NO_FUTURE_PRICE_FORECAST",
                          "NO_PROFITABILITY", "NO_RMC017_CLOSEOUT"],
        }
        doc["triage_commitment_sha256"]=sha256(canonical_bytes({
            "domain":"NQC-RMC015-AUXILIARY-EXECUTION-COMPATIBILITY-TRIAGE-V1",
            "report":doc,
        })).hexdigest()
        return doc


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for a in ("d08","d09","d08-sha256","d09-sha256","d08-commit","d09-commit"):
        parser.add_argument("--"+a,required=True)
    parser.add_argument("--evaluation-start-block",type=int,required=True)
    parser.add_argument("--top-k",type=int,default=4)
    parser.add_argument("--out",type=Path,required=True)
    args=parser.parse_args()
    report=create(Path(args.d08),Path(args.d09),args.d08_sha256,args.d09_sha256,
                  d08_commit=args.d08_commit,d09_commit=args.d09_commit,
                  evaluation_start_block=args.evaluation_start_block,top_k=args.top_k)
    args.out.write_bytes(canonical_bytes(report))
    print("RMC015_AUXILIARY_COMPATIBILITY_TRIAGE_VERIFIED")
    print("focus_accounts="+str(report["focus_unique_account_count"]))

if __name__=="__main__":
    main()
