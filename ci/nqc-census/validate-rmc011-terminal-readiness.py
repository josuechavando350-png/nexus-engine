#!/usr/bin/env python3
import json
from pathlib import Path

p=Path("ci/nqc-census/rmc011-capital-source-universe.json")
data=json.loads(p.read_text())
assert data["schema_version"]==1
assert data["stage"]=="RMC-011"
families=data["families"]
assert families and len({x["id"] for x in families})==len(families)
allowed={"SEMANTIC_ADMISSION_IMPLEMENTED","SEMANTIC_ADMISSION_READY_NOT_AUTHENTICATED","MODEL_ONLY","EXHAUSTIVELY_REJECTED","AUTHENTICATED_REAL_SOURCE"}
for row in families:
    assert row["status"] in allowed, row
    assert isinstance(row["terminally_resolved"], bool)
    if row["terminally_resolved"]:
        assert row["status"] in {"AUTHENTICATED_REAL_SOURCE","EXHAUSTIVELY_REJECTED"}, row
unknown=sum(1 for x in families if x["status"]=="UNKNOWN")
assert unknown==data["unknown_family_count"]==0
all_resolved=all(x["terminally_resolved"] for x in families)
if data["terminal_claim_allowed"]:
    assert all_resolved
    assert data["status"]=="D11_TERMINAL_CLOSED"
else:
    assert data["status"]!="D11_TERMINAL_CLOSED"
scope=json.loads(Path("ci/nqc-census/capital-census-scope.json").read_text())
required=set(scope["required_classes"])
covered={x["capital_class"] for x in families}
assert required <= covered, sorted(required-covered)
print(json.dumps({
    "RMC011_SOURCE_UNIVERSE_CONTRACT":"PASS",
    "families":len(families),
    "resolved":sum(1 for x in families if x["terminally_resolved"]),
    "unresolved":sum(1 for x in families if not x["terminally_resolved"]),
    "terminal_claim_allowed":data["terminal_claim_allowed"]
}, sort_keys=True))
