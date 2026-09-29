#!/usr/bin/env python3
"""Fifth read-only probe: D08 state/oracle/token design facts.

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


def ray_mul_half_up(a, b):
    return (a * b + RAY // 2) // RAY


def ray_mul_floor(a, b):
    return (a * b) // RAY


def ray_mul_ceil(a, b):
    return -((-(a * b)) // RAY)


def linear(rate, last, now):
    return RAY + rate * (now - last) // YEAR


def compounded(rate, last, now):
    exp = now - last
    if exp == 0:
        return RAY
    e1, e2 = exp - 1, max(exp - 2, 0)
    b2 = ray_mul_half_up(rate, rate) // (YEAR * YEAR)
    b3 = ray_mul_half_up(b2, rate) // YEAR
    return RAY + rate * exp // YEAR + exp * e1 * b2 // 2 + exp * e1 * e2 * b3 // 6


def storage(rpc, account, slot):
    value, error = rpc.one("eth_getStorageAt", [account, slot, {"blockHash": ANCHOR_HASH}])
    return None if value is None else int(value, 16)


def code_size(rpc, account):
    code, error = rpc.one("eth_getCode", [account, {"blockHash": ANCHOR_HASH}])
    return None if code is None else (len(code) - 2) // 2


def probe_capabilities(rpc):
    # Code override: runtime returning word 42.
    runtime = "0x602a60005260206000f3"
    target = "0x00000000000000000000000000000000000c0de5"
    result, error = rpc.one("eth_call", [{"to": target, "data": "0x"}, {"blockHash": ANCHOR_HASH},
                                         {target: {"code": runtime}}])
    emit("capability", provider=rpc.name, feature="STATE_OVERRIDE_CODE", result=result,
         error=None if result else error)
    # Creation call: init code that returns the 32-byte word 42 as "runtime".
    result, error = rpc.one("eth_call", [{"data": "0x602a60005260206000f3"}, {"blockHash": ANCHOR_HASH}])
    emit("capability", provider=rpc.name, feature="CREATION_CALL", result=result,
         error=None if result else error)
    proof, error = rpc.one("eth_getProof", [POOL, [], {"blockHash": ANCHOR_HASH}])
    emit("capability", provider=rpc.name, feature="GET_PROOF",
         ok=proof is not None,
         code_hash=None if proof is None else proof.get("codeHash"),
         proof_nodes=None if proof is None else len(proof.get("accountProof", [])),
         proof_bytes=None if proof is None else sum((len(n) - 2) // 2 for n in proof.get("accountProof", [])),
         error=None if proof else error)


def probe_aave(rpc, header):
    now = int(header["timestamp"], 16)
    impl_code, _ = rpc.one("eth_getCode", [POOL_IMPL, {"blockHash": ANCHOR_HASH}])
    present = push4_selectors(impl_code) if impl_code else set()
    emit("aave_selectors", provider=rpc.name, impl_bytes=(len(impl_code) - 2) // 2 if impl_code else None,
         present=sorted(s for s in POOL_CANDIDATES if selector(s) in present),
         absent=sorted(s for s in POOL_CANDIDATES if selector(s) not in present))
    scalars = {}
    for signature in ["POOL_REVISION()", "FLASHLOAN_PREMIUM_TOTAL()", "FLASHLOAN_PREMIUM_TO_PROTOCOL()",
                      "MAX_NUMBER_RESERVES()", "BRIDGE_PROTOCOL_FEE()", "MAX_STABLE_RATE_BORROW_SIZE_PERCENT()",
                      "UMBRELLA()", "getReservesCount()"]:
        result, error = rpc.call(POOL, calldata(signature))
        scalars[signature] = words(result) if result is not None else {"error": str(error)[:120]}
    emit("aave_scalars", provider=rpc.name, values=scalars)
    listed, _ = rpc.call(POOL, calldata("getReservesList()"))
    body = words(listed)
    reserves = [address_of(v) for v in body[2:2 + body[1]]]
    emit("aave_reserves", provider=rpc.name, count=len(reserves), reserves=reserves)
    per = ["getReserveData(address)", "getReserveDataExtended(address)", "getConfiguration(address)",
           "getReserveNormalizedIncome(address)", "getReserveNormalizedVariableDebt(address)",
           "getVirtualUnderlyingBalance(address)", "getLiquidationGracePeriod(address)",
           "getReserveDeficit(address)", "getReserveAToken(address)", "getReserveVariableDebtToken(address)"]
    requests = [(POOL, calldata(sig, word_address(asset))) for asset in reserves for sig in per]
    results = rpc.calls(requests)
    table = {}
    for index, asset in enumerate(reserves):
        row = {}
        for j, sig in enumerate(per):
            result, error = results[index * len(per) + j]
            row[sig] = words(result) if result is not None else {"error": str(error)[:160]}
        table[asset] = row
    shapes = {sig: sorted({len(r[sig]) if isinstance(r[sig], list) else -1 for r in table.values()}) for sig in per}
    emit("aave_reserve_shapes", provider=rpc.name, shapes=shapes)
    first = reserves[0]
    emit("aave_first_reserve", provider=rpc.name, asset=first,
         data={k: (v if not isinstance(v, list) else [hex(x) for x in v]) for k, v in table[first].items()})
    # Token math and index rounding vs the deployed getters.
    token_requests = []
    for asset in reserves:
        data = table[asset]["getReserveData(address)"]
        a_token, v_token, s_token = address_of(data[8]), address_of(data[10]), address_of(data[9])
        token_requests += [
            (a_token, calldata("scaledTotalSupply()")), (a_token, calldata("totalSupply()")),
            (v_token, calldata("scaledTotalSupply()")), (v_token, calldata("totalSupply()")),
            (a_token, calldata("UNDERLYING_ASSET_ADDRESS()")), (a_token, calldata("POOL()")),
            (a_token, calldata("RESERVE_TREASURY_ADDRESS()")), (a_token, calldata("ATOKEN_REVISION()")),
            (v_token, calldata("UNDERLYING_ASSET_ADDRESS()")), (v_token, calldata("POOL()")),
            (v_token, calldata("DEBT_TOKEN_REVISION()")), (a_token, calldata("decimals()")),
            (v_token, calldata("decimals()")), (asset, calldata("decimals()")),
            (asset, calldata("balanceOf(address)", word_address(a_token))),
            (asset, calldata("totalSupply()")),
            (s_token, calldata("totalSupply()")) if data[9] else (asset, calldata("totalSupply()")),
        ]
    token_results = rpc.calls(token_requests)
    width = 17
    summary = {"a_floor": 0, "a_half": 0, "a_ceil": 0, "v_floor": 0, "v_half": 0, "v_ceil": 0,
               "income_half": 0, "income_floor": 0, "debt_half": 0, "debt_floor": 0, "debt_ceil": 0,
               "virtual_le_balance": 0, "virtual_gt_balance": 0, "decimals_equal": 0, "n": 0}
    rows = []
    for index, asset in enumerate(reserves):
        data = table[asset]["getReserveData(address)"]
        got = [words(r)[0] if r is not None and len(r) >= 66 else None for r, _ in token_results[index * width:(index + 1) * width]]
        income = table[asset]["getReserveNormalizedIncome(address)"]
        debt = table[asset]["getReserveNormalizedVariableDebt(address)"]
        income = income[0] if isinstance(income, list) else None
        debt = debt[0] if isinstance(debt, list) else None
        virtual = table[asset]["getVirtualUnderlyingBalance(address)"]
        virtual = virtual[0] if isinstance(virtual, list) and virtual else None
        summary["n"] += 1
        a_scaled, a_total, v_scaled, v_total = got[0], got[1], got[2], got[3]
        if None not in (a_scaled, a_total, income):
            summary["a_floor"] += ray_mul_floor(a_scaled, income) == a_total
            summary["a_half"] += ray_mul_half_up(a_scaled, income) == a_total
            summary["a_ceil"] += ray_mul_ceil(a_scaled, income) == a_total
        if None not in (v_scaled, v_total, debt):
            summary["v_floor"] += ray_mul_floor(v_scaled, debt) == v_total
            summary["v_half"] += ray_mul_half_up(v_scaled, debt) == v_total
            summary["v_ceil"] += ray_mul_ceil(v_scaled, debt) == v_total
        last = data[6]
        if income is not None:
            lin = linear(data[2], last, now)
            summary["income_half"] += (income == data[1] if last == now else ray_mul_half_up(lin, data[1]) == income)
            summary["income_floor"] += (income == data[1] if last == now else ray_mul_floor(lin, data[1]) == income)
        if debt is not None:
            comp = compounded(data[4], last, now)
            summary["debt_half"] += (debt == data[3] if last == now else ray_mul_half_up(comp, data[3]) == debt)
            summary["debt_floor"] += (debt == data[3] if last == now else ray_mul_floor(comp, data[3]) == debt)
            summary["debt_ceil"] += (debt == data[3] if last == now else ray_mul_ceil(comp, data[3]) == debt)
        balance = got[14]
        if virtual is not None and balance is not None:
            summary["virtual_le_balance" if virtual <= balance else "virtual_gt_balance"] += 1
        config = data[0]
        decimals = (config >> 48) & 0xFF
        summary["decimals_equal"] += decimals == got[11] == got[12] == got[13]
        rows.append({"asset": asset, "config_hex": hex(config), "a_token": address_of(data[8]),
                     "v_token": address_of(data[10]), "stable": address_of(data[9]),
                     "irs": address_of(data[11]), "a_underlying": None if got[4] is None else address_of(got[4]),
                     "a_pool": None if got[5] is None else address_of(got[5]),
                     "treasury": None if got[6] is None else address_of(got[6]),
                     "a_rev": got[7], "v_rev": got[10], "decimals": [decimals, got[11], got[12], got[13]],
                     "stable_total": got[16] if data[9] else None, "last_update": last,
                     "virtual": virtual, "balance": balance})
    emit("aave_token_math", provider=rpc.name, anchor_timestamp=now, summary=summary)
    for row in rows:
        emit("aave_reserve_row", provider=rpc.name, **row)
    return reserves, table


def probe_emode(rpc):
    sigs = ["getEModeCategoryData(uint8)", "getEModeCategoryCollateralConfig(uint8)",
            "getEModeCategoryLabel(uint8)", "getEModeCategoryCollateralBitmap(uint8)",
            "getEModeCategoryBorrowableBitmap(uint8)", "getEModeCategoryLtvzeroBitmap(uint8)"]
    ids = list(range(0, 256))
    results = rpc.calls([(POOL, calldata(sig, word_uint(i))) for i in ids for sig in sigs])
    configured = []
    errors = {sig: 0 for sig in sigs}
    for n, i in enumerate(ids):
        row = {}
        for j, sig in enumerate(sigs):
            result, error = results[n * len(sigs) + j]
            if result is None:
                errors[sig] += 1
                row[sig] = None
            elif sig.startswith("getEModeCategoryLabel"):
                row[sig] = decode_string(result)
            else:
                row[sig] = words(result)
        collateral = row["getEModeCategoryCollateralConfig(uint8)"]
        legacy = row["getEModeCategoryData(uint8)"]
        if (collateral and any(collateral[:3])) or (legacy and any(legacy[1:4])) or row["getEModeCategoryLabel(uint8)"]:
            configured.append({"id": i, "label": row["getEModeCategoryLabel(uint8)"],
                               "collateral_config": collateral, "legacy_words": None if legacy is None else len(legacy),
                               "legacy_head": None if legacy is None else [hex(x) for x in legacy[:5]],
                               "collateral_bitmap": row["getEModeCategoryCollateralBitmap(uint8)"],
                               "borrowable_bitmap": row["getEModeCategoryBorrowableBitmap(uint8)"],
                               "ltvzero_bitmap": row["getEModeCategoryLtvzeroBitmap(uint8)"]})
    emit("aave_emode", provider=rpc.name, errors=errors, configured_count=len(configured))
    for row in configured:
        emit("aave_emode_category", provider=rpc.name, **row)


def probe_oracle(rpc, reserves, header):
    now = int(header["timestamp"], 16)
    base = {}
    for sig in ["BASE_CURRENCY()", "BASE_CURRENCY_UNIT()", "getFallbackOracle()", "ADDRESSES_PROVIDER()"]:
        result, error = rpc.call(ORACLE, calldata(sig))
        base[sig] = None if result is None else hex(words(result)[0])
    emit("oracle_base", provider=rpc.name, values=base)
    results = rpc.calls([(ORACLE, calldata(sig, word_address(a))) for a in reserves
                         for sig in ["getSourceOfAsset(address)", "getAssetPrice(address)"]])
    sources = []
    for n, asset in enumerate(reserves):
        source = results[2 * n][0]
        price = results[2 * n + 1][0]
        sources.append((asset, None if source is None else address_of(words(source)[0]),
                        None if price is None else words(price)[0]))
    sigs = ["latestAnswer()", "latestRoundData()", "decimals()", "description()", "aggregator()",
            "latestTimestamp()", "version()", "BASE_TO_USD_AGGREGATOR()", "RATIO_PROVIDER()",
            "isCapped()", "getRatio()", "ASSET_TO_USD_AGGREGATOR()", "PEG_TO_BASE()", "ASSET_TO_PEG()"]
    src_results = rpc.calls([(src, calldata(sig)) for _, src, _ in sources for sig in sigs])
    kinds = {}
    for n, (asset, src, price) in enumerate(sources):
        row = {}
        for j, sig in enumerate(sigs):
            result, error = src_results[n * len(sigs) + j]
            if result is None or result == "0x":
                row[sig] = None
            elif sig == "description()":
                row[sig] = decode_string(result)
            else:
                row[sig] = words(result)
        latest = row["latestAnswer()"]
        round_data = row["latestRoundData()"]
        exposed = tuple(sig for sig in sigs if row[sig] is not None)
        kinds[exposed] = kinds.get(exposed, 0) + 1
        emit("oracle_source", provider=rpc.name, asset=asset, source=src, price=price,
             latest_answer=None if latest is None else latest[0],
             price_equals_latest=None if latest is None else latest[0] == price,
             updated_at=None if round_data is None or len(round_data) < 4 else round_data[3],
             age=None if round_data is None or len(round_data) < 4 else now - round_data[3],
             decimals=None if row["decimals()"] is None else row["decimals()"][0],
             description=row["description()"], exposed=list(exposed))
    emit("oracle_kinds", provider=rpc.name, kinds=[{"exposed": list(k), "count": v} for k, v in kinds.items()])


def probe_token_proxies(rpc, reserves, table):
    for asset in reserves:
        data = table[asset]["getReserveData(address)"]
        a_token, v_token = address_of(data[8]), address_of(data[10])
        record = {"asset": asset}
        for label, account in [("underlying", asset), ("a_token", a_token), ("v_token", v_token)]:
            record[label] = {
                "code": code_size(rpc, account),
                "eip1967_impl": storage(rpc, account, EIP1967_IMPL),
                "eip1967_beacon": storage(rpc, account, EIP1967_BEACON),
                "zeppelinos_impl": storage(rpc, account, ZEPPELINOS_IMPL),
            }
            for key in ("eip1967_impl", "eip1967_beacon", "zeppelinos_impl"):
                if record[label][key]:
                    record[label][key] = address_of(record[label][key])
        emit("token_proxy", provider=rpc.name, **record)


def probe_v2(rpc):
    pairs = []
    for index in (0, 1, 2, 100_000, 514_623):
        result, _ = rpc.call(V2_FACTORY, calldata("allPairs(uint256)", word_uint(index)))
        pairs.append((index, None if result is None else address_of(words(result)[0])))
    for index, pair in pairs:
        sigs = ["getReserves()", "kLast()", "totalSupply()", "factory()", "token0()", "token1()",
                "price0CumulativeLast()", "MINIMUM_LIQUIDITY()", "decimals()"]
        results = rpc.calls([(pair, calldata(sig)) for sig in sigs])
        row = {sig: (None if r is None else words(r)) for sig, (r, _) in zip(sigs, results)}
        tokens = [address_of(row["token0()"][0]), address_of(row["token1()"][0])]
        token_results = rpc.calls([(t, calldata(sig, *args)) for t in tokens for sig, args in
                                   [("decimals()", ()), ("balanceOf(address)", (word_address(pair),)),
                                    ("totalSupply()", ())]])
        emit("v2_pair", provider=rpc.name, index=index, pair=pair,
             reserves=row["getReserves()"], k_last=row["kLast()"], total_supply=row["totalSupply()"],
             factory=None if row["factory()"] is None else address_of(row["factory()"][0]),
             tokens=tokens, token_facts=[None if r is None else words(r) for r, _ in token_results],
             pair_code=code_size(rpc, pair))


def main():
    for name, url, interval in PROVIDERS:
        rpc = Rpc(name, url, interval)
        header, error = rpc.one("eth_getBlockByHash", [ANCHOR_HASH, False])
        if header is None:
            emit("error", provider=name, stage="header", error=str(error)[:300])
            continue
        emit("anchor", provider=name, number=int(header["number"], 16), timestamp=int(header["timestamp"], 16))
        for stage, run in [("capabilities", lambda: probe_capabilities(rpc))]:
            try:
                run()
            except Exception as exc:  # noqa: BLE001
                emit("error", provider=name, stage=stage, error=repr(exc)[:300])
        try:
            reserves, table = probe_aave(rpc, header)
            probe_emode(rpc)
            probe_oracle(rpc, reserves, header)
            probe_token_proxies(rpc, reserves, table)
        except Exception as exc:  # noqa: BLE001
            emit("error", provider=name, stage="aave", error=repr(exc)[:300])
        try:
            probe_v2(rpc)
        except Exception as exc:  # noqa: BLE001
            emit("error", provider=name, stage="v2", error=repr(exc)[:300])
    print("STATE_DESIGN_PROBE_V5_DONE", flush=True)


if __name__ == "__main__":
    main()
