import pytest

import google_surface_policy as google_policy
import main


@pytest.mark.asyncio
async def test_section_vector_persists_in_isolated_table(tmp_path, monkeypatch):
    store = main.SeoVectorStore(str(tmp_path / "nexus.sqlite3"))
    await store.initialize()
    monkeypatch.setattr(main, "vector_store", store)

    async def fake_entities(_text: str):
        return [
            main.RawEntity("Nexus Bot Studio", 0.72, "ORGANIZATION", {}),
            main.RawEntity("Artificial intelligence", 0.28, "OTHER", {"wikipedia_url": "https://en.wikipedia.org/wiki/Artificial_intelligence"}),
        ]

    async def no_publish(_snapshot):
        return False

    monkeypatch.setattr(main, "analyze_entities", fake_entities)
    monkeypatch.setattr(main, "publish_edge_snapshot", no_publish)
    digest = "sha256:" + "a" * 64
    request = main.SectionVectorRequest(
        authority="NEXUS_SEO_AVENGERS_200_SECTION_V1",
        schema_version=2,
        site_id="nexus-bot-studio",
        route="/",
        section_id="hero",
        locale="es-MX",
        canonical_origin="https://nexusbotstudio.com",
        text="Nexus Bot Studio desarrolla agentes de inteligencia artificial.",
        keyword="agentes de IA",
        source_revision="abcdef1234567",
        input_hash=digest,
        idempotency_key=digest,
    )
    result = await main.run_section_analysis(request)
    saved = await store.get("nexus-bot-studio", "/", "hero")
    snapshot = await store.route_snapshot("nexus-bot-studio", "/")

    assert result.output_hash.startswith("sha256:")
    assert saved is not None
    assert saved["input_hash"] == digest
    assert saved["json_ld"]["@id"] == "https://nexusbotstudio.com/#hero"
    assert snapshot["version"] == 1
    assert "hero" in snapshot["sections"]
    assert snapshot["suite"] == "SEO_AVENGERS_200"
    assert snapshot["module_count"] == 200
    assert len(saved["module_evidence"]) == 58
    assert saved["vector_profile"]["model"] == "nexus-feature-hash-v1"


def test_google_consumer_surfaces_are_denied_but_authorized_api_hosts_are_not():
    assert google_policy.is_google_consumer_surface("https://www.google.com/search?q=rank")
    assert google_policy.is_google_consumer_surface("https://google.com.mx/maps?q=business")
    assert google_policy.is_google_consumer_surface("https://www.google.co.uk/webhp?q=rank")

    assert not google_policy.is_google_consumer_surface(
        "https://www.googleapis.com/webmasters/v3/sites/example/searchAnalytics/query"
    )
    assert not google_policy.is_google_consumer_surface(
        "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
    )
    assert not google_policy.is_google_consumer_surface(
        "https://developers.google.com/search/docs/essentials/spam-policies"
    )


def test_google_consumer_crawl_field_identifies_target_and_competitor_inputs():
    assert google_policy.google_consumer_crawl_field(
        {"target_url": "https://www.google.com/search?q=rank", "competitor_urls": []}
    ) == "target_url"
    assert google_policy.google_consumer_crawl_field(
        {
            "target_url": "https://example.com/",
            "competitor_urls": ["https://competitor.example/", "https://google.com.mx/search?q=x"],
        }
    ) == "competitor_urls[1]"
    assert google_policy.google_consumer_crawl_field(
        {
            "target_url": "https://example.com/",
            "competitor_urls": ["https://another.example/"],
        }
    ) is None
