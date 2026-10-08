#!/usr/bin/env python3
"""Fail-closed real current Census authority readiness; never self-certify."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import rmc017_source_lock_readiness as m

REPO = Path(__file__).resolve().parents[2]

def d17_source():
    return {
      "schema_version":1,
      "status":"BLOCKED_AWAITING_RMC014_RMC015_RMC016",
      "repository":"josuechavando350-png/nexus-engine",
      "real_market_census_closed":False,
      "rmc014":None,
      "rmc015":None,
      "rmc016":None,
      "blocking_reasons":[
        "RMC014_STRUCTURAL_AUTHORITY_NOT_PINNED",
        "RMC015_TEMPORAL_AUTHORITY_NOT_PINNED",
        "RMC016_CAPACITY_AUTHORITY_NOT_PINNED",
      ],
    }

def sources():
    return m.read_stage_sources(REPO)

def valid():
    return m.validate_local_sources(sources(),d17_source())


class TestReadinessNoFakeTerminalCertificate(unittest.TestCase):
    def test_original_8_source_blob_invariants(self):
        self.assertEqual(len(m.SOURCES),8)
        for name,(path,oid) in m.SOURCES.items():
            blob=(REPO/path).read_bytes()
            self.assertEqual(m.gitblob(blob),oid,name)

    def test_negative_source_is_still_real_verified_work(self):
        report=valid()
        self.assertEqual(report["status"],
            "RMC017_READINESS_EVIDENCE_BLOCKED_NO_TERMINAL_CERTIFICATE")
        self.assertEqual(report["rmc011_required_capital_families"],13)
        self.assertEqual(report["rmc011_terminally_resolved_families"],0)
        self.assertEqual(report["rmc011_approved_external_providers"],0)
        self.assertEqual(report["rmc014_required_structural_stages"],8)
        self.assertEqual(report["rmc014_structural_stage_pins_in_canonical_source_lock"],0)
        self.assertTrue(report["rmc016_pre_shadow_conservative_model_report_pass"])
        self.assertEqual(report["rmc016_127_historical_competitor_receipts_observed"],127)
        self.assertEqual(report["rmc016_conservative_nqc_monthly_capacity_usd_wad"],"0")

    def test_readiness_cannot_fake_any_positive_authority(self):
        r=valid()
        for key in (
           "rmc011_global_external_provider_nonexistence_proven",
           "rmc012_terminal_authority_obtained",
           "rmc013_complete_execution_economics_authority_obtained",
           "rmc015_temporal_authority_pinned",
           "rmc015_historical_window_declared",
           "rmc015_structural_and_provider_sources_ready",
           "rmc016_nqc_ex_ante_capture_probability_calibrated",
           "rmc017_final_all_three_authorities_pinned",
           "rmc017_ready_for_terminal_certificate",
           "nqc_zero_owned_capital_production_liquidation_authorized",
           "nqc_realized_profitability_proven",
           "real_market_census_closed",
           "engineering_percentage_certifiable_from_these_locks",
        ):
            self.assertIs(r[key],False,key)
        self.assertNotIn("REAL_MARKET_CENSUS_CLOSED",r["status"])

    def test_false_external_provider_count_fails(self):
        d=sources()
        d["rmc011_approved_providers"]["provider_count"]=1
        d["rmc011_approved_providers"]["providers"]=[{"id":"fabricated"}]
        with self.assertRaisesRegex(ValueError,"zero authorized"):
            m.validate_local_sources(d,d17_source())

    def test_source_universe_cannot_be_claimed_complete(self):
        d=sources()
        d["rmc011_source_universe"]["family_universe_discovery"]["status"]="CERTIFIED"
        with self.assertRaisesRegex(ValueError,"source family universe"):
            m.validate_local_sources(d,d17_source())

    def test_thirteen_required_families_must_not_be_trimmed(self):
        d=sources()
        d["rmc011_source_universe"]["families"].pop()
        with self.assertRaisesRegex(ValueError,"13 real"):
            m.validate_local_sources(d,d17_source())

    def test_partial_source_family_cannot_fake_resolution(self):
        d=sources()
        d["rmc011_source_universe"]["families"][0]["terminally_resolved"]=True
        with self.assertRaisesRegex(ValueError,"source claims changed"):
            m.validate_local_sources(d,d17_source())

    def test_gas_universe_cannot_hide_missing_credit_class(self):
        d=sources()
        d["rmc011_source_universe"]["families"][4]["capital_class"]="NOT_GAS"
        with self.assertRaisesRegex(ValueError,"gas funder classes"):
            m.validate_local_sources(d,d17_source())

    def test_d12_requires_real_d11(self):
        d=sources()
        d["rmc012_terminal_inputs"]["d11"]={"fake":"proof"}
        with self.assertRaisesRegex(ValueError,"RMC012"):
            m.validate_local_sources(d,d17_source())

    def test_d13_cannot_close_with_fake_economics(self):
        d=sources()
        d["rmc013_terminal_inputs"]["execution_evidence"]={"fake":"execution"}
        with self.assertRaisesRegex(ValueError,"RMC013"):
            m.validate_local_sources(d,d17_source())

    def test_d14_cannot_self_pin_structural_stages(self):
        d=sources()
        d["rmc014_structural_lock"]["pinned_stages"]=[{"stage":"RMC-006"}]
        with self.assertRaisesRegex(ValueError,"RMC014"):
            m.validate_local_sources(d,d17_source())

    def test_d14_cannot_self_close(self):
        d=sources()
        d["rmc014_structural_lock"]["real_market_census_closed"]=True
        with self.assertRaisesRegex(ValueError,"RMC014"):
            m.validate_local_sources(d,d17_source())

    def test_d15_empty_providers_not_dual_rpc_full_acquisition(self):
        d=sources()
        d["rmc015_trigger_inputs"]["status"]="PINNED"
        with self.assertRaisesRegex(ValueError,"RMC015"):
            m.validate_local_sources(d,d17_source())

    def test_d16_pre_shadow_model_not_capture_authority(self):
        d=sources()
        d["rmc016_capacity_inputs"]["capture_probability"]="0.99"
        with self.assertRaisesRegex(ValueError,"RMC016"):
            m.validate_local_sources(d,d17_source())

    def test_d16_one_positive_cent_injected_fails(self):
        d=sources()
        d["rmc016_real_evidence"]["authority"]["nqc_conservative_realizable_monthly_capacity_usd_wad"]="1"
        with self.assertRaisesRegex(ValueError,"source-supported"):
            m.validate_local_sources(d,d17_source())

    def test_d17_foundation_never_fakes_full_three_authorities(self):
        d=d17_source()
        d["rmc014"]={"fake":"structural"}
        with self.assertRaisesRegex(ValueError,"separate D17"):
            m.validate_local_sources(sources(),d)
        d=d17_source()
        d["real_market_census_closed"]=True
        with self.assertRaisesRegex(ValueError,"separate D17"):
            m.validate_local_sources(sources(),d)

    def test_d17_json_duplicate_keys_rejected(self):
        with self.assertRaisesRegex(ValueError,"duplicate"):
            m.read_json(b'{"real_market_census_closed":false,"real_market_census_closed":true}')

    def test_immutable_input_source_tampering_fails_before_semantics(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            for name,(relative,expected) in m.SOURCES.items():
                dest=root/relative
                dest.parent.mkdir(parents=True,exist_ok=True)
                dest.write_bytes((REPO/relative).read_bytes())
            lock=root/m.SOURCES["rmc014_structural_lock"][0]
            lock.write_bytes(lock.read_bytes()+b"\n")
            with self.assertRaisesRegex(ValueError,"Git blob drift"):
                m.read_stage_sources(root)

    def test_full_d17_source_file_commitment_and_determinism(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"d17-source.json"
            blob=m.canon(d17_source())
            path.write_bytes(blob)
            with patch.object(m,"D17_SOURCE_BLOB",m.gitblob(blob)):
                a=m.assess(REPO,path)
                b=m.assess(REPO,path)
                self.assertEqual(a,b)
                self.assertEqual(a["report_sha256"],m.digest(m.canon(
                    {k:v for k,v in a.items() if k!="report_sha256"})))
                path.write_bytes(blob.replace(b'false',b'true',1))
                with self.assertRaisesRegex(ValueError,"source Git blob drift"):
                    m.assess(REPO,path)


if __name__=="__main__":
    unittest.main()
