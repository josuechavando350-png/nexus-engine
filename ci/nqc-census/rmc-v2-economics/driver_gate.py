#!/usr/bin/env python3
"""NQC RMC V2: read-only, negative economic admission gate.

All numeric values are base-unit decimal strings. This module does NOT certify
RPC operators, ABI precision, forecast, flash capacity, sponsor or Shadow/P2.
"""
from __future__ import annotations
import argparse
from decimal import Decimal, localcontext
from hashlib import sha256
import json
from pathlib import Path

BORROWER = "0x08c14b32c8a48894e4b933090ebcc9ce33b21135"
WAD = 10**18
USD_BASE = 10**8
ROUTES = {
    "MORPHO_USDT": ("USDT", "USDC", "USDtb", "sUSDe", "USDT"),
    "AAVE_USDTB": ("USDtb", "sUSDe", "USDT", "USDtb"),
}

class InvalidEvidence(ValueError):
    pass

def require(ok, reason):
    if not ok:
        raise InvalidEvidence(reason)

def uint(value, field):
    require(type(value) is str and value.isascii() and value.isdecimal()
            and (value == "0" or not value.startswith("0")), field + ": decimal string required")
    n = int(value)
    require(0 <= n < 2**256, field + ": uint256 overflow")
    return n

def canon(obj):
    return sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def audit(doc):
    require(type(doc) is dict and doc.get("schema_version") == 1, "schema version")
    require(doc.get("evidence_tier") == "RETROSPECTIVE_SINGLE_PROVIDER_RESEARCH_ONLY", "evidence tier")
    require("claim_scope" not in doc, "unregistered competing claim scope")
    require(doc.get("chain_id") == 1 and doc.get("borrower") == BORROWER, "chain/borrower mismatch")
    require(str(doc.get("aave_pool", "")).lower() ==
            "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", "Aave Pool mismatch")
    require(str(doc.get("morpho_usdt", {}).get("provider_address", "")).lower() ==
            "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", "Morpho contract mismatch")
    require(str(doc.get("morpho_usdt", {}).get("token_address", "")).lower() ==
            "0xdac17f958d2ee523a2206206994597c13d831ec7", "USDT contract mismatch")
    require(str(doc.get("aave_usdtb", {}).get("asset_address", "")).lower() ==
            "0xc139190f447e929f090edeb554d95abb8b18ac1c", "USDtb contract mismatch")
    require(str(doc.get("aave_usdtb", {}).get("atoken_address", "")).lower() ==
            "0xec4ef66d4fceeba34abb4de69db391bc5476ccc8", "USDtb aToken mismatch")
    require(doc.get("live_transactions") == 0 and doc.get("realized_nqc_pnl_usd") == "0"
            and doc.get("certifies_p2") is False and doc.get("certifies_rmc") is False,
            "cannot promote research fixture to terminal or realized P&L")
    p, c = doc["previous"], doc["current"]
    require(type(p["block_number"]) is int and type(c["block_number"]) is int
            and 0 < p["block_number"] < c["block_number"], "invalid block sequence")
    for name, row in (("previous", p), ("current", c)):
        require(row["block_hash"] is None and row["raw_abi_certified"] is False, name + ": source overclaim")
        require(row["liquidation_threshold_display_bps"] == 9199, name + ": configuration changed")
    c0, d0, h0 = (uint(p[k], "previous."+k) for k in
                  ("total_collateral_base", "total_debt_base", "health_factor_wad_approx"))
    c1, d1, h1 = (uint(c[k], "current."+k) for k in
                  ("total_collateral_base", "total_debt_base", "health_factor_wad_approx"))
    require(min(c0,d0,h0,c1,d1,h1) > 0, "zero value")
    require(h0 >= WAD and h1 >= WAD, "a prospective crossing requires a separate exact trigger gate")
    nominal = uint(doc["morpho_usdt"]["nominal_balance_raw_6_decimals"], "Morpho nominal")
    amount = uint(doc["illustrative_cover_usdtb_raw_18_decimals"], "illustrative USDtb cover")
    require(amount > 0 and amount % (10**18) == 0, "cover decimals")
    bp = doc["aave_usdtb"]["premium_total_bps"]
    require(type(bp) is int and 0 <= bp <= 10000, "invalid fee bps")
    require(doc["independent_rpc_operator_count"] == 1
            and doc["prospective_trigger_seen"] is False, "unproven prospective quorum/trigger")
    require(doc["morpho_usdt"]["executable_capital_proven"] is False
            and doc["morpho_usdt"]["committed_to_nqc"] is False
            and doc["aave_usdtb"]["executable_capital_proven"] is False
            and doc["aave_usdtb"]["underlying_balance_raw_18_decimals"] is None,
            "nominal or missing liquidity cannot prove capital")
    require(all(doc[field] is False for field in (
        "gas_sponsor_nonrecourse_proven", "builder_terms_proven",
        "competition_survival_proven", "external_liabilities_proven_zero")),
        "external funding/competition cannot be assumed")
    require(set(doc["route_evidence"]) == {
        "morpho_usdt_to_usdtb", "aave_usdtb_repay_conversion",
        "susde_monetization", "liquidation_fork_pass"}
        and all(v is False for v in doc["route_evidence"].values()), "unverified route")

    with localcontext() as ctx:
        ctx.prec = 75
        hf0, hf1 = Decimal(h0)/WAD, Decimal(h1)/WAD
        constant_lt_hf1 = hf0 * Decimal(c1)/c0 * Decimal(d0)/d1
        require(abs(constant_lt_hf1-hf1) < Decimal("2e-13"),
                "HF/collateral/debt decomposition mismatch")
        fmt = lambda v, n=12: format(v, f".{n}f")
        driver = {
            "collateral_usd_base_delta": fmt(Decimal(c1-c0)/USD_BASE,8),
            "debt_usd_base_delta": fmt(Decimal(d1-d0)/USD_BASE,8),
            "hf_delta_bps_approx": fmt((hf1-hf0)*10000),
            "collateral_relative_delta_bps": fmt((Decimal(c1)/c0-1)*10000),
            "debt_relative_delta_bps": fmt((Decimal(d1)/d0-1)*10000),
            "collateral_loss_to_hf_one_usd_base_sensitivity_only":
                fmt((Decimal(c1)-Decimal(c1)/hf1)/USD_BASE,8),
            "debt_growth_to_hf_one_usd_base_sensitivity_only":
                fmt((Decimal(d1)*hf1-Decimal(d1))/USD_BASE,8),
            "no_etiology_or_forecast_claim": True
        }
    common = ["HF_ABOVE_ONE_NO_TRIGGER", "NO_BLOCK_HASH_PIN",
              "NO_INDEPENDENT_RPC_QUORUM", "HF_NOT_EXACT_ABI_CERTIFIED",
              "NO_EXTERNAL_GAS_NONRECOURSE", "NO_BUILDER_QUOTE",
              "NO_COMPETITION_SURVIVAL_EVIDENCE", "NO_FORK_EXECUTION"]
    variants = []
    for name, path in ROUTES.items():
        require(path[0] == path[-1] and path.count("sUSDe") == 1,
                name + ": invalid flash debt asset conservation")
        if name == "MORPHO_USDT":
            extra = ["MORPHO_NOMINAL_NOT_EXECUTABLE", "MORPHO_CALLBACK_NOT_PROVEN",
                     "USDC_TO_USDTB_ACQUISITION_UNQUOTED"]
        else:
            require(path[-2:] == ("USDT", "USDtb"), "USDtb debt repayment route incomplete")
            extra = ["AAVE_USDTB_UNDERLYING_UNKNOWN",
                     "AAVE_USDTB_CALLBACK_NOT_PROVEN",
                     "USDT_TO_USDTB_REPAYMENT_UNQUOTED"]
        variants.append({"topology":name, "asset_sequence":list(path),
                         "status":"BLOCKED", "execution_admitted":False,
                         "blockers":sorted(set(common+extra)), "net_pnl_usd":None})
    # Aave percentageMul uses half-up rounding in base units; illustrative only.
    fee_raw = (amount*bp+5000)//10000
    return {"schema_version":1,
            "contract":"NQC_V2_ECONOMIC_NEGATIVE_PREFLIGHT_ONLY",
            "input_sha256":canon(doc), "block":c["block_number"],
            "health_factor_approx_wad":str(h1), "hf_above_one":h1 >= WAD,
            "driver_decomposition":driver,
            "morpho_nominal_usdt_raw":str(nominal), "morpho_executable":False,
            "aave_usdtb_available_raw":None,
            "illustrative_usdtb_cover_raw":str(amount),
            "illustrative_aave_premium_bps":bp,
            "illustrative_aave_flash_fee_raw_usdtb":str(fee_raw),
            "variants":variants, "admitted_count":0,
            "prospective_shadow_p2_certified":False, "rmc_closed":False,
            "commercial_score_upgrade":False, "realized_nqc_pnl_usd":"0",
            "notes":["Source is one provider; HF transport rounded and block hash absent.",
                     "HF sensitivity assumes unchanged portfolio/rates/prices/config.",
                     "Liquidity nominal does not imply flash execution capacity.",
                     "Amounts before fees/routes/gas/builder/competition are not P&L."]}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ns=ap.parse_args()
    result=audit(json.loads(Path(ns.input).read_text()))
    Path(ns.out).write_text(json.dumps(result,sort_keys=True,indent=2)+"\n")
    print(result["contract"], "admitted_count="+str(result["admitted_count"]))

if __name__ == "__main__":
    main()
