#!/usr/bin/env python3
"""Read-only probe of Aave V3 stable debt token addresses at the census anchor.

Probe run 36686929285 read one stable debt token (0x1026…949a) in
getReserveData of all 67 mainnet reserves. RMC-009 compares getReserveData's
token addresses to the ones D06's history recorded at initialization. This
probe prints, per reserve, the stable debt token D06 recorded at
initialization (and any later update) and the one getReserveData reports. It
also reads, at the anchor, each such token's code size, totalSupply, POOL()
and UNDERLYING_ASSET_ADDRESS(). Nothing is written anywhere.
"""
import collections, json, sys, time, urllib.request

ANCHOR_HASH = "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8"
URL = "https://rpc.mevblocker.io"
POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
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
            if "error" in reply and "execution reverted" in json.dumps(reply["error"]).lower():
                return {"reverted": reply["error"]}
            print(f"RETRY {method} {reply.get('error')}")
        except Exception as error:  # transport: retry, never an answer
            print(f"RETRY {method} {error}")
        time.sleep(2 ** attempt)
    raise SystemExit(f"NO_ANSWER {method} {params}")


def call(token, selector):
    return rpc("eth_call", [{"to": token, "data": selector}, PIN])


def main(history_path):
    history = json.load(open(history_path))
    events = history["reserve_events"]
    print("EVENT_KINDS", dict(collections.Counter(event["kind"] for event in events)))
    keys = sorted({key for event in events for key in event})
    print("EVENT_KEYS", keys)
    initial = {}
    for event in events:
        if event["kind"] == "RESERVE_INITIALIZED":
            initial[event["asset"].lower()] = (event.get("stable_debt_token") or "").lower()
        elif "stable" in json.dumps(event).lower():
            print("STABLE_EVENT", json.dumps(event, sort_keys=True))
    current = {}
    for asset in sorted(initial):
        data = call(POOL, "0x35ea6a75" + asset[2:].rjust(64, "0"))
        current[asset] = "0x" + data[2 + 64 * 9 + 24: 2 + 64 * 10]
    tokens = sorted(set(initial.values()) | set(current.values()))
    facts = {}
    for token in tokens:
        if not token or int(token, 16) == 0:
            continue
        code = rpc("eth_getCode", [token, PIN])
        facts[token] = {
            "code_bytes": (len(code) - 2) // 2,
            "totalSupply": call(token, "0x18160ddd"),
            "POOL": call(token, "0x7535d246"),
            "UNDERLYING_ASSET_ADDRESS": call(token, "0xb16a19de"),
        }
    same = 0
    for asset in sorted(initial):
        if initial[asset] == current[asset]:
            same += 1
        print(f"RESERVE asset={asset} initialized_stable={initial[asset]} current_stable={current[asset]} "
              f"equal={initial[asset] == current[asset]}")
    print(f"SUMMARY reserves={len(initial)} equal={same} distinct_initialized={len(set(initial.values()))} "
          f"distinct_current={len(set(current.values()))}")
    for token, fact in sorted(facts.items()):
        print("TOKEN", token, json.dumps(fact, sort_keys=True))
    print("PROBE_DONE")


if __name__ == "__main__":
    main(sys.argv[1])
