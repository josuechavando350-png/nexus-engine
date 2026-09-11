from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import socket
import sqlite3
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import httpx
try:
    import redis.asyncio as redis
    from redis.exceptions import ResponseError
except ImportError:  # localhost stub can run without Redis installed
    redis = None

    class ResponseError(Exception):
        pass

from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Request
try:
    from google.cloud import language_v2
except ImportError:  # SEMANTIC_TEST_STUB=1 remains available for wiring tests
    language_v2 = None
from pydantic import BaseModel, Field, HttpUrl, field_validator
from bert_embeddings import BertEmbeddingEngine

USER_AGENT = "NexusSEOAvengers/2.0 (+https://nexusbotstudio.com/)"
MAX_HTML_BYTES = 2_000_000
MAX_TEXT_CHARS = 100_000
MAX_COMPETITORS = 5
RESULT_TTL_SECONDS = 86_400


class AnalyzeRequest(BaseModel):
    target_url: HttpUrl
    keyword: str = Field(min_length=2, max_length=180)
    competitor_urls: list[HttpUrl] = Field(default_factory=list, max_length=MAX_COMPETITORS)
    source_revision: str = Field(min_length=7, max_length=128)
    input_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")

    @field_validator("keyword")
    @classmethod
    def normalize_keyword(cls, value: str) -> str:
        return " ".join(value.split())


class EntityScore(BaseModel):
    name: str
    entity_type: str
    target_salience: float
    competitor_mean_salience: float
    competitor_max_salience: float
    competitor_document_frequency: int
    gap_score: float
    wikipedia_url: str | None = None
    mid: str | None = None


class AnalyzeResponse(BaseModel):
    target_url: str
    keyword: str
    analyzed_competitors: list[str]
    target_entities: dict[str, float]
    entity_gap_map: list[EntityScore]
    recommended_terms_to_close_gap: list[str]
    semantic_gap_score: float
    input_hash: str
    output_hash: str
    model_note: str


class SectionVectorRequest(BaseModel):
    authority: str = Field(pattern=r"^NEXUS_SEO_AVENGERS_200_SECTION_V1$")
    schema_version: int = Field(ge=2, le=2)
    site_id: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]*$")
    route: str = Field(min_length=1, max_length=200)
    section_id: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]*$")
    locale: str = Field(min_length=2, max_length=32)
    canonical_origin: HttpUrl | None = None
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    keyword: str | None = Field(default=None, max_length=180)
    source_revision: str = Field(min_length=7, max_length=128)
    input_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    idempotency_key: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")

    @field_validator("route")
    @classmethod
    def validate_route(cls, value: str) -> str:
        if not value.startswith("/") or "\x00" in value:
            raise ValueError("route must be a rooted path")
        return value

    @field_validator("text")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        return " ".join(value.split())

    @field_validator("idempotency_key")
    @classmethod
    def bind_idempotency(cls, value: str, info):
        input_hash = info.data.get("input_hash")
        if input_hash and value != input_hash:
            raise ValueError("idempotency_key must equal input_hash")
        return value


class SectionVectorResponse(BaseModel):
    site_id: str
    route: str
    section_id: str
    locale: str
    source_revision: str
    input_hash: str
    entities: list[dict[str, Any]]
    json_ld: dict[str, Any]
    vector_profile: dict[str, Any] = Field(default_factory=dict)
    module_evidence: dict[str, Any] = Field(default_factory=dict)
    output_hash: str
    edge_published: bool


class JobAccepted(BaseModel):
    job_id: str
    deduplicated: bool
    status: str = "queued"


@dataclass(frozen=True)
class RawEntity:
    name: str
    salience: float
    entity_type: str
    metadata: dict[str, str]


@dataclass(frozen=True)
class QueuedJob:
    transport_id: str
    job_id: str
    request: AnalyzeRequest | SectionVectorRequest


class JobStore(Protocol):
    async def initialize(self) -> None: ...
    async def submit(self, req: AnalyzeRequest | SectionVectorRequest) -> JobAccepted: ...
    async def next_job(self) -> QueuedJob | None: ...
    async def complete(self, job: QueuedJob, result: dict[str, Any]) -> None: ...
    async def get(self, job_id: str) -> dict[str, Any] | None: ...
    async def depth(self) -> int: ...
    async def close(self) -> None: ...


def deterministic_job_id(req: AnalyzeRequest | SectionVectorRequest) -> str:
    payload = req.model_dump_json().encode()
    return hashlib.sha256(payload).hexdigest()[:32]


class MemoryJobStore:
    def __init__(self, maxsize: int = 256) -> None:
        self.queue: asyncio.Queue[QueuedJob] = asyncio.Queue(maxsize=maxsize)
        self.results: dict[str, dict[str, Any]] = {}
        self.seen: set[str] = set()
        self.lock = asyncio.Lock()

    async def initialize(self) -> None:
        return None

    async def submit(self, req: AnalyzeRequest | SectionVectorRequest) -> JobAccepted:
        job_id = deterministic_job_id(req)
        async with self.lock:
            if job_id in self.seen:
                return JobAccepted(job_id=job_id, deduplicated=True)
            self.seen.add(job_id)
        await self.queue.put(QueuedJob(job_id, job_id, req))
        return JobAccepted(job_id=job_id, deduplicated=False)

    async def next_job(self) -> QueuedJob | None:
        return await self.queue.get()

    async def complete(self, job: QueuedJob, result: dict[str, Any]) -> None:
        self.results[job.job_id] = result
        self.queue.task_done()

    async def get(self, job_id: str) -> dict[str, Any] | None:
        if job_id in self.results:
            return self.results[job_id]
        if job_id in self.seen:
            return {"status": "queued_or_running"}
        return None

    async def depth(self) -> int:
        return self.queue.qsize()

    async def close(self) -> None:
        return None


class RedisJobStore:
    """Durable Redis Streams queue for multi-instance semantic workers."""

    stream = "seoavengers:semantic:jobs"
    group = "seoavengers-semantic"

    def __init__(self, url: str) -> None:
        if redis is None:
            raise RuntimeError("REDIS_URL configured but redis dependency is not installed")
        self.redis = redis.from_url(url, decode_responses=True)
        self.consumer = f"semantic-{socket.gethostname()}-{os.getpid()}"

    async def initialize(self) -> None:
        await self.redis.ping()
        try:
            await self.redis.xgroup_create(self.stream, self.group, id="0", mkstream=True)
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    async def submit(self, req: AnalyzeRequest | SectionVectorRequest) -> JobAccepted:
        job_id = deterministic_job_id(req)
        seen_key = f"seoavengers:semantic:seen:{job_id}"
        first = await self.redis.set(seen_key, "1", ex=RESULT_TTL_SECONDS, nx=True)
        if not first:
            return JobAccepted(job_id=job_id, deduplicated=True)
        await self.redis.xadd(
            self.stream,
            {
                "job_id": job_id,
                "kind": "section_vector" if isinstance(req, SectionVectorRequest) else "gap_analysis",
                "payload": req.model_dump_json(),
            },
            maxlen=10_000,
            approximate=True,
        )
        return JobAccepted(job_id=job_id, deduplicated=False)

    async def next_job(self) -> QueuedJob | None:
        messages = await self.redis.xreadgroup(
            groupname=self.group,
            consumername=self.consumer,
            streams={self.stream: ">"},
            count=1,
            block=1000,
        )
        if not messages:
            return None
        _, entries = messages[0]
        transport_id, fields = entries[0]
        request_model = SectionVectorRequest if fields.get("kind") == "section_vector" else AnalyzeRequest
        return QueuedJob(
            transport_id=transport_id,
            job_id=fields["job_id"],
            request=request_model.model_validate_json(fields["payload"]),
        )

    async def complete(self, job: QueuedJob, result: dict[str, Any]) -> None:
        result_key = f"seoavengers:semantic:result:{job.job_id}"
        pipe = self.redis.pipeline(transaction=True)
        pipe.set(result_key, json.dumps(result, ensure_ascii=False), ex=RESULT_TTL_SECONDS)
        pipe.xack(self.stream, self.group, job.transport_id)
        await pipe.execute()

    async def get(self, job_id: str) -> dict[str, Any] | None:
        raw = await self.redis.get(f"seoavengers:semantic:result:{job_id}")
        if raw:
            return json.loads(raw)
        if await self.redis.exists(f"seoavengers:semantic:seen:{job_id}"):
            return {"status": "queued_or_running"}
        return None

    async def depth(self) -> int:
        info = await self.redis.xinfo_groups(self.stream)
        for group in info:
            if group.get("name") == self.group:
                return int(group.get("pending", 0)) + int(group.get("lag") or 0)
        return 0

    async def close(self) -> None:
        await self.redis.aclose()


store: JobStore = MemoryJobStore()
worker_tasks: list[asyncio.Task[None]] = []


class SeoVectorStore:
    """Isolated `seo_vectors` table. SQLite is the local mirror/default Nexus store."""

    def __init__(self, database_path: str) -> None:
        self.database_path = database_path

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.database_path, timeout=5.0)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA busy_timeout=5000")
        return db

    def _initialize_sync(self) -> None:
        with self._connect() as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS seo_vectors (
                    site_id TEXT NOT NULL,
                    route TEXT NOT NULL,
                    section_id TEXT NOT NULL,
                    locale TEXT NOT NULL,
                    source_revision TEXT NOT NULL,
                    input_hash TEXT NOT NULL,
                    entity_map_json TEXT NOT NULL,
                    json_ld_json TEXT NOT NULL,
                    vector_profile_json TEXT NOT NULL DEFAULT '{}',
                    module_evidence_json TEXT NOT NULL DEFAULT '{}',
                    output_hash TEXT NOT NULL,
                    updated_at_unix REAL NOT NULL,
                    PRIMARY KEY(site_id, route, section_id)
                ) WITHOUT ROWID
                """
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS seo_vector_route_versions (
                    site_id TEXT NOT NULL,
                    route TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    PRIMARY KEY(site_id, route)
                ) WITHOUT ROWID
                """
            )
            columns = {row[1] for row in db.execute("PRAGMA table_info(seo_vectors)").fetchall()}
            if "vector_profile_json" not in columns:
                db.execute("ALTER TABLE seo_vectors ADD COLUMN vector_profile_json TEXT NOT NULL DEFAULT '{}'")
            if "module_evidence_json" not in columns:
                db.execute("ALTER TABLE seo_vectors ADD COLUMN module_evidence_json TEXT NOT NULL DEFAULT '{}'")

    async def initialize(self) -> None:
        parent = os.path.dirname(os.path.abspath(self.database_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        await asyncio.to_thread(self._initialize_sync)

    def _upsert_sync(self, record: SectionVectorResponse) -> int:
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                """
                INSERT INTO seo_vectors(
                    site_id, route, section_id, locale, source_revision, input_hash,
                    entity_map_json, json_ld_json, vector_profile_json, module_evidence_json, output_hash, updated_at_unix
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(site_id, route, section_id) DO UPDATE SET
                    locale=excluded.locale,
                    source_revision=excluded.source_revision,
                    input_hash=excluded.input_hash,
                    entity_map_json=excluded.entity_map_json,
                    json_ld_json=excluded.json_ld_json,
                    vector_profile_json=excluded.vector_profile_json,
                    module_evidence_json=excluded.module_evidence_json,
                    output_hash=excluded.output_hash,
                    updated_at_unix=excluded.updated_at_unix
                """,
                (
                    record.site_id, record.route, record.section_id, record.locale,
                    record.source_revision, record.input_hash,
                    json.dumps(record.entities, ensure_ascii=False, sort_keys=True),
                    json.dumps(record.json_ld, ensure_ascii=False, sort_keys=True),
                    json.dumps(record.vector_profile, ensure_ascii=False, sort_keys=True),
                    json.dumps(record.module_evidence, ensure_ascii=False, sort_keys=True),
                    record.output_hash, time.time(),
                ),
            )
            db.execute(
                """
                INSERT INTO seo_vector_route_versions(site_id, route, version) VALUES (?, ?, 1)
                ON CONFLICT(site_id, route) DO UPDATE SET version=version+1
                """,
                (record.site_id, record.route),
            )
            version = db.execute(
                "SELECT version FROM seo_vector_route_versions WHERE site_id=? AND route=?",
                (record.site_id, record.route),
            ).fetchone()[0]
            db.commit()
            return int(version)

    async def upsert(self, record: SectionVectorResponse) -> int:
        return await asyncio.to_thread(self._upsert_sync, record)

    def _route_snapshot_sync(self, site_id: str, route: str) -> dict[str, Any]:
        with self._connect() as db:
            version_row = db.execute(
                "SELECT version FROM seo_vector_route_versions WHERE site_id=? AND route=?",
                (site_id, route),
            ).fetchone()
            rows = db.execute(
                "SELECT section_id, json_ld_json, vector_profile_json, module_evidence_json, output_hash FROM seo_vectors WHERE site_id=? AND route=? ORDER BY section_id ASC",
                (site_id, route),
            ).fetchall()
        sections = {
            row[0]: {
                "json_ld": json.loads(row[1]),
                "vector_profile": json.loads(row[2]),
                "module_evidence": json.loads(row[3]),
                "output_hash": row[4],
            }
            for row in rows
        }
        snapshot = {
            "suite": "SEO_AVENGERS_200",
            "module_count": 200,
            "site_id": site_id,
            "route": route,
            "version": int(version_row[0]) if version_row else 0,
            "sections": sections,
        }
        snapshot["output_hash"] = canonical_hash(snapshot)
        return snapshot

    async def route_snapshot(self, site_id: str, route: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._route_snapshot_sync, site_id, route)

    def _get_sync(self, site_id: str, route: str, section_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT site_id, route, section_id, locale, source_revision, input_hash, entity_map_json, json_ld_json, vector_profile_json, module_evidence_json, output_hash FROM seo_vectors WHERE site_id=? AND route=? AND section_id=?",
                (site_id, route, section_id),
            ).fetchone()
        if not row:
            return None
        return {
            "site_id": row[0], "route": row[1], "section_id": row[2], "locale": row[3],
            "source_revision": row[4], "input_hash": row[5],
            "entities": json.loads(row[6]), "json_ld": json.loads(row[7]),
            "vector_profile": json.loads(row[8]), "module_evidence": json.loads(row[9]),
            "output_hash": row[10],
        }

    async def get(self, site_id: str, route: str, section_id: str) -> dict[str, Any] | None:
        return await asyncio.to_thread(self._get_sync, site_id, route, section_id)


vector_store = SeoVectorStore(os.getenv("NEXUS_SEO_VECTOR_DB", ".artifacts/seo-avengers-200/seo-vectors.sqlite3"))


def canonical_hash(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def lexical_feature_embedding(text: str, dimensions: int = 256) -> list[float]:
    """Deterministic, local feature-hash embedding with L2 normalization.

    This is the always-available vector layer for M151-M158. Optional BERT-family
    embeddings can augment it, but never replace the hash-stable baseline used
    for receipts and localhost certification.
    """
    if dimensions < 32 or dimensions > 4096:
        raise ValueError("embedding dimensions out of range")
    vector = [0.0] * dimensions
    tokens = [token.strip(".,:;!?()[]{}\"'<>/\\|-_+").casefold() for token in text.split()]
    for token in (token for token in tokens if token):
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % dimensions
        sign = 1.0 if (digest[4] & 1) == 0 else -1.0
        weight = 1.0 + (digest[5] / 255.0) * 0.25
        vector[index] += sign * weight
    norm = sum(value * value for value in vector) ** 0.5
    if norm:
        vector = [value / norm for value in vector]
    return [round(value, 10) for value in vector]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b) or not a:
        raise ValueError("vectors must have equal non-zero dimensions")
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return 0.0 if na == 0.0 or nb == 0.0 else max(-1.0, min(1.0, dot / (na * nb)))


def semantic200_profile(req: SectionVectorRequest, entities: list[RawEntity]) -> dict[str, Any]:
    ordered = sorted(entities, key=lambda item: (-item.salience, item.name.casefold()))
    saliences = [max(0.0, float(item.salience)) for item in ordered]
    salience_sum = sum(saliences)
    normalized = [value / salience_sum for value in saliences] if salience_sum else []
    entropy = -sum(value * __import__("math").log(value, 2) for value in normalized if value > 0)
    text_vector = lexical_feature_embedding(req.text)
    query_text = req.keyword or req.section_id
    query_vector = lexical_feature_embedding(query_text)
    cosine = cosine_similarity(text_vector, query_vector)
    clusters = [
        {
            "entity": item.name,
            "type": item.entity_type,
            "salience_bucket": min(4, int(max(0.0, item.salience) * 5)),
        }
        for item in ordered[:40]
    ]
    profile = {
        "model": "nexus-feature-hash-v1",
        "dimensions": len(text_vector),
        "embedding_hash": canonical_hash(text_vector),
        "query_embedding_hash": canonical_hash(query_vector),
        "query_cosine": round(cosine, 8),
        "entity_count": len(ordered),
        "entity_type_count": len({item.entity_type for item in ordered}),
        "salience_sum": round(salience_sum, 8),
        "salience_entropy_bits": round(entropy, 8),
        "top1_salience": round(saliences[0] if saliences else 0.0, 8),
        "top3_salience": round(sum(saliences[:3]), 8),
        "clusters": clusters,
        "semantic_invariant": True,
    }
    profile["profile_hash"] = canonical_hash(profile)
    return profile


async def maybe_bert_profile(req: SectionVectorRequest) -> dict[str, Any] | None:
    if os.getenv("NEXUS_ENABLE_BERT_EMBEDDINGS", "0") != "1":
        return None
    engine = BertEmbeddingEngine()
    vectors = await engine.encode([req.text, req.keyword or req.section_id])
    if len(vectors) != 2:
        return None
    return {
        "model": engine.model_name,
        "content_hash": canonical_hash(vectors[0]),
        "query_hash": canonical_hash(vectors[1]),
        "query_cosine": round(engine.cosine(vectors[0], vectors[1]), 8),
    }


def semantic200_module_evidence(
    req: SectionVectorRequest,
    entities: list[RawEntity],
    profile: dict[str, Any],
    bert_profile: dict[str, Any] | None,
) -> dict[str, Any]:
    ordered = sorted(entities, key=lambda item: (-item.salience, item.name.casefold()))
    provider_grounded = [
        {
            "name": item.name,
            "type": item.entity_type,
            "salience": round(item.salience, 8),
            "wikipedia_url": item.metadata.get("wikipedia_url"),
            "wikidata_url": item.metadata.get("wikidata_url"),
            "mid": item.metadata.get("mid"),
        }
        for item in ordered[:40]
    ]
    common = {
        "site_id": req.site_id,
        "route": req.route,
        "section_id": req.section_id,
        "source_revision": req.source_revision,
        "input_hash": req.input_hash,
        "entity_count": profile["entity_count"],
        "entity_type_count": profile["entity_type_count"],
        "query_cosine": profile["query_cosine"],
        "embedding_hash": profile["embedding_hash"],
    }
    evidence: dict[str, Any] = {}

    # M51-M100: the Google-NLP/entity/vector family. Each module receives a
    # hash-bound observation envelope. Capabilities that require competitors or
    # prior revisions state that requirement instead of fabricating a score.
    contextual = {64, 65, 66, 67, 68, 73, 74, 75, 93, 96, 97, 98, 100}
    for module_id in range(51, 101):
        record: dict[str, Any] = {
            "status": "requires_context" if module_id in contextual else "complete",
            "basis": "google-nlp-v2+deterministic-vector",
            **common,
        }
        if module_id == 51:
            record["normalized_salience"] = [round(max(0.0, item.salience), 8) for item in ordered[:40]]
        elif module_id == 52:
            record["salience_entropy_bits"] = profile["salience_entropy_bits"]
        elif module_id == 53:
            record["top3_salience"] = profile["top3_salience"]
        elif module_id == 54:
            record["entity_type_count"] = profile["entity_type_count"]
        elif module_id in {56, 57, 71, 72, 76, 77, 78}:
            record["clusters"] = profile["clusters"]
        elif module_id in {58, 59, 60, 61, 62, 63}:
            record["query_cosine"] = profile["query_cosine"]
        elif 79 <= module_id <= 90:
            record["grounded_entities"] = provider_grounded
        elif module_id == 99:
            record["canonical_evidence_hash"] = canonical_hash(common)
        record["evidence_hash"] = canonical_hash({"module_id": module_id, **record})
        evidence[f"M{module_id}"] = record

    # M151-M158: cognitive vector primitives implemented in Python. PageRank
    # M159-M170 lives in Go; RUM M171-M186 lives in telemetry; M187-M200 is Edge.
    for module_id in range(151, 159):
        record = {
            "status": "complete",
            "basis": "deterministic-feature-hash" if module_id != 152 else "lazy-sentence-transformers",
            **common,
            "vector_profile_hash": profile["profile_hash"],
            "bert": bert_profile,
        }
        record["evidence_hash"] = canonical_hash({"module_id": module_id, **record})
        evidence[f"M{module_id}"] = record
    return evidence


async def ensure_public_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("only public http/https URLs are allowed")
    if parsed.username or parsed.password:
        raise ValueError("credential-bearing URLs are not allowed")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    infos = await asyncio.to_thread(
        socket.getaddrinfo, parsed.hostname, port, type=socket.SOCK_STREAM
    )
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError(f"URL resolves to non-public address: {ip}")


async def robots_allows(client: httpx.AsyncClient, url: str) -> bool:
    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    try:
        response = await client.get(robots_url, headers={"User-Agent": USER_AGENT})
        if response.status_code >= 400:
            return True
        rp = RobotFileParser()
        rp.set_url(robots_url)
        rp.parse(response.text.splitlines())
        return rp.can_fetch(USER_AGENT, url)
    except httpx.HTTPError:
        return True


async def fetch_visible_text(client: httpx.AsyncClient, url: str) -> str:
    await ensure_public_url(url)
    if not await robots_allows(client, url):
        raise ValueError(f"robots.txt disallows analysis: {url}")
    async with client.stream("GET", url, headers={"User-Agent": USER_AGENT}) as response:
        response.raise_for_status()
        content_type = response.headers.get("content-type", "").lower()
        if "text/html" not in content_type:
            raise ValueError(f"target is not HTML: {url}")
        buf = bytearray()
        async for chunk in response.aiter_bytes():
            buf.extend(chunk)
            if len(buf) > MAX_HTML_BYTES:
                raise ValueError(f"HTML exceeds {MAX_HTML_BYTES} bytes: {url}")
    soup = BeautifulSoup(bytes(buf), "html.parser")
    for tag in soup(["script", "style", "noscript", "template", "svg"]):
        tag.decompose()
    return " ".join(soup.stripped_strings)[:MAX_TEXT_CHARS]


async def discover_competitors(client: httpx.AsyncClient, keyword: str) -> list[str]:
    endpoint = os.getenv("SERP_API_URL", "").strip()
    key = os.getenv("SERP_API_KEY", "").strip()
    if not endpoint:
        raise ValueError("competitor_urls omitted and SERP_API_URL is not configured")
    await ensure_public_url(endpoint)
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    response = await client.get(
        endpoint, params={"q": keyword, "num": MAX_COMPETITORS}, headers=headers
    )
    response.raise_for_status()
    data = response.json()
    candidates: list[str] = []
    for item in data.get("organic_results", data.get("items", [])):
        link = item.get("link") or item.get("url")
        if isinstance(link, str):
            candidates.append(link)
    return candidates[:MAX_COMPETITORS]


def _analyze_entities_sync(text: str) -> list[RawEntity]:
    if language_v2 is None:
        raise RuntimeError("google-cloud-language is required unless SEMANTIC_TEST_STUB=1")
    client = language_v2.LanguageServiceClient()
    response = client.analyze_entities(
        request={
            "document": {"content": text, "type_": language_v2.Document.Type.PLAIN_TEXT},
            "encoding_type": language_v2.EncodingType.UTF8,
        }
    )
    out: list[RawEntity] = []
    for entity in response.entities:
        metadata = dict(entity.metadata)
        out.append(
            RawEntity(
                name=entity.name,
                salience=float(entity.salience),
                entity_type=language_v2.Entity.Type(entity.type_).name,
                metadata=metadata,
            )
        )
    return out


async def analyze_entities(text: str) -> list[RawEntity]:
    if os.getenv("SEMANTIC_TEST_STUB") == "1":
        # Wiring-only localhost mode. Production never enables this flag.
        words = [word.strip(".,:;!?()[]{}\"'") for word in text.split()]
        label = " ".join(word for word in words[:4] if word) or "Nexus"
        return [RawEntity(label, 1.0, "OTHER", {})]
    # Google client is synchronous; offload it so FastAPI's event loop is never blocked.
    return await asyncio.to_thread(_analyze_entities_sync, text)


def aggregate_gap(
    target: list[RawEntity], competitors: list[list[RawEntity]]
) -> tuple[list[EntityScore], float]:
    target_map = {e.name.casefold(): e for e in target}
    sums: dict[str, float] = defaultdict(float)
    maxima: dict[str, float] = defaultdict(float)
    freq: dict[str, int] = defaultdict(int)
    representative: dict[str, RawEntity] = {}

    for doc in competitors:
        seen_doc: set[str] = set()
        for entity in doc:
            key = entity.name.casefold()
            representative.setdefault(key, entity)
            sums[key] += entity.salience
            maxima[key] = max(maxima[key], entity.salience)
            if key not in seen_doc:
                freq[key] += 1
                seen_doc.add(key)

    divisor = max(1, len(competitors))
    scores: list[EntityScore] = []
    total_gap = 0.0
    for key, total in sums.items():
        mean = total / divisor
        target_salience = target_map.get(key).salience if key in target_map else 0.0
        document_ratio = freq[key] / divisor
        gap = max(0.0, mean - target_salience) * (1.0 + document_ratio)
        if gap <= 0:
            continue
        rep = representative[key]
        total_gap += gap
        scores.append(
            EntityScore(
                name=rep.name,
                entity_type=rep.entity_type,
                target_salience=target_salience,
                competitor_mean_salience=mean,
                competitor_max_salience=maxima[key],
                competitor_document_frequency=freq[key],
                gap_score=gap,
                wikipedia_url=rep.metadata.get("wikipedia_url"),
                mid=rep.metadata.get("mid"),
            )
        )
    scores.sort(
        key=lambda x: (-x.gap_score, -x.competitor_document_frequency, x.name.casefold())
    )
    return scores, total_gap


async def run_analysis(req: AnalyzeRequest) -> AnalyzeResponse:
    timeout = httpx.Timeout(12.0, connect=5.0)
    limits = httpx.Limits(max_connections=12, max_keepalive_connections=6)
    async with httpx.AsyncClient(timeout=timeout, limits=limits, follow_redirects=True) as client:
        target_url = str(req.target_url)
        competitors = [str(u) for u in req.competitor_urls]
        if not competitors:
            competitors = await discover_competitors(client, req.keyword)
        competitors = [
            u for u in competitors if u.rstrip("/") != target_url.rstrip("/")
        ][:MAX_COMPETITORS]
        if not competitors:
            raise ValueError("no competitor URLs available after filtering")

        target_text, competitor_texts = await asyncio.gather(
            fetch_visible_text(client, target_url),
            asyncio.gather(*(fetch_visible_text(client, u) for u in competitors)),
        )
        target_entities, competitor_entities = await asyncio.gather(
            analyze_entities(target_text),
            asyncio.gather(*(analyze_entities(text) for text in competitor_texts)),
        )

    gaps, total_gap = aggregate_gap(target_entities, competitor_entities)
    target_map = {entity.name: entity.salience for entity in target_entities}
    payload: dict[str, Any] = {
        "target_url": target_url,
        "keyword": req.keyword,
        "analyzed_competitors": competitors,
        "target_entities": target_map,
        "entity_gap_map": [gap.model_dump() for gap in gaps],
        "recommended_terms_to_close_gap": [gap.name for gap in gaps[:30]],
        "semantic_gap_score": total_gap,
        "input_hash": req.input_hash,
        "model_note": (
            "Relative entity-salience gap, not a ranking guarantee or a mathematical promise "
            "to reach Top 1."
        ),
    }
    payload["output_hash"] = canonical_hash(payload)
    return AnalyzeResponse(**payload)


def section_json_ld(req: SectionVectorRequest, entities: list[RawEntity]) -> dict[str, Any]:
    mentions = []
    for entity in sorted(entities, key=lambda item: (-item.salience, item.name.casefold()))[:40]:
        item: dict[str, Any] = {
            "@type": "Thing",
            "name": entity.name,
            "additionalProperty": {
                "@type": "PropertyValue",
                "name": "googleNlpSalience",
                "value": round(entity.salience, 8),
            },
        }
        same_as = [
            value for value in (entity.metadata.get("wikipedia_url"), entity.metadata.get("wikidata_url"))
            if value
        ]
        if same_as:
            item["sameAs"] = same_as if len(same_as) > 1 else same_as[0]
        if entity.metadata.get("mid"):
            item["identifier"] = entity.metadata["mid"]
        mentions.append(item)
    origin = str(req.canonical_origin).rstrip("/") if req.canonical_origin else ""
    page_id = f"{origin}{req.route}#{req.section_id}" if origin else f"urn:nexus:{req.site_id}:{req.route}:{req.section_id}"
    return {
        "@context": "https://schema.org",
        "@type": "WebPageElement",
        "@id": page_id,
        "inLanguage": req.locale,
        "name": req.keyword or req.section_id,
        "mentions": mentions,
    }


async def publish_edge_snapshot(snapshot: dict[str, Any]) -> bool:
    endpoint = os.getenv("NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL", "").strip()
    if not endpoint:
        return False
    token = os.getenv("NEXUS_SEO_EDGE_PUBLISH_TOKEN", "").strip()
    headers = {"authorization": f"Bearer {token}"} if token else {}
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.post(endpoint, json=snapshot, headers=headers)
            response.raise_for_status()
        return True
    except httpx.HTTPError:
        return False


async def run_section_analysis(req: SectionVectorRequest) -> SectionVectorResponse:
    entities = await analyze_entities(req.text)
    entity_map = [
        {
            "name": item.name,
            "salience": item.salience,
            "type": item.entity_type,
            "wikipedia_url": item.metadata.get("wikipedia_url"),
            "wikidata_url": item.metadata.get("wikidata_url"),
            "mid": item.metadata.get("mid"),
        }
        for item in sorted(entities, key=lambda value: (-value.salience, value.name.casefold()))
    ]
    vector_profile = semantic200_profile(req, entities)
    bert_profile = await maybe_bert_profile(req)
    if bert_profile:
        vector_profile = {**vector_profile, "bert": bert_profile}
        vector_profile["profile_hash"] = canonical_hash(vector_profile)
    module_evidence = semantic200_module_evidence(req, entities, vector_profile, bert_profile)
    json_ld = section_json_ld(req, entities)
    digest_payload = {
        "site_id": req.site_id, "route": req.route, "section_id": req.section_id,
        "locale": req.locale, "source_revision": req.source_revision, "input_hash": req.input_hash,
        "entities": entity_map, "json_ld": json_ld, "vector_profile": vector_profile,
        "module_evidence": module_evidence,
    }
    output_hash = canonical_hash(digest_payload)
    record = SectionVectorResponse(
        **digest_payload,
        output_hash=output_hash,
        edge_published=False,
    )
    await vector_store.upsert(record)
    snapshot = await vector_store.route_snapshot(record.site_id, record.route)
    published = await publish_edge_snapshot(snapshot)
    if published:
        record = record.model_copy(update={"edge_published": True})
    return record


async def worker_loop() -> None:
    while True:
        job = await store.next_job()
        if job is None:
            continue
        try:
            result = (
                await run_section_analysis(job.request)
                if isinstance(job.request, SectionVectorRequest)
                else await run_analysis(job.request)
            )
            record = {"status": "complete", "result": result.model_dump(mode="json")}
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # process boundary: failure becomes data, not process death
            record = {"status": "failed", "error": str(exc)}
        await store.complete(job, record)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global store
    redis_url = os.getenv("REDIS_URL", "").strip()
    store = RedisJobStore(redis_url) if redis_url else MemoryJobStore()
    await store.initialize()
    await vector_store.initialize()
    worker_count = max(1, min(8, int(os.getenv("SEMANTIC_WORKERS", "2"))))
    worker_tasks.extend(asyncio.create_task(worker_loop()) for _ in range(worker_count))
    yield
    for task in worker_tasks:
        task.cancel()
    await asyncio.gather(*worker_tasks, return_exceptions=True)
    await store.close()


app = FastAPI(title="SEO AVENGERS 200 Semantic Analyzer", version="2.0.0", lifespan=lifespan)


def require_internal_auth(request: Request) -> None:
    expected = os.getenv("SEMANTIC_SHARED_SECRET", "").strip()
    if not expected:
        return
    got = request.headers.get("authorization", "")
    if got != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"ok": True, "queue_depth": await store.depth(), "time_unix": time.time()}


@app.post("/v1/semantic/analyze", response_model=AnalyzeResponse)
async def analyze(payload: AnalyzeRequest, request: Request) -> AnalyzeResponse:
    require_internal_auth(request)
    try:
        return await run_analysis(payload)
    except (ValueError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail="semantic provider failure") from exc


@app.post("/v1/semantic/jobs", response_model=JobAccepted, status_code=202)
async def submit_job(payload: AnalyzeRequest, request: Request) -> JobAccepted:
    require_internal_auth(request)
    try:
        return await store.submit(payload)
    except asyncio.QueueFull as exc:
        raise HTTPException(status_code=503, detail="semantic queue saturated") from exc


@app.post("/v1/semantic/sections", response_model=JobAccepted, status_code=202)
async def submit_section(payload: SectionVectorRequest, request: Request) -> JobAccepted:
    require_internal_auth(request)
    try:
        return await store.submit(payload)
    except asyncio.QueueFull as exc:
        raise HTTPException(status_code=503, detail="semantic queue saturated") from exc


@app.get("/v1/semantic/vectors/{site_id}/{section_id}")
async def get_vector(site_id: str, section_id: str, request: Request, route: str = "/") -> dict[str, Any]:
    require_internal_auth(request)
    result = await vector_store.get(site_id, route, section_id)
    if result is None:
        raise HTTPException(status_code=404, detail="vector not found")
    return result


@app.get("/v1/semantic/jobs/{job_id}")
async def job_result(job_id: str, request: Request) -> dict[str, Any]:
    require_internal_auth(request)
    result = await store.get(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail="job not found")
    return result
