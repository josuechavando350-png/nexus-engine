from __future__ import annotations

from pathlib import Path
import unittest

REPO_ROOT = Path(__file__).resolve().parents[2]
EDGE_SOURCES = (
    REPO_ROOT / "seo-avengers-200/apps/edge-cloudflare-worker/src/lib.rs",
    REPO_ROOT / "seo-avengers-200/apps/edge-cloudflare-gateway/src/index.ts",
    REPO_ROOT / "seo-avengers-200/apps/seo-avengers-reverse-proxy/src/index.ts",
)

CRAWLER_IDENTITY_TOKENS = (
    "googlebot",
    "bingbot",
    "duckduckbot",
    "yandexbot",
    "baiduspider",
    'headers.get("user-agent")',
    "headers.get('user-agent')",
    'headers().get("user-agent")',
    "headers().get('user-agent')",
)
REDIRECT_CONSTRUCTORS = (
    "response.redirect(",
    "response::redirect(",
    "redirectresponse(",
)


def scan_edge_source(text: str) -> list[str]:
    folded = text.casefold()
    violations = [f"crawler_identity:{token}" for token in CRAWLER_IDENTITY_TOKENS if token in folded]
    violations.extend(
        f"edge_redirect_constructor:{token}" for token in REDIRECT_CONSTRUCTORS if token in folded
    )
    return violations


class EdgeWhiteHatDeliveryTests(unittest.TestCase):
    def test_edge_delivery_has_no_crawler_identity_or_local_redirect_branch(self) -> None:
        for path in EDGE_SOURCES:
            with self.subTest(path=path.relative_to(REPO_ROOT)):
                text = path.read_text(encoding="utf-8")
                self.assertEqual(scan_edge_source(text), [])

    def test_native_gateway_variation_is_network_hint_only(self) -> None:
        path = REPO_ROOT / "seo-avengers-200/apps/edge-cloudflare-gateway/src/index.ts"
        text = path.read_text(encoding="utf-8")
        self.assertIn('request.headers.get("save-data")', text)
        self.assertIn('request.headers.get("ect")', text)
        self.assertNotIn('request.headers.get("user-agent")', text.casefold())

    def test_external_proxy_variation_is_network_hint_only(self) -> None:
        path = REPO_ROOT / "seo-avengers-200/apps/seo-avengers-reverse-proxy/src/index.ts"
        text = path.read_text(encoding="utf-8")
        self.assertIn('request.headers.get("save-data")', text)
        self.assertIn('request.headers.get("ect")', text)
        self.assertNotIn('request.headers.get("user-agent")', text.casefold())

    def test_scanner_rejects_googlebot_cloaking_and_edge_redirect(self) -> None:
        malicious = '''
const ua = request.headers.get("user-agent") || "";
if (ua.includes("Googlebot")) return Response.redirect("https://example.test/seo-only", 302);
'''
        violations = scan_edge_source(malicious)
        self.assertTrue(any(item.startswith("crawler_identity:") for item in violations), violations)
        self.assertTrue(any(item.startswith("edge_redirect_constructor:") for item in violations), violations)


if __name__ == "__main__":
    unittest.main()
