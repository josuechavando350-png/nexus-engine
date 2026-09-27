#!/usr/bin/env python3
"""Exact two-provider historical Uniswap V2 Sync-transition witness."""
import argparse
import json
import re
import time
from pathlib import Path

from reserve_balance_witness import PROVIDERS, PROVIDER_MIN_INTERVAL, rpc, digest
from v2_historical_witness import (
    FACTORY,
    USDC_WETH,
    FEE_BPS,
    SELECTORS,
    address_word,
    decode_address,
    decode_words,
)

SYNC_TOPIC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1"

ANCHORS = [
    {
        "block_number": 25_252_136,
        "block_hash": "0x49edc621ec5fe843353be319ae1a307be4e37d2a51111ccc07a2c8aae3ff6470",
        "parent_hash": "0x04a2465e3a87b1103521c1f54e568de209062f08742a0212da24d34eee4aac78",
    },
    {
        "block_number": 25_437_474,
        "block_hash": "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8",
        "parent_hash": "0x033656168ee1dba1934f77171fe572c866282e97738b79434cb8c01b6e6f88f2",
    },
]


def collect(provider, out):
    provider_id, url = provider
    serial = 0
    log_path = out / f"{provider_id}-v2-sync-rpc.jsonl"

    def call(method, params):
        nonlocal serial
        serial += 1
        time.sleep(PROVIDER_MIN_INTERVAL[provider_id])
        result = rpc(url, method, params, serial)
        with log_path.open("a") as handle:
            handle.write(json.dumps(
                {"method": method, "params": params, "result": result},
                sort_keys=True,
            ) + "\n")
        return result

    if int(call("eth_chainId", []), 16) != 1:
        raise ValueError("wrong chain")

    def eth_call(target, data, block_arg):
        return call("eth_call", [{"to": target, "data": data}, block_arg])

    def pair_state(block_arg):
        token0 = decode_address(eth_call(USDC_WETH, SELECTORS["token0()"], block_arg))
        token1 = decode_address(eth_call(USDC_WETH, SELECTORS["token1()"], block_arg))
        reserve0, reserve1, ts = decode_words(
            eth_call(USDC_WETH, SELECTORS["getReserves()"], block_arg), 3
        )
        canonical_pair = decode_address(
            eth_call(
                FACTORY,
                SELECTORS["getPair(address,address)"]
                + address_word(token0)
                + address_word(token1),
                block_arg,
            )
        )
        if canonical_pair != USDC_WETH:
            raise ValueError("factory pair binding mismatch")
        return {
            "pair": USDC_WETH,
            "token0": token0,
            "token1": token1,
            "reserve0": reserve0,
            "reserve1": reserve1,
            "block_timestamp_last": ts,
        }

    cases = []
    for fixed in ANCHORS:
        block = call("eth_getBlockByNumber", [hex(fixed["block_number"]), False])
        if (
            int(block["number"], 16) != fixed["block_number"]
            or block["hash"].lower() != fixed["block_hash"]
            or block["parentHash"].lower() != fixed["parent_hash"]
        ):
            raise ValueError("target block identity mismatch")

        parent = call("eth_getBlockByHash", [fixed["parent_hash"], False])
        if (
            int(parent["number"], 16) != fixed["block_number"] - 1
            or parent["hash"].lower() != fixed["parent_hash"]
        ):
            raise ValueError("parent block identity mismatch")

        parent_arg = {"blockHash": fixed["parent_hash"], "requireCanonical": True}
        block_arg = {"blockHash": fixed["block_hash"], "requireCanonical": True}
        before = pair_state(parent_arg)
        after = pair_state(block_arg)

        logs = call(
            "eth_getLogs",
            [{
                "blockHash": fixed["block_hash"],
                "address": USDC_WETH,
                "topics": [SYNC_TOPIC],
            }],
        )
        if not logs:
            raise ValueError(
                f"NO_SYNC_AT_FIXED_ANCHOR block={fixed['block_number']}"
            )

        decoded = []
        for log in sorted(logs, key=lambda item: int(item["logIndex"], 16)):
            if (
                log["address"].lower() != USDC_WETH
                or log["blockHash"].lower() != fixed["block_hash"]
                or not log["topics"]
                or log["topics"][0].lower() != SYNC_TOPIC
            ):
                raise ValueError("Sync log identity mismatch")
            reserve0, reserve1 = decode_words(log["data"], 2)
            if reserve0 >= 2**112 or reserve1 >= 2**112:
                raise ValueError("Sync reserve outside uint112")
            decoded.append({
                "log_index": int(log["logIndex"], 16),
                "transaction_hash": log["transactionHash"].lower(),
                "reserve0": reserve0,
                "reserve1": reserve1,
            })

        final = decoded[-1]
        if (
            final["reserve0"] != after["reserve0"]
            or final["reserve1"] != after["reserve1"]
        ):
            raise ValueError("final Sync does not match canonical end-block reserves")
        if (
            before["reserve0"] == after["reserve0"]
            and before["reserve1"] == after["reserve1"]
        ):
            raise ValueError("Sync fixture does not change reserves")

        # Re-read exact anchors after logs to fail closed on any provider-side drift.
        parent_after = call("eth_getBlockByHash", [fixed["parent_hash"], False])
        block_after = call("eth_getBlockByHash", [fixed["block_hash"], False])
        if (
            parent_after["hash"].lower() != fixed["parent_hash"]
            or block_after["hash"].lower() != fixed["block_hash"]
        ):
            raise ValueError("canonical identity changed during witness")

        case = {
            **fixed,
            "pair": USDC_WETH,
            "factory": FACTORY,
            "fee_bps": FEE_BPS,
            "parent": {
                "number": int(parent["number"], 16),
                "hash": parent["hash"].lower(),
                "timestamp": int(parent["timestamp"], 16),
                "base_fee_per_gas": (
                    int(parent["baseFeePerGas"], 16)
                    if parent.get("baseFeePerGas") is not None
                    else None
                ),
                "state": before,
            },
            "target": {
                "number": int(block["number"], 16),
                "hash": block["hash"].lower(),
                "timestamp": int(block["timestamp"], 16),
                "base_fee_per_gas": (
                    int(block["baseFeePerGas"], 16)
                    if block.get("baseFeePerGas") is not None
                    else None
                ),
                "state": after,
            },
            "sync_logs": decoded,
        }
        cases.append(case)
        print(
            f"V2_SYNC_WITNESS upstream={provider_id} block={fixed['block_number']} "
            f"logs={len(decoded)} before={before['reserve0']}:{before['reserve1']} "
            f"after={after['reserve0']}:{after['reserve1']}",
            flush=True,
        )

    return {"sync_topic": SYNC_TOPIC, "cases": cases}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    observations = []
    for provider in PROVIDERS:
        observation = collect(provider, args.out)
        (args.out / f"{provider[0]}-v2-sync-witness.json").write_text(
            json.dumps(observation, indent=2, sort_keys=True) + "\n"
        )
        observations.append(observation)

    if observations[0] != observations[1]:
        raise ValueError("PROVIDER_DISSENT: V2 Sync witnesses differ")

    witness = {
        "schema_version": 1,
        "gate": "V2_HISTORICAL_SYNC_TRANSITION_WITNESS",
        "providers": [p[0] for p in PROVIDERS],
        **observations[0],
        "nqc_parity": "NOT_TESTED",
        "protocol_fork_truth": "NOT_CLOSED",
    }
    witness["attestation_sha256"] = digest(witness)
    (args.out / "v2-sync-witness.json").write_text(
        json.dumps(witness, indent=2, sort_keys=True) + "\n"
    )
    print("V2_SYNC_EXTERNAL_WITNESS_CONSENSUS_PASS", flush=True)


if __name__ == "__main__":
    main()
