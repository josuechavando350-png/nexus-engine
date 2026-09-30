from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-bounded-family-rejections.py")
SPEC = importlib.util.spec_from_file_location("rmc011_bounded_rejections", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

PROVIDER = json.loads(
    Path("ci/nqc-census/rmc011-external-capital-provider-registry.json").read_text()
)
PLAN = json.loads(
    Path("ci/nqc-census/rmc011-execution-plan-requirement-catalog.json").read_text()
)
DEBT = json.loads(
    Path("ci/nqc-census/rmc011-permissionless-debt-facility-catalog.json").read_text()
)


class BoundedFamilyRejectionTests(unittest.TestCase):
    def test_current_empty_surfaces_derive_exact_nine_bounded_rejections(self) -> None:
        result = mod.validate_documents(
            copy.deepcopy(PROVIDER),
            copy.deepcopy(PLAN),
            copy.deepcopy(DEBT),
        )
        self.assertEqual(result["family_count"], 9)
        self.assertEqual(
            {row["family"] for row in result["families"]},
            mod.EXPECTED,
        )
        self.assertFalse(result["global_nonexistence_claimed"])
        self.assertFalse(result["source_availability_claimed"])
        self.assertFalse(result["d11_terminal_closed"])

    def test_one_registered_provider_invalidates_empty_rejection(self) -> None:
        provider = copy.deepcopy(PROVIDER)
        provider["status"] = "DECLARED_WITH_PROVIDERS_NOT_TERMINAL_EVIDENCE"
        provider["provider_count"] = 1
        provider["providers"] = [{
            "provider_id": "provider-a",
            "family": "EXTERNAL_GAS_CREDIT",
            "provider_kind": "EXTERNAL_CREDIT_FACILITY",
            "identity_sha256": "1" * 64,
            "admission_status": "DECLARED_NOT_AUTHENTICATED",
            "evidence": ["content-addressed:provider-a"],
        }]
        with self.assertRaises((mod.RejectionError, ValueError)):
            mod.validate_documents(provider, copy.deepcopy(PLAN), copy.deepcopy(DEBT))

    def test_one_supported_execution_plan_invalidates_empty_rejection(self) -> None:
        plan = copy.deepcopy(PLAN)
        plan["status"] = "DECLARED_WITH_PLANS_NOT_TERMINAL_EVIDENCE"
        plan["plan_count"] = 1
        plan["plans"] = [{
            "plan_id": "plan-a",
            "plan_sha256": "1" * 64,
            "admission_status": "SUPPORTED",
            "requirements": [{
                "family": "BOND_OR_STAKE",
                "requirement_kind": "BOND_OR_STAKE",
                "allowed_classes": ["BOND_OR_STAKE"],
                "asset_source": "plan.bond_asset",
                "amount_source": "plan.bond_amount",
            }],
            "evidence": ["content-addressed:plan-a"],
        }]
        with self.assertRaises((mod.RejectionError, ValueError)):
            mod.validate_documents(copy.deepcopy(PROVIDER), plan, copy.deepcopy(DEBT))

    def test_one_permissionless_debt_facility_invalidates_empty_rejection(self) -> None:
        debt = copy.deepcopy(DEBT)
        debt["status"] = "DECLARED_WITH_FACILITIES_NOT_TERMINAL_EVIDENCE"
        debt["facility_count"] = 1
        debt["facilities"] = [{
            "family": "PERSISTENT_DEBT",
            "chain_id": 1,
            "facility_address": "0x" + "11" * 20,
            "principal_asset": "TOKEN:" + "22" * 20,
            "collateral_asset": "TOKEN:" + "33" * 20,
            "runtime_code_hash": "0x" + "44" * 32,
            "deployment_provenance": {
                "kind": "OFFICIAL_UPSTREAM_DEPLOYMENT",
                "source": "fixture://persistent-debt",
                "sha256": "55" * 32,
            },
            "interest_model_hash": "0x" + "61" * 32,
            "liquidation_model_hash": "0x" + "62" * 32,
            "solvency_model_hash": "0x" + "63" * 32,
            "oracle_risk_hash": "0x" + "64" * 32,
            "liquidity_withdrawal_risk_hash": "0x" + "65" * 32,
            "facility_disappearance_risk_hash": "0x" + "66" * 32,
            "declaration_sha256": "77" * 32,
            "admission_status": "DECLARED_NOT_AUTHENTICATED",
        }]
        with self.assertRaises((mod.RejectionError, ValueError)):
            mod.validate_documents(copy.deepcopy(PROVIDER), copy.deepcopy(PLAN), debt)

    def test_provider_registry_must_cover_all_bounded_families(self) -> None:
        provider = copy.deepcopy(PROVIDER)
        provider["provider_backed_families"].remove("PERSISTENT_DEBT")
        with self.assertRaises((mod.RejectionError, ValueError)):
            mod.validate_documents(provider, copy.deepcopy(PLAN), copy.deepcopy(DEBT))

    def test_plan_family_set_must_be_exact(self) -> None:
        plan = copy.deepcopy(PLAN)
        plan["requirement_families"].pop()
        with self.assertRaises((mod.RejectionError, ValueError)):
            mod.validate_documents(copy.deepcopy(PROVIDER), plan, copy.deepcopy(DEBT))

    def test_debt_family_set_must_be_exact(self) -> None:
        debt = copy.deepcopy(DEBT)
        debt["families"].pop()
        with self.assertRaises((mod.RejectionError, ValueError)):
            mod.validate_documents(copy.deepcopy(PROVIDER), copy.deepcopy(PLAN), debt)


if __name__ == "__main__":
    unittest.main()
