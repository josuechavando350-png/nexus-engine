from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import main as semantic_main
from local_semantic_provider import PROVIDER_ID, install_local_provider
from neon_store import PostgresJobStore, PostgresSeoVectorStore
from site_bootstrap import bootstrap_nexus_site

install_local_provider(semantic_main)
app = semantic_main.app


@asynccontextmanager
async def render_neon_lifespan(fastapi_app: FastAPI):
    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url:
        async with semantic_main.lifespan(fastapi_app):
            yield
        return

    semantic_main.store = PostgresJobStore(database_url)
    semantic_main.vector_store = PostgresSeoVectorStore(database_url)
    await semantic_main.store.initialize()
    await semantic_main.vector_store.initialize()

    semantic_main.worker_tasks.clear()
    worker_count = max(1, min(8, int(os.getenv("SEMANTIC_WORKERS", "2"))))
    semantic_main.worker_tasks.extend(
        asyncio.create_task(semantic_main.worker_loop()) for _ in range(worker_count)
    )

    # This task is deliberately out-of-band. The HTTP service becomes ready
    # without waiting for sitemap discovery, NLP, Neon writes, or Edge publish.
    # site_bootstrap additionally requires the exact protected Nexus publisher
    # deployment before it will queue any work, so client deployments stay off.
    bootstrap_task = asyncio.create_task(bootstrap_nexus_site(semantic_main, PROVIDER_ID))
    try:
        yield
    finally:
        if not bootstrap_task.done():
            bootstrap_task.cancel()
        await asyncio.gather(bootstrap_task, return_exceptions=True)
        for task in semantic_main.worker_tasks:
            task.cancel()
        await asyncio.gather(*semantic_main.worker_tasks, return_exceptions=True)
        semantic_main.worker_tasks.clear()
        await semantic_main.store.close()


app.router.lifespan_context = render_neon_lifespan


@app.middleware("http")
async def render_fail_closed_auth(request: Request, call_next):
    if request.url.path.startswith("/v1/"):
        expected = os.getenv("SEMANTIC_SHARED_SECRET", "").strip()
        if not expected:
            return JSONResponse(status_code=503, content={"detail": "semantic auth not configured"})
        got = request.headers.get("authorization", "")
        if got != f"Bearer {expected}":
            return JSONResponse(status_code=401, content={"detail": "unauthorized"})
    return await call_next(request)
