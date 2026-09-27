#!/usr/bin/env python3
"""Two-provider exact historical Uniswap V2 state and quote witness."""
import argparse
import hashlib
import json
import re
import time
from pathlib import Path

from reserve_balance_witness import PROVIDERS, PROVIDER_MIN_INTERVAL, rpc, digest

FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"
ROUTER = "0x7a250d5630b4cf539739df2c5dacab4c659f2488d"
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
DAI = "0x6b175474e89094c44da98b954eedeac495271d0f"
USDC_WETH = "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc"
DAI_WETH = "0xa478c2975ab1ea89e8196811f51a7b7ade33eb11"
FEE_BPS = 30
AMOUNT_IN = 10_000 * 10**6

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

SELECTORS = {
    "token0()": "0x0dfe1681",
    "token1()": "0xd21220a7",
    "getReserves()": "0x0902f1ac",
    "getPair(address,address)": "0xe6a43905",
    "getAmountsOut(uint256,address[])": "0xd06ca61f",
}


def address_word(value):
    value = value.lower()
    if not re.fullmatch(r"0x[0-9a-f]{40}", value):
        raise ValueError("invalid address")
    return value[2:].rjust(64, "0")


def uint_word(value):
    if not 0 <= int(value) < 2**256:
        raise ValueError("uint out of range")
    return f"{int(value):064x}"


def decode_words(value, count=None):
    if not isinstance(value, str) or not value.startswith("0x") or len(value[2:]) % 64:
        raise ValueError("noncanonical ABI words")
    words = [int(value[i:i + 64], 16) for i in range(2, len(value), 64)]
    if count is not None and len(words) != count:
        raise ValueError(f"expected {count} ABI words, got {len(words)}")
    return words


def decode_address(value):
    words = decode_words(value, 1)
    word = words[0]
    if word >= 2**160:
        raise ValueError("noncanonical address word")
    return f"0x{word:040x}"


def decode_amounts(value):
    words = decode_words(value)
    if len(words) < 3 or words[0] != 32:
        raise ValueError("invalid dynamic uint[] encoding")
    length = words[1]
    if len(words) != 2 + length:
        raise ValueError("uint[] length mismatch")
    return words[2:]


def quote(reserve_in, reserve_out, amount_in):
    amount_with_fee = amount_in * (10_000 - FEE_BPS)
    return amount_with_fee * reserve_out // (reserve_in * 10_000 + amount_with_fee)


def pair_quote(pair, token_in, amount_in):
    if token_in == pair["token0"]:
        return pair["token1"], quote(pair["reserve0"], pair["reserve1"], amount_in)
    if token_in == pair["token1"]:
        return pair["token0"], quote(pair["reserve1"], pair["reserve0"], amount_in)
    raise ValueError("token not in pair")


def encode_get_amounts_out(amount_in, path):
    return (
        SELECTORS["getAmountsOut(uint256,address[])"]
        + uint_word(amount_in)
        + uint_word(64)
        + uint_word(len(path))
        + "".join(address_word(x) for x in path)
    )


def collect(provider, out):
    provider_id, url = provider
    serial = 0
    min_interval = PROVIDER_MIN_INTERVAL[provider_id]
    log_path = out / f"{provider_id}-v2-rpc.jsonl"

    def call(method, params):
        nonlocal serial
        serial += 1
        time.sleep(min_interval)
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

    def code_hash(target, block_arg):
        raw = call("eth_getCode", [target, block_arg])
        if not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", raw):
            raise ValueError(f"missing code: {target}")
        return hashlib.sha256(bytes.fromhex(raw[2:])).hexdigest()

    cases = []
    for fixed in ANCHORS:
        number = fixed["block_number"]
        block = call("eth_getBlockByNumber", [hex(number), False])
        if (
            int(block["number"], 16) != number
            or block["hash"].lower() != fixed["block_hash"]
            or block["parentHash"].lower() != fixed["parent_hash"]
        ):
            raise ValueError("canonical anchor mismatch")
        block_arg = {"blockHash": fixed["block_hash"], "requireCanonical": True}

        pairs = []
        for pair_addr in (USDC_WETH, DAI_WETH):
            token0 = decode_address(eth_call(pair_addr, SELECTORS["token0()"], block_arg))
            token1 = decode_address(eth_call(pair_addr, SELECTORS["token1()"], block_arg))
            if token0 == token1 or token0 == "0x" + "00" * 20:
                raise ValueError("invalid pair token identity")
            reserve0, reserve1, ts = decode_words(
                eth_call(pair_addr, SELECTORS["getReserves()"], block_arg), 3
            )
            if reserve0 >= 2**112 or reserve1 >= 2**112 or ts >= 2**32:
                raise ValueError("reserve ABI domain mismatch")
            get_pair_data = (
                SELECTORS["getPair(address,address)"]
                + address_word(token0)
                + address_word(token1)
            )
            canonical_pair = decode_address(eth_call(FACTORY, get_pair_data, block_arg))
            if canonical_pair != pair_addr:
                raise ValueError("factory membership mismatch")
            pairs.append({
                "pair": pair_addr,
                "token0": token0,
                "token1": token1,
                "reserve0": reserve0,
                "reserve1": reserve1,
                "block_timestamp_last": ts,
                "code_sha256": code_hash(pair_addr, block_arg),
            })

        by_pair = {p["pair"]: p for p in pairs}
        single_raw = eth_call(
            ROUTER,
            encode_get_amounts_out(AMOUNT_IN, [USDC, WETH]),
            block_arg,
        )
        multi_raw = eth_call(
            ROUTER,
            encode_get_amounts_out(AMOUNT_IN, [USDC, WETH, DAI]),
            block_arg,
        )
        single = decode_amounts(single_raw)
        multi = decode_amounts(multi_raw)
        if len(single) != 2 or len(multi) != 3:
            raise ValueError("router amount length mismatch")

        token, local_single = pair_quote(by_pair[USDC_WETH], USDC, AMOUNT_IN)
        if token != WETH or single != [AMOUNT_IN, local_single]:
            raise ValueError("single-hop router/formula mismatch")

        token, hop1 = pair_quote(by_pair[USDC_WETH], USDC, AMOUNT_IN)
        token2, hop2 = pair_quote(by_pair[DAI_WETH], token, hop1)
        if token2 != DAI or multi != [AMOUNT_IN, hop1, hop2]:
            raise ValueError("multi-hop router/formula mismatch")

        after = call("eth_getBlockByNumber", [hex(number), False])
        if after["hash"].lower() != fixed["block_hash"]:
            raise ValueError("canonical anchor changed during witness")

        cases.append({
            **fixed,
            "timestamp": int(block["timestamp"], 16),
            "factory": FACTORY,
            "factory_code_sha256": code_hash(FACTORY, block_arg),
            "router": ROUTER,
            "router_code_sha256": code_hash(ROUTER, block_arg),
            "fee_bps": FEE_BPS,
            "pairs": sorted(pairs, key=lambda p: p["pair"]),
            "quotes": {
                "single_usdc_weth": {
                    "amount_in": AMOUNT_IN,
                    "path": [USDC, WETH],
                    "amounts": single,
                },
                "multi_usdc_weth_dai": {
                    "amount_in": AMOUNT_IN,
                    "path": [USDC, WETH, DAI],
                    "amounts": multi,
                },
            },
        })
        print(
            f"V2_WITNESS upstream={provider_id} block={number} "
            f"pairs={len(pairs)} single_out={single[-1]} multi_out={multi[-1]}",
            flush=True,
        )

    return {
        "selectors": SELECTORS,
        "cases": cases,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    observations = []
    for provider in PROVIDERS:
        observation = collect(provider, args.out)
        (args.out / f"{provider[0]}-v2-witness.json").write_text(
            json.dumps(observation, indent=2, sort_keys=True) + "\n"
        )
        observations.append(observation)

    if observations[0] != observations[1]:
        raise ValueError("PROVIDER_DISSENT: exact V2 observations differ")

    witness = {
        "schema_version": 1,
        "gate": "V2_HISTORICAL_STATE_AND_QUOTE_EXTERNAL_WITNESS",
        "providers": [p[0] for p in PROVIDERS],
        **observations[0],
        "nqc_parity": "NOT_TESTED",
        "protocol_fork_truth": "NOT_CLOSED",
    }
    witness["attestation_sha256"] = digest(witness)
    (args.out / "v2-historical-witness.json").write_text(
        json.dumps(witness, indent=2, sort_keys=True) + "\n"
    )
    print("V2_EXTERNAL_WITNESS_CONSENSUS_PASS", flush=True)


if __name__ == "__main__":
    main()
