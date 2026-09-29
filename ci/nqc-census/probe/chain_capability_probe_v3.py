#!/usr/bin/env python3
"""Third read-only probe: log-scan limits/throughput and topic identification.

Design evidence only.
"""

import json
import sys
import time

sys.path.insert(0, "ci/nqc-census/probe")
from chain_capability_probe import keccak256  # noqa: E402
from chain_capability_probe_v2 import Rpc, emit, ADDRESSES_PROVIDER, CONFIGURATOR, POOL, ANCHOR  # noqa: E402

SIGNATURES = [
    "PoolUpdated(address,address)", "PoolConfiguratorUpdated(address,address)",
    "PriceOracleUpdated(address,address)", "ACLManagerUpdated(address,address)",
    "ACLAdminUpdated(address,address)", "PriceOracleSentinelUpdated(address,address)",
    "PoolDataProviderUpdated(address,address)", "ProxyCreated(bytes32,address,address)",
    "AddressSet(bytes32,address,address)", "AddressSetAsProxy(bytes32,address,address,address)",
    "MarketIdSet(string,string)", "OwnershipTransferred(address,address)", "Upgraded(address)",
    "ReserveInitialized(address,address,address,address,address)", "ReserveDropped(address)",
    "Initialized(uint8)", "Initialized(uint64)",
]


def logs(rpc, address, start, end, topics=None, attempts=6):
    params = {"address": address, "fromBlock": hex(start), "toBlock": hex(end)}
    if topics:
        params["topics"] = topics
    for attempt in range(attempts):
        result, error = rpc.call("eth_getLogs", [params], timeout=180)
        if result is not None:
            return result, None, attempt
        text = json.dumps(error)
        if "temporarily" in text or "429" in text or "rate" in text.lower():
            time.sleep(2 * (attempt + 1))
            continue
        return None, error, attempt
    return None, error, attempts


def main():
    topic_names = {"0x" + keccak256(s.encode()).hex(): s for s in SIGNATURES}
    emit("topic_table", table=topic_names)
    mev = Rpc("mevblocker-rpc")
    drpc = Rpc("drpc")
    nodies = Rpc("nodies")

    # drpc window limit.
    for span in (9_999, 5_000, 2_000, 1_000):
        result, error, _ = logs(drpc, [ADDRESSES_PROVIDER, CONFIGURATOR], 16_290_000, 16_290_000 + span - 1)
        emit("drpc_window", span=span, ok=result is not None, count=None if result is None else len(result),
             error=error)
    # drpc sustained throughput at 5k windows (20 calls).
    started, ok, errors = time.monotonic(), 0, []
    for i in range(20):
        result, error, retries = logs(drpc, [ADDRESSES_PROVIDER, CONFIGURATOR], 16_290_000 + i * 5_000,
                                      16_290_000 + i * 5_000 + 4_999)
        ok += result is not None
        if error:
            errors.append(error)
    emit("drpc_sustained", calls=20, ok=ok, errors=errors[:3], elapsed=round(time.monotonic() - started, 2))

    # nodies 50-block windows batched 10 (20 requests).
    started, found, failures = time.monotonic(), 0, []
    for request in range(20):
        payload = [{"jsonrpc": "2.0", "id": request * 100 + i, "method": "eth_getLogs",
                    "params": [{"address": [ADDRESSES_PROVIDER, CONFIGURATOR],
                                "fromBlock": hex(16_290_000 + (request * 10 + i) * 50),
                                "toBlock": hex(16_290_000 + (request * 10 + i) * 50 + 49)}]} for i in range(10)]
        reply, _ = nodies.post(payload)
        if isinstance(reply, list):
            found += sum(len(r.get("result") or []) for r in reply)
            bad = [r.get("error") for r in reply if "error" in r]
            if bad:
                failures.append(bad[0])
        else:
            failures.append(reply)
    emit("nodies_batched", requests=20, blocks=10_000, logs=found, failures=failures[:3],
         elapsed=round(time.monotonic() - started, 2))

    # mevblocker window reliability.
    for span in (250_000, 1_000_000, 3_000_000):
        result, error, retries = logs(mev, [ADDRESSES_PROVIDER, CONFIGURATOR], 16_291_071, 16_291_071 + span - 1)
        emit("mev_window", span=span, ok=result is not None, count=None if result is None else len(result),
             retries=retries, error=error)

    # Full event history of the lineage emitters, labelled.
    for label, address in (("addresses_provider", ADDRESSES_PROVIDER), ("configurator", CONFIGURATOR),
                           ("pool_upgrades", POOL)):
        topics = [["0x" + keccak256(b"Upgraded(address)").hex()]] if label == "pool_upgrades" else None
        result, error, retries = logs(mev, address, 16_291_000, ANCHOR, topics=topics[0] if topics else None)
        if result is None:
            emit("history", emitter=label, error=error, retries=retries)
            continue
        counts = {}
        interesting = []
        for log in result:
            name = topic_names.get(log["topics"][0], log["topics"][0])
            counts[name] = counts.get(name, 0) + 1
            if label != "configurator" or name in ("Upgraded(address)", "ReserveDropped(address)",
                                                    "Initialized(uint8)", "Initialized(uint64)"):
                interesting.append([int(log["blockNumber"], 16), name, log["topics"][1:], log["data"][:200]])
        emit("history", emitter=label, total=len(result), counts=counts, retries=retries,
             events=interesting[:80])
    print("CHAIN_CAPABILITY_PROBE_V3_DONE", flush=True)


if __name__ == "__main__":
    main()
