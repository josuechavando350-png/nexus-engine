from __future__ import annotations

import os
from fastapi import Request
from fastapi.responses import JSONResponse

from main import app


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
