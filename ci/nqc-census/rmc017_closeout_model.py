#!/usr/bin/env python3
import hashlib,json,re
REQUIRED=("RMC-014","RMC-015","RMC-016")
H=re.compile(r"^(?:sha256:|0x)?[0-9a-f]{64}$")
G=re.compile(r"^[0-9a-f]{40}$")
A=re.compile(r"^sha256:[0-9a-f]{64}$")
def nonzero_hash(v):
 if not isinstance(v,str) or not H.fullmatch(v): return False
 return any(ch!="0" for ch in v.removeprefix("sha256:").removeprefix("0x"))
def canonical(v): return (json.dumps(v,sort_keys=True,separators=(",",":"))+"\n").encode()
def require(c,m):
 if not c: raise ValueError(m)
def validate(doc):
 require(isinstance(doc,dict) and type(doc.get("schema_version")) is int and doc["schema_version"]==1,"schema")
 require(doc.get("real_market_census_closed") is False,"source lock cannot self-close")
 rows=doc.get("authorities"); require(isinstance(rows,list) and len(rows)==3,"three authorities required")
 by={}
 for r in rows:
  require(isinstance(r,dict),"authority row must be object")
  s=r.get("stage"); require(s in REQUIRED and s not in by,f"invalid/duplicate {s}")
  require(type(r.get("workflow_run_id")) is int and r["workflow_run_id"]>0,f"{s}: run")
  require(type(r.get("artifact_id")) is int and r["artifact_id"]>0,f"{s}: artifact")
  require(all(isinstance(r.get(k),str) and G.fullmatch(r[k]) and r[k]!="0"*40 for k in ("code_commit","code_tree")),f"{s}: git")
  require(isinstance(r.get("artifact_digest"),str) and A.fullmatch(r["artifact_digest"]) and nonzero_hash(r["artifact_digest"]),f"{s}: digest")
  require(r.get("admitted") is True and r.get("coverage_complete") is True,f"{s}: not admitted/complete")
  for k in ("unresolved_mismatch_count","unknown_failure_count","blocker_count"):
   require(type(r.get(k)) is int and r[k]==0,f"{s}: {k}")
  ev=r.get("evidence")
  require(isinstance(ev,list) and ev and all(nonzero_hash(x) for x in ev) and len(ev)==len(set(ev)),f"{s}: evidence")
  if s=="RMC-014":
   require(r.get("structural_chain_certified") is True and r.get("real_market_census_closed") is False,"D14 boundary")
  if s=="RMC-015":
   require(r.get("temporal_conservation_complete") is True and r.get("lookahead_used") is False and type(r.get("material_unknown_count")) is int and r["material_unknown_count"]==0,"D15 boundary")
  if s=="RMC-016":
   require(r.get("conservative_realizable_capacity_only") is True,"D16 conservative boundary")
   require(r.get("global_market_maximum_claimed") is False,"D16 global maximum forbidden")
   require(r.get("capture_adjusted_capacity_claimed") is False,"D16 capture claim forbidden")
  by[s]=r
 require(tuple(sorted(by,key=REQUIRED.index))==REQUIRED,"authority set")
 ordered=[by[s] for s in REQUIRED]
 commitment="0x"+hashlib.sha256(canonical({"domain":"NQC-RMC017-FOUNDATION-CANDIDATE-V2","authorities":ordered})).hexdigest()
 # This is strictly an offline structural candidate. It cannot authenticate
 # remote GitHub runs, artifact ZIP bytes, or exact inner evidence contracts.
 # Only a separately implemented terminal workflow, after independent
 # reauthentication of D14/D15/D16, may ever emit final Census closure.
 return {"schema_version":1,"status":"RMC017_FOUNDATION_CANDIDATE_VALID_NOT_CERTIFIED",
         "terminal_authority":False,"independent_artifact_authentication_complete":False,
         "real_market_census_closed":False,"realized_profitability_proven":False,
         "month1_target_proven":False,"authorities":ordered,"candidate_commitment":commitment}
