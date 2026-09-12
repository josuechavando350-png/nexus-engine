from __future__ import annotations

import re
from collections import defaultdict
from typing import Any, Mapping, Sequence

from .common import PPM, InvalidData, InsufficientData, bounded_ratio_ppm, canonical_url_or_path, complement_ppm, config_phrases, contains_any_phrase, hash_value

_SHA_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_VALID_EXEC = {"SUCCESS","INSUFFICIENT_DATA","ERROR"}
_VALID_FINDING = {"FINDING","NO_FINDING","NOT_APPLICABLE"}


def _receipt_from_row(row: Any) -> Mapping[str, Any] | None:
    if not isinstance(row, Mapping):
        return None
    nested=row.get("receipt_payload")
    if isinstance(nested, Mapping):
        return nested
    return row

def _inspect_upstream(raw: Any):
    if not isinstance(raw,list):
        raise InvalidData("upstream_evidence_must_be_list")
    receipts=[]; invalid=[]
    for index,row in enumerate(raw):
        receipt=_receipt_from_row(row)
        if receipt is None:
            invalid.append({"index":index,"reason":"NOT_MAPPING"}); continue
        module=receipt.get("module"); operation=receipt.get("operation"); evidence_hash=receipt.get("evidence_hash")
        execution=receipt.get("execution_status"); finding=receipt.get("finding_status")
        if not isinstance(module,str) or not module or not isinstance(operation,str) or not operation:
            invalid.append({"index":index,"reason":"IDENTITY_INVALID"}); continue
        if not isinstance(evidence_hash,str) or not _SHA_RE.fullmatch(evidence_hash):
            invalid.append({"index":index,"module":module,"operation":operation,"reason":"EVIDENCE_HASH_FORMAT"}); continue
        body=dict(receipt); body.pop("evidence_hash",None)
        if hash_value(body)!=evidence_hash:
            invalid.append({"index":index,"module":module,"operation":operation,"reason":"EVIDENCE_HASH_MISMATCH"}); continue
        if execution not in _VALID_EXEC or finding not in _VALID_FINDING:
            invalid.append({"index":index,"module":module,"operation":operation,"reason":"STATUS_DOMAIN_INVALID"}); continue
        receipts.append(dict(receipt))
    receipts.sort(key=lambda r:(str(r["operation"]),str(r["module"]),str(r["evidence_hash"])))
    return receipts,invalid

def _by_operation(receipts):
    out:dict[str,list[dict[str,Any]]]=defaultdict(list)
    for receipt in receipts: out[str(receipt["operation"])].append(receipt)
    return out

def _health(receipt):
    return receipt.get("execution_status")=="SUCCESS" and receipt.get("finding_status")!="FINDING"

def proof_operation_health(spec, raw, config):
    receipts,invalid=_inspect_upstream(raw)
    if invalid: raise InvalidData("upstream_receipt_integrity_failure")
    required=spec["params"]["required_operation"]
    matching=[r for r in receipts if r["operation"]==required]
    if not matching: raise InsufficientData(f"upstream_proof_missing:{required}")
    healthy=sum(1 for r in matching if _health(r)); score=bounded_ratio_ppm(healthy,len(matching))
    failures=[{"module":r["module"],"execution_status":r["execution_status"],"finding_status":r["finding_status"],"reason_code":r.get("reason_code")} for r in matching if not _health(r)]
    return score,bool(failures),{"required_operation":required,"matching_receipt_count":len(matching),"healthy_receipt_count":healthy,"failures":failures}

def proof_bundle_health(spec, raw, config):
    receipts,invalid=_inspect_upstream(raw)
    if invalid: raise InvalidData("upstream_receipt_integrity_failure")
    byop=_by_operation(receipts); required=list(spec["params"]["required_operations"])
    missing=[op for op in required if not byop.get(op)]
    if missing: raise InsufficientData("proof_bundle_missing:"+",".join(missing))
    failures=[]; healthy=0
    for op in required:
        op_receipts=byop[op]
        if all(_health(r) for r in op_receipts): healthy+=1
        else: failures.append({"operation":op,"modules":[r["module"] for r in op_receipts if not _health(r)]})
    score=bounded_ratio_ppm(healthy,len(required))
    return score,bool(failures),{"required_operations":required,"healthy_operation_count":healthy,"operation_count":len(required),"failures":failures}

def search_content_observation_readiness(spec, normalized, config):
    search=normalized["search_performance_records"]; docs={canonical_url_or_path(d["document_id"]) or d["document_id"] for d in normalized["content_documents"]}
    scope_cfg=spec["params"]["scope_config"]
    phrases=() if scope_cfg=="none" else config_phrases(config,scope_cfg)
    rows=[r for r in search if not phrases or contains_any_phrase(r["query_tokens"],phrases)]
    if not rows: raise InsufficientData("search_observation_scope_empty")
    mode=spec["params"]["mode"]
    pages=sorted({r["page_url"] for r in rows})
    if mode=="landing_presence":
        present=[p for p in pages if p in docs]; missing=[p for p in pages if p not in docs]; score=bounded_ratio_ppm(len(present),len(pages))
        return score,bool(missing),{"observed_landing_count":len(pages),"present_content_count":len(present),"content_not_supplied":missing,"semantic":"CONTENT_CORPUS_PRESENCE_NOT_INDEX_STATUS"}
    if mode=="impression_presence":
        total=sum(r["impressions"] for r in rows)
        if total<=0: raise InsufficientData("search_impressions_empty")
        present=sum(r["impressions"] for r in rows if r["page_url"] in docs); score=bounded_ratio_ppm(present,total)
        return score,score<900_000,{"total_impressions":total,"content_present_impressions":present,"coverage_ppm":score,"semantic":"CONTENT_CORPUS_PRESENCE_NOT_INDEX_STATUS"}
    selected=[]
    for row in rows:
        if row["page_url"] in docs: continue
        if mode=="zero_click_gap" and row["clicks"]==0 and row["impressions"]>0: selected.append(row)
        if mode=="high_impression_gap" and row["impressions"]>=spec["params"]["high_impression_floor"]: selected.append(row)
    total=sum(r["impressions"] for r in rows)
    bad=sum(r["impressions"] for r in selected)
    if total<=0: raise InsufficientData("search_impressions_empty")
    score=complement_ppm(bounded_ratio_ppm(min(bad,total),total))
    findings=[{"query":r["query"],"page_url":r["page_url"],"impressions":r["impressions"],"clicks":r["clicks"]} for r in selected]
    return score,bool(findings),{"findings":findings,"semantic":"SEARCH_OBSERVED_CONTENT_NOT_SUPPLIED_NOT_UNINDEXED"}

def demand_weighted_proof_risk(spec, normalized, config):
    raw=normalized["upstream_evidence_raw"]; receipts,invalid=_inspect_upstream(raw)
    if invalid: raise InvalidData("upstream_receipt_integrity_failure")
    byop=_by_operation(receipts); required=list(spec["params"]["required_operations"])
    missing=[op for op in required if not byop.get(op)]
    if missing: raise InsufficientData("demand_weighted_proof_missing:"+",".join(missing))
    failed=sum(1 for op in required if not all(_health(r) for r in byop[op])); proof_risk=bounded_ratio_ppm(failed,len(required))
    search=normalized["search_performance_records"]; scope_cfg=spec["params"]["scope_config"]
    phrases=() if scope_cfg=="none" else config_phrases(config,scope_cfg)
    total=sum(r["impressions"] for r in search)
    scoped=sum(r["impressions"] for r in search if not phrases or contains_any_phrase(r["query_tokens"],phrases))
    if total<=0: raise InsufficientData("demand_weight_sample_empty")
    demand_share=bounded_ratio_ppm(min(scoped,total),total)
    risk=(proof_risk*demand_share)//PPM
    return complement_ppm(risk),risk>0,{"required_operations":required,"failed_operation_count":failed,"proof_risk_ppm":proof_risk,"scoped_impressions":scoped,"total_impressions":total,"demand_share_ppm":demand_share,"demand_weighted_risk_ppm":risk,"not_an_indexing_or_ranking_prediction":True}

def _walk_strings(value: Any):
    if isinstance(value,str):
        yield value
    elif isinstance(value,Mapping):
        for key,child in value.items():
            yield str(key); yield from _walk_strings(child)
    elif isinstance(value,list):
        for child in value: yield from _walk_strings(child)

def indexation_readiness_guard(spec, normalized, config, prior_receipts=None):
    mode=spec["params"]["mode"]
    raw=normalized.get("upstream_evidence_raw",[])
    try:
        receipts,invalid=_inspect_upstream(raw)
    except InvalidData:
        receipts=[]; invalid=[{"reason":"UPSTREAM_SCHEMA_INVALID"}]
    if mode=="receipt_hash_integrity":
        total=len(raw) if isinstance(raw,list) else 1; bad=len(invalid); score=complement_ppm(bounded_ratio_ppm(min(bad,total),max(1,total)))
        return score,bad>0,{"invalid_receipts":invalid,"input_receipt_count":total}
    if mode=="duplicate_module_conflict":
        seen:dict[str,str]={}; conflicts=[]
        for r in receipts:
            prior=seen.get(r["module"])
            if prior is None: seen[r["module"]]=r["evidence_hash"]
            elif prior!=r["evidence_hash"]: conflicts.append(r["module"])
        return PPM if not conflicts else 0,bool(conflicts),{"conflicting_modules":sorted(set(conflicts))}
    if mode=="duplicate_operation_conflict":
        mapping:dict[str,set[tuple[str,str]]]=defaultdict(set)
        for r in receipts: mapping[r["operation"]].add((r["module"],r["evidence_hash"]))
        conflicts=[{"operation":op,"distinct_receipts":len(vals)} for op,vals in mapping.items() if len(vals)>1]
        return PPM if not conflicts else 0,bool(conflicts),{"conflicting_operations":conflicts}
    if mode=="execution_error_propagation":
        errors=[{"module":r["module"],"operation":r["operation"],"reason_code":r.get("reason_code")} for r in receipts if r["execution_status"]=="ERROR"]
        return PPM if not errors else 0,bool(errors),{"upstream_errors":errors}
    if mode=="finding_propagation":
        findings=[{"module":r["module"],"operation":r["operation"],"reason_code":r.get("reason_code")} for r in receipts if r["finding_status"]=="FINDING"]
        return PPM if not findings else 0,bool(findings),{"upstream_findings":findings}
    if mode=="m1200_safe":
        if prior_receipts is None or "M1200" not in prior_receipts: raise InsufficientData("M1200_whitehat_receipt_missing")
        receipt=prior_receipts["M1200"]
        safe=receipt.get("execution_status")=="SUCCESS" and receipt.get("finding_status")=="NO_FINDING" and receipt.get("output",{}).get("release_safe") is True
        return PPM if safe else 0,not safe,{"m1200_release_safe":safe,"m1200_evidence_hash":receipt.get("evidence_hash")}
    if mode=="no_index_claim":
        if prior_receipts is None: raise InsufficientData("prior_receipts_missing")
        forbidden=[]
        for module,receipt in prior_receipts.items():
            for text in _walk_strings(receipt.get("output",{})):
                normalized_text=text.casefold().replace("-","_")
                if normalized_text in {"unindexed","not_indexed","is_indexed","indexed_true","indexed_false"}:
                    forbidden.append({"module":module,"claim":text})
        return PPM if not forbidden else 0,bool(forbidden),{"forbidden_index_state_claims":forbidden}
    if mode=="minimum_proof_coverage":
        required={"canonical_href_consistency","robots_meta_cardinality","visible_text_retention","status_code_parity","crawler_status_parity","crawler_content_type_parity","perimeter_evidence_completeness"}
        observed={r["operation"] for r in receipts}; covered=len(required&observed); score=bounded_ratio_ppm(covered,len(required))
        return score,score<PPM,{"required_operations":sorted(required),"observed_required_operations":sorted(required&observed),"coverage_ppm":score}
    if mode=="status_domain":
        bad=[]
        if isinstance(raw,list):
            for index,row in enumerate(raw):
                r=_receipt_from_row(row)
                if isinstance(r,Mapping) and (r.get("execution_status") not in _VALID_EXEC or r.get("finding_status") not in _VALID_FINDING): bad.append(index)
        return PPM if not bad else 0,bool(bad),{"invalid_status_record_indexes":bad}
    raise InvalidData(f"unsupported_readiness_guard_mode:{mode}")

def indexation_readiness_release_gate(spec, normalized, config, prior_receipts):
    if prior_receipts is None: raise InvalidData("M1400_prior_receipts_required")
    expected=("M1200",)+tuple(f"M{i}" for i in range(1391,1400))
    if tuple(prior_receipts)!=expected: raise InvalidData("M1400_prior_receipt_range_drift")
    blocking=[]; hashes=[]
    for module in expected:
        receipt=prior_receipts[module]
        evidence_hash=receipt.get("evidence_hash")
        if not isinstance(evidence_hash,str) or not _SHA_RE.fullmatch(evidence_hash): blocking.append({"module":module,"reason":"EVIDENCE_HASH_INVALID"}); continue
        body=dict(receipt); body.pop("evidence_hash",None)
        if hash_value(body)!=evidence_hash: blocking.append({"module":module,"reason":"EVIDENCE_HASH_MISMATCH"}); continue
        hashes.append(f"{module}:{evidence_hash}")
        if receipt.get("execution_status")!="SUCCESS": blocking.append({"module":module,"reason":"EXECUTION_NOT_SUCCESS"})
        if receipt.get("finding_status")=="FINDING": blocking.append({"module":module,"reason":str(receipt.get("reason_code"))})
    score=PPM if not blocking else 0
    return score,bool(blocking),{"checked_receipt_count":len(expected),"blocking_findings":blocking,"release_safe":not blocking,"prior_receipt_hashes_hash":hash_value(hashes)}
