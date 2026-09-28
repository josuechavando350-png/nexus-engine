#!/usr/bin/env python3
"""Checks the fsync/link/rename ordering of an RMC-004 writer from a syscall trace.

Process-crash tests cannot observe power-loss durability: skipping a directory
fsync leaves every in-process test green. This gate closes that hole by proving
the publication ordering from the kernel's point of view.

Input: `strace -f -y -qq -e trace=linkat,link,rename,renameat,renameat2,fsync,fdatasync`
output of a process writing to the store at --store.

Rules, for every successful publication into the store outside tmp/:
  R1  the staged source file was fsynced before it received its final name;
  R2  the destination directory is fsynced after the link/rename and before the
      next link or rename of any kind (nothing is built on a non-durable name);
  R3  at least one checkpoint link and one HEAD rename were observed, so the
      gate cannot pass vacuously.

Exit status: 0 pass, 1 violation, 2 usage error.
"""

import os
import re
import sys

FSYNC = re.compile(r'^\d+\s+f(?:data)?sync\(\d+<(?P<path>[^>]*)>\)\s+=\s+0$')
LINK = re.compile(r'^\d+\s+linkat\([^,]+,\s+"(?P<src>[^"]+)",\s+[^,]+,\s+"(?P<dst>[^"]+)",\s+\d+\)\s+=\s+(?P<rc>-?\d+)')
RENAME = re.compile(r'^\d+\s+rename(?:at2?)?\((?:[^,]+,\s+)?"(?P<src>[^"]+)",\s+(?:[^,]+,\s+)?"(?P<dst>[^"]+)"(?:,\s+\d+)?\)\s+=\s+(?P<rc>-?\d+)')


def main():
    if len(sys.argv) != 5 or sys.argv[1] != "--store" or sys.argv[3] != "--trace":
        print("usage: check_durability_trace.py --store DIR --trace FILE", file=sys.stderr)
        return 2
    store = os.path.abspath(sys.argv[2])
    staging = os.path.join(store, "tmp") + os.sep
    fsynced = set()
    pending = None  # (directory that must be fsynced, description)
    links = renames = checkpoint_links = head_renames = 0

    with open(sys.argv[4], encoding="utf-8") as trace:
        for number, line in enumerate(trace, 1):
            line = line.rstrip("\n")
            match = FSYNC.match(line)
            if match:
                path = match.group("path")
                fsynced.add(path)
                if pending and path == pending[0]:
                    pending = None
                continue
            match = LINK.match(line) or RENAME.match(line)
            if not match or match.group("rc") != "0":
                continue
            src, dst = match.group("src"), match.group("dst")
            if not dst.startswith(store + os.sep) or dst.startswith(staging):
                continue
            if pending:
                print(f"DURABILITY_TRACE=FAIL rule=R2 line={number} "
                      f"reason=publishing {dst} before {pending[1]} was made durable",
                      file=sys.stderr)
                return 1
            if src not in fsynced:
                print(f"DURABILITY_TRACE=FAIL rule=R1 line={number} "
                      f"reason={src} was never fsynced before receiving name {dst}",
                      file=sys.stderr)
                return 1
            if LINK.match(line):
                links += 1
                checkpoint_links += "/checkpoints/" in dst
            else:
                renames += 1
                head_renames += dst.endswith("/HEAD")
            pending = (os.path.dirname(dst), dst)
    if pending:
        print(f"DURABILITY_TRACE=FAIL rule=R2 reason=trace ends before {pending[1]} is durable",
              file=sys.stderr)
        return 1
    if checkpoint_links == 0 or head_renames == 0:
        print("DURABILITY_TRACE=FAIL rule=R3 reason=no checkpoint link or HEAD rename observed",
              file=sys.stderr)
        return 1
    print(f"DURABILITY_TRACE=PASS links={links} renames={renames} "
          f"checkpoint_links={checkpoint_links} head_renames={head_renames}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
