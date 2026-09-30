#!/usr/bin/env python3
"""Read-only probe of RMC-009 index partition 3 on tenderly-public.

Rebuilds the exact RMC-009 account-index filter from the certified D06
history (every RESERVE_INITIALIZED aToken and variable debt token), the same
200,000-block job grid and partition 3 of 4. Then it sends the exact
eth_getLogs request shape of nqc-census-chain (fromBlock/toBlock quantities,
the sorted address list, topics [[Mint, BalanceTransfer]]) in 5,000-block
windows. Every refused window is kept with its full JSON-RPC error. The
refused window is bisected on tenderly, and its logs are counted on
mevblocker-rpc in 2,500-block windows. Nothing is written anywhere.
"""
import json, sys, time, urllib.error, urllib.request

ANCHOR = 25437474
JOB_SPAN, PARTITIONS, PARTITION = 200_000, 4, 3
TENDERLY = "https://gateway.tenderly.co/public/mainnet"
MEVBLOCKER = "https://rpc.mevblocker.io"
MINT = "0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196"
BALANCE_TRANSFER = "0x4beccb90f994c31aced7a23b5611020728a23d8ec5cddd1a3e9d97b96fda8666"


def post(url, body):
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "content-type": "application/json", "accept": "application/json",
        "user-agent": "nqc-census-chain/1"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def logs(url, addresses, first, last, interval):
    params = [{"fromBlock": hex(first), "toBlock": hex(last), "address": addresses,
               "topics": [[MINT, BALANCE_TRANSFER]]}]
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs", "params": params},
                      separators=(",", ":")).encode()
    for attempt in range(6):
        time.sleep(interval)
        try:
            status, raw = post(url, body)
        except Exception as error:  # transport: retry, never an answer
            print(f"transport {first}-{last}: {error}")
            time.sleep(2 ** attempt)
            continue
        try:
            reply = json.loads(raw)
        except ValueError:
            reply = None
        text = raw[:400].decode(errors="replace")
        if reply is None or status in (429, 502, 503, 504) or (
                reply.get("error") and any(w in json.dumps(reply["error"]).lower()
                                           for w in ("rate", "too many requests", "timeout"))):
            print(f"transient {first}-{last} status={status} {text}")
            time.sleep(2 ** attempt)
            continue
        return status, reply, len(body)
    raise SystemExit(f"no answer for {first}-{last}")


def main(history_path):
    report = json.load(open(history_path))
    tokens, first_block = set(), None
    for event in report["reserve_events"]:
        if event["kind"] != "RESERVE_INITIALIZED":
            continue
        tokens.add(event["a_token"].lower())
        tokens.add(event["variable_debt_token"].lower())
        first_block = event["block"] if first_block is None else min(first_block, event["block"])
    addresses = sorted(tokens)
    jobs = []
    start = first_block
    while start <= ANCHOR:
        end = min(start + JOB_SPAN - 1, ANCHOR)
        jobs.append((start, end))
        start = end + 1
    size = -(-len(jobs) // PARTITIONS)
    part = jobs[PARTITION * size:min(PARTITION * size + size, len(jobs))]
    print(f"PROBE addresses={len(addresses)} first_block={first_block} jobs={len(jobs)} "
          f"partition3_jobs={len(part)} range={part[0][0]}-{part[-1][1]}")
    refused = []
    for job_first, job_last in part:
        for first in range(job_first, job_last + 1, 5000):
            last = min(first + 4999, job_last)
            status, reply, request_bytes = logs(TENDERLY, addresses, first, last, 0.3)
            if "error" in reply:
                print(f"TENDERLY_REFUSED {first}-{last} status={status} request_bytes={request_bytes} "
                      f"error={json.dumps(reply['error'])}")
                refused.append((first, last, reply["error"]))
            else:
                print(f"tenderly {first}-{last} logs={len(reply['result'])}")
    print(f"PROBE_TENDERLY_REFUSED windows={len(refused)}")
    for first, last, error in refused[:6]:
        count = 0
        for sub in range(first, last + 1, 2500):
            sub_last = min(sub + 2499, last)
            status, reply, _ = logs(MEVBLOCKER, addresses, sub, sub_last, 1.3)
            if "error" in reply:
                print(f"MEVBLOCKER_REFUSED {sub}-{sub_last} {json.dumps(reply['error'])}")
                count = None
                break
            count += len(reply["result"])
        print(f"REFUSED_WINDOW {first}-{last} mevblocker_logs={count}")
        for span in (2500, 1250, 625):
            answered, worst = 0, None
            for sub in range(first, last + 1, span):
                sub_last = min(sub + span - 1, last)
                status, reply, _ = logs(TENDERLY, addresses, sub, sub_last, 0.3)
                if "error" in reply:
                    worst = reply["error"]
                else:
                    answered += 1
            print(f"TENDERLY_SPAN window={first}-{last} span={span} "
                  f"answered_all={worst is None} refusal={json.dumps(worst)}")
            if worst is None:
                break


if __name__ == "__main__":
    main(sys.argv[1])
