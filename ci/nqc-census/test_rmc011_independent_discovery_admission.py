#!/usr/bin/env python3
"""Real published discovery bytes are the only positive fixture.

Semantic-layer mutations deliberately rebind hashes to exercise inner guards;
they are never accepted through the pinned ZIP/certificate authority envelope.
"""
from __future__ import annotations
import argparse
import copy
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

import rmc011_independent_discovery_admission as proof


class IndependentDiscoveryAdmissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = ARGS.zip.read_bytes()
        cls.metadata = {name: proof.parse(getattr(ARGS, name).read_bytes())
                        for name in ("run", "artifact", "commit")}
        cls.members = proof.open_archive(cls.raw)
        root = Path("ci/nqc-census")
        cls.universe = (root / "rmc011-capital-source-universe.json").read_bytes()
        cls.scope = (root / "capital-census-scope.json").read_bytes()
        cls.discovery = (root / "rmc011-capital-family-discovery.json").read_bytes()

    def audit(self, **changes):
        kwargs = dict(zip_raw=self.raw, **copy.deepcopy(self.metadata),
                      source_universe=self.universe, scope=self.scope, discovery=self.discovery)
        kwargs.update(changes)
        return proof.verify(**kwargs)

    def reject(self, message, **changes):
        with self.assertRaisesRegex(ValueError, message):
            self.audit(**changes)

    def semantic(self, filename, change, error):
        members = copy.deepcopy(self.members)
        value = proof.parse(members[filename])
        change(value)
        members[filename] = proof.canonical(value)
        # Bind altered inputs so the intended semantic assertion is exercised.
        cert = proof.parse(members["discovery-evidence.json"])
        for name, key in proof.BINDINGS.items():
            cert[key] = proof.sha256(members[name])
        members["discovery-evidence.json"] = proof.canonical(cert)
        for manifest in sorted((p for p in members if p.endswith("SHA256SUMS")), reverse=True):
            prefix = manifest.rsplit("/", 1)[0] + "/" if "/" in manifest else ""
            lines = []
            for line in members[manifest].decode().splitlines():
                _, relative = line.split("  ", 1)
                lines.append(proof.sha256(members[prefix + relative.removeprefix("./")]) + "  " + relative)
            members[manifest] = ("\n".join(lines) + "\n").encode()
        with self.assertRaisesRegex(ValueError, error):
            proof.verify_bound_members(members)

    def test_real_original_archive_and_exact_coupled_admission(self):
        report = self.audit()
        self.assertEqual(report["family_count"], 13)
        self.assertTrue(report["family_universe_discovery_authenticated"])
        self.assertTrue(report["capital_source_universe_complete"])
        for flag in ("d11_terminal_closed", "global_capital_source_completeness",
                     "executable_capital_proven", "real_market_census_closed", "profitability_proven"):
            self.assertIs(report[flag], False)
        self.assertEqual(report["aave_v3_and_uniswap_v2_execution_eligibility"], "UNRECONSTRUCTED")
        self.assertEqual(report["balancer_v2_and_uniswap_v3_execution_eligible_count"], 0)
        self.assertEqual(report["nqc_realized_pnl_usd_wad"], "0")

    def test_original_certificate_binds_pending_not_its_future_reference(self):
        original = proof.verify_bound_members(self.members)
        self.assertFalse(original["terminal_claim_allowed"])
        self.assertEqual(original["family_universe_discovery"]["status"], "NOT_CERTIFIED")
        self.assertNotEqual(proof.sha256(self.universe), proof.ORIGINAL_UNIVERSE_SHA)
        self.audit()

    def test_altered_zip_rejected(self):
        self.reject("outer SHA256", zip_raw=self.raw + b"tamper")

    def test_certificate_member_hash_independently_required(self):
        members = copy.deepcopy(self.members)
        members["discovery-evidence.json"] += b" "
        with patch.object(proof, "open_archive", return_value=members):
            self.reject("certificate member SHA256")

    def test_changed_discovery_contract_rejected(self):
        self.reject("discovery contract", discovery=self.discovery + b" ")

    def test_current_family_drift_rejected(self):
        value = proof.parse(self.universe)
        value["families"][0]["resolution_evidence"]["sha256"] = "a" * 64
        self.reject("changed original families", source_universe=proof.canonical(value))

    def test_wrong_promoted_discovery_reference_rejected(self):
        for key, value in (("run_id", proof.RUN + 1), ("artifact_id", proof.ARTIFACT + 1),
                           ("head_sha", "a" * 40), ("sha256", "a" * 64)):
            with self.subTest(key=key):
                doc = proof.parse(self.universe)
                doc["family_universe_discovery"]["evidence"][key] = value
                self.reject("exact discovery reference", source_universe=proof.canonical(doc))

    def test_scope_transition_requires_true(self):
        value = proof.parse(self.scope)
        value["claims"]["capital_source_universe_complete"] = False
        self.reject("matching readiness scope", scope=proof.canonical(value))

    def test_no_scope_claim_widening(self):
        original = proof.parse(self.scope)
        for key, value in original["claims"].items():
            if value is False:
                with self.subTest(claim=key):
                    changed = copy.deepcopy(original)
                    changed["claims"][key] = True
                    self.reject("widened terminal/economic claims", scope=proof.canonical(changed))

    def test_omitted_outer_manifest_member(self):
        members = copy.deepcopy(self.members)
        members["SHA256SUMS"] = b"\n".join(members["SHA256SUMS"].splitlines()[1:]) + b"\n"
        with self.assertRaisesRegex(ValueError, "omitted or extra manifest"):
            proof.verify_bound_members(members)

    def test_extra_outer_manifest_member(self):
        members = copy.deepcopy(self.members)
        members["SHA256SUMS"] += b"a" * 64 + b"  ./injected.json\n"
        with self.assertRaisesRegex(ValueError, "omitted or extra manifest"):
            proof.verify_bound_members(members)

    def test_duplicate_outer_manifest_member(self):
        members = copy.deepcopy(self.members)
        members["SHA256SUMS"] += members["SHA256SUMS"].splitlines()[0] + b"\n"
        with self.assertRaisesRegex(ValueError, "duplicate manifest"):
            proof.verify_bound_members(members)

    def test_omitted_nested_manifest_member(self):
        members = copy.deepcopy(self.members)
        name = "artifacts/11576204678/SHA256SUMS"
        members[name] = b"\n".join(members[name].splitlines()[1:]) + b"\n"
        with self.assertRaisesRegex(ValueError, "omitted or extra manifest"):
            proof.verify_bound_members(members)

    def test_injected_archive_member(self):
        members = copy.deepcopy(self.members)
        members["extra.txt"] = b"not authoritative"
        with self.assertRaisesRegex(ValueError, "missing or injected archive"):
            proof.verify_bound_members(members)

    def test_missing_archive_member(self):
        members = copy.deepcopy(self.members)
        del members["artifacts/11576204678/adversarial-tests.txt"]
        with self.assertRaisesRegex(ValueError, "missing or injected archive"):
            proof.verify_bound_members(members)

    def test_tampered_actual_family_member(self):
        members = copy.deepcopy(self.members)
        path = "artifacts/11576204678/protocol-family-evidence/families/AAVE_V3_FLASH_LOAN/evidence.json"
        members[path] += b" "
        with self.assertRaisesRegex(ValueError, "family witness member SHA256"):
            proof.verify_bound_members(members)

    def test_duplicate_family_transport_ledger(self):
        members = copy.deepcopy(self.members)
        path = "family-evidence-authentication.jsonl"
        lines = members[path].splitlines()
        lines[1] = lines[0]
        members[path] = b"\n".join(lines) + b"\n"
        cert = proof.parse(members["discovery-evidence.json"])
        cert["family_evidence_transport_sha256"] = proof.sha256(members[path])
        members["discovery-evidence.json"] = proof.canonical(cert)
        # Digest mismatch is independently sufficient; exercise equality directly
        # with valid recomputed outer sums, never through the authority envelope.
        text = members["SHA256SUMS"].decode()
        for name in (path, "discovery-evidence.json"):
            text = "\n".join(proof.sha256(members[name]) + "  " + line.split("  ", 1)[1]
                             if line.split("  ", 1)[1].removeprefix("./") == name else line
                             for line in text.splitlines()) + "\n"
        members["SHA256SUMS"] = text.encode()
        with self.assertRaisesRegex(ValueError, "transport ledger set/order/bindings"):
            proof.verify_bound_members(members)

    def test_false_already_authenticated_readiness(self):
        self.semantic("rmc011-family-discovery-readiness.json",
                      lambda d: d.update(already_authenticated=True), "readiness ledger/claims")

    def test_missing_readiness_family(self):
        self.semantic("rmc011-family-discovery-readiness.json",
                      lambda d: d["family_evidence"].pop(), "readiness ledger/claims")

    def test_duplicate_universe_family(self):
        self.semantic("rmc011-capital-source-universe.json",
                      lambda d: d["families"].__setitem__(1, copy.deepcopy(d["families"][0])),
                      "family set/count/duplicates")

    def test_substituted_family_transport(self):
        self.semantic("rmc011-family-discovery-readiness.json",
                      lambda d: d["family_evidence"][0].update(run_id=1), "readiness ledger/claims")

    def test_certificate_input_digest_drift(self):
        members = copy.deepcopy(self.members)
        cert = proof.parse(members["discovery-evidence.json"])
        cert["source_universe_sha256"] = "f" * 64
        members["discovery-evidence.json"] = proof.canonical(cert)
        with self.assertRaisesRegex(ValueError, "certificate input SHA256"):
            proof.verify_bound_members(members)

    def test_native_unknown_and_zero_eligibility_never_interchanged(self):
        cases = (
            ("AAVE_V3_FLASH_LOAN", "source_execution_eligible_count", 0),
            ("UNISWAP_V2_FLASH_SWAP", "source_execution_eligible_count", 0),
            ("BALANCER_V2_FLASH_LOAN", "source_execution_eligible_count", None),
            ("UNISWAP_V3_FLASH", "source_execution_eligible_count", None),
            ("BALANCER_V2_FLASH_LOAN", "source_execution_eligible_count", False),
            ("AAVE_V3_FLASH_LOAN", "source_execution_eligibility_not_yet_reconstructed", False),
            ("UNISWAP_V3_FLASH", "source_execution_eligibility_not_yet_reconstructed", True),
            ("AAVE_V3_FLASH_LOAN", "nqc_capital_or_profit_positive_claimed", True),
            ("BALANCER_V2_FLASH_LOAN", "original_native_gas_external_sponsor_count", 1),
            ("UNISWAP_V2_FLASH_SWAP", "global_source_nonexistence_claimed", True),
            ("UNISWAP_V3_FLASH", "terminal_d11_closed", True),
        )
        for family, key, value in cases:
            with self.subTest(family=family, key=key):
                members = copy.deepcopy(self.members)
                path = f"artifacts/11576204678/protocol-family-evidence/families/{family}/evidence.json"
                original_digest = proof.sha256(members[path])
                record = proof.parse(members[path])
                record[key] = value
                changed = proof.canonical(record)
                members[path] = changed
                digest = proof.sha256
                # Isolate the inner semantics after the already-tested member
                # hash boundary. This never enters the authority envelope.
                with patch.object(proof, "sha256", side_effect=lambda raw:
                                  original_digest if raw == changed else digest(raw)):
                    with self.assertRaisesRegex(ValueError, "eligibility unknown/zero or nonclaims"):
                        proof.verify_bound_members(members)

    def test_workflow_authenticates_archive_before_transport_pass(self):
        path = Path(".github/workflows/nqc-census-capital-terminal-readiness.yml")
        source = path.read_text()
        auth = source.index("      - name: Independently authenticate original discovery archive and minimal admission")
        gate = source.index("      - name: Enforce terminal claim boundary")
        self.assertLess(auth, gate)
        step = source[auth:gate]
        for expected in (
            "actions/runs/37841923756", "actions/artifacts/11577503474",
            "git/commits/" + proof.HEAD, "actions/artifacts/11577503474/zip",
            "test_rmc011_independent_discovery_admission.py",
            "rmc011_independent_discovery_admission.py", "set -euo pipefail",
            '--report "$OUT/admission-report.json"',
        ):
            self.assertIn(expected, step)
        self.assertNotIn("continue-on-error", step)

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate JSON"):
            proof.parse(b'{"status": "allowed", "status": "blocked"}')

    def test_archive_duplicate_and_traversal_members_rejected(self):
        for name in ("discovery-evidence.json", "../escape.json", "/absolute.json"):
            with self.subTest(name=name):
                buffer = io.BytesIO()
                with ZipFile(buffer, "w") as archive:
                    for member, raw in self.members.items():
                        if member != "SHA256SUMS":
                            archive.writestr(member, raw)
                    archive.writestr(name, b"unsafe")
                raw = buffer.getvalue()
                with patch.object(proof, "ZIP_SHA", proof.sha256(raw)):
                    with self.assertRaisesRegex(ValueError, "duplicates|unsafe ZIP"):
                        proof.open_archive(raw)


def metadata_case(field, changes):
    def check(self):
        value = copy.deepcopy(self.metadata[field])
        for key, replacement in changes.items():
            if "." in key:
                a, b = key.split(".")
                value[a][b] = replacement
            else:
                value[key] = replacement
        self.reject("original discovery", **{field: value})
    return check


for suffix, field, changes in (
    ("failed_run", "run", {"conclusion": "failure"}),
    ("wrong_run", "run", {"id": proof.RUN + 1}),
    ("wrong_head", "run", {"head_sha": "b" * 40}),
    ("wrong_attempt", "run", {"run_attempt": 2}),
    ("bool_attempt", "run", {"run_attempt": True}),
    ("wrong_workflow", "run", {"name": "Forged discovery"}),
    ("foreign_repository", "run", {"repository.full_name": "foreign/repo"}),
    ("foreign_head_repository", "run", {"head_repository.full_name": "foreign/repo"}),
    ("wrong_artifact", "artifact", {"id": proof.ARTIFACT + 1}),
    ("wrong_name", "artifact", {"name": proof.NAME + "-wrong"}),
    ("wrong_digest", "artifact", {"digest": "sha256:" + "a" * 64}),
    ("expired_artifact", "artifact", {"expired": True}),
    ("string_expiry", "artifact", {"expired": "false"}),
    ("artifact_wrong_run", "artifact", {"workflow_run.id": 1}),
    ("artifact_wrong_head", "artifact", {"workflow_run.head_sha": "a" * 40}),
    ("wrong_tree", "commit", {"tree.sha": "a" * 40}),
):
    setattr(IndependentDiscoveryAdmissionTests, "test_reject_" + suffix, metadata_case(field, changes))


def certificate_case(key, value):
    def check(self):
        self.semantic("discovery-evidence.json", lambda d: d.update({key: value}),
                      "certificate identity/count/nonclaims|certificate field set")
    return check


for key, value in (("run_attempt", 2), ("head_sha", "a" * 40), ("run_id", 1),
                   ("family_count", 12), ("unresolved_family_count", 1),
                   ("d11_terminal_closed", True), ("global_source_nonexistence_claimed", True)):
    setattr(IndependentDiscoveryAdmissionTests, "test_certificate_" + key, certificate_case(key, value))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    for name in ("zip", "run", "artifact", "commit"):
        parser.add_argument("--" + name, type=Path, required=True)
    ARGS, remaining = parser.parse_known_args()
    unittest.main(argv=[__file__, *remaining])
