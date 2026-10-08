#!/usr/bin/env python3
"""Adversarial tests with TWO original independently audited source reports.

The actual public GitHub Actions audit ZIP bytes are the ONLY positive inputs.
No simulation, future market state, native gas permission or fabricated capital.
"""
from __future__ import annotations
import argparse
import copy
from pathlib import Path
import unittest

import rmc011_four_native_original_source_join as j

parser=argparse.ArgumentParser(add_help=False)
for label in ("d08-zip","d08-run","d08-artifact","dual-zip","dual-run","dual-artifact"):
    parser.add_argument("--"+label,type=Path,required=True)


class FourNativeSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d08=j.exact_report(ARGS.d08_zip,"d08")
        cls.dual=j.exact_report(ARGS.dual_zip,"dual")
        cls.run1=j.load(ARGS.d08_run.read_bytes())
        cls.art1=j.load(ARGS.d08_artifact.read_bytes())
        cls.run2=j.load(ARGS.dual_run.read_bytes())
        cls.art2=j.load(ARGS.dual_artifact.read_bytes())
        cls.universe=Path("ci/nqc-census/rmc011-capital-source-universe.json").read_bytes()
        cls.providers=Path("ci/nqc-census/rmc011-external-capital-provider-registry.json").read_bytes()
        cls.final=Path("ci/nqc-census/final-census-authority-lock.json").read_bytes()

    def join(self,**change):
        args={
            "source1":copy.deepcopy(self.d08),
            "source2":copy.deepcopy(self.dual),
            "run1":copy.deepcopy(self.run1),
            "art1":copy.deepcopy(self.art1),
            "run2":copy.deepcopy(self.run2),
            "art2":copy.deepcopy(self.art2),
            "universe":self.universe,
            "providers":self.providers,
            "final":self.final,
            "head":"b"*40,
            "tree":"c"*40,
            "run_id":77777,
            "attempt":1,
        }
        args.update(change)
        return j.make_package(**args)

    def reject(self,message,**changes):
        with self.assertRaisesRegex(ValueError,message):
            self.join(**changes)

    def test_two_original_report_zip_byte_commits_are_exact(self):
        self.assertEqual(self.d08["source_run_id"],j.D08_RUN)
        self.assertEqual(self.dual["original_capture_producer_run_id"],37689816997)

    def test_no_source_attests_to_positive_executable_gas(self):
        _,summary=self.join()
        self.assertEqual(summary["external_native_eth_gas_sponsors_admitted"],0)
        self.assertEqual(summary["nqc_realized_net_usd_wad"],"0")
        self.assertFalse(summary["rmc011_terminal_closed"])
        self.assertFalse(summary["real_market_census_closed"])

    def test_four_unique_per_family_source_witnesses(self):
        files,summary=self.join()
        self.assertEqual(summary["source_family_count"],4)
        evidence=[n for n in files if n.endswith("/evidence.json")]
        self.assertEqual(len(evidence),4)
        self.assertEqual(len({j.hash_bytes(files[n]) for n in evidence}),4)
        self.assertEqual(set(summary["source_families"]),set(j.FAMILIES))

    def test_aave_v3_and_uni_v2_are_historic_sources_not_executions(self):
        files,_=self.join()
        for family,count in (("AAVE_V3_FLASH_LOAN",67),("UNISWAP_V2_FLASH_SWAP",1045392)):
            v=j.load(files[f"protocol-family-evidence/families/{family}/evidence.json"])
            self.assertEqual(v["original_historical_source_count"],count)
            self.assertIsNone(v["source_execution_eligible_count"])
            self.assertTrue(v["source_execution_eligibility_not_yet_reconstructed"])
            self.assertFalse(v["terminal_d11_closed"])

    def test_balancer_and_univ3_protocol_sources_both_ineligible(self):
        files,_=self.join()
        for fam,n in (("BALANCER_V2_FLASH_LOAN",67),("UNISWAP_V3_FLASH",69748)):
            v=j.load(files[f"protocol-family-evidence/families/{fam}/evidence.json"])
            self.assertEqual(v["original_historical_source_count"],n)
            self.assertEqual(v["source_execution_eligible_count"],0)
            self.assertFalse(v["source_execution_eligibility_not_yet_reconstructed"])
            self.assertTrue(v["two_distinct_rpc_operators_verified"])

    def test_two_input_auditor_sources_share_exact_D08_manifest(self):
        row=j.validate_sources(self.d08,self.dual,self.universe,self.providers,self.final)
        self.assertEqual(row["authority_sha256"],j.D08_ORIGINAL_MANIFEST_SHA)

    def test_source_zip_wrong_outer_sha_rejected(self):
        with self.assertRaisesRegex(ValueError,"ZIP digest"):
            j.exact_report(ARGS.d08_zip,"dual")

    def test_duplicate_source_report_keys_rejected(self):
        with self.assertRaisesRegex(ValueError,"duplicate source JSON"):
            j.load(b'{"source_count":0,"source_count":100}')

    def test_original_d08_auditor_must_have_successful_run(self):
        fake=copy.deepcopy(self.run1)
        fake["conclusion"]="failure"
        self.reject("d08: original independent source workflow",run1=fake)

    def test_original_dual_auditor_must_have_successful_run(self):
        fake=copy.deepcopy(self.run2)
        fake["conclusion"]="failure"
        self.reject("dual: original independent source workflow",run2=fake)

    def test_original_d08_artifact_digest_forgery_fails(self):
        fake=copy.deepcopy(self.art1)
        fake["digest"]="sha256:"+"0"*64
        self.reject("d08: original independent source artifact",art1=fake)

    def test_original_dual_source_provenance_mismatch_fails(self):
        fake=copy.deepcopy(self.art2)
        fake["workflow_run"]["head_sha"]="e"*40
        self.reject("dual: original independent source artifact",art2=fake)

    def test_forged_positive_profit_from_D08_rejected(self):
        fake=copy.deepcopy(self.d08)
        fake["nqc_realized_pnl_usd_wad"]="100000000"
        self.reject("D08 historic source evidence",source1=fake)

    def test_forged_positive_native_liquidity_eligibility_rejected(self):
        fake=copy.deepcopy(self.dual)
        fake["historical_sources_recorded_execution_eligible"]=1
        self.reject("original dual-provider evidence",source2=fake)

    def test_forged_balancer_source_count_rejected(self):
        fake=copy.deepcopy(self.dual)
        fake["original_source_family_evidence"]["BALANCER_V2_FLASH_LOAN"]["source_count_historical"]=68
        self.reject("BALANCER_V2_FLASH_LOAN",source2=fake)

    def test_forged_uniswap_v3_source_count_rejected(self):
        fake=copy.deepcopy(self.dual)
        fake["original_source_family_evidence"]["UNISWAP_V3_FLASH"]["source_count_historical"]=69749
        self.reject("UNISWAP_V3_FLASH",source2=fake)

    def test_original_universe_cannot_self_promote_d11(self):
        doc=j.load(self.universe)
        doc["d11_terminal_closed"]=True
        self.reject("9/13 canonical family source lock drifted",universe=j.canonical(doc))

    def test_external_native_gas_sponsor_cannot_be_fabricated(self):
        doc=j.load(self.providers)
        doc["provider_count"]=1
        doc["providers"]=[{"fabricated":True}]
        self.reject("provider registry drifted",providers=j.canonical(doc))

    def test_invalid_census_final_lock_rejected(self):
        doc=j.load(self.final)
        doc["real_market_census_closed"]=True
        self.reject("final Census lock drifted",final=j.canonical(doc))

    def test_summary_content_address_and_determinism(self):
        a,summary=self.join()
        b,again=self.join()
        self.assertEqual(a,b)
        self.assertEqual(summary,again)
        self.assertEqual(summary["report_sha256"],
                         j.hash_bytes(j.canonical({k:v for k,v in summary.items()
                                                     if k!="report_sha256"})))

    def test_source_certification_does_not_imply_current_capture_or_profit(self):
        _,s=self.join()
        self.assertFalse(s["all_native_families_terminally_source_pinned_here"])
        self.assertFalse(s["family_universe_discovery_closed"])
        self.assertFalse(s["global_protocol_source_nonexistence_claimed"])
        self.assertFalse(s["original_d08_aave_and_univ2_execution_eligibility_certified_here"])
        self.assertEqual(s["original_balancer_and_univ3_execution_eligible_sources"],0)


if __name__=="__main__":
    ARGS,extra=parser.parse_known_args()
    unittest.main(argv=[__file__]+extra,verbosity=2)
