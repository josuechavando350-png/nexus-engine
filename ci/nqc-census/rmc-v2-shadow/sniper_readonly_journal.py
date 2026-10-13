#!/usr/bin/env python3
"""Read-only sniper sampling daemon with immutable, fail-closed evidence chain.

This is a *deployable candidate*, not a running or certified 24/7 service.
It never builds/sends/signs a transaction, reads a wallet or asserts profit.
Requires explicitly approved host/operator/recurring resource use.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import time

import sniper_readonly_observer as obs

MIN_INTERVAL=60
DEFAULT_INTERVAL=300
MAX_REPORT_BYTES=2_000_000
SCHEMA=1

class JournalError(ValueError):
    pass

def need(c,why):
    if not c: raise JournalError(why)

def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=True).encode()+b"\n"

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def parse_line(s):
    def unique(fields):
        d={}
        for k,v in fields:
            need(k not in d,"duplicate JSON key in audit log")
            d[k]=v
        return d
    try:return json.loads(s,object_pairs_hook=unique)
    except (ValueError,UnicodeError,TypeError) as e:
        raise JournalError("malformed audit record") from e

def validate_entry(entry,prev,seen):
    need(type(entry) is dict and entry.get("schema_version")==SCHEMA,
         "wrong audit schema")
    need(entry.get("contract")=="NQC_V2_SNIPER_APPEND_ONLY_READ_ONLY_JOURNAL",
         "wrong audit contract")
    index=entry.get("sequence")
    need(type(index) is int and index>=0 and index not in seen,
         "sequence invalid or duplicated")
    need(index==len(seen),"noncontiguous journal sequence")
    need(entry.get("previous_entry_sha256")==prev,"broken hash chain")
    sh=entry.get("snapshot_sha256")
    need(type(sh) is str and len(sh)==64 and all(c in "0123456789abcdef" for c in sh),
         "noncanonical report commitment")
    status=entry.get("snapshot_status")
    need(status in ("DUAL_ENDPOINT_SAME_BLOCK_HF_WITNESS_NOT_P2",
                    "SINGLE_ENDPOINT_RESEARCH_ONLY_NOT_P2",
                    "UNVERIFIED_NO_OBSERVATION"),"invalid source scope")
    need(entry.get("nqc_realized_pnl_usd")=="0" and
         entry.get("captured_liquidation") is False and
         entry.get("shadow_p2_certified") is False and
         entry.get("rmc_closed") is False and
         entry.get("commercial_score_upgrade") is False,
         "fabricated commercial authority")
    return digest(canonical(entry))

def audit(existing:bytes,folder:Path|None=None):
    if not existing:return [],"0"*64
    need(existing.endswith(b"\n"),"partial final record")
    lines=existing.splitlines()
    need(len(lines)<=100_000,"unbounded journal")
    entries=[];prev="0"*64;seen=set()
    for raw in lines:
        need(len(raw)<=12_000,"oversized log entry")
        entry=parse_line(raw)
        checksum=validate_entry(entry,prev,seen)
        if folder is not None:
            rel=entry.get("snapshot_file")
            need(type(rel) is str and rel.startswith("sample-") and
                 rel.endswith(".json") and "/" not in rel and "\\" not in rel,
                 "unsafe snapshot file reference")
            p=folder/rel
            need(p.is_file() and not p.is_symlink(),"referenced snapshot missing/symlink")
            raw_snapshot=p.read_bytes()
            need(len(raw_snapshot)<=MAX_REPORT_BYTES and digest(raw_snapshot)==
                 entry["snapshot_sha256"],"snapshot content mismatch")
            d=parse_line(raw_snapshot)
            need(d.get("status")==entry["snapshot_status"] and
                 d.get("p2_shadow_certified") is False and
                 d.get("nqc_realized_pnl_usd")=="0",
                 "mismatched snapshot authority")
        seen.add(entry["sequence"]);entries.append(entry);prev=checksum
    return entries,prev

def append_snapshot(out:Path,report:dict):
    need(type(report) is dict and report.get("contract")==
         "NQC_V2_READ_ONLY_SNIPER_PROSPECTIVE_SNAPSHOT",
         "invalid observer output")
    need(report.get("p2_shadow_certified") is False and
         report.get("rmc_closed") is False and
         report.get("commercial_score_upgrade") is False and
         report.get("nqc_realized_pnl_usd")=="0",
         "forged shadow/revenue")
    need(out.is_absolute() and out.is_dir() and not out.is_symlink(),
         "working evidence directory unavailable")
    journal=out/"journal.jsonl"
    need(not journal.is_symlink(),"journal symlink prohibited")
    old=journal.read_bytes() if journal.exists() else b""
    entries,prev=audit(old,out)
    sequence=len(entries)
    name=f"sample-{sequence:09d}.json"
    sample=canonical(report)
    need(len(sample)<=MAX_REPORT_BYTES,"report oversized")
    sample_path=out/name
    # Never overwrite an existing snapshot. Require exclusive creation and fsync.
    try:
        with sample_path.open("xb") as stream:
            stream.write(sample);stream.flush();os.fsync(stream.fileno())
    except FileExistsError as e:
        raise JournalError("snapshot identity already exists") from e
    entry={
      "schema_version":SCHEMA,
      "contract":"NQC_V2_SNIPER_APPEND_ONLY_READ_ONLY_JOURNAL",
      "sequence":sequence,"previous_entry_sha256":prev,
      "snapshot_file":name,"snapshot_sha256":digest(sample),
      "snapshot_status":report["status"],
      "recorded_at_utc":datetime.now(timezone.utc).isoformat(),
      "captured_liquidation":False,"nqc_realized_pnl_usd":"0",
      "shadow_p2_certified":False,"rmc_closed":False,
      "commercial_score_upgrade":False
    }
    validate_entry(entry,prev,set(range(sequence)))
    line=canonical(entry)
    # Verify the chain before and after writing, rather than altering old bytes.
    fd=os.open(journal,os.O_APPEND|os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,"ab",closefd=True) as stream:
            stream.write(line);stream.flush();os.fsync(stream.fileno())
    except BaseException:
        raise
    contents=journal.read_bytes()
    audit(contents,out)
    return entry

def run(out:Path,provider_ids,max_cycles=1,interval=DEFAULT_INTERVAL,
        observer=None,sleep=time.sleep):
    need(type(max_cycles) is int and max_cycles>=0,
         "max cycles invalid")
    need(type(interval) is int and interval>=MIN_INTERVAL,
         "interval less than sustainable read-only pilot floor")
    need(out.is_absolute() and out.is_dir() and not out.is_symlink(),
         "output folder must pre-exist and be a real absolute directory")
    need(type(provider_ids) in (tuple,list) and
         len(set(provider_ids))==len(provider_ids),
         "provider selection invalid")
    # An always-on service may require a substantial number of network calls;
    # this function does not provision infrastructure or negotiate RPC quotas.
    read=obs.observe if observer is None else observer
    i=0
    while max_cycles==0 or i<max_cycles:
        started=time.monotonic()
        try:
            report=read(tuple(provider_ids))
        except Exception as exc:
            report=obs.unavailable_report(
                int(datetime.now(timezone.utc).timestamp()),
                [{"reason":type(exc).__name__,"detail":str(exc)[:120]}],
                "READ_ONLY_SAMPLE_EXCEPTION")
        entry=append_snapshot(out,report)
        print(entry["sequence"],entry["snapshot_status"],flush=True)
        i+=1
        if max_cycles and i>=max_cycles:
            break
        remaining=interval-(time.monotonic()-started)
        if remaining>0:sleep(remaining)
    return i

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--out-dir",required=True,type=Path)
    p.add_argument("--providers",nargs="+",choices=sorted(obs.SOURCES),
                   default=["drpc","publicnode","blast"])
    p.add_argument("--interval-seconds",type=int,default=DEFAULT_INTERVAL)
    p.add_argument("--max-cycles",type=int,default=1,
                   help="0 = run continuously until stopped by operator")
    ns=p.parse_args()
    return run(ns.out_dir,ns.providers,ns.max_cycles,
               ns.interval_seconds)

if __name__=="__main__":
    main()
