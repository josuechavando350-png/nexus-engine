from __future__ import annotations

from collections import defaultdict
from typing import Any, Mapping

from .common import PPM, InvalidData, InsufficientData, all_phrase_tokens, bounded_ratio_ppm, canonical_url_or_path, complement_ppm, config_phrases, contains_any_phrase, gini_ppm, hash_value, normalize_text, shingle_set
from .kernel_shared import _document_matches_field, _modal, _phrase_positions, _record_field, _similar_pairs


def _content_term_doc_coverage(spec, normalized, config):
    docs=normalized["records"]; phrases=config_phrases(config,spec["params"]["terms_config"])
    if not docs: raise InsufficientData("content_documents_empty")
    matched=[d["document_id"] for d in docs if contains_any_phrase(d["tokens"],phrases)]
    share=bounded_ratio_ppm(len(matched),len(docs))
    return share,share<200_000,{"document_count":len(docs),"matching_document_count":len(matched),"coverage_ppm":share}

def _content_term_density(spec, normalized, config):
    docs=normalized["records"]; phrases=config_phrases(config,spec["params"]["terms_config"])
    termset=all_phrase_tokens(phrases); total=0; matched=0
    for d in docs:
        total += len(d["tokens"]); matched += sum(1 for t in d["tokens"] if t in termset)
    if total==0: raise InsufficientData("content_token_sample_empty")
    density=bounded_ratio_ppm(matched,total)
    violation=density==0 or density>100_000
    score=0 if density==0 else complement_ppm(min(PPM,density*5))
    return score,violation,{"token_count":total,"matched_token_count":matched,"density_ppm":density,"review_ceiling_ppm":100_000}

def _content_term_gini(spec, normalized, config):
    docs=normalized["records"]; phrases=config_phrases(config,spec["params"]["terms_config"]); termset=all_phrase_tokens(phrases)
    counts=[sum(1 for t in d["tokens"] if t in termset) for d in docs]
    if not any(counts): raise InsufficientData("configured_terms_absent")
    gini=gini_ppm(counts)
    return complement_ppm(gini),gini>800_000,{"document_count":len(docs),"distribution_gini_ppm":gini}

def _content_pair_cooccurrence(spec, normalized, config):
    docs=normalized["records"]
    left=config_phrases(config,spec["params"]["left_config"]); right=config_phrases(config,spec["params"]["right_config"])
    eligible=0; matched=[]
    for d in docs:
        l=contains_any_phrase(d["tokens"],left); r=contains_any_phrase(d["tokens"],right)
        if l or r: eligible += 1
        if l and r: matched.append(d["document_id"])
    if eligible==0: raise InsufficientData("pair_terms_absent")
    share=bounded_ratio_ppm(len(matched),eligible)
    return share,share<300_000,{"eligible_documents":eligible,"cooccurring_documents":matched,"coverage_ppm":share}

def _content_pair_proximity(spec, normalized, config):
    docs=normalized["records"]; left=config_phrases(config,spec["params"]["left_config"]); right=config_phrases(config,spec["params"]["right_config"]); window=spec["params"]["window_tokens"]
    distances=[]; close_docs=[]
    for d in docs:
        lp=_phrase_positions(d["tokens"],left); rp=_phrase_positions(d["tokens"],right)
        if not lp or not rp: continue
        dist=min(abs(a-b) for a in lp for b in rp); distances.append(dist)
        if dist<=window: close_docs.append(d["document_id"])
    if not distances: raise InsufficientData("pair_proximity_sample_empty")
    share=bounded_ratio_ppm(len(close_docs),len(distances))
    return share,share<500_000,{"analyzed_documents":len(distances),"within_window_documents":close_docs,"coverage_ppm":share,"window_tokens":window}

def _content_doorway(spec, normalized, config, strip_config=None):
    docs=normalized["records"]; p=spec["params"]
    strip=set()
    if strip_config:
        strip=all_phrase_tokens(config_phrases(config,strip_config))
    findings,count=_similar_pairs(docs,p["shingle_size"],p["similarity_ppm"],strip_terms=strip)
    if count<2: raise InsufficientData("similarity_documents_too_small")
    bad_pairs=len(findings); total_pairs=count*(count-1)//2
    score=complement_ppm(bounded_ratio_ppm(bad_pairs,total_pairs)) if total_pairs else PPM
    return score,bool(findings),{"analyzed_documents":count,"high_similarity_pairs":findings}

def _content_repetition(spec, normalized, config):
    docs=normalized["records"]; p=spec["params"]
    configs=[p["terms_config"]] if p.get("terms_config") else ["local_service_terms","local_location_terms"]
    termset=set()
    for key in configs: termset |= all_phrase_tokens(config_phrases(config,key))
    findings=[]
    for d in docs:
        total=len(d["tokens"])
        if total==0: continue
        matched=sum(1 for t in d["tokens"] if t in termset)
        share=bounded_ratio_ppm(matched,total)
        if share>p["max_term_share_ppm"]: findings.append({"document_id":d["document_id"],"term_share_ppm":share,"token_count":total})
    score=complement_ppm(min(PPM,len(findings)*100_000))
    return score,bool(findings),{"findings":findings,"review_ceiling_ppm":p["max_term_share_ppm"]}

def _content_thin(spec, normalized, config):
    docs=normalized["records"]; minimum=spec["params"]["min_tokens"]
    if not docs: raise InsufficientData("content_documents_empty")
    findings=[{"document_id":d["document_id"],"token_count":len(d["tokens"])} for d in docs if len(d["tokens"])<minimum]
    score=complement_ppm(bounded_ratio_ppm(len(findings),len(docs)))
    return score,bool(findings),{"minimum_tokens":minimum,"thin_documents":findings}

def _content_unique_value(spec, normalized, config):
    docs=normalized["records"]; floor=spec["params"]["min_unique_share_ppm"]
    findings=[]
    for d in docs:
        if not d["tokens"]: continue
        share=bounded_ratio_ppm(len(set(d["tokens"])),len(d["tokens"]))
        if share<floor: findings.append({"document_id":d["document_id"],"unique_token_share_ppm":share})
    if not docs: raise InsufficientData("content_documents_empty")
    score=complement_ppm(bounded_ratio_ppm(len(findings),len(docs)))
    return score,bool(findings),{"findings":findings,"minimum_unique_share_ppm":floor}

def _content_unique_shingle(spec, normalized, config):
    docs=normalized["records"]; width=spec["params"]["shingle_size"]; floor=spec["params"]["min_unique_share_ppm"]
    sh={d["document_id"]:shingle_set(d["tokens"],width) for d in docs}
    findings=[]
    for doc_id,own in sh.items():
        if not own: continue
        others=set()
        for other_id,vals in sh.items():
            if other_id!=doc_id: others |= vals
        unique=len(own-others); share=bounded_ratio_ppm(unique,len(own))
        if share<floor: findings.append({"document_id":doc_id,"unique_shingle_share_ppm":share,"shingle_count":len(own)})
    if not sh: raise InsufficientData("content_documents_empty")
    score=complement_ppm(bounded_ratio_ppm(len(findings),max(1,len(sh))))
    return score,bool(findings),{"findings":findings,"minimum_unique_share_ppm":floor}

def _content_local_fact_support(spec, normalized, config):
    local=normalized["local_business_records"]; docs=normalized["content_documents"]
    if not local or not docs: raise InsufficientData("local_fact_evidence_missing")
    name,_,_=_modal([r["name"] for r in local]); addr,_,_=_modal([r["address"] for r in local]); phone,_,_=_modal([r["phone"] for r in local])
    localish=config_phrases(config,"local_location_terms")
    findings=[]
    for d in docs:
        if not contains_any_phrase(d["tokens"],localish): continue
        supported=(_document_matches_field(d,name,"name") or _document_matches_field(d,addr,"address") or _document_matches_field(d,phone,"phone"))
        if not supported: findings.append({"document_id":d["document_id"]})
    score=complement_ppm(min(PPM,len(findings)*100_000))
    return score,bool(findings),{"unsupported_local_documents":findings}

def _content_nap_conflict(spec, normalized, config, field=None):
    local=normalized["local_business_records"]; docs=normalized["content_documents"]
    if not local or not docs: raise InsufficientData("nap_conflict_evidence_missing")
    fields=[field] if field else ["name","address","phone"]
    findings=[]
    for f in fields:
        modal,_,_=_modal([_record_field(r,f) for r in local])
        alternatives=sorted({_record_field(r,f) for r in local if _record_field(r,f) and _record_field(r,f)!=modal})
        for alt in alternatives:
            for d in docs:
                if _document_matches_field(d,alt,f):
                    findings.append({"document_id":d["document_id"],"field":f,"conflicting_value_hash":hash_value(alt)})
    score=complement_ppm(min(PPM,len(findings)*100_000))
    return score,bool(findings),{"conflicting_claims":findings}

def _content_allowed_term_guard(spec, normalized, config):
    docs=normalized["records"]; observed=config_phrases(config,spec["params"]["observed_config"]); allowed=config_phrases(config,spec["params"]["allowed_config"])
    observed_tokens=all_phrase_tokens(observed); allowed_tokens=all_phrase_tokens(allowed); forbidden=observed_tokens-allowed_tokens
    findings=[]
    if forbidden:
        for d in docs:
            hits=sorted(set(d["tokens"])&forbidden)
            if hits: findings.append({"document_id":d["document_id"],"unsupported_tokens":hits})
    return complement_ppm(min(PPM,len(findings)*100_000)),bool(findings),{"findings":findings}

def _query_only_page_risk(spec, normalized, config):
    search=normalized["search_performance_records"]; docs=normalized["content_documents"]
    if not search or not docs: raise InsufficientData("query_page_evidence_missing")
    by_page:dict[str,int]=defaultdict(int)
    for r in search: by_page[r["page_url"]]+=r["impressions"]
    findings=[]
    for d in docs:
        demand=by_page.get(d["document_id"],0)
        if demand>0 and len(d["tokens"])<120:
            findings.append({"document_id":d["document_id"],"observed_impressions":demand,"token_count":len(d["tokens"])})
    return complement_ppm(min(PPM,len(findings)*100_000)),bool(findings),{"query_only_risk_documents":findings}

def _commercial_intent_value(spec, normalized, config):
    search=normalized["search_performance_records"]; docs=normalized["content_documents"]; ph=config_phrases(config,"local_commercial_terms"); minimum=spec["params"]["min_tokens"]
    demand_pages={r["page_url"] for r in search if contains_any_phrase(r["query_tokens"],ph) and r["impressions"]>0}
    findings=[{"document_id":d["document_id"],"token_count":len(d["tokens"])} for d in docs if d["document_id"] in demand_pages and len(d["tokens"])<minimum]
    if not demand_pages: raise InsufficientData("commercial_demand_pages_empty")
    return complement_ppm(min(PPM,len(findings)*100_000)),bool(findings),{"commercial_demand_page_count":len(demand_pages),"findings":findings}

def _local_intent_identity(spec, normalized, config, *, near_me=False):
    search=normalized["search_performance_records"]; docs=normalized["content_documents"]; local=normalized["local_business_records"]
    if not search or not docs or not local: raise InsufficientData("local_intent_identity_evidence_missing")
    if near_me:
        ph=(( "near","me"),("cerca","de","mi"),("cerca","de","mí"))
    else:
        ph=config_phrases(config,"local_location_terms")
    name,_,_=_modal([r["name"] for r in local]); addr,_,_=_modal([r["address"] for r in local])
    demand_pages={r["page_url"] for r in search if contains_any_phrase(r["query_tokens"],ph) and r["impressions"]>0}
    findings=[]
    for d in docs:
        if d["document_id"] in demand_pages and not (_document_matches_field(d,name,"name") or _document_matches_field(d,addr,"address")):
            findings.append({"document_id":d["document_id"]})
    if not demand_pages: raise InsufficientData("local_intent_pages_empty")
    return complement_ppm(min(PPM,len(findings)*100_000)),bool(findings),{"demand_page_count":len(demand_pages),"missing_identity_pages":findings}

def _refresh_evidence(spec, normalized, config):
    rows=normalized["records"]; threshold=spec["params"]["min_decline_ppm"]; findings=[]; eligible=0
    for r in rows:
        if not isinstance(r,Mapping): continue
        needed=("baseline_clicks","current_clicks","baseline_impressions","current_impressions","baseline_window_days","current_window_days")
        if any(isinstance(r.get(k),bool) or not isinstance(r.get(k),int) for k in needed): continue
        if r["baseline_window_days"]<=0 or r["baseline_window_days"]!=r["current_window_days"]: continue
        if r["baseline_clicks"]<=0 and r["baseline_impressions"]<=0: continue
        eligible+=1
        click_decline=0 if r["baseline_clicks"]<=0 else max(0,((r["baseline_clicks"]-r["current_clicks"])*PPM)//r["baseline_clicks"])
        imp_decline=0 if r["baseline_impressions"]<=0 else max(0,((r["baseline_impressions"]-r["current_impressions"])*PPM)//r["baseline_impressions"])
        if max(click_decline,imp_decline)>=threshold:
            findings.append({"document_id":normalize_text(r.get("document_id")),"click_decline_ppm":click_decline,"impression_decline_ppm":imp_decline})
    if eligible==0: raise InsufficientData("refresh_decay_evidence_empty")
    return PPM if findings else 0, not bool(findings), {"evidence_backed_refresh_candidates":findings,"minimum_decline_ppm":threshold}

def _predecessor_policy(spec, normalized, config):
    rows=normalized["records"]
    if not rows: raise InsufficientData("upstream_evidence_empty")
    findings=[]
    for row in rows:
        if not isinstance(row,Mapping): continue
        receipt=row.get("receipt_payload",row)
        if not isinstance(receipt,Mapping): continue
        policy=str(receipt.get("policy_status",""))
        reason=str(receipt.get("reason_code",""))
        finding=receipt.get("finding_status")
        if finding=="FINDING" and ("CLOAK" in reason or "SPAM" in reason or "DOORWAY" in reason or "MANIPUL" in reason or policy in {"PROHIBITED","UNCERTAIN"}):
            findings.append({"module":str(receipt.get("module","UNKNOWN")),"reason_code":reason,"policy_status":policy})
    return PPM if not findings else 0,bool(findings),{"blocking_predecessor_findings":findings}

def _scaled_cardinality(spec, normalized, config):
    docs=normalized["records"]; threshold=spec["params"]["similarity_ppm"]; max_cluster=spec["params"]["max_similar_cluster"]
    findings,count=_similar_pairs(docs,5,threshold)
    graph:dict[str,set[str]]=defaultdict(set)
    for pair in findings:
        a=pair["document_a"]; b=pair["document_b"]; graph[a].add(b); graph[b].add(a)
    seen=set(); clusters=[]
    for node in sorted(graph):
        if node in seen: continue
        stack=[node]; comp=[]
        while stack:
            cur=stack.pop()
            if cur in seen: continue
            seen.add(cur); comp.append(cur); stack.extend(sorted(graph[cur]-seen))
        if len(comp)>max_cluster: clusters.append(sorted(comp))
    return PPM if not clusters else 0,bool(clusters),{"similarity_pair_count":len(findings),"oversized_similar_clusters":clusters,"max_similar_cluster":max_cluster}

def _information_gain(spec, normalized, config):
    docs=normalized["records"]; floor=spec["params"]["min_novel_token_count"]; findings=[]
    for d in docs:
        best_overlap=set()
        own=set(d["tokens"])
        for other in docs:
            if other["document_id"]==d["document_id"]: continue
            overlap=own & set(other["tokens"])
            if len(overlap)>len(best_overlap): best_overlap=overlap
        novel=len(own-best_overlap)
        if novel<floor: findings.append({"document_id":d["document_id"],"novel_token_count":novel})
    if len(docs)<2: raise InsufficientData("information_gain_requires_two_documents")
    return complement_ppm(bounded_ratio_ppm(len(findings),len(docs))),bool(findings),{"findings":findings,"minimum_novel_token_count":floor}

def _brand_identity_conflict(spec, normalized, config):
    return _content_nap_conflict(spec,normalized,config,field="name")

def _phone_identity_conflict(spec, normalized, config):
    return _content_nap_conflict(spec,normalized,config,field="phone")

def _address_identity_conflict(spec, normalized, config):
    return _content_nap_conflict(spec,normalized,config,field="address")

def _whitehat_gate(spec, normalized, config, prior_receipts):
    if prior_receipts is None:
        raise InvalidData("whitehat_gate_prior_receipts_required")
    required=tuple(f"M{i}" for i in range(1176,1200))
    if tuple(prior_receipts) != required:
        raise InvalidData("whitehat_gate_receipt_range_drift")
    blocking=[]
    for module_id in required:
        receipt=prior_receipts[module_id]
        if receipt.get("policy_status")!="SAFE_WHITE_HAT" or receipt.get("action_mode")!="OBSERVE_ONLY":
            blocking.append({"module":module_id,"reason":"UNSAFE_MODULE_METADATA"})
        if receipt.get("execution_status")=="ERROR":
            blocking.append({"module":module_id,"reason":"POLICY_MODULE_ERROR"})
        if receipt.get("finding_status")=="FINDING":
            blocking.append({"module":module_id,"reason":str(receipt.get("reason_code"))})
    return PPM if not blocking else 0,bool(blocking),{"checked_policy_modules":len(required),"blocking_findings":blocking,"release_safe":not blocking}
