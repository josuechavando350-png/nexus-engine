from __future__ import annotations

from .mass_lot_common import *

def _semantic_graph(index: int, rows: Sequence[Mapping[str, Any]], module_id: str,
                    config: Mapping[str, Any]) -> EvalResult:
    texts = [_req_str(row, "text") for row in rows]
    entity_sets = [_entity_rows(row) for row in rows]
    if index == 1:
        missing = 0
        total = 0
        for entities in entity_sets:
            ids = {_entity_id(entity) for entity in entities}
            for entity in entities:
                related = entity.get("related_ids", [])
                if not isinstance(related, list) or any(not isinstance(item, str) for item in related):
                    raise _InvalidData("entity.related_ids")
                total += len(related)
                missing += sum(1 for item in related if item not in ids)
        if total == 0:
            raise _InsufficientData("entity.related_ids")
        return _gt_result(module_id, "unresolved_related_entity_links", missing, config, 0, {"related_links": total}, "ENTITY_CROSSLINKING")
    if index == 2:
        pairs = set()
        for text, entities in zip(texts, entity_sets):
            lower = text.casefold()
            present = sorted({_entity_label(entity).casefold() for entity in entities if _entity_label(entity).casefold() in lower})
            for a_index, left in enumerate(present):
                for right in present[a_index + 1:]:
                    pairs.add((left, right))
        value = len(pairs)
        return _lt_result(module_id, "entity_cooccurrence_pairs", value, config, 1, {"pairs": [list(pair) for pair in sorted(pairs)]}, "ENTITY_COOCCURRENCE")
    if index == 3:
        ambiguous = 0
        for entities in entity_sets:
            labels: Dict[str, set[str]] = {}
            for entity in entities:
                labels.setdefault(_entity_label(entity).casefold(), set()).add(_entity_id(entity))
            ambiguous += sum(1 for ids in labels.values() if len(ids) > 1)
        return _gt_result(module_id, "ambiguous_entity_surfaces", ambiguous, config, 0, {}, "SEMANTIC_AMBIGUITY")
    if index == 4:
        orphan_parent = 0
        nested = 0
        for entities in entity_sets:
            ids = {_entity_id(entity) for entity in entities}
            for entity in entities:
                parent = entity.get("parent_id")
                if parent is None:
                    continue
                if not isinstance(parent, str):
                    raise _InvalidData("entity.parent_id")
                nested += 1
                if parent not in ids:
                    orphan_parent += 1
        if nested == 0:
            raise _InsufficientData("entity.parent_id")
        return _gt_result(module_id, "nested_graph_orphan_parents", orphan_parent, config, 0, {"nested_entities": nested}, "NESTED_JSONLD_GRAPH")
    if index == 5:
        low = 0
        eligible = 0
        for entities in entity_sets:
            for entity in entities:
                if "salience_ppm" not in entity:
                    continue
                value = entity["salience_ppm"]
                if type(value) is not int or not (0 <= value <= PPM):
                    raise _InvalidData("entity.salience_ppm")
                eligible += 1
                low += int(value < 350_000)
        if eligible == 0:
            raise _InsufficientData("entity.salience_ppm")
        return _gt_result(module_id, "low_salience_entities", low, config, 0, {"eligible_entities": eligible}, "ENTITY_SALIENCE")
    if index == 6:
        value = sum(len(re.findall(r"(?<!\w)\d+(?:[.,]\d+)?(?!\w)", text)) for text in texts)
        return _lt_result(module_id, "numeric_cardinal_mentions", value, config, 1, {}, "NUMERIC_CARDINAL_EXTRACTION")
    if index == 7:
        value = sum(sum(1 for entity in entities if _entity_type(entity) in {"GPE", "LOC", "LOCATION", "PLACE"}) for entities in entity_sets)
        return _lt_result(module_id, "geographic_entities", value, config, 1, {}, "GEOGRAPHIC_ENTITY_COVERAGE")
    if index == 8:
        orphan = 0
        eligible = 0
        for entities in entity_sets:
            ids = {_entity_id(entity) for entity in entities}
            for entity in entities:
                taxonomy_parent = entity.get("taxonomy_parent_id")
                if taxonomy_parent is None:
                    continue
                if not isinstance(taxonomy_parent, str):
                    raise _InvalidData("entity.taxonomy_parent_id")
                eligible += 1
                if taxonomy_parent not in ids:
                    orphan += 1
        if eligible == 0:
            raise _InsufficientData("entity.taxonomy_parent_id")
        return _gt_result(module_id, "taxonomy_orphans", orphan, config, 0, {"taxonomy_links": eligible}, "TAXONOMY_HIERARCHY")
    if index == 9:
        value = 0
        eligible = 0
        for row in rows:
            cache = _opt_dict(row, "entity_cache")
            for key, synonyms in cache.items():
                if isinstance(synonyms, list) and all(isinstance(item, str) for item in synonyms):
                    eligible += 1
                    value += max(0, len(set(item.casefold() for item in synonyms)) - 1)
        if eligible == 0:
            raise _InsufficientData("entity_cache")
        return _lt_result(module_id, "deterministic_synonym_links", value, config, 1, {"cache_entries": eligible}, "DETERMINISTIC_SYNONYMS")
    if index == 10:
        allowed = {"string", "integer", "boolean", "number", "url", "date", "datetime"}
        invalid = 0
        eligible = 0
        for entities in entity_sets:
            for entity in entities:
                schema = entity.get("schema_types")
                if schema is None:
                    continue
                if not isinstance(schema, dict):
                    raise _InvalidData("entity.schema_types")
                for value in schema.values():
                    eligible += 1
                    if not isinstance(value, str) or value.casefold() not in allowed:
                        invalid += 1
        if eligible == 0:
            raise _InsufficientData("entity.schema_types")
        return _gt_result(module_id, "invalid_schema_value_types", invalid, config, 0, {"schema_fields": eligible}, "SCHEMA_TYPE_VALIDATION")
    if index == 11:
        value = sum(sum(1 for entity in entities if _entity_type(entity) in {"ORG", "ORGANIZATION", "COMPANY"}) for entities in entity_sets)
        return _lt_result(module_id, "organization_entities", value, config, 1, {}, "ORGANIZATION_ENTITY_EXTRACTION")
    if index == 12:
        value = 0
        entities_count = 0
        for entities in entity_sets:
            for entity in entities:
                properties = entity.get("properties", {})
                if not isinstance(properties, dict):
                    raise _InvalidData("entity.properties")
                entities_count += 1
                value += len(properties)
        if entities_count == 0:
            raise _InsufficientData("entities")
        return _lt_result(module_id, "indexed_entity_properties", value, config, entities_count, {"entities": entities_count}, "ENTITY_PROPERTY_INDEX")
    if index == 13:
        issues = 0
        total = 0
        for entities in entity_sets:
            ids: List[str] = []
            for entity in entities:
                total += 1
                try:
                    ids.append(_entity_id(entity))
                except _InvalidData:
                    issues += 1
            issues += len(ids) - len(set(ids))
        if total == 0:
            raise _InsufficientData("entities")
        return _gt_result(module_id, "entity_id_integrity_issues", issues, config, 0, {"entities": total}, "ENTITY_ID_INTEGRITY")
    if index == 14:
        mismatches = 0
        eligible = 0
        for row, entities in zip(rows, entity_sets):
            locale = _opt_str(row, "locale")
            if not locale:
                continue
            for entity in entities:
                language = entity.get("language")
                if language is None:
                    continue
                if not isinstance(language, str):
                    raise _InvalidData("entity.language")
                eligible += 1
                if not locale.casefold().startswith(language.casefold()) and not language.casefold().startswith(locale.casefold().split("-")[0]):
                    mismatches += 1
        if eligible == 0:
            raise _InsufficientData("entity.language")
        return _gt_result(module_id, "entity_language_variant_mismatches", mismatches, config, 0, {"eligible_entities": eligible}, "LANGUAGE_VARIANT_NORMALIZATION")
    if index == 15:
        missing = 0
        eligible = 0
        for entities in entity_sets:
            for entity in entities:
                salience = entity.get("salience_ppm")
                if salience is None:
                    continue
                if type(salience) is not int or not (0 <= salience <= PPM):
                    raise _InvalidData("entity.salience_ppm")
                if salience >= 500_000:
                    eligible += 1
                    context = entity.get("external_context")
                    if not isinstance(context, dict) or not context:
                        missing += 1
        if eligible == 0:
            raise _InsufficientData("high_salience_entities")
        return _gt_result(module_id, "high_salience_entities_missing_external_context", missing, config, 0, {"eligible_entities": eligible}, "EXTERNAL_ENTITY_CONTEXT")
    if index == 16:
        low_rows = 0
        scores: List[int] = []
        for text in texts:
            tokens = _tokens(text)
            if not tokens:
                raise _InsufficientData("text_tokens")
            score = _ppm(len(set(tokens)), len(tokens))
            scores.append(score)
            if score < 350_000:
                low_rows += 1
        return _gt_result(module_id, "low_semantic_diversity_documents", low_rows, config, 0, {"diversity_ppm": scores}, "SEMANTIC_DIVERSITY")
    if index == 17:
        short = 0
        total = 0
        for text in texts:
            for sentence in _sentences(text):
                total += 1
                if len(_tokens(sentence)) <= 4:
                    short += 1
        if total == 0:
            raise _InsufficientData("sentences")
        density = _ppm(short, total)
        return _gt_result(module_id, "short_phrase_density_ppm", density, config, 700_000, {"short_sentences": short, "sentences": total}, "SHORT_PHRASE_DENSITY", PPM)
    if index == 18:
        value = sum(len(re.findall(r"\b(?:es|son|significa|se\s+define\s+como|consiste\s+en)\b", text, flags=re.I)) for text in texts)
        return _lt_result(module_id, "definition_markers", value, config, 1, {}, "DEFINITION_EXTRACTION")
    if index == 19:
        missing = 0
        headings_count = 0
        for row in rows:
            headings = _list_str(row, "headings")
            links = _opt_list(row, "links")
            anchors: List[str] = []
            for link in links:
                if not isinstance(link, dict):
                    raise _InvalidData("links")
                anchor = link.get("anchor")
                if anchor is not None and not isinstance(anchor, str):
                    raise _InvalidData("link.anchor")
                if anchor:
                    anchors.append(anchor.casefold())
            for heading in headings:
                headings_count += 1
                tokens = set(_tokens(re.sub(r"^h[1-6]\s*:\s*", "", heading, flags=re.I)))
                if tokens and not any(tokens.intersection(_tokens(anchor)) for anchor in anchors):
                    missing += 1
        if headings_count == 0:
            raise _InsufficientData("headings")
        return _gt_result(module_id, "headings_without_topical_anchor", missing, config, 0, {"headings": headings_count}, "TOPICAL_ANCHOR_GENERATION")
    if index == 20:
        value = 0
        for text, entities in zip(texts, entity_sets):
            lower = text.casefold()
            for entity in entities:
                label = _entity_label(entity).casefold()
                if lower.count(label) >= 2:
                    value += 1
        return _lt_result(module_id, "frequent_entity_profiles", value, config, 1, {}, "FREQUENT_ENTITY_PROFILES")
    if index == 21:
        issues = 0
        eligible = 0
        for row in rows:
            levels: List[int] = []
            for heading in _list_str(row, "headings"):
                match = re.match(r"h([1-6])\s*:", heading, flags=re.I)
                if match:
                    levels.append(int(match.group(1)))
            if levels:
                eligible += 1
                for prior, current in zip(levels, levels[1:]):
                    if current - prior > 1:
                        issues += 1
        if eligible == 0:
            raise _InsufficientData("heading_levels")
        return _gt_result(module_id, "heading_hierarchy_jumps", issues, config, 0, {"documents": eligible}, "HEADING_HIERARCHY")
    if index == 22:
        value = sum(sum(1 for entity in entities if _entity_type(entity) in {"EVENT", "TEMPORAL_EVENT"}) for entities in entity_sets)
        return _lt_result(module_id, "temporal_event_entities", value, config, 1, {}, "TEMPORAL_EVENT_ENTITIES")
    if index == 23:
        value = sum(sum(1 for entity in entities if _entity_type(entity) in {"PRODUCT", "OFFER", "SERVICE"}) for entities in entity_sets)
        return _lt_result(module_id, "product_entities", value, config, 1, {}, "PRODUCT_ENTITY_MAPPING")
    if index == 24:
        labels = set()
        for row in rows:
            labels.update(item.casefold() for item in _list_str(row, "intent_labels") if item.strip())
        if not labels:
            raise _InsufficientData("intent_labels")
        value = len(labels)
        return _lt_result(module_id, "search_intent_clusters", value, config, 1, {"clusters": sorted(labels)}, "SEARCH_INTENT_CLUSTERING")
    if index == 25:
        disconnected = 0
        total = 0
        for entities in entity_sets:
            for entity in entities:
                total += 1
                related = entity.get("related_ids", [])
                if not isinstance(related, list):
                    raise _InvalidData("entity.related_ids")
                if not related:
                    disconnected += 1
        if total == 0:
            raise _InsufficientData("entities")
        return _gt_result(module_id, "disconnected_graph_entities", disconnected, config, 0, {"entities": total}, "SITE_GRAPH_CONSOLIDATION")
    raise _InvalidData("UNKNOWN_SEMANTIC_GRAPH_OPERATION")
