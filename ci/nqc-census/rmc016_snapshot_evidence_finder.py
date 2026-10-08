#!/usr/bin/env python3
"""Read-only SHA-256 recovery of source economic ledgers from an authorized snapshot.

IMPORTANT: Never upload raw recovered rows or copy private/borrower data into
GitHub artifacts. This is evidence discovery, not Nexus execution authority.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import os
import stat
import sys
import zipfile
from pathlib import Path

TARGETS = {
    "D16_TRANSACTION_ECONOMICS": "55d5d6be9e09f2e499e1ca8949c4305d05824dffa61e363f4371c615537dcb1c",
    "D16_EVENT_ECONOMICS": "ea1f62091175c8c67b8763411f72a6071bfe528c1f969d19c9cff5679677c98b",
    "D16_WINNER_REPLAY": "29133f3b7ab34b74f92f5e8a3101e04a3cb2b1b389d4b8728813fbbae7f461be",
    "D15B_EPISODE_LEDGER": "a7fe40d752ee43ea507e9723d056248ca28dd6fb5884f49f33bed60950e3782a",
    "D15B_CENSORED_LEDGER": "c64b6050ff7a3cd5ee7119c9b2f041dad6341fb0cd7b53884e8f1bba1efb9252",
    "D16_LIQUIDATION_PRICE_AUTHORITY": "7c08ec2708e5d1d4d5ee4687ef960e440328683f1f6e7771805bc03c5b34f61a",
    "D16_DAILY_BASELINE": "1d06b56a28400bbf1102d614cd615543e855b3b1a01b78ed513300cff32d660f",
    "D15B_FULL_BLOCK_ORACLE_TRANSITIONS": "bbad1eb1a6fba097bd642b1abb5aa417fc86686dfe271da7c66017609bd3c519",
}
SKIP_DIRS = frozenset({
    ".git", ".ssh", ".aws", ".config", ".cache", "node_modules", "__pycache__",
    ".venv", "venv", "vendor", "proc", "sys", "dev",
})
SKIP_FILENAMES = frozenset({".env", ".env.local", "id_rsa", "id_ed25519"})
SKIP_SUFFIXES = frozenset({".pem", ".key", ".p12", ".pfx", ".sqlite", ".db"})
READ_SIZE = 1024*1024
MAX_BYTES = 2*1024*1024*1024

def require(ok, msg):
    if not ok:
        raise ValueError(msg)

def canonical(data):
    return (json.dumps(data,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()

def checksum(stream, max_bytes=MAX_BYTES):
    h=hashlib.sha256()
    n=0
    while True:
        chunk=stream.read(READ_SIZE)
        if not chunk: break
        n+=len(chunk)
        require(n<=max_bytes,"source exceeds bounded decompression/read budget")
        h.update(chunk)
    return h.hexdigest(),n

def candidates(root):
    root=Path(root)
    require(root.is_dir() and not root.is_symlink(),"root must be a real directory")
    for base, dirs, files in os.walk(root,followlinks=False):
        dirs[:]=sorted(x for x in dirs if x not in SKIP_DIRS and
                       not (Path(base)/x).is_symlink())
        for filename in sorted(files):
            p=Path(base)/filename
            if (filename in SKIP_FILENAMES or filename.startswith(".env.") or
                p.suffix.lower() in SKIP_SUFFIXES or p.is_symlink()):
                continue
            try:
                info=p.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_size>MAX_BYTES:continue
            except OSError:
                continue
            yield p

def records_from_path(path, max_bytes=MAX_BYTES):
    path=Path(path)
    with path.open("rb") as f:
        yield ("file",None,*checksum(f,max_bytes))
    if path.suffix.lower()==".gz":
        with gzip.open(path,"rb") as f:
            yield ("gzip_uncompressed",None,*checksum(f,max_bytes))
    elif path.suffix.lower()==".zip":
        with zipfile.ZipFile(path,"r") as archive:
            infos=archive.infolist()
            require(len({x.filename for x in infos})==len(infos),"duplicate ZIP member names")
            for info in sorted(infos,key=lambda x:x.filename):
                if info.is_dir() or info.file_size>max_bytes:continue
                require(not ((info.external_attr>>16)&0o170000)==0o120000,
                        "ZIP symbolic link forbidden")
                require(not info.filename.startswith("/") and
                        ".." not in Path(info.filename).parts,"unsafe ZIP member name")
                with archive.open(info) as f:
                    yield ("zip_member",info.filename,*checksum(f,max_bytes))

def find(roots,targets=TARGETS,max_bytes=MAX_BYTES):
    require(type(targets) is dict and targets, "non-empty exact digest targets required")
    assert all(type(k) is str and type(v) is str and len(v)==64 and
               all(c in "0123456789abcdef" for c in v) for k,v in targets.items())
    required=set(targets.values())
    require(type(roots) is list and roots,"at least one explicitly selected root required")
    all_hits={key:[] for key in sorted(targets)}
    examined=0
    errors=[]
    roots=[Path(x).resolve(strict=True) for x in roots]
    require(len(set(roots))==len(roots),"duplicate root")
    for root in sorted(roots):
        for p in candidates(root):
            examined+=1
            location=p.relative_to(root).as_posix()
            try:
                for kind,member,sha,n in records_from_path(p,max_bytes):
                    if sha not in required:continue
                    for k,digest in sorted(targets.items()):
                        if digest==sha:
                            all_hits[k].append({"root":str(root),"relative_path":location,
                                "container_kind":kind,"archive_member":member,
                                "sha256":sha,"bytes":n})
            except (ValueError,OSError,zipfile.BadZipFile,EOFError) as e:
                errors.append({"root":str(root),"relative_path":location,
                               "error_class":type(e).__name__})
    for k in all_hits:
        all_hits[k]=sorted(all_hits[k],key=lambda r:(r["root"],r["relative_path"],
                                                     r["container_kind"],r["archive_member"] or ""))
    found=[k for k,v in all_hits.items() if v]
    report={"schema_version":1,
            "status":"RMC016_EXACT_SOURCE_BYTES_LOCATED_UNCERTIFIED" if found
                     else "RMC016_ORIGINAL_SOURCE_BYTES_NOT_FOUND",
            "authorization":"LOCAL_READ_ONLY_HASH_DISCOVERY",
            "terminal_authority":False,"nexus_profitability_proven":False,
            "source_replay_completed":False,"source_digest_only_not_semantic_evidence":True,
            "user_capital_used_usd":"0","roots":[str(r) for r in sorted(roots)],
            "scanned_file_count":examined,"file_errors":errors,
            "found_target_labels":found,
            "missing_target_labels":sorted(set(targets)-set(found)),
            "matches":all_hits}
    report["report_sha256"]=hashlib.sha256(canonical(report)).hexdigest()
    return report

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--root",action="append",required=True,
                   help="Explicit local snapshot/workspace root (never scan / by default)")
    p.add_argument("--out",required=True,type=Path,
                   help="Local manifest only. Do not upload source rows or manifest externally.")
    a=p.parse_args()
    require(not a.out.is_symlink(),"output symlink forbidden")
    require(not a.out.exists(),"output already exists; append-only reports")
    report=find(a.root)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(a.out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,"wb") as stream:
            stream.write(canonical(report))
    except BaseException:
        a.out.unlink(missing_ok=True)
        raise
    print(report["status"],"files_scanned",report["scanned_file_count"],
          "exact_sources_found",len(report["found_target_labels"]),
          "errors",len(report["file_errors"]))
    return 0 if "D16_TRANSACTION_ECONOMICS" in report["found_target_labels"] else 2

if __name__=="__main__":
    sys.exit(main())
