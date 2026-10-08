#!/usr/bin/env python3
"""Read-only search for the EXACT original D16 127-transaction economics bytes.

Searches a bounded, declared selection of *already-existing* GitHub Actions
archives. SHA-256 byte equality is mandatory. A failure to locate a source
inside a bounded sample is NOT evidence it never existed. This tool does not
do Ethereum RPC, access wallets, infer P&L, or close Real Market Census.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

REPOSITORY = "josuechavando350-png/nexus-engine"
D16_SOURCE_GIT_BLOB = "5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa"
ORIGINAL_LEDGER_SHA256 = "55d5d6be9e09f2e499e1ca8949c4305d05824dffa61e363f4371c615537dcb1c"
MAX_ZIP_BYTES = 3_000_000
MAX_ENTRY_BYTES = 4_000_000
MAX_MEMBERS = 150
MAX_SELECTED = 48
EXPECTED_WINNERS = 127
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
SHA256_META = re.compile(r"sha256:([0-9a-f]{64})\Z")
POTENTIAL = re.compile(r"rmc[-_ ]?0(?:15|16)|winner|econom|transaction|liquidation|ledger|census[-_ ]?capacity", re.I)


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=True) + "\n").encode("ascii")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def gitblob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def exact_json(raw):
    def no_duplicate(pairs):
        output = {}
        for key, value in pairs:
            need(key not in output, "duplicate JSON field")
            output[key] = value
        return output
    obj = json.loads(raw, object_pairs_hook=no_duplicate)
    need(type(obj) is dict, "root must be an object")
    return obj


def verify_source(raw):
    need(0 < len(raw) < 10_000 and gitblob(raw) == D16_SOURCE_GIT_BLOB,
         "original D16 economic authority Git blob changed or absent")
    e = exact_json(raw)
    a = e.get("authority")
    need(type(a) is dict and
         e.get("status") == "RMC016_CONSERVATIVE_REALIZABLE_CAPACITY_PASS" and
         a.get("status") == e["status"] and
         a.get("transaction_economics_sha256") == ORIGINAL_LEDGER_SHA256 and
         a.get("definite_transaction_count") == EXPECTED_WINNERS and
         type(a.get("definite_transaction_count")) is int and
         a.get("definite_episode_count") == 139 and
         type(a.get("definite_episode_count")) is int and
         a.get("nqc_capture_probability_lower_bound_wad") == "0" and
         a.get("nqc_conservative_realizable_monthly_capacity_usd_wad") == "0" and
         "NO_NQC_REALIZED_PNL" in a.get("non_claims", []) and
         a.get("zero_own_capital_not_overridden") is True,
         "source D16 economic scope/certification contract drifted")
    return a


def artifact_row(row):
    need(type(row) is dict, "invalid GitHub Actions metadata")
    id_ = row.get("id")
    rid = row.get("run_id")
    sz = row.get("size_in_bytes")
    name = row.get("name")
    expired = row.get("expired")
    digest = row.get("digest")
    head = row.get("head_sha")
    need(type(id_) is int and id_ > 0 and
         type(rid) is int and rid > 0 and
         type(sz) is int and sz >= 0 and
         type(name) is str and 0 < len(name) < 300 and
         type(expired) is bool and
         (digest is None or
          (type(digest) is str and SHA256_META.fullmatch(digest))) and
         type(head) is str and HEX64.fullmatch(head),
         "malformed or unauthenticated artifact inventory row")
    return {
        "id": id_, "run_id": rid, "name": name, "size_in_bytes": sz,
        "expired": expired, "digest": digest, "head_sha": head,
    }


def load_index(raw):
    need(type(raw) is bytes and 0 < len(raw) < 4_000_000
         and raw.endswith(b"\n"), "missing or oversized Actions metadata index")
    rows = []
    seen = set()
    for line in raw.splitlines():
        item = artifact_row(exact_json(line))
        need(item["id"] not in seen, "duplicated artifact ID in index")
        seen.add(item["id"])
        rows.append(item)
    need(len(rows) > 0, "empty Actions inventory is not zero evidence")
    return rows


def score(item):
    name = item["name"].lower()
    pts = 0
    if any(s in name for s in ("transaction-economics", "winner-net", "winner-econom",
                             "original-ledger", "transaction-ledger")):
        pts += 500
    if "rmc016" in name or "rmc-016" in name:
        pts += 120
    if "winner" in name or "economic" in name or "ledger" in name:
        pts += 70
    if "rmc015" in name or "rmc-015" in name:
        pts += 15
    if item["id"] in (11505504820, 11504276505):
        pts += 350
    return pts


def select(index, limit=MAX_SELECTED):
    need(type(index) is list and
         type(limit) is int and 1 <= limit <= MAX_SELECTED,
         "invalid source indexing/scan budget")
    all_rows = [artifact_row(row) for row in index]
    need(len({r["id"] for r in all_rows}) == len(all_rows),
         "duplicate artifact identity")
    potential = [x for x in all_rows if POTENTIAL.search(x["name"])]
    eligible = [x for x in potential if not x["expired"] and
                x["digest"] is not None and 0 < x["size_in_bytes"] <= MAX_ZIP_BYTES]
    ranked = sorted(eligible, key=lambda x: (-score(x), x["id"]))
    selected = ranked[:limit]
    out = {
        "schema_version": 1,
        "status": "RMC016_EXISTING_ACTIONS_LEDGER_RECOVERY_BOUNDED_SELECTION",
        "source_repository": REPOSITORY,
        "original_d16_git_blob_sha1": D16_SOURCE_GIT_BLOB,
        "original_transaction_economics_sha256": ORIGINAL_LEDGER_SHA256,
        "total_indexed_artifacts": len(all_rows),
        "name_matched_artifacts": len(potential),
        "eligible_unexpired_small_archives": len(eligible),
        "excluded_expired_or_unverifiable_or_oversized": len(potential) - len(eligible),
        "eligible_not_selected_due_to_scan_budget": len(eligible) - len(selected),
        "max_artifact_zip_bytes": MAX_ZIP_BYTES,
        "scan_budget": limit,
        "selected": selected,
        "unscanned_global_repo_artifacts_may_contain_source": True,
        "all_artifacts_recovered_and_scanned": False,
        "no_global_absence_claim": True,
        "real_market_census_closed": False,
    }
    out["report_sha256"] = sha256(canonical(out))
    return out


def scan_zip(raw, expected_outer, expected_member=ORIGINAL_LEDGER_SHA256):
    need(type(raw) is bytes and 0 < len(raw) <= MAX_ZIP_BYTES,
         "archive ZIP missing or exceeds safety cap")
    need(type(expected_outer) is str and HEX64.fullmatch(expected_outer)
         and sha256(raw) == expected_outer,
         "GitHub archive outer SHA256 not authenticated")
    matches = []
    with zipfile.ZipFile(io.BytesIO(raw)) as zip_:
        members = zip_.infolist()
        names = [m.filename for m in members]
        need(0 < len(names) <= MAX_MEMBERS and len(names) == len(set(names)),
             "archive duplicate entries or excessive member count")
        for member in members:
            path = member.filename
            need(not member.is_dir() and
                 len(path) < 300 and
                 not path.startswith("/") and
                 ".." not in Path(path).parts and
                 "\\" not in path and
                 member.file_size <= MAX_ENTRY_BYTES and
                 ((member.external_attr >> 16) & 0o170000) != 0o120000,
                 "unsafe or oversized artifact archive member")
            if path.lower().endswith(".jsonl") or "transaction-economics" in path.lower():
                blob = zip_.read(member)
                need(len(blob) == member.file_size,
                     "ZIP member raw size inconsistent")
                if sha256(blob) == expected_member:
                    matches.append({
                        "archive_member": path,
                        "original_ledger_sha256": sha256(blob),
                        "raw_bytes": len(blob),
                    })
    return matches


def scan(selection, zipped_root):
    need(type(selection) is dict and
         selection.get("status") == "RMC016_EXISTING_ACTIONS_LEDGER_RECOVERY_BOUNDED_SELECTION",
         "selection authority absent")
    committed = selection.get("report_sha256")
    need(type(committed) is str and HEX64.fullmatch(committed) and
         sha256(canonical({k: v for k, v in selection.items()
                           if k != "report_sha256"})) == committed,
         "selection commitment mismatch")
    root = Path(zipped_root)
    matched = []
    missing = []
    scanned = 0
    for item in selection["selected"]:
        artifact = artifact_row(item)
        archive_path = root / (str(artifact["id"]) + ".zip")
        if not archive_path.is_file():
            missing.append(artifact["id"])
            continue
        need(artifact["digest"] is not None and
             SHA256_META.fullmatch(artifact["digest"]),
             "archive metadata digest missing")
        witness = scan_zip(archive_path.read_bytes(),
                           artifact["digest"].split(":", 1)[1])
        scanned += 1
        for row in witness:
            matched.append({
                "artifact_id": artifact["id"],
                "source_run_id": artifact["run_id"],
                "source_head_sha": artifact["head_sha"],
                "original_archive_sha256": artifact["digest"].split(":", 1)[1],
                **row,
            })
    report = {
        "schema_version": 1,
        "status": (
            "RMC016_ORIGINAL_LEDGER_SHA_MATCH_FOUND_REPLAY_PENDING"
            if matched else
            "RMC016_ORIGINAL_LEDGER_NOT_FOUND_IN_BOUNDED_ACTIONS_SAMPLE"
        ),
        "source_repository": REPOSITORY,
        "source_d16_git_blob_sha1": D16_SOURCE_GIT_BLOB,
        "source_d16_ledger_sha256": ORIGINAL_LEDGER_SHA256,
        "source_selection_sha256": committed,
        "artifact_metadata_rows_indexed": selection["total_indexed_artifacts"],
        "eligible_archives": selection["eligible_unexpired_small_archives"],
        "selected_archives": len(selection["selected"]),
        "zip_sha256_authenticated_archives_scanned": scanned,
        "selected_archives_not_scanned": missing,
        "other_eligible_archives_unscanned": selection["eligible_not_selected_due_to_scan_budget"],
        "source_sha_exact_matches": matched,
        "original_source_located_in_this_sample": bool(matched),
        "original_ledger_full_costs_independently_replayed": False,
        "original_127_row_economics_certified_by_this_search": False,
        "all_existing_github_artifacts_searched": False,
        "source_absent_globally_proven": False,
        "snapshot_data_recovered": False,
        "nonrecourse_native_gas_funding_authorized": False,
        "nqc_capture_probability_calibrated": False,
        "nqc_realized_net_usd_wad": "0",
        "real_market_census_closed": False,
        "next_action_if_found": "ADAPT_AND_INDEPENDENTLY_REPLAY_AUTHENTIC_BYTES_WITH_EXISTING_RMC016_WINNER_NET_AUDIT",
        "next_action_if_not_found": "RECOVER_ORIGINAL_SOURCE_FROM_AUTHORIZED_EXISTING_SNAPSHOT_WITHOUT_PROVISIONING_NEW_INFRA",
    }
    report["report_sha256"] = sha256(canonical(report))
    return report


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--economic-source", type=Path, required=True)
    p.add_argument("--index", type=Path, required=True)
    p.add_argument("--selection", type=Path, required=True)
    p.add_argument("--zip-root", type=Path)
    p.add_argument("--report", type=Path)
    args = p.parse_args()
    verify_source(args.economic_source.read_bytes())
    if args.zip_root is None:
        need(args.report is None, "scan report requires ZIP input directory")
        need(not args.selection.exists(), "append-only source selection")
        selection = select(load_index(args.index.read_bytes()))
        args.selection.parent.mkdir(parents=True, exist_ok=True)
        args.selection.write_bytes(canonical(selection))
        print("CANDIDATES", len(selection["selected"]),
              "INDEXED", selection["total_indexed_artifacts"],
              "ELIGIBLE", selection["eligible_unexpired_small_archives"])
    else:
        need(args.report is not None and args.selection.is_file()
             and not args.report.exists(), "append-only ZIP scan report required")
        selection = exact_json(args.selection.read_bytes())
        report = scan(selection, args.zip_root)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_bytes(canonical(report))
        print(report["status"], "SCANNED", report["zip_sha256_authenticated_archives_scanned"],
              "EXACT_MATCHES", len(report["source_sha_exact_matches"]),
              "NQC_PNL=0 CENSUS_CLOSED=false")


if __name__ == "__main__":
    main()
