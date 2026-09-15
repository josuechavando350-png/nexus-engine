from pathlib import Path
import subprocess
import unittest


SUITE = Path(__file__).resolve().parents[1]
ENGINE = SUITE / "commercial-demand" / "tournament-engine.mjs"
CLI = SUITE / "scripts" / "nexus-commercial-demand-tournament-v1.mjs"
NODE_TEST = SUITE / "tests" / "test_nexus_commercial_demand_tournament_v1.mjs"


class NexusCommercialTournamentVerifierIntegrationTests(unittest.TestCase):
    def run_node(self, *args):
        return subprocess.run(
            ["node", *map(str, args)],
            cwd=SUITE,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_engine_cli_and_node_tests_are_part_of_the_existing_verifier(self):
        for path in (ENGINE, CLI):
            result = self.run_node("--check", path)
            self.assertEqual(result.returncode, 0, result.stderr)

        tests = self.run_node("--test", NODE_TEST)
        self.assertEqual(tests.returncode, 0, tests.stdout + "\n" + tests.stderr)

        cli = self.run_node(
            CLI,
            "--assert-verdict",
            "EXPAND_VALIDATED_DEMAND_BEFORE_CLAIM",
            "--assert-selected",
            "SERVICES_PLUS_MIXED_CORE",
        )
        self.assertEqual(cli.returncode, 0, cli.stdout + "\n" + cli.stderr)
        self.assertIn('"status": "TOURNAMENT_COMPLETE"', cli.stdout)
        self.assertIn('"targetSupportVerdict": "EXPAND_VALIDATED_DEMAND_BEFORE_CLAIM"', cli.stdout)


if __name__ == "__main__":
    unittest.main()
