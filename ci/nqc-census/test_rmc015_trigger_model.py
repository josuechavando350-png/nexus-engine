#!/usr/bin/env python3
import copy, importlib.util, json, random, sys, unittest
from pathlib import Path

MODULE=Path(__file__).with_name("rmc015_trigger_model.py")
SPEC=importlib.util.spec_from_file_location("rmc015_trigger_model",MODULE)
assert SPEC and SPEC.loader
m=importlib.util.module_from_spec(SPEC); sys.modules[SPEC.name]=m; SPEC.loader.exec_module(m)

H=lambda b:"0x"+f"{b:02x}"*32
WINDOW={"chain_id":1,"start_block":25000000,"start_hash":H(1),"end_block":26000000,"end_hash":H(2)}
SURFACES={
 "POSITION_MUTATIONS":["SUPPLY","WITHDRAW","BORROW","REPAY","ATOKEN_TRANSFER","VARIABLE_DEBT_MINT_BURN","COLLATERAL_USAGE_CHANGE","USER_EMODE_CHANGE"],
 "PROTOCOL_CONFIG_MUTATIONS":["RESERVE_CONFIGURATION","LIQUIDATION_THRESHOLD","LIQUIDATION_BONUS","LIQUIDATION_PROTOCOL_FEE","RESERVE_PAUSE_FREEZE_ACTIVE","SUPPLY_BORROW_CAPS","ISOLATION_DEBT_CEILING","EMODE_CONFIGURATION","ORACLE_CONFIGURATION","GOVERNANCE_EXECUTION_EFFECTS"],
 "ORACLE_PRICE_TRANSITIONS":["HISTORICAL_PRICE","FRESHNESS","DECIMALS"],
 "RATE_INDEX_SEGMENTS":["LIQUIDITY_INDEX","VARIABLE_BORROW_INDEX","RATE_SEGMENT"],
 "INTEREST_ONLY_CROSSING_CANDIDATES":["HF_THRESHOLD_CROSSING"],
 "LIQUIDATION_OUTCOMES":["LIQUIDATION_CALL","TERMINAL_OUTCOME"],
 "CANONICAL_CHAIN_REORG_AUTHORITY":["CANONICAL_HASH","PARENT_HASH","REORG_INVALIDATION"],
}
def row(k,i):
 r={"trigger_class":k,"start_block":WINDOW["start_block"],"end_block":WINDOW["end_block"],"surface_kinds":SURFACES[k],"coverage_complete":True,"lookahead_used":False,"unresolved_mismatch_count":0,"material_unknown_count":0}
 if k=="INTEREST_ONLY_CROSSING_CANDIDATES":
  r.update(sources=[],authenticated_input_commitments=[H(60),H(61)],algorithm_commitment=H(62),equivalence_commitment=H(63))
 else:
  r["sources"]=[{"provider_id":f"p{i}a","operator":f"op{i}a","evidence_sha256":H(10+i)},{"provider_id":f"p{i}b","operator":f"op{i}b","evidence_sha256":H(30+i)}]
 return r
def valid():
 return {"schema_version":1,"window":dict(WINDOW),"trigger_classes":[row(k,i) for i,k in enumerate(m.TRIGGER_CLASSES)]}

class TriggerAuthorityTests(unittest.TestCase):
 def test_valid_exact_surface_passes(self):
  out=m.validate(valid())
  self.assertEqual(out["trigger_class_count"],7)
  self.assertFalse(out["terminal_authority"])
  self.assertEqual(out["status"],"RMC015_TRIGGER_FOUNDATION_VALID")

 def test_order_independent_commitment_500_permutations(self):
  base=m.validate(valid())["commitment"]
  rng=random.Random(15015)
  for _ in range(500):
   d=valid(); rng.shuffle(d["trigger_classes"])
   for r in d["trigger_classes"]: rng.shuffle(r["surface_kinds"]); rng.shuffle(r["sources"])
   self.assertEqual(m.validate(d)["commitment"],base)

 def test_event_only_position_surface_fails(self):
  d=valid(); p=next(x for x in d["trigger_classes"] if x["trigger_class"]=="POSITION_MUTATIONS")
  p["surface_kinds"]=["SUPPLY","WITHDRAW","BORROW","REPAY"]
  with self.assertRaises(ValueError): m.validate(d)

 def test_missing_trigger_class_fails(self):
  d=valid(); d["trigger_classes"]=d["trigger_classes"][:-1]
  with self.assertRaises(ValueError): m.validate(d)

 def test_duplicate_trigger_class_fails(self):
  d=valid(); d["trigger_classes"][-1]=copy.deepcopy(d["trigger_classes"][0])
  with self.assertRaises(ValueError): m.validate(d)

 def test_same_operator_is_not_independent(self):
  d=valid(); r=d["trigger_classes"][0]; r["sources"][1]["operator"]=r["sources"][0]["operator"]
  with self.assertRaises(ValueError): m.validate(d)

 def test_single_provider_acquired_surface_fails(self):
  d=valid(); d["trigger_classes"][2]["sources"]=d["trigger_classes"][2]["sources"][:1]
  with self.assertRaises(ValueError): m.validate(d)

 def test_derived_surface_cannot_fake_provider_independence(self):
  d=valid(); r=next(x for x in d["trigger_classes"] if x["trigger_class"]=="INTEREST_ONLY_CROSSING_CANDIDATES")
  r["sources"]=[{"provider_id":"fake","operator":"fake","evidence_sha256":H(90)}]
  with self.assertRaises(ValueError): m.validate(d)

 def test_derived_surface_requires_authenticated_inputs_and_equivalence(self):
  for field in ("authenticated_input_commitments","algorithm_commitment","equivalence_commitment"):
   d=valid(); r=next(x for x in d["trigger_classes"] if x["trigger_class"]=="INTEREST_ONLY_CROSSING_CANDIDATES")
   r[field]=[] if field=="authenticated_input_commitments" else "0x"+"0"*64
   with self.assertRaises(ValueError): m.validate(d)

 def test_unknown_mismatch_lookahead_and_window_drift_fail_closed(self):
  mutations=[
   ("material_unknown_count",1),("unresolved_mismatch_count",1),("lookahead_used",True),("start_block",WINDOW["start_block"]+1)
  ]
  for field,value in mutations:
   d=valid(); d["trigger_classes"][4][field]=value
   with self.assertRaises(ValueError,msg=field): m.validate(d)

 def test_noncanonical_or_zero_hash_fails(self):
  for field in ("start_hash","end_hash"):
   d=valid(); d["window"][field]="0x"+"0"*64
   with self.assertRaises(ValueError): m.validate(d)

if __name__=="__main__": unittest.main()
