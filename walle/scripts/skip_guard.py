#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import re
import sys
from typing import Iterable

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
SKIP_TOKEN = re.compile(
    r"(?<![A-Za-z0-9])SKIP(?:PED)?(?:_[A-Z0-9]+)*(?![A-Za-z0-9])",
    re.IGNORECASE,
)
NOT_TESTED_TOKEN = re.compile(r"(?<![A-Za-z0-9])NOT_TESTED(?![A-Za-z0-9])", re.IGNORECASE)

# These are exact framework summary forms that prove zero skipped tests. Do not
# broaden them to arbitrary text containing "skipped 0": anything ambiguous
# remains fail-closed.
ZERO_SKIP_COUNTERS = (
    re.compile(r"^(?:ℹ\s*)?skipped\s+0$", re.IGNORECASE),
    re.compile(r"^(?:ℹ\s*)?0\s+skipped$", re.IGNORECASE),
    re.compile(r"^(?:ℹ\s*)?skip(?:ped)?\s*[:=]\s*0$", re.IGNORECASE),
)


def normalized_line(raw_line: str) -> str:
    return ANSI.sub("", raw_line).strip()


def line_is_blocking(raw_line: str) -> bool:
    line = normalized_line(raw_line)
    if NOT_TESTED_TOKEN.search(line):
        return True
    if not SKIP_TOKEN.search(line):
        return False
    return not any(pattern.fullmatch(line) for pattern in ZERO_SKIP_COUNTERS)


def blocking_markers(paths: Iterable[Path]) -> list[tuple[Path, int, str]]:
    markers: list[tuple[Path, int, str]] = []
    for path in paths:
        if not path.is_file():
            continue
        for line_number, raw_line in enumerate(
            path.read_text(encoding="utf-8", errors="replace").splitlines(), 1
        ):
            if line_is_blocking(raw_line):
                markers.append((path, line_number, normalized_line(raw_line)))
    return markers


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    markers = blocking_markers(Path(value) for value in args)
    if not markers:
        return 1
    path, line_number, line = markers[0]
    print(f"REAL_SKIP_MARKER:{path}:{line_number}:{line}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
