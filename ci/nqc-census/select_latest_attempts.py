#!/usr/bin/env python3
"""Select the latest attempt of every stage artifact of one workflow run.

Usage: select_latest_attempts.py ROOT PREFIX OUT.json [REQUIRED_FILE]

Artifacts are named `<PREFIX>...-<40-hex head>-<run id>-<run attempt>`. For
each stage (the name without its attempt) the highest attempt is selected; it
must hold REQUIRED_FILE (default `record.json`). Every attempt, failed ones
included, is listed in OUT.json, and the selected artifact names are printed
one per line.
"""

import json
import os
import re
import sys


def main():
    root, prefix, out = sys.argv[1:4]
    required = sys.argv[4] if len(sys.argv) > 4 else "record.json"
    pattern = re.compile(r"(" + re.escape(prefix) + r".+-[0-9a-f]{40}-[0-9]+)-([0-9]+)")
    attempts = {}
    for name in sorted(os.listdir(root)):
        match = pattern.fullmatch(name)
        if not match:
            raise SystemExit(f"unexpected stage artifact {name}")
        attempts.setdefault(match.group(1), []).append(
            {"attempt": int(match.group(2)), "artifact": name,
             "record": os.path.exists(os.path.join(root, name, required))})
    selection = []
    for key in sorted(attempts):
        latest = max(attempts[key], key=lambda item: item["attempt"])
        if not latest["record"]:
            raise SystemExit(f"{key}: latest attempt {latest['attempt']} has no {required}")
        selection.append({"stage": key, "selected": latest["artifact"], "attempts": attempts[key]})
        print(latest["artifact"])
    with open(out, "w") as handle:
        json.dump(selection, handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    main()
