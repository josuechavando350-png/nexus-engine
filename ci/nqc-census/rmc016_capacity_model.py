#!/usr/bin/env python3
"""Deterministic conservative temporal capacity primitives for RMC-016."""

from __future__ import annotations
import hashlib, json
from dataclasses import dataclass
from typing import Iterable

RESOURCE_KINDS = {
    "OPPORTUNITY_LINEAGE",
    "BORROWER_POSITION",
    "FLASH_CAPITAL",
    "DEX_LIQUIDITY",
    "BLOCK_BUILDER_SLOT",
    "ORACLE_MOVE",
    "GAS_FUNDING",
    "PROTOCOL_MARKET_CAP",
    "ROUTE_VARIANT",
}
EXACT_SOLVER_LIMIT = 24

def canonical(v): return (json.dumps(v,sort_keys=True,separators=(",",":"))+"\n").encode()
def digest(v): return hashlib.sha256(canonical(v)).hexdigest()
def require(c,m):
    if not c: raise ValueError(m)

@dataclass(frozen=True, order=True)
class Claim:
    kind:str
    resource_id:str
    amount:int
    capacity:int

@dataclass(frozen=True)
class Opportunity:
    opportunity_id:str
    start:int
    end:int
    value:int
    claims:tuple[Claim,...]

    @classmethod
    def parse(cls,row):
        require(isinstance(row,dict),"opportunity must be object")
        oid=row.get("opportunity_id")
        require(isinstance(oid,str) and oid,"opportunity_id missing")
        start=row.get("start_order"); end=row.get("end_order"); value=row.get("success_path_value_usd_wad")
        require(isinstance(start,int) and isinstance(end,int) and start<end,f"{oid}: invalid half-open interval")
        require(isinstance(value,int) and value>=0,f"{oid}: invalid value")
        raw=row.get("claims"); require(isinstance(raw,list) and raw,f"{oid}: claims required")
        claims=[]; seen=set()
        for c in raw:
            require(isinstance(c,dict),f"{oid}: claim object required")
            kind=c.get("resource_kind"); rid=c.get("resource_id")
            amount=c.get("amount"); cap=c.get("capacity")
            require(kind in RESOURCE_KINDS,f"{oid}: unsupported resource kind {kind}")
            require(isinstance(rid,str) and rid,f"{oid}: resource_id missing")
            require(isinstance(amount,int) and isinstance(cap,int) and 0<amount<=cap,f"{oid}: invalid claim amount/capacity")
            key=(kind,rid)
            require(key not in seen,f"{oid}: duplicate resource claim {key}")
            seen.add(key); claims.append(Claim(kind,rid,amount,cap))
        claims.sort()
        return cls(oid,start,end,value,tuple(claims))

def parse_opportunities(rows):
    values=[Opportunity.parse(row) for row in rows]
    ids=[x.opportunity_id for x in values]
    require(len(ids)==len(set(ids)),"duplicate opportunity_id")
    capacities={}
    for opp in values:
        for claim in opp.claims:
            key=(claim.kind,claim.resource_id)
            prior=capacities.setdefault(key,claim.capacity)
            require(prior==claim.capacity,f"inconsistent capacity for {key}")
    return sorted(values,key=lambda x:x.opportunity_id)

def _resource_events(selected:Iterable[Opportunity]):
    resources={}
    for opp in selected:
        for claim in opp.claims:
            key=(claim.kind,claim.resource_id)
            bucket=resources.setdefault(key,{"capacity":claim.capacity,"events":[]})
            require(bucket["capacity"]==claim.capacity,f"inconsistent capacity for {key}")
            # Half-open interval [start,end): removals sort before additions at same coordinate.
            bucket["events"].append((opp.start,1,claim.amount,opp.opportunity_id))
            bucket["events"].append((opp.end,0,-claim.amount,opp.opportunity_id))
    return resources

def feasible(selected:Iterable[Opportunity]) -> bool:
    try:
        resources=_resource_events(selected)
        for key,bucket in resources.items():
            used=0
            for _,phase,delta,_ in sorted(bucket["events"],key=lambda x:(x[0],x[1],x[3])):
                used+=delta
                if used<0 or used>bucket["capacity"]:
                    return False
            if used!=0: return False
        return True
    except ValueError:
        return False

def value(selected): return sum(x.value for x in selected)
def ids(selected): return tuple(sorted(x.opportunity_id for x in selected))

def better(candidate,best):
    cv=value(candidate); bv=value(best)
    return cv>bv or (cv==bv and ids(candidate)<ids(best))

def brute_force(opportunities):
    ops=parse_opportunities(opportunities) if opportunities and isinstance(opportunities[0],dict) else sorted(opportunities,key=lambda x:x.opportunity_id)
    require(len(ops)<=20,"brute force limited to 20")
    best=[]
    for mask in range(1<<len(ops)):
        chosen=[ops[i] for i in range(len(ops)) if mask>>i&1]
        if feasible(chosen) and better(chosen,best): best=chosen
    return sorted(best,key=lambda x:x.opportunity_id)

def exact_branch_and_bound(opportunities):
    ops=parse_opportunities(opportunities) if opportunities and isinstance(opportunities[0],dict) else sorted(opportunities,key=lambda x:x.opportunity_id)
    require(len(ops)<=EXACT_SOLVER_LIMIT,f"exact solver limit {EXACT_SOLVER_LIMIT}")
    # Higher value first improves pruning; stable id is deterministic tie-break.
    ordered=sorted(ops,key=lambda x:(-x.value,x.opportunity_id))
    suffix=[0]*(len(ordered)+1)
    for i in range(len(ordered)-1,-1,-1): suffix[i]=suffix[i+1]+ordered[i].value
    best=[]
    def visit(i,chosen,current):
        nonlocal best
        if current+suffix[i] < value(best): return
        if i==len(ordered):
            if better(chosen,best): best=list(chosen)
            return
        opp=ordered[i]
        chosen.append(opp)
        if feasible(chosen): visit(i+1,chosen,current+opp.value)
        chosen.pop()
        visit(i+1,chosen,current)
    visit(0,[],0)
    return sorted(best,key=lambda x:x.opportunity_id)

def deterministic_lower_bound(opportunities):
    ops=parse_opportunities(opportunities) if opportunities and isinstance(opportunities[0],dict) else sorted(opportunities,key=lambda x:x.opportunity_id)
    chosen=[]
    for opp in sorted(ops,key=lambda x:(-x.value,x.opportunity_id)):
        trial=chosen+[opp]
        if feasible(trial): chosen=trial
    return sorted(chosen,key=lambda x:x.opportunity_id)

def solve(rows):
    ops=parse_opportunities(rows)
    if len(ops)<=EXACT_SOLVER_LIMIT:
        selected=exact_branch_and_bound(ops); mode="EXACT_BRANCH_AND_BOUND"; global_optimum=True
    else:
        selected=deterministic_lower_bound(ops); mode="DETERMINISTIC_FEASIBLE_LOWER_BOUND"; global_optimum=False
    require(feasible(selected),"solver emitted infeasible result")
    result={
        "schema_version":1,
        "status":"RMC016_CAPACITY_FOUNDATION_VALID",
        "solver_mode":mode,
        "global_optimum_claimed":global_optimum,
        "conservative_realizable_capacity_only":True,
        "capture_probability":"UNCALIBRATED",
        "capture_adjusted_capacity_claimed":False,
        "input_opportunity_count":len(ops),
        "selected_opportunity_count":len(selected),
        "selected_opportunity_ids":list(ids(selected)),
        "success_path_capacity_usd_wad":str(value(selected)),
    }
    result["commitment"]="0x"+digest(result)
    return result

def window_report(observed_start,observed_end,requested_start,requested_end,capacity):
    require(all(isinstance(x,int) for x in (observed_start,observed_end,requested_start,requested_end)),"window integers required")
    require(observed_start<observed_end and requested_start<requested_end,"invalid window")
    covered=observed_start<=requested_start and requested_end<=observed_end
    return {
        "requested_window":[requested_start,requested_end],
        "observed_window":[observed_start,observed_end],
        "capacity_usd_wad":str(capacity) if covered else None,
        "status":"COVERED" if covered else "INSUFFICIENT_TEMPORAL_WINDOW",
        "extrapolation_used":False,
    }
