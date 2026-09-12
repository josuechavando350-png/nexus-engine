from __future__ import annotations

from collections import deque
from typing import Any, Mapping, Sequence

from .common import (
    PPM, InvalidData, InsufficientData, bounded_ratio_ppm, complement_ppm,
    config_phrases, contains_any_phrase, gini_ppm, normalize_text, tokens,
)

EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"
SEMANTIC = "LOCAL_ENTITY_KNOWLEDGE_GRAPH_FROM_VERIFIED_EVIDENCE_NOT_GOOGLE_KNOWLEDGE_GRAPH"


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


def _average(values: Sequence[int]) -> int:
    return sum(values) // len(values) if values else 0


def _share_count(good: int, total: int) -> int:
    return bounded_ratio_ppm(good, total) if total > 0 else 0


def _path(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    raw = value.split("?", 1)[0]
    if raw.startswith("/"):
        return raw
    marker = raw.find("://")
    if marker >= 0:
        tail = raw[marker + 3:]
        slash = tail.find("/")
        return "/" if slash < 0 else tail[slash:]
    return raw


def _entity_inventory(semantic_rows: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    entities: dict[str, dict[str, Any]] = {}
    for record in semantic_rows:
        raw = record.get("entities")
        if not isinstance(raw, list):
            continue
        for entity in raw:
            if not isinstance(entity, Mapping):
                continue
            entity_id = entity.get("id")
            label = entity.get("label")
            if not isinstance(entity_id, str) or not entity_id.strip() or not isinstance(label, str) or not label.strip():
                continue
            normalized = {
                "id": entity_id.strip(),
                "label": normalize_text(label),
                "type": normalize_text(entity.get("type")),
                "related_ids": sorted({str(x) for x in entity.get("related_ids", []) if isinstance(x, str) and x}),
                "salience_ppm": entity.get("salience_ppm"),
                "properties": dict(entity.get("properties")) if isinstance(entity.get("properties"), Mapping) else {},
                "schema_types": dict(entity.get("schema_types")) if isinstance(entity.get("schema_types"), Mapping) else {},
                "external_context": dict(entity.get("external_context")) if isinstance(entity.get("external_context"), Mapping) else {},
            }
            prior = entities.get(normalized["id"])
            if prior is not None and prior != normalized:
                raise InvalidData(f"conflicting_semantic_entity:{normalized['id']}")
            entities[normalized["id"]] = normalized
    if not entities:
        raise InsufficientData("semantic_entity_inventory_empty")
    return entities


def _directed_edges(entities: Mapping[str, Mapping[str, Any]]) -> set[tuple[str, str]]:
    ids = set(entities)
    edges: set[tuple[str, str]] = set()
    for source, entity in entities.items():
        for target in entity.get("related_ids", []):
            if target in ids and target != source:
                edges.add((source, target))
    return edges


def _adjacency(nodes: Sequence[str], edges: set[tuple[str, str]], *, undirected: bool = False) -> dict[str, set[str]]:
    adj = {node: set() for node in nodes}
    for source, target in edges:
        adj[source].add(target)
        if undirected:
            adj[target].add(source)
    return adj


def _components(nodes: Sequence[str], edges: set[tuple[str, str]]) -> list[set[str]]:
    adj = _adjacency(nodes, edges, undirected=True)
    unseen = set(nodes)
    out: list[set[str]] = []
    while unseen:
        start = min(unseen)
        queue = [start]
        component: set[str] = set()
        unseen.remove(start)
        while queue:
            node = queue.pop()
            component.add(node)
            for nxt in sorted(adj[node]):
                if nxt in unseen:
                    unseen.remove(nxt)
                    queue.append(nxt)
        out.append(component)
    return out


def _reachable(adj: Mapping[str, set[str]], start: str, max_depth: int | None = None) -> set[str]:
    seen = {start}
    queue = deque([(start, 0)])
    while queue:
        node, depth = queue.popleft()
        if max_depth is not None and depth >= max_depth:
            continue
        for nxt in adj.get(node, set()):
            if nxt not in seen:
                seen.add(nxt)
                queue.append((nxt, depth + 1))
    seen.discard(start)
    return seen


def _pair_reachability(nodes: Sequence[str], adj: Mapping[str, set[str]], max_depth: int | None = None) -> int:
    if len(nodes) <= 1:
        return PPM
    possible = len(nodes) * (len(nodes) - 1)
    actual = sum(len(_reachable(adj, node, max_depth=max_depth)) for node in nodes)
    return bounded_ratio_ppm(actual, possible)


def _articulation_nodes(nodes: Sequence[str], edges: set[tuple[str, str]]) -> set[str]:
    if len(nodes) <= 2:
        return set()
    baseline = len(_components(nodes, edges))
    result: set[str] = set()
    for removed in nodes:
        remaining = [node for node in nodes if node != removed]
        filtered = {(a, b) for a, b in edges if a != removed and b != removed}
        if remaining and len(_components(remaining, filtered)) > baseline:
            result.add(removed)
    return result


def _bridge_edges(nodes: Sequence[str], edges: set[tuple[str, str]]) -> set[tuple[str, str]]:
    undirected = {tuple(sorted((a, b))) for a, b in edges if a != b}
    baseline = len(_components(nodes, edges))
    bridges: set[tuple[str, str]] = set()
    for edge in sorted(undirected):
        filtered = {(a, b) for a, b in edges if tuple(sorted((a, b))) != edge}
        if len(_components(nodes, filtered)) > baseline:
            bridges.add(edge)
    return bridges


def _weighted_query_share(search: Sequence[Mapping[str, Any]], predicate, field: str = "impressions") -> int:
    total = sum(int(row.get(field, 0)) for row in search)
    if total <= 0:
        return 0
    good = sum(int(row.get(field, 0)) for row in search if predicate(row))
    return bounded_ratio_ppm(good, total)


def _feature_map(normalized: Mapping[str, Any], config: Mapping[str, Any]) -> dict[str, tuple[int, dict[str, Any]]]:
    semantic = _rows(normalized, "semantic_text_records")
    search = _rows(normalized, "search_performance_records")
    docs = _rows(normalized, "content_documents", allow_empty=True)
    local = _rows(normalized, "local_business_records", allow_empty=True)
    canon = _rows(normalized, "canonicalization_records", allow_empty=True)
    policy = _rows(normalized, "policy_audit_records", allow_empty=True)
    entities = _entity_inventory(semantic)
    nodes = sorted(entities)
    edges = _directed_edges(entities)
    adj = _adjacency(nodes, edges)
    undirected_adj = _adjacency(nodes, edges, undirected=True)
    components = _components(nodes, edges)
    bridges = _bridge_edges(nodes, edges)
    articulations = _articulation_nodes(nodes, edges)

    labels = {entity_id: set(tokens(entity["label"])) for entity_id, entity in entities.items()}
    all_entity_tokens = {token for value in labels.values() for token in value}
    types = {entity_id: entity["type"] for entity_id, entity in entities.items()}
    salience = {
        entity_id: value if isinstance((value := entity.get("salience_ppm")), int) and not isinstance(value, bool) and 0 <= value <= PPM else 0
        for entity_id, entity in entities.items()
    }
    phrases = {
        "commercial": config_phrases(config, "local_commercial_terms"),
        "service": config_phrases(config, "local_service_terms"),
        "location": config_phrases(config, "local_location_terms"),
        "urgency": config_phrases(config, "local_urgency_terms"),
        "question": config_phrases(config, "local_question_terms"),
        "brand": config_phrases(config, "local_brand_terms"),
    }
    def qhas(row: Mapping[str, Any], key: str) -> bool:
        return contains_any_phrase(row.get("query_tokens", []), phrases[key])
    def q_entity_ids(row: Mapping[str, Any]) -> set[str]:
        q = set(row.get("query_tokens", []))
        return {entity_id for entity_id, label_tokens in labels.items() if q & label_tokens}

    features: dict[str, tuple[int, dict[str, Any]]] = {}
    def put(name: str, score: int, **details: Any) -> None:
        features[name] = (max(0, min(PPM, score)), details)

    # Core graph topology.
    put("entity_inventory_health", min(PPM, len(nodes) * 100_000), entity_count=len(nodes))
    possible_edges = max(1, len(nodes) * max(1, len(nodes) - 1))
    put("relation_edge_coverage", min(PPM, (len(edges) * PPM) // possible_edges), relation_edges=len(edges))
    put("weak_component_health", bounded_ratio_ppm(1, len(components)), component_count=len(components))
    largest = max((len(component) for component in components), default=0)
    put("largest_component_share", _share_count(largest, len(nodes)), largest_component_size=largest)
    isolated = sum(1 for node in nodes if not undirected_adj[node])
    put("isolated_entity_health", complement_ppm(_share_count(isolated, len(nodes))), isolated_entities=isolated)
    reciprocal = sum(1 for edge in edges if (edge[1], edge[0]) in edges)
    put("reciprocal_relation_share", _share_count(reciprocal, len(edges)) if edges else PPM, reciprocal_edges=reciprocal)
    outdegrees = [len(adj[node]) for node in nodes]
    indegrees = [sum(1 for source in nodes if node in adj[source]) for node in nodes]
    out_gini = gini_ppm(outdegrees) if any(outdegrees) else 0
    in_gini = gini_ppm(indegrees) if any(indegrees) else 0
    put("outdegree_balance_health", complement_ppm(out_gini), degree_gini_ppm=out_gini)
    put("indegree_balance_health", complement_ppm(in_gini), degree_gini_ppm=in_gini)
    max_degree = max((outdegrees[i] + indegrees[i] for i in range(len(nodes))), default=0)
    total_degree = sum(outdegrees) + sum(indegrees)
    hub_share = bounded_ratio_ppm(max_degree, total_degree) if total_degree else 0
    put("hub_concentration_health", complement_ppm(hub_share), max_degree_share_ppm=hub_share)
    put("articulation_resilience", complement_ppm(_share_count(len(articulations), len(nodes))), articulation_nodes=sorted(articulations))
    put("bridge_edge_resilience", complement_ppm(_share_count(len(bridges), max(1, len({tuple(sorted(e)) for e in edges})))), bridge_edges=[list(e) for e in sorted(bridges)])
    cycle_nodes = {node for node in nodes if any(node in _reachable(adj, other) and other in _reachable(adj, node) for other in nodes if other != node)}
    put("cycle_participation_share", _share_count(len(cycle_nodes), len(nodes)), cycle_entities=len(cycle_nodes))
    directed_reach = _pair_reachability(nodes, adj)
    put("directed_reachability_share", directed_reach, reachability_ppm=directed_reach)
    two_hop = _pair_reachability(nodes, adj, max_depth=2)
    put("two_hop_reachability_share", two_hop, reachability_ppm=two_hop)
    cross_type = sum(1 for a, b in edges if types.get(a) and types.get(b) and types.get(a) != types.get(b))
    put("type_mixing_health", _share_count(cross_type, len(edges)) if edges else 0, cross_type_edges=cross_type)
    put("property_completeness", _share_count(sum(1 for e in entities.values() if e.get("properties")), len(nodes)), entity_count=len(nodes))
    put("schema_annotation_completeness", _share_count(sum(1 for e in entities.values() if e.get("schema_types")), len(nodes)), entity_count=len(nodes))
    project_count = sum(1 for e in entities.values() if normalize_text(e.get("external_context", {}).get("source")) == "project")
    put("project_source_share", _share_count(project_count, len(nodes)), project_sourced_entities=project_count)
    salience_count = sum(1 for value in salience.values() if value > 0)
    put("salience_coverage", _share_count(salience_count, len(nodes)), salience_entities=salience_count)
    high_salience = {entity_id for entity_id, value in salience.items() if value >= 700_000}
    high_related = sum(1 for entity_id in high_salience if undirected_adj[entity_id])
    put("high_salience_relation_support", _share_count(high_related, len(high_salience)) if high_salience else PPM, high_salience_entities=len(high_salience))

    # Query-to-entity graph.
    query_supported = lambda row: bool(q_entity_ids(row))
    put("query_entity_alignment", _weighted_query_share(search, query_supported), search_records=len(search))
    for key in ("commercial", "service", "location", "urgency", "question", "brand"):
        subset = [row for row in search if qhas(row, key)]
        score = _weighted_query_share(subset, query_supported) if subset else PPM
        put(f"{key}_query_entity_alignment", score, eligible_queries=len(subset))
    longtail = [row for row in search if len(row.get("query_tokens", [])) >= 5]
    put("longtail_query_entity_alignment", _weighted_query_share(longtail, query_supported) if longtail else PPM, eligible_queries=len(longtail))
    zero_click = [row for row in search if int(row.get("clicks", 0)) == 0]
    put("zero_click_query_entity_support", _weighted_query_share(zero_click, query_supported) if zero_click else PPM, eligible_queries=len(zero_click))
    top10 = [row for row in search if int(row.get("average_position_milli", 1_000_000)) <= 10_000]
    put("top10_query_entity_support", _weighted_query_share(top10, query_supported) if top10 else PPM, eligible_queries=len(top10))
    rank_gap = [row for row in search if 10_000 < int(row.get("average_position_milli", 1_000_000)) <= 20_000]
    put("rank_gap_query_entity_support", _weighted_query_share(rank_gap, query_supported) if rank_gap else PPM, eligible_queries=len(rank_gap))
    page_entities: dict[str, set[str]] = {}
    query_entities: dict[str, set[str]] = {}
    for row in search:
        ids = q_entity_ids(row)
        page_entities.setdefault(_path(row.get("page_url")), set()).update(ids)
        query_entities.setdefault(str(row.get("query")), set()).update(ids)
    page_breadths = [len(v) for v in page_entities.values()]
    query_breadths = [len(v) for v in query_entities.values()]
    put("page_entity_breadth_health", min(PPM, _average(page_breadths) * 250_000) if page_breadths else 0, average_entities_per_page=_average(page_breadths))
    put("query_entity_breadth_health", min(PPM, _average(query_breadths) * 250_000) if query_breadths else 0, average_entities_per_query=_average(query_breadths))
    single_entity_queries = sum(1 for values in query_entities.values() if len(values) == 1)
    put("query_to_entity_specialization", _share_count(single_entity_queries, len(query_entities)) if query_entities else 0, single_entity_queries=single_entity_queries)
    entity_queries: dict[str, set[str]] = {entity_id: set() for entity_id in nodes}
    for query, ids in query_entities.items():
        for entity_id in ids:
            entity_queries[entity_id].add(query)
    focused_entities = sum(1 for values in entity_queries.values() if 0 < len(values) <= 5)
    put("entity_to_query_specialization", _share_count(focused_entities, len(nodes)), focused_entities=focused_entities)
    query_entity_components = sum(1 for component in components if any(entity_queries[node] for node in component))
    put("query_entity_component_health", _share_count(query_entity_components, len(components)), query_backed_components=query_entity_components)
    put("impression_weighted_entity_support", _weighted_query_share(search, query_supported, "impressions"), search_records=len(search))
    put("click_weighted_entity_support", _weighted_query_share(search, query_supported, "clicks") if sum(int(r.get("clicks", 0)) for r in search) else 0, search_records=len(search))
    high_intent = [row for row in search if qhas(row, "commercial") or qhas(row, "service") or qhas(row, "location") or qhas(row, "urgency")]
    put("high_intent_entity_support", _weighted_query_share(high_intent, query_supported) if high_intent else PPM, eligible_queries=len(high_intent))
    local_tokens = {token for row in local for token in tokens(row.get("name")) + tokens(row.get("address"))}
    local_entity_ids = {entity_id for entity_id, label in labels.items() if label & local_tokens}
    local_bridge_rows = [row for row in search if qhas(row, "location")]
    local_bridge_score = _weighted_query_share(local_bridge_rows, lambda row: bool(q_entity_ids(row) & local_entity_ids)) if local_bridge_rows else PPM
    put("local_identity_query_entity_bridge", local_bridge_score, local_identity_entities=sorted(local_entity_ids))

    # Content/entity proof.
    doc_tokens = {str(row.get("document_id")): set(row.get("tokens", [])) for row in docs}
    doc_entity_ids = {doc_id: {eid for eid, label in labels.items() if label & values} for doc_id, values in doc_tokens.items()}
    put("document_entity_presence", _share_count(sum(1 for values in doc_entity_ids.values() if values), len(doc_entity_ids)) if doc_entity_ids else 0, documents=len(doc_entity_ids))
    label_supported = sum(1 for eid, label in labels.items() if any(label & values for values in doc_tokens.values()))
    put("content_label_support", _share_count(label_supported, len(nodes)), supported_entities=label_supported)
    heading_text = " ".join(" ".join(str(x) for x in row.get("headings", []) if isinstance(x, str)) for row in semantic)
    heading_tokens = set(tokens(heading_text))
    heading_supported = sum(1 for label in labels.values() if label & heading_tokens)
    put("heading_entity_support", _share_count(heading_supported, len(nodes)), supported_entities=heading_supported)
    link_text_parts: list[str] = []
    for row in semantic:
        links = row.get("links")
        if isinstance(links, list):
            for link in links:
                if isinstance(link, Mapping):
                    link_text_parts.append(str(link.get("anchor") or ""))
                elif isinstance(link, str):
                    link_text_parts.append(link)
    link_tokens = set(tokens(" ".join(link_text_parts)))
    link_supported = sum(1 for label in labels.values() if label & link_tokens)
    put("link_anchor_entity_support", _share_count(link_supported, len(nodes)), supported_entities=link_supported)
    cache_tokens: set[str] = set()
    for row in semantic:
        cache = row.get("entity_cache")
        if isinstance(cache, Mapping):
            for key, value in cache.items():
                cache_tokens.update(tokens(key))
                if isinstance(value, list):
                    for item in value:
                        cache_tokens.update(tokens(item))
    cache_supported = sum(1 for label in labels.values() if label & cache_tokens)
    put("entity_cache_support", _share_count(cache_supported, len(nodes)), supported_entities=cache_supported)
    doc_breadths = [len(values) for values in doc_entity_ids.values()]
    put("document_entity_breadth_health", min(PPM, _average(doc_breadths) * 250_000) if doc_breadths else 0, average_entities_per_document=_average(doc_breadths))
    entity_doc_counts = [sum(1 for values in doc_entity_ids.values() if eid in values) for eid in nodes]
    put("entity_document_breadth_health", min(PPM, _average(entity_doc_counts) * 250_000) if entity_doc_counts else 0, average_documents_per_entity=_average(entity_doc_counts))
    type_groups = {
        "service_entity_document_coverage": {"service"},
        "location_entity_document_coverage": {"gpe", "location", "place"},
        "brand_entity_document_coverage": {"org", "organization"},
        "event_entity_document_coverage": {"event"},
    }
    for name, accepted_types in type_groups.items():
        ids = {eid for eid, typ in types.items() if typ in accepted_types}
        supported = sum(1 for eid in ids if any(eid in values for values in doc_entity_ids.values()))
        put(name, _share_count(supported, len(ids)) if ids else PPM, eligible_entities=len(ids))
    content_components = sum(1 for component in components if any(any(eid in values for eid in component) for values in doc_entity_ids.values()))
    put("content_entity_component_health", _share_count(content_components, len(components)), content_backed_components=content_components)
    orphan_content = sum(1 for eid in nodes if not any(eid in values for values in doc_entity_ids.values()))
    put("orphan_entity_content_gap_health", complement_ppm(_share_count(orphan_content, len(nodes))), unsupported_entities=orphan_content)
    high_content = sum(1 for eid in high_salience if any(eid in values for values in doc_entity_ids.values()))
    put("high_salience_content_support", _share_count(high_content, len(high_salience)) if high_salience else PPM, high_salience_entities=len(high_salience))
    property_tokens: dict[str, set[str]] = {}
    for eid, entity in entities.items():
        values: list[str] = []
        for key, value in entity.get("properties", {}).items():
            values.append(str(key)); values.append(str(value))
        property_tokens[eid] = set(tokens(" ".join(values)))
    prop_supported = sum(1 for eid, pts in property_tokens.items() if pts and any(pts & values for values in doc_tokens.values()))
    prop_eligible = sum(1 for pts in property_tokens.values() if pts)
    put("property_token_content_support", _share_count(prop_supported, prop_eligible) if prop_eligible else PPM, eligible_entities=prop_eligible)
    relation_pairs = [(a, b) for a, b in edges]
    def pair_support(token_sets: Sequence[set[str]]) -> int:
        if not relation_pairs:
            return PPM
        good = 0
        for a, b in relation_pairs:
            if any(bool(labels[a] & values) and bool(labels[b] & values) for values in token_sets):
                good += 1
        return _share_count(good, len(relation_pairs))
    put("relation_pair_content_cooccurrence", pair_support(list(doc_tokens.values())), relation_pairs=len(relation_pairs))
    put("relation_pair_heading_support", pair_support([heading_tokens]), relation_pairs=len(relation_pairs))
    put("relation_pair_link_support", pair_support([link_tokens]), relation_pairs=len(relation_pairs))
    distinct_docs = sum(1 for values in doc_entity_ids.values() if len({types.get(eid) for eid in values if types.get(eid)}) >= 2)
    put("document_entity_diversity", _share_count(distinct_docs, len(doc_entity_ids)) if doc_entity_ids else 0, diverse_documents=distinct_docs)
    content_breadth_flags = [bool(docs), bool(heading_tokens), bool(link_tokens), bool(cache_tokens), bool(doc_entity_ids)]
    put("entity_content_evidence_breadth", _share_count(sum(1 for x in content_breadth_flags if x), len(content_breadth_flags)), evidence_families=sum(1 for x in content_breadth_flags if x))

    # Business/canonical/schema corroboration.
    local_name_tokens = {token for row in local for token in tokens(row.get("name"))}
    local_location_tokens = {token for row in local for token in tokens(row.get("address"))}
    put("local_name_entity_support", _share_count(sum(1 for label in labels.values() if label & local_name_tokens), len(nodes)), local_records=len(local))
    put("local_location_entity_support", _share_count(sum(1 for label in labels.values() if label & local_location_tokens), len(nodes)), local_records=len(local))
    brand_entity_tokens = {token for row in canon for token in tokens(row.get("brand_entity"))}
    put("canonical_brand_entity_support", _share_count(sum(1 for label in labels.values() if label & brand_entity_tokens), len(nodes)), canonical_records=len(canon))
    canonical_inventory_tokens: set[str] = set()
    for row in canon:
        raw = row.get("entities")
        if isinstance(raw, list):
            for value in raw:
                canonical_inventory_tokens.update(tokens(value))
    put("canonical_entity_inventory_support", _share_count(sum(1 for label in labels.values() if label & canonical_inventory_tokens), len(nodes)), canonical_records=len(canon))
    put("canonical_schema_signature_backing", _share_count(sum(1 for row in canon if normalize_text(row.get("schema_signature"))), len(canon)) if canon else 0, canonical_records=len(canon))
    jsonld_types = {normalize_text(value) for row in policy for value in row.get("jsonld_types", []) if isinstance(value, str) and normalize_text(value)}
    put("jsonld_type_backing", PPM if jsonld_types else 0, jsonld_types=sorted(jsonld_types))
    put("organization_type_support", PPM if "organization" in jsonld_types and any(t in {"org", "organization"} for t in types.values()) else 0, jsonld_types=sorted(jsonld_types))
    put("legalservice_type_support", PPM if "legalservice" in jsonld_types and any(t == "service" for t in types.values()) else 0, jsonld_types=sorted(jsonld_types))
    put("localbusiness_type_support", PPM if "localbusiness" in jsonld_types and bool(local) else 0, jsonld_types=sorted(jsonld_types))
    schema_prop = sum(1 for entity in entities.values() if entity.get("schema_types") and entity.get("properties"))
    put("entity_schema_property_consistency", _share_count(schema_prop, len(nodes)), consistent_entities=schema_prop)
    source_ids = {normalize_text(row.get("source_id")) for row in local if normalize_text(row.get("source_id"))}
    put("local_identity_source_quorum", min(PPM, len(source_ids) * 333_333), distinct_local_sources=len(source_ids))
    identity_tokens = local_name_tokens | local_location_tokens
    corroborated = sum(1 for label in labels.values() if label & identity_tokens)
    put("entity_local_identity_corroboration", _share_count(corroborated, len(nodes)), corroborated_entities=corroborated)
    cluster_tokens = {token for row in canon for token in tokens(row.get("query_cluster"))}
    cluster_supported = sum(1 for label in labels.values() if label & cluster_tokens)
    put("canonical_entity_query_cluster_bridge", _share_count(cluster_supported, len(nodes)), cluster_supported_entities=cluster_supported)
    site_identity_present = any(isinstance(row.get("site_id"), str) and row.get("site_id") == row.get("expected_site_id") for row in policy)
    put("site_identity_entity_bridge", PPM if site_identity_present and bool(nodes) else 0, site_identity_present=site_identity_present)
    schema_flags = [bool(canon), bool(jsonld_types), bool(local), bool(brand_entity_tokens), bool(canonical_inventory_tokens)]
    put("schema_entity_evidence_breadth", _share_count(sum(1 for x in schema_flags if x), len(schema_flags)), evidence_families=sum(1 for x in schema_flags if x))

    # Counterfactual resilience and aggregate proofs; simulation only.
    baseline_reach = directed_reach
    best_gain = 0
    if len(components) > 1:
        representatives = [sorted(component)[0] for component in components]
        for source in representatives:
            for target in representatives:
                if source == target:
                    continue
                trial = set(edges); trial.add((source, target))
                trial_reach = _pair_reachability(nodes, _adjacency(nodes, trial))
                best_gain = max(best_gain, trial_reach - baseline_reach)
    put("best_missing_bridge_reachability_gain", min(PPM, max(0, best_gain)), baseline_reachability_ppm=baseline_reach, best_gain_ppm=max(0, best_gain))
    component_merge_gain = PPM if len(components) == 1 else bounded_ratio_ppm(1, len(components))
    put("best_component_merge_gain", component_merge_gain, component_count=len(components))
    put("hub_overload_health", complement_ppm(hub_share), max_degree_share_ppm=hub_share)
    put("bridge_redundancy_health", complement_ppm(_share_count(len(bridges), max(1, len(edges)))), bridge_edges=len(bridges))
    put("articulation_redundancy_health", complement_ppm(_share_count(len(articulations), len(nodes))), articulation_nodes=len(articulations))
    salience_total = sum(salience.values())
    salience_reachable = 0
    for source in nodes:
        if _reachable(adj, source):
            salience_reachable += salience[source]
    put("salience_weighted_reachability", bounded_ratio_ppm(salience_reachable, salience_total) if salience_total else 0, total_salience_ppm=salience_total)
    query_backed = {eid for ids in query_entities.values() for eid in ids}
    reachable_query_entities = sum(1 for eid in query_backed if _reachable(adj, eid) or any(eid in _reachable(adj, other) for other in nodes if other != eid))
    put("query_weighted_reachability", _share_count(reachable_query_entities, len(query_backed)) if query_backed else 0, query_backed_entities=len(query_backed))
    demand_by_entity = {eid: 0 for eid in nodes}
    for row in search:
        for eid in q_entity_ids(row):
            demand_by_entity[eid] += int(row.get("impressions", 0))
    demand_total = sum(demand_by_entity.values())
    demand_connected = sum(weight for eid, weight in demand_by_entity.items() if undirected_adj[eid])
    put("demand_weighted_entity_centrality", bounded_ratio_ppm(demand_connected, demand_total) if demand_total else 0, demand_weight=demand_total)
    evidence_flags = [bool(semantic), bool(search), bool(docs), bool(local), bool(canon), bool(policy), bool(edges), bool(entity_tokens if (entity_tokens := all_entity_tokens) else set())]
    breadth = _share_count(sum(1 for x in evidence_flags if x), len(evidence_flags))
    put("entity_evidence_breadth", breadth, evidence_families=sum(1 for x in evidence_flags if x))
    contradictory = sum(1 for entity in entities.values() if not entity.get("type") or not entity.get("label"))
    put("entity_contradiction_health", complement_ppm(_share_count(contradictory, len(nodes))), contradictory_entities=contradictory)
    label_to_ids: dict[str, set[str]] = {}
    for eid, entity in entities.items():
        label_to_ids.setdefault(entity["label"], set()).add(eid)
    duplicate_labels = sum(1 for ids in label_to_ids.values() if len(ids) > 1)
    put("duplicate_label_health", complement_ppm(_share_count(duplicate_labels, len(label_to_ids))), duplicate_labels=duplicate_labels)
    label_types: dict[str, set[str]] = {}
    for entity in entities.values():
        label_types.setdefault(entity["label"], set()).add(entity["type"])
    type_conflicts = sum(1 for values in label_types.values() if len({v for v in values if v}) > 1)
    put("entity_type_conflict_health", complement_ppm(_share_count(type_conflicts, len(label_types))), type_conflicts=type_conflicts)
    non_project = sum(1 for entity in entities.values() if normalize_text(entity.get("external_context", {}).get("source")) not in {"", "project"})
    put("project_source_conflict_health", complement_ppm(_share_count(non_project, len(nodes))), non_project_entities=non_project)
    confidence_parts = [breadth, features["project_source_share"][0], features["content_label_support"][0], features["query_entity_alignment"][0], features["entity_local_identity_corroboration"][0], features["schema_entity_evidence_breadth"][0]]
    confidence = _average(confidence_parts)
    put("entity_graph_confidence", confidence, component_scores=confidence_parts)
    proof_parts = [confidence, directed_reach, features["orphan_entity_content_gap_health"][0], features["high_intent_entity_support"][0], features["entity_contradiction_health"][0], features["duplicate_label_health"][0], features["entity_type_conflict_health"][0]]
    put("entity_proof_graph_health", _average(proof_parts), component_scores=proof_parts)
    return features


def entity_proof_graph_metric(spec: Mapping[str, Any], normalized: Mapping[str, Any], config: Mapping[str, Any]):
    params = spec.get("params")
    if not isinstance(params, Mapping):
        raise InvalidData("entity_graph_params_missing")
    mode = params.get("mode")
    if not isinstance(mode, str):
        raise InvalidData("entity_graph_mode_invalid")
    features = _feature_map(normalized, config)
    if mode not in features:
        raise InvalidData(f"unsupported_entity_graph_mode:{mode}")
    score, details = features[mode]
    threshold = spec.get("threshold_ppm")
    if isinstance(threshold, bool) or not isinstance(threshold, int) or not 0 <= threshold <= PPM:
        raise InvalidData("entity_graph_threshold_invalid")
    return score, score < threshold, {
        **details,
        "mode": mode,
        "semantic": SEMANTIC,
        "evidence_contract": EVIDENCE_CONTRACT,
        "observe_only": True,
        "proof_carrying": True,
        "counterfactual_only_when_simulating": True,
        "no_google_scraping": True,
        "no_entity_fabrication": True,
        "no_location_fabrication": True,
        "no_service_fabrication": True,
        "no_review_fabrication": True,
        "not_google_knowledge_graph": True,
        "not_google_pagerank": True,
        "no_site_mutation": True,
    }
