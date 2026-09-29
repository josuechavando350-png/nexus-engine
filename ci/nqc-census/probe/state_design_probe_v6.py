#!/usr/bin/env python3
"""Sixth read-only probe: exact Aave index inputs per reserve and revert encodings.

Design evidence only. Nothing here is census authority: the census re-acquires
every fact through the RMC-004 evidence store and requires two-provider
agreement. This probe only tells the implementation which getters the deployed
contracts expose and which rounding the deployed token math uses.
"""

import json
import sys
import time
import urllib.error
import urllib.request

import json
import sys

RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
# Rotation offsets r[x][y] from the Keccak reference.
ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]
MASK = (1 << 64) - 1


def _rol(value, shift):
    return ((value << shift) | (value >> (64 - shift))) & MASK if shift else value


def _keccak_f(a):
    for rc in RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], ROT[x][y])
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data):
    rate = 136
    padded = bytearray(data) + b"\x01"
    while len(padded) % rate:
        padded += b"\x00"
    padded[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for offset in range(0, len(padded), rate):
        block = padded[offset:offset + rate]
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        a = _keccak_f(a)
    out = b""
    for i in range(4):
        out += a[i % 5][i // 5].to_bytes(8, "little")
    return out


PROVIDERS = [
    ("blastapi-public", "https://eth-mainnet.public.blastapi.io", 0.35),
    ("mevblocker-rpc", "https://rpc.mevblocker.io", 1.25),
]
ANCHOR = 25_437_474
ANCHOR_HASH = "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8"
POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
POOL_IMPL = "0x728a138a4823392c2efa55e028d434f526fe03cf"
ORACLE = "0x54586be62e3c3580375ae3723c145253060ca0c2"
V2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"
EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"
ZEPPELINOS_IMPL = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3"
RAY = 10 ** 27
YEAR = 365 * 24 * 3600


def selector(signature):
    return keccak256(signature.encode())[:4].hex()


def word_address(value):
    return value.lower().replace("0x", "").rjust(64, "0")


def word_uint(value):
    return format(value, "064x")


def calldata(signature, *words):
    return "0x" + selector(signature) + "".join(words)


class Rpc:
    def __init__(self, name, url, interval):
        self.name, self.url, self.interval = name, url, interval
        self.last = 0.0

    def post(self, payload, timeout=120):
        wait = self.interval - (time.monotonic() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.last = time.monotonic()
        body = json.dumps(payload).encode()
        req = urllib.request.Request(self.url, data=body, headers={
            "content-type": "application/json", "user-agent": "nqc-census-state-probe/5"})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=timeout) as response:
                    return json.loads(response.read())
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 502, 503, 504) and attempt < 4:
                    time.sleep(2 ** attempt)
                    continue
                return {"http_error": exc.code, "body": exc.read()[:300].decode("utf-8", "replace")}
            except Exception as exc:  # noqa: BLE001
                if attempt < 4:
                    time.sleep(2 ** attempt)
                    continue
                return {"transport_error": repr(exc)[:300]}
        return {"transport_error": "exhausted"}

    def one(self, method, params):
        reply = self.post({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        if isinstance(reply, dict) and "result" in reply:
            return reply["result"], None
        return None, reply

    def calls(self, requests, chunk=40):
        """requests: [(to, data)] -> [(result|None, error|None)] at the anchor."""
        out = []
        for start in range(0, len(requests), chunk):
            part = requests[start:start + chunk]
            payload = [{"jsonrpc": "2.0", "id": i, "method": "eth_call",
                        "params": [{"to": to, "data": data}, {"blockHash": ANCHOR_HASH}]}
                       for i, (to, data) in enumerate(part)]
            reply = self.post(payload)
            if not isinstance(reply, list):
                out.extend((None, reply) for _ in part)
                continue
            by_id = {item.get("id"): item for item in reply if isinstance(item, dict)}
            for i in range(len(part)):
                item = by_id.get(i, {})
                if "result" in item:
                    out.append((item["result"], None))
                else:
                    out.append((None, item.get("error", "missing")))
        return out

    def call(self, to, data):
        return self.calls([(to, data)])[0]


def words(result):
    if result is None:
        return None
    body = result[2:]
    return [int(body[i:i + 64], 16) for i in range(0, len(body), 64)]


def address_of(value):
    return "0x" + format(value, "040x")


def decode_string(result):
    try:
        raw = bytes.fromhex(result[2:])
        offset = int.from_bytes(raw[0:32], "big")
        length = int.from_bytes(raw[offset:offset + 32], "big")
        return raw[offset + 32:offset + 32 + length].decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return None


def push4_selectors(code_hex):
    code = bytes.fromhex(code_hex[2:])
    found, i = set(), 0
    while i < len(code):
        op = code[i]
        if 0x60 <= op <= 0x7F:
            size = op - 0x5F
            if size == 4:
                found.add(code[i + 1:i + 5].hex())
            i += size + 1
        else:
            i += 1
    return found


def emit(kind, **record):
    print(json.dumps({"probe": kind, **record}, sort_keys=True), flush=True)


POOL_CANDIDATES = [
    "POOL_REVISION()", "getRevision()", "ADDRESSES_PROVIDER()", "FLASHLOAN_PREMIUM_TOTAL()",
    "FLASHLOAN_PREMIUM_TO_PROTOCOL()", "MAX_NUMBER_RESERVES()", "BRIDGE_PROTOCOL_FEE()",
    "MAX_STABLE_RATE_BORROW_SIZE_PERCENT()", "UMBRELLA()", "RESERVE_INTEREST_RATE_STRATEGY()",
    "getReservesList()", "getReservesCount()", "getReserveAddressById(uint16)",
    "getReserveData(address)", "getReserveDataExtended(address)", "getConfiguration(address)",
    "getReserveNormalizedIncome(address)", "getReserveNormalizedVariableDebt(address)",
    "getVirtualUnderlyingBalance(address)", "getLiquidationGracePeriod(address)",
    "getReserveDeficit(address)", "getReserveAToken(address)", "getReserveVariableDebtToken(address)",
    "getEModeCategoryData(uint8)", "getEModeCategoryCollateralConfig(uint8)",
    "getEModeCategoryLabel(uint8)", "getEModeCategoryCollateralBitmap(uint8)",
    "getEModeCategoryBorrowableBitmap(uint8)", "getEModeCategoryLtvzeroBitmap(uint8)",
    "getEModeCategoryIsolatedBitmap(uint8)", "getUserAccountData(address)",
    "getUserConfiguration(address)", "getUserEMode(address)", "getBorrowLogic()",
    "getLiquidationLogic()", "getFlashLoanLogic()", "getPoolLogic()", "getSupplyLogic()",
    "getEModeLogic()", "isApprovedPositionManager(address,address)", "getReserveVirtualUnderlyingBalance(address)",
    "getReserveNormalizedIncomeView(address)", "getLiquidationBonus(address)",
]



def probe_indexes(rpc, header):
    now = int(header["timestamp"], 16)
    listed, _ = rpc.call(POOL, calldata("getReservesList()"))
    body = words(listed)
    reserves = [address_of(v) for v in body[2:2 + body[1]]]
    per = ["getReserveData(address)", "getReserveNormalizedIncome(address)",
           "getReserveNormalizedVariableDebt(address)"]
    results = rpc.calls([(POOL, calldata(sig, word_address(a))) for a in reserves for sig in per], chunk=10)
    for n, asset in enumerate(reserves):
        data, income, debt = (results[3 * n + k][0] for k in range(3))
        w = words(data) if data else None
        emit("aave_index", provider=rpc.name, asset=asset, now=now,
             liquidity_index=None if w is None else w[1], liquidity_rate=None if w is None else w[2],
             variable_index=None if w is None else w[3], variable_rate=None if w is None else w[4],
             last_update=None if w is None else w[6],
             normalized_income=None if income is None else words(income)[0],
             normalized_debt=None if debt is None else words(debt)[0],
             errors=[str(results[3 * n + k][1])[:120] for k in range(3) if results[3 * n + k][0] is None])


def probe_reverts(rpc):
    cases = [("decimals_on_factory", V2_FACTORY, calldata("decimals()")),
             ("unknown_selector_on_pool_impl", POOL, "0xdeadbeef"),
             ("balance_of_on_factory", V2_FACTORY, calldata("balanceOf(address)", word_address(POOL)))]
    for name, to, data in cases:
        reply = rpc.post({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                          "params": [{"to": to, "data": data}, {"blockHash": ANCHOR_HASH}]})
        emit("revert_encoding", provider=rpc.name, case=name, reply=reply)


def main():
    for name, url, interval in PROVIDERS:
        rpc = Rpc(name, url, interval)
        header, error = rpc.one("eth_getBlockByHash", [ANCHOR_HASH, False])
        if header is None:
            emit("error", provider=name, stage="header", error=str(error)[:300])
            continue
        try:
            probe_indexes(rpc, header)
            probe_reverts(rpc)
        except Exception as exc:  # noqa: BLE001
            emit("error", provider=name, stage="indexes", error=repr(exc)[:300])
    print("STATE_DESIGN_PROBE_V6_DONE", flush=True)


if __name__ == "__main__":
    main()
