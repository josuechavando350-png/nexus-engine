#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-capital-family-discovery.py")
SPEC = importlib.util.spec_from_file_location("rmc011_discovery", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

DISCOVERY = json.loads(Path("ci/nqc-census/rmc011-capital-family-discovery.json").read_text())
UNIVERSE = json.loads(Path("ci/nqc-census/rmc011-capital-source-universe.json").read_text())
DEPLOYMENT = json.loads(Path("ci/nqc-census/rmc011-uniswap-v3-deployment.json").read_text())


def validate(discovery: dict, universe: dict | None = None, deployment: dict | None = None) -> dict:
    return mod.validate_document(
        discovery,
        copy.deepcopy(UNIVERSE) if universe is None else universe,
        copy.deepcopy(DEPLOYMENT) if deployment is None else deployment,
    )


class DiscoveryContractTests(unittest.TestCase):
    def test_current_contract_covers_exact_universe(self) -> None:
        result = validate(copy.deepcopy(DISCOVERY))
        self.assertEqual(result["family_count"], 13)
        self.assertTrue(result["cross_checked_universe"])
        self.assertTrue(result["uniswap_v3_deployment_verified"])
        self.assertEqual(
            result["uniswap_v3_factory"],
            "0x1f98431c8ad98523631ae4a59f267346ea31f984",
        )

    def test_missing_family_fails(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        doc["families"].pop()
        with self.assertRaises(mod.DiscoveryError):
            validate(doc)

    def test_unknown_family_fails(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        doc["families"][0]["id"] = "UNKNOWN_CAPITAL_FAMILY"
        with self.assertRaises(mod.DiscoveryError):
            validate(doc)

    def test_blank_completeness_rule_fails(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        doc["families"][0]["completeness"] = ""
        with self.assertRaises(mod.DiscoveryError):
            validate(doc)

    def test_historical_t36_cannot_be_balancer_d11_authority(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        row = next(row for row in doc["families"] if row["id"] == "BALANCER_V2_FLASH_LOAN")
        row["authority"] = "T36_HISTORICAL_FORK"
        with self.assertRaises(mod.DiscoveryError):
            validate(doc)

    def test_external_credit_cannot_drop_registry_enumeration(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        row = next(row for row in doc["families"] if row["id"] == "EXTERNAL_GAS_CREDIT")
        row["surface"] = "AD_HOC_PROVIDER"
        with self.assertRaises(mod.DiscoveryError):
            validate(doc)

    def test_universe_family_set_mismatch_fails(self) -> None:
        universe = copy.deepcopy(UNIVERSE)
        universe["families"].pop()
        with self.assertRaises(mod.DiscoveryError):
            validate(copy.deepcopy(DISCOVERY), universe=universe)

    def test_uniswap_v3_factory_address_tamper_fails(self) -> None:
        deployment = copy.deepcopy(DEPLOYMENT)
        deployment["deployment_root"]["address"] = "0x0000000000000000000000000000000000000001"
        with self.assertRaises(mod.DiscoveryError):
            validate(copy.deepcopy(DISCOVERY), deployment=deployment)

    def test_uniswap_v3_upstream_blob_tamper_fails(self) -> None:
        deployment = copy.deepcopy(DEPLOYMENT)
        deployment["deployment_root"]["provenance"]["blob_sha"] = "0" * 40
        with self.assertRaises(mod.DiscoveryError):
            validate(copy.deepcopy(DISCOVERY), deployment=deployment)

    def test_uniswap_v3_metadata_cannot_claim_terminal_resolution(self) -> None:
        deployment = copy.deepcopy(DEPLOYMENT)
        deployment["runtime_requirements"]["terminal_resolution_claimed"] = True
        with self.assertRaises(mod.DiscoveryError):
            validate(copy.deepcopy(DISCOVERY), deployment=deployment)

    def test_uniswap_v3_documentation_must_remain_non_authoritative(self) -> None:
        deployment = copy.deepcopy(DEPLOYMENT)
        deployment["non_claims"].remove("FACTORY_DOCUMENTATION_IS_NOT_RUNTIME_AUTHORITY")
        with self.assertRaises(mod.DiscoveryError):
            validate(copy.deepcopy(DISCOVERY), deployment=deployment)

    def test_uniswap_v3_requires_complete_poolcreated_history(self) -> None:
        deployment = copy.deepcopy(DEPLOYMENT)
        deployment["runtime_requirements"]["full_log_history_through_anchor_required"] = False
        with self.assertRaises(mod.DiscoveryError):
            validate(copy.deepcopy(DISCOVERY), deployment=deployment)


    def test_collateralized_borrowing_requires_permissionless_catalog(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        row = next(
            row for row in doc["families"]
            if row["id"] == "COLLATERALIZED_BORROWING"
        )
        row["implementation"] = "nqc-census/crates/nqc-census-capital/src/external_debt.rs"
        with self.assertRaises(mod.DiscoveryError):
            validate(doc)

    def test_persistent_debt_requires_permissionless_catalog_verifier(self) -> None:
        doc = copy.deepcopy(DISCOVERY)
        row = next(
            row for row in doc["families"]
            if row["id"] == "PERSISTENT_DEBT"
        )
        row["implementation"] = (
            "nqc-census/crates/nqc-census-capital/src/external_debt.rs + "
            "ci/nqc-census/rmc011-permissionless-debt-facility-catalog.json"
        )
        with self.assertRaises(mod.DiscoveryError):
            validate(doc)


if __name__ == "__main__":
    unittest.main()
