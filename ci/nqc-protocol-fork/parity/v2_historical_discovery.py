#!/usr/bin/env python3
"""Discover immutable early-mainnet Uniswap V2 anchors for T39.

Discovery only: this script never promotes V2 parity. It captures exact
block-hash-bound factory/pair/reserve truth from multiple independent RPCs.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
import argparse

CHAIN_ID = 1
FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"
FEE_BPS = 30
ANCHORS = [10014178, 10091097]
MAX_PAIRS = 128
MIN_VALID_PROVIDERS = 2
MAX_ATTEMPTS = 8
PROVIDERS = [
    ("drpc-public", "https://eth.drpc.org", 0.30),
    ("blastapi-public", "https://eth-mainnet.public.blastapi.io", 0.30),
    ("publicnode-ethereum", "https://ethereum-rpc.publicnode.com", 0.35),
    ("mevblocker-rpc", "https://rpc.mevblocker.io", 1.00),
]
SELECTORS = {
    "allPairsLength()": "0x574f2ba3",
    "allPairs(uint256)": "0x1e3dd18b",
    "token0()": "0x0dfe1681",
    "token1()": "0xd21220a7",
    "getReserves()": "0x0902f1ac",
}


def fail(message):
    raise RuntimeError(message)


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def rpc(url, method, params, request_id):
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
                      separators=(",", ":")).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": "nqc-t39-v2-historical-discovery/1",
        },
        method="POST",
    )
    last = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                payload = json.loads(response.read())
            if payload.get("id") != request_id:
                fail("RPC id mismatch")
            if "error" in payload:
                raise RuntimeError(f"rpc error: {payload['error']}")
            if "result" not in payload:
                fail("missing RPC result")
            return payload["result"]
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ConnectionError, OSError, RuntimeError) as exc:
            last = exc
            if attempt == MAX_ATTEMPTS:
                break
            time.sleep(min(12.0, 0.5 * (2 ** (attempt - 1))))
    raise RuntimeError(str(last))


def decode_word(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", value):
        fail(f"{label}: expected one canonical ABI word")
    return int(value[2:], 16)


def decode_address(value, label):
    word = decode_word(value, label)
    if word >> 160:
        fail(f"{label}: noncanonical address word")
    if word == 0:
        fail(f"{label}: zero address")
    return f"0x{word:040x}"


def decode_reserves(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{192}", value):
        fail("getReserves: expected three ABI words")
    words = [int(value[2 + 64*i:2 + 64*(i+1)], 16) for i in range(3)]
    if words[0] >= 2**112 or words[1] >= 2**112 or words[2] >= 2**32:
        fail("getReserves domain overflow")
    return words


def exact_call(call, number, block_hash, to, data):
    block_hex = hex(number)
    try:
        return call("eth_call", [{"to": to, "data": data},
                                  {"blockHash": block_hash, "requireCanonical": True}]), "EIP1898_BLOCK_HASH"
    except Exception as first:
        before = call("eth_getBlockByNumber", [block_hex, False])
        if not before or before.get("hash", "").lower() != block_hash:
            fail(f"pre-call canonical guard mismatch after EIP-1898 failure: {first}")
        result = call("eth_call", [{"to": to, "data": data}, block_hex])
        after = call("eth_getBlockByNumber", [block_hex, False])
        if not after or after.get("hash", "").lower() != block_hash:
            fail("post-call canonical guard mismatch")
        return result, "BLOCK_NUMBER_WITH_PRE_POST_HASH_GUARD"


def quote_exact_in(reserve_in, reserve_out, amount_in):
    fee_multiplier = 10_000 - FEE_BPS
    amount_in_with_fee = amount_in * fee_multiplier
    out = amount_in_with_fee * reserve_out // (reserve_in * 10_000 + amount_in_with_fee)
    return out


def collect(provider_id, url, min_interval, out):
    serial = 0
    trace_path = out / f"{provider_id}-rpc.jsonl"

    def call(method, params):
        nonlocal serial
        serial += 1
        time.sleep(min_interval)
        result = rpc(url, method, params, serial)
        with trace_path.open("a") as f:
            f.write(json.dumps({"method": method, "params": params, "result": result}, sort_keys=True) + "\n")
        return result

    if int(call("eth_chainId", []), 16) != CHAIN_ID:
        fail("wrong chain id")

    cases = []
    for number in ANCHORS:
        block_hex = hex(number)
        block = call("eth_getBlockByNumber", [block_hex, False])
        if not block or int(block.get("number", "0x0"), 16) != number:
            fail(f"block {number} unavailable")
        block_hash = block["hash"].lower()
        parent_hash = block["parentHash"].lower()
        timestamp = int(block["timestamp"], 16)
        base_fee = int(block["baseFeePerGas"], 16) if block.get("baseFeePerGas") is not None else None

        code, code_mode = exact_call(call, number, block_hash, FACTORY, "0x")
        # eth_call with empty data is not a code read; use eth_getCode separately.
        factory_code = call("eth_getCode", [FACTORY, block_hex])
        if not isinstance(factory_code, str) or len(factory_code) <= 2:
            fail("factory code unavailable")
        factory_code_sha256 = hashlib.sha256(bytes.fromhex(factory_code[2:])).hexdigest()

        count_raw, count_mode = exact_call(call, number, block_hash, FACTORY, SELECTORS["allPairsLength()"])
        count = decode_word(count_raw, "allPairsLength")
        if count == 0 or count > MAX_PAIRS:
            fail(f"anchor {number}: pair count {count} outside 1..{MAX_PAIRS}")

        pairs = []
        modes = {count_mode, code_mode}
        for index in range(count):
            data = SELECTORS["allPairs(uint256)"] + f"{index:064x}"
            pair_raw, mode = exact_call(call, number, block_hash, FACTORY, data)
            modes.add(mode)
            pair = decode_address(pair_raw, f"allPairs({index})")

            token0_raw, mode = exact_call(call, number, block_hash, pair, SELECTORS["token0()"])
            modes.add(mode)
            token1_raw, mode = exact_call(call, number, block_hash, pair, SELECTORS["token1()"])
            modes.add(mode)
            reserves_raw, mode = exact_call(call, number, block_hash, pair, SELECTORS["getReserves()"])
            modes.add(mode)

            token0 = decode_address(token0_raw, "token0")
            token1 = decode_address(token1_raw, "token1")
            if token0 == token1:
                fail("identical pair tokens")
            reserve0, reserve1, block_timestamp_last = decode_reserves(reserves_raw)
            pair_code = call("eth_getCode", [pair, block_hex])
            if not isinstance(pair_code, str) or len(pair_code) <= 2:
                fail(f"pair code unavailable: {pair}")
            pairs.append({
                "factory_index": index,
                "pair": pair,
                "token0": token0,
                "token1": token1,
                "reserve0": str(reserve0),
                "reserve1": str(reserve1),
                "block_timestamp_last": block_timestamp_last,
                "pair_code_sha256": hashlib.sha256(bytes.fromhex(pair_code[2:])).hexdigest(),
            })

        by_number_after = call("eth_getBlockByNumber", [block_hex, False])
        if by_number_after["hash"].lower() != block_hash:
            fail("canonical anchor changed during enumeration")

        pairs_sorted = sorted(pairs, key=lambda x: x["pair"])
        quotes = []
        for pair in pairs_sorted:
            r0, r1 = int(pair["reserve0"]), int(pair["reserve1"])
            if r0 == 0 or r1 == 0:
                continue
            amount_in = max(1, r0 // 10_000)
            amount_out = quote_exact_in(r0, r1, amount_in)
            if amount_out == 0:
                continue
            quotes.append({
                "pair": pair["pair"],
                "token_in": pair["token0"],
                "token_out": pair["token1"],
                "amount_in": str(amount_in),
                "amount_out": str(amount_out),
            })
            if len(quotes) == 3:
                break

        live = sum(int(p["reserve0"]) > 0 and int(p["reserve1"]) > 0 for p in pairs_sorted)
        zero = len(pairs_sorted) - live
        cases.append({
            "block_number": number,
            "block_hash": block_hash,
            "parent_hash": parent_hash,
            "timestamp": timestamp,
            "base_fee_per_gas": base_fee,
            "factory": FACTORY,
            "factory_code_sha256": factory_code_sha256,
            "fee_bps": FEE_BPS,
            "pair_count": count,
            "live_pair_count": live,
            "zero_liquidity_pair_count": zero,
            "state_addressing_modes": sorted(modes),
            "pairs": pairs_sorted,
            "quotes": quotes,
        })
        print(f"DISCOVER provider={provider_id} block={number} pairs={count} live={live} quotes={len(quotes)}", flush=True)

    return {"provider_id": provider_id, "cases": cases}


def normalize_for_consensus(observation):
    return observation["cases"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    successes = []
    failures = []
    for provider_id, url, min_interval in PROVIDERS:
        try:
            observation = collect(provider_id, url, min_interval, args.out)
            (args.out / f"{provider_id}-observation.json").write_text(json.dumps(observation, indent=2) + "\n")
            successes.append(observation)
        except Exception as exc:
            failures.append({"provider_id": provider_id, "error": f"{type(exc).__name__}: {exc}"})
            (args.out / f"{provider_id}-failure.json").write_text(json.dumps(failures[-1], indent=2) + "\n")
            print(f"PROVIDER_FAILURE provider={provider_id} error={exc}", flush=True)

    if len(successes) < MIN_VALID_PROVIDERS:
        fail(f"only {len(successes)} valid providers; need {MIN_VALID_PROVIDERS}")

    reference = normalize_for_consensus(successes[0])
    dissent = [x["provider_id"] for x in successes[1:] if normalize_for_consensus(x) != reference]
    if dissent:
        fail(f"PROVIDER_DISSENT: {dissent}")

    if not any(case["quotes"] for case in reference):
        fail("no live exact-in quote fixture discovered")

    witness = {
        "schema_version": 1,
        "gate": "V2_HISTORICAL_DISCOVERY",
        "classification": "DISCOVERY_ONLY_NOT_PARITY",
        "chain_id": CHAIN_ID,
        "factory": FACTORY,
        "fee_bps": FEE_BPS,
        "anchor_numbers": ANCHORS,
        "consensus_providers": [x["provider_id"] for x in successes],
        "failed_providers": failures,
        "selectors": SELECTORS,
        "cases": reference,
        "nqc_v2_state_parity": "NOT_TESTED",
        "nqc_v2_quote_parity": "NOT_TESTED",
        "protocol_fork_truth": "NOT_CLOSED",
    }
    witness["attestation_sha256"] = sha(witness)
    (args.out / "v2-historical-discovery.json").write_text(json.dumps(witness, indent=2, sort_keys=True) + "\n")
    print(
        f"V2_HISTORICAL_DISCOVERY_CONSENSUS_PASS providers={len(successes)} "
        f"cases={len(reference)} attestation={witness['attestation_sha256']}",
        flush=True,
    )


if __name__ == "__main__":
    main()
