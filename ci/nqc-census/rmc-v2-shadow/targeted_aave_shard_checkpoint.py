#!/usr/bin/env python3
"""Content-addressed incremental checkpoint/merge for targeted Aave census.

One checkpoint commits ONE fully verified subset of eth_getLogs plus receipts.
An interrupted scan cannot declare zero events or certify full coverage.
This audits report *integrity and invariants*, not independent RPC truth.
NO wallet, transaction, gas, keys, funds, P2, profit or RMC closeout.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re

import targeted_aave_liquidation_census as census

CHECKPOINT = "NQC_V2_AAVE_TARGETED_PARTIAL_CHECKPOINT_V1"
MANIFEST = "NQC_V2_AAVE_TARGETED_EXHAUSTIVE_SEGMENT_MERGE_V1"
PARTIAL = "PARTIAL_ONLY_CANNOT_CERTIFY_FULL_89390_BLOCKS"
COMPLETE = "COMPLETE_SINGLE_RPC_TARGETED_89390_BLOCKS_NOT_QUORUM"
HEX32 = re.compile(r"0x[0-9a-f]{64}\Z")
HEX64_SHA = re.compile(r"[0-9a-f]{64}\Z")
DECIMAL = re.compile(r"0|[1-9][0-9]*\Z")
U256 = 2**256-1


def require(ok, msg):
    if not ok:
        raise census.SourceError(msg)


def raw_sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(doc):
    return census.canon(doc)


def source_digest():
    return raw_sha(Path(census.__file__).read_bytes())


def uint(v, label, positive=False):
    require(type(v) is str and DECIMAL.fullmatch(v) is not None,
            label + ": canonical integer required")
    n = int(v)
    require(0 <= n <= U256 and (not positive or n > 0),
            label + ": number range invalid")
    return n


def exact_hex(v, label):
    require(type(v) is str and HEX32.fullmatch(v) is not None, label + ": bytes32")


def verify_boundary_header(row, height, label):
    require(type(row) is dict and
            type(row.get("number")) is int and row["number"] == height,
            label + ": block number missing/mismatch")
    for key in ("hash", "parent_hash", "state_root"):
        exact_hex(row.get(key), label + "." + key)
    timestamp = row.get("timestamp")
    require(type(timestamp) is int and timestamp > 0,
            label + ": timestamp missing")
    require(row["hash"] != row["parent_hash"],
            label + ": degenerate same-hash ancestry")
    return row


def verify_report(doc):
    require(type(doc) is dict and doc.get("schema_version") == 1,
            "report schema")
    require(doc.get("contract") ==
            "NQC_RMC_V2_POSTWINDOW_TARGETED_LIQUIDATION_EVIDENCE",
            "report contract")
    require(doc.get("scope") ==
            "HISTORICAL_TARGETED_SUSDE_USDTB_NOT_FULL_AAVE_CENSUS",
            "report scope")
    require(type(doc.get("chain_id")) is int and doc["chain_id"] == 1,
            "chain ID mismatch")
    w = doc.get("window")
    require(type(w) is dict and type(w.get("start")) is int and
            type(w.get("end")) is int, "window type")
    lo, hi = w["start"], w["end"]
    require(census.START <= lo <= hi <= census.END, "window outside exact anchors")
    require(w.get("previous_end_hash") == census.PREVIOUS_END_HASH and
            w.get("end_hash") == census.END_HASH and
            w.get("parent_hash") == census.END_PARENT,
            "canonical period anchor mismatch")
    boundaries = doc.get("segment_boundary_headers")
    require(type(boundaries) is dict and
            set(boundaries) == {"first", "last"},
            "historical segment boundary headers missing")
    first = verify_boundary_header(boundaries.get("first"), lo, "first")
    last = verify_boundary_header(boundaries.get("last"), hi, "last")
    if lo == hi:
        require(first == last, "one-block segment disagreeing headers")
    if lo == census.START:
        require(first["parent_hash"] == census.PREVIOUS_END_HASH,
                "checkpoint starts on wrong predecessor")
    if hi == census.END:
        require(last["hash"] == census.END_HASH and
                last["parent_hash"] == census.END_PARENT,
                "checkpoint finishes on wrong canonical anchor")
    full = lo == census.START and hi == census.END
    allowed_status = (
        "COMPLETE_SINGLE_PUBLIC_RPC_TARGETED_HISTORICAL_ONLY" if full
        else "PARTIAL_SINGLE_PUBLIC_RPC_TARGETED_HISTORICAL_ONLY"
    )
    require(doc.get("status") == allowed_status, "full/partial scope promotion")
    require(doc.get("provider_id") in census.PROVIDERS, "unknown source provider")
    require(doc.get("operator_label") ==
            census.PROVIDERS[doc["provider_id"]][0], "operator spoofing")
    spacing = doc.get("provider_rate_spacing_seconds")
    require(type(spacing) in (int, float) and
            spacing >= census.MIN_RPC_INTERVAL,
            "public source pacing missing")
    count = doc.get("provider_rpc_requests")
    require(type(count) is int and 0 < count <= census.MAX_REQUESTS,
            "source query budget invalid")
    require(doc.get("independent_operator_authenticity_proven") is False and
            doc.get("actual_liquidation_by_Nexus") is False and
            doc.get("nqc_capture_probability_calibrated") is False and
            doc.get("p2_shadow_certified") is False and
            doc.get("rmc_closed") is False and
            doc.get("commercial_score_upgrade") is False and
            doc.get("nqc_realized_pnl_usd") == "0" and
            doc.get("full_Aave_liquidation_count_in_postwindow_known") is False,
            "commercial/source authority fraud")
    shards = doc.get("shards")
    require(type(shards) is list and len(shards) > 0, "no covered shards")
    census.interval_cover(shards, lo, hi)
    for shard in shards:
        for k in ("collateral_stream_count", "debt_stream_count"):
            n = shard.get(k)
            require(type(n) is int and 0 <= n < census.MAX_EVENT_PER_STREAM_SHARD,
                    "invalid query result row count")
    rows = doc.get("events")
    receipts = doc.get("receipt_checks")
    require(type(rows) is list and type(receipts) is list and
            len(rows) == len(receipts) and
            len(rows) == doc.get("total_targeted_events"),
            "event/receipt count mismatch")
    require(census.sha(rows) == doc.get("events_sha256") and
            census.sha(receipts) == doc.get("receipt_checks_sha256"),
            "event/receipt content hash mismatch")
    seen = set()
    order = []
    for i, e in enumerate(rows):
        require(type(e) is dict, "event row not object")
        require(type(e.get("block_number")) is int and
                lo <= e["block_number"] <= hi, "event outside shard")
        exact_hex(e.get("block_hash"), "event block")
        if e["block_number"] == lo:
            require(e["block_hash"] == first["hash"],
                    "first-block event differs from anchored header")
        if e["block_number"] == hi:
            require(e["block_hash"] == last["hash"],
                    "last-block event differs from anchored header")
        exact_hex(e.get("transaction_hash"), "event transaction")
        require(type(e.get("raw_event_commitment_sha256")) is str and
                HEX64_SHA.fullmatch(e["raw_event_commitment_sha256"]) is not None,
                "ABI commitment: invalid SHA256 digest")
        exact_hex("0x" + e.get("borrower_address_hash_sha256", ""),
                  "borrower hash")
        require(e.get("collateral_asset") in
                {census.SUSDE, census.USDTB} or
                e.get("debt_asset") in {census.SUSDE, census.USDTB},
                "event does not refer to requested assets")
        require(type(e.get("transaction_index")) is int and
                e["transaction_index"] >= 0 and
                type(e.get("log_index")) is int and
                e["log_index"] >= 0, "negative event order")
        require(type(e.get("receive_atoken")) is bool, "ABI bool invalid")
        uint(e.get("debt_to_cover_raw"), "debt", positive=True)
        uint(e.get("collateral_liquidated_raw"), "collateral", positive=True)
        identity = census.identifier(e)
        require(identity not in seen, "duplicate event identity")
        seen.add(identity)
        order.append((e["block_number"], e["transaction_index"],
                      e["log_index"], e["transaction_hash"]))
        r = receipts[i]
        require(type(r) is dict and
                r.get("receipt_identity_matches") is True and
                r.get("transaction_hash") == e["transaction_hash"],
                "receipt order/identity mismatch")
        uint(r.get("receipt_gas_used_raw"), "receipt gas", positive=True)
        uint(r.get("receipt_effective_gas_price_wei_raw"),
             "receipt gas price", positive=True)
    require(order == sorted(order), "noncanonical event ordering")
    require(census.classify(rows) == doc.get("summary"),
            "asset-pair statistics contradict event universe")
    return lo, hi


def make_checkpoint(report):
    lo, hi = verify_report(report)
    report_raw = canonical(report)
    return {
        "schema_version": 1, "contract": CHECKPOINT,
        "status": "PARTIAL_OR_FULL_SEGMENT_NEVER_TERMINAL_AUTHORITY",
        "chain_id": 1,
        "source_python_sha256": source_digest(),
        "window_start": lo, "window_end": hi,
        "report_sha256": raw_sha(report_raw),
        "report": report,
        "provenance_scope": "ONE_UNVERIFIED_OPERATOR_REPLAY_ONLY",
        "independent_rpc_quorum": False,
        "complete_global_coverage_claim": False,
        "nqc_realized_pnl_usd": "0", "shadow_p2_certified": False,
        "rmc_closed": False,
    }


def verify_checkpoint(cp):
    require(type(cp) is dict and cp.get("schema_version") == 1 and
            cp.get("contract") == CHECKPOINT and
            cp.get("status") ==
            "PARTIAL_OR_FULL_SEGMENT_NEVER_TERMINAL_AUTHORITY",
            "checkpoint version/claim")
    require(cp.get("chain_id") == 1 and
            cp.get("source_python_sha256") == source_digest() and
            cp.get("provenance_scope") == "ONE_UNVERIFIED_OPERATOR_REPLAY_ONLY",
            "source provenance mismatch")
    require(cp.get("independent_rpc_quorum") is False and
            cp.get("complete_global_coverage_claim") is False and
            cp.get("nqc_realized_pnl_usd") == "0" and
            cp.get("shadow_p2_certified") is False and
            cp.get("rmc_closed") is False,
            "checkpoint promoted to authority")
    report = cp.get("report")
    require(type(report) is dict and
            cp.get("report_sha256") == raw_sha(canonical(report)),
            "checkpoint content digest mismatch")
    lo, hi = verify_report(report)
    require(cp.get("window_start") == lo and cp.get("window_end") == hi,
            "checkpoint window/reference mismatch")
    return report


def combine(parts):
    require(type(parts) is list and len(parts) > 0,
            "checkpoint list empty")
    pairs = [(verify_checkpoint(p), p) for p in parts]
    pairs.sort(key=lambda x: x[1]["window_start"])
    a = pairs[0][0]
    provider = a["provider_id"]
    operator = a["operator_label"]
    cursor = pairs[0][1]["window_start"]
    all_events = []
    all_receipts = []
    shard_proofs = []
    ids = set()
    previous_end_hash = None
    for report, cp in pairs:
        # Classify gaps/overlaps before comparing canonical ancestry, so a
        # broken interval is not misreported as an RPC reorg/mismatch.
        require(cp["window_start"] == cursor,
                "missing or overlapping historical checkpoint interval")
        require(report["provider_id"] == provider and
                report["operator_label"] == operator,
                "unrelated operators cannot form one complete source")
        edge = report["segment_boundary_headers"]
        if previous_end_hash is not None:
            require(edge["first"]["parent_hash"] == previous_end_hash,
                    "adjacent segment parent/hash ancestry mismatch")
        previous_end_hash = edge["last"]["hash"]
        for event in report["events"]:
            identity = census.identifier(event)
            require(identity not in ids, "cross-checkpoint duplicate event")
            ids.add(identity)
            all_events.append(event)
        all_receipts.extend(report["receipt_checks"])
        shard_proofs.append({
            "start": cp["window_start"], "end": cp["window_end"],
            "checkpoint_sha256": raw_sha(canonical(cp)),
            "event_count": len(report["events"]),
            "source_rpc_request_count": report["provider_rpc_requests"],
        })
        cursor = cp["window_end"] + 1
    require(cursor <= census.END + 1, "checkpoint range overrun")
    covered_start = pairs[0][1]["window_start"]
    covered_end = cursor - 1
    global_complete = covered_start == census.START and covered_end == census.END
    return {
        "schema_version": 1, "contract": MANIFEST,
        "status": COMPLETE if global_complete else PARTIAL,
        "chain_id": 1, "provider_id": provider,
        "single_provider_only": True,
        "source_python_sha256": source_digest(),
        "window_covered": {"start": covered_start, "end": covered_end,
                           "count": covered_end-covered_start+1},
        "global_window": {"start": census.START, "end": census.END},
        "full_global_coverage": global_complete,
        "source_shards": shard_proofs,
        "total_targeted_events": len(all_events),
        "events_sha256": raw_sha(canonical(all_events)),
        "receipts_sha256": raw_sha(canonical(all_receipts)),
        "summary": census.classify(all_events),
        "raw_abi_events_and_receipts_embedded": False,
        "independent_rpc_operator_authentication_proven": False,
        "prospective_capture_proven": False,
        "gas_external_nonrecourse_proven": False,
        "nqc_realized_pnl_usd": "0",
        "commercial_score_upgrade": False,
        "p2_shadow_certified": False, "rmc_closed": False,
        "caveat": "Hashes authenticate archived JSON consistency, not independent chain/operator truth",
    }


def write_new_immutable(path, obj):
    payload = canonical(obj)
    path = Path(path)
    if path.exists():
        require(path.read_bytes() == payload,
                "immutable checkpoint file already contains different bytes")
        return path
    with path.open("xb") as stream:
        stream.write(payload)
    return path


def main():
    cli = argparse.ArgumentParser()
    g = cli.add_mutually_exclusive_group(required=True)
    g.add_argument("--scan-segment", nargs=2, type=int, metavar=("START", "END"))
    g.add_argument("--merge-checkpoints", nargs="+", type=Path)
    cli.add_argument("--provider", choices=sorted(census.PROVIDERS), default="drpc")
    cli.add_argument("--span", type=int, default=2500)
    cli.add_argument("--out", type=Path, required=True)
    args = cli.parse_args()
    if args.scan_segment:
        start, end = args.scan_segment
        rpc = census.RPC(args.provider)
        # Verify each checkpoint's first/last canonical headers both before
        # and after the segment scan; all shards remain one-provider research.
        edge_first = rpc.header(start)
        edge_last = rpc.header(end)
        report = census.report_for_provider(rpc,start=start,end=end,span=args.span)
        require(rpc.header(start) == edge_first and
                rpc.header(end) == edge_last,
                "segment boundary changed during historical scan")
        report["segment_boundary_headers"] = {
            "first": edge_first, "last": edge_last}
        report["provider_rpc_requests"] = rpc.requests
        report["status"] = ("COMPLETE_SINGLE_PUBLIC_RPC_TARGETED_HISTORICAL_ONLY"
                            if start == census.START and end == census.END else
                            "PARTIAL_SINGLE_PUBLIC_RPC_TARGETED_HISTORICAL_ONLY")
        doc = make_checkpoint(report)
    else:
        doc = combine([json.loads(f.read_bytes()) for f in args.merge_checkpoints])
    write_new_immutable(args.out,doc)
    print(doc["status"], doc.get("total_targeted_events",doc.get("report",{}).get("total_targeted_events")))
    
if __name__ == "__main__":
    main()
