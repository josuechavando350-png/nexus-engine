from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "skip_guard.py"
SPEC = importlib.util.spec_from_file_location("walle_skip_guard", MODULE_PATH)
assert SPEC and SPEC.loader
skip_guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(skip_guard)


class SkipGuardTests(unittest.TestCase):
    def test_node_zero_skip_counter_is_not_a_blocker(self) -> None:
        self.assertFalse(skip_guard.line_is_blocking("ℹ skipped 0"))
        self.assertFalse(skip_guard.line_is_blocking("\x1b[36mℹ skipped 0\x1b[0m"))

    def test_other_exact_zero_counter_forms_are_not_blockers(self) -> None:
        for line in ("skipped 0", "0 skipped", "skip: 0", "skipped=0"):
            with self.subTest(line=line):
                self.assertFalse(skip_guard.line_is_blocking(line))

    def test_positive_skip_count_is_blocking(self) -> None:
        self.assertTrue(skip_guard.line_is_blocking("ℹ skipped 1"))
        self.assertTrue(skip_guard.line_is_blocking("2 skipped"))

    def test_reason_and_status_skip_markers_are_blocking(self) -> None:
        self.assertTrue(skip_guard.line_is_blocking("# SKIP provider unavailable"))
        self.assertTrue(skip_guard.line_is_blocking('status="SKIPPED_ERROR"'))
        self.assertTrue(skip_guard.line_is_blocking("SKIPPED: missing evidence"))

    def test_not_tested_is_always_blocking(self) -> None:
        self.assertTrue(skip_guard.line_is_blocking("M742=NOT_TESTED"))

    def test_ambiguous_text_with_skipped_zero_remains_fail_closed(self) -> None:
        self.assertTrue(skip_guard.line_is_blocking("module skipped 0 evidence receipts"))

    def test_file_scan_returns_exact_blocking_line(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "verifier.log"
            path.write_text("ℹ skipped 0\nM12 PASS\nM13 SKIPPED_ERROR\n", encoding="utf-8")
            markers = skip_guard.blocking_markers([path])
        self.assertEqual(len(markers), 1)
        self.assertEqual(markers[0][1], 3)
        self.assertEqual(markers[0][2], "M13 SKIPPED_ERROR")


if __name__ == "__main__":
    unittest.main()
