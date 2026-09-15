from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "google_search_safety.py"
SPEC = importlib.util.spec_from_file_location("google_search_safety", MODULE_PATH)
assert SPEC and SPEC.loader
safety = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(safety)

REPO_ROOT = Path(__file__).resolve().parents[2]


class GoogleSearchSafetyTests(unittest.TestCase):
    def test_repository_satisfies_strict_white_hat_boundary(self) -> None:
        report = safety.audit_repository(REPO_ROOT)
        self.assertEqual(report["status"], "PASS", report)
        self.assertEqual(report["errors"], [], report)
        self.assertTrue(report["checks"])
        self.assertTrue(all(value == "PASS" for value in report["checks"].values()), report)

    def test_python_runtime_direct_network_import_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            runtime.mkdir()
            (runtime / "bad.py").write_text("import requests\n", encoding="utf-8")
            errors = safety.audit_python_runtime(runtime)
        self.assertTrue(any("direct_network_import" in error and "requests" in error for error in errors), errors)

    def test_python_runtime_process_escape_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            runtime.mkdir()
            (runtime / "bad.py").write_text(
                "import os\nos.system('curl https://www.google.com/search?q=x')\n",
                encoding="utf-8",
            )
            errors = safety.audit_python_runtime(runtime)
        self.assertTrue(any("process_escape" in error and "os.system" in error for error in errors), errors)

    def test_direct_google_search_result_url_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "src"
            source.mkdir()
            (source / "runtime.py").write_text(
                'URL = "https://www.google.com/search?q=rank-check"\n', encoding="utf-8"
            )
            with mock.patch.object(safety, "EXECUTABLE_TREES", ("src",)):
                errors = safety.audit_direct_google_search_urls(root)
        self.assertTrue(any("direct_google_search_url" in error for error in errors), errors)

    def test_maps_and_authorized_googleapis_are_not_search_scraping(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "src"
            source.mkdir()
            (source / "runtime.py").write_text(
                '\n'.join(
                    (
                        'MAP = "https://www.google.com/maps?q=Mexico&output=embed"',
                        'SC = "https://www.googleapis.com/webmasters/v3/sites/x/searchAnalytics/query"',
                        'INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"',
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            with mock.patch.object(safety, "EXECUTABLE_TREES", ("src",)):
                errors = safety.audit_direct_google_search_urls(root)
        self.assertEqual(errors, [])

    def test_sensitive_catalog_mode_drift_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            catalog_path = root / "seo-avengers-200/packages/Core-Go-Backend/module-catalog.json"
            catalog_path.parent.mkdir(parents=True)
            catalog = [{"id": number, "mode": "compliant"} for number in range(1, 201)]
            for module_id, expected_mode in safety.REQUIRED_CATALOG_MODES.items():
                catalog[module_id - 1]["mode"] = expected_mode
            catalog[18]["mode"] = "compliant"
            catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
            errors = safety.audit_m200_catalog(root)
        self.assertTrue(any("m200_sensitive_mode_drift:M19" in error for error in errors), errors)

    def test_missing_operator_override_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "seo-avengers-200/packages/Core-Go-Backend/activation.go"
            path.parent.mkdir(parents=True)
            path.write_text(
                '''package core
var operatorReviewOverrides = map[int]string{
    18: "review",
    21: "review",
    25: "review",
    50: "review",
}
func policy() {
    effectiveMode = "advisory-only"
    state, reason = "ADVISORY", overrideReason
    switch module.Mode {
    case "disabled-by-default":
    case "eligibility-gated":
    case "advisory-only":
    case "experiment-safe":
    case "consent-aware":
    }
}
''',
                encoding="utf-8",
            )
            errors = safety.audit_m200_activation_policy(root)
        self.assertTrue(any("operator_review_overrides_missing:M23" in error for error in errors), errors)

    def test_removed_production_google_ingress_guard_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "seo-avengers-200/packages/Semantic-Python-NLP"
            package.mkdir(parents=True)
            (package / "google_surface_policy.py").write_text(
                '''from typing import Any
def is_google_consumer_surface(value: str) -> bool:
    labels = ["google", "com"]
    return labels[0] == "google"
def google_consumer_crawl_field(payload: Any) -> str | None:
    index = 0
    if payload:
        return "target_url"
    return f"competitor_urls[{index}]"
''',
                encoding="utf-8",
            )
            (package / "render_neon_entry.py").write_text(
                '''from google_surface_policy import google_consumer_crawl_field
if request.url.path.startswith("/v1/"):
    if not expected:
        status_code=503
# Deliberately missing /v1/semantic/jobs guard and helper invocation.
''',
                encoding="utf-8",
            )
            (package / "railway_entry.py").write_text(
                "from render_neon_entry import app\n", encoding="utf-8"
            )
            (package / "render_entry.py").write_text(
                "from render_neon_entry import app\n", encoding="utf-8"
            )
            (package / "Dockerfile").write_text(
                'COPY google_surface_policy.py ./\nCMD ["uvicorn", "railway_entry:app", "--host", "0.0.0.0"]\n',
                encoding="utf-8",
            )
            (package / "pyproject.toml").write_text(
                'py-modules = ["google_surface_policy"]\n', encoding="utf-8"
            )
            errors = safety.audit_m200_production_ingress(root)
        self.assertTrue(
            any("m200_production_ingress_fragment_missing" in error for error in errors), errors
        )

    def test_missing_compliance_control_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "seo-avengers-2500/runtime"
            runtime.mkdir(parents=True)
            (runtime / "specs_compliance.py").write_text(
                '_MODES = ("google_scraping_signal_health",)\n', encoding="utf-8"
            )
            (runtime / "kernel_compliance.py").write_text(
                '\n'.join(
                    (
                        'EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"',
                        'SEMANTIC = "STRICT_WHITE_HAT_POLICY_AND_PROVENANCE_OBSERVATION_ONLY"',
                        'OUTPUT = {"observe_only": True, "strict_white_hat_only": True, "no_google_scraping": True}',
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            errors = safety.audit_compliance_kernel(root)
        self.assertTrue(any("compliance_modes_missing" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
