from __future__ import annotations

from typing import Any, Dict

from runtime.manifest import MODULE_SPECS
from edge_fixture import EDGE_ROWS
from html_fixture import HTML_ROWS
from relational_fixture import RELATIONAL_ROWS, terminal_row
from semantic_fixture import SEMANTIC_ROWS


def full_payload() -> Dict[str, Any]:
    relational = [dict(RELATIONAL_ROWS[module_id]) for module_id in RELATIONAL_ROWS]
    relational.append(terminal_row(MODULE_SPECS))
    return {
        "semantic_nlp_records": [dict(SEMANTIC_ROWS[module_id]) for module_id in SEMANTIC_ROWS],
        "html_stream_records": [dict(HTML_ROWS[module_id]) for module_id in HTML_ROWS],
        "edge_perimeter_records": [dict(EDGE_ROWS[module_id]) for module_id in EDGE_ROWS],
        "relational_evidence_records": relational,
    }
