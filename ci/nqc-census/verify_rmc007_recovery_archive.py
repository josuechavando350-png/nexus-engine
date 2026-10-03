#!/usr/bin/env python3
"""Authenticate recovery ZIP bytes before extraction. Does not certify chain state.

RMC-004 verification, exact-head offline replay and surface validation remain
mandatory. Extraction is staged and rejects ambiguous or non-regular members.
"""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import zipfile


class InvalidEvidence(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise InvalidEvidence(message)


def digest(value: object, name: str, prefix: str = "0x") -> str:
    require(isinstance(value, str) and
            re.fullmatch(re.escape(prefix) + r"[0-9a-f]{64}", value) is not None,
            f"invalid hash: {name}")
    require(value != prefix + "0" * 64, f"zero hash: {name}")
    return value


def unpack(archive: Path, sha256: str, destination: Path) -> None:
    expected = digest(sha256.removeprefix("sha256:"), "archive SHA-256", "")
    with archive.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    require(actual == expected, "archive SHA-256 mismatch")
    require(not destination.is_symlink(), "symlink destination")
    require(not destination.exists() or
            (destination.is_dir() and not any(destination.iterdir())), "destination is not empty")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as package:
        seen = {}
        infos = package.infolist()
        require(bool(infos), "empty archive")
        for info in infos:
            name = info.filename
            parts = name.rstrip("/").split("/")
            require(info.orig_filename == name and name and "\\" not in name and
                    ":" not in name and all(part not in ("", ".", "..") for part in parts),
                    "unsafe archive path")
            path = PurePosixPath(*parts)
            require(path not in seen, "duplicate archive path")
            kind = stat.S_IFMT(info.external_attr >> 16)
            require(kind in (0, stat.S_IFDIR if info.is_dir() else stat.S_IFREG),
                    "non-regular archive member")
            seen[path] = info.is_dir()
        for path in seen:
            require(all(parent not in seen or seen[parent] for parent in path.parents),
                    "archive file/directory collision")
        # Do not leave partially unpacked evidence at the destination.
        with tempfile.TemporaryDirectory(prefix="rmc007-unpack-", dir=destination.parent) as temp:
            staging = Path(temp)
            for info in infos:
                target = staging / info.filename
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with package.open(info) as source, target.open("xb") as output:
                        shutil.copyfileobj(source, output)
            if destination.exists():
                destination.rmdir()
            staging.rename(destination)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        unpack(args.archive, args.sha256, args.out_dir)
    except (InvalidEvidence, OSError, zipfile.BadZipFile, RuntimeError, EOFError) as error:
        parser.exit(1, f"RMC007_RECOVERY_ARCHIVE_FAIL: {error}\n")
    print("RMC007_RECOVERY_ARCHIVE_BYTES_PASS")


if __name__ == "__main__":
    main()
