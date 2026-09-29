#!/usr/bin/env python3
"""Read-only JSON-RPC capability probe for Census design decisions.

This is design evidence, not Census evidence: it measures what each public
provider actually supports (archive depth, EIP-1898, getLogs limits, batching,
header field sets, client identity). It performs no signing and no writes.
"""

import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PROVIDERS = [
    ("blastapi-public", "https://eth-mainnet.public.blastapi.io"),
    ("mevblocker-rpc", "https://rpc.mevblocker.io"),
    ("publicnode", "https://ethereum-rpc.publicnode.com"),
    ("drpc", "https://eth.drpc.org"),
    ("1rpc", "https://1rpc.io/eth"),
    ("llamarpc", "https://eth.llamarpc.com"),
    ("blockpi", "https://ethereum.blockpi.network/v1/rpc/public"),
    ("flashbots", "https://rpc.flashbots.net"),
    ("merkle", "https://eth.merkle.io"),
    ("nodies", "https://ethereum-public.nodies.app"),
]

ADDRESSES_PROVIDER = "0x2f39d218133afab8f2b819b1066c7e434ad94e9e"
POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
V2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"
ANCHOR = 25_437_474
ANCHOR_HASH = "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8"
BLOCKS = [0, 1, 1_920_000, 12_965_000, 15_537_394, 16_291_000, 17_034_870, 19_426_587,
          22_431_084, 23_935_694, 24_500_000, ANCHOR]

RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
      0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
      0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
      0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
      0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
      0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56],
       [27, 20, 39, 8, 14]]
M = (1 << 64) - 1


def keccak256(data):
    def rol(v, s):
        return ((v << s) | (v >> (64 - s))) & M if s else v
    padded = bytearray(data) + b"\x01"
    while len(padded) % 136:
        padded += b"\x00"
    padded[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(padded), 136):
        blk = padded[off:off + 136]
        for i in range(17):
            a[i % 5][i // 5] ^= int.from_bytes(blk[8 * i:8 * i + 8], "little")
        for rc in RC:
            c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
            d = [c[(x - 1) % 5] ^ rol(c[(x + 1) % 5], 1) for x in range(5)]
            a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
            b = [[0] * 5 for _ in range(5)]
            for x in range(5):
                for y in range(5):
                    b[y][(2 * x + 3 * y) % 5] = rol(a[x][y], ROT[x][y])
            a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
            a[0][0] ^= rc
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


def selector(signature):
    return "0x" + keccak256(signature.encode())[:4].hex()


class Provider:
    def __init__(self, name, url, out):
        self.name, self.url, self.out = name, url, out
        self.serial = 0
        self.records = []

    def raw(self, payload, timeout=60):
        body = json.dumps(payload, separators=(",", ":")).encode()
        req = urllib.request.Request(self.url, data=body, headers={
            "content-type": "application/json", "accept": "application/json",
            "user-agent": "nqc-census-capability-probe/1"})
        started = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                text = response.read()
                status = response.status
        except urllib.error.HTTPError as exc:
            text, status = exc.read(), exc.code
        except Exception as exc:  # noqa: BLE001 - probe records every failure
            return {"transport_error": repr(exc)[:400], "elapsed": round(time.monotonic() - started, 3)}
        elapsed = round(time.monotonic() - started, 3)
        try:
            parsed = json.loads(text)
        except ValueError:
            return {"http_status": status, "non_json": text[:400].decode("utf-8", "replace"), "elapsed": elapsed}
        return {"http_status": status, "body": parsed, "elapsed": elapsed, "bytes": len(text)}

    def call(self, method, params, label=None, timeout=60, keep=True):
        self.serial += 1
        time.sleep(0.4)
        result = self.raw({"jsonrpc": "2.0", "id": self.serial, "method": method, "params": params}, timeout)
        record = {"label": label or method, "method": method, "params": params}
        if keep:
            record.update(result)
        else:
            summary = dict(result)
            body = summary.pop("body", None)
            if isinstance(body, dict):
                summary["has_result"] = "result" in body
                summary["error"] = body.get("error")
                res = body.get("result")
                if isinstance(res, list):
                    summary["result_len"] = len(res)
                elif isinstance(res, str):
                    summary["result_prefix"] = res[:80]
                    summary["result_hex_len"] = len(res)
            record.update(summary)
        self.records.append(record)
        return result

    def result(self, method, params, label=None, keep=True, timeout=60):
        response = self.call(method, params, label, timeout, keep)
        body = response.get("body")
        if isinstance(body, dict) and "result" in body:
            return body["result"]
        return None


def probe(name, url, out):
    p = Provider(name, url, out)
    summary = {"provider": name, "url": url}
    summary["client_version"] = p.result("web3_clientVersion", [])
    summary["chain_id"] = p.result("eth_chainId", [])
    head = p.result("eth_blockNumber", [])
    summary["head"] = head
    if summary["chain_id"] is None:
        summary["reachable"] = False
        return summary, p.records
    summary["reachable"] = True

    headers = {}
    for number in BLOCKS:
        block = p.result("eth_getBlockByNumber", [hex(number), False], f"header_{number}")
        if isinstance(block, dict):
            headers[number] = block
    summary["header_keys"] = {n: sorted(h.keys()) for n, h in headers.items()}
    summary["anchor_hash_matches"] = headers.get(ANCHOR, {}).get("hash") == ANCHOR_HASH
    if head:
        near_head = int(head, 16) - 64
        block = p.result("eth_getBlockByNumber", [hex(near_head), False], "header_near_head")
        if isinstance(block, dict):
            summary["header_keys_near_head"] = sorted(block.keys())
            summary["near_head_number"] = near_head
    by_hash = p.result("eth_getBlockByHash", [ANCHOR_HASH, False], "header_by_hash")
    summary["get_block_by_hash"] = isinstance(by_hash, dict) and by_hash.get("hash") == ANCHOR_HASH

    anchor_ref = {"blockHash": ANCHOR_HASH, "requireCanonical": True}
    code = p.result("eth_getCode", [POOL, anchor_ref], "code_pool_eip1898", keep=False)
    summary["eip1898_getcode"] = isinstance(code, str) and len(code) > 2
    call = p.result("eth_call", [{"to": ADDRESSES_PROVIDER, "data": selector("getPoolConfigurator()")}, anchor_ref],
                    "call_getPoolConfigurator_eip1898")
    summary["eip1898_call"] = call
    configurator = "0x" + call[-40:] if isinstance(call, str) and len(call) == 66 else None
    summary["configurator"] = configurator
    summary["reserves_list"] = p.result("eth_call", [{"to": POOL, "data": selector("getReservesList()")}, anchor_ref],
                                        "call_getReservesList_eip1898")
    summary["reserves_count"] = p.result("eth_call", [{"to": POOL, "data": selector("getReservesCount()")}, anchor_ref],
                                         "call_getReservesCount_eip1898")
    summary["v2_all_pairs_length"] = p.result("eth_call", [{"to": V2_FACTORY, "data": selector("allPairsLength()")}, anchor_ref],
                                              "call_allPairsLength_eip1898")
    for target, label in ((ADDRESSES_PROVIDER, "provider"), (configurator, "configurator"), (V2_FACTORY, "v2_factory")):
        if target:
            c = p.result("eth_getCode", [target, anchor_ref], f"code_{label}_anchor", keep=False)
            summary[f"code_{label}_len"] = (len(c) - 2) // 2 if isinstance(c, str) else None

    # Archive depth: code and calls at early blocks, by number.
    archive = {}
    for number in (10_000_000, 16_200_000, 16_291_000, 16_300_000, 16_500_000, 20_000_000):
        c = p.result("eth_getCode", [ADDRESSES_PROVIDER, hex(number)], f"code_provider_{number}", keep=False)
        archive[f"code_provider_{number}"] = None if c is None else (len(c) - 2) // 2
    r = p.result("eth_call", [{"to": ADDRESSES_PROVIDER, "data": selector("getPool()")}, hex(16_500_000)],
                 "call_getPool_16500000")
    archive["call_getPool_16500000"] = r
    r = p.result("eth_call", [{"to": V2_FACTORY, "data": selector("allPairsLength()")}, hex(10_100_000)],
                 "call_allPairsLength_10100000")
    archive["call_allPairsLength_10100000"] = r
    summary["archive"] = archive

    # getLogs range limits with an address filter.
    logs = {}
    for start, span in ((16_280_000, 10_000), (16_280_000, 100_000), (16_200_000, 1_000_000),
                        (16_000_000, 9_500_000)):
        res = p.call("eth_getLogs", [{"address": ADDRESSES_PROVIDER, "fromBlock": hex(start),
                                      "toBlock": hex(start + span - 1)}], f"logs_provider_{span}", timeout=120, keep=False)
        body = res.get("body") if isinstance(res, dict) else None
        if isinstance(body, dict) and isinstance(body.get("result"), list):
            logs[str(span)] = {"ok": True, "count": len(body["result"]), "elapsed": res.get("elapsed")}
        else:
            logs[str(span)] = {"ok": False, "error": (body or {}).get("error") if isinstance(body, dict) else res}
    if configurator:
        topic = "0x" + keccak256(b"ReserveInitialized(address,address,address,address,address)").hex()
        res = p.call("eth_getLogs", [{"address": configurator, "topics": [topic], "fromBlock": hex(16_000_000),
                                      "toBlock": hex(ANCHOR)}], "logs_reserve_initialized_full", timeout=180, keep=True)
        body = res.get("body") if isinstance(res, dict) else None
        logs["reserve_initialized_full"] = (
            {"ok": True, "count": len(body["result"])} if isinstance(body, dict) and isinstance(body.get("result"), list)
            else {"ok": False, "error": body.get("error") if isinstance(body, dict) else res})
    res = p.call("eth_getLogs", [{"address": V2_FACTORY, "fromBlock": hex(10_000_000), "toBlock": hex(10_099_999)}],
                 "logs_v2_factory_100k", timeout=120, keep=False)
    body = res.get("body") if isinstance(res, dict) else None
    logs["v2_factory_100k"] = ({"ok": True, "count": len(body["result"])}
                              if isinstance(body, dict) and isinstance(body.get("result"), list)
                              else {"ok": False, "error": body.get("error") if isinstance(body, dict) else res})
    summary["logs"] = logs

    # JSON-RPC batch support.
    batch = {}
    for size in (10, 100, 500):
        payload = [{"jsonrpc": "2.0", "id": 10_000 + i, "method": "eth_getBlockByNumber",
                    "params": [hex(ANCHOR - i), False]} for i in range(size)]
        time.sleep(1.0)
        res = p.raw(payload, timeout=120)
        body = res.get("body")
        ok = isinstance(body, list) and len(body) == size and all("result" in item for item in body)
        batch[str(size)] = {"ok": ok, "elapsed": res.get("elapsed"),
                            "detail": None if ok else (body if not isinstance(body, list) else
                                                       [item.get("error") for item in body[:3]])}
    summary["batch"] = batch

    receipts = p.result("eth_getBlockReceipts", [hex(ANCHOR)], "block_receipts", keep=False)
    summary["get_block_receipts"] = isinstance(receipts, list)
    return summary, p.records


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    summaries = []
    for name, url in PROVIDERS:
        print(f"PROBE {name} {url}", flush=True)
        try:
            summary, records = probe(name, url, out)
        except Exception as exc:  # noqa: BLE001
            summary, records = {"provider": name, "url": url, "probe_error": repr(exc)}, []
        (out / f"{name}.records.json").write_text(json.dumps(records, indent=1, sort_keys=True))
        (out / f"{name}.summary.json").write_text(json.dumps(summary, indent=1, sort_keys=True))
        compact = {k: summary.get(k) for k in ("client_version", "chain_id", "head", "reachable", "anchor_hash_matches",
                                                "eip1898_getcode", "configurator", "archive", "logs", "batch",
                                                "get_block_receipts")}
        print(json.dumps(compact, sort_keys=True), flush=True)
        summaries.append(summary)
    (out / "summary.json").write_text(json.dumps(summaries, indent=1, sort_keys=True))
    digest = hashlib.sha256((out / "summary.json").read_bytes()).hexdigest()
    print(f"CHAIN_CAPABILITY_PROBE_DONE providers={len(summaries)} summary_sha256={digest}")


if __name__ == "__main__":
    main()
