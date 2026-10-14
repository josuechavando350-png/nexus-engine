#!/usr/bin/env python3
"""NQC V2: offline, fail-closed admission of partial MEV-Share SVR hints.

No network, keys, wallets, signing, bids, simulation, trade, or access claim.
The source of each candidate is UNAUTHENTICATED until an independent
prospective source/timing witness is obtained. This deliberately cannot output
an eligible liquidation, profitable opportunity, or builder-deadline PASS.
"""
from __future__ import annotations

from hashlib import sha256
import json
import re

# Exact one-hop WETH aggregator proved in NQC PR732 at block 26193763.
WETH_AGGREGATOR = "0x7c7fdfca295a787ded12bb5c1a49a8d2cc20e3f8"
FORWARD_SELECTOR = bytes.fromhex("6fadcf72")
SECONDARY_SELECTOR = bytes.fromhex("ba0cb29e")
MAX_EVENT_BYTES = 200_000
MAX_CALLDATA_BYTES = 100_000
MAX_TRANSACTIONS = 16
MAX_OBSERVATIONS = 31
HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
HEX = re.compile(r"0x(?:[0-9a-fA-F]{2})*\Z")


class InvalidHint(ValueError):
    pass


def require(ok, reason):
    if not ok:
        raise InvalidHint(reason)


def json_strict(raw):
    def unique(entries):
        d = {}
        for k, v in entries:
            require(k not in d, "duplicate JSON key")
            d[k] = v
        return d
    def bad_constant(_):
        raise InvalidHint("non-JSON constant")
    return json.loads(raw, object_pairs_hook=unique, parse_constant=bad_constant)


def word(buf, at):
    require(type(at) is int and at >= 0 and at + 32 <= len(buf),
            "ABI word out of bounds")
    return int.from_bytes(buf[at:at+32], "big")


def dynamic(buf, offset_word, *, max_size):
    offset = word(buf, offset_word)
    require(offset % 32 == 0 and offset >= 32 and offset+32 <= len(buf),
            "ABI dynamic offset malformed")
    count = word(buf, offset)
    padded = ((count+31)//32)*32
    require(count <= max_size and offset+32+padded <= len(buf),
            "ABI dynamic payload out of bounds")
    tail = buf[offset+32+count:offset+32+padded]
    require(not any(tail), "ABI dynamic nonzero padding")
    return buf[offset+32:offset+32+count]


def signed192(buf, at):
    raw = word(buf, at)
    signed = raw if raw < (1<<255) else raw-(1<<256)
    require(-(1<<191) <= signed < (1<<191), "int192 sign extension invalid")
    return signed


def decode_report(raw):
    # Report = (uint32 observationTimestamp, bytes32 observers,
    #           int192[] observations, int192 juelsPerFeeCoin)
    require(len(raw) >= 160 and len(raw) % 32 == 0,
            "bad OCR report ABI length")
    ts = word(raw, 0)
    require(0 < ts < (1<<32), "bad OCR observations timestamp")
    offset = word(raw, 64)
    require(offset == 128, "noncanonical OCR observations offset")
    count = word(raw, offset)
    require(1 <= count <= MAX_OBSERVATIONS and
            offset+32+32*count == len(raw),
            "OCR observations count, size or trailing data invalid")
    values = [signed192(raw, offset+32+i*32) for i in range(count)]
    require(values == sorted(values) and values[0] > 0,
            "OCR observations nonpositive or unsorted")
    signed192(raw, 96)
    return {"observations_timestamp": ts,
            "observation_count": count,
            "median_signed_int192_raw": str(values[count//2])}


def decode_forward(blob):
    require(4+96 <= len(blob) <= MAX_CALLDATA_BYTES and
            blob[:4] == FORWARD_SELECTOR,
            "not canonical forward(address,bytes) call")
    args = blob[4:]
    dest = word(args, 0)
    require(0 < dest < 1<<160 and word(args, 32) == 64,
            "bad forward target or offset")
    size = word(args, 64)
    padded = ((size+31)//32)*32
    require(4+224 <= len(blob) and size >= 4 and
            size <= MAX_CALLDATA_BYTES and len(args) == 96+padded,
            "noncanonical forward nested bytes")
    nested = args[96:96+size]
    require(not any(args[96+size:]), "nonzero forward bytes padding")
    return "0x"+format(dest, "040x"), nested


def decode_secondary(nested):
    require(nested[:4] == SECONDARY_SELECTOR and len(nested) >= 4+224,
            "not transmitSecondary or truncated head")
    args = nested[4:]
    require(len(args)%32 == 0, "malformed transmitSecondary ABI")
    off_report = word(args, 96)
    off_rs = word(args, 128)
    off_ss = word(args, 160)
    require(off_report == 224 and off_report < off_rs < off_ss and
            off_report%32 == off_rs%32 == off_ss%32 == 0,
            "noncanonical report/signature offsets")
    report = dynamic(args, 96, max_size=12000)
    require(off_rs == off_report+32+((len(report)+31)//32)*32,
            "report overlaps signature region")
    for here, bound in ((off_rs, off_ss), (off_ss, len(args))):
        count = word(args, here)
        require(count <= 31 and here+32+count*32 == bound,
                "noncanonical signature array")
    return decode_report(report)


def inspect_event(raw: bytes, *, expected=WETH_AGGREGATOR):
    """Classification is data-readiness only, never authenticated first-seen."""
    require(type(raw) is bytes and 0 < len(raw) <= MAX_EVENT_BYTES,
            "invalid/oversized event")
    require(type(expected) is str and ADDRESS.fullmatch(expected),
            "untrusted expected aggregator")
    digest = sha256(raw).hexdigest()
    base = {"event_sha256": digest,
            "result": "INCOMPLETE_HINT_CENSORED",
            "oracle_price_authority": False,
            "actual_preinclusion_reception_proven": False,
            "builder_deadline_proven": False,
            "liquidation_eligible_proven": False,
            "net_profit_proven": False,
            "native_gas_funding_proven": False,
            "nqc_realized_pnl_usd": "0"}
    try:
        event = json_strict(raw)
        require(type(event) is dict and
                type(event.get("hash")) is str and HASH.fullmatch(event["hash"]),
                "event hash missing or malformed")
        txs = event.get("txs")
        if not isinstance(txs, list) or not txs:
            base["reason"] = "NO_TRANSACTION_HINTS"
            return base
        require(len(txs) <= MAX_TRANSACTIONS, "excessive transaction hints")
        incomplete = False
        other = 0
        for tx in txs:
            require(type(tx) is dict, "malformed transaction hint")
            selector = tx.get("functionSelector")
            payload = tx.get("callData")
            if selector is None or payload is None:
                incomplete = True
                continue
            require(type(selector) is str and
                    re.fullmatch(r"(?:0x)?[0-9a-fA-F]{8}", selector),
                    "malformed selector")
            if selector.lower().removeprefix("0x") != FORWARD_SELECTOR.hex():
                other += 1
                continue
            require(type(payload) is str and HEX.fullmatch(payload) and
                    len(payload)//2 <= MAX_CALLDATA_BYTES+1,
                    "malformed or oversized callData")
            blob = bytes.fromhex(payload[2:])
            require(blob[:4] == FORWARD_SELECTOR, "selector/callData disagreement")
            dest, nested = decode_forward(blob)
            if dest != expected.lower():
                other += 1
                continue
            report = decode_secondary(nested)
            base.update({"result": "TARGET_PRICE_DECODED_UNAUTHENTICATED",
                         "aggregator": dest,
                         "event_hash": event["hash"].lower(),
                         "report": report,
                         "report_value_is_raw_not_USD": True,
                         "next_required_gate": "AUTHENTICATED_BEFORE_BUILDER_CUTOFF"})
            return base
        base["result"] = ("INCOMPLETE_HINT_CENSORED" if incomplete else
                          "NO_TARGET_IN_COMPLETE_BOUNDED_HINT")
        base["reason"] = ("PARTIAL_HINTS_CANNOT_EXCLUDE_TARGET" if incomplete
                          else "ONLY_INSPECTED_THIS_BOUNDED_HINT")
        base["non_target_entries"] = other
    except (InvalidHint, ValueError, OverflowError, TypeError) as err:
        base["result"] = "INVALID_HINT_CENSORED"
        base["reason"] = str(err)[:120]
    return base


def deadline_gate(*, actual_source_proven, recv_monotonic_ns,
                  ready_monotonic_ns, independent_builder_cutoff_ns=None):
    """Unknown builder cutoff must not be silently replaced by block time."""
    if (not actual_source_proven or
        type(recv_monotonic_ns) is not int or
        type(ready_monotonic_ns) is not int or
        recv_monotonic_ns <= 0 or ready_monotonic_ns < recv_monotonic_ns):
        return "INCOMPLETE_NO_AUTHENTICATED_SOURCE_OR_CLOCK"
    if independent_builder_cutoff_ns is None:
        return "INCOMPLETE_BUILDER_DEADLINE_UNKNOWN"
    if (type(independent_builder_cutoff_ns) is not int or
        independent_builder_cutoff_ns <= 0):
        return "INCOMPLETE_BAD_DEADLINE_AUTHORITY"
    if ready_monotonic_ns >= independent_builder_cutoff_ns:
        return "FAIL_PREPARED_AT_OR_AFTER_BUILDER_CUTOFF"
    return "PREPARED_BEFORE_CUTOFF_ONLY_NOT_INCLUSION_OR_PROFIT"
