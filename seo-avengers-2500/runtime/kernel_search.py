from __future__ import annotations

from collections import defaultdict
from math import isqrt
from typing import Any, Mapping, Sequence

from .common import PPM, InsufficientData, bounded_ratio_ppm, complement_ppm, config_phrases, contains_any_phrase, gini_ppm
from .kernel_shared import _ctr_ppm, _filter_search_rows, _phrases_for_spec, _service_location_groups


def _search_band_opportunity(spec, normalized, config):
    rows = _filter_search_rows(normalized["records"], _phrases_for_spec(spec, config))
    p = spec["params"]
    findings = []
    eligible_impressions = 0
    finding_impressions = 0
    for row in rows:
        pos = row["average_position_milli"]
        if not p["position_min_milli"] <= pos <= p["position_max_milli"]:
            continue
        if row["impressions"] < p["min_impressions"] or row["impressions"] <= 0:
            continue
        eligible_impressions += row["impressions"]
        ctr = _ctr_ppm(row)
        if ctr <= p["max_ctr_ppm"]:
            finding_impressions += row["impressions"]
            findings.append({
                "query": row["query"], "page_url": row["page_url"], "clicks": row["clicks"],
                "impressions": row["impressions"], "average_position_milli": pos, "ctr_ppm": ctr,
            })
    if eligible_impressions == 0:
        raise InsufficientData("no_eligible_search_demand")
    bad_share = bounded_ratio_ppm(finding_impressions, eligible_impressions)
    score = complement_ppm(bad_share)
    findings.sort(key=lambda x:(-x["impressions"], x["ctr_ppm"], x["query"], x["page_url"]))
    return score, bool(findings), {"eligible_impressions": eligible_impressions, "opportunity_impressions": finding_impressions, "opportunities": findings}

def _search_pattern_share(spec, normalized, config):
    rows = normalized["records"]
    phrases = _phrases_for_spec(spec, config)
    if not rows:
        raise InsufficientData("search_records_empty")
    weight = spec["params"]["weight_field"]
    total = sum(int(row[weight]) for row in rows)
    if total <= 0:
        raise InsufficientData(f"search_{weight}_empty")
    selected = sum(int(row[weight]) for row in rows if contains_any_phrase(row["query_tokens"], phrases))
    share = bounded_ratio_ppm(selected, total)
    target = int(spec["params"]["share_ppm"])
    if spec["params"]["comparison"] == "min":
        violation = share < target
        score = share
    else:
        violation = share > target
        score = complement_ppm(share)
    return score, violation, {"weight_field": weight, "selected_weight": selected, "total_weight": total, "share_ppm": share, "policy_target_ppm": target}

def _search_query_page_degree(spec, normalized, config):
    rows = _filter_search_rows(normalized["records"], _phrases_for_spec(spec, config))
    pages: dict[str,set[str]] = defaultdict(set)
    for row in rows:
        pages[row["query"]].add(row["page_url"])
    if not pages:
        raise InsufficientData("query_page_graph_empty")
    minimum = int(spec["params"]["min_pages"])
    findings = [{"query":q,"distinct_page_count":len(v),"pages":sorted(v)} for q,v in pages.items() if len(v) >= minimum]
    findings.sort(key=lambda x:(-x["distinct_page_count"], x["query"]))
    bad = len(findings)
    score = complement_ppm(bounded_ratio_ppm(bad, len(pages))) if bad <= len(pages) else 0
    return score, bool(findings), {"query_node_count":len(pages),"fragmented_queries":findings}

def _search_page_query_degree(spec, normalized, config):
    rows = _filter_search_rows(normalized["records"], _phrases_for_spec(spec, config))
    queries: dict[str,set[str]] = defaultdict(set)
    for row in rows:
        queries[row["page_url"]].add(row["query"])
    if not queries:
        raise InsufficientData("page_query_graph_empty")
    minimum = int(spec["params"]["min_queries"])
    findings = [{"page_url":p,"distinct_query_count":len(v)} for p,v in queries.items() if len(v) >= minimum]
    findings.sort(key=lambda x:(-x["distinct_query_count"], x["page_url"]))
    bad = len(findings)
    score = complement_ppm(bounded_ratio_ppm(bad, len(queries))) if bad <= len(queries) else 0
    return score, bool(findings), {"page_node_count":len(queries),"broad_pages":findings}

def _search_pareto_frontier(spec, normalized, config):
    rows = _filter_search_rows(normalized["records"], _phrases_for_spec(spec, config))
    p=spec["params"]
    candidates=[]
    for row in rows:
        if row["impressions"] < p["min_impressions"] or row["average_position_milli"] > p["position_max_milli"] or row["impressions"] <= 0:
            continue
        ctr=_ctr_ppm(row)
        candidates.append({**row,"ctr_ppm":ctr,"ctr_deficit_ppm":PPM-ctr})
    if not candidates:
        raise InsufficientData("pareto_candidates_empty")
    frontier=[]
    for i,a in enumerate(candidates):
        dominated=False
        for j,b in enumerate(candidates):
            if i==j: continue
            at_least=(b["impressions"]>=a["impressions"] and b["ctr_deficit_ppm"]>=a["ctr_deficit_ppm"] and b["average_position_milli"]<=a["average_position_milli"])
            strict=(b["impressions"]>a["impressions"] or b["ctr_deficit_ppm"]>a["ctr_deficit_ppm"] or b["average_position_milli"]<a["average_position_milli"])
            if at_least and strict:
                dominated=True; break
        if not dominated:
            frontier.append({"query":a["query"],"page_url":a["page_url"],"impressions":a["impressions"],"ctr_ppm":a["ctr_ppm"],"average_position_milli":a["average_position_milli"]})
    frontier.sort(key=lambda x:(-x["impressions"],x["ctr_ppm"],x["average_position_milli"],x["query"]))
    share=bounded_ratio_ppm(len(frontier),len(candidates))
    return complement_ppm(share), bool(frontier), {"candidate_count":len(candidates),"frontier_count":len(frontier),"frontier":frontier}

def _search_gini(spec, normalized, config):
    rows=_filter_search_rows(normalized["records"], _phrases_for_spec(spec,config))
    if not rows: raise InsufficientData("gini_search_rows_empty")
    grouped:dict[str,int]=defaultdict(int)
    weight=spec["params"]["weight_field"]
    for row in rows: grouped[row["query"]]+=int(row[weight])
    gini=gini_ppm(list(grouped.values()))
    max_gini=600_000
    return complement_ppm(gini), gini>max_gini, {"group_count":len(grouped),"gini_ppm":gini,"max_gini_ppm":max_gini}

def _search_tensor(spec, normalized, config):
    rows=normalized["records"]
    services=_service_location_groups(config,"local_service_groups")
    locations=_service_location_groups(config,"local_location_groups")
    cells:dict[tuple[str,str],dict[str,Any]]={}
    classified_weight=0; total_weight=0
    weight_field=spec["params"]["weight_field"]
    for row in rows:
        total_weight += int(row[weight_field])
        service_hits=[name for name,ph in services.items() if contains_any_phrase(row["query_tokens"],ph)]
        location_hits=[name for name,ph in locations.items() if contains_any_phrase(row["query_tokens"],ph)]
        if not service_hits or not location_hits: continue
        classified_weight += int(row[weight_field])
        for s in service_hits:
            for l in location_hits:
                cell=cells.setdefault((s,l),{"service":s,"location":l,"impressions":0,"clicks":0,"weighted_position_num":0,"pages":set()})
                cell["impressions"] += row["impressions"]; cell["clicks"] += row["clicks"]
                cell["weighted_position_num"] += row["average_position_milli"]*max(1,row["impressions"])
                cell["pages"].add(row["page_url"])
    if total_weight<=0: raise InsufficientData("tensor_weight_empty")
    mode=spec["params"]["mode"]
    findings=[]
    for cell in cells.values():
        avgpos = cell["weighted_position_num"]//max(1,cell["impressions"])
        item={"service":cell["service"],"location":cell["location"],"impressions":cell["impressions"],"clicks":cell["clicks"],"average_position_milli":avgpos,"distinct_pages":len(cell["pages"])}
        if mode=="zero_click" and cell["impressions"]>0 and cell["clicks"]==0: findings.append(item)
        elif mode=="rank_gap" and cell["impressions"]>0 and avgpos>10_000: findings.append(item)
        elif mode=="page_dispersion" and len(cell["pages"])>1: findings.append(item)
    coverage=bounded_ratio_ppm(classified_weight,total_weight)
    if mode=="coverage":
        return coverage, coverage<700_000, {"classified_weight":classified_weight,"total_weight":total_weight,"coverage_ppm":coverage,"observed_cells":len(cells)}
    findings.sort(key=lambda x:(-x["impressions"],x["service"],x["location"]))
    bad_share=bounded_ratio_ppm(len(findings),max(1,len(cells))) if cells else 0
    return complement_ppm(bad_share), bool(findings), {"observed_cells":len(cells),"findings":findings}

def _search_ctr_confidence(spec, normalized, config):
    rows=_filter_search_rows(normalized["records"],_phrases_for_spec(spec,config))
    p=spec["params"]; findings=[]; analyzable=0
    for row in rows:
        n=row["impressions"]; k=row["clicks"]
        if n < p["min_impressions"] or n<=0: continue
        analyzable += 1
        ctr=(k*PPM)//n
        variance=(ctr*(PPM-ctr))//n
        se=isqrt(max(0,variance))
        upper=min(PPM,ctr+2*se)
        if upper < p["expected_ctr_ppm"]:
            findings.append({"query":row["query"],"page_url":row["page_url"],"impressions":n,"clicks":k,"ctr_ppm":ctr,"approx_upper_95_ppm":upper})
    if analyzable==0: raise InsufficientData("ctr_confidence_sample_empty")
    bad=bounded_ratio_ppm(len(findings),analyzable)
    return complement_ppm(bad),bool(findings),{"analyzed_records_count":analyzable,"findings":findings,"interval":"integer_normal_approx_2se"}

def _search_lift(spec, normalized, config, *, intersection=False):
    rows=normalized["records"]
    if not rows: raise InsufficientData("search_records_empty")
    keys=list(spec.get("config_terms",[]))
    phrase_sets=[config_phrases(config,k) for k in keys]
    def match(row):
        if intersection:
            return all(contains_any_phrase(row["query_tokens"],ps) for ps in phrase_sets)
        merged=tuple(p for ps in phrase_sets for p in ps)
        return contains_any_phrase(row["query_tokens"],merged)
    total_i=sum(r["impressions"] for r in rows); total_c=sum(r["clicks"] for r in rows)
    sub=[r for r in rows if match(r)]
    si=sum(r["impressions"] for r in sub); sc=sum(r["clicks"] for r in sub)
    if total_i<=0 or si<=0: raise InsufficientData("lift_sample_empty")
    overall=(total_c*PPM)//total_i
    subset=(sc*PPM)//si
    if overall==0:
        raise InsufficientData("overall_ctr_zero")
    lift=min(2*PPM,(subset*PPM)//overall)
    score=min(PPM,lift)
    return score,lift<PPM,{"subset_impressions":si,"subset_clicks":sc,"subset_ctr_ppm":subset,"overall_ctr_ppm":overall,"lift_ppm":lift}
