#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json
from dataclasses import dataclass
from typing import Iterable

TRIGGER_CLASSES = (
    "POSITION_MUTATIONS",
    "PROTOCOL_CONFIG_MUTATIONS",
    "ORACLE_PRICE_TRANSITIONS",
    "RATE_INDEX_SEGMENTS",
    "INTEREST_ONLY_CROSSING_CANDIDATES",
    "LIQUIDATION_OUTCOMES",
    "CANONICAL_CHAIN_REORG_AUTHORITY",
)
DERIVED = {"INTEREST_ONLY_CROSSING_CANDIDATES"}
MANDATORY_SURFACES = {
    "POSITION_MUTATIONS": {
        "SUPPLY","WITHDRAW","BORROW","REPAY","ATOKEN_TRANSFER",
        "VARIABLE_DEBT_MINT_BURN","COLLATERAL_USAGE_CHANGE","USER_EMODE_CHANGE",
    },
    "PROTOCOL_CONFIG_MUTATIONS": {
        "RESERVE_CONFIGURATION","LIQUIDATION_THRESHOLD","LIQUIDATION_BONUS",
        "LIQUIDATION_PROTOCOL_FEE","RESERVE_PAUSE_FREEZE_ACTIVE",
        "SUPPLY_BORROW_CAPS","ISOLATION_DEBT_CEILING","EMODE_CONFIGURATION",
        "ORACLE_CONFIGURATION","GOVERNANCE_EXECUTION_EFFECTS",
    },
}
HEX64 = set("0123456789abcdef")

def canonical(v): return (json.dumps(v,sort_keys=True,separators=(",",":"))+"\n").encode()
def digest(v): return hashlib.sha256(canonical(v)).hexdigest()
def require(c,m):
    if not c: raise ValueError(m)
def hash64(v,name):
    require(isinstance(v,str),f"{name}: string required")
    x=v[2:] if v.startswith("0x") else v
    require(len(x)==64 and all(ch in HEX64 for ch in x),f"{name}: canonical 32-byte lowercase hex required")
    require(set(x)!={"0"},f"{name}: zero hash forbidden")
    return x

@dataclass(frozen=True)
class Window:
    chain_id:int; start_block:int; start_hash:str; end_block:int; end_hash:str
    @classmethod
    def parse(cls,row):
        require(isinstance(row,dict),"window must be object")
        cid=row.get("chain_id"); sb=row.get("start_block"); eb=row.get("end_block")
        require(isinstance(cid,int) and cid>0,"invalid chain_id")
        require(isinstance(sb,int) and isinstance(eb,int) and 0<=sb<=eb,"invalid block window")
        return cls(cid,sb,hash64(row.get("start_hash"),"start_hash"),eb,hash64(row.get("end_hash"),"end_hash"))
    def json(self): return {"chain_id":self.chain_id,"start_block":self.start_block,"start_hash":"0x"+self.start_hash,"end_block":self.end_block,"end_hash":"0x"+self.end_hash}

def _sources(row,klass):
    values=row.get("sources")
    require(isinstance(values,list),f"{klass}: sources array required")
    if klass in DERIVED:
        require(values==[],f"{klass}: derived surface must not fake provider independence")
        return []
    require(len(values)>=2,f"{klass}: at least two provider observations required")
    providers=set(); operators=set(); normalized=[]
    for src in values:
        require(isinstance(src,dict),f"{klass}: source must be object")
        p=src.get("provider_id"); o=src.get("operator")
        require(isinstance(p,str) and p,f"{klass}: provider_id missing")
        require(isinstance(o,str) and o,f"{klass}: operator missing")
        require(p not in providers,f"{klass}: duplicate provider {p}")
        providers.add(p); operators.add(o)
        normalized.append({"provider_id":p,"operator":o,"evidence_sha256":hash64(src.get("evidence_sha256"),"evidence_sha256")})
    require(len(operators)>=2,f"{klass}: two providers from one operator are not independent")
    return sorted(normalized,key=lambda x:(x["operator"],x["provider_id"]))

def validate(doc):
    require(isinstance(doc,dict),"root must be object")
    require(doc.get("schema_version")==1,"schema_version must be 1")
    window=Window.parse(doc.get("window"))
    rows=doc.get("trigger_classes")
    require(isinstance(rows,list),"trigger_classes must be array")
    require(len(rows)==len(TRIGGER_CLASSES),"exactly seven trigger classes required")
    by={}
    for row in rows:
        require(isinstance(row,dict),"trigger row must be object")
        k=row.get("trigger_class")
        require(k in TRIGGER_CLASSES,f"unknown trigger class {k!r}")
        require(k not in by,f"duplicate trigger class {k}")
        require(row.get("coverage_complete") is True,f"{k}: coverage incomplete")
        require(row.get("lookahead_used") is False,f"{k}: look-ahead forbidden")
        require(row.get("unresolved_mismatch_count")==0,f"{k}: unresolved mismatch")
        require(row.get("material_unknown_count")==0,f"{k}: material UNKNOWN")
        require(row.get("start_block")==window.start_block and row.get("end_block")==window.end_block,f"{k}: window coverage differs")
        surfaces=row.get("surface_kinds")
        require(isinstance(surfaces,list) and len(surfaces)==len(set(surfaces)),f"{k}: invalid/duplicate surface_kinds")
        required=MANDATORY_SURFACES.get(k,set())
        require(required.issubset(set(surfaces)),f"{k}: mandatory surfaces missing: {sorted(required-set(surfaces))}")
        normalized={"trigger_class":k,"start_block":window.start_block,"end_block":window.end_block,"surface_kinds":sorted(surfaces),"sources":_sources(row,k),"coverage_complete":True,"lookahead_used":False,"unresolved_mismatch_count":0,"material_unknown_count":0}
        if k in DERIVED:
            inputs=row.get("authenticated_input_commitments")
            require(isinstance(inputs,list) and inputs and len(inputs)==len(set(inputs)),f"{k}: authenticated inputs required")
            normalized["authenticated_input_commitments"]=sorted(hash64(x,"authenticated input") for x in inputs)
            normalized["algorithm_commitment"]=hash64(row.get("algorithm_commitment"),"algorithm_commitment")
            normalized["equivalence_commitment"]=hash64(row.get("equivalence_commitment"),"equivalence_commitment")
        by[k]=normalized
    require(tuple(sorted(by,key=TRIGGER_CLASSES.index))==TRIGGER_CLASSES,"trigger class conservation failed")
    ordered=[by[k] for k in TRIGGER_CLASSES]
    commitment="0x"+digest({"domain":"NQC-RMC015A-TEMPORAL-TRIGGER-AUTHORITY-V1","window":window.json(),"trigger_classes":ordered})
    return {"schema_version":1,"status":"RMC015_TRIGGER_FOUNDATION_VALID","terminal_authority":False,"window":window.json(),"trigger_class_count":7,"coverage_complete":True,"unresolved_mismatch_count":0,"material_unknown_count":0,"lookahead_used":False,"commitment":commitment,"trigger_classes":ordered}

def main():
    import argparse
    p=argparse.ArgumentParser(); p.add_argument("input"); p.add_argument("--out")
    a=p.parse_args(); doc=json.load(open(a.input,encoding="utf-8")); out=validate(doc)
    b=canonical(out)
    if a.out: open(a.out,"wb").write(b)
    print("RMC015_TRIGGER_FOUNDATION_VALID commitment="+out["commitment"])

if __name__=="__main__": main()
