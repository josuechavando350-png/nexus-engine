from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-terminal-family-partition.py")
SPEC = importlib.util.spec_from_file_location("rmc011_terminal_partition", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class TerminalFamilyPartitionTests(unittest.TestCase):
    def test_current_partition_is_exact_7_plus_2_plus_4(self) -> None:
        result = mod.current_partition()
        self.assertEqual(result["family_count"], 13)
        self.assertEqual(result["bounded_count"], 7)
        self.assertEqual(result["debt_count"], 2)
        self.assertEqual(result["protocol_count"], 4)
        self.assertEqual(set(result["families"]), mod.EXPECTED)

    def test_overlap_fails(self) -> None:
        with self.assertRaises(mod.PartitionError):
            mod.validate_partition(
                {"EXTERNAL_GAS_CREDIT"},
                {"EXTERNAL_GAS_CREDIT"},
                mod.EXPECTED - {"EXTERNAL_GAS_CREDIT"},
            )

    def test_missing_family_fails(self) -> None:
        bounded = {
            "EXTERNAL_GAS_CREDIT",
            "EXTERNAL_GAS_SPONSOR",
            "TRANSIENT_EXTERNAL_CREDIT",
            "INVENTORY_REQUIREMENT",
            "BOND_OR_STAKE",
            "SOLVER_OR_BUILDER_DEPOSIT",
            "INTRA_BLOCK_TEMPORARY_LOCK",
        }
        debt = {"COLLATERALIZED_BORROWING", "PERSISTENT_DEBT"}
        protocol = {
            "AAVE_V3_FLASH_LOAN",
            "UNISWAP_V2_FLASH_SWAP",
            "BALANCER_V2_FLASH_LOAN",
        }
        with self.assertRaises(mod.PartitionError):
            mod.validate_partition(bounded, debt, protocol)

    def test_unknown_family_fails(self) -> None:
        bounded = {
            "EXTERNAL_GAS_CREDIT",
            "EXTERNAL_GAS_SPONSOR",
            "TRANSIENT_EXTERNAL_CREDIT",
            "INVENTORY_REQUIREMENT",
            "BOND_OR_STAKE",
            "SOLVER_OR_BUILDER_DEPOSIT",
            "INTRA_BLOCK_TEMPORARY_LOCK",
            "UNKNOWN_FAMILY",
        }
        with self.assertRaises(mod.PartitionError):
            mod.validate_partition(
                bounded,
                {"COLLATERALIZED_BORROWING", "PERSISTENT_DEBT"},
                {
                    "AAVE_V3_FLASH_LOAN",
                    "UNISWAP_V2_FLASH_SWAP",
                    "BALANCER_V2_FLASH_LOAN",
                    "UNISWAP_V3_FLASH",
                },
            )


if __name__ == "__main__":
    unittest.main()
