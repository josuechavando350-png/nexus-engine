from __future__ import annotations

from typing import Any, Mapping, Sequence

from .common import (
    PPM, InvalidData, InsufficientData, bounded_ratio_ppm, capped_ratio_ppm,
    complement_ppm, config_phrases, contains_any_phrase, gini_ppm, normalize_text, tokens,
)

EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"
SEMANTIC = "OBSERVED_ORGANIC_TEMPORAL_EVIDENCE_NOT_CAUSAL_RANK_OR_REVENUE_FORECAST"


def _rows(normalized: Mapping[str, Any], key: str, *, allow_empty: bool = False) -> list[Mapping[str, Any]]:
    raw = normalized.get(key, [])
    if not isinstance(raw, list):
        raise InvalidData(f"{key}_must_be_list")
    if not raw and not allow_empty:
        raise InsufficientData(f"{key}_empty")
    out: list[Mapping[str, Any]] = []
    for index, row in enumerate(raw):
        if not isinstance(row, Mapping):
            raise InvalidData(f"{key}_row_not_mapping:{index}")
        out.append(row)
    return out


def _path(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    raw=value.split("?",1)[0]
    if raw.startswith("/"): return raw
    marker=raw.find("://")
    if marker>=0:
        tail=raw[marker+3:]; slash=tail.find("/")
        return "/" if slash<0 else tail[slash:]
    return raw


def _need_nonnegative_int(value: Any, label: str) -> int:
    if isinstance(value,bool) or not isinstance(value,int) or value<0:
        raise InvalidData(f"{label}_invalid")
    return value


def _window_rows(normalized: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw=_rows(normalized,"traffic_window_records")
    seen:dict[str,dict[str,Any]]={}
    for index,row in enumerate(raw):
        entity=normalize_text(row.get("entity_id"))
        if not entity: raise InvalidData(f"traffic_window_entity_invalid:{index}")
        baseline=_need_nonnegative_int(row.get("baseline_visits"),f"traffic_window_baseline:{index}")
        current=_need_nonnegative_int(row.get("current_visits"),f"traffic_window_current:{index}")
        bd=_need_nonnegative_int(row.get("baseline_window_days"),f"traffic_window_baseline_days:{index}")
        cd=_need_nonnegative_int(row.get("current_window_days"),f"traffic_window_current_days:{index}")
        if bd==0 or cd==0: raise InvalidData(f"traffic_window_days_zero:{index}")
        item={"entity_id":entity,"baseline_visits":baseline,"current_visits":current,"baseline_window_days":bd,"current_window_days":cd}
        prior=seen.get(entity)
        if prior is not None and prior!=item: raise InvalidData(f"conflicting_traffic_window:{entity}")
        seen[entity]=item
    return [seen[k] for k in sorted(seen)]


def _series_rows(normalized: Mapping[str, Any]) -> list[dict[str,Any]]:
    raw=_rows(normalized,"traffic_series_records")
    seen:dict[str,dict[str,Any]]={}
    for index,row in enumerate(raw):
        entity=normalize_text(row.get("entity_id")); points=row.get("visits_series")
        if not entity or not isinstance(points,list) or not points: raise InvalidData(f"traffic_series_invalid:{index}")
        clean=[_need_nonnegative_int(value,f"traffic_series_point:{index}") for value in points]
        item={"entity_id":entity,"visits_series":clean}
        prior=seen.get(entity)
        if prior is not None and prior!=item: raise InvalidData(f"conflicting_traffic_series:{entity}")
        seen[entity]=item
    return [seen[k] for k in sorted(seen)]


def _decay_rows(normalized: Mapping[str, Any]) -> list[dict[str,Any]]:
    raw=_rows(normalized,"content_decay_records")
    seen:dict[str,dict[str,Any]]={}
    for index,row in enumerate(raw):
        doc=_path(row.get("document_id")) or normalize_text(row.get("document_id"))
        if not doc: raise InvalidData(f"content_decay_document_invalid:{index}")
        item={
            "document_id":doc,
            "baseline_clicks":_need_nonnegative_int(row.get("baseline_clicks"),f"decay_baseline_clicks:{index}"),
            "current_clicks":_need_nonnegative_int(row.get("current_clicks"),f"decay_current_clicks:{index}"),
            "baseline_impressions":_need_nonnegative_int(row.get("baseline_impressions"),f"decay_baseline_impressions:{index}"),
            "current_impressions":_need_nonnegative_int(row.get("current_impressions"),f"decay_current_impressions:{index}"),
            "baseline_window_days":_need_nonnegative_int(row.get("baseline_window_days"),f"decay_baseline_days:{index}"),
            "current_window_days":_need_nonnegative_int(row.get("current_window_days"),f"decay_current_days:{index}"),
        }
        if item["baseline_window_days"]==0 or item["current_window_days"]==0: raise InvalidData(f"content_decay_days_zero:{index}")
        prior=seen.get(doc)
        if prior is not None and prior!=item: raise InvalidData(f"conflicting_content_decay:{doc}")
        seen[doc]=item
    return [seen[k] for k in sorted(seen)]


def _share(good:int,total:int)->int:
    return bounded_ratio_ppm(good,total) if total>0 else 0


def _average(values:Sequence[int])->int:
    return sum(values)//len(values) if values else 0


def _median(values:Sequence[int])->int:
    if not values:return 0
    ordered=sorted(values); return ordered[(len(ordered)-1)//2]


def _lower_quartile(values:Sequence[int])->int:
    if not values:return 0
    ordered=sorted(values); return ordered[(len(ordered)-1)//4]


def _retention(current:int,baseline:int)->int:
    if baseline<=0:return PPM if current>0 else 0
    return capped_ratio_ppm(current,baseline)


def _direction(current:int,baseline:int)->int:
    return 1 if current>baseline else -1 if current<baseline else 0


def _weighted_retention(rows:Sequence[Mapping[str,Any]],current_key:str,baseline_key:str)->int:
    baseline=sum(int(r.get(baseline_key,0)) for r in rows); current=sum(int(r.get(current_key,0)) for r in rows)
    return _retention(current,baseline) if baseline or current else 0


def _feature_map(normalized:Mapping[str,Any],config:Mapping[str,Any])->dict[str,tuple[int,dict[str,Any]]]:
    windows=_window_rows(normalized); series=_series_rows(normalized); decay=_decay_rows(normalized)
    search=_rows(normalized,"search_performance_records")
    docs=_rows(normalized,"content_documents",allow_empty=True)
    canon=_rows(normalized,"canonicalization_records",allow_empty=True)
    semantic=_rows(normalized,"semantic_text_records",allow_empty=True)
    local=_rows(normalized,"local_business_records",allow_empty=True)
    funnel=_rows(normalized,"revenue_funnel_records",allow_empty=True)
    phrases={
        "service":config_phrases(config,"local_service_terms"),
        "location":config_phrases(config,"local_location_terms"),
        "commercial":config_phrases(config,"local_commercial_terms"),
        "urgency":config_phrases(config,"local_urgency_terms"),
    }
    features:dict[str,tuple[int,dict[str,Any]]]={}
    def put(name:str,score:int,**details:Any)->None:
        features[name]=(max(0,min(PPM,score)),details)

    doc_ids={str(r.get("document_id")) for r in docs}
    search_pages={_path(r.get("page_url")) for r in search}
    canon_map:dict[str,Mapping[str,Any]]={}
    for r in canon:
        for candidate in (_path(r.get("url")),_path(r.get("consolidated_to"))):
            if candidate:canon_map[candidate]=r
    entity_tokens:set[str]=set()
    for record in semantic:
        raw=record.get("entities")
        if isinstance(raw,list):
            for entity in raw:
                if isinstance(entity,Mapping):entity_tokens.update(tokens(entity.get("label")))
    local_tokens={token for row in local for token in tokens(row.get("name"))+tokens(row.get("address"))}

    # Equal-window portfolio evidence.
    equal=[r for r in windows if r["baseline_window_days"]==r["current_window_days"]]
    positive=[r for r in equal if r["baseline_visits"]>0]
    retentions=[_retention(r["current_visits"],r["baseline_visits"]) for r in positive]
    put("traffic_window_record_coverage",PPM if windows else 0,records=len(windows))
    put("traffic_window_equal_duration_integrity",_share(len(equal),len(windows)),equal_window_records=len(equal))
    put("traffic_window_positive_baseline_share",_share(len(positive),len(equal)) if equal else 0,positive_baselines=len(positive))
    put("traffic_window_average_retention",_average(retentions),analyzable_records=len(retentions))
    put("traffic_window_growth_share",_share(sum(1 for r in positive if r["current_visits"]>r["baseline_visits"]),len(positive)) if positive else 0,growth_records=sum(1 for r in positive if r["current_visits"]>r["baseline_visits"]))
    declines=sum(1 for r in positive if r["current_visits"]<r["baseline_visits"])
    put("traffic_window_decline_health",complement_ppm(_share(declines,len(positive))) if positive else 0,decline_records=declines)
    flat=sum(1 for r in positive if r["current_visits"]==r["baseline_visits"])
    put("traffic_window_flat_share",_share(flat,len(positive)) if positive else 0,flat_records=flat)
    severe=sum(1 for r in positive if r["current_visits"]*2<r["baseline_visits"])
    put("traffic_window_severe_decline_health",complement_ppm(_share(severe,len(positive))) if positive else 0,severe_declines=severe)
    put("traffic_window_median_retention",_median(retentions),retentions_ppm=retentions)
    weighted_ret=_weighted_retention(positive,"current_visits","baseline_visits")
    put("traffic_window_weighted_retention",weighted_ret,total_baseline_visits=sum(r["baseline_visits"] for r in positive),total_current_visits=sum(r["current_visits"] for r in positive))
    window_entities={_path(r["entity_id"]) or r["entity_id"] for r in windows}
    put("traffic_window_content_entity_bridge",_share(len(window_entities&doc_ids),len(window_entities)) if window_entities else 0,matched_entities=len(window_entities&doc_ids))
    put("traffic_window_search_landing_bridge",_share(len(window_entities&search_pages),len(window_entities)) if window_entities else 0,matched_entities=len(window_entities&search_pages))
    put("traffic_window_canonical_bridge",_share(len(window_entities&set(canon_map)),len(window_entities)) if window_entities else 0,matched_entities=len(window_entities&set(canon_map)))
    current_values=[r["current_visits"] for r in positive if r["current_visits"]>0]; baseline_values=[r["baseline_visits"] for r in positive if r["baseline_visits"]>0]
    current_gini=gini_ppm(current_values) if current_values else 0; baseline_gini=gini_ppm(baseline_values) if baseline_values else 0
    put("current_visit_concentration_health",complement_ppm(current_gini),gini_ppm=current_gini)
    put("baseline_visit_concentration_health",complement_ppm(baseline_gini),gini_ppm=baseline_gini)
    retention_gini=gini_ppm([max(1,v) for v in retentions]) if retentions else 0
    put("retention_dispersion_health",complement_ppm(retention_gini),gini_ppm=retention_gini)
    total_current=sum(current_values); top_current=max(current_values,default=0)
    put("top_entity_dependency_health",complement_ppm(_share(top_current,total_current)) if total_current else PPM,top_entity_current_visits=top_current)
    put("portfolio_floor_retention",min(retentions) if retentions else 0,retentions_ppm=retentions)
    put("lower_quartile_retention",_lower_quartile(retentions),retentions_ppm=retentions)
    window_flags=[bool(windows),bool(equal),bool(doc_ids),bool(search_pages),bool(canon_map)]
    put("traffic_window_evidence_breadth",_share(sum(1 for x in window_flags if x),len(window_flags)),evidence_families=sum(1 for x in window_flags if x))

    # Traffic-series observatory. These are cross-portfolio constructs, not duplicates of single legacy alarms.
    deep=[r for r in series if len(r["visits_series"])>=8]
    put("traffic_series_record_coverage",PPM if series else 0,records=len(series))
    put("traffic_series_minimum_depth_share",_share(len(deep),len(series)),deep_series=len(deep))
    put("traffic_series_nonzero_evidence_share",_share(sum(1 for r in series if any(r["visits_series"])),len(series)),nonzero_series=sum(1 for r in series if any(r["visits_series"])))
    put("traffic_series_recent_activity_share",_share(sum(1 for r in series if r["visits_series"][-1]>0),len(series)),recent_active_series=sum(1 for r in series if r["visits_series"][-1]>0))
    recover_min=[]; end_above_start=[]; end_above_median=[]; positive_steps=[]; negative_steps=[]; stable_steps=[]; consistency=[]; monotonic_recovery=[]; last_q_ret=[]; last_q_stability=[]; median_step_stability=[]; max_shock_health=[]; active_run_health=[]; recovery_latency=[]; peak_recapture=[]; trough_distance=[]; area_ret=[]; recent_strength=[]; sign_balance=[]; turning_health=[]
    for row in series:
        pts=row["visits_series"]; n=len(pts); end=pts[-1]; start=pts[0]; minimum=min(pts); maximum=max(pts); med=_median(pts)
        recover_min.append(PPM if end>minimum else 0)
        end_above_start.append(PPM if end>=start else 0); end_above_median.append(PPM if end>=med else 0)
        diffs=[pts[i]-pts[i-1] for i in range(1,n)]
        positive_steps.append(_share(sum(1 for d in diffs if d>0),len(diffs)) if diffs else PPM)
        negative_steps.append(complement_ppm(_share(sum(1 for d in diffs if d<0),len(diffs))) if diffs else PPM)
        stable_steps.append(_share(sum(1 for d in diffs if d==0),len(diffs)) if diffs else PPM)
        pos=sum(1 for d in diffs if d>0); neg=sum(1 for d in diffs if d<0); majority=max(pos,neg)
        consistency.append(_share(majority,len(diffs)) if diffs else PPM)
        min_index=min(range(n),key=lambda i:(pts[i],i)); after=pts[min_index:]
        mono=sum(1 for i in range(1,len(after)) if after[i]>=after[i-1])
        monotonic_recovery.append(_share(mono,max(1,len(after)-1)))
        q=max(1,n//4); first_q=sum(pts[:q]); last_q=sum(pts[-q:])
        last_q_ret.append(_retention(last_q,first_q))
        last_values=pts[-q:]; last_mean=sum(last_values)//len(last_values); deviation=sum(abs(v-last_mean) for v in last_values)
        stability_den=max(1,sum(last_values)); stability_penalty=min(PPM,(deviation*PPM)//stability_den)
        last_q_stability.append(complement_ppm(stability_penalty))
        abs_steps=sorted(abs(d) for d in diffs); median_step=abs_steps[(len(abs_steps)-1)//2] if abs_steps else 0
        step_den=max(1,med); median_penalty=min(PPM,(median_step*PPM)//step_den)
        median_step_stability.append(complement_ppm(median_penalty))
        max_step=max(abs_steps,default=0); max_penalty=min(PPM,(max_step*PPM)//max(1,maximum))
        max_shock_health.append(complement_ppm(max_penalty))
        longest=0; current=0
        for value in pts:
            current=current+1 if value>0 else 0; longest=max(longest,current)
        active_run_health.append(_share(longest,n))
        if min_index==n-1: recovery_latency.append(0)
        else:
            target=(minimum+maximum)//2; steps_to=None
            for idx in range(min_index+1,n):
                if pts[idx]>=target: steps_to=idx-min_index; break
            recovery_latency.append(complement_ppm(_share(steps_to or (n-min_index),max(1,n-min_index))))
        peak_recapture.append(_retention(end,maximum))
        trough_distance.append(_retention(end,maximum) if maximum else PPM)
        area_ret.append(_retention(sum(pts),max(1,maximum*n)))
        weights=list(range(1,n+1)); weighted=sum(v*w for v,w in zip(pts,weights)); denominator=max(1,maximum*sum(weights)); recent_strength.append(capped_ratio_ppm(weighted,denominator))
        sign_diff=abs(pos-neg); sign_balance.append(complement_ppm(_share(sign_diff,max(1,len(diffs)))))
        turns=0
        prev=0
        for d in diffs:
            sign=1 if d>0 else -1 if d<0 else 0
            if sign and prev and sign!=prev: turns+=1
            if sign: prev=sign
        turning_health.append(complement_ppm(_share(turns,max(1,len(diffs)-1))))
    put("traffic_series_recovery_from_minimum_share",_average(recover_min),series=len(series))
    put("traffic_series_ending_above_start_share",_average(end_above_start),series=len(series))
    put("traffic_series_ending_above_median_share",_average(end_above_median),series=len(series))
    put("traffic_series_positive_step_share",_average(positive_steps),series=len(series))
    put("traffic_series_negative_step_health",_average(negative_steps),series=len(series))
    put("traffic_series_stable_step_share",_average(stable_steps),series=len(series))
    put("traffic_series_direction_consistency",_average(consistency),series=len(series))
    put("traffic_series_monotonic_recovery_share",_average(monotonic_recovery),series=len(series))
    put("traffic_series_last_quartile_retention",_average(last_q_ret),series=len(series))
    put("traffic_series_last_quartile_stability",_average(last_q_stability),series=len(series))
    put("traffic_series_median_step_stability",_average(median_step_stability),series=len(series))
    put("traffic_series_max_step_shock_health",_average(max_shock_health),series=len(series))
    put("traffic_series_active_run_health",_average(active_run_health),series=len(series))
    put("traffic_series_recovery_latency_health",_average(recovery_latency),series=len(series))
    put("traffic_series_peak_recapture_share",_average(peak_recapture),series=len(series))
    put("traffic_series_trough_distance_health",_average(trough_distance),series=len(series))
    put("traffic_series_area_retention",_average(area_ret),series=len(series))
    put("traffic_series_recent_weighted_strength",_average(recent_strength),series=len(series))
    put("traffic_series_step_sign_balance",_average(sign_balance),series=len(series))
    put("traffic_series_turning_point_health",_average(turning_health),series=len(series))
    series_entities={_path(r["entity_id"]) or r["entity_id"] for r in series}
    put("traffic_series_entity_breadth",_share(len(series_entities&doc_ids),len(series_entities)) if series_entities else 0,content_backed_entities=len(series_entities&doc_ids))

    # Content-decay evidence cross-bound to current demand and structure.
    equal_decay=[r for r in decay if r["baseline_window_days"]==r["current_window_days"]]
    click_ret=[_retention(r["current_clicks"],r["baseline_clicks"]) for r in equal_decay if r["baseline_clicks"]>0]
    imp_ret=[_retention(r["current_impressions"],r["baseline_impressions"]) for r in equal_decay if r["baseline_impressions"]>0]
    put("content_decay_record_coverage",PPM if decay else 0,records=len(decay))
    put("content_decay_equal_window_integrity",_share(len(equal_decay),len(decay)),equal_window_records=len(equal_decay))
    put("content_decay_click_retention",_average(click_ret),records=len(click_ret))
    put("content_decay_impression_retention",_average(imp_ret),records=len(imp_ret))
    pairs=[]; ctr_ret=[]
    for r in equal_decay:
        if r["baseline_clicks"]>0 and r["baseline_impressions"]>0 and r["current_impressions"]>0:
            cr=_retention(r["current_clicks"],r["baseline_clicks"]); ir=_retention(r["current_impressions"],r["baseline_impressions"])
            pairs.append(complement_ppm(min(PPM,abs(cr-ir))))
            baseline_ctr=(r["baseline_clicks"]*PPM)//r["baseline_impressions"]
            current_ctr=(r["current_clicks"]*PPM)//r["current_impressions"]
            ctr_ret.append(_retention(current_ctr,baseline_ctr))
    put("content_decay_click_impression_balance",_average(pairs),records=len(pairs))
    put("content_decay_ctr_retention",_average(ctr_ret),records=len(ctr_ret))
    severe_click=sum(1 for r in equal_decay if r["baseline_clicks"]>0 and r["current_clicks"]*2<r["baseline_clicks"])
    severe_imp=sum(1 for r in equal_decay if r["baseline_impressions"]>0 and r["current_impressions"]*2<r["baseline_impressions"])
    dual=sum(1 for r in equal_decay if r["current_clicks"]<r["baseline_clicks"] and r["current_impressions"]<r["baseline_impressions"])
    put("content_decay_severe_click_health",complement_ppm(_share(severe_click,len(equal_decay))) if equal_decay else 0,severe_records=severe_click)
    put("content_decay_severe_impression_health",complement_ppm(_share(severe_imp,len(equal_decay))) if equal_decay else 0,severe_records=severe_imp)
    put("content_decay_dual_signal_health",complement_ppm(_share(dual,len(equal_decay))) if equal_decay else 0,dual_declines=dual)
    decay_ids={r["document_id"] for r in decay}
    put("content_decay_content_backing",_share(len(decay_ids&doc_ids),len(decay_ids)) if decay_ids else 0,matched_documents=len(decay_ids&doc_ids))
    put("content_decay_search_landing_backing",_share(len(decay_ids&search_pages),len(decay_ids)) if decay_ids else 0,matched_landings=len(decay_ids&search_pages))
    put("content_decay_canonical_backing",_share(len(decay_ids&set(canon_map)),len(decay_ids)) if decay_ids else 0,matched_canonicals=len(decay_ids&set(canon_map)))
    sitemap_backed=sum(1 for doc in decay_ids if doc in canon_map and canon_map[doc].get("sitemap_present") is True)
    inlink_backed=sum(1 for doc in decay_ids if doc in canon_map and isinstance(canon_map[doc].get("internal_inlinks"),int) and canon_map[doc].get("internal_inlinks")>0)
    put("content_decay_sitemap_backing",_share(sitemap_backed,len(decay_ids)) if decay_ids else 0,sitemap_backed=sitemap_backed)
    put("content_decay_inlink_backing",_share(inlink_backed,len(decay_ids)) if decay_ids else 0,inlink_backed=inlink_backed)
    doc_token_map={str(r.get("document_id")):set(r.get("tokens",[])) for r in docs}
    entity_backed=sum(1 for doc in decay_ids if doc in doc_token_map and doc_token_map[doc]&entity_tokens)
    local_backed=sum(1 for doc in decay_ids if doc in doc_token_map and doc_token_map[doc]&local_tokens)
    put("content_decay_entity_backing",_share(entity_backed,len(decay_ids)) if decay_ids else 0,entity_backed=entity_backed)
    put("content_decay_local_identity_backing",_share(local_backed,len(decay_ids)) if decay_ids else 0,local_identity_backed=local_backed)

    search_by_page:dict[str,list[Mapping[str,Any]]]={}
    for row in search:search_by_page.setdefault(_path(row.get("page_url")),[]).append(row)
    decaying={r["document_id"] for r in equal_decay if r["current_clicks"]<r["baseline_clicks"] or r["current_impressions"]<r["baseline_impressions"]}
    def demand_support(predicate=None)->int:
        eligible=[doc for doc in decaying if doc in search_by_page]
        if not decaying:return PPM
        if predicate is None:return _share(len(eligible),len(decaying))
        good=sum(1 for doc in decaying if any(predicate(row) for row in search_by_page.get(doc,[])))
        return _share(good,len(decaying))
    def high_intent(row:Mapping[str,Any])->bool:
        qt=row.get("query_tokens",[]); return any(contains_any_phrase(qt,phrases[k]) for k in ("commercial","service","urgency"))
    put("decaying_page_current_demand_support",demand_support(),decaying_pages=len(decaying))
    put("decaying_page_high_intent_support",demand_support(high_intent),decaying_pages=len(decaying))
    put("decaying_page_local_demand_support",demand_support(lambda r:contains_any_phrase(r.get("query_tokens",[]),phrases["location"])),decaying_pages=len(decaying))
    put("decaying_page_service_demand_support",demand_support(lambda r:contains_any_phrase(r.get("query_tokens",[]),phrases["service"])),decaying_pages=len(decaying))
    put("decaying_page_urgency_demand_support",demand_support(lambda r:contains_any_phrase(r.get("query_tokens",[]),phrases["urgency"])),decaying_pages=len(decaying))
    put("decaying_page_zero_click_opportunity_support",demand_support(lambda r:int(r.get("clicks",0))==0 and int(r.get("impressions",0))>0),decaying_pages=len(decaying))
    put("decaying_page_rank_gap_opportunity_support",demand_support(lambda r:10_000<int(r.get("average_position_milli",1_000_000))<=20_000),decaying_pages=len(decaying))
    click_gap=sum(max(0,r["baseline_clicks"]-r["current_clicks"]) for r in equal_decay); baseline_click=sum(r["baseline_clicks"] for r in equal_decay)
    imp_gap=sum(max(0,r["baseline_impressions"]-r["current_impressions"]) for r in equal_decay); baseline_imp=sum(r["baseline_impressions"] for r in equal_decay)
    put("decaying_page_click_gap_magnitude",_share(click_gap,baseline_click) if baseline_click else 0,click_gap=click_gap)
    put("decaying_page_impression_gap_magnitude",_share(imp_gap,baseline_imp) if baseline_imp else 0,impression_gap=imp_gap)

    # Cross-signal concordance and intervention evidence. Still observational only.
    window_map={_path(r["entity_id"]) or r["entity_id"]:r for r in equal}
    series_map={_path(r["entity_id"]) or r["entity_id"]:r for r in series}
    decay_map={r["document_id"]:r for r in equal_decay}
    shared_wd=sorted(set(window_map)&set(decay_map)); agree_wd=0
    for key in shared_wd:
        w=window_map[key]; d=decay_map[key]
        if _direction(w["current_visits"],w["baseline_visits"])==_direction(d["current_clicks"],d["baseline_clicks"]):agree_wd+=1
    put("traffic_window_decay_direction_concordance",_share(agree_wd,len(shared_wd)) if shared_wd else 0,shared_entities=len(shared_wd))
    shared_ws=sorted(set(window_map)&set(search_by_page)); concordant_ws=0
    for key in shared_ws:
        visits_dir=_direction(window_map[key]["current_visits"],window_map[key]["baseline_visits"])
        current_demand=sum(int(r.get("impressions",0)) for r in search_by_page[key])
        if (visits_dir>=0 and current_demand>0) or (visits_dir<0 and current_demand==0):concordant_ws+=1
    put("traffic_window_search_demand_concordance",_share(concordant_ws,len(shared_ws)) if shared_ws else 0,shared_entities=len(shared_ws))
    shared_sd=sorted(set(series_map)&set(decay_map)); agree_sd=0
    for key in shared_sd:
        pts=series_map[key]["visits_series"]; sdir=_direction(pts[-1],pts[0]); d=decay_map[key]; ddir=_direction(d["current_clicks"],d["baseline_clicks"])
        if sdir==ddir:agree_sd+=1
    put("traffic_series_decay_direction_concordance",_share(agree_sd,len(shared_sd)) if shared_sd else 0,shared_entities=len(shared_sd))
    retention_agreement=[]
    for key in shared_wd:
        wr=_retention(window_map[key]["current_visits"],window_map[key]["baseline_visits"]); dr=_retention(decay_map[key]["current_clicks"],decay_map[key]["baseline_clicks"])
        retention_agreement.append(complement_ppm(min(PPM,abs(wr-dr))))
    put("window_and_decay_retention_agreement",_average(retention_agreement),shared_entities=len(shared_wd))
    put("click_and_visit_direction_agreement",features["traffic_window_decay_direction_concordance"][0],shared_entities=len(shared_wd))
    imp_agree=0
    for key in shared_wd:
        w=window_map[key]; d=decay_map[key]
        if _direction(w["current_visits"],w["baseline_visits"])==_direction(d["current_impressions"],d["baseline_impressions"]):imp_agree+=1
    put("impression_and_visit_direction_agreement",_share(imp_agree,len(shared_wd)) if shared_wd else 0,shared_entities=len(shared_wd))

    demand_by_page={page:sum(int(r.get("impressions",0)) for r in rows) for page,rows in search_by_page.items()}
    total_demand=sum(demand_by_page.get(doc,0) for doc in decaying); all_demand=sum(demand_by_page.values())
    demand_signal=_share(total_demand,all_demand) if all_demand else 0
    put("demand_weighted_decay_review_signal",demand_signal,decaying_demand=total_demand)
    local_demand=sum(sum(int(r.get("impressions",0)) for r in search_by_page.get(doc,[]) if contains_any_phrase(r.get("query_tokens",[]),phrases["location"])) for doc in decaying)
    put("local_demand_weighted_decay_review_signal",_share(local_demand,all_demand) if all_demand else 0,local_decaying_demand=local_demand)
    high_demand=sum(sum(int(r.get("impressions",0)) for r in search_by_page.get(doc,[]) if high_intent(r)) for doc in decaying)
    put("high_intent_decay_review_signal",_share(high_demand,all_demand) if all_demand else 0,high_intent_decaying_demand=high_demand)
    organic_ids=config.get("organic_funnel_source_ids"); organic_set={normalize_text(v) for v in organic_ids} if isinstance(organic_ids,list) else set()
    organic_funnel=[r for r in funnel if normalize_text(r.get("source_id")) in organic_set]
    funnel_signal=demand_signal if organic_funnel else 0
    put("funnel_weighted_decay_review_signal",funnel_signal,organic_funnel_records=len(organic_funnel),not_a_revenue_forecast=True)
    recovery_parts=[features["traffic_series_recovery_from_minimum_share"][0],features["traffic_series_peak_recapture_share"][0],features["traffic_window_weighted_retention"][0]]
    put("recovery_evidence_confidence",_average(recovery_parts),component_scores=recovery_parts)
    preserve_parts=[features["content_decay_click_retention"][0],features["content_decay_impression_retention"][0],features["traffic_window_weighted_retention"][0],features["decaying_page_current_demand_support"][0]]
    put("preservation_evidence_confidence",_average(preserve_parts),component_scores=preserve_parts)
    structural_parts=[features["content_decay_canonical_backing"][0],features["content_decay_sitemap_backing"][0],features["content_decay_inlink_backing"][0],features["content_decay_entity_backing"][0]]
    put("structural_review_evidence_confidence",_average(structural_parts),component_scores=structural_parts)
    intervention_parts=[demand_signal,features["high_intent_decay_review_signal"][0],features["structural_review_evidence_confidence"][0],features["window_and_decay_retention_agreement"][0]]
    put("temporal_intervention_evidence_confidence",_average(intervention_parts),component_scores=intervention_parts)
    temporal_flags=[bool(windows),bool(series),bool(decay),bool(search),bool(docs),bool(canon),bool(semantic),bool(organic_funnel)]
    breadth=_share(sum(1 for x in temporal_flags if x),len(temporal_flags))
    put("temporal_evidence_breadth",breadth,evidence_families=sum(1 for x in temporal_flags if x))
    conflict_parts=[features["window_and_decay_retention_agreement"][0],features["click_and_visit_direction_agreement"][0],features["impression_and_visit_direction_agreement"][0],features["traffic_series_decay_direction_concordance"][0]]
    conflict_health=_average(conflict_parts)
    put("temporal_conflict_health",conflict_health,component_scores=conflict_parts)
    agreement_parts=[conflict_health,features["traffic_window_search_demand_concordance"][0],features["content_decay_click_impression_balance"][0]]
    signal_agreement=_average(agreement_parts)
    put("temporal_signal_agreement",signal_agreement,component_scores=agreement_parts)
    resilience_parts=[features["traffic_window_weighted_retention"][0],features["traffic_series_recent_weighted_strength"][0],features["content_decay_click_retention"][0],features["content_decay_impression_retention"][0],features["top_entity_dependency_health"][0]]
    resilience=_average(resilience_parts)
    put("temporal_resilience_score",resilience,component_scores=resilience_parts)
    readiness_parts=[breadth,signal_agreement,features["structural_review_evidence_confidence"][0],features["temporal_intervention_evidence_confidence"][0]]
    readiness=_average(readiness_parts)
    put("temporal_decision_readiness",readiness,component_scores=readiness_parts)
    final_parts=[resilience,readiness,conflict_health,features["recovery_evidence_confidence"][0],features["traffic_window_evidence_breadth"][0]]
    put("organic_temporal_observatory_health",_average(final_parts),component_scores=final_parts)
    return features


def temporal_observatory_metric(spec:Mapping[str,Any],normalized:Mapping[str,Any],config:Mapping[str,Any]):
    params=spec.get("params")
    if not isinstance(params,Mapping):raise InvalidData("temporal_observatory_params_missing")
    mode=params.get("mode")
    if not isinstance(mode,str):raise InvalidData("temporal_observatory_mode_invalid")
    features=_feature_map(normalized,config)
    if mode not in features:raise InvalidData(f"unsupported_temporal_observatory_mode:{mode}")
    score,details=features[mode]
    threshold=spec.get("threshold_ppm")
    if isinstance(threshold,bool) or not isinstance(threshold,int) or not 0<=threshold<=PPM:raise InvalidData("temporal_observatory_threshold_invalid")
    return score,score<threshold,{
        **details,
        "mode":mode,
        "semantic":SEMANTIC,
        "evidence_contract":EVIDENCE_CONTRACT,
        "observe_only":True,
        "temporal_observation_only":True,
        "no_google_scraping":True,
        "no_site_mutation":True,
        "not_causal_proof":True,
        "not_a_rank_forecast":True,
        "not_a_revenue_forecast":True,
        "not_an_indexation_guarantee":True,
    }
