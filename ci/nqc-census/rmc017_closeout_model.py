#!/usr/bin/env python3
import hashlib,json,re
REQUIRED=("RMC-014","RMC-015","RMC-016")
H=re.compile(r"^(?:sha256:|0x)?[0-9a-f]{64}$")
G=re.compile(r"^[0-9a-f]{40}$")
def canonical(v): return (json.dumps(v,sort_keys=True,separators=(",",":"))+"\n").encode()
def require(c,m):
 if not c: raise ValueError(m)
def validate(doc):
 require(isinstance(doc,dict) and doc.get("schema_version")==1,"schema")
 require(doc.get("real_market_census_closed") is False,"source lock cannot self-close")
 rows=doc.get("authorities"); require(isinstance(rows,list) and len(rows)==3,"three authorities required")
 by={}
 for r in rows:
  s=r.get("stage"); require(s in REQUIRED and s not in by,f"invalid/duplicate {s}")
  require(isinstance(r.get("workflow_run_id"),int) and r["workflow_run_id"]>0,f"{s}: run")
  require(isinstance(r.get("artifact_id"),int) and r["artifact_id"]>0,f"{s}: artifact")
  require(G.fullmatch(r.get("code_commit","")) and G.fullmatch(r.get("code_tree","")),f"{s}: git")
  require(H.fullmatch(r.get("artifact_digest","")),f"{s}: digest")
  require(r.get("admitted") is True and r.get("coverage_complete") is True,f"{s}: not admitted/complete")
  for k in ("unresolved_mismatch_count","unknown_failure_count","blocker_count"): require(r.get(k)==0,f"{s}: {k}")
  ev=r.get("evidence"); require(isinstance(ev,list) and ev and len(ev)==len(set(ev)) and all(H.fullmatch(x or "") for x in ev),f"{s}: evidence")
  if s=="RMC-014":
   require(r.get("structural_chain_certified") is True and r.get("real_market_census_closed") is False,"D14 boundary")
  if s=="RMC-015":
   require(r.get("temporal_conservation_complete") is True and r.get("lookahead_used") is False and r.get("material_unknown_count")==0,"D15 boundary")
  if s=="RMC-016":
   require(r.get("conservative_realizable_capacity_only") is True,"D16 conservative boundary")
   require(r.get("global_market_maximum_claimed") is False,"D16 global maximum forbidden")
   require(r.get("capture_adjusted_capacity_claimed") is False,"D16 capture claim forbidden")
  by[s]=r
 require(tuple(sorted(by,key=REQUIRED.index))==REQUIRED,"authority set")
 ordered=[by[s] for s in REQUIRED]
 commitment="0x"+hashlib.sha256(canonical({"domain":"NQC-RMC017-FINAL-CLOSEOUT-V1","authorities":ordered})).hexdigest()
 return {"schema_version":1,"status":"REAL_MARKET_CENSUS_CLOSED","real_market_census_closed":True,"realized_profitability_proven":False,"month1_target_proven":False,"authorities":ordered,"terminal_commitment":commitment}
