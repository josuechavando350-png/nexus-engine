#!/usr/bin/env python3
import importlib.util, random, sys, unittest
from pathlib import Path
MODULE=Path(__file__).with_name("rmc016_capacity_model.py")
SPEC=importlib.util.spec_from_file_location("rmc016_capacity_model",MODULE)
assert SPEC and SPEC.loader
m=importlib.util.module_from_spec(SPEC); sys.modules[SPEC.name]=m; SPEC.loader.exec_module(m)

def opp(i,start,end,value,rid="flash",amount=1,capacity=1,kind="FLASH_CAPITAL"):
 return {"opportunity_id":f"o{i:02d}","start_order":start,"end_order":end,"success_path_value_usd_wad":value,"claims":[{"resource_kind":kind,"resource_id":rid,"amount":amount,"capacity":capacity}]}

class CapacityTests(unittest.TestCase):
 def test_nonoverlapping_reuse_is_not_conflict(self):
  rows=[opp(1,0,10,5),opp(2,10,20,7)]
  out=m.solve(rows)
  self.assertEqual(out["selected_opportunity_count"],2)
  self.assertEqual(out["success_path_capacity_usd_wad"],"12")

 def test_overlapping_exclusive_resource_conflicts(self):
  rows=[opp(1,0,11,5),opp(2,10,20,7)]
  out=m.solve(rows)
  self.assertEqual(out["selected_opportunity_ids"],["o02"])

 def test_numeric_capacity_supports_multiple_concurrent_claims(self):
  rows=[opp(1,0,10,5,amount=4,capacity=10),opp(2,0,10,7,amount=6,capacity=10),opp(3,0,10,20,amount=7,capacity=10)]
  out=m.solve(rows)
  self.assertEqual(out["selected_opportunity_ids"],["o03"])

 def test_three_way_capacity_is_not_reduced_to_pairwise_edges(self):
  rows=[opp(1,0,10,5,amount=4,capacity=10),opp(2,0,10,6,amount=4,capacity=10),opp(3,0,10,7,amount=4,capacity=10)]
  out=m.solve(rows)
  self.assertEqual(out["selected_opportunity_count"],2)
  self.assertEqual(out["success_path_capacity_usd_wad"],"13")

 def test_capacity_identity_mismatch_fails_closed(self):
  rows=[opp(1,0,10,5,amount=1,capacity=2),opp(2,0,10,7,amount=1,capacity=3)]
  with self.assertRaises(ValueError): m.solve(rows)

 def test_duplicate_claim_fails_closed(self):
  row=opp(1,0,10,5); row["claims"].append(dict(row["claims"][0]))
  with self.assertRaises(ValueError): m.solve([row])

 def test_short_window_is_not_extrapolated(self):
  r=m.window_report(0,7,0,30,100)
  self.assertEqual(r["status"],"INSUFFICIENT_TEMPORAL_WINDOW")
  self.assertIsNone(r["capacity_usd_wad"])
  self.assertFalse(r["extrapolation_used"])

 def test_exact_branch_and_bound_matches_bruteforce_500_random_cases(self):
  rng=random.Random(16016)
  for case in range(500):
   n=rng.randint(1,10); rows=[]
   capacities={"r0":rng.randint(1,3),"r1":rng.randint(1,3),"r2":rng.randint(1,3)}
   for i in range(n):
    start=rng.randint(0,8); end=start+rng.randint(1,5); rid=rng.choice(list(capacities))
    cap=capacities[rid]; amt=rng.randint(1,cap)
    rows.append(opp(i,start,end,rng.randint(0,50),rid,amt,cap))
   parsed=m.parse_opportunities(rows)
   a=m.exact_branch_and_bound(parsed); b=m.brute_force(parsed)
   self.assertEqual((m.value(a),m.ids(a)),(m.value(b),m.ids(b)),case)

 def test_input_order_independence_500_permutations(self):
  rows=[opp(1,0,10,10,"a"),opp(2,0,10,10,"a"),opp(3,10,20,8,"a"),opp(4,0,20,17,"b")]
  base=m.solve(rows)
  rng=random.Random(26016)
  for _ in range(500):
   p=list(rows); rng.shuffle(p)
   self.assertEqual(m.solve(p),base)

 def test_large_domain_is_explicit_lower_bound_not_global_claim(self):
  rows=[opp(i,i,i+2,i+1,f"r{i%5}",1,2) for i in range(30)]
  out=m.solve(rows)
  self.assertEqual(out["solver_mode"],"DETERMINISTIC_FEASIBLE_LOWER_BOUND")
  self.assertFalse(out["global_optimum_claimed"])
  self.assertTrue(out["conservative_realizable_capacity_only"])
  self.assertEqual(out["capture_probability"],"UNCALIBRATED")
  self.assertFalse(out["capture_adjusted_capacity_claimed"])

if __name__=="__main__": unittest.main()
