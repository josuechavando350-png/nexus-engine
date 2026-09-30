#!/usr/bin/env python3
"""RMC-001 Amendment 1 evidence: V2 pairs whose token is their own factory.

Three subcommands, run in this order:

  locate EXTRACTS_DIR OUT.json
      Scans the verified RMC-007 stage extracts for every pair whose token0
      or token1 is the factory. Both the allPairs enumeration rows and the
      PairCreated logs are read, per provider. Every provider and both
      surfaces must name exactly the same pairs, or it fails closed.

  acquire PROVIDERS.json SCOPE.json CANDIDATES.json OUT_DIR
      For each candidate, asks every declared provider, pinned to the census
      anchor by EIP-1898 {blockHash, requireCanonical: true}, for its code,
      pair.factory/token0/token1, factory.getPair in both orders, the
      creation log, and the factory's ERC-20 behaviour. It also records
      eth_chainId, the anchor header and the finalized height. Each exact
      request and response is kept byte for byte. A transport failure or
      rate limit is retried and never read as an answer. A revert is kept as
      an observation.

  verify OUT_DIR
      Offline. Recomputes every digest and decodes every response, then
      checks the claims. All providers must agree. It independently
      recomputes the CREATE2 address of each pair with keccak-256, and writes
      a deterministic summary.json.

Only the Python standard library is used.
"""

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

SCHEMA = "nqc-rmc001-amendment-1-evidence-v1"
PAIR_CREATED_SIGNATURE = "PairCreated(address,address,address,uint256)"
UNISWAP_V2_INIT_CODE_HASH = "96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f"
USER_AGENT = "nqc-census-chain/1"

# --------------------------------------------------------------------------
# keccak-256 (the Ethereum variant, not FIPS SHA3-256), pure Python.

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
]
_MASK = (1 << 64) - 1


def _rol(value, shift):
    shift %= 64
    return ((value << shift) | (value >> (64 - shift))) & _MASK if shift else value


def _keccak_f(lanes):
    for rc in _RC:
        c = [lanes[x][0] ^ lanes[x][1] ^ lanes[x][2] ^ lanes[x][3] ^ lanes[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        lanes = [[lanes[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(lanes[x][y], _ROT[x][y])
        lanes = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)]
                 for x in range(5)]
        lanes[0][0] ^= rc
    return lanes


def keccak256(data: bytes) -> bytes:
    rate = 136
    padded = bytearray(data) + b"\x01"
    padded += b"\x00" * ((-len(padded)) % rate)
    padded[-1] |= 0x80
    lanes = [[0] * 5 for _ in range(5)]
    for offset in range(0, len(padded), rate):
        block = padded[offset:offset + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            lanes[x][y] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        lanes = _keccak_f(lanes)
    out = b"".join(lanes[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


def selector(signature: str) -> str:
    return "0x" + keccak256(signature.encode()).hex()[:8]


def self_test():
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(b"abc").hex() == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    assert selector("transfer(address,uint256)") == "0xa9059cbb"
    assert "0x" + keccak256(PAIR_CREATED_SIGNATURE.encode()).hex() == (
        "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9")


# --------------------------------------------------------------------------
# helpers

def fail(message):
    raise SystemExit(f"RMC001_AMENDMENT_1_EVIDENCE_FAIL {message}")


def address(text):
    value = text.lower()
    if value.startswith("0x"):
        value = value[2:]
    if len(value) != 40 or any(ch not in "0123456789abcdef" for ch in value):
        fail(f"not an address: {text!r}")
    return "0x" + value


def topic_address(topic):
    value = topic.lower().removeprefix("0x")
    if len(value) != 64 or value[:24] != "0" * 24:
        fail(f"topic is not an address: {topic!r}")
    return "0x" + value[24:]


def word_address(word_hex):
    value = word_hex.lower().removeprefix("0x")
    if len(value) != 64 or value[:24] != "0" * 24:
        fail(f"word is not an address: {word_hex!r}")
    return "0x" + value[24:]


def pad_address(addr):
    return "0x" + "0" * 24 + address(addr)[2:]


def sha256_file(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


# --------------------------------------------------------------------------
# locate

def locate(extracts_dir, out_path):
    pairs_by_provider = {}
    logs_by_provider = {}
    anchors = set()
    files = []
    for base, _, names in os.walk(extracts_dir):
        for name in names:
            if name == "extract.json":
                files.append(os.path.join(base, name))
    files.sort()
    if not files:
        fail("no extracts")
    for path in files:
        with open(path, "rb") as handle:
            extract = json.load(handle)
        if extract.get("schema") != "nqc-rmc-007-v2-stage-extract-v1":
            fail(f"{path} is not an RMC-007 stage extract")
        record = extract["record"]
        rows = extract["rows"]
        if len(rows) != extract["row_count"]:
            fail(f"{path} row count differs from its rows")
        anchor = extract["anchor"].get("anchor")
        if not isinstance(anchor, dict):
            fail(f"{path} has no replayed anchor")
        anchors.add((anchor["number"], anchor["hash"].lower()))
        stage = record["stage"]
        label = record["provider"]["label"]
        if stage == "PAIRS":
            table = pairs_by_provider.setdefault(label, {})
            for row in rows:
                if row["index"] in table:
                    fail(f"{label} repeats enumeration index {row['index']}")
                table[row["index"]] = row
        elif stage == "PAIR_CREATED":
            logs_by_provider.setdefault(label, []).extend(rows)
        else:
            fail(f"unknown stage {stage}")
    if len(anchors) != 1:
        fail(f"extracts name more than one anchor: {sorted(map(str, anchors))}")
    if len(pairs_by_provider) < 2 or len(logs_by_provider) < 2:
        fail("need both surfaces from two providers each")

    with open(os.environ.get("NQC_V2_SCOPE", "ci/nqc-census/v2-discovery-scope.json"), "rb") as handle:
        declared = json.load(handle)
    factory = address(declared["factory"])
    pair_created = "0x" + keccak256(PAIR_CREATED_SIGNATURE.encode()).hex()

    enumeration = {}
    counts = {}
    for label, table in sorted(pairs_by_provider.items()):
        counts[label] = len(table)
        found = {}
        for index, row in table.items():
            tokens = [row.get("token0"), row.get("token1")]
            if any(token is None for token in tokens) or row.get("pair") is None:
                fail(f"{label} enumeration index {index} has no pair identity")
            token0, token1 = address(tokens[0]), address(tokens[1])
            if factory in (token0, token1):
                found[address(row["pair"])] = {"index": index, "token0": token0, "token1": token1}
        enumeration[label] = found
    if len(set(counts.values())) != 1:
        fail(f"providers enumerate different pair counts: {counts}")

    creation = {}
    for label, logs in sorted(logs_by_provider.items()):
        found = {}
        for log in logs:
            if address(log["emitter"]) != factory or log["topics"][0].lower() != pair_created:
                fail(f"{label} PairCreated row is not a factory PairCreated log")
            token0, token1 = topic_address(log["topics"][1]), topic_address(log["topics"][2])
            if factory not in (token0, token1):
                continue
            data = log["data"].lower().removeprefix("0x")
            pair = word_address(data[:64])
            ordinal = int(data[64:128], 16)
            if pair in found:
                fail(f"{label} has two creation logs for {pair}")
            found[pair] = {
                "token0": token0, "token1": token1, "ordinal": ordinal,
                "block_number": log["block"], "block_hash": log["block_hash"].lower(),
                "transaction_hash": log["transaction_hash"].lower(),
                "log_index": log["log_index"],
            }
        creation[label] = found

    enumerations = [json.dumps(v, sort_keys=True) for v in enumeration.values()]
    creations = [json.dumps(v, sort_keys=True) for v in creation.values()]
    if len(set(enumerations)) != 1:
        fail("enumeration providers disagree on factory-token pairs")
    if len(set(creations)) != 1:
        fail("PairCreated providers disagree on factory-token pairs")
    listed = next(iter(enumeration.values()))
    created = next(iter(creation.values()))
    if sorted(listed) != sorted(created):
        fail(f"surfaces disagree: enumeration {sorted(listed)} creation {sorted(created)}")
    candidates = []
    for pair in sorted(listed):
        row, log = listed[pair], created[pair]
        if (row["token0"], row["token1"]) != (log["token0"], log["token1"]):
            fail(f"{pair}: enumeration tokens differ from its PairCreated log")
        if log["ordinal"] != row["index"] + 1:
            fail(f"{pair}: PairCreated ordinal {log['ordinal']} is not index {row['index']} + 1")
        candidates.append({"pair": pair, "index": row["index"], **log})
    (anchor,) = anchors
    out = {
        "schema": SCHEMA + "-candidates",
        "factory": factory,
        "anchor": {"number": anchor[0], "hash": anchor[1].lower()},
        "pair_count_per_provider": counts,
        "enumeration_providers": sorted(enumeration),
        "creation_providers": sorted(creation),
        "extract_files": len(files),
        "candidates": candidates,
    }
    with open(out_path, "wb") as handle:
        handle.write(json.dumps(out, sort_keys=True, indent=2).encode() + b"\n")
    for c in candidates:
        side = "token0" if c["token0"] == factory else "token1"
        print(f"RMC001_A1_CANDIDATE pair={c['pair']} {side}=factory token0={c['token0']} "
              f"token1={c['token1']} index={c['index']} created_block={c['block_number']}")
    print(f"RMC001_A1_LOCATE_PASS candidates={len(candidates)} extracts={len(files)} "
          f"pairs_per_provider={sorted(set(counts.values()))}")


# --------------------------------------------------------------------------
# acquire

def rpc_calls(scope, candidate, anchor_hash):
    factory = scope["factory"]
    pin = {"blockHash": anchor_hash, "requireCanonical": True}
    pair, token0, token1 = candidate["pair"], candidate["token0"], candidate["token1"]
    factory_token = token0 if token0 == factory else token1
    def call(to, data):
        return ("eth_call", [{"to": to, "data": data}, pin])
    get_pair = selector("getPair(address,address)")
    return [
        ("code_pair", ("eth_getCode", [pair, pin])),
        ("code_token0", ("eth_getCode", [token0, pin])),
        ("code_token1", ("eth_getCode", [token1, pin])),
        ("pair_factory", call(pair, selector("factory()"))),
        ("pair_token0", call(pair, selector("token0()"))),
        ("pair_token1", call(pair, selector("token1()"))),
        ("pair_get_reserves", call(pair, selector("getReserves()"))),
        ("factory_get_pair", call(factory, get_pair + pad_address(token0)[2:] + pad_address(token1)[2:])),
        ("factory_get_pair_reversed",
         call(factory, get_pair + pad_address(token1)[2:] + pad_address(token0)[2:])),
        ("factory_all_pairs_at_index",
         call(factory, selector("allPairs(uint256)") + format(candidate["index"], "064x"))),
        ("creation_log", ("eth_getLogs", [{
            "blockHash": candidate["block_hash"], "address": factory,
            "topics": ["0x" + keccak256(PAIR_CREATED_SIGNATURE.encode()).hex(),
                       pad_address(token0), pad_address(token1)]}])),
        ("factory_token_decimals", call(factory_token, selector("decimals()"))),
        ("factory_token_symbol", call(factory_token, selector("symbol()"))),
        ("factory_token_total_supply", call(factory_token, selector("totalSupply()"))),
        ("factory_token_balance_of_pair",
         call(factory_token, selector("balanceOf(address)") + pad_address(pair)[2:])),
    ]


def is_transient(status, reply):
    if status in (408, 425, 429) or status >= 500:
        return True
    error = (reply or {}).get("error")
    if not error:
        return False
    text = json.dumps(error).lower()
    return any(word in text for word in ("rate", "limit", "timeout", "too many", "capacity",
                                         "unavailable", "busy", "try again", "header not found"))


def is_revert(reply):
    error = (reply or {}).get("error")
    if not error:
        return False
    text = json.dumps(error).lower()
    return "revert" in text or error.get("code") == 3


def post(provider, body):
    request = urllib.request.Request(provider["url"], data=body, method="POST", headers={
        "content-type": "application/json", "accept": "application/json",
        "user-agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def acquire(providers_path, scope_path, candidates_path, out_dir):
    with open(providers_path, "rb") as handle:
        providers = json.load(handle)["providers"]
    with open(scope_path, "rb") as handle:
        scope = json.load(handle)
    with open(candidates_path, "rb") as handle:
        candidates = json.load(handle)
    scope = {"factory": address(scope["factory"]), "chain_id": scope["chain_id"],
             "anchor_number": scope["observation_anchor"]["block_number"],
             "anchor_hash": scope["observation_anchor"]["block_hash"].lower()}
    if candidates["factory"] != scope["factory"] or candidates["anchor"] != {
            "number": scope["anchor_number"], "hash": scope["anchor_hash"]}:
        fail("candidates were located for another factory or anchor")
    if not candidates["candidates"]:
        fail("no candidate pair to prove")
    index = []
    exchanges = os.path.join(out_dir, "exchanges")
    for provider in providers:
        label = provider["label"]
        os.makedirs(os.path.join(exchanges, label), exist_ok=True)
        plan = [
            ("chain_id", ("eth_chainId", [])),
            ("anchor_by_number", ("eth_getBlockByNumber", [hex(scope["anchor_number"]), False])),
            ("anchor_by_hash", ("eth_getBlockByHash", [scope["anchor_hash"], False])),
            ("finalized", ("eth_getBlockByNumber", ["finalized", False])),
            ("code_factory", ("eth_getCode", [scope["factory"],
                                              {"blockHash": scope["anchor_hash"],
                                               "requireCanonical": True}])),
            ("factory_all_pairs_length",
             ("eth_call", [{"to": scope["factory"], "data": selector("allPairsLength()")},
                           {"blockHash": scope["anchor_hash"], "requireCanonical": True}])),
        ]
        for candidate in candidates["candidates"]:
            plan += [(f"{candidate['pair']}.{name}", spec)
                     for name, spec in rpc_calls(scope, candidate, scope["anchor_hash"])]
        interval = provider.get("min_interval_ms", 500) / 1000
        for seq, (name, (method, params)) in enumerate(plan):
            body = canonical({"jsonrpc": "2.0", "id": seq + 1, "method": method, "params": params})
            for attempt in range(8):
                time.sleep(interval)
                try:
                    status, raw = post(provider, body)
                except Exception as error:  # transport failure: retry, never read as an answer
                    print(f"{label} {name} transport error: {error}")
                    time.sleep(2 ** attempt)
                    continue
                try:
                    reply = json.loads(raw)
                except ValueError:
                    reply = None
                if reply is None or is_transient(status, reply):
                    print(f"{label} {name} transient status={status} body={raw[:200]!r}")
                    time.sleep(2 ** attempt)
                    continue
                if status != 200:
                    fail(f"{label} {name} HTTP {status}")
                break
            else:
                fail(f"{label} {name}: no answer after retries")
            stem = f"{seq:04d}-{name.replace('.', '-')}"
            for suffix, data in ((".request.json", body), (".response.json", raw)):
                with open(os.path.join(exchanges, label, stem + suffix), "wb") as handle:
                    handle.write(data)
            index.append({
                "provider": label, "namespace": provider["namespace"], "url": provider["url"],
                "seq": seq, "name": name, "method": method,
                "request": f"exchanges/{label}/{stem}.request.json",
                "request_sha256": hashlib.sha256(body).hexdigest(),
                "response": f"exchanges/{label}/{stem}.response.json",
                "response_sha256": hashlib.sha256(raw).hexdigest(),
                "outcome": "REVERT" if is_revert(reply) else ("ERROR" if "error" in reply else "RESULT"),
            })
            print(f"{label} {name} {index[-1]['outcome']}")
    with open(os.path.join(out_dir, "candidates.json"), "wb") as handle:
        handle.write(json.dumps(candidates, sort_keys=True, indent=2).encode() + b"\n")
    with open(os.path.join(out_dir, "scope.json"), "wb") as handle:
        handle.write(json.dumps(scope, sort_keys=True, indent=2).encode() + b"\n")
    with open(os.path.join(out_dir, "exchanges.json"), "wb") as handle:
        handle.write(json.dumps({"schema": SCHEMA + "-exchanges", "exchanges": index},
                                sort_keys=True, indent=2).encode() + b"\n")
    print(f"RMC001_A1_ACQUIRE_DONE exchanges={len(index)} providers={len(providers)}")


# --------------------------------------------------------------------------
# verify (offline)

MANDATORY_RESULT = {"code_pair", "code_token0", "code_token1", "pair_factory", "pair_token0",
                    "pair_token1", "pair_get_reserves", "factory_get_pair",
                    "factory_get_pair_reversed", "factory_all_pairs_at_index", "creation_log"}
BEHAVIOUR = {"factory_token_decimals", "factory_token_symbol", "factory_token_total_supply",
             "factory_token_balance_of_pair"}


def verify(out_dir):
    self_test()
    with open(os.path.join(out_dir, "exchanges.json"), "rb") as handle:
        exchanges = json.load(handle)["exchanges"]
    with open(os.path.join(out_dir, "scope.json"), "rb") as handle:
        scope = json.load(handle)
    with open(os.path.join(out_dir, "candidates.json"), "rb") as handle:
        candidates = json.load(handle)
    factory = scope["factory"]
    by_provider = {}
    for item in exchanges:
        for key in ("request", "response"):
            if sha256_file(os.path.join(out_dir, item[key])) != item[key + "_sha256"]:
                fail(f"{item[key]} digest differs from the exchange index")
        with open(os.path.join(out_dir, item["request"]), "rb") as handle:
            request = json.load(handle)
        with open(os.path.join(out_dir, item["response"]), "rb") as handle:
            reply = json.load(handle)
        if request.get("method") != item["method"] or reply.get("id") != request.get("id"):
            fail(f"{item['response']} does not answer its request")
        if item["outcome"] != ("REVERT" if is_revert(reply) else ("ERROR" if "error" in reply else "RESULT")):
            fail(f"{item['response']} outcome mislabelled")
        by_provider.setdefault(item["provider"], {})[item["name"]] = (request, reply)
    if len(by_provider) < 2:
        fail("need at least two providers")

    def result(label, name):
        request, reply = by_provider[label].get(name, (None, None))
        if reply is None:
            fail(f"{label} lacks {name}")
        if "result" not in reply or reply["result"] is None:
            fail(f"{label} {name} has no result: {reply.get('error')}")
        return reply["result"]

    def agreed(name, project=lambda value: value):
        values = {label: project(result(label, name)) for label in by_provider}
        if len({json.dumps(v, sort_keys=True) for v in values.values()}) != 1:
            fail(f"providers disagree on {name}: {values}")
        return next(iter(values.values()))

    chain_id = int(agreed("chain_id"), 16)
    if chain_id != scope["chain_id"]:
        fail(f"chain id {chain_id} is not {scope['chain_id']}")
    header = lambda block: {"number": int(block["number"], 16), "hash": block["hash"].lower(),
                            "parentHash": block["parentHash"].lower()}
    anchor = agreed("anchor_by_number", header)
    if agreed("anchor_by_hash", header) != anchor:
        fail("anchor by hash differs from anchor by number")
    if (anchor["number"], anchor["hash"]) != (scope["anchor_number"], scope["anchor_hash"]):
        fail(f"anchor {anchor} is not the census anchor")
    finalized = {label: int(result(label, "finalized")["number"], 16) for label in by_provider}
    if min(finalized.values()) < anchor["number"]:
        fail(f"anchor is not finalized on every provider: {finalized}")
    factory_code = agreed("code_factory")
    if len(factory_code) <= 2:
        fail("factory has no code at the anchor")
    all_pairs_length = int(agreed("factory_all_pairs_length"), 16)

    init_code_hash = bytes.fromhex(UNISWAP_V2_INIT_CODE_HASH)
    proven = []
    for candidate in candidates["candidates"]:
        pair, token0, token1 = candidate["pair"], candidate["token0"], candidate["token1"]
        p = pair + "."
        for name in MANDATORY_RESULT:
            agreed(p + name)
        code = {k: agreed(p + "code_" + k) for k in ("pair", "token0", "token1")}
        if len(code["pair"]) <= 2:
            fail(f"{pair} has no code at the anchor")
        observed = {
            "pair.factory()": word_address(agreed(p + "pair_factory")),
            "pair.token0()": word_address(agreed(p + "pair_token0")),
            "pair.token1()": word_address(agreed(p + "pair_token1")),
            "factory.getPair(token0,token1)": word_address(agreed(p + "factory_get_pair")),
            "factory.getPair(token1,token0)": word_address(agreed(p + "factory_get_pair_reversed")),
            "factory.allPairs(index)": word_address(agreed(p + "factory_all_pairs_at_index")),
        }
        if observed["pair.factory()"] != factory:
            fail(f"{pair}.factory() is {observed['pair.factory()']}, not the factory")
        if (observed["pair.token0()"], observed["pair.token1()"]) != (token0, token1):
            fail(f"{pair} runtime tokens differ from its creation")
        for key in ("factory.getPair(token0,token1)", "factory.getPair(token1,token0)",
                    "factory.allPairs(index)"):
            if observed[key] != pair:
                fail(f"{key} is {observed[key]}, not {pair}")
        if factory not in (token0, token1):
            fail(f"{pair} does not name the factory as a token")
        if not token0 < token1:
            fail(f"{pair} tokens are not canonically ordered")
        if pair in (factory, token0, token1):
            fail(f"{pair} collides with its factory or a token")
        create2 = "0x" + keccak256(
            b"\xff" + bytes.fromhex(factory[2:])
            + keccak256(bytes.fromhex(token0[2:]) + bytes.fromhex(token1[2:]))
            + init_code_hash)[12:].hex()
        if create2 != pair:
            fail(f"CREATE2({factory}, {token0}, {token1}) is {create2}, not {pair}")
        logs = agreed(p + "creation_log")
        matching = [log for log in logs
                    if log["transactionHash"].lower() == candidate["transaction_hash"]
                    and int(log["logIndex"], 16) == candidate["log_index"]]
        if len(matching) != 1:
            fail(f"{pair} creation log is not in its block")
        log = matching[0]
        if (address(log["address"]) != factory or log["blockHash"].lower() != candidate["block_hash"]
                or int(log["blockNumber"], 16) != candidate["block_number"]
                or word_address(log["data"][2:66]) != pair
                or int(log["data"][66:130], 16) != candidate["ordinal"] or log.get("removed")):
            fail(f"{pair} creation log does not prove its creation")
        behaviour = {}
        for name in sorted(BEHAVIOUR):
            outcomes = {}
            for label in by_provider:
                _, reply = by_provider[label][p + name]
                outcomes[label] = ("REVERT" if is_revert(reply) else
                                   ("RESULT:" + reply["result"] if "result" in reply else None))
                if outcomes[label] is None:
                    fail(f"{label} {name} is neither a result nor a revert: {reply}")
            if len(set(outcomes.values())) != 1:
                fail(f"providers disagree on {pair} {name}: {outcomes}")
            behaviour[name.removeprefix("factory_token_")] = next(iter(outcomes.values()))
        proven.append({
            "pair_address": pair,
            "token0": token0,
            "token1": token1,
            "factory_is": "token0" if token0 == factory else "token1",
            "enumeration_index": candidate["index"],
            "creation": {k: candidate[k] for k in ("block_number", "block_hash", "transaction_hash",
                                                  "log_index", "ordinal")},
            "observed_at_anchor": observed,
            "create2_address": create2,
            "code_sha256": {k: hashlib.sha256(bytes.fromhex(v[2:])).hexdigest() for k, v in code.items()},
            "code_keccak256": {k: keccak256(bytes.fromhex(v[2:])).hex() for k, v in code.items()},
            "code_bytes": {k: (len(v) - 2) // 2 for k, v in code.items()},
            "reserves_word": agreed(p + "pair_get_reserves"),
            "factory_as_erc20": behaviour,
        })

    summary = {
        "schema": SCHEMA,
        "claim": "UNISWAP_V2_PAIR_MAY_NAME_ITS_FACTORY_AS_A_TOKEN",
        "chain_id": chain_id,
        "block_number": anchor["number"],
        "block_hash": anchor["hash"],
        "parent_hash": anchor["parentHash"],
        "finalized_height_per_provider": finalized,
        "factory": factory,
        "factory_code_sha256": hashlib.sha256(bytes.fromhex(factory_code[2:])).hexdigest(),
        "factory_code_keccak256": keccak256(bytes.fromhex(factory_code[2:])).hex(),
        "all_pairs_length": all_pairs_length,
        "providers": sorted(by_provider),
        "pinning": "EIP1898_BLOCK_HASH_REQUIRE_CANONICAL",
        "uniswap_v2_init_code_hash": "0x" + UNISWAP_V2_INIT_CODE_HASH,
        "pairs": proven,
        "exchanges_sha256": sha256_file(os.path.join(out_dir, "exchanges.json")),
        "candidates_sha256": sha256_file(os.path.join(out_dir, "candidates.json")),
        "scope_sha256": sha256_file(os.path.join(out_dir, "scope.json")),
    }
    data = json.dumps(summary, sort_keys=True, indent=2).encode() + b"\n"
    target = os.path.join(out_dir, "summary.json")
    if os.path.exists(target):
        with open(target, "rb") as handle:
            if handle.read() != data:
                fail("summary.json differs from the evidence it summarises")
    else:
        with open(target, "wb") as handle:
            handle.write(data)
    for pair in proven:
        o = pair["observed_at_anchor"]
        print(f"RMC001_A1_PROVEN chain_id={chain_id} block={anchor['number']} hash={anchor['hash']} "
              f"pair={pair['pair_address']} token0={pair['token0']} token1={pair['token1']} "
              f"factory={factory} factory_is={pair['factory_is']} pair.factory()={o['pair.factory()']} "
              f"getPair={o['factory.getPair(token0,token1)']} create2={pair['create2_address']}")
    print(f"RMC001_AMENDMENT_1_EVIDENCE_PASS pairs={len(proven)} providers={len(by_provider)} "
          f"summary_sha256={hashlib.sha256(data).hexdigest()}")


def main(argv):
    self_test()
    if len(argv) >= 2 and argv[1] == "self-test":
        print("RMC001_A1_KECCAK_SELF_TEST_PASS")
    elif len(argv) == 4 and argv[1] == "locate":
        locate(argv[2], argv[3])
    elif len(argv) == 6 and argv[1] == "acquire":
        acquire(*argv[2:6])
    elif len(argv) == 3 and argv[1] == "verify":
        verify(argv[2])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
