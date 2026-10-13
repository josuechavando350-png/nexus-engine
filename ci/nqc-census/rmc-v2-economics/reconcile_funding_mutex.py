#!/usr/bin/env python3
"""NQC RMC V2: counterfactual route comparison. NO execution authority.

Consumes four immutable GitHub Actions archives. All four refer to Ethereum
block 26,184,741. Three sets of swaps occurred in DIFFERENT reverted historical
forks; no liquidation, synchronized full-route execution, live capture or USD P&L
has been demonstrated. Both funding variants compete for ONE opportunity.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

ARTIFACTS = {
    "aave_seize": ("NQC_RMC_V2_AAVE_SEIZE_BUDGET_BLOCK26184741.zip",
                   "777771c4f220299ba7985705efbf358843137736f00425fe82bd53c85258b343"),
    "curve": ("NQC_V2_EXECUTED_CURVE_FORK_EVIDENCE_20261013.zip",
              "5598d2ece2261a3f4a14b4fee3cccccd84bdda037e00b6cbed0fc2d1f35f9bad"),
    "fluid": ("NQC_V2_AAVE_FEE_ADJUSTED_FLUID_FORK_20261013.zip",
              "b5cfe2abcb90ba597b17f049d46faeeb2aa723e1c97c047f889c7c4e5e35149a"),
    "aave_flash": ("NQC_V2_AAVE_USDTB_FORK_20261013.zip",
                   "cfac15301d12f0cfe1eef4f7e9fbed1dd8186e976b501fff57646737c8ebd3dc"),
}
CHAIN = 1
BLOCK = 26184741
HASH = "0xe4b0718c51a6a484eef56edce0f25e9a5c546c2f66f595c6e305a589a612dbbe"
PARENT = "0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66"
BORROWER = "0x08c14b32c8a48894e4b933090ebcc9ce33b21135"
DEBT = "0xc139190f447e929f090edeb554d95abb8b18ac1c"
COLLATERAL = "0x9d39a5de30e57443bff2a8307a4256c8797a3497"
COVER = 472000 * 10**18

class EvidenceRejected(ValueError): pass

def require(cond, why):
    if not cond:
        raise EvidenceRejected(why)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def read_archives(root):
    root=Path(root)
    out={}
    for key,(filename,digest) in ARTIFACTS.items():
        path=root/filename
        require(path.is_file(),"archive absent: "+filename)
        require(sha(path.read_bytes())==digest,"archive digest mismatch: "+filename)
        z=zipfile.ZipFile(path)
        names=z.namelist()
        require(len(names)==len(set(names)),"duplicate zip member")
        manifest=sorted(set(names)&{"evidence.sha256","archive.sha256"})
        require(len(manifest)==1,"missing or ambiguous internal checksum manifest")
        records=z.read(manifest[0]).decode().strip().splitlines()
        require(len(records)>=3,"insufficient immutable evidence members")
        for line in records:
            match=re.fullmatch(r"([0-9a-f]{64})\s+\*?(\S+)",line.strip())
            require(match is not None,"invalid internal checksum entry")
            expected,member=match.groups()
            require(member in names,"manifest refers to missing member")
            require(sha(z.read(member))==expected,"evidence member digest mismatch: "+member)
        out[key]=z
    return out

def event(log,name):
    hits=re.findall(r"^\s*"+re.escape(name)+r":\s*(\d+)\s*$",log,re.M)
    require(len(hits)==1,"event missing or duplicate: "+name)
    return int(hits[0])

def passed(log,name):
    needle="[PASS] "+name+"()"
    require(log.count(needle)>=1,"missing actual fork PASS: "+name)
    tail=log[log.index(needle)+len(needle):]
    marker=re.search(r"\n\[PASS\]|\nSuite result:",tail)
    return tail[:marker.start()] if marker else tail

def reconcile(archives):
    a,c,f,af=(archives[k] for k in ("aave_seize","curve","fluid","aave_flash"))
    account=json.loads(a.read("conditional-seizure-budget.json"))
    original=json.loads(a.read("exact-onchain-input.json"))
    cb=json.loads(c.read("canonical-block.json"))
    fb=json.loads(f.read("block.json"))
    ab=json.loads(af.read("pinned-block.json"))
    config=json.loads(af.read("reserve-snapshot.json"))
    notice=json.loads(af.read("nonclaims.json"))
    require(account["contract"]=="NQC_RMC_V2_AAVE_SUSDE_SEIZE_BUDGET_CONDITIONAL_RESEARCH",
            "wrong Aave seizure budget contract")
    canonical=json.dumps(original,sort_keys=True,separators=(",",":")).encode()
    require(sha(canonical)==account["input_sha256"],"Aave input commitment mismatch")
    require(account["block_hash"]==HASH and original["block_hash"]==HASH and
            all(x["hash"].lower()==HASH and x["parentHash"].lower()==PARENT for x in (cb,fb,ab))
            and original["parent_hash"]==PARENT,
            "not the identical canonical historical block")
    require(account["block_number"]==BLOCK and original["block_number"]==BLOCK
            and config["block_number"]==BLOCK and original["chain_id"]==CHAIN,
            "wrong block or chain")
    require(account["borrower"]==BORROWER
            and account["emode_bonus_bps"]==10310
            and account["sUSDe_protocol_liquidation_fee_bps"]==1000,
            "Aave borrower, emode or fee state mismatch")
    require(account["health_factor_below_one"] is False
            and account["liquidation_executed"] is False
            and int(account["health_factor_wad"])>=10**18
            and account["p2_shadow_certified"] is False
            and account["rmc_closed"] is False
            and account["commercial_score_upgrade"] is False
            and account["nqc_realized_pnl_usd"]=="0",
            "false liquidation or economic authority")
    net=int(account["conditional_liquidator_net_susde_raw"])
    gross=int(account["conditional_gross_collateral_susde_raw"])
    fee=int(account["conditional_protocol_fee_susde_raw"])
    require(net>0 and net+fee==gross and net<388000*10**18,
            "Aave protocol-fee or net collateral amount mismatch")
    require(account["illustrative_debt_cover_usdtb_raw"]==str(COVER)
            and int(account["conditional_close_factor_max_cover_raw"])>=COVER,
            "invalid USDtb covered debt or close factor")
    require(config["source_tier"]=="SINGLE_ARCHIVE_RPC_HISTORICAL_ONLY"
            and config["schema_version"]==1
            and config["capital_committed_to_nqc"] is False
            and config["external_gas_source_known"] is False
            and config["reserve_flags"]=={"active":True,"flash_enabled":True,
                                          "frozen":False,"paused":False},
            "Aave USDtb provider overstated availability")
    require(notice["canonical_block_hash"]==HASH
            and notice["exact_token_amount_borrowed_for_liquidation"] is False
            and notice["full_cross_asset_route_executed"] is False
            and notice["realized_pnl_usd"]=="0",
            "Aave USDtb evidence authority changed")
    bp=config["flash_premium_total_bps"]
    require(type(bp) is int and bp==5,"Aave USDtb flash premium unverified")
    premium=(COVER*bp+5000)//10000
    require(premium==236*10**18,"incorrect Aave premium rounding")
    cash=config["aave_usdtb_underlying_raw"]
    require(type(cash) is str and cash.isascii() and cash.isdecimal()
            and int(cash)>COVER,"Aave nominal token balance insufficient")

    cl=c.read("fork-tests.txt").decode()
    fl=f.read("fork-tests.txt").decode()
    require("Suite result: ok. 5 passed; 0 failed" in cl,
            "Curve deployed-contract fork proof failed")
    require("Suite result: ok. 12 passed; 0 failed" in fl,
            "Fluid deployed-contract fork proof failed")
    morpho=passed(cl,"testRealMorphoCurveOneAdditionalUSDTBaseUnitMeetsFormerTarget")
    aave=passed(cl,"testRealMorphoCurveRecordsActualOutputForPremiumQuote")
    fluid=passed(fl,"testAave472kConditionalNetSeizeExactSizeAgainstDeployedFluidFork")
    morpho_in=event(morpho,"NQC_MORPHO_USDT_INPUT_RAW")
    aave_in=event(aave,"NQC_MORPHO_USDT_INPUT_RAW")
    morpho_received=event(morpho,"NQC_CURVE_USDTB_ACTUAL_RAW")
    aave_received=event(aave,"NQC_CURVE_USDTB_ACTUAL_RAW")
    fluid_input=event(fluid,"NQC_AAVE_CONDITIONAL_NET_SUSDE_RAW")
    fluid_output=event(fluid,"NQC_AAVE_CONDITIONAL_NET_FLUID_USDT_RAW")
    pre_cost_claim=event(fluid,"NQC_AAVE_CONDITIONAL_PRE_COST_MARGIN_USDT_RAW")
    require(fluid_input==net and fluid_output==484870110578,
            "Fluid actual balance delta not tied to Aave fee-adjusted collateral")
    require(morpho_in==472461610797 and morpho_received>=COVER,
            "Morpho USDT acquisition inadequate")
    require(aave_in==472697861244 and aave_received>=COVER+premium,
            "USDtb flash repayment amount missing Aave premium")
    require(fluid_output-morpho_in==pre_cost_claim and aave_in>morpho_in,
            "route flow attribution invalid")

    opp_id=sha(f"{CHAIN}:{HASH}:{BORROWER}:{DEBT}:{COLLATERAL}".encode())
    candidates=[]
    for provider,input_usdt in (("MORPHO_USDT",morpho_in),("AAVE_USDTB",aave_in)):
        candidates.append({
            "opportunity_id":opp_id,
            "variant_id":sha((opp_id+":"+provider).encode()),
            "funding_source":provider,
            "partial_reverted_fork_quote_usdt_micro":str(input_usdt),
            "conditional_pre_gas_builder_competition_usdt_micro":str(fluid_output-input_usdt),
            "full_route_fork_certified":False,
            "aave_liquidation_executed":False,
            "gas_sponsor_nonrecourse_admitted":False,
            "builder_competition_survival_proven":False,
            "borrower_crossing_prospective":False,
            "p2_shadow_admitted":False,
            "nqc_net_pnl_usd":None,
        })
    require(len(set(x["variant_id"] for x in candidates))==2
            and len(set(x["opportunity_id"] for x in candidates))==1,
            "single economic opportunity incorrectly double-counted")
    return {
        "schema_version":1,
        "contract":"NQC_RMC_V2_MUTEX_FUNDING_VARIANT_RESEARCH_ONLY",
        "chain_id":CHAIN,"block_number":BLOCK,"block_hash":HASH,
        "borrower":BORROWER,"common_opportunity_id":opp_id,
        "one_capture_max_even_with_two_funding_variants":True,
        "opportunities_discovered_eligible":0,
        "finance_variant_count":2,
        "artifact_sha256":{k:v[1] for k,v in ARTIFACTS.items()},
        "conditional_susde_net_raw":str(net),
        "separate_fork_fluid_usdt_out_micro":str(fluid_output),
        "aave_flash_premium_bps":bp,
        "aave_flash_premium_usdtb_raw":str(premium),
        "aave_usdtb_nominal_cash_raw":cash,
        "provider_nominal_cash_committed_to_nqc":False,
        "candidates":candidates,
        "same_borrower_conflict_keys":[
            "SAME_BORROWER","SAME_AAVE_USDTB_DEBT","SAME_AAVE_SUSDE_COLLATERAL",
            "SAME_ETHEREUM_BLOCK","SAME_COMPETITION_AND_LIQUIDITY",
        ],
        "cannot_sum_candidate_pnl":True,
        "historical_single_provider_sources_not_prospective":True,
        "curve_fluid_legs_proven_independently_not_atomically":True,
        "liquidation_executed":False,
        "full_route_pnl_usd":None,
        "zero_own_capital_gas_sponsorship_proven":False,
        "shadow_p2_certified":False,"rmc_closed":False,
        "commercial_score_upgrade":False,"realized_nqc_pnl_usd":"0",
    }

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--artifacts-dir",required=True)
    p.add_argument("--out",required=True)
    ns=p.parse_args()
    zips=read_archives(ns.artifacts_dir)
    result=reconcile(zips)
    Path(ns.out).write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
    print(json.dumps({"status":result["contract"],
      "morpho_margin_micro":result["candidates"][0]["conditional_pre_gas_builder_competition_usdt_micro"],
      "aave_margin_micro":result["candidates"][1]["conditional_pre_gas_builder_competition_usdt_micro"],
      "admitted_opportunities":0},sort_keys=True))

if __name__=="__main__": main()
