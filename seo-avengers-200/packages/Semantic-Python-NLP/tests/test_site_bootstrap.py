from __future__ import annotations

from dataclasses import dataclass

import site_bootstrap


def _clear_tenant_env(monkeypatch):
    for name in (
        "NEXUS_SEO_BOOTSTRAP_SITE_ID",
        "NEXUS_SEO_BOOTSTRAP_ORIGIN",
        "NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL",
        "NEXUS_SEO_EDGE_PUBLISH_TOKEN",
        "SEMANTIC_SHARED_SECRET",
    ):
        monkeypatch.delenv(name, raising=False)


def test_existing_nexus_default_stays_authorized_only_by_exact_publisher(monkeypatch):
    _clear_tenant_env(monkeypatch)
    tenant = site_bootstrap.load_bootstrap_tenant()
    assert tenant is not None
    assert tenant.site_id == "nexus-bot-studio"
    assert tenant.origin == "https://nexusbotstudio.com"
    assert site_bootstrap.bootstrap_is_authorized_by_deployment(tenant) is False

    monkeypatch.setenv(
        "NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL",
        "https://nexusbotstudio.com/__nexus/seo-vector",
    )
    monkeypatch.setenv("NEXUS_SEO_EDGE_PUBLISH_TOKEN", "edge-secret")
    assert site_bootstrap.bootstrap_is_authorized_by_deployment(tenant) is True

    monkeypatch.setenv(
        "NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL",
        "https://cliente-ejemplo.com/__nexus/seo-vector",
    )
    assert site_bootstrap.bootstrap_is_authorized_by_deployment(tenant) is False


def test_client_tenant_is_explicit_and_isolated(monkeypatch):
    _clear_tenant_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_SITE_ID", "cano-penal")
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", "https://canopenal.com")
    monkeypatch.setenv(
        "NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL",
        "https://canopenal.com/__nexus/seo-vector",
    )
    monkeypatch.setenv("NEXUS_SEO_EDGE_PUBLISH_TOKEN", "cano-edge-secret")

    tenant = site_bootstrap.load_bootstrap_tenant()
    assert tenant is not None
    assert tenant.site_id == "cano-penal"
    assert tenant.origin == "https://canopenal.com"
    assert tenant.hosts == frozenset({"canopenal.com", "www.canopenal.com"})
    assert site_bootstrap.bootstrap_is_authorized_by_deployment(tenant) is True

    xml = b"""<?xml version='1.0' encoding='UTF-8'?>
    <urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>
      <url><loc>https://canopenal.com/</loc></url>
      <url><loc>https://www.canopenal.com/defensa-penal</loc></url>
      <url><loc>https://nexusbotstudio.com/no-tocar</loc></url>
      <url><loc>https://cliente-ejemplo.com/no-tocar</loc></url>
      <url><loc>http://canopenal.com/inseguro</loc></url>
      <url><loc>https://canopenal.com/ruta?preview=1</loc></url>
    </urlset>
    """
    assert site_bootstrap._parse_sitemap_routes(xml, tenant) == [
        "/",
        "/defensa-penal",
    ]

    monkeypatch.setenv(
        "NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL",
        "https://nexusbotstudio.com/__nexus/seo-vector",
    )
    assert site_bootstrap.bootstrap_is_authorized_by_deployment(tenant) is False


def test_partial_or_invalid_client_configuration_fails_closed(monkeypatch):
    _clear_tenant_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_SITE_ID", "cano-penal")
    assert site_bootstrap.load_bootstrap_tenant() is None
    assert site_bootstrap.bootstrap_is_authorized_by_deployment() is False

    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", "http://canopenal.com")
    assert site_bootstrap.load_bootstrap_tenant() is None

    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", "https://canopenal.com/subpath")
    assert site_bootstrap.load_bootstrap_tenant() is None

    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_SITE_ID", "CANO PENAL")
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", "https://canopenal.com")
    assert site_bootstrap.load_bootstrap_tenant() is None


@dataclass
class _Request:
    authority: str
    schema_version: int
    site_id: str
    route: str
    section_id: str
    locale: str
    canonical_origin: str
    text: str
    keyword: str | None
    source_revision: str
    input_hash: str
    idempotency_key: str


class _SemanticMain:
    SectionVectorRequest = _Request

    @staticmethod
    def canonical_hash(core):
        assert core["site_id"] == "cano-penal"
        assert core["canonical_origin"] == "https://canopenal.com"
        return "a" * 64


def test_vector_request_is_scoped_to_selected_client(monkeypatch):
    _clear_tenant_env(monkeypatch)
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_SITE_ID", "cano-penal")
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", "https://canopenal.com")
    tenant = site_bootstrap.load_bootstrap_tenant()
    assert tenant is not None

    request = site_bootstrap._build_request(
        _SemanticMain,
        "/defensa-penal",
        "Defensa penal en Mexico",
        "provider-v1",
        tenant,
    )
    assert request.site_id == "cano-penal"
    assert request.canonical_origin == "https://canopenal.com"
    assert request.route == "/defensa-penal"
    assert request.input_hash == "a" * 64
    assert request.idempotency_key == request.input_hash
    assert request.source_revision.startswith("bootstrap-")


def test_sitemap_never_crosses_default_nexus_boundary(monkeypatch):
    _clear_tenant_env(monkeypatch)
    xml = b"""<?xml version='1.0' encoding='UTF-8'?>
    <urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>
      <url><loc>https://nexusbotstudio.com/</loc></url>
      <url><loc>https://nexusbotstudio.com/contacto</loc></url>
      <url><loc>https://www.nexusbotstudio.com/servicios</loc></url>
      <url><loc>https://cliente-ejemplo.com/no-tocar</loc></url>
      <url><loc>http://nexusbotstudio.com/inseguro</loc></url>
      <url><loc>https://nexusbotstudio.com/ruta?preview=1</loc></url>
    </urlset>
    """
    assert site_bootstrap._parse_sitemap_routes(xml) == ["/", "/contacto", "/servicios"]
