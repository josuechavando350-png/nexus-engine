#!/usr/bin/env python3
import json, pathlib, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parent
def base():
    return {
      "schema_version":1,"status":"PINNED","repository":"josuechavando350-png/nexus-engine",
      "pft_certified_commit":"5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf","pft_certified_tree":"ef3498da528f85cdb9fdd82222d64773a557f853",
      "real_market_census_closed":False,"blocking_reasons":[],
      "non_claims":["NO_REALIZED_NEXUS_PNL"],
      **{k:{"run_id":1,"head_sha":"1"*40,"tree_sha":"2"*40,"workflow_name":w,"artifact_id":1,"artifact_name":p+"1"*40,"artifact_digest":"sha256:"+"3"*64}
         for k,p,w in [
          ("rmc014","rmc014-structural-chain-","NQC RMC-014 Structural Census Chain"),
          ("rmc015","rmc015b-temporal-opportunity-authority-","NQC RMC-015B Temporal Opportunity Authority"),
          ("rmc016","rmc016-conservative-capacity-","NQC RMC-016 Conservative Realizable Capacity")]}
    }
def run(mutate=None):
    with tempfile.TemporaryDirectory() as td:
      td=pathlib.Path(td); inp=base()
      d14={"status":"RMC_014_STRUCTURAL_CHAIN_CERTIFIED","structural_chain_certified":True,"real_market_census_closed":False,"final_census_authority_stage":"RMC-017","stages":[{}]*8,"realized_profitability_proven":False,"monthly_target_probability_proven":False,"conservative_realizable_capacity_only":True,"global_capital_source_completeness_claimed":False,"global_route_venue_completeness_claimed":False,"structural_commitment":"0x"+"4"*64}
      d15={"status":"RMC015_TEMPORAL_OPPORTUNITY_AUTHORITY_PASS","coverage_complete":True,"trigger_conservation":True,"canonical_ordering_complete":True,"lookahead_used":False,"unresolved_mismatch_count":0,"material_unknown_count":0,"blocker_count":0,"realized_nexus_pnl_proven":False,"capture_probability_calibrated":False,"authority_commitment":"0x"+"5"*64}
      d16={"status":"RMC016_CONSERVATIVE_REALIZABLE_CAPACITY_PASS","coverage_complete":True,"conservative_realizable_capacity_only":True,"global_market_maximum_claimed":False,"capture_probability":"UNCALIBRATED","capture_adjusted_capacity_claimed":False,"unresolved_mismatch_count":0,"unknown_count":0,"double_counting_detected":False,"extrapolation_used":False,"realized_nexus_pnl_proven":False,"month1_300k_target_proven":False,"authority_commitment":"0x"+"6"*64}
      if mutate: mutate(inp,d14,d15,d16)
      for name,obj in [("i",inp),("a",d14),("b",d15),("c",d16)]: (td/f"{name}.json").write_text(json.dumps(obj))
      p=subprocess.run(["python3",str(ROOT/"verify_rmc017_final.py"),str(td/"i.json"),str(td/"a.json"),str(td/"b.json"),str(td/"c.json"),str(td/"out")],capture_output=True,text=True)
      return p
p=run(); assert p.returncode==0 and "REAL_MARKET_CENSUS_CLOSED" in p.stdout
p=run(lambda i,a,b,c:b.__setitem__("material_unknown_count",1)); assert p.returncode!=0
p=run(lambda i,a,b,c:c.__setitem__("capture_probability","0.5")); assert p.returncode!=0
p=run(lambda i,a,b,c:a.__setitem__("real_market_census_closed",True)); assert p.returncode!=0
print("RMC017_FINAL_VERIFIER_TESTS=PASS")
