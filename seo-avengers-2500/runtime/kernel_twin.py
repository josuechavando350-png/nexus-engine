from __future__ import annotations

from collections import defaultdict
from typing import Any, Mapping, Sequence

from .common import (
    INT_MAX, PPM, InvalidData, InsufficientData, all_phrase_tokens, bounded_ratio_ppm,
    canonical_url_or_path, complement_ppm, config_phrases, contains_any_phrase,
    contains_phrase, gini_ppm, need_int, normalize_text, tokens,
)
from .kernel_shared import _service_location_groups


def _scope_rows(rows: Sequence[Mapping[str, Any]], config: Mapping[str, Any], cfg: str) -> list[dict[str, Any]]:
    if cfg == "none":
        return [dict(r) for r in rows]
    phrases = config_phrases(config, cfg)
    return [dict(r) for r in rows if contains_any_phrase(r["query_tokens"], phrases)]

def _doc_map(documents: Sequence[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    out: dict[str, Mapping[str, Any]] = {}
    for document in documents:
        key = canonical_url_or_path(document["document_id"]) or str(document["document_id"])
        out[key] = document
    return out

def _query_support_ppm(query_tokens: Sequence[str], document_tokens: Sequence[str]) -> int:
    q = set(query_tokens)
    if not q:
        raise InsufficientData("query_tokens_empty")
    return bounded_ratio_ppm(len(q.intersection(set(document_tokens))), len(q))

def twin_query_content_alignment(spec, normalized, config):
    search = normalized["search_performance_records"]
    docs = _doc_map(normalized["content_documents"])
    phrases = config_phrases(config, spec["params"]["intent_config"])
    rows = [r for r in search if contains_any_phrase(r["query_tokens"], phrases)]
    if not rows:
        raise InsufficientData("intent_search_observations_empty")
    mode = spec["params"]["mode"]
    eligible_weight = 0
    supported_weight = 0
    findings: list[dict[str, Any]] = []
    pages = sorted({r["page_url"] for r in rows})
    if mode == "page_content_presence":
        present = [page for page in pages if page in docs]
        score = bounded_ratio_ppm(len(present), len(pages))
        missing = [page for page in pages if page not in docs]
        return score, bool(missing), {"observed_landing_count":len(pages),"present_document_count":len(present),"missing_documents":missing,"coverage_ppm":score}
    for row in rows:
        if mode == "zero_click_support" and row["clicks"] != 0:
            continue
        if mode == "first_page_support" and row["average_position_milli"] > 10_000:
            continue
        weight = max(1, int(row["impressions"]))
        eligible_weight += weight
        document = docs.get(row["page_url"])
        if document is None:
            findings.append({"query":row["query"],"page_url":row["page_url"],"reason":"DOCUMENT_NOT_SUPPLIED"})
            continue
        if mode == "page_specialization":
            supported = contains_any_phrase(document["tokens"], phrases)
            support_ppm = PPM if supported else 0
        else:
            support_ppm = _query_support_ppm(row["query_tokens"], document["tokens"])
            supported = support_ppm >= 500_000
        if supported:
            supported_weight += weight
        else:
            findings.append({"query":row["query"],"page_url":row["page_url"],"support_ppm":support_ppm,"impressions":row["impressions"]})
    if eligible_weight == 0:
        raise InsufficientData("alignment_eligible_weight_empty")
    score = bounded_ratio_ppm(supported_weight, eligible_weight)
    findings.sort(key=lambda x:(-int(x.get("impressions",0)),x["query"],x["page_url"]))
    return score, score < 750_000, {"eligible_weight":eligible_weight,"supported_weight":supported_weight,"support_ppm":score,"findings":findings}

def twin_longtail_geometry(spec, normalized, config):
    rows = normalized["records"]
    lo = spec["params"]["min_tokens"]
    hi = spec["params"]["max_tokens"]
    selected = [r for r in rows if lo <= len(r["query_tokens"]) <= hi]
    if not rows:
        raise InsufficientData("search_observations_empty")
    mode = spec["params"]["mode"]
    total_i = sum(r["impressions"] for r in rows)
    total_c = sum(r["clicks"] for r in rows)
    selected_i = sum(r["impressions"] for r in selected)
    selected_c = sum(r["clicks"] for r in selected)
    if mode == "impression_share":
        if total_i <= 0: raise InsufficientData("impression_sample_empty")
        share = bounded_ratio_ppm(selected_i,total_i)
        return share, share < 50_000, {"selected_impressions":selected_i,"total_impressions":total_i,"share_ppm":share,"query_count":len(selected)}
    if mode == "click_share":
        if total_c <= 0: raise InsufficientData("click_sample_empty")
        share = bounded_ratio_ppm(selected_c,total_c)
        return share, share < 25_000, {"selected_clicks":selected_c,"total_clicks":total_c,"share_ppm":share,"query_count":len(selected)}
    if mode == "zero_click_share":
        if selected_i <= 0: raise InsufficientData("selected_impressions_empty")
        zero = sum(r["impressions"] for r in selected if r["clicks"] == 0)
        bad = bounded_ratio_ppm(zero,selected_i)
        return complement_ppm(bad), bad > 400_000, {"selected_impressions":selected_i,"zero_click_impressions":zero,"zero_click_share_ppm":bad}
    if mode == "landing_dispersion":
        if not selected: raise InsufficientData("selected_queries_empty")
        by_query: dict[str,set[str]] = defaultdict(set)
        for row in selected: by_query[row["query"]].add(row["page_url"])
        fragmented = [{"query":q,"page_count":len(p),"pages":sorted(p)} for q,p in by_query.items() if len(p)>1]
        bad = bounded_ratio_ppm(len(fragmented),len(by_query))
        return complement_ppm(bad), bool(fragmented), {"query_count":len(by_query),"fragmented_queries":sorted(fragmented,key=lambda x:(-x["page_count"],x["query"]))}
    raise InvalidData(f"unsupported_longtail_mode:{mode}")

def _cell_rows(search, services, locations, scope_phrases):
    cells: dict[tuple[str,str],dict[str,Any]] = {}
    for row in search:
        if scope_phrases and not contains_any_phrase(row["query_tokens"],scope_phrases):
            continue
        sh=[name for name,phrases in services.items() if contains_any_phrase(row["query_tokens"],phrases)]
        lh=[name for name,phrases in locations.items() if contains_any_phrase(row["query_tokens"],phrases)]
        for s in sh:
            for l in lh:
                cell=cells.setdefault((s,l),{"service":s,"location":l,"impressions":0,"clicks":0,"pages":set(),"rows":[]})
                cell["impressions"]+=row["impressions"]; cell["clicks"]+=row["clicks"]
                cell["pages"].add(row["page_url"]); cell["rows"].append(row)
    return cells

def twin_service_location_portfolio(spec, normalized, config):
    search=normalized["search_performance_records"]
    documents=_doc_map(normalized["content_documents"])
    services=_service_location_groups(config,"local_service_groups")
    locations=_service_location_groups(config,"local_location_groups")
    scope_cfg=spec["params"]["scope_config"]
    scope_phrases=() if scope_cfg=="none" else config_phrases(config,scope_cfg)
    cells=_cell_rows(search,services,locations,scope_phrases)
    mode=spec["params"]["mode"]
    theoretical=len(services)*len(locations)
    if theoretical<=0: raise InsufficientData("service_location_groups_empty")
    if mode=="cell_coverage":
        score=bounded_ratio_ppm(len(cells),theoretical)
        return score,score<250_000,{"observed_cells":len(cells),"theoretical_cells":theoretical,"coverage_ppm":score}
    if not cells: raise InsufficientData("service_location_cells_empty")
    if mode=="click_active":
        active=sum(1 for c in cells.values() if c["clicks"]>0); score=bounded_ratio_ppm(active,len(cells))
        return score,score<500_000,{"observed_cells":len(cells),"click_active_cells":active,"share_ppm":score}
    if mode=="zero_click":
        bad=[{"service":c["service"],"location":c["location"],"impressions":c["impressions"]} for c in cells.values() if c["impressions"]>0 and c["clicks"]==0]
        bad_share=bounded_ratio_ppm(len(bad),len(cells)); return complement_ppm(bad_share),bool(bad),{"zero_click_cells":sorted(bad,key=lambda x:(-x["impressions"],x["service"],x["location"]))}
    if mode=="landing_dispersion":
        bad=[{"service":c["service"],"location":c["location"],"page_count":len(c["pages"]),"pages":sorted(c["pages"])} for c in cells.values() if len(c["pages"])>1]
        bad_share=bounded_ratio_ppm(len(bad),len(cells)); return complement_ppm(bad_share),bool(bad),{"dispersed_cells":bad}
    if mode=="page_content_support":
        supported=0; findings=[]
        for (service,location),cell in sorted(cells.items()):
            service_phrases=services[service]; location_phrases=locations[location]
            cell_supported=False
            for page in cell["pages"]:
                doc=documents.get(page)
                if doc and contains_any_phrase(doc["tokens"],service_phrases) and contains_any_phrase(doc["tokens"],location_phrases):
                    cell_supported=True; break
            if cell_supported: supported+=1
            else: findings.append({"service":service,"location":location,"pages":sorted(cell["pages"]),"impressions":cell["impressions"]})
        score=bounded_ratio_ppm(supported,len(cells)); return score,bool(findings),{"supported_cells":supported,"observed_cells":len(cells),"unsupported_cells":findings}
    raise InvalidData(f"unsupported_portfolio_mode:{mode}")

def _organic_funnel(config, records):
    raw_ids=config.get("organic_funnel_source_ids")
    if not isinstance(raw_ids,list) or not raw_ids:
        raise InsufficientData("organic_funnel_source_ids_missing")
    wanted={normalize_text(v) for v in raw_ids if normalize_text(v)}
    candidates=[]
    for row in records:
        if not isinstance(row,Mapping) or normalize_text(row.get("source_id")) not in wanted: continue
        try:
            sessions=need_int(row.get("sessions"),"sessions",minimum=0,maximum=100_000_000_000)
            lead=need_int(row.get("lead_conversion_ppm"),"lead_conversion_ppm",minimum=0,maximum=PPM)
            close=need_int(row.get("close_rate_ppm"),"close_rate_ppm",minimum=0,maximum=PPM)
            ticket=need_int(row.get("average_ticket_micros"),"average_ticket_micros",minimum=0,maximum=INT_MAX)
        except InvalidData:
            continue
        candidates.append((normalize_text(row.get("source_id")),sessions,lead,close,ticket))
    if not candidates: raise InsufficientData("organic_funnel_evidence_missing")
    candidates.sort()
    total_sessions=sum(v[1] for v in candidates)
    if total_sessions<=0: raise InsufficientData("organic_funnel_sessions_empty")
    lead=sum(v[1]*v[2] for v in candidates)//total_sessions
    close=sum(v[1]*v[3] for v in candidates)//total_sessions
    ticket=sum(v[1]*v[4] for v in candidates)//total_sessions
    return lead,close,ticket,len(candidates)

def _priority_index(signal_count:int, lead:int, close:int, ticket:int) -> int:
    value=signal_count
    value=(value*lead)//PPM
    value=(value*close)//PPM
    if ticket and value>INT_MAX//ticket: return INT_MAX
    return value*ticket

def twin_economic_priority(spec, normalized, config):
    search=normalized["search_performance_records"]
    funnel=normalized.get("revenue_funnel_records",[])
    phrases=config_phrases(config,spec["params"]["intent_config"])
    rows=[r for r in search if contains_any_phrase(r["query_tokens"],phrases)]
    if not rows: raise InsufficientData("economic_intent_rows_empty")
    lead,close,ticket,source_count=_organic_funnel(config,funnel)
    mode=spec["params"]["mode"]
    if mode=="impression_value": selected=sum(r["impressions"] for r in rows); total=sum(r["impressions"] for r in search)
    elif mode=="click_value": selected=sum(r["clicks"] for r in rows); total=sum(r["clicks"] for r in search)
    elif mode=="zero_click_value": selected=sum(r["impressions"] for r in rows if r["clicks"]==0); total=sum(r["impressions"] for r in search)
    elif mode=="rank_gap_value": selected=sum(r["impressions"] for r in rows if r["average_position_milli"]>10_000); total=sum(r["impressions"] for r in search)
    else: raise InvalidData(f"unsupported_economic_mode:{mode}")
    if total<=0: raise InsufficientData("economic_signal_total_empty")
    share=bounded_ratio_ppm(min(selected,total),total)
    index=_priority_index(selected,lead,close,ticket)
    return complement_ppm(share),share>=100_000,{"selected_signal_count":selected,"total_signal_count":total,"opportunity_share_ppm":share,"funnel_weighted_priority_micros":index,"funnel_source_count":source_count,"not_a_revenue_forecast":True}

def twin_strategic_portfolio(spec, normalized, config):
    search=normalized["search_performance_records"]; docs=_doc_map(normalized["content_documents"]); mode=spec["params"]["mode"]
    if mode=="query_overlap":
        by_page:dict[str,set[str]]=defaultdict(set)
        for r in search: by_page[r["page_url"]].add(r["query"])
        pairs=[]; pages=sorted(by_page)
        for i,a in enumerate(pages):
            for b in pages[i+1:]:
                union=by_page[a]|by_page[b]
                if not union: continue
                score=bounded_ratio_ppm(len(by_page[a]&by_page[b]),len(union))
                if score>=500_000: pairs.append({"page_a":a,"page_b":b,"query_overlap_ppm":score})
        return complement_ppm(min(PPM,len(pairs)*100_000)),bool(pairs),{"high_overlap_pairs":pairs}
    if mode=="mixed_intent":
        configs=("local_service_terms","local_location_terms","local_commercial_terms","local_urgency_terms","local_question_terms","local_brand_terms")
        phrase_sets={k:config_phrases(config,k) for k in configs}; by_page:dict[str,set[str]]=defaultdict(set)
        for r in search:
            for key,phrases in phrase_sets.items():
                if contains_any_phrase(r["query_tokens"],phrases): by_page[r["page_url"]].add(key)
        findings=[{"page_url":p,"intent_family_count":len(v),"intent_families":sorted(v)} for p,v in by_page.items() if len(v)>=4]
        return complement_ppm(min(PPM,len(findings)*100_000)),bool(findings),{"mixed_intent_pages":findings}
    if mode=="opportunity_concentration":
        by_page:dict[str,int]=defaultdict(int); total=0
        for r in search:
            if r["impressions"]>0 and (r["clicks"]==0 or r["average_position_milli"]>10_000):
                by_page[r["page_url"]]+=r["impressions"]; total+=r["impressions"]
        if total<=0: raise InsufficientData("opportunity_impressions_empty")
        concentration=gini_ppm(list(by_page.values())); return complement_ppm(concentration),concentration>700_000,{"page_count":len(by_page),"opportunity_impressions":total,"gini_ppm":concentration}
    if mode in {"service_coverage","location_coverage"}:
        key="local_service_groups" if mode=="service_coverage" else "local_location_groups"; groups=_service_location_groups(config,key)
        observed={name for r in search for name,phrases in groups.items() if contains_any_phrase(r["query_tokens"],phrases)}
        score=bounded_ratio_ppm(len(observed),len(groups)); return score,score<500_000,{"group_count":len(groups),"observed_groups":sorted(observed),"coverage_ppm":score}
    if mode in {"commercial_location_joint","urgency_location_joint"}:
        left=config_phrases(config,"local_commercial_terms" if mode.startswith("commercial") else "local_urgency_terms"); right=config_phrases(config,"local_location_terms")
        total=sum(r["impressions"] for r in search); selected=sum(r["impressions"] for r in search if contains_any_phrase(r["query_tokens"],left) and contains_any_phrase(r["query_tokens"],right))
        if total<=0: raise InsufficientData("joint_demand_empty")
        share=bounded_ratio_ppm(selected,total); return share,share<50_000,{"selected_impressions":selected,"total_impressions":total,"share_ppm":share}
    if mode=="brand_nonbrand_balance":
        brand=config_phrases(config,"local_brand_terms"); total=sum(r["impressions"] for r in search)
        if total<=0: raise InsufficientData("brand_balance_empty")
        branded=sum(r["impressions"] for r in search if contains_any_phrase(r["query_tokens"],brand)); nonbrand=total-branded; dominant=max(branded,nonbrand); share=bounded_ratio_ppm(dominant,total)
        return complement_ppm(share),share>900_000,{"branded_impressions":branded,"nonbrand_impressions":nonbrand,"dominant_share_ppm":share}
    search_pages={r["page_url"] for r in search}; content_pages=set(docs)
    if mode=="search_without_content":
        missing=sorted(search_pages-content_pages); score=bounded_ratio_ppm(len(search_pages)-len(missing),max(1,len(search_pages)))
        return score,bool(missing),{"observed_search_pages":len(search_pages),"unmatched_search_pages":missing,"semantic":"SEARCH_OBSERVED_CONTENT_NOT_SUPPLIED"}
    if mode=="content_without_search":
        missing=sorted(content_pages-search_pages); score=bounded_ratio_ppm(len(content_pages)-len(missing),max(1,len(content_pages)))
        return score,bool(missing),{"supplied_content_pages":len(content_pages),"search_unobserved_content_pages":missing,"semantic":"SEARCH_UNOBSERVED_NOT_UNINDEXED"}
    raise InvalidData(f"unsupported_strategic_mode:{mode}")
