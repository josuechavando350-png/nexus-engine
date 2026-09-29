#!/usr/bin/env python3
"""Fourth read-only probe: search for additional archive log providers.

Design evidence only.
"""

import json
import sys
import time
import urllib.error
import urllib.request

CANDIDATES = [
    ("subquery", "https://ethereum.rpc.subquery.network/public"),
    ("tenderly", "https://gateway.tenderly.co/public/mainnet"),
    ("onfinality", "https://eth.api.onfinality.io/public"),
    ("gatewayfm", "https://rpc.eth.gateway.fm"),
    ("meowrpc", "https://eth.meowrpc.com"),
    ("omniatech", "https://endpoints.omniatech.io/v1/eth/mainnet/public"),
    ("lava", "https://eth1.lava.build"),
    ("blockrazor", "https://eth.blockrazor.xyz"),
    ("payload", "https://rpc.payload.de"),
    ("stackup", "https://public.stackup.sh/api/v1/node/ethereum-mainnet"),
    ("securerpc", "https://api.securerpc.com/v1"),
    ("cloudflare", "https://cloudflare-eth.com"),
    ("pokt", "https://eth-pokt.nodies.app"),
    ("zan", "https://api.zan.top/eth-mainnet"),
    ("unifra", "https://eth-mainnet-public.unifra.io"),
    ("builder0x69", "https://rpc.builder0x69.io"),
    ("titan", "https://rpc.titanbuilder.xyz"),
    ("lokibuilder", "https://rpc.lokibuilder.xyz/wallet"),
    ("eth-public-rpc", "https://eth.public-rpc.com"),
    ("allthatnode", "https://ethereum-mainnet.g.allthatnode.com/full/evm"),
]
CONFIGURATOR = "0x64b761d848206f447fe2dd461b0c635ec39ebb27"
PROVIDER = "0x2f39d218133afab8f2b819b1066c7e434ad94e9e"


def post(url, payload, timeout=60):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json",
                                                         "user-agent": "nqc-census-capability-probe/4"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read()), round(time.monotonic() - started, 2)
    except urllib.error.HTTPError as exc:
        return {"http_error": exc.code, "body": exc.read()[:200].decode("utf-8", "replace")}, None
    except Exception as exc:  # noqa: BLE001
        return {"transport_error": repr(exc)[:200]}, None


def call(url, method, params, timeout=60):
    reply, elapsed = post(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout)
    if isinstance(reply, dict) and "result" in reply:
        return reply["result"], None, elapsed
    return None, reply, elapsed


def main():
    for name, url in CANDIDATES:
        version, error, _ = call(url, "web3_clientVersion", [])
        chain, _, _ = call(url, "eth_chainId", [])
        record = {"provider": name, "url": url, "client": version, "chain": chain,
                  "error": None if chain else error}
        if chain == "0x1":
            code, cerr, _ = call(url, "eth_getCode", [PROVIDER, hex(16_300_000)])
            record["archive_code_2023"] = None if code is None else (len(code) - 2) // 2
            record["archive_error"] = cerr if code is None else None
            for span in (1_000, 100_000, 1_000_000, 9_200_000):
                logs, lerr, elapsed = call(url, "eth_getLogs", [{"address": [PROVIDER, CONFIGURATOR],
                                                                  "fromBlock": hex(16_291_000),
                                                                  "toBlock": hex(16_291_000 + span - 1)}], 120)
                record[f"logs_{span}"] = len(logs) if logs is not None else {"error": lerr}
                record[f"logs_{span}_elapsed"] = elapsed
                if logs is None:
                    break
        print(json.dumps({"probe": "candidate", **record}, sort_keys=True), flush=True)
    print("CHAIN_CAPABILITY_PROBE_V4_DONE", flush=True)


if __name__ == "__main__":
    main()
