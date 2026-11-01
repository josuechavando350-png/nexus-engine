"""Restore the complete measured traces using only Python's standard library.

Usage: python validation/daksh/unpack-traces.py runs/restored-0.4
Then use Bot MD compare-motion with the restored directories.
"""
import hashlib
import json
import lzma
from pathlib import Path
import re
import sys

if len(sys.argv) not in (2, 3):
    raise SystemExit("Provide a new output directory and optionally an evidence directory.")
evidence = (Path(sys.argv[2]).resolve() if len(sys.argv) == 3 else Path(__file__).resolve().parents[2] / "evidence/daksh/controlled-0.4.0")
destination = Path(sys.argv[1]).resolve()
destination.mkdir(parents=True, exist_ok=False)
manifest = json.loads((evidence / "traces.json").read_text())
for entry in manifest["traces"]:
    name = entry["name"]
    if not re.fullmatch(r"[a-z0-9-]+", name) or entry["archive"] != name + ".json.xz":
        raise ValueError("Invalid archive name")
    compressed = (evidence / entry["archive"]).read_bytes()
    if hashlib.sha256(compressed).hexdigest() != entry["archiveSha256"]:
        raise ValueError("Archive hash mismatch")
    raw = lzma.decompress(compressed)
    if len(raw) != entry["bytes"] or hashlib.sha256(raw).hexdigest() != entry["sha256"]:
        raise ValueError("Trace hash mismatch")
    folder = destination / name
    folder.mkdir()
    (folder / "motion.json").write_bytes(raw)
    (folder / "seal.json").write_text(json.dumps({"sha256": entry["sha256"]}) + "\n")
    print(name + ": restored and verified")
