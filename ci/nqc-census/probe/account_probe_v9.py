#!/usr/bin/env python3
"""Ninth read-only probe: D09 account-universe log density, provider log capability and batched balance reads.

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



FIRST = 16_291_000
MINT_TOPICS = None


def topic(signature):
    return "0x" + keccak256(signature.encode()).hex()


TRANSFER = topic("Transfer(address,address,uint256)")
BALANCE_TRANSFER = topic("BalanceTransfer(address,address,uint256,uint256)")
ZERO_WORD = "0x" + "0" * 64

EXTRA_PROVIDERS = [
    ("tenderly-public", "https://gateway.tenderly.co/public/mainnet", 0.25),
    ("publicnode", "https://ethereum-rpc.publicnode.com", 0.5),
    ("drpc-public", "https://eth.drpc.org", 0.5),
    ("1rpc", "https://1rpc.io/eth", 0.5),
    ("llamarpc", "https://eth.llamarpc.com", 0.5),
    ("merkle", "https://eth.merkle.io", 0.5),
    ("nodies-public", "https://ethereum-public.nodies.app", 0.6),
    ("blockpi-public", "https://ethereum.blockpi.network/v1/rpc/public", 0.5),
    ("meowrpc", "https://eth.meowrpc.com", 0.5),
    ("payload", "https://rpc.payload.de", 0.5),
    ("blastapi-public", "https://eth-mainnet.public.blastapi.io", 0.35),
]


def reserve_tokens(rpc):
    result, error = rpc.call(POOL, calldata("getReservesList()"))
    if result is None:
        emit("error", provider=rpc.name, what="getReservesList", error=str(error)[:300])
        return None
    raw = bytes.fromhex(result[2:])
    count = int.from_bytes(raw[32:64], "big")
    assets = ["0x" + raw[64 + 32 * i + 12:64 + 32 * i + 32].hex() for i in range(count)]
    replies = rpc.calls([(POOL, calldata("getReserveData(address)", word_address(a))) for a in assets])
    tokens = []
    for asset, (res, err) in zip(assets, replies):
        w = words(res)
        if w is None or len(w) < 11:
            emit("error", provider=rpc.name, what="getReserveData", asset=asset, error=str(err)[:200])
            return None
        tokens.append({"asset": asset, "atoken": address_of(w[8]), "stable": address_of(w[9]),
                       "vtoken": address_of(w[10]), "treasury_accrued": w[12]})
    emit("reserves", provider=rpc.name, count=len(tokens),
         nonzero_stable=sum(1 for t in tokens if int(t["stable"], 16) != 0))
    return tokens


def logs(rpc, flt, first, last, timeout=180):
    payload = {"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
               "params": [{**flt, "fromBlock": hex(first), "toBlock": hex(last)}]}
    began = time.monotonic()
    wait = rpc.interval - (time.monotonic() - rpc.last)
    if wait > 0:
        time.sleep(wait)
    rpc.last = time.monotonic()
    body = json.dumps(payload).encode()
    req = urllib.request.Request(rpc.url, data=body, headers={
        "content-type": "application/json", "user-agent": "nqc-census-state-probe/9"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        return None, {"http_error": exc.code, "body": exc.read()[:200].decode("utf-8", "replace")}, 0, time.monotonic() - began
    except Exception as exc:  # noqa: BLE001
        return None, {"transport_error": repr(exc)[:200]}, 0, time.monotonic() - began
    elapsed = time.monotonic() - began
    try:
        reply = json.loads(raw)
    except Exception:  # noqa: BLE001
        return None, {"non_json": raw[:200].decode("utf-8", "replace")}, len(raw), elapsed
    if "result" in reply:
        return reply["result"], None, len(raw), elapsed
    return None, reply.get("error", reply), len(raw), elapsed


def density(rpc, tokens, samples=12, span=10_000):
    atokens = [t["atoken"] for t in tokens]
    all_tokens = atokens + [t["vtoken"] for t in tokens]
    filters = {
        "mint": {"address": all_tokens, "topics": [TRANSFER, ZERO_WORD]},
        "balance_transfer": {"address": atokens, "topics": [BALANCE_TRANSFER]},
    }
    step = (ANCHOR - FIRST) // samples
    accounts = {}
    totals = {name: [0, 0, 0] for name in filters}
    for index in range(samples):
        first = FIRST + index * step
        last = first + span - 1
        for name, flt in filters.items():
            result, error, size, elapsed = logs(rpc, flt, first, last)
            if result is None:
                emit("density_error", provider=rpc.name, filter=name, first=first, error=str(error)[:300])
                continue
            totals[name][0] += len(result)
            totals[name][1] += size
            totals[name][2] += 1
            for item in result:
                token = item["address"].lower()
                to = "0x" + item["topics"][2][-40:]
                accounts.setdefault(token, set()).add(to)
            emit("density", provider=rpc.name, filter=name, first=first, last=last, logs=len(result),
                 bytes=size, elapsed=round(elapsed, 2))
    windows = (ANCHOR - FIRST) // span + 1
    for name, (count, size, ok) in totals.items():
        if ok:
            emit("density_estimate", provider=rpc.name, filter=name, sampled_windows=ok,
                 mean_logs=round(count / ok, 1), mean_bytes=round(size / ok),
                 est_total_logs=round(count / ok * windows), est_total_bytes=round(size / ok * windows))
    return accounts


def capability(tokens, reference_first):
    atokens = [t["atoken"] for t in tokens]
    all_tokens = atokens + [t["vtoken"] for t in tokens]
    flt = {"address": all_tokens, "topics": [TRANSFER, ZERO_WORD]}
    for name, url, interval in EXTRA_PROVIDERS:
        rpc = Rpc(name, url, interval)
        for span in (10_000, 2_000, 100):
            result, error, size, elapsed = logs(rpc, flt, reference_first, reference_first + span - 1, timeout=90)
            emit("log_capability", provider=name, span=span, ok=result is not None,
                 logs=None if result is None else len(result), bytes=size, elapsed=round(elapsed, 2),
                 error=None if error is None else str(error)[:240])
        # archive state at the anchor
        res, err = rpc.call(POOL, calldata("getReservesCount()"))
        emit("anchor_state", provider=name, ok=res is not None, error=None if err is None else str(err)[:200])


def balances(rpc, accounts, tokens, limit=400, chunk=100):
    pairs = []
    for token, owners in sorted(accounts.items()):
        for owner in sorted(owners):
            pairs.append((token, owner))
    pairs = pairs[:limit]
    requests = [(token, calldata("scaledBalanceOf(address)", word_address(owner))) for token, owner in pairs]
    began = time.monotonic()
    replies = rpc.calls(requests, chunk=chunk)
    elapsed = time.monotonic() - began
    failures = sum(1 for res, _ in replies if res is None)
    nonzero = sum(1 for res, _ in replies if res is not None and int(res, 16) != 0)
    emit("balance_batch", provider=rpc.name, calls=len(requests), failures=failures, nonzero=nonzero,
         elapsed=round(elapsed, 2), chunk=chunk)
    config = rpc.calls([(POOL, calldata("getUserConfiguration(address)", word_address(owner)))
                        for owner in sorted({o for _, o in pairs})[:200]], chunk=chunk)
    emit("configuration_batch", provider=rpc.name, calls=len(config),
         failures=sum(1 for res, _ in config if res is None))
    return [res for res, _ in replies]


def main():
    mev = Rpc("mevblocker-rpc", "https://rpc.mevblocker.io", 1.25)
    tokens = reserve_tokens(mev)
    if tokens is None:
        print("ACCOUNT_PROBE_V9_DONE", flush=True)
        return
    stable = [t["stable"] for t in tokens if int(t["stable"], 16) != 0]
    if stable:
        supplies = mev.calls([(s, calldata("totalSupply()")) for s in stable])
        emit("stable_debt_supply", nonzero=sum(1 for r, _ in supplies if r is not None and int(r, 16) != 0),
             failures=sum(1 for r, _ in supplies if r is None), tokens=len(stable))
    try:
        accounts = density(mev, tokens)
        emit("sample_accounts", tokens=len(accounts), pairs=sum(len(v) for v in accounts.values()),
             distinct=len(set().union(*accounts.values())) if accounts else 0)
        blast = Rpc("blastapi-public", "https://eth-mainnet.public.blastapi.io", 0.35)
        left = balances(mev, accounts, tokens)
        right = balances(blast, accounts, tokens)
        emit("balance_agreement", equal=left == right, compared=len(left))
    except Exception as exc:  # noqa: BLE001
        emit("error", what="density", error=repr(exc)[:300])
    try:
        capability(tokens, FIRST + 6 * ((ANCHOR - FIRST) // 12))
    except Exception as exc:  # noqa: BLE001
        emit("error", what="capability", error=repr(exc)[:300])
    print("ACCOUNT_PROBE_V9_DONE", flush=True)


if __name__ == "__main__":
    main()
