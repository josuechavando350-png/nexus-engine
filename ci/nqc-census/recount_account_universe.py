#!/usr/bin/env python3
"""Independent recount of an RMC-009 closeout (shares no code with Rust).

Re-sums every indexed scaled balance per token from the account manifest and
requires it to equal both the recorded indexed sum and the token's
scaledTotalSupply; recounts the account classifications against the metrics;
re-hashes every artifact against the evidence manifest.
"""

import collections
import hashlib
import json
import os
import sys


def rows(root, name):
    with open(os.path.join(root, name)) as handle:
        return [json.loads(line) for line in handle if line.strip()]


def main():
    root = sys.argv[1]
    accounts = rows(root, "account-manifest.jsonl")
    conservation = rows(root, "token-conservation.jsonl")
    mismatches = rows(root, "mismatch-ledger.jsonl")
    metrics = json.load(open(os.path.join(root, "account-metrics.json")))
    summary = json.load(open(os.path.join(root, "account-summary.json")))
    evidence = json.load(open(os.path.join(root, "evidence-manifest.json")))

    assert summary["status"] == "RMC_009_PASS_CANDIDATE", summary["status"]
    assert not summary["blocking_findings"], summary["blocking_findings"]
    assert all(m["classification"] != "UNEXPLAINED" for m in mismatches), "unexplained mismatch"

    sums = collections.Counter()
    holders = collections.Counter()
    for account in accounts:
        for position in account["supply_positions"] + account["debt_positions"]:
            sums[position["token"]] += int(position["scaled"])
            holders[position["token"]] += 1
    for row in conservation:
        assert row["status"] == "CONSERVED", row
        total = int(row["scaled_total_supply"])
        assert int(row["indexed_scaled_sum"]) == sums[row["token"]] == total, row
        assert row["holders"] == holders[row["token"]], row

    classes = collections.Counter(account["classification"] for account in accounts)
    borrowers = sum(1 for account in accounts if account["debt_positions"])
    assert metrics["indexed_accounts"] == len(accounts)
    assert metrics["state_verified_accounts"] == len(accounts)
    assert metrics["position_holders"] == classes["POSITION_HOLDER"]
    assert metrics["extra_accounts"] == classes["NO_POSITION_AT_ANCHOR"]
    assert metrics["actionable_accounts"] == borrowers
    assert metrics["missing_holder_tokens"] == 0
    assert metrics["mismatched_accounts"] == 0
    assert metrics["conserved_tokens"] == metrics["tokens"] == len(conservation)

    for artifact in evidence["artifacts"]:
        data = open(os.path.join(root, artifact["path"]), "rb").read()
        assert hashlib.sha256(data).hexdigest() == artifact["sha256"], artifact["path"]

    print(f"RMC009_INDEPENDENT_RECOUNT_PASS accounts={len(accounts)} tokens={len(conservation)} "
          f"holders={classes['POSITION_HOLDER']} extra={classes['NO_POSITION_AT_ANCHOR']} "
          f"actionable={borrowers}")


if __name__ == "__main__":
    main()
