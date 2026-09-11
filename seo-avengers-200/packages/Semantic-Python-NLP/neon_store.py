from __future__ import annotations

from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from main import (
    AnalyzeRequest,
    JobAccepted,
    QueuedJob,
    SectionVectorRequest,
    SectionVectorResponse,
    canonical_hash,
    deterministic_job_id,
)


class PostgresJobStore:
    """Durable Postgres queue/result store with deterministic idempotency."""

    def __init__(self, url: str) -> None:
        self.url = url

    async def initialize(self) -> None:
        async with await psycopg.AsyncConnection.connect(self.url) as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS seo_semantic_jobs (
                    job_id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    payload JSONB NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    result JSONB,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    locked_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS seo_semantic_jobs_status_created_idx ON seo_semantic_jobs(status, created_at)"
            )
            await conn.commit()

    async def submit(self, req: AnalyzeRequest | SectionVectorRequest) -> JobAccepted:
        job_id = deterministic_job_id(req)
        kind = "section_vector" if isinstance(req, SectionVectorRequest) else "gap_analysis"
        async with await psycopg.AsyncConnection.connect(self.url) as conn:
            cursor = await conn.execute(
                """
                INSERT INTO seo_semantic_jobs(job_id, kind, payload, status)
                VALUES (%s, %s, %s, 'queued')
                ON CONFLICT(job_id) DO NOTHING
                RETURNING job_id
                """,
                (job_id, kind, Jsonb(req.model_dump(mode="json"))),
            )
            row = await cursor.fetchone()
            await conn.commit()
        return JobAccepted(job_id=job_id, deduplicated=row is None)

    async def next_job(self) -> QueuedJob | None:
        async with (
            await psycopg.AsyncConnection.connect(self.url) as conn,
            conn.transaction(),
        ):
            cursor = await conn.execute(
                """
                WITH candidate AS (
                    SELECT job_id
                    FROM seo_semantic_jobs
                    WHERE status = 'queued'
                       OR (status = 'running' AND locked_at < now() - interval '10 minutes')
                    ORDER BY created_at ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                UPDATE seo_semantic_jobs AS jobs
                SET status = 'running',
                    locked_at = now(),
                    attempts = attempts + 1,
                    updated_at = now()
                FROM candidate
                WHERE jobs.job_id = candidate.job_id
                RETURNING jobs.job_id, jobs.kind, jobs.payload
                """
            )
            row = await cursor.fetchone()
        if row is None:
            return None
        job_id, kind, payload = row
        model = SectionVectorRequest if kind == "section_vector" else AnalyzeRequest
        req = model.model_validate(payload)
        return QueuedJob(transport_id=job_id, job_id=job_id, request=req)

    async def complete(self, job: QueuedJob, result: dict[str, Any]) -> None:
        async with await psycopg.AsyncConnection.connect(self.url) as conn:
            await conn.execute(
                """
                UPDATE seo_semantic_jobs
                SET status = 'complete', result = %s, locked_at = NULL, updated_at = now()
                WHERE job_id = %s
                """,
                (Jsonb(result), job.job_id),
            )
            await conn.commit()

    async def get(self, job_id: str) -> dict[str, Any] | None:
        async with await psycopg.AsyncConnection.connect(self.url) as conn:
            cursor = await conn.execute(
                "SELECT status, result FROM seo_semantic_jobs WHERE job_id = %s",
                (job_id,),
            )
            row = await cursor.fetchone()
        if row is None:
            return None
        status, result = row
        if status == "complete" and result is not None:
            return result
        return {"status": "queued_or_running"}

    async def depth(self) -> int:
        async with await psycopg.AsyncConnection.connect(self.url) as conn:
            cursor = await conn.execute(
                "SELECT count(*) FROM seo_semantic_jobs WHERE status IN ('queued', 'running')"
            )
            row = await cursor.fetchone()
        return int(row[0]) if row else 0

    async def close(self) -> None:
        return None


class PostgresSeoVectorStore:
    """Durable Neon Postgres store for route-scoped SEO vector snapshots."""

    def __init__(self, url: str) -> None:
        self.url = url

    async def initialize(self) -> None:
        async with await psycopg.AsyncConnection.connect(self.url) as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS seo_vectors (
                    site_id TEXT NOT NULL,
                    route TEXT NOT NULL,
                    section_id TEXT NOT NULL,
                    locale TEXT NOT NULL,
                    source_revision TEXT NOT NULL,
                    input_hash TEXT NOT NULL,
                    entity_map JSONB NOT NULL,
                    json_ld JSONB NOT NULL,
                    vector_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
                    module_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
                    output_hash TEXT NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    PRIMARY KEY(site_id, route, section_id)
                )
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS seo_vector_route_versions (
                    site_id TEXT NOT NULL,
                    route TEXT NOT NULL,
                    version BIGINT NOT NULL,
                    PRIMARY KEY(site_id, route)
                )
                """
            )
            await conn.commit()

    async def upsert(self, record: SectionVectorResponse) -> int:
        async with (
            await psycopg.AsyncConnection.connect(self.url) as conn,
            conn.transaction(),
        ):
            await conn.execute(
                """
                INSERT INTO seo_vectors(
                    site_id, route, section_id, locale, source_revision, input_hash,
                    entity_map, json_ld, vector_profile, module_evidence, output_hash, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT(site_id, route, section_id) DO UPDATE SET
                    locale = EXCLUDED.locale,
                    source_revision = EXCLUDED.source_revision,
                    input_hash = EXCLUDED.input_hash,
                    entity_map = EXCLUDED.entity_map,
                    json_ld = EXCLUDED.json_ld,
                    vector_profile = EXCLUDED.vector_profile,
                    module_evidence = EXCLUDED.module_evidence,
                    output_hash = EXCLUDED.output_hash,
                    updated_at = now()
                """,
                (
                    record.site_id,
                    record.route,
                    record.section_id,
                    record.locale,
                    record.source_revision,
                    record.input_hash,
                    Jsonb(record.entities),
                    Jsonb(record.json_ld),
                    Jsonb(record.vector_profile),
                    Jsonb(record.module_evidence),
                    record.output_hash,
                ),
            )
            cursor = await conn.execute(
                """
                INSERT INTO seo_vector_route_versions(site_id, route, version)
                VALUES (%s, %s, 1)
                ON CONFLICT(site_id, route) DO UPDATE
                SET version = seo_vector_route_versions.version + 1
                RETURNING version
                """,
                (record.site_id, record.route),
            )
            row = await cursor.fetchone()
        return int(row[0]) if row else 0

    async def route_snapshot(self, site_id: str, route: str) -> dict[str, Any]:
        async with await psycopg.AsyncConnection.connect(self.url) as conn:
            version_cursor = await conn.execute(
                "SELECT version FROM seo_vector_route_versions WHERE site_id = %s AND route = %s",
                (site_id, route),
            )
            version_row = await version_cursor.fetchone()
            cursor = await conn.execute(
                """
                SELECT section_id, json_ld, vector_profile, module_evidence, output_hash
                FROM seo_vectors
                WHERE site_id = %s AND route = %s
                ORDER BY section_id ASC
                """,
                (site_id, route),
            )
            rows = await cursor.fetchall()
        sections = {
            row[0]: {
                "json_ld": row[1],
                "vector_profile": row[2],
                "module_evidence": row[3],
                "output_hash": row[4],
            }
            for row in rows
        }
        snapshot: dict[str, Any] = {
            "suite": "SEO_AVENGERS_200",
            "module_count": 200,
            "site_id": site_id,
            "route": route,
            "version": int(version_row[0]) if version_row else 0,
            "sections": sections,
        }
        snapshot["output_hash"] = canonical_hash(snapshot)
        return snapshot

    async def get(self, site_id: str, route: str, section_id: str) -> dict[str, Any] | None:
        async with await psycopg.AsyncConnection.connect(self.url) as conn:
            cursor = await conn.execute(
                """
                SELECT site_id, route, section_id, locale, source_revision, input_hash,
                       entity_map, json_ld, vector_profile, module_evidence, output_hash
                FROM seo_vectors
                WHERE site_id = %s AND route = %s AND section_id = %s
                """,
                (site_id, route, section_id),
            )
            row = await cursor.fetchone()
        if row is None:
            return None
        return {
            "site_id": row[0],
            "route": row[1],
            "section_id": row[2],
            "locale": row[3],
            "source_revision": row[4],
            "input_hash": row[5],
            "entities": row[6],
            "json_ld": row[7],
            "vector_profile": row[8],
            "module_evidence": row[9],
            "output_hash": row[10],
        }
