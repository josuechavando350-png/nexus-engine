#!/usr/bin/env python3
import copy,importlib.util,random,sys,unittest
from pathlib import Path
P=Path(__file__).with_name("rmc017_closeout_model.py")
S=importlib.util.spec_from_file_location("m",P); m=importlib.util.module_from_spec(S); sys.modules[S.name]=m; S.loader.exec_module(m)
H=lambda b:"0x"+f"{b:02x}"*32
G=lambda b:f"{b:02x}"*20
def row(stage,b):
 r={"stage":stage,"workflow_run_id":100+b,"artifact_id":200+b,"code_commit":G(b),"code_tree":G(b+1),"artifact_digest":"sha256:"+f"{b+2:02x}"*32,"admitted":True,"coverage_complete":True,"unresolved_mismatch_count":0,"unknown_failure_count":0,"blocker_count":0,"evidence":[H(b+3)]}
 if stage=="RMC-014": r.update(structural_chain_certified=True,real_market_census_closed=False)
 if stage=="RMC-015": r.update(temporal_conservation_complete=True,lookahead_used=False,material_unknown_count=0)
 if stage=="RMC-016": r.update(conservative_realizable_capacity_only=True,global_market_maximum_claimed=False,capture_adjusted_capacity_claimed=False)
 return r
def valid(): return {"schema_version":1,"real_market_census_closed":False,"authorities":[row(s,10+i) for i,s in enumerate(m.REQUIRED)]}
class T(unittest.TestCase):
 def test_valid(self):
  o=m.validate(valid()); self.assertFalse(o["real_market_census_closed"]); self.assertFalse(o["terminal_authority"]); self.assertFalse(o["independent_artifact_authentication_complete"]); self.assertEqual(o["status"],"RMC017_FOUNDATION_CANDIDATE_VALID_NOT_CERTIFIED"); self.assertFalse(o["realized_profitability_proven"]); self.assertFalse(o["month1_target_proven"])
 def test_order_independent_500(self):
  base=m.validate(valid())["candidate_commitment"]; rng=random.Random(17017)
  for _ in range(500):
   d=valid(); rng.shuffle(d["authorities"]); self.assertEqual(m.validate(d)["candidate_commitment"],base)
 def test_every_terminal_failure_bit_fails_closed(self):
  cases=[("admitted",False),("coverage_complete",False),("unresolved_mismatch_count",1),("unknown_failure_count",1),("blocker_count",1)]
  for field,value in cases:
   d=valid(); d["authorities"][0][field]=value
   with self.assertRaises(ValueError,msg=field): m.validate(d)
 def test_d14_cannot_self_close(self):
  d=valid(); d["authorities"][0]["real_market_census_closed"]=True
  with self.assertRaises(ValueError): m.validate(d)
 def test_temporal_unknown_or_lookahead_fails(self):
  for field,value in [("material_unknown_count",1),("lookahead_used",True),("temporal_conservation_complete",False)]:
   d=valid(); d["authorities"][1][field]=value
   with self.assertRaises(ValueError): m.validate(d)
 def test_capacity_overclaim_fails(self):
  for field,value in [("conservative_realizable_capacity_only",False),("global_market_maximum_claimed",True),("capture_adjusted_capacity_claimed",True)]:
   d=valid(); d["authorities"][2][field]=value
   with self.assertRaises(ValueError): m.validate(d)
 def test_foundation_never_emits_final_marker(self):
  o=m.validate(valid()); self.assertNotIn("REAL_MARKET_CENSUS_CLOSED",str(o)); self.assertFalse(o["terminal_authority"])
  import hashlib
  legacy="0x"+hashlib.sha256(m.canonical({"domain":"NQC-RMC017-FINAL-CLOSEOUT-V1","authorities":o["authorities"]})).hexdigest()
  self.assertNotEqual(o["candidate_commitment"],legacy)
 def test_boolean_ids_zero_digests_and_boolean_counts_rejected(self):
  for stage_index, field, value in [
   (0,"workflow_run_id",True), (1,"artifact_id",True),
   (0,"unresolved_mismatch_count",False), (1,"blocker_count",False),
   (0,"artifact_digest","sha256:"+"0"*64),
   (1,"code_commit","0"*40),
   (2,"code_tree","0"*40),
   (2,"evidence",["0x"+"0"*64]),
  ]:
   d=valid(); d["authorities"][stage_index][field]=value
   with self.assertRaises(ValueError,msg=field): m.validate(d)
 def test_boolean_schema_and_temporal_unknown_fail(self):
  d=valid(); d["schema_version"]=True
  with self.assertRaises(ValueError): m.validate(d)
  d=valid(); d["authorities"][1]["material_unknown_count"]=False
  with self.assertRaises(ValueError): m.validate(d)
 def test_source_lock_self_close_fails(self):
  d=valid(); d["real_market_census_closed"]=True
  with self.assertRaises(ValueError): m.validate(d)
if __name__=="__main__": unittest.main()
