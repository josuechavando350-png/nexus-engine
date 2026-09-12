from __future__ import annotations

from collections import defaultdict
from typing import Any, Mapping

from .common import PPM, InsufficientData, bounded_ratio_ppm, canonical_url_or_path, complement_ppm, config_phrases, contains_any_phrase, hash_value, lower_median, tokens
from .kernel_shared import _coord_distance, _document_matches_field, _modal, _record_field, _select_scope_documents


def _nap_content(spec, normalized, config):
    local=normalized["local_business_records"]; docs=normalized["content_documents"]; search=normalized["search_performance_records"]
    if not local or not docs: raise InsufficientData("nap_content_evidence_missing")
    field=spec["params"]["field"]
    values=[_record_field(r,field) for r in local]
    modal,count,total=_modal(values)
    scoped=_select_scope_documents(docs,search,spec["params"]["scope"],config)
    if not scoped: raise InsufficientData("scoped_documents_empty")
    matched=[d["document_id"] for d in scoped if _document_matches_field(d,modal,field)]
    share=bounded_ratio_ppm(len(matched),len(scoped))
    return share,share<500_000,{"modal_value_hash":hash_value(modal),"source_quorum_count":count,"source_value_count":total,"scoped_document_count":len(scoped),"corroborating_documents":matched,"coverage_ppm":share}

def _local_field_quorum(spec, normalized, config, *, outliers=False):
    rows=normalized["records"]; field=spec["params"]["field"]
    if len(rows)<spec["params"].get("min_sources",2): raise InsufficientData("local_source_quorum_too_small")
    values=[_record_field(r,field) for r in rows]
    modal,count,total=_modal(values)
    if outliers:
        bad=[{"source_id":r["source_id"],"value_hash":hash_value(_record_field(r,field))} for r in rows if _record_field(r,field) and _record_field(r,field)!=modal]
        score=complement_ppm(bounded_ratio_ppm(len(bad),total)) if total else 0
        return score,bool(bad),{"modal_value_hash":hash_value(modal),"modal_count":count,"outliers":bad}
    share=bounded_ratio_ppm(count,total)
    return share,share<800_000,{"modal_value_hash":hash_value(modal),"modal_count":count,"value_count":total,"quorum_share_ppm":share}

def _local_joint_presence(spec, normalized, config):
    rows=normalized["records"]; fields=spec["params"]["fields"]
    if not rows: raise InsufficientData("local_records_empty")
    good=0
    for r in rows:
        ok=True
        for field in fields:
            value=r.get(field)
            if field in {"latitude_e6","longitude_e6"}: ok &= isinstance(value,int) and not isinstance(value,bool)
            else: ok &= bool(_record_field(r,field))
        if ok: good+=1
    share=bounded_ratio_ppm(good,len(rows))
    return share,share<800_000,{"fields":fields,"complete_sources":good,"source_count":len(rows),"coverage_ppm":share}

def _query_entity_alignment(spec, normalized, config):
    local=normalized["local_business_records"]; search=normalized["search_performance_records"]
    if not local or not search: raise InsufficientData("query_entity_evidence_missing")
    field=spec["params"]["field"]
    modal,_,_=_modal([_record_field(r,field) for r in local])
    intent=config_phrases(config,spec["params"]["intent_config"])
    entity_tokens=set(tokens(modal))
    if field=="phone":
        entity_tokens={modal[-4:]} if modal else set()
    total=0; aligned=0; examples=[]
    min_i=int(spec["params"].get("min_impressions",0))
    for row in search:
        if row["impressions"]<min_i or not contains_any_phrase(row["query_tokens"],intent): continue
        total += row["impressions"]
        if entity_tokens.intersection(set(row["query_tokens"])):
            aligned += row["impressions"]
            examples.append(row["query"])
    if total<=0: raise InsufficientData("entity_alignment_demand_empty")
    share=bounded_ratio_ppm(aligned,total)
    return share,share<100_000,{"field":field,"eligible_impressions":total,"aligned_impressions":aligned,"alignment_share_ppm":share,"aligned_query_examples":sorted(set(examples))[:20]}

def _local_source_id_uniqueness(spec, normalized, config):
    rows=normalized["records"]
    if not rows: raise InsufficientData("local_records_empty")
    ids=[r["source_id"] for r in rows]
    unique=len(set(ids)); share=bounded_ratio_ppm(unique,len(ids))
    return share,unique!=len(ids),{"source_count":len(ids),"unique_source_count":unique}

def _local_source_count(spec, normalized, config):
    count=len(normalized["records"]); minimum=int(spec["params"]["min_sources"])
    if count==0: raise InsufficientData("local_records_empty")
    score=PPM if count>=minimum else (count*PPM)//minimum
    return score,count<minimum,{"source_count":count,"minimum_sources":minimum}

def _local_complete_share(spec, normalized, config):
    rows=normalized["records"]; fields=spec["params"]["fields"]
    if not rows: raise InsufficientData("local_records_empty")
    good=0
    for r in rows:
        ok=True
        for f in fields:
            v=r.get(f)
            if f in {"latitude_e6","longitude_e6"}: ok &= isinstance(v,int) and not isinstance(v,bool)
            else: ok &= bool(_record_field(r,f))
        good += int(ok)
    share=bounded_ratio_ppm(good,len(rows))
    return share,share<800_000,{"fields":fields,"complete_source_count":good,"source_count":len(rows),"share_ppm":share}

def _local_nap_geo_corroboration(spec, normalized, config):
    rows=normalized["records"]
    if len(rows)<2: raise InsufficientData("local_geo_sources_too_small")
    modal_name,_,_=_modal([r["name"] for r in rows])
    modal_addr,_,_=_modal([r["address"] for r in rows])
    modal_phone,_,_=_modal([r["phone"] for r in rows])
    lats=[r["latitude_e6"] for r in rows if isinstance(r.get("latitude_e6"),int)]
    lons=[r["longitude_e6"] for r in rows if isinstance(r.get("longitude_e6"),int)]
    if not lats or not lons: raise InsufficientData("local_coordinates_missing")
    ref_lat=lower_median(lats); ref_lon=lower_median(lons); limit=spec["params"]["max_l1_e6"]
    findings=[]
    for r in rows:
        if r.get("latitude_e6") is None or r.get("longitude_e6") is None: continue
        dist=abs(r["latitude_e6"]-ref_lat)+abs(r["longitude_e6"]-ref_lon)
        nap_diff=sum([r["name"]!=modal_name,r["address"]!=modal_addr,r["phone"]!=modal_phone])
        if dist>limit and nap_diff>0:
            findings.append({"source_id":r["source_id"],"l1_deviation_e6":dist,"nap_mismatched_field_count":nap_diff})
    score=complement_ppm(bounded_ratio_ppm(len(findings),len(rows)))
    return score,bool(findings),{"reference_latitude_e6":ref_lat,"reference_longitude_e6":ref_lon,"joint_outliers":findings}

def _local_nap_geo_joint_outliers(spec, normalized, config):
    return _local_nap_geo_corroboration(spec, normalized, config)

def _local_group_geo_disagreement(spec, normalized, config, group_field):
    rows=normalized["records"]; limit=spec["params"]["max_l1_e6"]
    groups:dict[str,list[dict[str,Any]]]=defaultdict(list)
    for r in rows:
        key=_record_field(r,group_field)
        if key and r.get("latitude_e6") is not None and r.get("longitude_e6") is not None:
            groups[key].append(r)
    if not groups: raise InsufficientData("grouped_geo_evidence_empty")
    findings=[]
    for key,group in groups.items():
        maxd=0; pair=None
        for i,a in enumerate(group):
            for b in group[i+1:]:
                d=_coord_distance(a,b)
                if d is not None and d>maxd: maxd=d; pair=(a["source_id"],b["source_id"])
        if maxd>limit:
            findings.append({"group_value_hash":hash_value(key),"max_l1_deviation_e6":maxd,"source_pair":list(pair) if pair else []})
    score=complement_ppm(bounded_ratio_ppm(len(findings),max(1,len(groups))))
    return score,bool(findings),{"group_field":group_field,"group_count":len(groups),"disagreements":findings}

def _local_entity_content_metric(spec, normalized, config):
    local=normalized["local_business_records"]; docs=normalized["content_documents"]; search=normalized["search_performance_records"]
    if not local or not docs: raise InsufficientData("local_entity_content_evidence_missing")
    metric=spec["params"]["metric"]
    modal_name,_,_=_modal([r["name"] for r in local])
    modal_addr,_,_=_modal([r["address"] for r in local])
    modal_phone,_,_=_modal([r["phone"] for r in local])
    matches=[]
    if metric=="nap_triplet_content_cooccurrence":
        for d in docs:
            if _document_matches_field(d,modal_name,"name") and _document_matches_field(d,modal_addr,"address") and _document_matches_field(d,modal_phone,"phone"):
                matches.append(d["document_id"])
        share=bounded_ratio_ppm(len(matches),len(docs)); return share,share==0,{"cooccurring_documents":matches,"coverage_ppm":share}
    if metric=="local_entity_conflicting_claim_detector":
        conflicts=[]
        for r in local:
            diff=[f for f,m in (("name",modal_name),("address",modal_addr),("phone",modal_phone)) if _record_field(r,f) and _record_field(r,f)!=m]
            if not diff: continue
            for d in docs:
                if any(_document_matches_field(d,_record_field(r,f),f) for f in diff):
                    conflicts.append({"document_id":d["document_id"],"source_id":r["source_id"],"conflicting_fields":diff})
        return complement_ppm(min(PPM,len(conflicts)*100_000)),bool(conflicts),{"conflicts":conflicts}
    if metric=="local_entity_query_page_bridge":
        location_ph=config_phrases(config,"local_location_terms")
        wanted={r["page_url"] for r in search if contains_any_phrase(r["query_tokens"],location_ph)}
        scoped=[d for d in docs if d["document_id"] in wanted or canonical_url_or_path(d["document_id"]) in wanted]
        if not scoped: raise InsufficientData("local_demand_pages_empty")
        matched=[d["document_id"] for d in scoped if _document_matches_field(d,modal_name,"name")]
        share=bounded_ratio_ppm(len(matched),len(scoped)); return share,share<500_000,{"local_demand_document_count":len(scoped),"identity_document_count":len(matched),"coverage_ppm":share}
    field=spec["params"].get("field","name")
    modal={"name":modal_name,"address":modal_addr,"phone":modal_phone}.get(field,modal_name)
    present=[d["document_id"] for d in docs if _document_matches_field(d,modal,field if field!="triplet" else "name")]
    share=bounded_ratio_ppm(len(present),len(docs))
    if metric=="local_entity_document_dispersion":
        return share,share<200_000,{"identity_documents":present,"coverage_ppm":share}
    return share,share==0,{"matching_documents":present,"coverage_ppm":share}
