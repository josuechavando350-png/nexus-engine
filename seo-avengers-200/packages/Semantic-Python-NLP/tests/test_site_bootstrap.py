from __future__ import annotations

import site_bootstrap


def test_bootstrap_requires_exact_nexus_publisher_and_secrets(monkeypatch):
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


def test_sitemap_never_crosses_tenant_boundary():
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
