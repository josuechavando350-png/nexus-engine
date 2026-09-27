#!/usr/bin/env python3
"""Independent raw-ABI witnesses; never promotes fork or production status."""
import argparse
import hashlib
import json
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LOCK = ROOT / "ci/nqc-protocol-fork/parity/aave-user-meta-witness.json"
LOCK_SHA = "16a4260977fa7784fd5b1282de8eee71710fdb49ca171b42e99592e8cf870441"
PROVIDERS = [
    ("blastapi-public", "https://eth-mainnet.public.blastapi.io"),
    ("mevblocker-rpc", "https://rpc.mevblocker.io"),
]
SIGNATURES = [
    "getReserveAddressById(uint16)", "getReserveData(address)",
    "ADDRESSES_PROVIDER()", "getPriceOracle()", "BASE_CURRENCY_UNIT()",
    "getAssetPrice(address)", "getLiquidationGracePeriod(address)",
    "scaledBalanceOf(address)",
]


def rpc(url, method, params, request_id):
    payload = json.dumps(dict(jsonrpc="2.0", id=request_id, method=method, params=params)).encode()
    request = urllib.request.Request(url, data=payload, headers={"content-type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                body = json.loads(response.read())
            if body.get("id") != request_id or body.get("jsonrpc") != "2.0":
                raise ValueError("RPC envelope mismatch")
            if "error" in body:
                raise ValueError(f"RPC error: {body['error']}")
            return body["result"]
        except (OSError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(1 + attempt)


def decode_words(value, count, label):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{" + str(count * 64) + "}", value):
        raise ValueError(f"{label}: expected {count} canonical ABI words")
    return [int(value[i:i + 64], 16) for i in range(2, len(value), 64)]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def address(word):
    if not 0 < word < 2**160:
        raise ValueError("noncanonical or zero ABI address")
    return f"0x{word:040x}"


def active_ids(raw):
    n = int(raw)
    if not 0 <= n < 2**256:
        raise ValueError("configuration out of uint256 range")
    return [i for i in range(128) if (n >> (2 * i)) & 3]


def collect(provider, lock, out):
    provider_id, url = provider
    trace = []
    serial = 0

    def call(method, params):
        nonlocal serial
        serial += 1
        time.sleep(0.25)
        result = rpc(url, method, params, serial)
        trace.append(dict(method=method, params=params, result=result))
        # Preserve partial evidence even if a later call fails.
        with (out / f"{provider_id}-rpc.jsonl").open("a") as f:
            f.write(json.dumps(trace[-1], sort_keys=True) + "\n")
        return result

    if int(call("eth_chainId", []), 16) != 1:
        raise ValueError("wrong chain")
    selectors = {}
    for sig in SIGNATURES:
        h = call("web3_sha3", ["0x" + sig.encode().hex()])
        if not re.fullmatch(r"0x[0-9a-fA-F]{64}", h):
            raise ValueError("invalid selector digest")
        selectors[sig] = h[:10].lower()
    cases = []
    pool = lock["pool"]
    for case in lock["cases"]:
        number, block_hash = case["block_number"], case["block_hash"].lower()
        block = call("eth_getBlockByNumber", [hex(number), False])
        if block["hash"].lower() != block_hash or int(block["number"], 16) != number:
            raise ValueError("anchor mismatch")
        block_arg = {"blockHash": block_hash, "requireCanonical": True}

        def words(target, sig, arg=None, count=1):
            suffix = "" if arg is None else f"{int(arg, 16) if isinstance(arg, str) else arg:064x}"
            result = call("eth_call", [{"to": target, "data": selectors[sig] + suffix}, block_arg])
            return decode_words(result, count, sig)

        def code(target):
            raw = call("eth_getCode", [target, block_arg])
            if not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", raw):
                raise ValueError(f"missing code {target}")
            return hashlib.sha256(bytes.fromhex(raw[2:])).hexdigest()

        pool_code = code(pool)
        provider_address = address(words(pool, "ADDRESSES_PROVIDER()")[0])
        oracle = address(words(provider_address, "getPriceOracle()")[0])
        base_unit = words(oracle, "BASE_CURRENCY_UNIT()")[0]
        if base_unit == 0:
            raise ValueError("zero oracle base unit")
        ids = sorted({i for user in case["canonical_users"].values() for i in active_ids(user["user_configuration_raw"])})
        reserves = []
        for reserve_id in ids:
            asset = address(words(pool, "getReserveAddressById(uint16)", reserve_id)[0])
            raw = words(pool, "getReserveData(address)", asset, 15)
            if raw[7] != reserve_id or any(raw[i] >= 2**128 for i in (1, 2, 3, 4, 5)) or raw[6] >= 2**40:
                raise ValueError("reserve ABI/domain mismatch")
            atoken, debt = address(raw[8]), address(raw[10])
            price = words(oracle, "getAssetPrice(address)", asset)[0]
            if price == 0:
                raise ValueError("zero asset price")
            grace = words(pool, "getLiquidationGracePeriod(address)", asset)[0]
            if grace >= 2**40:
                raise ValueError("grace period out of range")
            reserves.append(dict(
                reserve_id=reserve_id, asset=asset, configuration=str(raw[0]),
                a_token=atoken, variable_debt_token=debt,
                a_token_code_sha256=code(atoken), variable_debt_code_sha256=code(debt),
                liquidity_index_ray=str(raw[1]), liquidity_rate_ray=str(raw[2]),
                variable_borrow_index_ray=str(raw[3]), variable_borrow_rate_ray=str(raw[4]),
                last_update_timestamp=raw[6], liquidation_grace_period_until=grace,
                price_oracle_units=str(price), price_usd_wad=str(price * 10**18 // base_unit),
            ))
        users = []
        for user, meta in sorted(case["canonical_users"].items()):
            positions = []
            for reserve in reserves:
                if reserve["reserve_id"] not in active_ids(meta["user_configuration_raw"]):
                    continue
                positions.append(dict(
                    asset=reserve["asset"], reserve_id=reserve["reserve_id"],
                    scaled_atoken_balance=str(words(reserve["a_token"], "scaledBalanceOf(address)", user)[0]),
                    scaled_variable_debt=str(words(reserve["variable_debt_token"], "scaledBalanceOf(address)", user)[0]),
                ))
            users.append(dict(user=user, meta=meta, positions=positions))
        after = call("eth_getBlockByNumber", [hex(number), False])
        if after["hash"].lower() != block_hash:
            raise ValueError("canonical anchor changed")
        cases.append(dict(case_id=case["case_id"], block_number=number, block_hash=block_hash,
                          timestamp=int(block["timestamp"], 16), pool_code_sha256=pool_code,
                          addresses_provider=provider_address, price_oracle=oracle,
                          oracle_base_unit=str(base_unit), reserves=reserves, users=users))
        print(f"WITNESS {provider_id} {case['case_id']} reserves={len(reserves)} users={len(users)}", flush=True)
    return dict(selectors=selectors, cases=cases)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if hashlib.sha256(LOCK.read_bytes()).hexdigest() != LOCK_SHA:
        raise ValueError("locked witness digest mismatch")
    lock = json.loads(LOCK.read_text())
    observations = []
    for provider in PROVIDERS:
        observation = collect(provider, lock, args.out)
        (args.out / f"{provider[0]}-witness.json").write_text(json.dumps(observation, indent=2) + "\n")
        observations.append(observation)
    if observations[0] != observations[1]:
        raise ValueError("PROVIDER_DISSENT: quarantine; no majority or tolerance")
    witness = dict(schema_version=1, gate="AAVE_RESERVE_BALANCE_EXTERNAL_WITNESS",
                   pool=lock["pool"], locked_user_meta_sha256=LOCK_SHA,
                   providers=[p[0] for p in PROVIDERS], **observations[0],
                   nqc_parity="NOT_TESTED", protocol_fork_truth="NOT_CLOSED")
    witness["attestation_sha256"] = digest(witness)
    (args.out / "reserve-balance-witness.json").write_text(json.dumps(witness, indent=2) + "\n")
    print("EXTERNAL_WITNESS_CONSENSUS_PASS", flush=True)


if __name__ == "__main__":
    main()
