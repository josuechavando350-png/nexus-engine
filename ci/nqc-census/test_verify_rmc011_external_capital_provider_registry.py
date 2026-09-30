#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-external-capital-provider-registry.py")
SPEC = importlib.util.spec_from_file_location("rmc011_external_registry", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

REGISTRY = json.loads(
    Path("ci/nqc-census/rmc011-external-capital-provider-registry.json").read_text()
)


class ExternalProviderRegistryTests(unittest.TestCase):
    def test_current_empty_registry_is_explicit_nonterminal_negative_fact(self) -> None:
        result = mod.validate_document(copy.deepcopy(REGISTRY))
        self.assertEqual(result["provider_count"], 0)
        self.assertFalse(result["terminal_evidence"])
        self.assertFalse(result["global_nonexistence_claimed"])

    def test_empty_registry_cannot_claim_terminal_evidence(self) -> None:
        doc = copy.deepcopy(REGISTRY)
        doc["terminal_semantics"]["terminal_rejection_requires_authenticated_workflow_artifact"] = False
        with self.assertRaises(mod.RegistryError):
            mod.validate_document(doc)

    def test_empty_registry_cannot_claim_global_nonexistence(self) -> None:
        doc = copy.deepcopy(REGISTRY)
        doc["terminal_semantics"]["does_not_mean"] = "NO_PROVIDER_EXISTS_ANYWHERE"
        with self.assertRaises(mod.RegistryError):
            mod.validate_document(doc)

    def test_family_omission_fails(self) -> None:
        doc = copy.deepcopy(REGISTRY)
        doc["provider_backed_families"].pop()
        with self.assertRaises(mod.RegistryError):
            mod.validate_document(doc)

    def test_provider_count_mismatch_fails(self) -> None:
        doc = copy.deepcopy(REGISTRY)
        doc["provider_count"] = 1
        with self.assertRaises(mod.RegistryError):
            mod.validate_document(doc)

    def test_nonempty_provider_requires_dual_authenticated_evidence(self) -> None:
        doc = copy.deepcopy(REGISTRY)
        doc["status"] = "DECLARED_WITH_PROVIDERS_NOT_TERMINAL_EVIDENCE"
        doc["provider_count"] = 1
        doc["providers"] = [{
            "provider_id": "example",
            "families": ["EXTERNAL_GAS_CREDIT"],
            "authority_mode": "SIGNED_PROVIDER_TRANSCRIPT",
            "terms_locator": "content-addressed:example",
            "provider_identity_commitment": "sha256:example",
            "evidence_requirements": {
                "independent_provider_views": 1,
                "terms_valid_at_observation": True,
                "availability_observed": True,
            },
        }]
        with self.assertRaises(mod.RegistryError):
            mod.validate_document(doc)

    def test_registry_rejects_credentials(self) -> None:
        doc = copy.deepcopy(REGISTRY)
        doc["status"] = "DECLARED_WITH_PROVIDERS_NOT_TERMINAL_EVIDENCE"
        doc["provider_count"] = 1
        doc["providers"] = [{
            "provider_id": "example",
            "families": ["EXTERNAL_GAS_SPONSOR"],
            "authority_mode": "CONTENT_ADDRESSED_PROVIDER_TRANSCRIPT",
            "terms_locator": "content-addressed:example",
            "provider_identity_commitment": "sha256:example",
            "api_key": "must-never-appear",
            "evidence_requirements": {
                "independent_provider_views": 2,
                "terms_valid_at_observation": True,
                "availability_observed": True,
            },
        }]
        with self.assertRaises(mod.RegistryError):
            mod.validate_document(doc)


if __name__ == "__main__":
    unittest.main()
