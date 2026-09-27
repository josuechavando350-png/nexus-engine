#!/usr/bin/env python3
"""Discover and attest a real historical Ethereum PoW orphan for V2 reorg invalidation.

The orphan is not synthesized. It is fetched through eth_getUncleByBlockNumberAndIndex,
verified independently by two providers, then paired with the canonical block at the
same execution height. Canonical V2 state is captured at that exact height.
"""
import argparse
import hashlib
import json
import re
import time
from pathlib import Path

from reserve_balance_witness import PROVIDERS, PROVIDER_MIN_INTERVAL, rpc, digest

SEARCH_START = 10_500_000
SEARCH_END = 10_500_199
FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"
PAIR = "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc"
TOKEN0_SELECTOR = "0x0dfe1681"
TOKEN1_SELECTOR = "0xd21220a7"
RESERVES_SELECTOR = "0x0902f1ac"
GET_PAIR_SELECTOR = "0xe6a43905"


def word_address(value):
    if not re.fullmatch(r"0x[0-9a-fA-F]{64}", value):
        raise ValueError("noncanonical address ABI word")
    raw = int(value, 16)
    if raw >= 2**160:
        raise ValueError("address ABI overflow")
    return f"0x{raw:040x}"


def address_word(value):
    value = value.lower()
    if not re.fullmatch(r"0x[0-9a-f]{40}", value):
        raise ValueError("invalid address")
    return value[2:].rjust(64, "0")


def reserves(value):
    if not re.fullmatch(r"0x[0-9a-fA-F]{192}", value):
        raise ValueError("noncanonical getReserves result")
    words = [int(value[i:i+64], 16) for i in range(2, len(value), 64)]
    if words[0] >= 2**112 or words[1] >= 2**112 or words[2] >= 2**32:
        raise ValueError("reserve ABI domain mismatch")
    return words


class Client:
    def __init__(self, provider, out):
        self.provider_id, self.url = provider
        self.min_interval = PROVIDER_MIN_INTERVAL[self.provider_id]
        self.serial = 0
        self.log_path = out / f"{self.provider_id}-real-reorg-rpc.jsonl"

    def call(self, method, params):
        self.serial += 1
        time.sleep(self.min_interval)
        result = rpc(self.url, method, params, self.serial)
        with self.log_path.open("a") as handle:
            handle.write(json.dumps(
                {"method": method, "params": params, "result": result},
                sort_keys=True,
            ) + "\n")
        return result


def block_identity(block):
    return {
        "number": int(block["number"], 16),
        "hash": block["hash"].lower(),
        "parent_hash": block["parentHash"].lower(),
        "timestamp": int(block["timestamp"], 16),
        "base_fee_per_gas": (
            int(block["baseFeePerGas"], 16)
            if block.get("baseFeePerGas") is not None else None
        ),
    }


def v2_state(client, canonical):
    block_arg = {"blockHash": canonical["hash"], "requireCanonical": True}

    def eth_call(target, data):
        return client.call("eth_call", [{"to": target, "data": data}, block_arg])

    token0 = word_address(eth_call(PAIR, TOKEN0_SELECTOR))
    token1 = word_address(eth_call(PAIR, TOKEN1_SELECTOR))
    reserve0, reserve1, ts = reserves(eth_call(PAIR, RESERVES_SELECTOR))
    canonical_pair = word_address(
        eth_call(FACTORY, GET_PAIR_SELECTOR + address_word(token0) + address_word(token1))
    )
    if canonical_pair != PAIR:
        raise ValueError("factory membership mismatch")

    pair_code = client.call("eth_getCode", [PAIR, block_arg])
    factory_code = client.call("eth_getCode", [FACTORY, block_arg])
    for name, raw in (("pair", pair_code), ("factory", factory_code)):
        if not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", raw):
            raise ValueError(f"missing {name} code at canonical anchor")

    return {
        "factory": FACTORY,
        "pair": PAIR,
        "token0": token0,
        "token1": token1,
        "reserve0": reserve0,
        "reserve1": reserve1,
        "block_timestamp_last": ts,
        "fee_bps": 30,
        "pair_code_sha256": hashlib.sha256(bytes.fromhex(pair_code[2:])).hexdigest(),
        "factory_code_sha256": hashlib.sha256(bytes.fromhex(factory_code[2:])).hexdigest(),
    }


def discover(primary, out):
    if int(primary.call("eth_chainId", []), 16) != 1:
        raise ValueError("wrong chain")
    for including_number in range(SEARCH_START, SEARCH_END + 1):
        count = int(primary.call("eth_getUncleCountByBlockNumber", [hex(including_number)]), 16)
        if count == 0:
            continue
        for index in range(count):
            uncle = primary.call(
                "eth_getUncleByBlockNumberAndIndex",
                [hex(including_number), hex(index)],
            )
            if uncle is None:
                continue
            orphan = block_identity(uncle)
            canonical_block = primary.call(
                "eth_getBlockByNumber", [hex(orphan["number"]), False]
            )
            canonical = block_identity(canonical_block)
            if orphan["hash"] == canonical["hash"]:
                continue
            canonical_parent = block_identity(primary.call(
                "eth_getBlockByNumber", [hex(orphan["number"] - 1), False]
            ))
            # We deliberately select a real shallow orphan here. Deep replacement
            # semantics are exercised separately with a deterministic multi-block test.
            if orphan["parent_hash"] != canonical_parent["hash"]:
                continue
            return {
                "including_block_number": including_number,
                "uncle_index": index,
                "orphan": orphan,
                "canonical": canonical,
                "canonical_parent": canonical_parent,
                "observed_real_reorg_depth": 1,
                "v2": v2_state(primary, canonical),
            }
    raise ValueError(
        f"no real shallow orphan found in deterministic range {SEARCH_START}-{SEARCH_END}"
    )


def verify(provider, candidate, out):
    client = Client(provider, out)
    if int(client.call("eth_chainId", []), 16) != 1:
        raise ValueError("wrong chain")

    uncle = client.call(
        "eth_getUncleByBlockNumberAndIndex",
        [hex(candidate["including_block_number"]), hex(candidate["uncle_index"])],
    )
    if uncle is None:
        raise ValueError("provider cannot resolve locked historical orphan")
    observed_orphan = block_identity(uncle)
    canonical = block_identity(client.call(
        "eth_getBlockByNumber", [hex(candidate["orphan"]["number"]), False]
    ))
    parent = block_identity(client.call(
        "eth_getBlockByNumber", [hex(candidate["orphan"]["number"] - 1), False]
    ))
    observed = {
        "including_block_number": candidate["including_block_number"],
        "uncle_index": candidate["uncle_index"],
        "orphan": observed_orphan,
        "canonical": canonical,
        "canonical_parent": parent,
        "observed_real_reorg_depth": 1,
        "v2": v2_state(client, canonical),
    }
    if observed != candidate:
        raise ValueError(f"PROVIDER_DISSENT: {client.provider_id} historical orphan/state mismatch")
    return observed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    primary = Client(PROVIDERS[0], args.out)
    candidate = discover(primary, args.out)
    observations = [candidate]
    for provider in PROVIDERS[1:]:
        observations.append(verify(provider, candidate, args.out))

    if observations[0] != observations[1]:
        raise ValueError("PROVIDER_DISSENT: exact real-reorg observations differ")

    witness = {
        "schema_version": 1,
        "gate": "V2_REAL_HISTORICAL_ORPHAN_INVALIDATION_WITNESS",
        "providers": [p[0] for p in PROVIDERS],
        "search_range": [SEARCH_START, SEARCH_END],
        **candidate,
        "classification": "REAL_POW_ORPHAN_HEADER_PLUS_CANONICAL_V2_STATE",
        "deep_reorg_semantics": "DETERMINISTIC_MULTI_BLOCK_REPLACEMENT_TEST_REQUIRED_SEPARATELY",
        "protocol_fork_truth": "NOT_CLOSED",
    }
    witness["attestation_sha256"] = digest(witness)
    (args.out / "v2-real-reorg-witness.json").write_text(
        json.dumps(witness, indent=2, sort_keys=True) + "\n"
    )
    print(
        "V2_REAL_REORG_WITNESS_PASS "
        f"including_block={candidate['including_block_number']} "
        f"height={candidate['orphan']['number']} "
        f"orphan={candidate['orphan']['hash']} "
        f"canonical={candidate['canonical']['hash']}",
        flush=True,
    )


if __name__ == "__main__":
    main()
