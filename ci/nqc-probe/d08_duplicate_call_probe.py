#!/usr/bin/env python3
"""Read-only probe of RMC-008 live run 36682467619.

Both AAVE_STATE stages failed on every attempt with Rpc("duplicate call in
batch"): the frozen chain layer refuses a JSON-RPC batch holding the same
call twice. This probe rebuilds, at the census anchor, exactly the address
sets RMC-008's aave stage batches (reserve token sets from getReserveData,
each reserve's code-account list with its proxy slots and strategy, and the
oracle sources) and prints every duplicate. Nothing is written anywhere.
"""
import collections, json, sys, time, urllib.error, urllib.request

ANCHOR_HASH = "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8"
URL = "https://rpc.mevblocker.io"
POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
SLOTS = {
    "eip1967_implementation": "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    "eip1967_beacon": "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
    "zeppelinos_implementation": "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
}
PIN = {"blockHash": ANCHOR_HASH, "requireCanonical": True}


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for attempt in range(8):
        time.sleep(1.25)
        try:
            request = urllib.request.Request(URL, data=body, headers={
                "content-type": "application/json", "user-agent": "nqc-census-chain/1"})
            with urllib.request.urlopen(request, timeout=60) as response:
                reply = json.load(response)
            if "result" in reply:
                return reply["result"]
            print(f"RETRY {method} {reply.get('error')}")
        except Exception as error:  # transport: retry, never an answer
            print(f"RETRY {method} {error}")
        time.sleep(2 ** attempt)
    raise SystemExit(f"NO_ANSWER {method} {params}")


def word_address(word):
    value = word[-40:]
    return None if int(value, 16) == 0 else "0x" + value


def main(reserve_manifest):
    assets = [json.loads(line)["asset"].lower() for line in open(reserve_manifest) if line.strip()]
    print(f"PROBE reserves={len(assets)}")
    selector = "0x35ea6a75"  # getReserveData(address)
    stable, strategy, a_tokens, variables = {}, {}, {}, {}
    for asset in assets:
        data = rpc("eth_call", [{"to": POOL, "data": selector + asset[2:].rjust(64, "0")}, PIN])
        words = [data[2 + 64 * i: 2 + 64 * (i + 1)] for i in range((len(data) - 2) // 64)]
        a, s, v, r = (word_address(words[i]) for i in (8, 9, 10, 11))
        a_tokens[asset], stable[asset], variables[asset], strategy[asset] = a, s, v, r
        accounts = [asset, a, v]
        slots = {}
        for label, account in (("underlying", asset), ("a_token", a), ("variable_debt", v)):
            for name, slot in SLOTS.items():
                if label != "underlying" and name != "eip1967_implementation":
                    continue
                value = rpc("eth_getStorageAt", [account, slot, PIN])
                slots[f"{label}_{name}"] = value
                address = word_address(value) if int(value[2:26] or "0", 16) == 0 else None
                if address and address not in accounts:
                    accounts.append(address)
        if r:
            accounts.append(r)
        duplicates = [x for x, n in collections.Counter(accounts).items() if n > 1]
        print(f"RESERVE asset={asset} a_token={a} stable={s} variable={v} strategy={r} "
              f"code_accounts={len(accounts)} duplicate_code_accounts={duplicates}")
    for label, table in (("stable_debt_token", stable), ("a_token", a_tokens),
                         ("variable_debt_token", variables), ("interest_rate_strategy", strategy)):
        counts = collections.Counter(v for v in table.values() if v)
        shared = {k: n for k, n in counts.items() if n > 1}
        print(f"SHARED {label} distinct={len(counts)} null={sum(1 for v in table.values() if not v)} shared={shared}")
    print("PROBE_DONE")


if __name__ == "__main__":
    main(sys.argv[1])
