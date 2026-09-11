from __future__ import annotations

import site_bootstrap


def _clear_tenant_override(monkeypatch):
    monkeypatch.delenv("NEXUS_SEO_BOOTSTRAP_SITE_ID", raising=False)
    monkeypatch.delenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", raising=False)


def test_bootstrap_requires_matching_publisher_and_secrets(monkeypatch):
    _clear_tenant_override(monkeypatch)
    monkeypatch.delenv("NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL", raising=False)
    monkeypatch.delenv("NEXUS_SEO_EDGE_PUBLISH_TOKEN", raising=False)
    monkeypatch.delenv("SEMANTIC_SHARED_SECRET", raising=False)
    assert site_bootstrap.bootstrap_is_authorized_by_deployment() is False

    monkeypatch.setenv(
        "NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL",
        "https://nexusbotstudio.com/__nexus/seo-vector",
    )
    monkeypatch.setenv("NEXUS_SEO_EDGE_PUBLISH_TOKEN", "edge-secret")
    monkeypatch.setenv("SEMANTIC_SHARED_SECRET", "semantic-secret")
    assert site_bootstrap.bootstrap_is_authorized_by_deployment() is True

    monkeypatch.setenv(
        "NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL",
        "https://cliente-ejemplo.com/__nexus/seo-vector",
    )
    assert site_bootstrap.bootstrap_is_authorized_by_deployment() is False


def test_cano_tenant_requires_matching_cano_publisher(monkeypatch):
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_SITE_ID", "cano-penal")
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", "https://canopenal.com")
    monkeypatch.setenv("NEXUS_SEO_EDGE_PUBLISH_TOKEN", "edge-secret")
    monkeypatch.setenv(
        "NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL",
        "https://canopenal.com/__nexus/seo-vector",
    )

    tenant = site_bootstrap.load_bootstrap_tenant()
    assert tenant is not None
    assert tenant.site_id == "cano-penal"
    assert tenant.origin == "https://canopenal.com"
    assert site_bootstrap.bootstrap_is_authorized_by_deployment(tenant) is True

    monkeypatch.setenv(
        "NEXUS_SEO_VECTOR_EDGE_PUBLISH_URL",
        "https://nexusbotstudio.com/__nexus/seo-vector",
    )
    assert site_bootstrap.bootstrap_is_authorized_by_deployment(tenant) is False


def test_partial_or_invalid_tenant_override_fails_closed(monkeypatch):
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_SITE_ID", "cano-penal")
    monkeypatch.delenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", raising=False)
    assert site_bootstrap.load_bootstrap_tenant() is None
    assert site_bootstrap.bootstrap_is_authorized_by_deployment() is False

    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", "http://canopenal.com")
    assert site_bootstrap.load_bootstrap_tenant() is None


def test_sitemap_never_crosses_default_tenant_boundary(monkeypatch):
    _clear_tenant_override(monkeypatch)
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
    assert site_bootstrap._parse_sitemap_routes(xml) == [
        "/",
        "/contacto",
        "/servicios",
    ]


def test_cano_sitemap_never_crosses_tenant_boundary(monkeypatch):
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_SITE_ID", "cano-penal")
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", "https://canopenal.com")
    tenant = site_bootstrap.load_bootstrap_tenant()
    assert tenant is not None

    xml = b"""<?xml version='1.0' encoding='UTF-8'?>
    <urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>
      <url><loc>https://canopenal.com/</loc></url>
      <url><loc>https://canopenal.com/defensa-penal</loc></url>
      <url><loc>https://www.canopenal.com/contacto</loc></url>
      <url><loc>https://nexusbotstudio.com/no-tocar</loc></url>
    </urlset>
    """
    assert site_bootstrap._parse_sitemap_routes(xml, tenant) == [
        "/",
        "/contacto",
        "/defensa-penal",
    ]


def test_request_is_scoped_to_cano_tenant(monkeypatch):
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_SITE_ID", "cano-penal")
    monkeypatch.setenv("NEXUS_SEO_BOOTSTRAP_ORIGIN", "https://canopenal.com")
    tenant = site_bootstrap.load_bootstrap_tenant()
    assert tenant is not None

    class SemanticStub:
        @staticmethod
        def canonical_hash(core):
            assert core["site_id"] == "cano-penal"
            assert core["canonical_origin"] == "https://canopenal.com"
            return "a" * 64

        @staticmethod
        def SectionVectorRequest(**kwargs):
            return kwargs

    request = site_bootstrap._build_request(
        SemanticStub,
        "/defensa-penal",
        "Defensa penal",
        "provider-test",
        tenant,
    )
    assert request["site_id"] == "cano-penal"
    assert request["canonical_origin"] == "https://canopenal.com"
    assert request["route"] == "/defensa-penal"
