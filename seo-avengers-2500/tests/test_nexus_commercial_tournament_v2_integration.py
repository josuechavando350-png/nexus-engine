from pathlib import Path
import subprocess
import unittest


SUITE = Path(__file__).resolve().parents[1]
ENGINE = SUITE / "commercial-demand" / "tournament-engine-v2.mjs"
BOUNDARY = SUITE / "commercial-demand" / "tenant-evidence-boundary.mjs"
SNAPSHOT_BOUNDARY = SUITE / "commercial-demand" / "tenant-snapshot-binding.mjs"
V3_BUILDER = SUITE / "commercial-demand" / "tournament-v3-scenario.mjs"
SCENARIO = SUITE / "commercial-demand" / "nexus-commercial-demand-v2.json"
MANIFEST = SUITE / "commercial-demand" / "nexus-commercial-demand-v2.tenant-manifest.json"
CLI = SUITE / "scripts" / "nexus-commercial-demand-tournament-v2.mjs"
NODE_TEST = SUITE / "tests" / "test_nexus_commercial_demand_tournament_v2.mjs"
NODE_BOUNDARY_TEST = SUITE / "tests" / "test_nexus_commercial_tenant_boundary.mjs"
NODE_SNAPSHOT_TEST = SUITE / "tests" / "test_nexus_commercial_tenant_snapshot_binding.mjs"


class NexusCommercialTournamentV2VerifierIntegrationTests(unittest.TestCase):
    def run_node(self, *args):
        return subprocess.run(
            ["node", *map(str, args)],
            cwd=SUITE,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_v2_engine_cli_and_node_tests_execute_inside_verifier_discovery(self):
        for path in (ENGINE, BOUNDARY, SNAPSHOT_BOUNDARY, V3_BUILDER, CLI):
            result = self.run_node("--check", path)
            self.assertEqual(result.returncode, 0, result.stderr)

        for test_path in (NODE_TEST, NODE_BOUNDARY_TEST, NODE_SNAPSHOT_TEST):
            tests = self.run_node("--test", test_path)
            self.assertEqual(tests.returncode, 0, tests.stdout + "\n" + tests.stderr)

        without_manifest = self.run_node(CLI, "--scenario", SCENARIO)
        self.assertNotEqual(without_manifest.returncode, 0)
        self.assertIn("CUSTOM_SCENARIO_REQUIRES_EXPLICIT_TENANT_MANIFEST_AND_VICE_VERSA", without_manifest.stderr)
        self.assertEqual(without_manifest.stdout, "")

        without_evidence = self.run_node(CLI, "--scenario", SCENARIO, "--tenant-manifest", MANIFEST)
        self.assertNotEqual(without_evidence.returncode, 0)
        self.assertIn("CUSTOM_SCENARIO_REQUIRES_TENANT_CONTROL_AND_EVIDENCE_ROOTS", without_evidence.stderr)
        self.assertEqual(without_evidence.stdout, "")

        cli = self.run_node(
            CLI,
            "--assert-floor-milli",
            "15000",
            "--assert-verdict",
            "EXPAND_VALIDATED_DEMAND_AND_OR_CHANNELS_BEFORE_FLOOR_CLAIM",
            "--assert-selected",
            "EVIDENCE_WEIGHTED_HYBRID_26",
        )
        self.assertEqual(cli.returncode, 0, cli.stdout + "\n" + cli.stderr)
        self.assertIn("SALES_CLAIMS=NOT_VALIDATED_FOR_SALES_CLAIMS", cli.stderr)
        self.assertIn('"status": "TOURNAMENT_COMPLETE"', cli.stdout)
        self.assertIn('"selectedStrategyId": "EVIDENCE_WEIGHTED_HYBRID_26"', cli.stdout)
        self.assertIn('"pageCount": 26', cli.stdout)
        self.assertIn('"targetSupportVerdict": "EXPAND_VALIDATED_DEMAND_AND_OR_CHANNELS_BEFORE_FLOOR_CLAIM"', cli.stdout)


if __name__ == "__main__":
    unittest.main()
