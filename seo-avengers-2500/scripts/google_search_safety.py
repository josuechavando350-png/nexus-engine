#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
import re
import sys
from typing import Iterable

POLICY_ID = "GOOGLE_SEARCH_STRICT_WHITE_HAT_V1"
POLICY_REVIEWED = "2026-09-14"
POLICY_REFERENCE = "https://developers.google.com/search/docs/essentials/spam-policies"

PYTHON_RUNTIME_ROOTS = (
    "seo-avengers-400/runtime",
    "seo-avengers-600/runtime",
    "seo-avengers-800/runtime",
    "seo-avengers-1000/runtime",
    "seo-avengers-2500/runtime",
)

BANNED_NETWORK_MODULES = {
    "requests",
    "httpx",
    "aiohttp",
    "urllib.request",
    "socket",
    "http.client",
    "selenium",
    "playwright",
    "pyppeteer",
}
BANNED_PROCESS_MODULES = {"subprocess"}
BANNED_CALLS = {
    "os.system",
    "os.popen",
    "subprocess.run",
    "subprocess.Popen",
    "subprocess.call",
    "subprocess.check_call",
    "subprocess.check_output",
}

# Direct consumer Search result pages are never an allowed automated data source.
# Google Maps embeds and authorized googleapis.com APIs are intentionally not matched.
DIRECT_GOOGLE_SEARCH_URL = re.compile(
    r"https?://(?:[^/\s@]+@)?(?:www\.)?google\.[a-z.]{2,}/search(?:[/?#]|$)",
    re.IGNORECASE,
)

EXECUTABLE_SUFFIXES = {".py", ".go", ".mjs", ".js", ".ts", ".tsx", ".sh"}
EXECUTABLE_TREES = (
    "seo-avengers-200/apps",
    "seo-avengers-200/packages",
    "seo-avengers-200/scripts",
    "seo-avengers-400/runtime",
    "seo-avengers-600/runtime",
    "seo-avengers-800/runtime",
    "seo-avengers-1000/runtime",
    "seo-avengers-2500/runtime",
    "seo-avengers-2500/sidecar",
)

# M001-M200 entries whose catalog semantics are policy-sensitive. Their source
# modes must remain fail-closed; the additional historical-name overrides are
# enforced in activation.go and exercised by the Go/E2E verifier.
REQUIRED_CATALOG_MODES = {
    19: "disabled-by-default",
    27: "eligibility-gated",
    30: "advisory-only",
    31: "experiment-safe",
    36: "real-rum-only",
    39: "consent-aware",
}
REQUIRED_OPERATOR_REVIEW_IDS = {18, 21, 23, 25, 50}
REQUIRED_COMPLIANCE_MODES = {
    "cloaking_signal_health",
    "link_scheme_signal_health",
    "paid_link_signal_health",
    "pbn_signal_health",
    "automated_external_link_signal_health",
    "google_scraping_signal_health",
    "automated_query_signal_health",
    "scaled_content_signal_health",
    "abusive_scraping_signal_health",
    "site_reputation_abuse_signal_health",
    "doorway_signal_health",
    "fake_review_signal_health",
    "fake_rating_signal_health",
    "fake_business_signal_health",
    "sneaky_redirect_signal_health",
    "low_value_generated_content_signal_health",
    "mass_location_page_signal_health",
    "mass_service_location_page_signal_health",
    "no_mutation_contract_health",
    "fail_closed_policy_evidence_health",
    "whitehat_compliance_composite",
    "terminal_readiness_health",
}


def _dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        left = _dotted_name(node.value)
        return f"{left}.{node.attr}" if left else node.attr
    return ""


def _forbidden_import(module: str, aliases: Iterable[ast.alias] = ()) -> str | None:
    if module in BANNED_NETWORK_MODULES or module in BANNED_PROCESS_MODULES:
        return module
    if module == "urllib" and any(alias.name == "request" for alias in aliases):
        return "urllib.request"
    if module == "http" and any(alias.name == "client" for alias in aliases):
        return "http.client"
    return None


def audit_python_runtime(path: Path) -> list[str]:
    errors: list[str] = []
    files = sorted(path.rglob("*.py"))
    if not files:
        return [f"runtime_missing:{path}"]
    for source in files:
        try:
            tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        except (OSError, SyntaxError) as exc:
            errors.append(f"runtime_unreadable:{source}:{type(exc).__name__}")
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    forbidden = _forbidden_import(alias.name)
                    if forbidden:
                        errors.append(f"direct_network_import:{source}:{node.lineno}:{forbidden}")
            elif isinstance(node, ast.ImportFrom) and node.module:
                forbidden = _forbidden_import(node.module, node.names)
                if forbidden:
                    errors.append(f"direct_network_import:{source}:{node.lineno}:{forbidden}")
            elif isinstance(node, ast.Call):
                call = _dotted_name(node.func)
                if call in BANNED_CALLS:
                    errors.append(f"process_escape:{source}:{node.lineno}:{call}")
    return errors


def _is_test_source(path: Path) -> bool:
    name = path.name
    return (
        "tests" in path.parts
        or name.startswith(("test_", "test-"))
        or "_test." in name
        or ".test." in name
    )


def audit_direct_google_search_urls(repo_root: Path) -> list[str]:
    errors: list[str] = []
    for relative in EXECUTABLE_TREES:
        root = repo_root / relative
        if not root.exists():
            errors.append(f"executable_tree_missing:{relative}")
            continue
        for path in sorted(p for p in root.rglob("*") if p.is_file() and p.suffix in EXECUTABLE_SUFFIXES):
            if _is_test_source(path):
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            for match in DIRECT_GOOGLE_SEARCH_URL.finditer(text):
                errors.append(f"direct_google_search_url:{path.relative_to(repo_root)}:{match.group(0)}")
    return errors


def audit_m200_catalog(repo_root: Path) -> list[str]:
    errors: list[str] = []
    catalog_path = repo_root / "seo-avengers-200/packages/Core-Go-Backend/module-catalog.json"
    try:
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [f"m200_catalog_unreadable:{type(exc).__name__}:{exc}"]
    if not isinstance(catalog, list) or len(catalog) != 200:
        return [f"m200_catalog_cardinality:{len(catalog) if isinstance(catalog, list) else 'not-list'}"]
    by_id = {item.get("id"): item for item in catalog if isinstance(item, dict)}
    if set(by_id) != set(range(1, 201)):
        errors.append("m200_catalog_ids_not_exact_1_200")
    for module_id, expected_mode in REQUIRED_CATALOG_MODES.items():
        item = by_id.get(module_id)
        if not isinstance(item, dict):
            errors.append(f"m200_sensitive_module_missing:M{module_id}")
            continue
        if item.get("mode") != expected_mode:
            errors.append(
                f"m200_sensitive_mode_drift:M{module_id}:{item.get('mode')}:{expected_mode}"
            )
    return errors


def audit_m200_activation_policy(repo_root: Path) -> list[str]:
    path = repo_root / "seo-avengers-200/packages/Core-Go-Backend/activation.go"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"activation_policy_unreadable:{type(exc).__name__}:{exc}"]
    errors: list[str] = []
    map_match = re.search(
        r"var\s+operatorReviewOverrides\s*=\s*map\[int\]string\s*\{(?P<body>.*?)\n\}",
        text,
        re.DOTALL,
    )
    if not map_match:
        return ["operator_review_override_map_missing"]
    ids = {int(value) for value in re.findall(r"(?m)^\s*(\d+)\s*:\s*\"", map_match.group("body"))}
    missing = sorted(REQUIRED_OPERATOR_REVIEW_IDS - ids)
    if missing:
        errors.append("operator_review_overrides_missing:" + ",".join(f"M{i}" for i in missing))
    required_fragments = (
        'effectiveMode = "advisory-only"',
        'state, reason = "ADVISORY", overrideReason',
        'case "disabled-by-default":',
        'case "eligibility-gated":',
        'case "advisory-only":',
        'case "experiment-safe":',
        'case "consent-aware":',
    )
    for fragment in required_fragments:
        if fragment not in text:
            errors.append(f"activation_fail_closed_fragment_missing:{fragment}")
    return errors


def audit_m200_outbound_boundary(repo_root: Path) -> list[str]:
    path = repo_root / "seo-avengers-200/apps/nexus-commander-dashboard/main.go"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"m200_commander_unreadable:{type(exc).__name__}:{exc}"]
    errors: list[str] = []
    request_count = text.count("http.NewRequestWithContext(")
    if request_count != 2:
        errors.append(f"m200_outbound_request_constructor_drift:{request_count}:2")
    forbidden = ("http.Get(", "http.Post(", "http.DefaultClient", "exec.Command(")
    for token in forbidden:
        if token in text:
            errors.append(f"m200_unreviewed_outbound_primitive:{token}")
    required = (
        'return s.semanticPOST(ctx, "/v1/semantic/jobs", params)',
        'return s.semanticGET(ctx, "/v1/semantic/jobs/"+p.JobID)',
        'strings.TrimRight(s.semanticURL, "/")+path',
    )
    for fragment in required:
        if fragment not in text:
            errors.append(f"m200_semantic_boundary_drift:{fragment}")
    return errors


def audit_m200_production_ingress(repo_root: Path) -> list[str]:
    package_root = repo_root / "seo-avengers-200/packages/Semantic-Python-NLP"
    paths = {
        "guard": package_root / "google_surface_policy.py",
        "entry": package_root / "render_neon_entry.py",
        "railway": package_root / "railway_entry.py",
        "render": package_root / "render_entry.py",
        "docker": package_root / "Dockerfile",
        "project": package_root / "pyproject.toml",
    }
    try:
        texts = {name: path.read_text(encoding="utf-8") for name, path in paths.items()}
    except OSError as exc:
        return [f"m200_production_ingress_unreadable:{type(exc).__name__}:{exc}"]

    errors: list[str] = []
    guard_required = (
        "def is_google_consumer_surface(value: str) -> bool:",
        'labels[0] == "google"',
        "def google_consumer_crawl_field(payload: Any) -> str | None:",
        'return "target_url"',
        'return f"competitor_urls[{index}]"',
    )
    for fragment in guard_required:
        if fragment not in texts["guard"]:
            errors.append(f"m200_google_guard_fragment_missing:{fragment}")

    entry_required = (
        "from google_surface_policy import google_consumer_crawl_field",
        'if request.url.path.startswith("/v1/"):',
        'if not expected:',
        "status_code=503",
        'if request.url.path == "/v1/semantic/jobs" and request.method == "POST":',
        "forbidden_field = google_consumer_crawl_field(payload)",
        "if forbidden_field is not None:",
        "status_code=403",
        "use an authorized provider/API contract",
    )
    for fragment in entry_required:
        if fragment not in texts["entry"]:
            errors.append(f"m200_production_ingress_fragment_missing:{fragment}")

    if "from render_neon_entry import app" not in texts["railway"]:
        errors.append("m200_railway_entry_bypasses_production_guard")
    if "from render_neon_entry import app" not in texts["render"]:
        errors.append("m200_render_entry_bypasses_production_guard")
    if "google_surface_policy.py" not in texts["docker"]:
        errors.append("m200_docker_missing_google_surface_policy")
    if 'CMD ["uvicorn", "railway_entry:app"' not in texts["docker"]:
        errors.append("m200_docker_bypasses_guarded_entry")
    if '"google_surface_policy"' not in texts["project"]:
        errors.append("m200_package_missing_google_surface_policy")
    return errors


def audit_compliance_kernel(repo_root: Path) -> list[str]:
    specs = repo_root / "seo-avengers-2500/runtime/specs_compliance.py"
    kernel = repo_root / "seo-avengers-2500/runtime/kernel_compliance.py"
    try:
        specs_text = specs.read_text(encoding="utf-8")
        kernel_text = kernel.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"compliance_kernel_unreadable:{type(exc).__name__}:{exc}"]
    errors: list[str] = []
    missing = sorted(mode for mode in REQUIRED_COMPLIANCE_MODES if f'"{mode}"' not in specs_text)
    if missing:
        errors.append("compliance_modes_missing:" + ",".join(missing))
    for fragment in (
        'EVIDENCE_CONTRACT = "EXISTING_NEXUS_RECORDS_ONLY"',
        'SEMANTIC = "STRICT_WHITE_HAT_POLICY_AND_PROVENANCE_OBSERVATION_ONLY"',
        '"observe_only": True',
        '"strict_white_hat_only": True',
        '"no_google_scraping": True',
    ):
        if fragment not in kernel_text:
            errors.append(f"compliance_invariant_missing:{fragment}")
    return errors


def audit_repository(repo_root: Path) -> dict[str, object]:
    root = repo_root.resolve()
    errors: list[str] = []
    checks: dict[str, str] = {}

    for relative in PYTHON_RUNTIME_ROOTS:
        runtime_errors = audit_python_runtime(root / relative)
        errors.extend(runtime_errors)
        checks[f"NO_DIRECT_NETWORK:{relative}"] = "PASS" if not runtime_errors else "FAIL"

    url_errors = audit_direct_google_search_urls(root)
    errors.extend(url_errors)
    checks["NO_DIRECT_GOOGLE_SEARCH_URLS"] = "PASS" if not url_errors else "FAIL"

    catalog_errors = audit_m200_catalog(root)
    errors.extend(catalog_errors)
    checks["M001_M200_CATALOG_POLICY"] = "PASS" if not catalog_errors else "FAIL"

    activation_errors = audit_m200_activation_policy(root)
    errors.extend(activation_errors)
    checks["M001_M200_ACTIVATION_POLICY"] = "PASS" if not activation_errors else "FAIL"

    boundary_errors = audit_m200_outbound_boundary(root)
    errors.extend(boundary_errors)
    checks["M001_M200_OUTBOUND_BOUNDARY"] = "PASS" if not boundary_errors else "FAIL"

    ingress_errors = audit_m200_production_ingress(root)
    errors.extend(ingress_errors)
    checks["M001_M200_PRODUCTION_GOOGLE_INGRESS"] = "PASS" if not ingress_errors else "FAIL"

    compliance_errors = audit_compliance_kernel(root)
    errors.extend(compliance_errors)
    checks["M2401_M2500_WHITEHAT_COMPLIANCE"] = "PASS" if not compliance_errors else "FAIL"

    return {
        "schema_version": 1,
        "policy_id": POLICY_ID,
        "policy_reviewed": POLICY_REVIEWED,
        "policy_reference": POLICY_REFERENCE,
        "status": "PASS" if not errors else "FAIL",
        "checks": checks,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fail-closed Google Search safety audit for SEO Avengers")
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    report = audit_repository(Path(args.repo_root))
    encoded = json.dumps(report, sort_keys=True, separators=(",", ":"))
    if args.output:
        Path(args.output).write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    if report["status"] != "PASS":
        for error in report["errors"]:
            print(f"GOOGLE_SEARCH_SAFETY_ERROR={error}", file=sys.stderr)
        return 2
    print("GOOGLE_SEARCH_SAFETY=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
