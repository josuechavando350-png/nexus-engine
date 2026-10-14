#!/usr/bin/env python3
"""Strict offline round-aware ETH/USD oracle activation timing ledger (NO TRADE).

Reads only already-produced authenticated PR709/PR710 GitHub Actions ZIPs.
No RPC, keys, user accounts, broadcasting, deployment or net P&L claims.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import zipfile

WAD = 10**18
SHA709 = "5e5684fb4a98b87b1d9e2f15facb03ddb093e50a6e75ff4553b79fc192e69d38"
HEAD709 = "635a10da08bb5b4cea7639c555cb2ddf7b38c551"
SHA710 = "dfe6213f2bc32777aa1f4e31172d197e19bf82ae052fae0418331b44cae1a0b7"
HEAD710 = "d002d4c0a850801ed73911cebcbbc627822d8f12"
PRIMARY = "PRIMARY_NEW_TRANSMISSION"
SECONDARY = "SECONDARY_ROUND_ID_UPDATED"
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")


class Rejected(ValueError):
    pass


def need(value, msg):
    if not value:
        raise Rejected(msg)


def integer(value, field, minimum=0):
    need(type(value) is int and value >= minimum, field + " must be integer >= " + str(minimum))
    return value


def strict_json(data: bytes):
    def pairs(entries):
        out = {}
        for k, v in entries:
            need(k not in out, "duplicate JSON key: " + k)
            out[k] = v
        return out
    def reject_constant(value):
        raise Rejected("nonfinite JSON " + value)
    return json.loads(data, object_pairs_hook=pairs, parse_constant=reject_constant)


def authenticate_archive(payload: bytes, expected_sha: str, expected_head: str, report_path: str):
    need(type(payload) is bytes and 1 <= len(payload) < 30_000_000, "ZIP size invalid")
    need(sha256(payload).hexdigest() == expected_sha, "source ZIP digest mismatch")
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        items = [m for m in archive.infolist() if not m.is_dir()]
        need(len(items) <= 400 and sum(m.file_size for m in items) < 80_000_000,
             "ZIP resource limit")
        names = [m.filename for m in items]
        need(len(names) == len(set(names)), "duplicate ZIP member")
        for item in items:
            p = PurePosixPath(item.filename)
            need(not p.is_absolute() and ".." not in p.parts
                 and item.filename == str(p) and "\\" not in item.filename
                 and item.file_size < 15_000_000, "unsafe ZIP member")
        need("manifest.sha256" in names and report_path in names
             and "code-commit.txt" in names and "code-tree.txt" in names,
             "required archive entries absent")
        need(archive.read("code-commit.txt").decode("ascii").strip() == expected_head,
             "producer head changed")
        need(HEX40.fullmatch(archive.read("code-tree.txt").decode("ascii").strip()),
             "invalid code tree")
        manifest = archive.read("manifest.sha256").decode("ascii")
        expected_members = {}
        for line in manifest.splitlines():
            match = re.fullmatch(r"([0-9a-f]{64})  \./([A-Za-z0-9._/\-]+)", line)
            need(match is not None, "invalid content-addressed manifest")
            digest, name = match.groups()
            need(name not in expected_members and name != "manifest.sha256",
                 "duplicated/recursive manifest")
            expected_members[name] = digest
        need(set(expected_members) == set(names) - {"manifest.sha256"},
             "manifest members are not exhaustive")
        for name, digest in expected_members.items():
            need(sha256(archive.read(name)).hexdigest() == digest,
                 "member bytes differ: " + name)
        return strict_json(archive.read(report_path)), {
            "zip_sha256": expected_sha,
            "producer_commit": expected_head,
            "manifest_members_verified": len(expected_members),
        }


def verify_source_contract(order, prices):
    need(type(order) is dict and order.get("status") ==
         "SINGLE_ENDPOINT_ROUND_ORDER_DESCRIPTIVE_ONLY", "PR709 was not certified")
    need(order.get("cross_endpoint_receipt_parity") is False,
         "PR709 one-endpoint limit falsely promoted")
    need(order.get("errors") == [] and type(order.get("rounds")) is list
         and len(order["rounds"]) == 2, "PR709 cases/errors changed")
    need(type(order.get("sources")) is dict and set(order["sources"]) == {"drpc", "blast"}
         and order["sources"]["drpc"]["status"] ==
         "ALL_FOUR_RECEIPTS_CANONICAL_ORDER_VERIFIED" and
         order["sources"]["blast"]["status"] == "INCOMPLETE_RECEIPT_SOURCE",
         "original positive controls or Blast 429 limitation changed")
    need(prices.get("status") == "TWO_RPC_HISTORICAL_PRICE_PATH_PARITY_NO_LIVE_CAPTURE"
         and prices.get("errors") == [] and type(prices.get("cases")) is list
         and len(prices["cases"]) == 4, "PR710 status/errors/cases not authoritative")
    need(prices.get("source", {}).get("producer_commit") == HEAD709 and
         prices["source"].get("zip_sha256") == SHA709 and
         prices["source"].get("producer_source_status") ==
         "SINGLE_ENDPOINT_ROUND_ORDER_DESCRIPTIVE_ONLY", "source link drift")
    need(prices.get("source", {}).get("PR707_two_operator_receipt_parity_inherited") is False,
         "PR707/709 false independence promotion")
    for source in (order, prices):
        need(source.get("nqc_realized_pnl_usd") == "0", "fake realized revenue")
        for k in ("RMC_closed", "P2_shadow_certified", "canary_live_authorized",
                  "commercial_score_upgrade"):
            need(source.get(k) is False, "source falsely claims certification " + k)


def map_price_cases(prices):
    rows = {}
    for item in prices["cases"]:
        need(type(item) is dict and item.get("source_parity") is True,
             "two-provider transaction price parity missing")
        c = item.get("case")
        need(type(c) is dict, "case absent")
        key = (integer(c.get("round_id"), "round", 1), c.get("family"))
        need(key[1] in (PRIMARY, SECONDARY) and key not in rows, "duplicate/unknown case")
        metrics = item.get("dRPC")
        need(type(metrics) is dict and metrics == item.get("BlastAPI"),
             "two-provider fork parity changed")
        need(metrics.get("source_event_family") == key[1] and
             metrics.get("NQC_MATCHED_ORACLE_EVENT") == 1 and
             metrics.get("historical_only") is True and
             metrics.get("source_event_does_not_guarantee_price_change") is True,
             "historical evidence claims/scope drift")
        for field in ("NQC_AAVE_PRICE_BEFORE", "NQC_AAVE_PRICE_AFTER",
                      "NQC_CHAINLINK_ANSWER_BEFORE", "NQC_CHAINLINK_ANSWER_AFTER",
                      "AAVE_PRICE_DELTA_RAW", "NQC_PRICE_CHANGED"):
            integer(metrics.get(field), field, -10**30 if field == "AAVE_PRICE_DELTA_RAW" else 0)
        need(metrics["NQC_AAVE_PRICE_BEFORE"] > 0 and
             metrics["NQC_AAVE_PRICE_AFTER"] > 0 and
             metrics["NQC_AAVE_PRICE_AFTER"]-metrics["NQC_AAVE_PRICE_BEFORE"] ==
             metrics["AAVE_PRICE_DELTA_RAW"] and
             int(metrics["NQC_AAVE_PRICE_AFTER"] != metrics["NQC_AAVE_PRICE_BEFORE"]) ==
             metrics["NQC_PRICE_CHANGED"], "price change identity error")
        rows[key] = (c, metrics)
    need(len(rows) == 4, "not exactly two primary and two secondary price paths")
    return rows


def build(order, prices, provenance):
    verify_source_contract(order, prices)
    cases = map_price_cases(prices)
    rows = []
    seen = set()
    for pair in order["rounds"]:
        need(type(pair) is dict, "round pair malformed")
        rid = integer(pair.get("round_id"), "round_id", 1)
        need(rid not in seen, "repeated round")
        seen.add(rid)
        pcase, pm = cases[(rid, PRIMARY)]
        scase, sm = cases[(rid, SECONDARY)]
        original_primary, original_secondary = pair.get("primary"), pair.get("secondary")
        need(type(original_primary) is dict and type(original_secondary) is dict,
             "missing order events")
        for original, case in ((original_primary, pcase), (original_secondary, scase)):
            need(original["block"] == case["block"] and
                 original["tx_hash"] == case["tx_hash"] and
                 original["transaction_index"] == case["tx_index"],
                 "receipt->price-path transaction identity drift")
        bn_primary = integer(pcase["block"], "primary block")
        bn_secondary = integer(scase["block"], "secondary block")
        txp = integer(pcase["tx_index"], "primary tx index")
        txs = integer(scase["tx_index"], "secondary tx index")
        gap = bn_secondary-bn_primary
        need(gap in (0, 1) and (gap == 1 or txp < txs),
             "unexpected round temporal ordering")
        need(pair.get("block_height_difference_secondary_minus_primary") == gap,
             "PR709 block gap changed")
        need(pair.get("block_timestamp_difference_seconds") ==
             scase["timestamp"]-pcase["timestamp"], "timestamp gap mismatch")
        kind = ("NEXT_BLOCK_SECONDARY" if gap == 1 else "SAME_BLOCK_SECONDARY")
        need(pair.get("ordering") == ("SECONDARY_AFTER_PRIMARY_FUTURE_BLOCK" if gap
             else "SECONDARY_AFTER_PRIMARY_SAME_BLOCK"), "ordering class drift")
        before = pm["NQC_AAVE_PRICE_BEFORE"]
        after = sm["NQC_AAVE_PRICE_AFTER"]
        need(pm["NQC_AAVE_PRICE_AFTER"] == before and pm["NQC_PRICE_CHANGED"] == 0,
             "primary did not leave Aave price unchanged")
        need(sm["NQC_AAVE_PRICE_BEFORE"] == before and sm["NQC_PRICE_CHANGED"] == 1,
             "secondary not the only price-activating transition")
        need(pm["NQC_CHAINLINK_ANSWER_AFTER"] == pm["NQC_CHAINLINK_ANSWER_BEFORE"] and
             sm["NQC_CHAINLINK_ANSWER_AFTER"] == after,
             "Chainlink/ Aave transition drift")
        need(pcase.get("source_price_answer_raw") == after and
             scase.get("source_price_answer_raw") is None,
             "primary report price not equal to later active Aave price")
        need(after < before, "not a downward ETH/USD transition")
        decline_raw = before-after
        decline_millibps = decline_raw*10_000_000//before
        # Rational / approximate; only WETH-only collateral, unchanged stablecoin
        # debt, static thresholds, no interest/fee, no other risk configuration.
        hypothetical_hf_max_exclusive_wad = before*WAD//after
        rows.append({
            "round_id": rid,
            "primary_block":bn_primary, "primary_transaction_index":txp,
            "secondary_block":bn_secondary, "secondary_transaction_index":txs,
            "primary_report_price_raw":pcase["source_price_answer_raw"],
            "aave_price_before_raw":before,
            "aave_price_after_secondary_raw":after,
            "price_decline_raw":decline_raw,
            "decline_millibasis_points_floor":decline_millibps,
            "hypothetical_eth_only_hf_crossing_band":
                {"lower_wad_inclusive":WAD,
                 "upper_wad_exclusive_approx":hypothetical_hf_max_exclusive_wad,
                 "assumes_only_weth_collateral_unchanged_stable_debt":True,
                 "real_aave_integer_hf_replay_proven":False},
            "block_gap":gap,
            "historical_secondary_minus_primary_timestamp_seconds":
                pair["block_timestamp_difference_seconds"],
            "window_class":kind,
            "post_primary_local_head_reactive_slot":
                "ONE_INTERVENING_BLOCK_BOUNDARY_ONLY_NO_WALL_CLOCK_ACCESS"
                if gap == 1 else
                "NONE_IF_TRIGGER_IS_ONLY_CONFIRMED_PRIMARY_HEAD",
            "public_pending_visibility_proven":False,
            "builder_ordering_available_proven":False,
            "borrower_at_risk_identified_in_this_round":False,
            "executed_liquidation_or_net_economic_capture_proven":False,
        })
    need(len(rows) == 2 and len(seen) == 2, "round cardinality drift")
    return {
        "schema_version":1,
        "status":"TWO_HISTORICAL_SECONDARY_PRICE_ACTIVATIONS_REPRODUCED_NO_CAPTURE",
        "source":provenance,
        "rounds":sorted(rows,key=lambda r:r["round_id"]),
        "secondary_only_price_activation_count":sum(1 for _ in rows),
        "next_block_secondary_count":sum(r["block_gap"]==1 for r in rows),
        "same_block_secondary_count":sum(r["block_gap"]==0 for r in rows),
        "historical_selected_rounds_not_population":True,
        "original_order_source_only_one_endpoint_complete":True,
        "price_path_two_public_urls_parity_but_independent_operators_not_proven":True,
        "oracle_primary_price_can_precede_aave_activation_in_these_rounds":True,
        "public_mempool_first_seen_proven":False,
        "prospective_oracle_report_visibility_proven":False,
        "confirmed_block_reactive_capture_proven":False,
        "candidate_borrower_hf_crossing_proven":False,
        "cold_transaction_gas_authenticated":False,
        "external_nonrecourse_native_gas_sponsor_proven":False,
        "nqc_net_profit_authenticated":False,
        "RMC_closed":False, "P2_shadow_certified":False,
        "canary_live_authorized":False, "commercial_score_upgrade":False,
        "nqc_realized_pnl_usd":"0",
    }


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--round-order-artifact",type=Path,required=True)
    parser.add_argument("--price-path-artifact",type=Path,required=True)
    parser.add_argument("--out",type=Path,required=True)
    args=parser.parse_args()
    need(args.out.is_absolute() and args.out.parent.is_dir()
         and not args.out.exists(), "new absolute output path required")
    a, pa = authenticate_archive(args.round_order_artifact.read_bytes(),SHA709,HEAD709,
                                 "round-receipt-order.json")
    b, pb = authenticate_archive(args.price_path_artifact.read_bytes(),SHA710,HEAD710,
                                 "attempt/price-path-fork.json")
    report=build(a,b,{"round_order":pa,"price_path":pb})
    with args.out.open("xb") as f:
        f.write((json.dumps(report,sort_keys=True,separators=(",",":"))+"\n").encode())
    print(report["status"],[
      (r["round_id"],r["block_gap"],r["decline_millibasis_points_floor"])
      for r in report["rounds"]])
    return 0


if __name__=="__main__":
    raise SystemExit(main())
