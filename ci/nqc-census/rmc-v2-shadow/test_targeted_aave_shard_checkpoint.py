#!/usr/bin/env python3
"""Offline adversarial tests for fail-closed postwindow checkpoint semantics."""
from __future__ import annotations
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

import targeted_aave_liquidation_census as c
import targeted_aave_shard_checkpoint as m

START = c.START
END = c.END
TX = "0x" + "1"*64
BLOCK_HASH = "0x" + "2"*64


def synthetic_hash(height):
    if height == c.PREVIOUS_END:
        return c.PREVIOUS_END_HASH
    if height == c.END - 1:
        return c.END_PARENT
    if height == c.END:
        return c.END_HASH
    return "0x" + format(height, "064x")


def synthetic_header(height):
    return {
        "number":height,
        "hash":synthetic_hash(height),
        "parent_hash":synthetic_hash(height-1),
        "state_root":"0x" + "a"*64,
        "timestamp":1_700_000_000,
    }


def event(block):
    return {
        "block_number": block,
        "block_hash": synthetic_hash(block),
        "transaction_hash": TX,
        "transaction_index": 1,
        "log_index": 0,
        "collateral_asset": c.SUSDE,
        "debt_asset": c.USDTB,
        "borrower_address_hash_sha256": "a"*64,
        "debt_to_cover_raw": "472000000000000000000000",
        "collateral_liquidated_raw": "388000000000000000000000",
        "receive_atoken": False,
        "raw_event_commitment_sha256": "b"*64,
    }


def receipt(e):
    return {
        "transaction_hash": e["transaction_hash"],
        "receipt_gas_used_raw": "900000",
        "receipt_effective_gas_price_wei_raw": "1300000000",
        "receipt_identity_matches": True,
    }


def synthetic(lo=START, hi=END, *, provider="drpc", with_event=False):
    events = [event(lo)] if with_event else []
    receipts = [receipt(e) for e in events]
    return {
        "schema_version": 1,
        "contract": "NQC_RMC_V2_POSTWINDOW_TARGETED_LIQUIDATION_EVIDENCE",
        "scope": "HISTORICAL_TARGETED_SUSDE_USDTB_NOT_FULL_AAVE_CENSUS",
        "status": (
            "COMPLETE_SINGLE_PUBLIC_RPC_TARGETED_HISTORICAL_ONLY"
            if lo == START and hi == END else
            "PARTIAL_SINGLE_PUBLIC_RPC_TARGETED_HISTORICAL_ONLY"
        ),
        "chain_id": 1,
        "operator_label": c.PROVIDERS[provider][0],
        "provider_id": provider,
        "window": {
            "start": lo,
            "end": hi,
            "previous_end_hash": c.PREVIOUS_END_HASH,
            "end_hash": c.END_HASH,
            "parent_hash": c.END_PARENT,
        },
        "segment_boundary_headers":{
            "first":synthetic_header(lo),
            "last":synthetic_header(hi),
        },
        "shards": [{"start":lo,"end":hi,"collateral_stream_count":len(events),
                    "debt_stream_count":len(events)}],
        "total_targeted_events": len(events),
        "summary": c.classify(events),
        "events": events,
        "receipt_checks": receipts,
        "events_sha256": c.sha(events),
        "receipt_checks_sha256": c.sha(receipts),
        "provider_rpc_requests": 11,
        "provider_rate_spacing_seconds": 22.0,
        "full_Aave_liquidation_count_in_postwindow_known": False,
        "independent_operator_authenticity_proven": False,
        "actual_liquidation_by_Nexus": False,
        "nqc_capture_probability_calibrated": False,
        "nqc_realized_pnl_usd": "0",
        "rmc_closed": False,
        "p2_shadow_certified": False,
        "commercial_score_upgrade": False,
    }


def remake(doc):
    doc["events_sha256"] = c.sha(doc["events"])
    doc["receipt_checks_sha256"] = c.sha(doc["receipt_checks"])
    doc["summary"] = c.classify(doc["events"])
    return doc


class ReportValidation(unittest.TestCase):
    def test_partial_source_is_admissible_only_as_partial(self):
        report = synthetic(START, START+100, with_event=True)
        self.assertEqual(m.verify_report(report),(START,START+100))
    def test_full_source_is_admissible_as_single_source_only(self):
        report = synthetic()
        self.assertEqual(m.verify_report(report),(START,END))
    def test_partial_report_with_full_status_is_forbidden(self):
        doc = synthetic(START,START+1)
        doc["status"] = "COMPLETE_SINGLE_PUBLIC_RPC_TARGETED_HISTORICAL_ONLY"
        with self.assertRaisesRegex(c.SourceError,"scope promotion"):
            m.verify_report(doc)
    def test_full_report_with_partial_status_is_forbidden(self):
        doc=synthetic()
        doc["status"]="PARTIAL_SINGLE_PUBLIC_RPC_TARGETED_HISTORICAL_ONLY"
        with self.assertRaisesRegex(c.SourceError,"scope promotion"):
            m.verify_report(doc)
    def test_p2_and_realized_profit_promotion_rejected(self):
        for k,v in (("p2_shadow_certified",True),("rmc_closed",True),
                    ("nqc_realized_pnl_usd","1000"),
                    ("commercial_score_upgrade",True),
                    ("independent_operator_authenticity_proven",True),
                    ("actual_liquidation_by_Nexus",True)):
            with self.subTest(k=k):
                doc=synthetic();doc[k]=v
                with self.assertRaisesRegex(c.SourceError,"authority"):
                    m.verify_report(doc)
    def test_event_digest_tampering_rejected(self):
        doc=synthetic(with_event=True)
        doc["events_sha256"]="0"*64
        with self.assertRaisesRegex(c.SourceError,"hash"):
            m.verify_report(doc)
    def test_receipt_digest_tampering_rejected(self):
        doc=synthetic(with_event=True)
        doc["receipt_checks_sha256"]="0"*64
        with self.assertRaisesRegex(c.SourceError,"hash"):
            m.verify_report(doc)
    def test_event_receipt_identity_tampering_rejected_even_if_rehashed(self):
        doc=synthetic(with_event=True)
        doc["receipt_checks"][0]["transaction_hash"]="0x"+"e"*64
        remake(doc)
        with self.assertRaisesRegex(c.SourceError,"receipt order"):
            m.verify_report(doc)
    def test_missing_receipt_prevents_positive_source(self):
        doc=synthetic(with_event=True)
        doc["receipt_checks"]=[]
        remake(doc)
        with self.assertRaisesRegex(c.SourceError,"count mismatch"):
            m.verify_report(doc)
    def test_spoofed_coin_and_wrong_pair_rejected(self):
        doc=synthetic(with_event=True)
        doc["events"][0]["collateral_asset"]="0x"+"e"*40
        doc["events"][0]["debt_asset"]="0x"+"f"*40
        remake(doc)
        with self.assertRaisesRegex(c.SourceError,"requested assets"):
            m.verify_report(doc)
    def test_fake_rpc_operator_rejected(self):
        doc=synthetic()
        doc["operator_label"]="FakeRPC"
        with self.assertRaisesRegex(c.SourceError,"operator spoofing"):
            m.verify_report(doc)
    def test_missing_shard_rejected(self):
        doc=synthetic()
        doc["shards"]=[]
        with self.assertRaisesRegex(c.SourceError,"no covered"):
            m.verify_report(doc)
    def test_gap_and_overlap_rejected(self):
        for shards in (
            [{"start":START+1,"end":END}],
            [{"start":START,"end":START+10},
             {"start":START+10,"end":END}],
            [{"start":START,"end":END-1}],
        ):
            with self.subTest(shards=shards):
                doc=synthetic();doc["shards"]=shards
                with self.assertRaises(c.SourceError):
                    m.verify_report(doc)
    def test_noncanonical_debt_rejected(self):
        doc=synthetic(with_event=True)
        doc["events"][0]["debt_to_cover_raw"]="0472"
        remake(doc)
        with self.assertRaisesRegex(c.SourceError,"canonical integer"):
            m.verify_report(doc)
    def test_zero_debt_rejected(self):
        doc=synthetic(with_event=True)
        doc["events"][0]["debt_to_cover_raw"]="0"
        remake(doc)
        with self.assertRaisesRegex(c.SourceError,"number range"):
            m.verify_report(doc)
    def test_wrong_borrower_commitment_rejected(self):
        doc=synthetic(with_event=True)
        doc["events"][0]["borrower_address_hash_sha256"]="bad"
        remake(doc)
        with self.assertRaisesRegex(c.SourceError,"bytes32"):
            m.verify_report(doc)
    def test_wrong_raw_log_commitment_rejected(self):
        doc=synthetic(with_event=True)
        doc["events"][0]["raw_event_commitment_sha256"]="0xdead"
        remake(doc)
        with self.assertRaisesRegex(c.SourceError,"invalid SHA256 digest"):
            m.verify_report(doc)
    def test_receipt_gas_must_be_positive_and_integer(self):
        for value in ("0","01",123,"-1"):
            with self.subTest(v=value):
                doc=synthetic(with_event=True)
                doc["receipt_checks"][0]["receipt_gas_used_raw"]=value
                remake(doc)
                with self.assertRaises(c.SourceError):
                    m.verify_report(doc)
    def test_provider_spacing_cannot_be_faked_as_zero(self):
        doc=synthetic()
        doc["provider_rate_spacing_seconds"]=0
        with self.assertRaisesRegex(c.SourceError,"pacing"):
            m.verify_report(doc)
    def test_wrong_canonical_end_hash_rejected(self):
        doc=synthetic()
        doc["window"]["end_hash"]="0x"+"f"*64
        with self.assertRaisesRegex(c.SourceError,"canonical period"):
            m.verify_report(doc)
    def test_outside_targeted_window_rejected(self):
        doc=synthetic(START-1, START+1)
        with self.assertRaisesRegex(c.SourceError,"outside"):
            m.verify_report(doc)
    def test_shard_scope_report_not_global_total(self):
        doc=synthetic(START,START+100,with_event=True)
        cp=m.make_checkpoint(doc)
        self.assertEqual(cp["status"],
            "PARTIAL_OR_FULL_SEGMENT_NEVER_TERMINAL_AUTHORITY")
        self.assertFalse(cp["complete_global_coverage_claim"])
        self.assertFalse(cp["independent_rpc_quorum"])


class CheckpointCommitAndMerge(unittest.TestCase):
    def test_full_merge_only_when_contiguous_entire_global_window(self):
        a=m.make_checkpoint(synthetic(START,START+100,with_event=True))
        b=m.make_checkpoint(synthetic(START+101,END))
        merged=m.combine([b,a])
        self.assertEqual(merged["status"],m.COMPLETE)
        self.assertTrue(merged["full_global_coverage"])
        self.assertEqual(merged["window_covered"]["count"],89390)
        self.assertEqual(merged["total_targeted_events"],1)
        self.assertEqual(merged["summary"]["susde_collateral_usdtb_debt"],1)
        self.assertFalse(merged["independent_rpc_operator_authentication_proven"])
        self.assertFalse(merged["prospective_capture_proven"])
        self.assertFalse(merged["gas_external_nonrecourse_proven"])
        self.assertEqual(merged["nqc_realized_pnl_usd"],"0")
    def test_partial_window_never_promoted_to_complete(self):
        cp=m.make_checkpoint(synthetic(START,START+100))
        merged=m.combine([cp])
        self.assertEqual(merged["status"],m.PARTIAL)
        self.assertFalse(merged["full_global_coverage"])
        self.assertEqual(merged["total_targeted_events"],0)
    def test_left_hand_gap_remains_partial(self):
        cp=m.make_checkpoint(synthetic(START+100,END))
        merged=m.combine([cp])
        self.assertFalse(merged["full_global_coverage"])
    def test_same_height_boundary_headers_must_match(self):
        doc=synthetic(START,START)
        self.assertEqual(m.verify_report(doc),(START,START))
        doc["segment_boundary_headers"]["last"]["timestamp"]+=1
        with self.assertRaisesRegex(c.SourceError,"one-block segment"):
            m.verify_report(doc)
    def test_unknown_predecessor_of_initial_checkpoint_rejected(self):
        doc=synthetic(START,START+100)
        doc["segment_boundary_headers"]["first"]["parent_hash"]="0x"+"9"*64
        with self.assertRaisesRegex(c.SourceError,"wrong predecessor"):
            m.verify_report(doc)
    def test_final_checkpoint_wrong_end_anchor_rejected(self):
        doc=synthetic(START+100,END)
        doc["segment_boundary_headers"]["last"]["hash"]="0x"+"f"*64
        with self.assertRaisesRegex(c.SourceError,"wrong canonical anchor"):
            m.verify_report(doc)
    def test_adjacent_checkpoints_wrong_parent_even_if_rehashed_rejected(self):
        a=m.make_checkpoint(synthetic(START,START+100))
        bdoc=synthetic(START+101,END)
        bdoc["segment_boundary_headers"]["first"]["parent_hash"]="0x"+"e"*64
        b=m.make_checkpoint(bdoc)
        with self.assertRaisesRegex(c.SourceError,"parent/hash ancestry"):
            m.combine([a,b])
    def test_real_time_shard_event_with_wrong_first_header_rejected(self):
        doc=synthetic(START,START+100,with_event=True)
        doc["segment_boundary_headers"]["first"]["hash"]="0x"+"f"*64
        with self.assertRaisesRegex(c.SourceError,"first-block event"):
            m.verify_report(doc)
    def test_boundary_header_timestamp_cannot_be_text(self):
        doc=synthetic(START,START+100)
        doc["segment_boundary_headers"]["first"]["timestamp"]="1700000000"
        with self.assertRaisesRegex(c.SourceError,"timestamp"):
            m.verify_report(doc)
    def test_internal_missing_shard_gap_rejected(self):
        a=m.make_checkpoint(synthetic(START,START+100))
        b=m.make_checkpoint(synthetic(START+102,END))
        with self.assertRaisesRegex(c.SourceError,"missing or overlapping"):
            m.combine([a,b])
    def test_overlapping_checkpoints_rejected(self):
        a=m.make_checkpoint(synthetic(START,START+100))
        b=m.make_checkpoint(synthetic(START+100,END))
        with self.assertRaisesRegex(c.SourceError,"missing or overlapping"):
            m.combine([a,b])
    def test_duplicate_checkpoint_rejected(self):
        a=m.make_checkpoint(synthetic(START,END))
        with self.assertRaisesRegex(c.SourceError,"missing or overlapping"):
            m.combine([a,a])
    def test_mixing_providers_is_not_source_authority(self):
        a=m.make_checkpoint(synthetic(START,START+100))
        b=m.make_checkpoint(synthetic(START+101,END,provider="publicnode"))
        with self.assertRaisesRegex(c.SourceError,"unrelated operators"):
            m.combine([a,b])
    def test_forged_checkpoint_report_digest_rejected(self):
        cp=m.make_checkpoint(synthetic())
        cp["report"]["operator_label"]="Fake"
        with self.assertRaisesRegex(c.SourceError,"content digest"):
            m.verify_checkpoint(cp)
    def test_source_code_hash_mismatch_rejected(self):
        cp=m.make_checkpoint(synthetic())
        cp["source_python_sha256"]="0"*64
        with self.assertRaisesRegex(c.SourceError,"source provenance"):
            m.verify_checkpoint(cp)
    def test_checkpoint_cannot_claim_own_profit(self):
        cp=m.make_checkpoint(synthetic())
        cp["nqc_realized_pnl_usd"]="999"
        with self.assertRaisesRegex(c.SourceError,"checkpoint promoted"):
            m.verify_checkpoint(cp)
    def test_empty_merge_rejected(self):
        with self.assertRaisesRegex(c.SourceError,"empty"):
            m.combine([])
    def test_immutable_file_never_overwrites_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"segment.json"
            a=m.make_checkpoint(synthetic(START,START+50))
            b=m.make_checkpoint(synthetic(START,START+51))
            m.write_new_immutable(path,a)
            m.write_new_immutable(path,deepcopy(a))
            with self.assertRaisesRegex(c.SourceError,"immutable checkpoint"):
                m.write_new_immutable(path,b)
            self.assertEqual(json.loads(path.read_text())["window_end"],START+50)
    def test_event_and_receipt_digests_are_content_bound(self):
        cp=m.make_checkpoint(synthetic(START,END,with_event=True))
        merged=m.combine([cp])
        self.assertEqual(merged["events_sha256"],
                         m.raw_sha(m.canonical(cp["report"]["events"])))
        self.assertEqual(merged["receipts_sha256"],
                         m.raw_sha(m.canonical(cp["report"]["receipt_checks"])))


if __name__=="__main__":
    unittest.main()
