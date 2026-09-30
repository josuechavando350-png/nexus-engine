#!/usr/bin/env python3
"""Independent recount of an RMC-009 closeout (shares no code with Rust).

Re-sums every indexed scaled balance per token from the account manifest,
requires it to equal the recorded indexed sum, and requires it plus the zero
address's scaled balance to equal the token's scaledTotalSupply; requires the
zero address never to be an account and every zero-address index log recorded
in provenance to name a census token; recounts the account classifications
against the metrics; re-hashes every artifact against the evidence manifest.
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
    # Integrity first: no artifact content is used before its digest matches.
    evidence = json.load(open(os.path.join(root, "evidence-manifest.json")))
    for artifact in evidence["artifacts"]:
        data = open(os.path.join(root, artifact["path"]), "rb").read()
        assert hashlib.sha256(data).hexdigest() == artifact["sha256"], artifact["path"]

    accounts = rows(root, "account-manifest.jsonl")
    conservation = rows(root, "token-conservation.jsonl")
    mismatches = rows(root, "mismatch-ledger.jsonl")
    metrics = json.load(open(os.path.join(root, "account-metrics.json")))
    summary = json.load(open(os.path.join(root, "account-summary.json")))
    provenance = json.load(open(os.path.join(root, "acquisition-provenance.json")))

    assert summary["status"] == "RMC_009_PASS_CANDIDATE", summary["status"]
    assert not summary["blocking_findings"], summary["blocking_findings"]
    assert all(m["classification"] != "UNEXPLAINED" for m in mismatches), "unexplained mismatch"

    sums = collections.Counter()
    holders = collections.Counter()
    for account in accounts:
        for position in account["supply_positions"] + account["debt_positions"]:
            sums[position["token"]] += int(position["scaled"])
            holders[position["token"]] += 1
    zero_holding = 0
    for row in conservation:
        assert row["status"] == "CONSERVED", row
        total = int(row["scaled_total_supply"])
        zero = int(row["zero_address_scaled_balance"])
        # The zero address is never an account, and it is always a supply term.
        assert int(row["indexed_scaled_sum"]) == sums[row["token"]], row
        assert sums[row["token"]] + zero == total, row
        assert row["holders"] == holders[row["token"]], row
        zero_holding += zero != 0
    assert all(account["account"] != "0x" + "0" * 40 for account in accounts), "zero address as account"
    assert metrics["zero_address_holding_tokens"] == zero_holding
    # The index logs naming the zero address (history, so provenance: a full
    # census holds them all, an incremental refresh its delta's).
    acquisition = provenance["acquisition"]
    index = acquisition["index"] if acquisition["mode"] == "FULL_CENSUS" else acquisition["delta_index"]
    refs = index["zero_account_log_refs"]
    assert len(refs) == index["zero_account_logs"], "zero-address log refs"
    assert len({(ref["block"], ref["log_index"]) for ref in refs}) == len(refs), "duplicate zero-address log"
    census_tokens = {row["token"] for row in conservation}
    assert all(ref["token"] in census_tokens for ref in refs), "zero-address log of a non-census token"

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

    print(f"RMC009_INDEPENDENT_RECOUNT_PASS accounts={len(accounts)} tokens={len(conservation)} "
          f"holders={classes['POSITION_HOLDER']} extra={classes['NO_POSITION_AT_ANCHOR']} "
          f"actionable={borrowers} zero_address_logs={len(refs)} zero_address_holding_tokens={zero_holding}")


if __name__ == "__main__":
    main()
