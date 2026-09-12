from __future__ import annotations

from collections import deque
from typing import Any, Mapping, Sequence

from .common import (
    PPM, InvalidData, InsufficientData, bounded_ratio_ppm, complement_ppm,
    config_phrases, contains_any_phrase, gini_ppm, normalize_text, tokens,
)

EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"
SEMANTIC = "INTERNAL_LINK_COUNTERFACTUAL_NOT_GOOGLE_PAGERANK_OR_AUTOMATIC_MUTATION"


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


def _as_silo(value: Any) -> str:
    return normalize_text(value)


def _graph(normalized: Mapping[str, Any]):
    rows = _rows(normalized, "search_intent_records")
    nodes: set[str] = set()
    raw_edges: list[tuple[str, str]] = []
    anchors_by_silo: dict[str, list[str]] = {}
    queries_by_silo: dict[str, list[str]] = {}
    entities_by_silo: dict[str, set[str]] = {}
    intents_by_silo: dict[str, set[str]] = {}
    nav_by_silo: dict[str, set[str]] = {}
    for index, row in enumerate(rows):
        silo = _as_silo(row.get("silo"))
        if not silo:
            raise InvalidData(f"search_intent_records_silo_missing:{index}")
        nodes.add(silo)
        query = normalize_text(row.get("query"))
        if query:
            queries_by_silo.setdefault(silo, []).append(query)
        labels = row.get("intent_labels")
        if isinstance(labels, list):
            intents_by_silo.setdefault(silo, set()).update(normalize_text(v) for v in labels if normalize_text(v))
        entities = row.get("entities")
        if isinstance(entities, list):
            entities_by_silo.setdefault(silo, set()).update(normalize_text(v) for v in entities if normalize_text(v))
        nav = row.get("navigation_entities")
        if isinstance(nav, list):
            nav_by_silo.setdefault(silo, set()).update(normalize_text(v) for v in nav if normalize_text(v))
        anchors = row.get("internal_anchors")
        if isinstance(anchors, list):
            anchors_by_silo.setdefault(silo, []).extend(normalize_text(v) for v in anchors if normalize_text(v))
        targets = row.get("internal_link_targets")
        if not isinstance(targets, list):
            raise InvalidData(f"internal_link_targets_invalid:{index}")
        for target in targets:
            if not isinstance(target, Mapping):
                raise InvalidData(f"internal_link_target_not_mapping:{index}")
            target_silo = _as_silo(target.get("silo"))
            if not target_silo:
                raise InvalidData(f"internal_link_target_silo_missing:{index}")
            nodes.add(target_silo)
            raw_edges.append((silo, target_silo))
    if len(nodes) < 2:
        raise InsufficientData("counterfactual_graph_requires_two_silos")
    return rows, sorted(nodes), raw_edges, sorted(set(raw_edges)), queries_by_silo, entities_by_silo, intents_by_silo, nav_by_silo, anchors_by_silo


def _adj(nodes: Sequence[str], edges: Sequence[tuple[str, str]]) -> dict[str, set[str]]:
    result = {node: set() for node in nodes}
    for source, target in edges:
        result[source].add(target)
    return result


def _undirected(nodes: Sequence[str], edges: Sequence[tuple[str, str]]) -> dict[str, set[str]]:
    result = {node: set() for node in nodes}
    for source, target in edges:
        result[source].add(target)
        result[target].add(source)
    return result


def _reachability(nodes: Sequence[str], edges: Sequence[tuple[str, str]]) -> dict[str, set[str]]:
    adjacency = _adj(nodes, edges)
    output: dict[str, set[str]] = {}
    for source in nodes:
        seen = {source}
        queue = deque([source])
        while queue:
            current = queue.popleft()
            for target in sorted(adjacency[current]):
                if target not in seen:
                    seen.add(target)
                    queue.append(target)
        output[source] = seen - {source}
    return output


def _distances(nodes: Sequence[str], edges: Sequence[tuple[str, str]]) -> dict[tuple[str, str], int]:
    adjacency = _adj(nodes, edges)
    result: dict[tuple[str, str], int] = {}
    for source in nodes:
        distances = {source: 0}
        queue = deque([source])
        while queue:
            current = queue.popleft()
            for target in sorted(adjacency[current]):
                if target not in distances:
                    distances[target] = distances[current] + 1
                    queue.append(target)
        for target, distance in distances.items():
            if target != source:
                result[(source, target)] = distance
    return result


def _components(nodes: Sequence[str], edges: Sequence[tuple[str, str]]) -> list[set[str]]:
    adjacency = _undirected(nodes, edges)
    remaining = set(nodes)
    result: list[set[str]] = []
    while remaining:
        start = sorted(remaining)[0]
        seen = {start}
        queue = deque([start])
        while queue:
            current = queue.popleft()
            for target in sorted(adjacency[current]):
                if target not in seen:
                    seen.add(target)
                    queue.append(target)
        result.append(seen)
        remaining -= seen
    return result


def _bridge_edges(nodes: Sequence[str], edges: Sequence[tuple[str, str]]) -> set[tuple[str, str]]:
    base = len(_components(nodes, edges))
    bridges: set[tuple[str, str]] = set()
    for edge in sorted(set(edges)):
        reduced = [candidate for candidate in edges if candidate != edge]
        if len(_components(nodes, reduced)) > base:
            bridges.add(edge)
    return bridges


def _articulations(nodes: Sequence[str], edges: Sequence[tuple[str, str]]) -> set[str]:
    base = len(_components(nodes, edges))
    result: set[str] = set()
    for node in nodes:
        remaining = [candidate for candidate in nodes if candidate != node]
        if not remaining:
            continue
        reduced = [(source, target) for source, target in edges if source != node and target != node]
        if len(_components(remaining, reduced)) > base:
            result.add(node)
    return result


def _has_cycle(nodes: Sequence[str], edges: Sequence[tuple[str, str]]) -> tuple[bool, set[str]]:
    adjacency = _adj(nodes, edges)
    visiting: set[str] = set()
    visited: set[str] = set()
    cycle_nodes: set[str] = set()

    def visit(node: str, stack: list[str]) -> bool:
        if node in visiting:
            if node in stack:
                cycle_nodes.update(stack[stack.index(node):])
            return True
        if node in visited:
            return False
        visiting.add(node)
        stack.append(node)
        found = False
        for target in sorted(adjacency[node]):
            if visit(target, stack):
                found = True
        stack.pop()
        visiting.remove(node)
        visited.add(node)
        return found

    found_any = False
    for node in nodes:
        if visit(node, []):
            found_any = True
    return found_any, cycle_nodes


def _count_balance(values: Sequence[int]) -> int:
    positive = [value for value in values if value > 0]
    if not positive:
        return PPM
    return complement_ppm(gini_ppm(positive))


def _assign_search_to_silos(normalized: Mapping[str, Any], queries_by_silo: Mapping[str, Sequence[str]]):
    search = _rows(normalized, "search_performance_records")
    demand = {silo: 0 for silo in queries_by_silo}
    clicks = {silo: 0 for silo in queries_by_silo}
    zero_click = {silo: 0 for silo in queries_by_silo}
    top10 = {silo: 0 for silo in queries_by_silo}
    rank_gap = {silo: 0 for silo in queries_by_silo}
    silo_tokens = {silo: [set(tokens(query)) for query in queries] for silo, queries in queries_by_silo.items()}
    for row in search:
        q = set(row.get("query_tokens", []))
        best_silo = ""; best_overlap = 0
        for silo in sorted(silo_tokens):
            overlap = max((len(q.intersection(candidate)) for candidate in silo_tokens[silo]), default=0)
            if overlap > best_overlap:
                best_overlap = overlap; best_silo = silo
        if not best_silo:
            continue
        impressions = int(row["impressions"]); click_count = int(row["clicks"])
        demand[best_silo] = demand.get(best_silo, 0) + impressions
        clicks[best_silo] = clicks.get(best_silo, 0) + click_count
        if click_count == 0:
            zero_click[best_silo] = zero_click.get(best_silo, 0) + impressions
        position = int(row["average_position_milli"])
        if position <= 10_000:
            top10[best_silo] = top10.get(best_silo, 0) + impressions
        if 10_000 < position <= 20_000:
            rank_gap[best_silo] = rank_gap.get(best_silo, 0) + impressions
    return search, demand, clicks, zero_click, top10, rank_gap


def _weighted_reachability(nodes: Sequence[str], reach: Mapping[str, set[str]], weights: Mapping[str, int]) -> int:
    denominator = 0; numerator = 0
    for source in nodes:
        for target in nodes:
            if source == target:
                continue
            weight = weights.get(source, 0) + weights.get(target, 0)
            denominator += weight
            if target in reach[source]:
                numerator += weight
    return bounded_ratio_ppm(numerator, denominator) if denominator > 0 else 0


def _candidate_stats(nodes: Sequence[str], edges: Sequence[tuple[str, str]], demand: Mapping[str, int]):
    edge_set = set(edges)
    candidates = [(source, target) for source in nodes for target in nodes if source != target and (source, target) not in edge_set]
    base_reach = _reachability(nodes, edges)
    base_pairs = sum(len(values) for values in base_reach.values())
    best = None; best_gain = -1; best_demand_gain = -1
    for candidate in sorted(candidates):
        reach = _reachability(nodes, list(edges) + [candidate])
        gain = sum(len(values) for values in reach.values()) - base_pairs
        newly = reach[candidate[0]] - base_reach[candidate[0]]
        demand_gain = sum(demand.get(node, 0) for node in newly)
        if (gain, demand_gain) > (best_gain, best_demand_gain):
            best = candidate; best_gain = gain; best_demand_gain = demand_gain
    return candidates, best, max(0, best_gain), max(0, best_demand_gain), base_reach


def _canonical_support(normalized: Mapping[str, Any], silo: str, field: str) -> bool:
    silo_tokens = set(tokens(silo))
    for row in _rows(normalized, "canonicalization_records", allow_empty=True):
        candidate = set(tokens(row.get("query_cluster"))) | set(tokens(row.get("keyword"))) | set(tokens(row.get("semantic_key")))
        if not silo_tokens.intersection(candidate):
            continue
        value = row.get(field)
        if field in {"integrity_verified", "sitemap_present"} and value is True:
            return True
        if field == "query_cluster" and isinstance(value, str) and value.strip():
            return True
    return False


def _feature_map(normalized: Mapping[str, Any], config: Mapping[str, Any]) -> dict[str, tuple[int, dict[str, Any]]]:
    rows, nodes, raw_edges, edges, queries_by_silo, entities_by_silo, intents_by_silo, nav_by_silo, anchors_by_silo = _graph(normalized)
    adjacency = _adj(nodes, edges)
    indegree = {node: 0 for node in nodes}
    for source, target in edges:
        indegree[target] += 1
    outdegree = {node: len(adjacency[node]) for node in nodes}
    reach = _reachability(nodes, edges)
    distances = _distances(nodes, edges)
    components = _components(nodes, edges)
    bridges = _bridge_edges(nodes, edges)
    articulations = _articulations(nodes, edges)
    has_cycle, cycle_nodes = _has_cycle(nodes, edges)
    search, demand, clicks, zero_click, top10, rank_gap = _assign_search_to_silos(normalized, queries_by_silo)
    total_demand = sum(demand.values())
    max_pairs = len(nodes) * (len(nodes) - 1)
    reachable_pairs = sum(len(values) for values in reach.values())
    source_nodes = {source for source, _ in edges}; target_nodes = {target for _, target in edges}
    orphans = [node for node in nodes if outdegree[node] == 0 and indegree[node] == 0]
    source_only = [node for node in nodes if outdegree[node] > 0 and indegree[node] == 0]
    sink_only = [node for node in nodes if indegree[node] > 0 and outdegree[node] == 0]
    edge_set = set(edges)
    reciprocal = sum(1 for source, target in edges if (target, source) in edge_set)
    duplicate_count = len(raw_edges) - len(edges)
    self_loops = sum(1 for source, target in raw_edges if source == target)
    generic = {"click", "click here", "here", "more", "read more", "learn more", "aqui", "aquí", "ver mas", "ver más"}
    all_anchors = [anchor for values in anchors_by_silo.values() for anchor in values]
    generic_count = sum(1 for anchor in all_anchors if anchor in generic)

    service_phrases = config_phrases(config, "local_service_terms")
    location_phrases = config_phrases(config, "local_location_terms")
    urgency_phrases = config_phrases(config, "local_urgency_terms")
    question_phrases = config_phrases(config, "local_question_terms")
    commercial_phrases = config_phrases(config, "local_commercial_terms")
    brand_phrases = config_phrases(config, "local_brand_terms")

    def silo_queries(silo: str) -> list[str]:
        return list(queries_by_silo.get(silo, []))
    def silo_has(silo: str, phrases) -> bool:
        return any(contains_any_phrase(tokens(query), phrases) for query in silo_queries(silo))
    def edge_share(predicate) -> int:
        return bounded_ratio_ppm(sum(1 for edge in edges if predicate(edge)), len(edges)) if edges else 0
    def support_share(nodeset: set[str], predicate) -> int:
        return bounded_ratio_ppm(sum(1 for node in nodeset if predicate(node)), len(nodeset)) if nodeset else PPM

    source_query_support = support_share(source_nodes, lambda silo: bool(silo_queries(silo)))
    target_query_support = support_share(target_nodes, lambda silo: bool(silo_queries(silo)))
    source_entity_support = support_share(source_nodes, lambda silo: bool(entities_by_silo.get(silo)))
    target_entity_support = support_share(target_nodes, lambda silo: bool(entities_by_silo.get(silo)))
    anchor_support = support_share(source_nodes, lambda silo: bool(anchors_by_silo.get(silo)))
    target_content = support_share(target_nodes, lambda silo: any(set(tokens(silo)).intersection(doc.get("tokens", [])) for doc in _rows(normalized, "content_documents", allow_empty=True)))
    canonical_source = support_share(source_nodes, lambda silo: _canonical_support(normalized, silo, "query_cluster"))
    canonical_target = support_share(target_nodes, lambda silo: _canonical_support(normalized, silo, "query_cluster"))
    demand_backed_target = support_share(target_nodes, lambda silo: demand.get(silo, 0) > 0)

    eccentricities = []
    for node in nodes:
        node_distances = [distance for (source, _), distance in distances.items() if source == node]
        eccentricities.append(max(node_distances) if node_distances else len(nodes))
    diameter = max(eccentricities); radius = min(eccentricities)
    sorted_distances = sorted(distances.values())
    median_distance = sorted_distances[(len(sorted_distances)-1)//2] if sorted_distances else len(nodes)

    candidates, best, best_gain, best_demand_gain, base_reach = _candidate_stats(nodes, edges, demand)
    gain_score = min(PPM, (best_gain * PPM)//max(1,max_pairs-reachable_pairs)) if reachable_pairs < max_pairs else 0
    demand_gain_score = min(PPM, (best_demand_gain * PPM)//max(1,total_demand)) if total_demand else 0
    reverse_missing = [candidate for candidate in candidates if (candidate[1], candidate[0]) in edge_set]

    def gain_for(candidate_list: Sequence[tuple[str,str]]) -> int:
        gain = 0
        for candidate in candidate_list:
            new_reach = _reachability(nodes, list(edges)+[candidate])
            gain = max(gain, sum(len(values) for values in new_reach.values()) - reachable_pairs)
        return gain

    reciprocal_gain = gain_for(reverse_missing)
    orphan_candidates = [candidate for candidate in candidates if candidate[0] in orphans or candidate[1] in orphans]
    sink_candidates = [candidate for candidate in candidates if candidate[0] in sink_only]
    component_index = {node:index for index,component in enumerate(components) for node in component}
    merge_candidates = [candidate for candidate in candidates if component_index[candidate[0]] != component_index[candidate[1]]]
    orphan_gain = gain_for(orphan_candidates); sink_gain = gain_for(sink_candidates); merge_gain = gain_for(merge_candidates)

    base_demand_reach = _weighted_reachability(nodes, reach, demand)
    worst_pair_loss = 0; worst_demand_loss = 0
    for edge in edges:
        reduced = [candidate for candidate in edges if candidate != edge]
        reduced_reach = _reachability(nodes, reduced)
        worst_pair_loss = max(worst_pair_loss, reachable_pairs - sum(len(values) for values in reduced_reach.values()))
        worst_demand_loss = max(worst_demand_loss, base_demand_reach - _weighted_reachability(nodes, reduced_reach, demand))

    depth_reduction = 0; old_cost = max(1, sum(distances.values()))
    if best is not None:
        new_distances = _distances(nodes, list(edges)+[best])
        pairs = set(distances) | set(new_distances)
        old_cost = sum(distances.get(pair, len(nodes)+1) for pair in pairs)
        new_cost = sum(new_distances.get(pair, len(nodes)+1) for pair in pairs)
        depth_reduction = max(0, old_cost-new_cost)

    candidate_source = best[0] if best else nodes[0]
    candidate_target = best[1] if best else nodes[-1]
    source_query_tokens = {token for query in silo_queries(candidate_source) for token in tokens(query)}
    target_query_tokens = {token for query in silo_queries(candidate_target) for token in tokens(query)}
    source_entities = {token for entity in entities_by_silo.get(candidate_source,set()) for token in tokens(entity)}
    target_entities = {token for entity in entities_by_silo.get(candidate_target,set()) for token in tokens(entity)}
    source_space = set(tokens(candidate_source)) | source_query_tokens
    target_space = set(tokens(candidate_target)) | target_query_tokens
    union = source_space | target_space; overlap = source_space & target_space
    semantic_support = bounded_ratio_ppm(len(overlap), len(union)) if union else 0
    shared_query_tokens = source_query_tokens & target_query_tokens
    shared_entity_tokens = source_entities & target_entities
    candidate_texts = [candidate_source,candidate_target] + silo_queries(candidate_source) + silo_queries(candidate_target)
    def candidate_has(phrases) -> int:
        return PPM if any(contains_any_phrase(tokens(text), phrases) for text in candidate_texts) else 0

    component_demand = [sum(demand.get(node,0) for node in component) for component in components]
    component_clicks = [sum(clicks.get(node,0) for node in component) for component in components]
    bridge_demand = sum(demand.get(source,0)+demand.get(target,0) for source,target in bridges)
    articulation_demand = sum(demand.get(node,0) for node in articulations)

    features: dict[str, tuple[int, dict[str, Any]]] = {}
    def put(name: str, score: int, **details: Any) -> None:
        features[name] = (max(0,min(PPM,score)), details)

    put("silo_node_coverage", bounded_ratio_ppm(sum(1 for n in nodes if n in source_nodes or n in target_nodes),len(nodes)), node_count=len(nodes))
    put("observed_edge_coverage", min(PPM,(len(edges)*PPM)//max(1,len(nodes))), unique_edge_count=len(edges))
    put("self_loop_health", complement_ppm(bounded_ratio_ppm(self_loops,len(raw_edges))) if raw_edges else PPM, self_loop_count=self_loops)
    put("duplicate_edge_health", complement_ppm(bounded_ratio_ppm(duplicate_count,len(raw_edges))) if raw_edges else PPM, duplicate_edge_count=duplicate_count)
    component_penalty = bounded_ratio_ppm(max(0,len(components)-1),max(1,len(nodes)-1))
    put("weak_component_health", complement_ppm(component_penalty), component_count=len(components))
    put("largest_component_share", bounded_ratio_ppm(len(max(components,key=len)),len(nodes)), largest_component_size=len(max(components,key=len)))
    put("orphan_node_health", complement_ppm(bounded_ratio_ppm(len(orphans),len(nodes))), orphan_nodes=orphans)
    put("source_only_node_health", complement_ppm(bounded_ratio_ppm(len(source_only),len(nodes))), source_only_nodes=source_only)
    put("sink_only_node_health", complement_ppm(bounded_ratio_ppm(len(sink_only),len(nodes))), sink_only_nodes=sink_only)
    put("reciprocal_edge_share", bounded_ratio_ppm(reciprocal,len(edges)) if edges else 0, reciprocal_directed_edges=reciprocal)
    put("directed_reachability_share", bounded_ratio_ppm(reachable_pairs,max_pairs), reachable_pairs=reachable_pairs)
    put("outdegree_balance_health", _count_balance(list(outdegree.values())), outdegrees=outdegree)
    put("indegree_balance_health", _count_balance(list(indegree.values())), indegrees=indegree)
    put("max_outdegree_concentration_health", complement_ppm(bounded_ratio_ppm(max(outdegree.values()),sum(outdegree.values()))) if sum(outdegree.values()) else PPM, max_outdegree=max(outdegree.values()))
    put("max_indegree_concentration_health", complement_ppm(bounded_ratio_ppm(max(indegree.values()),sum(indegree.values()))) if sum(indegree.values()) else PPM, max_indegree=max(indegree.values()))
    non_self_edges = [edge for edge in edges if edge[0] != edge[1]]
    density = bounded_ratio_ppm(len(non_self_edges),max_pairs)
    put("edge_density_health", density, directed_edge_density_ppm=density)
    put("bridge_edge_resilience", complement_ppm(bounded_ratio_ppm(len(bridges),len(edges))) if edges else PPM, bridge_edges=sorted(bridges))
    put("articulation_node_resilience", complement_ppm(bounded_ratio_ppm(len(articulations),len(nodes))), articulation_nodes=sorted(articulations))
    put("cycle_participation_share", bounded_ratio_ppm(len(cycle_nodes),len(nodes)), cycle_nodes=sorted(cycle_nodes))
    put("acyclic_dependency_health", 0 if has_cycle else PPM, cycle_detected=has_cycle)
    put("median_shortest_path_health", PPM if median_distance<=3 else max(0,PPM-((median_distance-3)*PPM)//len(nodes)), median_shortest_path=median_distance)
    put("directed_diameter_health", PPM if diameter<=4 else max(0,PPM-((diameter-4)*PPM)//len(nodes)), directed_diameter=diameter)
    put("graph_radius_health", PPM if radius<=3 else max(0,PPM-((radius-3)*PPM)//len(nodes)), graph_radius=radius)
    put("eccentricity_balance_health", _count_balance(eccentricities), eccentricities=eccentricities)
    put("source_query_support_share", source_query_support, source_count=len(source_nodes))
    put("target_query_support_share", target_query_support, target_count=len(target_nodes))
    put("source_entity_support_share", source_entity_support, source_count=len(source_nodes))
    put("target_entity_support_share", target_entity_support, target_count=len(target_nodes))
    put("anchor_support_share", anchor_support, anchor_count=len(all_anchors))
    put("generic_anchor_health", complement_ppm(bounded_ratio_ppm(generic_count,len(all_anchors))) if all_anchors else PPM, generic_anchor_count=generic_count)
    unique_anchor_tokens = {token for anchor in all_anchors for token in tokens(anchor)}
    put("anchor_vocabulary_diversity", bounded_ratio_ppm(len(unique_anchor_tokens),sum(len(tokens(anchor)) for anchor in all_anchors)) if all_anchors else 0, unique_anchor_tokens=len(unique_anchor_tokens))
    put("target_silo_content_support_share", target_content, target_count=len(target_nodes))
    put("cross_silo_link_share", edge_share(lambda edge:edge[0]!=edge[1]), edge_count=len(edges))
    put("same_silo_link_share", edge_share(lambda edge:edge[0]==edge[1]), self_silo_edges=sum(1 for edge in edges if edge[0]==edge[1]))
    put("navigation_entity_bridge_share", edge_share(lambda edge:bool(nav_by_silo.get(edge[0],set()).intersection(nav_by_silo.get(edge[1],set())))), edge_count=len(edges))
    put("service_bridge_share", edge_share(lambda edge:silo_has(edge[0],service_phrases) or silo_has(edge[1],service_phrases)), edge_count=len(edges))
    put("location_bridge_share", edge_share(lambda edge:silo_has(edge[0],location_phrases) or silo_has(edge[1],location_phrases)), edge_count=len(edges))
    put("urgency_bridge_share", edge_share(lambda edge:silo_has(edge[0],urgency_phrases) or silo_has(edge[1],urgency_phrases)), edge_count=len(edges))
    put("question_bridge_share", edge_share(lambda edge:silo_has(edge[0],question_phrases) or silo_has(edge[1],question_phrases)), edge_count=len(edges))
    put("commercial_bridge_share", edge_share(lambda edge:silo_has(edge[0],commercial_phrases) or silo_has(edge[1],commercial_phrases)), edge_count=len(edges))
    put("brand_bridge_share", edge_share(lambda edge:silo_has(edge[0],brand_phrases) or silo_has(edge[1],brand_phrases)), edge_count=len(edges))
    put("canonical_source_cluster_support", canonical_source, source_count=len(source_nodes))
    put("canonical_target_cluster_support", canonical_target, target_count=len(target_nodes))
    put("demand_backed_target_share", demand_backed_target, target_count=len(target_nodes))
    high_floor = total_demand//max(1,len(nodes))
    put("dead_end_high_demand_health", complement_ppm(bounded_ratio_ppm(sum(demand.get(n,0) for n in sink_only if demand.get(n,0)>=high_floor),total_demand)) if total_demand else PPM, high_demand_floor=high_floor)
    put("orphan_high_demand_health", complement_ppm(bounded_ratio_ppm(sum(demand.get(n,0) for n in orphans),total_demand)) if total_demand else PPM, orphan_demand=sum(demand.get(n,0) for n in orphans))
    put("sink_high_demand_health", complement_ppm(bounded_ratio_ppm(sum(demand.get(n,0) for n in sink_only),total_demand)) if total_demand else PPM, sink_demand=sum(demand.get(n,0) for n in sink_only))
    put("source_only_high_demand_health", complement_ppm(bounded_ratio_ppm(sum(demand.get(n,0) for n in source_only),total_demand)) if total_demand else PPM, source_only_demand=sum(demand.get(n,0) for n in source_only))
    put("demand_weighted_reachability", _weighted_reachability(nodes,reach,demand), score_ppm=_weighted_reachability(nodes,reach,demand))
    put("click_weighted_reachability", _weighted_reachability(nodes,reach,clicks), score_ppm=_weighted_reachability(nodes,reach,clicks))
    put("zero_click_weighted_reachability", _weighted_reachability(nodes,reach,zero_click), score_ppm=_weighted_reachability(nodes,reach,zero_click))
    put("top10_weighted_reachability", _weighted_reachability(nodes,reach,top10), score_ppm=_weighted_reachability(nodes,reach,top10))
    put("rank_gap_weighted_reachability", _weighted_reachability(nodes,reach,rank_gap), score_ppm=_weighted_reachability(nodes,reach,rank_gap))
    demand_gini = gini_ppm([v for v in demand.values() if v>0]) if any(demand.values()) else 0
    click_gini = gini_ppm([v for v in clicks.values() if v>0]) if any(clicks.values()) else 0
    put("silo_demand_gini_health", complement_ppm(demand_gini), gini_ppm=demand_gini)
    put("silo_click_gini_health", complement_ppm(click_gini), gini_ppm=click_gini)
    put("queries_per_silo_balance", _count_balance([len(queries_by_silo.get(n,[])) for n in nodes]), counts={n:len(queries_by_silo.get(n,[])) for n in nodes})
    put("intents_per_silo_balance", _count_balance([len(intents_by_silo.get(n,set())) for n in nodes]), counts={n:len(intents_by_silo.get(n,set())) for n in nodes})
    put("entities_per_silo_balance", _count_balance([len(entities_by_silo.get(n,set())) for n in nodes]), counts={n:len(entities_by_silo.get(n,set())) for n in nodes})
    put("anchors_per_silo_balance", _count_balance([len(anchors_by_silo.get(n,[])) for n in nodes]), counts={n:len(anchors_by_silo.get(n,[])) for n in nodes})
    component_demand_gini = gini_ppm([v for v in component_demand if v>0]) if any(component_demand) else 0
    component_click_gini = gini_ppm([v for v in component_clicks if v>0]) if any(component_clicks) else 0
    put("component_demand_balance", complement_ppm(component_demand_gini), component_demand=component_demand)
    put("component_click_balance", complement_ppm(component_click_gini), component_clicks=component_clicks)
    put("bridge_edge_demand_resilience", complement_ppm(min(PPM,(bridge_demand*PPM)//max(1,total_demand*2))) if total_demand else PPM, bridge_demand=bridge_demand)
    put("articulation_demand_resilience", complement_ppm(bounded_ratio_ppm(min(articulation_demand,total_demand),total_demand)) if total_demand else PPM, articulation_demand=articulation_demand)
    put("best_bridge_reachability_gain", gain_score, best_candidate=list(best) if best else None, reachable_pair_gain=best_gain)
    put("best_bridge_demand_gain", demand_gain_score, best_candidate=list(best) if best else None, demand_gain=best_demand_gain)
    denom_gain = max(1,max_pairs-reachable_pairs)
    put("best_reciprocal_reachability_gain", min(PPM,(reciprocal_gain*PPM)//denom_gain) if reachable_pairs<max_pairs else 0, reachable_pair_gain=reciprocal_gain)
    put("best_orphan_attach_gain", min(PPM,(orphan_gain*PPM)//denom_gain) if reachable_pairs<max_pairs else 0, reachable_pair_gain=orphan_gain)
    put("best_sink_escape_gain", min(PPM,(sink_gain*PPM)//denom_gain) if reachable_pairs<max_pairs else 0, reachable_pair_gain=sink_gain)
    put("best_component_merge_gain", min(PPM,(merge_gain*PPM)//denom_gain) if reachable_pairs<max_pairs else 0, reachable_pair_gain=merge_gain)
    put("worst_edge_removal_reachability_resilience", complement_ppm(min(PPM,(worst_pair_loss*PPM)//max(1,reachable_pairs))), worst_pair_loss=worst_pair_loss)
    put("worst_edge_removal_demand_resilience", complement_ppm(min(PPM,worst_demand_loss)), worst_demand_loss_ppm=worst_demand_loss)
    projected_bridges = _bridge_edges(nodes,list(edges)+[best]) if best else bridges
    bridge_reduction = max(0,len(bridges)-len(projected_bridges))
    put("bridge_redundancy_counterfactual", min(PPM,(bridge_reduction*PPM)//max(1,len(bridges))) if bridges else PPM, bridge_reduction=bridge_reduction)
    projected_articulations = _articulations(nodes,list(edges)+[best]) if best else articulations
    articulation_reduction = max(0,len(articulations)-len(projected_articulations))
    put("articulation_redundancy_counterfactual", min(PPM,(articulation_reduction*PPM)//max(1,len(articulations))) if articulations else PPM, articulation_reduction=articulation_reduction)
    put("route_depth_reduction_potential", min(PPM,(depth_reduction*PPM)//max(1,old_cost)), path_cost_reduction=depth_reduction)
    projected_indegree = indegree.get(candidate_target,0)+(1 if best else 0); overload_limit=max(2,(len(edges)+len(nodes)-1)//len(nodes))
    put("candidate_target_overload_health", PPM if projected_indegree<=overload_limit else max(0,PPM-((projected_indegree-overload_limit)*PPM)//projected_indegree), projected_indegree=projected_indegree)
    put("candidate_semantic_support", semantic_support, candidate=list(best) if best else None, overlap_tokens=sorted(overlap))
    put("candidate_shared_entity_support", min(PPM,len(shared_entity_tokens)*250_000), shared_entity_tokens=sorted(shared_entity_tokens))
    put("candidate_query_overlap_support", min(PPM,len(shared_query_tokens)*200_000), shared_query_tokens=sorted(shared_query_tokens))
    put("candidate_canonical_cluster_support", PPM if _canonical_support(normalized,candidate_source,"query_cluster") and _canonical_support(normalized,candidate_target,"query_cluster") else 0, candidate=list(best) if best else None)
    put("candidate_local_intent_support", candidate_has(location_phrases), candidate=list(best) if best else None)
    put("candidate_service_intent_support", candidate_has(service_phrases), candidate=list(best) if best else None)
    put("candidate_commercial_intent_support", candidate_has(commercial_phrases), candidate=list(best) if best else None)
    candidate_is_brand = any(contains_any_phrase(tokens(text),brand_phrases) for text in candidate_texts)
    put("candidate_nonbrand_support", PPM if not candidate_is_brand else 500_000, candidate=list(best) if best else None)
    put("candidate_source_canonical_integrity", PPM if _canonical_support(normalized,candidate_source,"integrity_verified") else 0, candidate_source=candidate_source)
    put("candidate_target_canonical_integrity", PPM if _canonical_support(normalized,candidate_target,"integrity_verified") else 0, candidate_target=candidate_target)
    put("candidate_source_sitemap_backing", PPM if _canonical_support(normalized,candidate_source,"sitemap_present") else 0, candidate_source=candidate_source)
    put("candidate_target_sitemap_backing", PPM if _canonical_support(normalized,candidate_target,"sitemap_present") else 0, candidate_target=candidate_target)
    evidence_flags = [bool(rows),bool(search),bool(_rows(normalized,"canonicalization_records",allow_empty=True)),bool(_rows(normalized,"content_documents",allow_empty=True)),bool(_rows(normalized,"semantic_text_records",allow_empty=True)),bool(_rows(normalized,"local_business_records",allow_empty=True))]
    evidence_breadth = bounded_ratio_ppm(sum(1 for flag in evidence_flags if flag),len(evidence_flags))
    put("counterfactual_candidate_evidence_breadth", evidence_breadth, evidence_sources_present=sum(1 for flag in evidence_flags if flag))
    confidence_components = [semantic_support,evidence_breadth,canonical_source,canonical_target,demand_backed_target]
    confidence = sum(confidence_components)//len(confidence_components)
    put("counterfactual_confidence_index", confidence, component_scores_ppm=confidence_components, candidate=list(best) if best else None)
    final_components = [bounded_ratio_ppm(reachable_pairs,max_pairs),complement_ppm(bounded_ratio_ppm(len(bridges),len(edges))) if edges else PPM,complement_ppm(bounded_ratio_ppm(len(articulations),len(nodes))),evidence_breadth,confidence]
    put("internal_authority_counterfactual_health", sum(final_components)//len(final_components), component_scores_ppm=final_components, best_candidate=list(best) if best else None)
    return features


def link_counterfactual_metric(spec, normalized, config):
    params = spec.get("params")
    if not isinstance(params, Mapping):
        raise InvalidData("link_counterfactual_params_missing")
    mode = params.get("mode")
    if not isinstance(mode, str):
        raise InvalidData("link_counterfactual_mode_invalid")
    features = _feature_map(normalized, config)
    if mode not in features:
        raise InvalidData(f"unsupported_link_counterfactual_mode:{mode}")
    score, details = features[mode]
    threshold = spec.get("threshold_ppm")
    if isinstance(threshold, bool) or not isinstance(threshold, int):
        raise InvalidData("threshold_ppm_invalid")
    return score, score < threshold, {
        **details,
        "metric": mode,
        "evidence_contract": EVIDENCE_CONTRACT,
        "semantic_boundary": SEMANTIC,
        "observe_only": True,
        "no_site_mutation": True,
        "no_external_link_creation": True,
        "no_link_scheme": True,
        "not_google_pagerank": True,
        "counterfactual_only": True,
    }
