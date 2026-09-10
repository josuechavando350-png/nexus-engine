from __future__ import annotations

import asyncio
import hashlib
import os
from collections import defaultdict
from typing import Any

import httpx
import psycopg
from psycopg.types.json import Jsonb
import xx_ent_wiki_sm

PROVIDER_ID = "spacy-xx-ent-wiki-sm-3.8.0+wikidata-frozen-cache"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
MAX_GROUNDED_ENTITIES = 12

_nlp = None
_nlp_lock = __import__("threading").Lock()


def _get_nlp():
    global _nlp
    if _nlp is None:
        with _nlp_lock:
            if _nlp is None:
                _nlp = xx_ent_wiki_sm.load()
    return _nlp


def _extract_sync(text: str) -> list[dict[str, Any]]:
    doc = _get_nlp()(text)
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    label_map = {
        "PER": "PERSON",
        "ORG": "ORGANIZATION",
        "LOC": "LOCATION",
        "MISC": "OTHER",
    }
    for ent in doc.ents:
        name = " ".join(ent.text.split()).strip()
        if not name:
            continue
        entity_type = label_map.get(ent.label_, ent.label_ or "OTHER")
        key = (name.casefold(), entity_type)
        current = grouped.get(key)
        if current is None:
            grouped[key] = {
                "name": name,
                "entity_type": entity_type,
                "count": 1,
                "first_char": ent.start_char,
            }
        else:
            current["count"] += 1
            current["first_char"] = min(current["first_char"], ent.start_char)

    if not grouped:
        return []

    scored: list[dict[str, Any]] = []
    text_len = max(1, len(text))
    for item in grouped.values():
        position_bonus = 1.0 - min(1.0, item["first_char"] / text_len)
        raw = float(item["count"]) + 0.35 * position_bonus
        scored.append({**item, "raw_salience": raw, "metadata": {}})

    total = sum(item["raw_salience"] for item in scored) or 1.0
    for item in scored:
        item["salience"] = item["raw_salience"] / total
    scored.sort(key=lambda item: (-item["salience"], item["name"].casefold(), item["entity_type"]))
    return scored


def _cache_key(name: str, language: str) -> str:
    payload = f"{PROVIDER_ID}\n{language}\n{name.casefold()}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


async def _wikidata_lookup(client: httpx.AsyncClient, name: str) -> tuple[str, dict[str, str]]:
    for language in ("es", "en"):
        try:
            response = await client.get(
                WIKIDATA_API,
                params={
                    "action": "wbsearchentities",
                    "search": name,
                    "language": language,
                    "uselang": language,
                    "type": "item",
                    "limit": 1,
                    "format": "json",
                    "origin": "*",
                },
                headers={"User-Agent": "NexusSEOAvengers/2.0 (+https://nexusbotstudio.com/)"},
            )
            response.raise_for_status()
            hits = response.json().get("search", [])
            if hits:
                hit = hits[0]
                qid = str(hit.get("id", "")).strip()
                if qid:
                    return language, {
                        "wikidata_id": qid,
                        "wikidata_url": f"https://www.wikidata.org/wiki/{qid}",
                    }
        except (httpx.HTTPError, ValueError, TypeError):
            continue
    return "es", {}


async def _ground_with_frozen_cache(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url or not rows:
        return rows

    selected = rows[:MAX_GROUNDED_ENTITIES]
    cache_keys = {_cache_key(item["name"], "es-en"): item for item in selected}
    cached: dict[str, dict[str, str]] = {}

    async with await psycopg.AsyncConnection.connect(database_url) as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS seo_entity_grounding_cache (
                cache_key TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                entity_name TEXT NOT NULL,
                lookup_language TEXT NOT NULL,
                metadata JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        cursor = await conn.execute(
            "SELECT cache_key, metadata FROM seo_entity_grounding_cache WHERE cache_key = ANY(%s)",
            (list(cache_keys.keys()),),
        )
        for key, metadata in await cursor.fetchall():
            cached[str(key)] = dict(metadata or {})
        await conn.commit()

    missing = [(key, item) for key, item in cache_keys.items() if key not in cached]
    if missing:
        timeout = httpx.Timeout(2.5, connect=1.5)
        limits = httpx.Limits(max_connections=4, max_keepalive_connections=2)
        semaphore = asyncio.Semaphore(4)
        async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
            async def resolve(key: str, item: dict[str, Any]):
                async with semaphore:
                    language, metadata = await _wikidata_lookup(client, item["name"])
                    return key, item["name"], language, metadata

            resolved = await asyncio.gather(*(resolve(key, item) for key, item in missing))

        async with await psycopg.AsyncConnection.connect(database_url) as conn:
            for key, name, language, metadata in resolved:
                await conn.execute(
                    """
                    INSERT INTO seo_entity_grounding_cache(cache_key, provider, entity_name, lookup_language, metadata)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT(cache_key) DO NOTHING
                    """,
                    (key, PROVIDER_ID, name, language, Jsonb(metadata)),
                )
            await conn.commit()
            cursor = await conn.execute(
                "SELECT cache_key, metadata FROM seo_entity_grounding_cache WHERE cache_key = ANY(%s)",
                (list(cache_keys.keys()),),
            )
            for key, metadata in await cursor.fetchall():
                cached[str(key)] = dict(metadata or {})

    for key, item in cache_keys.items():
        item["metadata"] = cached.get(key, {})
    return rows


async def analyze_entities_local(semantic_main: Any, text: str):
    rows = await asyncio.to_thread(_extract_sync, text)
    rows = await _ground_with_frozen_cache(rows)
    return [
        semantic_main.RawEntity(
            name=item["name"],
            salience=float(item["salience"]),
            entity_type=item["entity_type"],
            metadata=dict(item.get("metadata") or {}),
        )
        for item in rows
    ]


def section_json_ld_local(req: Any, entities: list[Any]) -> dict[str, Any]:
    mentions: list[dict[str, Any]] = []
    for entity in sorted(entities, key=lambda item: (-item.salience, item.name.casefold()))[:40]:
        item: dict[str, Any] = {
            "@type": "Thing",
            "name": entity.name,
            "additionalProperty": [
                {
                    "@type": "PropertyValue",
                    "name": "nexusEntitySalience",
                    "value": round(entity.salience, 8),
                },
                {
                    "@type": "PropertyValue",
                    "name": "entityProvider",
                    "value": PROVIDER_ID,
                },
            ],
        }
        wikidata_url = entity.metadata.get("wikidata_url")
        if wikidata_url:
            item["sameAs"] = wikidata_url
        wikidata_id = entity.metadata.get("wikidata_id")
        if wikidata_id:
            item["identifier"] = wikidata_id
        mentions.append(item)

    origin = str(req.canonical_origin).rstrip("/") if req.canonical_origin else ""
    page_id = (
        f"{origin}{req.route}#{req.section_id}"
        if origin
        else f"urn:nexus:{req.site_id}:{req.route}:{req.section_id}"
    )
    return {
        "@context": "https://schema.org",
        "@type": "WebPageElement",
        "@id": page_id,
        "inLanguage": req.locale,
        "name": req.keyword or req.section_id,
        "mentions": mentions,
    }


def install_local_provider(semantic_main: Any) -> None:
    original_module_evidence = semantic_main.semantic200_module_evidence

    async def analyze_entities(text: str):
        return await analyze_entities_local(semantic_main, text)

    def module_evidence(req: Any, entities: list[Any], profile: dict[str, Any], bert_profile: dict[str, Any] | None):
        evidence = original_module_evidence(req, entities, profile, bert_profile)
        grounded_count = sum(1 for item in entities if item.metadata.get("wikidata_id"))
        for module_id in range(51, 101):
            key = f"M{module_id}"
            record = evidence.get(key)
            if not isinstance(record, dict):
                continue
            record["basis"] = f"{PROVIDER_ID}+deterministic-vector"
            record["entity_provider"] = PROVIDER_ID
            if 79 <= module_id <= 90:
                record["wikidata_grounded_entity_count"] = grounded_count
                if grounded_count == 0 and record.get("status") == "complete":
                    record["status"] = "requires_context"
            record.pop("evidence_hash", None)
            record["evidence_hash"] = semantic_main.canonical_hash({"module_id": module_id, **record})
        return evidence

    semantic_main.analyze_entities = analyze_entities
    semantic_main.section_json_ld = section_json_ld_local
    semantic_main.semantic200_module_evidence = module_evidence
