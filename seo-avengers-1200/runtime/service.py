from __future__ import annotations

from typing import Any, Dict

from .legacy_bridge import bridge_semantic200_module_evidence
from .seo_avengers_1200 import SeoAvengers1200Runtime


def execute_avengers_1200(payload: Any, config: Any) -> Dict[str, Any]:
    """Execute the extended runtime with a verified legacy-evidence bridge.

    The bridge is only evaluated when the extension is explicitly enabled. It
    converts real SEO Avengers 200 semantic `module_evidence` records into normal
    receipts after independently reproducing their existing hash contract.
    """
    runtime = SeoAvengers1200Runtime()
    if not isinstance(config, dict) or config.get("CONFIG_SEO_AVENGERS_1200") is not True:
        return runtime.execute(payload, config)
    if not isinstance(payload, dict):
        return runtime.execute(payload, config)

    effective_payload = dict(payload)
    legacy_value = effective_payload.pop("seo_avengers_200_module_evidence", None)
    legacy_rows, bridge_summary = bridge_semantic200_module_evidence(legacy_value)

    upstream = effective_payload.get("upstream_evidence", [])
    if isinstance(upstream, list):
        merged_upstream = list(upstream)
    elif upstream is None:
        merged_upstream = []
    else:
        # Preserve malformed upstream input as an invalid row so M1101 sees it.
        merged_upstream = [upstream]
    merged_upstream.extend(legacy_rows)
    effective_payload["upstream_evidence"] = merged_upstream

    result = runtime.execute(effective_payload, config)
    result["legacy_evidence_bridge"] = bridge_summary
    return result
