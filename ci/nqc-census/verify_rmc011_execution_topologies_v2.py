#!/usr/bin/env python3
"""Fail-closed V2 topology-family discovery preflight, NOT D11/D17 authority.

Derives source/venue universes from explicitly registered full asset flows,
compares them to exact D11 source rows, and reports gaps without pretending
that a source registry, RPC balance or swap placeholder proves execution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

CATALOG_CONTRACT = "NQC_RMC011_EXECUTION_TOPOLOGIES_V2_RESEARCH_ONLY"
MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"
AAVE_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
SOURCE_COMMIT = "3b23804a46bfcc730d57784fb95a349e6e6e726b"
UPSTREAM_MORPHO = "8e26ca6a8dbc5089edcd67fb576248810fd2870a"
SOURCE_NONCLAIM = {
    "D11_TERMINAL_OPEN", "RMC_D17_TERMINAL_OPEN",
    "NO_LIVE_EXECUTABLE_CAPITAL", "NO_FULL_PATH_EXECUTION",
    "NO_HF_BELOW_ONE_TRIGGER", "NO_GAS_SPONSOR_APPROVAL",
    "NO_PROFIT_OR_SHADOW_CERTIFICATION", "NQC_REALIZED_PNL_ZERO",
}
REQUIRED_OPP = {
    "chain_id", "protocol_deployment", "borrower", "collateral_asset",
    "debt_asset", "canonical_block_hash", "prestate_commitment",
    "sizing_semantics", "trigger_conditions",
}
FORBIDDEN_OPP = {
    "flash_provider", "flash_premium", "flash_repayment", "funding_topology",
    "swap_route", "gas_provider", "builder_payment", "calldata", "post_event_result",
}
REQUIRED_VARIANT = {
    "opportunity_id", "funding_source", "funding_asset",
    "funding_terms_commitment", "acquisition_route", "liquidation",
    "monetization_route", "repayment_route", "gas_source", "builder_policy",
    "calldata_commitment", "canonical_block_hash",
}
FORBIDDEN_VARIANT = {
    "future_inclusion_outcome", "future_competitor_result", "post_event_pnl",
}
EXPECTED = {
    "TOPOLOGY-V2-001": {
        "family": "MORPHO_BLUE_FLASH_LOAN",
        "provider": "MORPHO_BLUE", "contract": MORPHO, "asset": "USDT",
        "callback": "onMorphoFlashLoan",
        "flow": [("FLASH_BORROW", "USDT", "USDT", None),
                 ("SWAP", "USDT", "USDC", "CURVE_3POOL_USDT_USDC"),
                 ("UNRESOLVED_SWAP", "USDC", "USDtb", None),
                 ("LIQUIDATE", "USDtb", "sUSDe", "AAVE_V3_LIQUIDATION"),
                 ("SWAP", "sUSDe", "USDT", "FLUID_SUSDE_USDT"),
                 ("FLASH_REPAY", "USDT", "USDT", None)],
        "reason": "NO_EXACT_BOUNDED_USDTB_ACQUISITION_QUOTE",
        "gap": "USDtb_ACQUISITION_USDC_TO_USDtb",
    },
    "TOPOLOGY-V2-002": {
        "family": "AAVE_V3_FLASH_LOAN",
        "provider": "AAVE_V3", "contract": AAVE_POOL, "asset": "USDtb",
        "callback": "executeOperation",
        "flow": [("FLASH_BORROW", "USDtb", "USDtb", None),
                 ("LIQUIDATE", "USDtb", "sUSDe", "AAVE_V3_LIQUIDATION"),
                 ("SWAP", "sUSDe", "USDT", "FLUID_SUSDE_USDT"),
                 ("UNRESOLVED_SWAP", "USDT", "USDtb", None),
                 ("FLASH_REPAY", "USDtb", "USDtb", None)],
        "reason": "AAVE_USDTB_PRINCIPAL_PLUS_PREMIUM_REPAYMENT_NOT_QUOTED",
        "gap": "USDtb_REACQUISITION_USDT_TO_USDtb",
    },
}

class TopologyError(ValueError):
    pass

def require(ok: bool, why: str) -> None:
    if not ok:
        raise TopologyError(why)

def canon(obj: object) -> str:
    return hashlib.sha256(json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")).hexdigest()

def unique_set(seq: object, label: str) -> set[str]:
    require(type(seq) is list and all(type(x) is str and x for x in seq),
            label + ": array of nonempty strings required")
    require(len(seq) == len(set(seq)), label + ": duplicates")
    return set(seq)

def read_obj(path: str) -> dict:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    require(type(value) is dict, path + ": JSON object expected")
    return value

def audit(catalog: dict, scope: dict, universe: dict) -> dict:
    require(type(catalog) is dict and catalog.get("schema_version") == 2,
            "catalog must be schema V2")
    require(catalog.get("contract") == CATALOG_CONTRACT
            and catalog.get("stage") == "RMC-011"
            and catalog.get("status") == "OPEN_MORPHO_FAMILY_AND_ROUTING_GAPS",
            "not an explicitly research-only topology catalog")
    require(catalog.get("terminal") is False and
            catalog.get("authority_scope") ==
            "DERIVED_REQUIREMENT_DISCOVERY_ONLY_NOT_D11_AUTHORITY",
            "catalog cannot claim D11/D17 authority")
    require(catalog.get("upstream_d11_source_head") == SOURCE_COMMIT,
            "D11 source-head mismatch")
    require(unique_set(catalog.get("nonclaims"), "nonclaims") == SOURCE_NONCLAIM,
            "research nonclaims cannot be weakened")
    opp = catalog.get("opportunity_identity")
    variant = catalog.get("execution_variant_identity")
    require(type(opp) is dict and type(variant) is dict, "identity contracts required")
    require(unique_set(opp.get("required"), "opportunity.required") == REQUIRED_OPP
            and unique_set(opp.get("prohibited"), "opportunity.prohibited") == FORBIDDEN_OPP,
            "opportunity identity contaminated by financing or hindsight")
    require(unique_set(variant.get("required"), "variant.required") == REQUIRED_VARIANT
            and unique_set(variant.get("prohibited"), "variant.prohibited") == FORBIDDEN_VARIANT,
            "variant identity missing route/funding or includes future outcomes")

    require(scope.get("schema_version") == 2 and scope.get("stage") == "RMC-011",
            "upstream D11 capital scope invalid")
    require(universe.get("schema_version") == 2
            and universe.get("claim_scope") == "SOURCE_UNIVERSE_READINESS_ONLY"
            and universe.get("d11_terminal_closed") is False,
            "upstream D11 is not authenticated terminal authority")
    family_scope = unique_set(scope.get("required_source_families"), "D11 scope families")
    rows = universe.get("families")
    require(type(rows) is list and all(type(r) is dict and type(r.get("id")) is str
                                       for r in rows), "D11 universe rows invalid")
    family_universe = unique_set([r["id"] for r in rows], "D11 universe families")
    require(family_scope == family_universe,
            "D11 scope/universe mismatch; must not mix branch generations")

    topologies = catalog.get("topologies")
    require(type(topologies) is list and len(topologies) == 2,
            "only the two audited V2 research topologies are supported")
    ids = unique_set([t.get("id") for t in topologies], "topology ids")
    require(ids == set(EXPECTED), "unregistered or missing execution topology")
    sources, venues, gaps = set(), set(), set()
    for t in topologies:
        tid = t["id"]
        p = EXPECTED[tid]
        require(t.get("status") == "RESEARCH_CANDIDATE_NOT_ADMITTED"
                and t.get("state_anchor") == "EXACT_TRIGGER_BLOCK_NOT_AVAILABLE",
                tid + ": no real trigger or admission")
        funding = t.get("funding")
        require(type(funding) is dict and
                funding.get("source_family") == p["family"]
                and funding.get("provider") == p["provider"]
                and str(funding.get("provider_address", "")).lower() == p["contract"]
                and funding.get("asset") == p["asset"]
                and funding.get("callback") == p["callback"],
                tid + ": funding provider, callback or deployment mismatch")
        if tid == "TOPOLOGY-V2-001":
            require(funding.get("source_code_commit") == UPSTREAM_MORPHO
                    and funding.get("premium") ==
                    "ZERO_BY_PINNED_MORPHO_UPSTREAM_VERIFY_LIVE_CODE",
                    tid + ": Morpho upstream callback/fee identity unpinned")
        else:
            require(funding.get("premium") ==
                    "READ_FLASHLOAN_PREMIUM_TOTAL_AT_TRIGGER",
                    tid + ": Aave premium cannot be hardcoded")
        gas = t.get("gas")
        require(type(gas) is dict and gas.get("source_family") ==
                "EXTERNAL_GAS_SPONSOR" and gas.get("eligibility") == "UNKNOWN"
                and gas.get("capital_committed") is False
                and gas.get("prepaid_by_operator") is False
                and gas.get("recourse") == "UNKNOWN" and gas.get("fee") == "UNKNOWN",
                tid + ": unfunded gas/recourse cannot be passed")
        builder = t.get("builder")
        require(type(builder) is dict and builder.get("terms") == "UNKNOWN"
                and builder.get("payment") == "UNKNOWN"
                and builder.get("probability_calibrated") is False,
                tid + ": builder/competition uncalibrated")
        required_evidence = {
            "borrower_hf_under_one", "exact_flash_capacity",
            "executor_callback_fork_pass", "all_route_quotes_block_pinned",
            "gas_sponsorship_terms_accepted", "competition_survival_proven",
            "profit_net_after_full_cost_proven",
        }
        evidence = t.get("evidence")
        require(type(evidence) is dict and set(evidence) == required_evidence
                and all(v is False for v in evidence.values()),
                tid + ": evidence flag cannot be upgraded by fixture")
        exposure = t.get("own_capital_exposure")
        require(exposure == {
            "principal": "EXTERNAL_REQUIRED", "gas": "EXTERNAL_REQUIRED",
            "collateral": "NO_OPERATOR_COLLATERAL_PERMITTED",
            "guarantees": "NO_OPERATOR_RECOURSE_PERMITTED",
        }, tid + ": OWN_CAPITAL=0 requires zero gas/guarantee exposure")

        steps = t.get("steps")
        require(type(steps) is list and len(steps) == len(p["flow"]),
                tid + ": missing or inserted route leg")
        current = p["asset"]
        gap_count, liquidations = 0, 0
        for i, (step, (kind, inp, out, venue)) in enumerate(zip(steps, p["flow"])):
            require(type(step) is dict and step.get("kind") == kind,
                    tid + f": wrong step kind at {i}")
            if kind in ("FLASH_BORROW", "FLASH_REPAY"):
                require(step.get("asset") == p["asset"]
                        and step.get("provider") == p["provider"],
                        tid + ": debt asset/provider repayment mismatch")
                require(kind == "FLASH_BORROW" or current == p["asset"],
                        tid + ": borrow repayment does not conserve funding asset")
            else:
                require(step.get("input_asset") == inp == current
                        and step.get("output_asset") == out
                        and step.get("venue_family") == venue,
                        tid + f": discontinuous route or invented venue at {i}")
                current = out
                if kind == "UNRESOLVED_SWAP":
                    gap_count += 1
                    require(step.get("reason") == p["reason"],
                            tid + ": unresolved USDtb acquisition must be explicit")
                    gaps.add(p["gap"])
                else:
                    require(step.get("quote") in ("BLOCK_PIN_REQUIRED",
                                                 "EXACT_TRIGGER_BLOCK_REQUIRED"),
                            tid + ": cannot claim simulation or quote exists")
                    venues.add(venue)
                    if kind == "LIQUIDATE":
                        liquidations += 1
                        require(inp == "USDtb" and out == "sUSDe",
                                tid + ": liquidation debt/collateral changed")
        require(gap_count == 1 and liquidations == 1,
                tid + ": liquidation and unresolved acquisition cardinality")
        sources.add(p["family"])
        sources.add("EXTERNAL_GAS_SPONSOR")

    require(unique_set(catalog.get("required_source_families"),
                       "catalog required capital families") == sources,
            "source-family universe must be derived from all registered plans")
    require(unique_set(catalog.get("required_venue_families"),
                       "catalog required venue families") == venues,
            "venue-family universe must be derived from all route legs")
    require(unique_set(catalog.get("missing_venue_requirements"),
                       "explicit unresolved venues") == gaps,
            "missing USDtb route cannot disappear by narrative")
    missing = sorted(sources - family_universe)
    blockers = sorted(
        ["D11_MISSING_REQUIRED_SOURCE_FAMILY:" + x for x in missing] +
        ["ROUTE_NOT_BLOCK_PINNED:" + x for x in sorted(gaps)] +
        ["CAPITAL_GAS_BUILDER_COMPETITION_UNPROVEN:" + t["id"]
         for t in topologies]
    )
    return {
        "schema_version": 1,
        "contract": "NQC_RMC011_TOPOLOGY_V2_DIAGNOSTIC_NO_TERMINAL",
        "status": "BLOCKED_RESEARCH_ONLY",
        "topology_count": len(topologies),
        "catalog_sha256": canon(catalog),
        "d11_scope_sha256": canon(scope),
        "d11_universe_sha256": canon(universe),
        "required_source_families": sorted(sources),
        "required_venue_families": sorted(venues),
        "required_unresolved_acquisition_routes": sorted(gaps),
        "d11_missing_source_families": missing,
        "blockers": blockers,
        "execution_admitted": 0,
        "capital_executable_verified": False,
        "gas_sponsor_admitted": False,
        "builder_competition_calibrated": False,
        "prospective_hf_crossing": False,
        "p2_shadow_certified": False,
        "rmc_closed": False,
        "commercial_upgrade_authorized": False,
        "realized_nqc_pnl_usd": "0",
    }

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--scope", required=True)
    parser.add_argument("--universe", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    result = audit(read_obj(args.catalog), read_obj(args.scope),
                   read_obj(args.universe))
    Path(args.out).write_text(
        json.dumps(result, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(result["status"] + " missing=" +
          ",".join(result["d11_missing_source_families"]))

if __name__ == "__main__":
    main()
