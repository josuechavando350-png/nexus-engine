#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json
from dataclasses import dataclass

PHASES={"PRE_TX":0,"LOG":1,"POST_TX":2,"END_BLOCK":3}
TERMINALS={"CAPTURED","EXPIRED","RECOVERED","REORG_INVALIDATED","RIGHT_CENSORED"}
OBSERVABILITY={"PUBLIC_OBSERVABLE","PARTIALLY_PRIVATE","PRIVATE_UNKNOWN"}

def canonical(v): return (json.dumps(v,sort_keys=True,separators=(",",":"))+"\n").encode()
def digest(v): return hashlib.sha256(canonical(v)).hexdigest()
def require(c,m):
    if not c: raise ValueError(m)

@dataclass(frozen=True,order=True)
class OrderPoint:
    block:int
    tx_index:int
    phase_rank:int
    log_index:int

    @classmethod
    def parse(cls,row):
        require(isinstance(row,dict),"order point must be object")
        block=row.get("block"); phase=row.get("phase")
        require(isinstance(block,int) and block>=0,"invalid block")
        require(phase in PHASES,f"invalid phase {phase!r}")
        if phase=="END_BLOCK":
            require(row.get("transaction_index") is None and row.get("log_index") is None,"END_BLOCK cannot carry tx/log index")
            return cls(block,2**31-1,PHASES[phase],2**31-1)
        tx=row.get("transaction_index")
        require(isinstance(tx,int) and tx>=0,"transaction_index required")
        if phase=="LOG":
            li=row.get("log_index"); require(isinstance(li,int) and li>=0,"LOG requires log_index")
        else:
            require(row.get("log_index") is None,"PRE_TX/POST_TX cannot carry log_index")
            li=-1
        return cls(block,tx,PHASES[phase],li)

def _point_json(row):
    return {
        "block":row["block"],
        "phase":row["phase"],
        "transaction_index":row.get("transaction_index"),
        "log_index":row.get("log_index"),
    }

def validate_episode(row):
    require(isinstance(row,dict),"episode must be object")
    oid=row.get("opportunity_id"); lineage=row.get("lineage_id")
    require(isinstance(oid,str) and oid,"opportunity_id missing")
    require(isinstance(lineage,str) and lineage,"lineage_id missing")
    left=row.get("left_censored") is True
    right=row.get("right_censored") is True

    birth=row.get("birth")
    if left:
        require(birth is None,"left-censored episode cannot invent birth")
    else:
        require(isinstance(birth,dict),"uncensored episode requires birth")

    actionable=row.get("first_actionable")
    executable=row.get("first_executable")
    require(isinstance(actionable,dict),"first_actionable required")
    require(isinstance(executable,dict),"first_executable required")
    a=OrderPoint.parse(actionable); e=OrderPoint.parse(executable)
    if not left:
        b=OrderPoint.parse(birth)
        require(b<=a,"birth after actionable")
    require(a<=e,"actionable after executable")

    hist=row.get("historical_execution_economics")
    require(isinstance(hist,dict),"historical execution/economics authority required")
    require(hist.get("pre_state_order") is not None,"historical authority lacks pre_state_order")
    pre=OrderPoint.parse(hist["pre_state_order"])
    require(pre<=e,"historical pre-state authority occurs after executable decision")
    require(isinstance(hist.get("authority_commitment"),str) and hist["authority_commitment"],"historical authority commitment missing")

    terminal=row.get("terminal")
    require(isinstance(terminal,dict),"terminal required")
    status=terminal.get("status")
    require(status in TERMINALS,f"invalid terminal status {status!r}")
    terminal_point=terminal.get("order")
    if right:
        require(status=="RIGHT_CENSORED","right_censored requires RIGHT_CENSORED terminal")
        require(terminal_point is None,"right-censored episode cannot invent terminal order")
        require(row.get("lifetime_seconds") is None,"right-censored episode cannot invent lifetime")
    else:
        require(status!="RIGHT_CENSORED","uncensored episode cannot use RIGHT_CENSORED")
        require(isinstance(terminal_point,dict),"terminal order required")
        t=OrderPoint.parse(terminal_point)
        require(e<=t,"terminal precedes executable state")
        require(isinstance(row.get("lifetime_seconds"),int) and row["lifetime_seconds"]>=0,"uncensored episode requires measured lifetime")

    obs=row.get("capture_observability")
    require(obs in OBSERVABILITY,"capture_observability invalid")
    arrival=row.get("time_to_first_competitor_arrival_ms")
    arrival_ev=row.get("competitor_arrival_evidence")
    if arrival is None:
        require(arrival_ev is None,"arrival evidence without measured arrival")
    else:
        require(isinstance(arrival,int) and arrival>=0,"arrival latency invalid")
        require(isinstance(arrival_ev,dict),"measured arrival needs direct evidence")
        require(arrival_ev.get("kind") in {"MEMPOOL","P2P","RELAY"},"arrival evidence must be direct timestamped flow")
        require(isinstance(arrival_ev.get("timestamp_commitment"),str) and arrival_ev["timestamp_commitment"],"arrival timestamp commitment missing")

    prediction=row.get("nexus_counterfactual")
    require(isinstance(prediction,dict),"Nexus counterfactual required")
    decision=OrderPoint.parse(prediction.get("decision_order"))
    max_evidence=OrderPoint.parse(prediction.get("max_evidence_order"))
    require(max_evidence<=decision,"Nexus counterfactual uses look-ahead")
    require(decision<=e,"counterfactual decision occurs after first executable state")
    require(prediction.get("capture_probability") is None,"capture probability cannot be invented")

    triggers=row.get("trigger_ids")
    require(isinstance(triggers,list) and triggers and len(triggers)==len(set(triggers)),"episode trigger_ids invalid")

    normalized={
        "opportunity_id":oid,
        "lineage_id":lineage,
        "left_censored":left,
        "right_censored":right,
        "birth":None if left else _point_json(birth),
        "first_actionable":_point_json(actionable),
        "first_executable":_point_json(executable),
        "historical_execution_economics":{
            "pre_state_order":_point_json(hist["pre_state_order"]),
            "authority_commitment":hist["authority_commitment"],
        },
        "terminal":{
            "status":status,
            "order":None if right else _point_json(terminal_point),
        },
        "lifetime_seconds":None if right else row["lifetime_seconds"],
        "capture_observability":obs,
        "time_to_first_competitor_arrival_ms":arrival,
        "competitor_arrival_evidence":arrival_ev,
        "nexus_counterfactual":{
            "decision_order":_point_json(prediction["decision_order"]),
            "max_evidence_order":_point_json(prediction["max_evidence_order"]),
            "capture_probability":None,
            "prediction_commitment":prediction.get("prediction_commitment"),
        },
        "trigger_ids":sorted(triggers),
    }
    require(isinstance(normalized["nexus_counterfactual"]["prediction_commitment"],str) and normalized["nexus_counterfactual"]["prediction_commitment"],"prediction commitment missing")
    return normalized

def validate_document(doc):
    require(isinstance(doc,dict) and doc.get("schema_version")==1,"schema")
    trigger_universe=doc.get("trigger_universe")
    require(isinstance(trigger_universe,list) and len(trigger_universe)==len(set(trigger_universe)),"trigger_universe invalid")
    episodes=doc.get("episodes"); rejections=doc.get("rejections")
    require(isinstance(episodes,list) and isinstance(rejections,list),"episodes/rejections required")
    normalized=[validate_episode(row) for row in episodes]
    ids=[row["opportunity_id"] for row in normalized]
    require(len(ids)==len(set(ids)),"duplicate opportunity_id")

    consumed={}
    for row in normalized:
        for trig in row["trigger_ids"]:
            prior=consumed.setdefault(trig,row["lineage_id"])
            require(prior==row["lineage_id"],f"trigger {trig} linked to unrelated lineages")

    rejected={}
    for row in rejections:
        require(isinstance(row,dict),"rejection must be object")
        tid=row.get("trigger_id"); reason=row.get("reason")
        require(isinstance(tid,str) and tid,"rejection trigger_id missing")
        require(isinstance(reason,str) and reason and reason!="UNKNOWN","rejection reason must be explicit non-UNKNOWN")
        require(tid not in rejected,"duplicate rejected trigger")
        rejected[tid]=reason

    overlap=set(consumed)&set(rejected)
    require(not overlap,f"triggers both consumed and rejected: {sorted(overlap)}")
    accounted=set(consumed)|set(rejected)
    require(accounted==set(trigger_universe),f"trigger conservation mismatch missing={sorted(set(trigger_universe)-accounted)} extra={sorted(accounted-set(trigger_universe))}")

    normalized.sort(key=lambda row:(row["lineage_id"],row["opportunity_id"]))
    normalized_rejections=sorted(
        [{"trigger_id":k,"reason":v} for k,v in rejected.items()],
        key=lambda row:row["trigger_id"],
    )
    result={
        "schema_version":1,
        "status":"RMC015B_EPISODE_FOUNDATION_VALID",
        "terminal_authority":False,
        "trigger_count":len(trigger_universe),
        "episode_count":len(normalized),
        "rejection_count":len(normalized_rejections),
        "trigger_conservation_complete":True,
        "lookahead_used":False,
        "material_unknown_terminal_count":0,
        "episodes":normalized,
        "rejections":normalized_rejections,
    }
    result["commitment"]="0x"+digest({
        "domain":"NQC-RMC015B-TEMPORAL-EPISODE-V1",
        "trigger_universe":sorted(trigger_universe),
        "episodes":normalized,
        "rejections":normalized_rejections,
    })
    return result
