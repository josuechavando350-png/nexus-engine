#!/usr/bin/env python3
"""Exact two-provider Aave V3 deployment/version lock for admitted historical anchors."""
import argparse
import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
EXPECTED_PROVIDER = "0x2f39d218133afab8f2b819b1066c7e434ad94e9e"
EXPECTED_ORACLE = "0x54586be62e3c3580375ae3723c145253060ca0c2"
IMPLEMENTATION_SLOT = (
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
)
FLASH_PREMIUM_SELECTOR = "0x074b2e43"
ADDRESSES_PROVIDER_SELECTOR = "0x0542975c"
GET_PRICE_ORACLE_SELECTOR = "0xfca513a8"

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

PROVIDERS = [
    ("blastapi-public", "https://eth-mainnet.public.blastapi.io", 0.35),
    ("mevblocker-rpc", "https://rpc.mevblocker.io", 1.25),
]

MAX_ATTEMPTS = 12


def retry_delay(attempt, retry_after=None):
    if retry_after:
        try:
            return min(30.0, max(0.5, float(retry_after)))
        except (TypeError, ValueError):
            pass
    return min(20.0, 0.75 * (2 ** max(0, attempt - 1)))


def rpc(url, method, params, request_id):
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
        separators=(",", ":"),
    ).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": "nqc-protocol-fork-truth/aave-deployment-lock-v1",
        },
    )
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                body = json.loads(response.read())
            if body.get("jsonrpc") != "2.0" or body.get("id") != request_id:
                raise RuntimeError("RPC envelope mismatch")
            if "error" in body:
                error = body["error"]
                message = str(error).lower()
                code = error.get("code") if isinstance(error, dict) else None
                if (
                    code in (-32097, -32005, 429)
                    or "rate limit" in message
                    or "too many" in message
                ):
                    if attempt == MAX_ATTEMPTS:
                        raise RuntimeError(f"RPC retry budget exhausted: {error}")
                    time.sleep(retry_delay(attempt))
                    continue
                raise RuntimeError(f"RPC error: {error}")
            return body["result"]
        except urllib.error.HTTPError as exc:
            if not (exc.code == 429 or 500 <= exc.code <= 599) or attempt == MAX_ATTEMPTS:
                raise
            time.sleep(retry_delay(attempt, exc.headers.get("Retry-After")))
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            if attempt == MAX_ATTEMPTS:
                raise
            time.sleep(retry_delay(attempt))
    raise RuntimeError("unreachable RPC retry exit")


class Client:
    def __init__(self, provider_id, url, min_interval, out):
        self.provider_id = provider_id
        self.url = url
        self.min_interval = min_interval
        self.serial = 0
        self.trace = out / f"{provider_id}-deployment-lock-rpc.jsonl"

    def call(self, method, params):
        self.serial += 1
        time.sleep(self.min_interval)
        result = rpc(self.url, method, params, self.serial)
        with self.trace.open("a") as handle:
            handle.write(
                json.dumps(
                    {"method": method, "params": params, "result": result},
                    sort_keys=True,
                )
                + "\n"
            )
        return result

    def exact(self, method, leading, anchor):
        block_hash = anchor["block_hash"]
        number = anchor["block_number"]
        try:
            return self.call(
                method,
                leading + [{"blockHash": block_hash, "requireCanonical": True}],
            ), "EIP1898_BLOCK_HASH"
        except Exception as exact_error:
            before = self.call("eth_getBlockByNumber", [hex(number), False])
            if (
                before is None
                or before["hash"].lower() != block_hash
                or int(before["number"], 16) != number
            ):
                raise RuntimeError(
                    f"exact-state fallback pre-guard failed after {exact_error}"
                )
            result = self.call(method, leading + [hex(number)])
            after = self.call("eth_getBlockByNumber", [hex(number), False])
            if after is None or after["hash"].lower() != block_hash:
                raise RuntimeError("exact-state fallback post-guard failed")
            return result, "BLOCK_NUMBER_WITH_PRE_POST_HASH_GUARD"


def decode_word(raw, label):
    if not isinstance(raw, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", raw):
        raise ValueError(f"{label}: expected one ABI/storage word")
    return int(raw, 16)


def decode_address_word(raw, label):
    value = decode_word(raw, label)
    if value == 0 or value >= 2**160:
        raise ValueError(f"{label}: noncanonical address word")
    return f"0x{value:040x}"


def code_sha256(raw, label):
    if not isinstance(raw, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", raw):
        raise ValueError(f"{label}: missing/noncanonical code")
    return hashlib.sha256(bytes.fromhex(raw[2:])).hexdigest()


def collect(provider, out):
    provider_id, url, min_interval = provider
    client = Client(provider_id, url, min_interval, out)
    if int(client.call("eth_chainId", []), 16) != 1:
        raise ValueError("wrong chain")

    cases = []
    access_modes = []
    for anchor in ANCHORS:
        block = client.call(
            "eth_getBlockByNumber", [hex(anchor["block_number"]), False]
        )
        if (
            block is None
            or int(block["number"], 16) != anchor["block_number"]
            or block["hash"].lower() != anchor["block_hash"]
            or block["parentHash"].lower() != anchor["parent_hash"]
        ):
            raise ValueError("canonical anchor mismatch")

        pool_code, mode = client.exact("eth_getCode", [POOL], anchor)
        access_modes.append(mode)
        impl_word, mode = client.exact(
            "eth_getStorageAt", [POOL, IMPLEMENTATION_SLOT], anchor
        )
        access_modes.append(mode)
        implementation = decode_address_word(impl_word, "implementation slot")
        implementation_code, mode = client.exact(
            "eth_getCode", [implementation], anchor
        )
        access_modes.append(mode)

        provider_raw, mode = client.exact(
            "eth_call",
            [{"to": POOL, "data": ADDRESSES_PROVIDER_SELECTOR}],
            anchor,
        )
        access_modes.append(mode)
        addresses_provider = decode_address_word(
            provider_raw, "ADDRESSES_PROVIDER()"
        )
        if addresses_provider != EXPECTED_PROVIDER:
            raise ValueError(
                f"addresses provider mismatch: {addresses_provider}"
            )

        provider_code, mode = client.exact(
            "eth_getCode", [addresses_provider], anchor
        )
        access_modes.append(mode)
        oracle_raw, mode = client.exact(
            "eth_call",
            [{"to": addresses_provider, "data": GET_PRICE_ORACLE_SELECTOR}],
            anchor,
        )
        access_modes.append(mode)
        oracle = decode_address_word(oracle_raw, "getPriceOracle()")
        if oracle != EXPECTED_ORACLE:
            raise ValueError(f"oracle mismatch: {oracle}")
        oracle_code, mode = client.exact("eth_getCode", [oracle], anchor)
        access_modes.append(mode)

        premium_raw, mode = client.exact(
            "eth_call",
            [{"to": POOL, "data": FLASH_PREMIUM_SELECTOR}],
            anchor,
        )
        access_modes.append(mode)
        premium_bps = decode_word(premium_raw, "FLASHLOAN_PREMIUM_TOTAL()")
        if premium_bps != 5:
            raise ValueError(f"flash premium changed: {premium_bps}")

        cases.append(
            {
                **anchor,
                "timestamp": int(block["timestamp"], 16),
                "pool": POOL,
                "pool_proxy_code_sha256": code_sha256(pool_code, "pool proxy"),
                "eip1967_implementation_slot": IMPLEMENTATION_SLOT,
                "implementation": implementation,
                "implementation_code_sha256": code_sha256(
                    implementation_code, "pool implementation"
                ),
                "addresses_provider": addresses_provider,
                "addresses_provider_code_sha256": code_sha256(
                    provider_code, "addresses provider"
                ),
                "price_oracle": oracle,
                "price_oracle_code_sha256": code_sha256(
                    oracle_code, "price oracle"
                ),
                "flash_loan_premium_bps": premium_bps,
            }
        )

        after = client.call(
            "eth_getBlockByNumber", [hex(anchor["block_number"]), False]
        )
        if after is None or after["hash"].lower() != anchor["block_hash"]:
            raise ValueError("canonical anchor changed during deployment lock")

    return {
        "provider_id": provider_id,
        "access_modes": sorted(set(access_modes)),
        "cases": cases,
    }


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    observations = []
    for provider in PROVIDERS:
        observation = collect(provider, args.out)
        observations.append(observation)
        (args.out / f"{provider[0]}-deployment-lock.json").write_text(
            json.dumps(observation, indent=2, sort_keys=True) + "\n"
        )
        for case in observation["cases"]:
            print(
                "AAVE_DEPLOYMENT_OBSERVATION "
                f"upstream={provider[0]} block={case['block_number']} "
                f"implementation={case['implementation']} "
                f"implementation_sha256={case['implementation_code_sha256']}",
                flush=True,
            )

    if observations[0]["cases"] != observations[1]["cases"]:
        raise ValueError("PROVIDER_DISSENT: Aave deployment/version lock differs")

    witness = {
        "schema_version": 1,
        "gate": "AAVE_V3_DEPLOYMENT_AND_VERSION_LOCK",
        "providers": [item[0] for item in PROVIDERS],
        "cases": observations[0]["cases"],
        "provider_access_modes": {
            observation["provider_id"]: observation["access_modes"]
            for observation in observations
        },
        "identity_rule": (
            "exact pool proxy bytecode + EIP-1967 implementation address/code + "
            "addresses provider/oracle code + flash premium at every admitted anchor"
        ),
        "unexplained_mismatches": 0,
        "real_market_evidence": False,
        "protocol_fork_truth": "NOT_CLOSED",
    }
    witness["attestation_sha256"] = digest(witness)
    (args.out / "aave-deployment-version-lock.json").write_text(
        json.dumps(witness, indent=2, sort_keys=True) + "\n"
    )
    print(
        "AAVE_V3_DEPLOYMENT_VERSION_LOCK_PASS "
        f"anchors={len(witness['cases'])} providers={len(PROVIDERS)} "
        "unexplained_mismatches=0",
        flush=True,
    )


if __name__ == "__main__":
    main()
