#!/usr/bin/env python3
"""Reconciler attacks: a second financing variant MUST NOT duplicate capture."""
from __future__ import annotations
import io
import json
import os
import tempfile
import zipfile
import unittest
from pathlib import Path
import reconcile_funding_mutex as m

def modified_zip(original,member,value):
    io_file=io.BytesIO()
    with zipfile.ZipFile(io_file,"w",compression=zipfile.ZIP_DEFLATED) as z:
        for name in original.namelist():
            z.writestr(name,value if name==member else original.read(name))
    io_file.seek(0)
    return zipfile.ZipFile(io_file)

class FundingConflictTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root=Path(os.environ["NQC_RMC_V2_EVIDENCE_DIR"])
        cls.original=m.read_archives(cls.root)

    def record(self):
        return m.reconcile(self.original)

    def fake(self,key,filename,mutate):
        original=self.original[key]
        doc=json.loads(original.read(filename))
        mutate(doc)
        corrupted=modified_zip(original,filename,json.dumps(doc).encode())
        try:
            return m.reconcile({**self.original,key:corrupted})
        finally:
            corrupted.close()

    def test_exact_artifact_hashes_and_four_evidence_sources(self):
        self.assertEqual(set(self.original),{"aave_seize","curve","fluid","aave_flash"})
        for label,(name,expected) in m.ARTIFACTS.items():
            self.assertEqual(m.sha((self.root/name).read_bytes()),expected)
        self.assertEqual(self.record()["artifact_sha256"],
                         {k:v[1] for k,v in m.ARTIFACTS.items()})

    def test_one_opportunity_two_execution_variants(self):
        record=self.record()
        c=record["candidates"]
        self.assertEqual(len(c),2)
        self.assertEqual({v["funding_source"] for v in c},
                         {"MORPHO_USDT","AAVE_USDTB"})
        self.assertEqual({v["opportunity_id"] for v in c},
                         {record["common_opportunity_id"]})
        self.assertEqual(len({v["variant_id"] for v in c}),2)
        self.assertTrue(record["cannot_sum_candidate_pnl"])
        self.assertTrue(record["one_capture_max_even_with_two_funding_variants"])
        self.assertEqual(record["opportunities_discovered_eligible"],0)

    def test_conditional_integer_amounts_and_differential(self):
        p=self.record()
        a,b=(int(q["conditional_pre_gas_builder_competition_usdt_micro"])
             for q in p["candidates"])
        self.assertEqual(a,12408499781)
        self.assertEqual(b,12172249334)
        self.assertEqual(a-b,236250447)
        self.assertEqual(p["aave_flash_premium_bps"],5)
        self.assertEqual(p["aave_flash_premium_usdtb_raw"],str(236*10**18))
        self.assertFalse(p["provider_nominal_cash_committed_to_nqc"])

    def test_no_income_or_sponsored_gas_or_p2_claim(self):
        r=self.record()
        self.assertFalse(r["liquidation_executed"])
        self.assertFalse(r["shadow_p2_certified"])
        self.assertFalse(r["commercial_score_upgrade"])
        self.assertFalse(r["rmc_closed"])
        self.assertFalse(r["zero_own_capital_gas_sponsorship_proven"])
        self.assertIsNone(r["full_route_pnl_usd"])
        self.assertEqual(r["realized_nqc_pnl_usd"],"0")
        self.assertTrue(r["historical_single_provider_sources_not_prospective"])
        for c in r["candidates"]:
            self.assertFalse(c["full_route_fork_certified"])
            self.assertFalse(c["aave_liquidation_executed"])
            self.assertFalse(c["p2_shadow_admitted"])
            self.assertIsNone(c["nqc_net_pnl_usd"])

    def test_tampered_outer_zip_digest_rejected(self):
        name=m.ARTIFACTS["aave_flash"][0]
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp)
            for filename,_ in m.ARTIFACTS.values():
                (d/filename).write_bytes((self.root/filename).read_bytes())
            with (d/name).open("ab") as file:
                file.write(b"not authorized")
            with self.assertRaisesRegex(m.EvidenceRejected,"archive digest mismatch"):
                m.read_archives(d)

    def test_reject_fee_if_production_state_forged(self):
        with self.assertRaisesRegex(m.EvidenceRejected,"flash premium unverified"):
            self.fake("aave_flash","reserve-snapshot.json",
                      lambda d:d.update(flash_premium_total_bps=0))

    def test_reject_flash_nominal_capacity_treated_as_committed(self):
        with self.assertRaisesRegex(m.EvidenceRejected,"provider overstated availability"):
            self.fake("aave_flash","reserve-snapshot.json",
                      lambda d:d.update(capital_committed_to_nqc=True))

    def test_reject_fake_operator_funded_gas(self):
        with self.assertRaisesRegex(m.EvidenceRejected,"provider overstated availability"):
            self.fake("aave_flash","reserve-snapshot.json",
                      lambda d:d.update(external_gas_source_known=True))

    def test_reject_wrong_flash_cash(self):
        with self.assertRaisesRegex(m.EvidenceRejected,"nominal token balance insufficient"):
            self.fake("aave_flash","reserve-snapshot.json",
                      lambda d:d.update(aave_usdtb_underlying_raw="1"))

    def test_reject_wrong_original_block_hash(self):
        with self.assertRaisesRegex(m.EvidenceRejected,"identical canonical historical block"):
            self.fake("aave_flash","pinned-block.json",
                      lambda d:d.update(hash="0x"+"0"*64))

    def test_reject_wrong_aave_bonus(self):
        with self.assertRaisesRegex(m.EvidenceRejected,"borrower, emode or fee"):
            self.fake("aave_seize","conditional-seizure-budget.json",
                      lambda d:d.update(emode_bonus_bps=10200))

    def test_reject_collateral_fee_arithmetic_fraud(self):
        with self.assertRaisesRegex(m.EvidenceRejected,"protocol-fee or net"):
            self.fake("aave_seize","conditional-seizure-budget.json",
                      lambda d:d.update(conditional_protocol_fee_susde_raw="0"))

    def test_reject_aave_hf_below_one_forgery(self):
        with self.assertRaisesRegex(m.EvidenceRejected,"false liquidation"):
            self.fake("aave_seize","conditional-seizure-budget.json",
                      lambda d:d.update(health_factor_below_one=True))

    def test_reject_fake_aave_profit(self):
        with self.assertRaisesRegex(m.EvidenceRejected,"false liquidation"):
            self.fake("aave_seize","conditional-seizure-budget.json",
                      lambda d:d.update(nqc_realized_pnl_usd="12000"))

    def test_reject_larger_outside_net_collateral(self):
        with self.assertRaises(m.EvidenceRejected):
            self.fake("aave_seize","conditional-seizure-budget.json",
                      lambda d:d.update(conditional_liquidator_net_susde_raw=str(388000*10**18)))

    def test_reject_fluid_fork_output_event_manipulation(self):
        original=self.original["fluid"]
        text=original.read("fork-tests.txt").decode()
        self.assertIn("NQC_AAVE_CONDITIONAL_NET_FLUID_USDT_RAW: 484870110578",text)
        corrupted=modified_zip(original,"fork-tests.txt",text.replace(
            "NQC_AAVE_CONDITIONAL_NET_FLUID_USDT_RAW: 484870110578",
            "NQC_AAVE_CONDITIONAL_NET_FLUID_USDT_RAW: 999999999999").encode())
        try:
            with self.assertRaisesRegex(m.EvidenceRejected,"Fluid actual balance delta"):
                m.reconcile({**self.original,"fluid":corrupted})
        finally:corrupted.close()

    def test_reject_curve_fork_missing_exact_proof(self):
        original=self.original["curve"]
        t=original.read("fork-tests.txt").decode()
        corrupted=modified_zip(original,"fork-tests.txt",t.replace(
            "testRealMorphoCurveOneAdditionalUSDTBaseUnitMeetsFormerTarget",
            "testRemovedEvidence").encode())
        try:
            with self.assertRaisesRegex(m.EvidenceRejected,"missing actual fork PASS"):
                m.reconcile({**self.original,"curve":corrupted})
        finally:corrupted.close()

    def test_no_cross_chain_or_double_credit(self):
        r=self.record()
        self.assertEqual(r["chain_id"],1)
        self.assertEqual(r["block_number"],26184741)
        self.assertIn("SAME_BORROWER",r["same_borrower_conflict_keys"])
        self.assertIn("SAME_ETHEREUM_BLOCK",r["same_borrower_conflict_keys"])

if __name__=="__main__":unittest.main()
