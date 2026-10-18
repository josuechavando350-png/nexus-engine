#!/usr/bin/env python3
"""Checks durability ordering of an RMC-004 writer from a syscall trace.

Process-crash tests cannot observe power-loss durability. This gate proves the
publication ordering from the kernel trace.

Input:
  strace -f -y -qq -e trace=linkat,link,rename,renameat,renameat2,mkdir,mkdirat,fsync,fdatasync

Rules for store paths:
  R1 staged source file is fsynced before link/rename publication.
  R2 destination directory is fsynced after publication and before any later
     authoritative publication.
  R3 at least one checkpoint link and one HEAD rename are observed.
  R4 a directory created or adopted through EEXIST has its parent fsynced before
     later authority can depend on that directory.
  PARSE any traced publication/directory syscall that is not understood fails
     closed rather than being silently ignored.

Exit status: 0 pass, 1 violation, 2 usage error.
"""

import os
import re
import sys

FSYNC = re.compile(
    r'^\d+\s+f(?:data)?sync\(\d+<(?P<path>[^>]*)>\)\s+=\s+0$'
)
LINKAT = re.compile(
    r'^\d+\s+linkat\([^,]+,\s+"(?P<src>[^"]+)",\s+[^,]+,\s+"(?P<dst>[^"]+)",\s+\d+\)\s+=\s+(?P<rc>-?\d+)'
)
LINK = re.compile(
    r'^\d+\s+link\("(?P<src>[^"]+)",\s+"(?P<dst>[^"]+)"\)\s+=\s+(?P<rc>-?\d+)'
)
RENAME = re.compile(
    r'^\d+\s+rename(?:at2?)?\((?:[^,]+,\s+)?"(?P<src>[^"]+)",\s+(?:[^,]+,\s+)?"(?P<dst>[^"]+)"(?:,\s+\d+)?\)\s+=\s+(?P<rc>-?\d+)'
)
MKDIR = re.compile(
    r'^\d+\s+mkdir\("(?P<path>[^"]+)",\s+[^)]+\)\s+=\s+(?P<rc>-?\d+)(?P<tail>.*)$'
)
MKDIRAT = re.compile(
    r'^\d+\s+mkdirat\([^,]+,\s+"(?P<path>[^"]+)",\s+[^)]+\)\s+=\s+(?P<rc>-?\d+)(?P<tail>.*)$'
)
PUBLICATION = re.compile(r'^\d+\s+(?:link|linkat|rename|renameat|renameat2)\(')
DIRECTORY_OP = re.compile(r'^\d+\s+(?:mkdir|mkdirat)\(')


def inside(path, root):
    return path == root or path.startswith(root + os.sep)


def main():
    if len(sys.argv) != 5 or sys.argv[1] != "--store" or sys.argv[3] != "--trace":
        print("usage: check_durability_trace.py --store DIR --trace FILE", file=sys.stderr)
        return 2

    store = os.path.abspath(sys.argv[2])
    staging = os.path.join(store, "tmp") + os.sep
    fsynced = set()
    pending = None  # (directory that must be fsynced, description)
    links = renames = checkpoint_links = head_renames = directory_barriers = 0

    with open(sys.argv[4], encoding="utf-8") as trace:
        for number, raw in enumerate(trace, 1):
            line = raw.rstrip("\n")

            match = FSYNC.match(line)
            if match:
                path = match.group("path")
                fsynced.add(path)
                if pending and path == pending[0]:
                    pending = None
                continue

            mkdir_match = MKDIR.match(line) or MKDIRAT.match(line)
            if DIRECTORY_OP.match(line) and not mkdir_match:
                print(
                    f"DURABILITY_TRACE=FAIL rule=PARSE line={number} "
                    f"reason=unparsed directory syscall: {line}",
                    file=sys.stderr,
                )
                return 1
            if mkdir_match:
                path = mkdir_match.group("path")
                rc = mkdir_match.group("rc")
                tail = mkdir_match.group("tail")
                if inside(path, store) and (rc == "0" or (rc == "-1" and "EEXIST" in tail)):
                    if pending:
                        print(
                            f"DURABILITY_TRACE=FAIL rule=R2 line={number} "
                            f"reason=using {path} before {pending[1]} was made durable",
                            file=sys.stderr,
                        )
                        return 1
                    pending = (os.path.dirname(path), f"directory {path}")
                    directory_barriers += 1
                continue

            link_match = LINKAT.match(line) or LINK.match(line)
            rename_match = RENAME.match(line)
            match = link_match or rename_match
            if PUBLICATION.match(line) and not match:
                print(
                    f"DURABILITY_TRACE=FAIL rule=PARSE line={number} "
                    f"reason=unparsed publication syscall: {line}",
                    file=sys.stderr,
                )
                return 1
            if not match or match.group("rc") != "0":
                continue

            src, dst = match.group("src"), match.group("dst")
            if not inside(dst, store) or dst.startswith(staging):
                continue
            if pending:
                print(
                    f"DURABILITY_TRACE=FAIL rule=R2 line={number} "
                    f"reason=publishing {dst} before {pending[1]} was made durable",
                    file=sys.stderr,
                )
                return 1
            if src not in fsynced:
                print(
                    f"DURABILITY_TRACE=FAIL rule=R1 line={number} "
                    f"reason={src} was never fsynced before receiving name {dst}",
                    file=sys.stderr,
                )
                return 1
            if link_match:
                links += 1
                checkpoint_links += "/checkpoints/" in dst
            else:
                renames += 1
                head_renames += dst.endswith("/HEAD")
            pending = (os.path.dirname(dst), dst)

    if pending:
        print(
            f"DURABILITY_TRACE=FAIL rule=R2 reason=trace ends before {pending[1]} is durable",
            file=sys.stderr,
        )
        return 1
    if checkpoint_links == 0 or head_renames == 0:
        print(
            "DURABILITY_TRACE=FAIL rule=R3 reason=no checkpoint link or HEAD rename observed",
            file=sys.stderr,
        )
        return 1

    print(
        f"DURABILITY_TRACE=PASS links={links} renames={renames} "
        f"checkpoint_links={checkpoint_links} head_renames={head_renames} "
        f"directory_barriers={directory_barriers}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
