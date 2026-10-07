#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, pathlib, re, sys

HEX40=re.compile(r"^[0-9a-f]{40}$")
SHA=re.compile(r"^(?:sha256:|0x)?[0-9a-f]{64}$")

def canonical(v):
    return (json.dumps(v,sort_keys=True,separators=(",",":"))+"\n").encode()

def require(cond,msg):
    if not cond: raise SystemExit(msg)

def load(path):
    with open(path,encoding="utf-8") as f:return json.load(f)

def h(path):
    d=hashlib.sha256()
    with open(path,"rb") as f:
        for c in iter(lambda:f.read(1<<20),b""):d.update(c)
    return d.hexdigest()

def check_ref(row,label,prefix,workflow):
    require(isinstance(row,dict),f"{label}: ref missing")
    for k in ("run_id","artifact_id"):
        require(isinstance(row.get(k),int) and not isinstance(row.get(k),bool) and row[k]>0,f"{label}: bad {k}")
    require(HEX40.fullmatch(row.get("head_sha","")) is not None,f"{label}: bad head")
    require(HEX40.fullmatch(row.get("tree_sha","")) is not None,f"{label}: bad tree")
    require(row.get("workflow_name")==workflow,f"{label}: workflow differs")
    require(isinstance(row.get("artifact_name"),str) and row["artifact_name"].startswith(prefix),f"{label}: artifact name differs")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}",row.get("artifact_digest","")) is not None,f"{label}: bad artifact digest")

def main():
    if len(sys.argv)!=6:
        raise SystemExit("usage: verify_rmc017_final.py INPUTS D14_CERT D15_CERT D16_CERT OUT")
    inputs=load(sys.argv[1]); d14=load(sys.argv[2]); d15=load(sys.argv[3]); d16=load(sys.argv[4]); out=pathlib.Path(sys.argv[5])
    require(inputs.get("schema_version")==1,"input schema")
    require(inputs.get("status")=="PINNED","RMC017 inputs not PINNED")
    require(inputs.get("real_market_census_closed") is False,"source input cannot self-certify")
    require(inputs.get("blocking_reasons")==[],"PINNED inputs retain blockers")
    require(inputs.get("pft_certified_commit")=="5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf","PFT commit differs")
    require(inputs.get("pft_certified_tree")=="ef3498da528f85cdb9fdd82222d64773a557f853","PFT tree differs")
    check_ref(inputs.get("rmc014"),"RMC014","rmc014-structural-chain-","NQC RMC-014 Structural Census Chain")
    check_ref(inputs.get("rmc015"),"RMC015","rmc015b-temporal-opportunity-authority-","NQC RMC-015B Temporal Opportunity Authority")
    check_ref(inputs.get("rmc016"),"RMC016","rmc016-conservative-capacity-","NQC RMC-016 Conservative Realizable Capacity")

    require(d14.get("status")=="RMC_014_STRUCTURAL_CHAIN_CERTIFIED","D14 status")
    require(d14.get("structural_chain_certified") is True,"D14 not structural")
    require(d14.get("real_market_census_closed") is False,"D14 illegally claims closure")
    require(d14.get("final_census_authority_stage")=="RMC-017","D14 final authority differs")
    require(len(d14.get("stages",[]))==8,"D14 stage cardinality")
    require(d14.get("realized_profitability_proven") is False,"D14 profitability overclaim")
    require(d14.get("monthly_target_probability_proven") is False,"D14 monthly overclaim")
    require(d14.get("conservative_realizable_capacity_only") is True,"D14 capacity boundary")
    require(d14.get("global_capital_source_completeness_claimed") is False,"D14 capital completeness overclaim")
    require(d14.get("global_route_venue_completeness_claimed") is False,"D14 route completeness overclaim")

    require(d15.get("status")=="RMC015_TEMPORAL_OPPORTUNITY_AUTHORITY_PASS","D15 status")
    require(d15.get("coverage_complete") is True,"D15 coverage incomplete")
    require(d15.get("trigger_conservation") is True,"D15 trigger conservation failed")
    require(d15.get("canonical_ordering_complete") is True,"D15 ordering incomplete")
    require(d15.get("lookahead_used") is False,"D15 lookahead")
    require(d15.get("unresolved_mismatch_count")==0,"D15 mismatch")
    require(d15.get("material_unknown_count")==0,"D15 material unknown")
    require(d15.get("blocker_count")==0,"D15 blockers")
    require(d15.get("realized_nexus_pnl_proven") is False,"D15 PnL overclaim")
    require(d15.get("capture_probability_calibrated") is False,"D15 capture calibration overclaim")

    require(d16.get("status")=="RMC016_CONSERVATIVE_REALIZABLE_CAPACITY_PASS","D16 status")
    require(d16.get("coverage_complete") is True,"D16 coverage incomplete")
    require(d16.get("conservative_realizable_capacity_only") is True,"D16 not conservative")
    require(d16.get("global_market_maximum_claimed") is False,"D16 global maximum overclaim")
    require(d16.get("capture_probability")=="UNCALIBRATED","D16 capture probability invented")
    require(d16.get("capture_adjusted_capacity_claimed") is False,"D16 capture-adjusted overclaim")
    require(d16.get("unresolved_mismatch_count")==0,"D16 mismatch")
    require(d16.get("unknown_count")==0,"D16 unknown")
    require(d16.get("double_counting_detected") is False,"D16 double counting")
    require(d16.get("extrapolation_used") is False,"D16 extrapolation")
    require(d16.get("realized_nexus_pnl_proven") is False,"D16 PnL overclaim")
    require(d16.get("month1_300k_target_proven") is False,"D16 target overclaim")

    refs={}
    for key,path,doc in (("rmc014",sys.argv[2],d14),("rmc015",sys.argv[3],d15),("rmc016",sys.argv[4],d16)):
        refs[key]={
            "run_id":inputs[key]["run_id"],"head_sha":inputs[key]["head_sha"],"tree_sha":inputs[key]["tree_sha"],
            "artifact_id":inputs[key]["artifact_id"],"artifact_name":inputs[key]["artifact_name"],
            "artifact_digest":inputs[key]["artifact_digest"],"certificate_sha256":"sha256:"+h(path),
            "authority_commitment":doc.get("structural_commitment") or doc.get("authority_commitment") or doc.get("commitment")
        }
        require(isinstance(refs[key]["authority_commitment"],str) and SHA.fullmatch(refs[key]["authority_commitment"]) is not None,f"{key}: authority commitment missing")

    cert={
        "schema_version":1,
        "status":"REAL_MARKET_CENSUS_CLOSED",
        "real_market_census_closed":True,
        "authority_stage":"RMC-017",
        "pft_certified_commit":inputs["pft_certified_commit"],
        "pft_certified_tree":inputs["pft_certified_tree"],
        "authorities":refs,
        "structural_chain_certified":True,
        "temporal_opportunity_authority_certified":True,
        "conservative_capacity_authority_certified":True,
        "unresolved_mismatch_count":0,
        "material_unknown_count":0,
        "blocker_count":0,
        "own_capital_usd":"0",
        "capture_probability_calibrated":False,
        "realized_nexus_pnl_proven":False,
        "month1_300k_target_proven":False,
        "revenue_reliability_certified":False,
        "next_layer":"SOVEREIGN_MARKET_INTELLIGENCE_FABRIC",
        "non_claims":inputs.get("non_claims",[])
    }
    raw=canonical(cert)
    cert["final_census_commitment"]="0x"+hashlib.sha256(b"NQC-RMC017-FINAL-CENSUS-V1\0"+raw).hexdigest()
    out.mkdir(parents=True,exist_ok=True)
    target=out/"rmc017-final-census-certificate.json"
    target.write_bytes(canonical(cert))
    (out/"rmc017-final-census-certificate.sha256").write_text(h(target)+"  rmc017-final-census-certificate.json\n",encoding="utf-8")
    print("REAL_MARKET_CENSUS_CLOSED")
    print("RMC017_FINAL_CENSUS_COMMITMENT="+cert["final_census_commitment"])

if __name__=="__main__":main()
