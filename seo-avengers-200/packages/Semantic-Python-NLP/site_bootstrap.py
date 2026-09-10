from __future__ import annotations

import hashlib
import os
from typing import Any
from urllib.parse import urlparse
from xml.etree import ElementTree

import httpx

NEXUS_SITE_ID = "nexus-bot-studio"
NEXUS_ORIGIN = "https://nexusbotstudio.com"
NEXUS_HOSTS = frozenset({"nexusbotstudio.com", "www.nexusbotstudio.com"})
VECTOR_ADMIN_PATH = "/__nexus/seo-vector"
MAX_SITEMAP_BYTES = 512_000
MAX_BOOTSTRAP_ROUTES = 64


def bootstrap_is_authorized_by_deployment() -> bool:
    """Enable only the dedicated Nexus deployment, never a generic/client service.

    The already-required protected edge publisher URL is the deployment-scoped
    authority. External tenants use different publisher hosts and therefore do
    not enter this path. Requiring both secrets keeps an incomplete deployment
    from starting background work accidentally.
    """
    endpoint = os.getenv("NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL", "").strip()
    edge_token = os.getenv("NEXUS_SEO_EDGE_PUBLISH_TOKEN", "").strip()
    semantic_secret = os.getenv("SEMANTIC_SHARED_SECRET", "").strip()
    if not endpoint or not edge_token or not semantic_secret:
        return False
    parsed = urlparse(endpoint)
    return (
        parsed.scheme == "https"
        and parsed.hostname == "nexusbotstudio.com"
        and parsed.path == VECTOR_ADMIN_PATH
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
    )


def _same_tenant_route(raw_url: str) -> str | None:
    try:
        parsed = urlparse(raw_url)
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.hostname not in NEXUS_HOSTS:
        return None
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return None
    route = parsed.path or "/"
    if not route.startswith("/") or "\x00" in route or len(route) > 200:
        return None
    return route


def _parse_sitemap_routes(xml_bytes: bytes) -> list[str]:
    if len(xml_bytes) > MAX_SITEMAP_BYTES:
        raise ValueError("sitemap exceeds bootstrap size limit")
    root = ElementTree.fromstring(xml_bytes)
    routes = {"/"}
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] != "loc" or not node.text:
            continue
        route = _same_tenant_route(node.text.strip())
        if route:
            routes.add(route)
        if len(routes) >= MAX_BOOTSTRAP_ROUTES:
            break
    return sorted(routes)[:MAX_BOOTSTRAP_ROUTES]


async def discover_routes(client: httpx.AsyncClient) -> list[str]:
    try:
        response = await client.get(f"{NEXUS_ORIGIN}/sitemap.xml")
        response.raise_for_status()
        return _parse_sitemap_routes(response.content)
    except (httpx.HTTPError, ElementTree.ParseError, ValueError):
        # The canonical home page is still safe to seed if sitemap discovery is
        # temporarily unavailable. This is a bounded fallback, not route guessing.
        return ["/"]


def _build_request(semantic_main: Any, route: str, text: str, provider_id: str):
    revision_digest = hashlib.sha256(f"{provider_id}\n{text}".encode()).hexdigest()
    core = {
        "authority": "NEXUS_SEO_AVENGERS_200_SECTION_V1",
        "schema_version": 2,
        "site_id": NEXUS_SITE_ID,
        "route": route,
        "section_id": "document",
        "locale": "es-MX",
        "canonical_origin": NEXUS_ORIGIN,
        "text": text,
        "keyword": None,
        "source_revision": f"bootstrap-{revision_digest[:40]}",
    }
    input_hash = semantic_main.canonical_hash(core)
    return semantic_main.SectionVectorRequest(
        **core,
        input_hash=input_hash,
        idempotency_key=input_hash,
    )


async def bootstrap_nexus_site(semantic_main: Any, provider_id: str) -> dict[str, int]:
    """Queue live Nexus pages asynchronously into the durable semantic store."""
    if not bootstrap_is_authorized_by_deployment():
        return {"discovered": 0, "queued": 0, "deduplicated": 0, "failed": 0}

    timeout = httpx.Timeout(8.0, connect=3.0)
    limits = httpx.Limits(max_connections=4, max_keepalive_connections=2)
    queued = deduplicated = failed = 0

    async with httpx.AsyncClient(timeout=timeout, limits=limits, follow_redirects=True) as client:
        routes = await discover_routes(client)
        for route in routes:
            try:
                text = await semantic_main.fetch_visible_text(client, f"{NEXUS_ORIGIN}{route}")
                if not text.strip():
                    failed += 1
                    continue
                request = _build_request(semantic_main, route, text, provider_id)
                accepted = await semantic_main.store.submit(request)
                if accepted.deduplicated:
                    deduplicated += 1
                else:
                    queued += 1
            except Exception as exc:  # noqa: BLE001 - service bootstrap must never kill runtime
                failed += 1
                print(
                    f"seo-avengers bootstrap skipped route={route!r}: {type(exc).__name__}",
                    flush=True,
                )

    result = {
        "discovered": len(routes),
        "queued": queued,
        "deduplicated": deduplicated,
        "failed": failed,
    }
    print(f"seo-avengers bootstrap result={result}", flush=True)
    return result
