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

    def test_permissionless_debt_is_outside_bounded_rejection_set(self) -> None:
        self.assertTrue(
            {"COLLATERALIZED_BORROWING", "PERSISTENT_DEBT"}.isdisjoint(mod.EXPECTED)
        )

    def test_one_registered_provider_invalidates_empty_rejection(self) -> None:
        provider = copy.deepcopy(PROVIDER)
        provider["status"] = "DECLARED_WITH_PROVIDERS_NOT_TERMINAL_EVIDENCE"
        provider["provider_count"] = 1
        provider["providers"] = [{
            "provider_id": "example",
            "families": ["EXTERNAL_GAS_CREDIT"],
            "authority_mode": "SIGNED_AND_CONTENT_ADDRESSED_PROVIDER_TRANSCRIPT",
            "terms_locator": "content-addressed:example",
            "provider_identity_commitment": "sha256:" + "1" * 64,
            "evidence_requirements": {
                "independent_provider_views": 2,
                "terms_valid_at_observation": True,
                "availability_observed": True,
            },
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

    def test_provider_registry_must_cover_every_bounded_family(self) -> None:
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
