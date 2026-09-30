#!/usr/bin/env python3
"""Read-only probe of the RMC-009 zero-address index logs.

RMC-009 live run 36674256094 indexed 3,791,094 Mint/BalanceTransfer logs on
two agreeing providers and counted 13 whose account word (topic 2) is the zero
address. This probe finds every such log from the exact RMC-009 filter (every
RESERVE_INITIALIZED aToken and variable debt token of the certified D06
history), filtered on chain by topic 2 = zero, on both providers, and requires
them to agree. For each log it fetches the transaction (target and selector).
At the census anchor it reads scaledBalanceOf(0x0) and balanceOf(0x0) of every
token on both providers. Nothing is written anywhere.
"""
import json, sys, time, urllib.error, urllib.request

ANCHOR = 25437474
ANCHOR_HASH = "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8"
PROVIDERS = {
    "tenderly-public": ("https://gateway.tenderly.co/public/mainnet", 0.25),
    "mevblocker-rpc": ("https://rpc.mevblocker.io", 1.25),
}
MINT = "0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196"
BALANCE_TRANSFER = "0x4beccb90f994c31aced7a23b5611020728a23d8ec5cddd1a3e9d97b96fda8666"
ZERO_WORD = "0x" + "00" * 32
SCALED_BALANCE_OF = "0x1da24f3e"
BALANCE_OF = "0x70a08231"
WINDOW = 50_000


def post(url, payload):
    body = json.dumps(payload, separators=(",", ":")).encode()
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "content-type": "application/json", "accept": "application/json",
        "user-agent": "nqc-census-chain/1"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def rpc(label, method, params):
    url, interval = PROVIDERS[label]
    payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    for attempt in range(8):
        time.sleep(interval)
        try:
            status, raw = post(url, payload)
        except Exception as error:  # transport: retry, never an answer
            print(f"TRANSIENT {label} {method} {error}")
            time.sleep(2 ** attempt)
            continue
        try:
            reply = json.loads(raw)
        except ValueError:
            reply = None
        if reply is None or status in (429, 502, 503, 504):
            time.sleep(2 ** attempt)
            continue
        error = reply.get("error")
        if error and any(w in json.dumps(error).lower() for w in ("rate", "too many requests", "timeout")) \
                and "results" not in json.dumps(error).lower():
            time.sleep(2 ** attempt)
            continue
        return reply
    raise SystemExit(f"NO_ANSWER {label} {method} {params}")


def zero_logs(label, addresses, first, last):
    """Every log in [first, last] with topic 2 = zero; a refused range is split."""
    reply = rpc(label, "eth_getLogs", [{
        "fromBlock": hex(first), "toBlock": hex(last), "address": addresses,
        "topics": [[MINT, BALANCE_TRANSFER], None, ZERO_WORD]}])
    if "error" in reply:
        if last == first:
            raise SystemExit(f"REFUSED_SINGLE_BLOCK {label} {first} {reply['error']}")
        middle = (first + last) // 2
        return zero_logs(label, addresses, first, middle) + zero_logs(label, addresses, middle + 1, last)
    return reply["result"]


def call(label, token, selector, pin):
    return rpc(label, "eth_call", [{"to": token, "data": selector + "00" * 32}, pin])


def main(history_path):
    report = json.load(open(history_path))
    tokens, kinds, first_block = set(), {}, None
    for event in report["reserve_events"]:
        if event["kind"] != "RESERVE_INITIALIZED":
            continue
        a, v = event["a_token"].lower(), event["variable_debt_token"].lower()
        tokens.update([a, v])
        kinds[a], kinds[v] = "ATOKEN", "VARIABLE_DEBT"
        first_block = event["block"] if first_block is None else min(first_block, event["block"])
    addresses = sorted(tokens)
    print(f"PROBE addresses={len(addresses)} first_block={first_block} anchor={ANCHOR}")

    found = {}
    for label in PROVIDERS:
        rows = []
        start = first_block
        while start <= ANCHOR:
            end = min(start + WINDOW - 1, ANCHOR)
            rows.extend(zero_logs(label, addresses, start, end))
            start = end + 1
        keyed = sorted((int(r["blockNumber"], 16), int(r["logIndex"], 16), r["address"].lower(),
                        r["transactionHash"], tuple(r["topics"]), r["data"]) for r in rows)
        found[label] = keyed
        print(f"ZERO_LOGS provider={label} count={len(keyed)}")
    labels = list(PROVIDERS)
    if found[labels[0]] != found[labels[1]]:
        print("PROVIDERS_DISAGREE")
        for label in labels:
            for row in found[label]:
                print(f"ROW {label} {row}")
        raise SystemExit(1)
    print(f"PROVIDERS_AGREE count={len(found[labels[0]])}")

    for block, index, emitter, tx, topics, data in found[labels[0]]:
        event = "Mint" if topics[0] == MINT else "BalanceTransfer"
        detail = rpc(labels[0], "eth_getTransactionByHash", [tx])["result"] or {}
        words = [data[2 + 64 * i: 2 + 64 * (i + 1)] for i in range((len(data) - 2) // 64)]
        print(f"ZERO_LOG block={block} log={index} token={emitter} kind={kinds.get(emitter)} event={event} "
              f"from_or_caller=0x{topics[1][-40:]} data_words={[int(w, 16) for w in words]} tx={tx} "
              f"tx_to={detail.get('to')} selector={(detail.get('input') or '')[:10]} tx_from={detail.get('from')}")

    pins = {"tenderly-public": hex(ANCHOR),
            "mevblocker-rpc": {"blockHash": ANCHOR_HASH, "requireCanonical": True}}
    for token in addresses:
        values = {}
        for label in labels:
            scaled = call(label, token, SCALED_BALANCE_OF, pins[label])
            balance = call(label, token, BALANCE_OF, pins[label])
            values[label] = (json.dumps(scaled.get("result", scaled.get("error"))),
                             json.dumps(balance.get("result", balance.get("error"))))
        agree = values[labels[0]] == values[labels[1]]
        scaled_value, balance_value = values[labels[0]]
        nonzero = any(v.strip('"') not in ("0x" + "0" * 64, "0x0", "0x") for v in (scaled_value, balance_value))
        if nonzero or not agree:
            print(f"ZERO_HOLDING token={token} kind={kinds[token]} scaled={scaled_value} balance={balance_value} "
                  f"providers_agree={agree} other={values[labels[1]]}")
    print("PROBE_DONE")


if __name__ == "__main__":
    main(sys.argv[1])
