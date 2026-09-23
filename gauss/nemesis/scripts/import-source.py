#!/usr/bin/env python3
"""Fail-closed import of exactly the pinned Némesis v17 source archive into GAUSS.

Only the user-uploaded, byte-identical ZIP is accepted. This does NOT certify
any motor or permit merging an unverified PR.
"""
from __future__ import annotations
import hashlib
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile

EXPECTED_ZIP_SHA256 = 'dfb28dd86060dc31edae1b930a208adabb1c66606e26da88a49790fdbf5884c6'
EXPECTED_FILE_COUNT = 297
EXPECTED_PREFIX = PurePosixPath('gauss/nemesis/engine')
MAX_TOTAL = 16 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024


def import_zip(repo: Path) -> None:
    repo = repo.resolve(strict=True)
    archive = repo / 'gauss/nemesis/import/GAUSS_NEMESIS_v19_fuente_para_subir_GitHub_NO_CERTIFICADO.zip'
    content = archive.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    if digest != EXPECTED_ZIP_SHA256:
        raise ValueError(f'NEMESIS_IMPORT_ARCHIVE_SHA256_MISMATCH: {digest}')
    checked: list[tuple[zipfile.ZipInfo, Path]] = []
    names: set[str] = set()
    size = 0
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            if info.is_dir():
                raise ValueError('NEMESIS_IMPORT_DIRECTORY_ENTRY_FORBIDDEN')
            if info.filename in names:
                raise ValueError('NEMESIS_IMPORT_DUPLICATE_PATH')
            names.add(info.filename)
            if '\\' in info.filename or '\x00' in info.filename or info.filename.startswith('/'):
                raise ValueError('NEMESIS_IMPORT_INVALID_PATH')
            rel = PurePosixPath(info.filename)
            if '..' in rel.parts or not rel.is_relative_to(EXPECTED_PREFIX) or rel == EXPECTED_PREFIX:
                raise ValueError(f'NEMESIS_IMPORT_OUTSIDE_ENGINE: {info.filename}')
            mode = info.external_attr >> 16
            if mode and not stat.S_ISREG(mode):
                raise ValueError(f'NEMESIS_IMPORT_NONREGULAR_FILE: {info.filename}')
            if info.file_size > MAX_FILE:
                raise ValueError('NEMESIS_IMPORT_FILE_TOO_LARGE')
            size += info.file_size
            if size > MAX_TOTAL:
                raise ValueError('NEMESIS_IMPORT_ARCHIVE_TOO_LARGE')
            dest = repo.joinpath(*rel.parts)
            parent = dest.parent
            while parent != repo:
                if parent.is_symlink():
                    raise ValueError('NEMESIS_IMPORT_SYMLINK_PARENT')
                parent = parent.parent
            if dest.is_symlink() or (dest.exists() and not dest.is_file()):
                raise ValueError('NEMESIS_IMPORT_DESTINATION_INVALID')
            checked.append((info, dest))
        if len(checked) != EXPECTED_FILE_COUNT:
            raise ValueError(f'NEMESIS_IMPORT_FILE_COUNT_MISMATCH: {len(checked)}')
        for info, dest in checked:
            raw = bundle.read(info)
            if dest.exists():
                if dest.read_bytes() != raw:
                    raise ValueError(f'NEMESIS_IMPORT_EXISTING_FILE_MISMATCH: {info.filename}')
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(raw)
                os.chmod(dest, 0o644)
    print(f'NEMESIS_SOURCE_IMPORTED: files={len(checked)} zipSha256={digest}')


if __name__ == '__main__':
    try:
        import_zip(Path(sys.argv[1] if len(sys.argv) > 1 else '.'))
    except (ValueError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
