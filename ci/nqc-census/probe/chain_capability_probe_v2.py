#!/usr/bin/env python3
"""Second read-only capability probe: prints exact facts to the job log.

Design evidence only. Measures header member sets per era, log member sets,
batched narrow-window getLogs throughput, earliest-code boundaries, and the
Aave configurator event history as seen by several providers.
"""

import json
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, "ci/nqc-census/probe")
from chain_capability_probe import keccak256, selector  # noqa: E402

PROVIDERS = {
    "blastapi-public": ("https://eth-mainnet.public.blastapi.io", 0.35),
    "mevblocker-rpc": ("https://rpc.mevblocker.io", 1.25),
    "drpc": ("https://eth.drpc.org", 0.6),
    "nodies": ("https://ethereum-public.nodies.app", 0.6),
}
ADDRESSES_PROVIDER = "0x2f39d218133afab8f2b819b1066c7e434ad94e9e"
POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
CONFIGURATOR = "0x64b761d848206f447fe2dd461b0c635ec39ebb27"
V2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"
ANCHOR = 25_437_474
HEADER_BLOCKS = [0, 1_920_000, 12_964_999, 12_965_000, 17_034_869, 17_034_870, 19_426_586,
                 19_426_587, 22_431_083, 22_431_084, 23_935_693, 23_935_694, ANCHOR]
TOPIC_INIT = "0x" + keccak256(b"ReserveInitialized(address,address,address,address,address)").hex()
TOPIC_DROP = "0x" + keccak256(b"ReserveDropped(address)").hex()


class Rpc:
    def __init__(self, name):
        self.name = name
        self.url, self.interval = PROVIDERS[name]
        self.last = 0.0
        self.id = 0

    def post(self, payload, timeout=120):
        wait = self.interval - (time.monotonic() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.last = time.monotonic()
        body = json.dumps(payload, separators=(",", ":")).encode()
        req = urllib.request.Request(self.url, data=body, headers={
            "content-type": "application/json", "user-agent": "nqc-census-capability-probe/2"})
        started = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                text = response.read()
        except urllib.error.HTTPError as exc:
            return {"http_error": exc.code, "body": exc.read()[:300].decode("utf-8", "replace")}, time.monotonic() - started
        except Exception as exc:  # noqa: BLE001
            return {"transport_error": repr(exc)[:300]}, time.monotonic() - started
        try:
            return json.loads(text), time.monotonic() - started
        except ValueError:
            return {"non_json": text[:300].decode("utf-8", "replace")}, time.monotonic() - started

    def call(self, method, params, timeout=120):
        self.id += 1
        reply, _ = self.post({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params}, timeout)
        if isinstance(reply, dict) and "result" in reply:
            return reply["result"], None
        return None, reply


def emit(kind, **fields):
    print(json.dumps({"probe": kind, **fields}, sort_keys=True), flush=True)


def headers(rpc):
    shapes = {}
    for number in HEADER_BLOCKS:
        block, error = rpc.call("eth_getBlockByNumber", [hex(number), False])
        if isinstance(block, dict):
            shapes[number] = sorted(k for k in block if k not in ("transactions", "uncles", "withdrawals"))
        else:
            shapes[number] = {"error": error}
    head, _ = rpc.call("eth_blockNumber", [])
    if head:
        block, _ = rpc.call("eth_getBlockByNumber", [hex(int(head, 16) - 100), False])
        if isinstance(block, dict):
            shapes["head-100"] = sorted(k for k in block if k not in ("transactions", "uncles", "withdrawals"))
            emit("head_header_sample", provider=rpc.name, number=int(block["number"], 16),
                 timestamp=int(block["timestamp"], 16), extra={k: block[k] for k in block
                                                               if k in ("requestsHash", "parentBeaconBlockRoot")})
    emit("header_keys", provider=rpc.name, shapes=shapes)
    block, _ = rpc.call("eth_getBlockByNumber", [hex(ANCHOR), False])
    if isinstance(block, dict):
        emit("anchor_header", provider=rpc.name, header={k: v for k, v in block.items() if k != "transactions"})


def earliest_code(rpc, address, lo, hi):
    """Smallest block in (lo, hi] with code, assuming code(lo)=empty, code(hi)=present."""
    steps = 0
    while hi - lo > 1:
        mid = (lo + hi) // 2
        code, error = rpc.call("eth_getCode", [address, hex(mid)])
        steps += 1
        if code is None:
            return {"error": error, "steps": steps}
        if len(code) > 2:
            hi = mid
        else:
            lo = mid
    return {"first_code_block": hi, "steps": steps}


def full_range_logs(rpc, address, topic, start, end):
    params = {"address": address, "fromBlock": hex(start), "toBlock": hex(end)}
    if topic:
        params["topics"] = [topic]
    logs, error = rpc.call("eth_getLogs", [params], timeout=180)
    return logs, error


def main():
    blast = Rpc("blastapi-public")
    mev = Rpc("mevblocker-rpc")
    drpc = Rpc("drpc")
    nodies = Rpc("nodies")
    for rpc in (blast, mev, drpc, nodies):
        headers(rpc)

    for rpc in (blast, mev):
        for name, address in (("addresses_provider", ADDRESSES_PROVIDER), ("pool", POOL),
                              ("configurator", CONFIGURATOR)):
            emit("earliest_code", provider=rpc.name, contract=name,
                 **earliest_code(rpc, address, 16_000_000, 16_500_000))
        emit("earliest_code", provider=rpc.name, contract="v2_factory",
             **earliest_code(rpc, V2_FACTORY, 9_000_000, 10_500_000))

    logs, error = full_range_logs(mev, CONFIGURATOR, TOPIC_INIT, 16_000_000, ANCHOR)
    if logs is not None:
        emit("log_member_keys", provider=mev.name, keys=sorted(logs[0].keys()) if logs else [])
        emit("reserve_initialized", provider=mev.name, count=len(logs),
             rows=[[int(l["blockNumber"], 16), "0x" + l["topics"][1][-40:], "0x" + l["topics"][2][-40:],
                    len(l["topics"]), (len(l["data"]) - 2) // 64] for l in logs])
    else:
        emit("reserve_initialized", provider=mev.name, error=error)
    logs, error = full_range_logs(mev, CONFIGURATOR, TOPIC_DROP, 16_000_000, ANCHOR)
    emit("reserve_dropped", provider=mev.name, count=None if logs is None else len(logs), error=error,
         rows=None if logs is None else [[int(l["blockNumber"], 16), "0x" + l["topics"][1][-40:]] for l in logs])
    for address, label in ((ADDRESSES_PROVIDER, "addresses_provider"), (CONFIGURATOR, "configurator")):
        logs, error = full_range_logs(mev, address, None, 16_000_000, ANCHOR)
        if logs is not None:
            topics = {}
            for log in logs:
                topics[log["topics"][0]] = topics.get(log["topics"][0], 0) + 1
            emit("emitter_topics", provider=mev.name, emitter=label, total=len(logs), topics=topics)
        else:
            emit("emitter_topics", provider=mev.name, emitter=label, error=error)

    # Narrow-window batched scan on blastapi: 500 windows x 10 blocks per request.
    started = time.monotonic()
    found, requests, failures = 0, 0, []
    start = 16_290_000
    for batch_index in range(6):
        payload = []
        for i in range(500):
            a = start + (batch_index * 500 + i) * 10
            payload.append({"jsonrpc": "2.0", "id": batch_index * 1000 + i, "method": "eth_getLogs",
                            "params": [{"address": [ADDRESSES_PROVIDER, CONFIGURATOR], "fromBlock": hex(a),
                                        "toBlock": hex(a + 9)}]})
        reply, elapsed = blast.post(payload, timeout=180)
        requests += 1
        if isinstance(reply, list):
            errors = [r.get("error") for r in reply if "error" in r]
            found += sum(len(r.get("result") or []) for r in reply if "result" in r)
            if errors:
                failures.append({"batch": batch_index, "errors": len(errors), "first": errors[0]})
        else:
            failures.append({"batch": batch_index, "reply": str(reply)[:300]})
        emit("blast_batch_logs_step", batch=batch_index, elapsed=round(elapsed, 3))
    emit("blast_batched_getlogs", windows=3000, blocks=30_000, requests=requests, logs=found,
         failures=failures, elapsed=round(time.monotonic() - started, 2))

    # drpc 10k windows over the same 30k blocks.
    count, errs = 0, []
    for i in range(3):
        logs, error = full_range_logs(drpc, [ADDRESSES_PROVIDER, CONFIGURATOR], None, 16_290_000 + i * 10_000,
                                      16_290_000 + i * 10_000 + 9_999)
        if logs is None:
            errs.append(error)
        else:
            count += len(logs)
    emit("drpc_10k_windows", logs=count, errors=errs)
    logs, error = full_range_logs(mev, [ADDRESSES_PROVIDER, CONFIGURATOR], None, 16_290_000, 16_319_999)
    emit("mev_same_30k", logs=None if logs is None else len(logs), error=error)

    for rpc in (blast, mev, drpc, nodies):
        version, _ = rpc.call("web3_clientVersion", [])
        receipts, rerr = rpc.call("eth_getBlockReceipts", [hex(ANCHOR)])
        emit("identity", provider=rpc.name, client_version=version,
             block_receipts=None if receipts is None else len(receipts), receipts_error=rerr)
    print("CHAIN_CAPABILITY_PROBE_V2_DONE", flush=True)


if __name__ == "__main__":
    main()
