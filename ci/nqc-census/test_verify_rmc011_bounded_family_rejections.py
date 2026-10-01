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

class BoundedFamilyRejectionTests(unittest.TestCase):
    def test_current_empty_surfaces_derive_exact_seven_bounded_rejections(self) -> None:
        result = mod.validate_documents(
            copy.deepcopy(PROVIDER),
            copy.deepcopy(PLAN),
        )
        self.assertEqual(result["family_count"], 7)
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
            mod.validate_documents(provider, copy.deepcopy(PLAN))

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
            mod.validate_documents(copy.deepcopy(PROVIDER), plan)

    def test_debt_families_are_not_part_of_bounded_rejection(self) -> None:
        result = mod.validate_documents(
            copy.deepcopy(PROVIDER),
            copy.deepcopy(PLAN),
        )
        self.assertEqual(result["family_count"], 7)
        self.assertFalse({"COLLATERALIZED_BORROWING", "PERSISTENT_DEBT"} & {
            row["family"] for row in result["families"]
        })

    def test_provider_registry_must_cover_all_bounded_families(self) -> None:
        provider = copy.deepcopy(PROVIDER)
        provider["provider_backed_families"].remove("EXTERNAL_GAS_CREDIT")
        with self.assertRaises((mod.RejectionError, ValueError)):
            mod.validate_documents(provider, copy.deepcopy(PLAN))

    def test_plan_family_set_must_be_exact(self) -> None:
        plan = copy.deepcopy(PLAN)
        plan["requirement_families"].pop()
        with self.assertRaises((mod.RejectionError, ValueError)):
            mod.validate_documents(copy.deepcopy(PROVIDER), plan)


if __name__ == "__main__":
    unittest.main()
