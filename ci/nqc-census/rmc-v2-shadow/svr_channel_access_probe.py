#!/usr/bin/env python3
"""NQC: one bounded READ-ONLY Flashbots MEV-Share SSE access witness.

No Ethereum transaction / wallet / authentication / paid API. Evidence is a
source-local observation, NOT SVR enrollment, builder cutoff, inclusion or P&L.
Never export third-party raw private hints in a public CI artifact.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from svr_hint_admission import inspect_event, WETH_AGGREGATOR

SSE_URL = "https://mev-share.flashbots.net"
HISTORY_INFO = SSE_URL + "/api/v1/history/info"
HISTORY = SSE_URL + "/api/v1/history"
MAX_STREAM_SECONDS = 24
MAX_STREAM_BYTES = 524288
MAX_EVENT_BYTES = 200000
MAX_EVENTS = 1200
MAX_HISTORY_BYTES = 120000
MAX_HISTORY_EVENTS = 25
ALLOWED_URLS = frozenset((SSE_URL, HISTORY_INFO))


def canonical(obj):
    return (json.dumps(obj, sort_keys=True, separators=(",", ":")) + "\n").encode()


def clock():
    return {"utc_ns": time.time_ns(), "monotonic_ns": time.monotonic_ns()}


def strict_json(raw):
    def unique(items):
        d = {}
        for k, value in items:
            if k in d:
                raise ValueError("duplicate key")
            d[k] = value
        return d
    def bad_constant(_):
        raise ValueError("non-JSON constant")
    return json.loads(raw, object_pairs_hook=unique, parse_constant=bad_constant)


def classification(code):
    # Status is source-local and never means zero tradable opportunities.
    if code in (401, 403):
        return "BLOCKED_SOURCE_ACCESS_CONTROL"
    if code == 429:
        return "INCOMPLETE_SOURCE_RATE_LIMIT"
    return "INCOMPLETE_HTTP_STATUS"


def open_fixed(url, *, stream=False, opener=urlopen):
    if url not in ALLOWED_URLS and not (url.startswith(HISTORY+"?") and
                                     url.count("?") == 1 and
                                     url[len(HISTORY)+1:].startswith("blockStart=")):
        raise ValueError("not the pinned public read-only endpoint")
    headers = {"Accept": "text/event-stream" if stream else "application/json",
               "User-Agent": "NQC-V2-readonly-evidence/1"}
    response = opener(Request(url, method="GET", headers=headers), timeout=20)
    if response.geturl() != url:
        response.close()
        raise ValueError("unapproved URL redirect")
    if response.getcode() != 200:
        status = response.getcode()
        response.close()
        raise ValueError("source non-200 HTTP "+str(status))
    return response


def consume_sse(source, *, now=clock, monotonic=time.monotonic):
    started = monotonic()
    total = 0
    messages = 0
    pings = 0
    malformed = 0
    candidates = 0
    complete_nontarget = 0
    partial = 0
    sampled = []
    chunks = []
    aggregate = sha256()
    status = "BOUNDED_SSE_NO_EVENT_DOES_NOT_PROVE_ABSENCE"
    while monotonic()-started < MAX_STREAM_SECONDS and messages < MAX_EVENTS:
        try:
            line = source.readline(MAX_EVENT_BYTES+1000)
        except (OSError, TimeoutError):
            status = "BOUNDED_SSE_READ_TIMEOUT_OR_IO_INCOMPLETE"
            break
        if not line:
            status = "BOUNDED_SSE_EOF_INCOMPLETE"
            break
        total += len(line)
        if total > MAX_STREAM_BYTES:
            status = "BOUNDED_SSE_BYTE_CAP_INCOMPLETE"
            break
        aggregate.update(line)
        if line.startswith(b":"):
            pings += 1
            continue
        if line.startswith(b"data:"):
            chunks.append(line[5:].strip())
            if sum(len(x) for x in chunks) > MAX_EVENT_BYTES:
                status = "BOUNDED_SSE_EVENT_TOO_LARGE_INCOMPLETE"
                break
        elif line.strip() == b"":
            if not chunks:
                continue
            payload = b"\n".join(chunks)
            chunks = []
            received = now()
            messages += 1
            verdict = inspect_event(payload)
            kind = verdict["result"]
            if kind == "TARGET_PRICE_DECODED_UNAUTHENTICATED":
                candidates += 1
            elif kind == "NO_TARGET_IN_COMPLETE_BOUNDED_HINT":
                complete_nontarget += 1
            elif kind == "INCOMPLETE_HINT_CENSORED":
                partial += 1
            else:
                malformed += 1
            # Never publish raw private calldata, event hashes or user addresses.
            if len(sampled) < 40:
                sampled.append({"recv_utc_ns": received["utc_ns"],
                                "recv_monotonic_ns": received["monotonic_ns"],
                                "sha256_of_received_private_hint": sha256(payload).hexdigest(),
                                "classification": kind})
        elif not (line.startswith(b"event:") or line.startswith(b"id:") or
                  line.startswith(b"retry:")):
            status = "BOUNDED_SSE_MALFORMED_FRAME_INCOMPLETE"
            break
    if messages:
        status = ("PROSPECTIVE_SOURCE_LOCAL_HINTS_OBSERVED_NOT_PREINCLUSION_PROOF"
                  if status == "BOUNDED_SSE_NO_EVENT_DOES_NOT_PROVE_ABSENCE" else status)
    return {"status": status, "read_bytes": total, "sse_data_messages": messages,
            "ping_frames": pings, "decoded_target_unauthenticated": candidates,
            "complete_non_target_hints": complete_nontarget,
            "partial_hints_censored": partial, "malformed_hints_censored": malformed,
            "stream_transcript_sha256": aggregate.hexdigest(), "sampled": sampled,
            "stream_coverage_exhaustive": False,
            "event_hash_is_double_keccak_not_ethereum_receipt_hash": True,
            "actual_first_seen_on_network_proven": False,
            "pre_builder_deadline_proven": False,
            "Aave_HF_trigger_proven": False,
            "winning_bundle_inclusion_proven": False}


def bounded_archive_read(*, opener=urlopen):
    # Auxiliary coverage diagnostic, NEVER prospective observation.
    with open_fixed(HISTORY_INFO, opener=opener) as r:
        raw = r.read(MAX_HISTORY_BYTES+1)
    if len(raw) > MAX_HISTORY_BYTES:
        raise ValueError("oversized /history/info")
    info = strict_json(raw)
    if not isinstance(info, dict):
        raise ValueError("invalid /history/info")
    maximum = info.get("maxBlock")
    limit = info.get("maxLimit")
    if type(maximum) is not int or maximum < 0 or type(limit) is not int or not (1 <= limit <= 100000):
        raise ValueError("invalid historical bounds")
    start = max(0, maximum-8)
    count = min(MAX_HISTORY_EVENTS, limit)
    url = f"{HISTORY}?blockStart={start}&blockEnd={maximum}&limit={count}&offset=0"
    # Deterministic allowlist is checked against original bounds before opening.
    if url.count("&") != 3:
        raise ValueError("invalid bounded history URL")
    with open_fixed(url, opener=opener) as r:
        raw = r.read(MAX_HISTORY_BYTES+1)
    if len(raw) > MAX_HISTORY_BYTES:
        raise ValueError("oversized bounded history response")
    data = strict_json(raw)
    if not isinstance(data, list) or len(data) > count:
        raise ValueError("unbounded /history array")
    decoded = 0
    for row in data:
        if not isinstance(row, dict) or type(row.get("block")) is not int or not start <= row["block"] <= maximum:
            raise ValueError("invalid historical hint block")
        hint = row.get("hint")
        if not isinstance(hint, dict):
            continue
        verdict = inspect_event(canonical(hint).strip())
        decoded += verdict["result"] == "TARGET_PRICE_DECODED_UNAUTHENTICATED"
    return {"status":"BOUNDED_ARCHIVE_NOT_PROSPECTIVE", "max_source_block":maximum,
            "range_start":start,"history_count_capped":len(data),
            "target_price_decodes_unverified":decoded,
            "history_response_sha256":sha256(raw).hexdigest(),
            "history_not_source_time_proof":True}


def run(out: Path, *, opener=urlopen, archive=bounded_archive_read):
    out.mkdir(parents=True, exist_ok=False)
    frozen = {"schema_version":1, "created_before_network":clock(),
              "source_url":SSE_URL,
              "target_aggregator_from_PR732_not_SVR_eligible_by_assumption":WETH_AGGREGATOR,
              "forward_selector":"0x6fadcf72",
              "predeclared_max_stream_seconds":MAX_STREAM_SECONDS,
              "predeclared_max_events":MAX_EVENTS,
              "predeclared_max_bytes":MAX_STREAM_BYTES,
              "predeclared_archive_range":"maxBlock-8..maxBlock one page",
              "no_signing_or_broadcast":True}
    (out/"precommit-before-network.json").write_bytes(canonical(frozen))
    report = {"schema_version":1,"run_started":clock(),
              "result":"INCOMPLETE_NO_LIVE_SOURCE",
              "precommit_sha256":sha256(canonical(frozen)).hexdigest(),
              "source":"Flashbots documented Ethereum MEV-Share SSE one GET",
              "stream":None,"archive":None,"error_type":None,
              "public_sse_http_200_observed":False,"svr_feed_access_proven":False,"NQC_pre_inclusion_edge_proven":False,
              "builder_cutoff_proven":False,"net_EV_or_inclusion_proven":False,
              "native_gas_finance_proven":False,"PFT_closed":True,
              "RMC_closed":False,"Shadow_P2_certified":False,
              "live_authorized":False,"nqc_realized_pnl_usd":"0"}
    try:
        with open_fixed(SSE_URL, stream=True, opener=opener) as stream:
            report["public_sse_http_200_observed"] = True
            report["stream"] = consume_sse(stream)
            report["result"] = "PUBLIC_MEV_SHARE_SSE_HTTP_200_NOT_SVR_ACCESS_PROOF"
        try:
            report["archive"] = archive(opener=opener)
        except Exception as exc:
            report["archive"] = {"status":"INCOMPLETE_ARCHIVE_OBSERVABILITY",
                                 "error_type":type(exc).__name__,
                                 "source_http_status":getattr(exc,"code",None)}
    except HTTPError as exc:
        report["result"] = classification(exc.code)
        report["error_type"] = "HTTPError"
        report["source_http_status"] = exc.code
    except (URLError, OSError, ValueError, TimeoutError) as exc:
        report["result"] = "INCOMPLETE_SOURCE_TRANSPORT_OR_FRAMING"
        report["error_type"] = type(exc).__name__
        # Do not leak full URL, gateway secrets or response bytes.
    report["completed"] = clock()
    (out/"source-witness.json").write_bytes(canonical(report))
    return report


if __name__ == "__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("--out", type=Path,required=True)
    args=ap.parse_args()
    print(json.dumps(run(args.out),sort_keys=True))
