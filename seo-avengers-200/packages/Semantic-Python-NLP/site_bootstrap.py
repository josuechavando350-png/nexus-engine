from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
import re
from typing import Any
from urllib.parse import urlparse
from xml.etree import ElementTree

import httpx

DEFAULT_SITE_ID = "nexus-bot-studio"
DEFAULT_ORIGIN = "https://nexusbotstudio.com"
VECTOR_ADMIN_PATH = "/__nexus/seo-vector"
MAX_SITEMAP_BYTES = 512_000
MAX_BOOTSTRAP_ROUTES = 64
SITE_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


@dataclass(frozen=True, slots=True)
class BootstrapTenant:
    site_id: str
    origin: str
    hosts: frozenset[str]
    publisher_hostname: str


def _origin_hosts(hostname: str) -> frozenset[str]:
    if hostname.startswith("www."):
        bare = hostname[4:]
        return frozenset({hostname, bare}) if bare else frozenset({hostname})
    return frozenset({hostname, f"www.{hostname}"})


def _parse_tenant(site_id: str, origin: str) -> BootstrapTenant | None:
    if not SITE_ID_RE.fullmatch(site_id):
        return None
    try:
        parsed = urlparse(origin)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or port is not None
        or parsed.path not in ("", "/")
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        return None
    hostname = parsed.hostname.lower()
    normalized_origin = f"https://{hostname}"
    return BootstrapTenant(
        site_id=site_id,
        origin=normalized_origin,
        hosts=_origin_hosts(hostname),
        publisher_hostname=hostname,
    )


def load_bootstrap_tenant() -> BootstrapTenant | None:
    """Load one deployment-scoped tenant, preserving the existing Nexus default.

    Both override variables must be supplied together. A partial or invalid
    override fails closed instead of silently combining tenants.
    """
    configured_site_id = os.getenv("NEXUS_SEO_BOOTSTRAP_SITE_ID", "").strip()
    configured_origin = os.getenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", "").strip()

    if bool(configured_site_id) != bool(configured_origin):
        return None
    if configured_site_id:
        return _parse_tenant(configured_site_id, configured_origin)
    return _parse_tenant(DEFAULT_SITE_ID, DEFAULT_ORIGIN)


def bootstrap_is_authorized_by_deployment(
    tenant: BootstrapTenant | None = None,
) -> bool:
    """Enable only when the protected publisher belongs to this deployment tenant.

    Bootstrap runs in-process and does not traverse the protected /v1 API, so
    SEMANTIC_SHARED_SECRET must not gate it. Deployment authority is the exact
    configured tenant publisher host plus its bearer token.
    """
    tenant = tenant or load_bootstrap_tenant()
    if tenant is None:
        return False

    endpoint = os.getenv("NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL", "").strip()
    edge_token = os.getenv("NEXUS_SEO_EDGE_PUBLISH_TOKEN", "").strip()
    if not endpoint or not edge_token:
        return False
    try:
        parsed = urlparse(endpoint)
        port = parsed.port
    except ValueError:
        return False
    normalized_path = parsed.path.rstrip("/") or "/"
    return (
        parsed.scheme == "https"
        and parsed.hostname == tenant.publisher_hostname
        and port is None
        and normalized_path == VECTOR_ADMIN_PATH
        and not parsed.username
        and not parsed.password
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
    )


def _same_tenant_route(
    raw_url: str,
    tenant: BootstrapTenant | None = None,
) -> str | None:
    tenant = tenant or load_bootstrap_tenant()
    if tenant is None:
        return None
    try:
        parsed = urlparse(raw_url)
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.hostname not in tenant.hosts:
        return None
    if parsed.username or parsed.password or port is not None:
        return None
    if parsed.query or parsed.fragment:
        return None
    route = parsed.path or "/"
    if not route.startswith("/") or "\x00" in route or len(route) > 200:
        return None
    return route


def _parse_sitemap_routes(
    xml_bytes: bytes,
    tenant: BootstrapTenant | None = None,
) -> list[str]:
    tenant = tenant or load_bootstrap_tenant()
    if tenant is None:
        return []
    if len(xml_bytes) > MAX_SITEMAP_BYTES:
        raise ValueError("sitemap exceeds bootstrap size limit")
    root = ElementTree.fromstring(xml_bytes)
    routes = {"/"}
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] != "loc" or not node.text:
            continue
        route = _same_tenant_route(node.text.strip(), tenant)
        if route:
            routes.add(route)
        if len(routes) >= MAX_BOOTSTRAP_ROUTES:
            break
    return sorted(routes)[:MAX_BOOTSTRAP_ROUTES]


async def discover_routes(
    client: httpx.AsyncClient,
    tenant: BootstrapTenant | None = None,
) -> list[str]:
    tenant = tenant or load_bootstrap_tenant()
    if tenant is None:
        return []
    try:
        response = await client.get(f"{tenant.origin}/sitemap.xml")
        response.raise_for_status()
        return _parse_sitemap_routes(response.content, tenant)
    except (httpx.HTTPError, ElementTree.ParseError, ValueError):
        # The canonical home page is still safe to seed if sitemap discovery is
        # temporarily unavailable. This is a bounded fallback, not route guessing.
        return ["/"]


def _build_request(
    semantic_main: Any,
    route: str,
    text: str,
    provider_id: str,
    tenant: BootstrapTenant | None = None,
):
    tenant = tenant or load_bootstrap_tenant()
    if tenant is None:
        raise ValueError("invalid bootstrap tenant configuration")
    revision_digest = hashlib.sha256(f"{provider_id}\n{text}".encode()).hexdigest()
    core = {
        "authority": "NEXUS_SEO_AVENGERS_200_SECTION_V1",
        "schema_version": 2,
        "site_id": tenant.site_id,
        "route": route,
        "section_id": "document",
        "locale": "es-MX",
        "canonical_origin": tenant.origin,
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


async def bootstrap_site_tenant(semantic_main: Any, provider_id: str) -> dict[str, int]:
    """Queue one authorized deployment tenant into the durable semantic store."""
    tenant = load_bootstrap_tenant()
    if tenant is None or not bootstrap_is_authorized_by_deployment(tenant):
        print(
            "seo-avengers bootstrap disabled: publisher deployment not authorized",
            flush=True,
        )
        return {"discovered": 0, "queued": 0, "deduplicated": 0, "failed": 0}

    timeout = httpx.Timeout(8.0, connect=3.0)
    limits = httpx.Limits(max_connections=4, max_keepalive_connections=2)
    queued = deduplicated = failed = 0

    async with httpx.AsyncClient(
        timeout=timeout,
        limits=limits,
        follow_redirects=True,
    ) as client:
        routes = await discover_routes(client, tenant)
        for route in routes:
            try:
                text = await semantic_main.fetch_visible_text(
                    client,
                    f"{tenant.origin}{route}",
                )
                if not text.strip():
                    failed += 1
                    continue
                request = _build_request(
                    semantic_main,
                    route,
                    text,
                    provider_id,
                    tenant,
                )
                accepted = await semantic_main.store.submit(request)
                if accepted.deduplicated:
                    deduplicated += 1
                else:
                    queued += 1
            except Exception as exc:  # noqa: BLE001 - bootstrap must never kill runtime
                failed += 1
                print(
                    f"seo-avengers bootstrap skipped route={route!r}: "
                    f"{type(exc).__name__}: {exc}",
                    flush=True,
                )

    result = {
        "discovered": len(routes),
        "queued": queued,
        "deduplicated": deduplicated,
        "failed": failed,
    }
    print(
        f"seo-avengers bootstrap site_id={tenant.site_id!r} result={result}",
        flush=True,
    )
    return result


# Backward-compatible internal alias for deployments still importing the old name.
bootstrap_nexus_site = bootstrap_site_tenant
