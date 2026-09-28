#!/usr/bin/env python3
"""RMC-006 Aave V3 discovery reconciliation.

This adapter deliberately treats JSON-RPC providers as transport. Authority is
the canonical Ethereum state/log history agreed byte-for-byte by independent
providers at one finalized anchor.

Discovery surfaces:
  A. Pool getReservesCount + getReserveAddressById(uint16)
  B. Pool getReservesList()
  C. PoolConfigurator ReserveInitialized/ReserveDropped event history, with the
     configurator address lineage discovered from AddressesProvider
     PoolConfiguratorUpdated events.

PASS requires A == B == event-derived active set and exact cross-provider
agreement on every normalized discovery result. Historical dropped reserves are
preserved rather than silently discarded.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

CHAIN_ID = 1
ZERO_ADDRESS = "0x" + "00" * 20
SCHEMA_VERSION = 1


class DiscoveryError(RuntimeError):
    pass


def stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode())


def normalize_hex(value: str, size: int | None = None) -> str:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise DiscoveryError(f"invalid hex value: {value!r}")
    raw = value[2:].lower()
    if len(raw) % 2:
        raw = "0" + raw
    if any(c not in "0123456789abcdef" for c in raw):
        raise DiscoveryError(f"non-hex value: {value!r}")
    if size is not None and len(raw) != size * 2:
        raise DiscoveryError(f"hex width mismatch expected={size} got={len(raw)//2}")
    return "0x" + raw


def decode_uint(value: str) -> int:
    value = normalize_hex(value)
    return int(value, 16)


def decode_address_word(value: str) -> str:
    value = normalize_hex(value)
    raw = value[2:]
    if len(raw) < 64:
        raise DiscoveryError("short ABI address result")
    return normalize_hex("0x" + raw[-40:], 20)


def decode_address_array(value: str) -> list[str]:
    value = normalize_hex(value)
    raw = value[2:]
    if len(raw) < 128 or len(raw) % 64:
        raise DiscoveryError("malformed ABI dynamic address array")
    words = [raw[i:i + 64] for i in range(0, len(raw), 64)]
    offset = int(words[0], 16)
    if offset % 32:
        raise DiscoveryError("unaligned ABI array offset")
    start = offset // 32
    if start >= len(words):
        raise DiscoveryError("ABI array offset outside result")
    length = int(words[start], 16)
    end = start + 1 + length
    if end > len(words):
        raise DiscoveryError("truncated ABI address array")
    output = []
    for word in words[start + 1:end]:
        if int(word[:24], 16) != 0:
            raise DiscoveryError("non-canonical ABI address padding")
        output.append(normalize_hex("0x" + word[-40:], 20))
    if any(int(word, 16) != 0 for word in words[end:]):
        raise DiscoveryError("unexpected non-zero ABI trailing data")
    return output


def encode_uint16_call(selector: str, value: int) -> str:
    selector = normalize_hex(selector, 4)
    if not 0 <= value <= 0xFFFF:
        raise DiscoveryError("uint16 argument outside range")
    return selector + value.to_bytes(32, "big").hex()


def topic_address(topic: str) -> str:
    topic = normalize_hex(topic, 32)
    return normalize_hex("0x" + topic[-40:], 20)


def code_digest(code: str) -> dict[str, Any]:
    code = normalize_hex(code)
    raw = bytes.fromhex(code[2:])
    return {
        "byte_length": len(raw),
        "sha256": sha256_bytes(raw),
        "present": len(raw) > 0,
    }


@dataclass(frozen=True)
class ProviderSpec:
    provider_id: str
    url: str
    min_interval: float


class Rpc:
    def __init__(self, spec: ProviderSpec, timeout: int, attempts: int):
        self.spec = spec
        self.timeout = timeout
        self.attempts = attempts
        self.next_id = 1
        self.last_request = 0.0
        self.http_requests = 0
        self.rpc_calls = 0

    def _pace(self) -> None:
        wait = self.spec.min_interval - (time.monotonic() - self.last_request)
        if wait > 0:
            time.sleep(wait)
        self.last_request = time.monotonic()

    def _post(self, payload: Any) -> Any:
        body = json.dumps(payload, separators=(",", ":")).encode()
        last: Exception | None = None
        delay = 0.5
        for attempt in range(self.attempts):
            self._pace()
            req = urllib.request.Request(
                self.spec.url,
                data=body,
                method="POST",
                headers={
                    "content-type": "application/json",
                    "user-agent": "nqc-rmc006-aave-discovery-v1",
                },
            )
            try:
                self.http_requests += 1
                with urllib.request.urlopen(req, timeout=self.timeout) as response:
                    return json.loads(response.read())
            except (
                urllib.error.HTTPError,
                urllib.error.URLError,
                TimeoutError,
                OSError,
                json.JSONDecodeError,
            ) as exc:
                last = exc
                if attempt + 1 == self.attempts:
                    break
                time.sleep(delay)
                delay = min(delay * 2.0, 12.0)
        raise DiscoveryError(
            f"provider={self.spec.provider_id} request failed after "
            f"{self.attempts} attempts: {last}"
        )

    def call(self, method: str, params: list[Any]) -> Any:
        request_id = self.next_id
        self.next_id += 1
        self.rpc_calls += 1
        response = self._post({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        })
        if not isinstance(response, dict) or response.get("id") != request_id:
            raise DiscoveryError(
                f"provider={self.spec.provider_id} malformed response for {method}"
            )
        if response.get("error") is not None:
            raise DiscoveryError(
                f"provider={self.spec.provider_id} RPC {method} error={response['error']}"
            )
        return response.get("result")

    def call_batch(self, calls: list[tuple[str, list[Any]]]) -> list[Any]:
        if not calls:
            return []
        payload = []
        ids = []
        for method, params in calls:
            request_id = self.next_id
            self.next_id += 1
            self.rpc_calls += 1
            ids.append(request_id)
            payload.append({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            })
        response = self._post(payload)
        if not isinstance(response, list):
            raise DiscoveryError(
                f"provider={self.spec.provider_id} batch response is not a list"
            )
        by_id = {
            item.get("id"): item
            for item in response
            if isinstance(item, dict)
        }
        output = []
        for request_id in ids:
            item = by_id.get(request_id)
            if item is None or item.get("error") is not None:
                raise DiscoveryError(
                    f"provider={self.spec.provider_id} batch item failed id={request_id}"
                )
            output.append(item.get("result"))
        return output

    def get_logs(
        self,
        address: str,
        topic0: str,
        first: int,
        last: int,
        chunk: int,
    ) -> list[dict[str, Any]]:
        address = normalize_hex(address, 20)
        topic0 = normalize_hex(topic0, 32)
        output: list[dict[str, Any]] = []
        start = first
        current_chunk = max(1, chunk)
        while start <= last:
            stop = min(last, start + current_chunk - 1)
            try:
                result = self.call("eth_getLogs", [{
                    "fromBlock": hex(start),
                    "toBlock": hex(stop),
                    "address": address,
                    "topics": [topic0],
                }])
                if not isinstance(result, list):
                    raise DiscoveryError("eth_getLogs result is not a list")
                output.extend(result)
                start = stop + 1
                if current_chunk < chunk:
                    current_chunk = min(chunk, current_chunk * 2)
            except DiscoveryError:
                if current_chunk == 1:
                    raise
                current_chunk = max(1, current_chunk // 2)
        return output


@dataclass(frozen=True)
class Selectors:
    get_pool: str
    get_pool_configurator: str
    addresses_provider: str
    reserves_count: str
    reserve_by_id: str
    reserves_list: str
    pool_configurator_updated_topic: str
    reserve_initialized_topic: str
    reserve_dropped_topic: str

    def normalized(self) -> "Selectors":
        return Selectors(
            get_pool=normalize_hex(self.get_pool, 4),
            get_pool_configurator=normalize_hex(self.get_pool_configurator, 4),
            addresses_provider=normalize_hex(self.addresses_provider, 4),
            reserves_count=normalize_hex(self.reserves_count, 4),
            reserve_by_id=normalize_hex(self.reserve_by_id, 4),
            reserves_list=normalize_hex(self.reserves_list, 4),
            pool_configurator_updated_topic=normalize_hex(
                self.pool_configurator_updated_topic, 32
            ),
            reserve_initialized_topic=normalize_hex(
                self.reserve_initialized_topic, 32
            ),
            reserve_dropped_topic=normalize_hex(self.reserve_dropped_topic, 32),
        )


def exact_anchor(rpcs: list[Rpc]) -> dict[str, Any]:
    finalized_heights = []
    for rpc in rpcs:
        if decode_uint(rpc.call("eth_chainId", [])) != CHAIN_ID:
            raise DiscoveryError(f"provider={rpc.spec.provider_id} wrong chain")
        block = rpc.call("eth_getBlockByNumber", ["finalized", False])
        if not isinstance(block, dict):
            raise DiscoveryError(f"provider={rpc.spec.provider_id} no finalized block")
        finalized_heights.append(decode_uint(block["number"]))
    height = min(finalized_heights)
    normalized = []
    for rpc in rpcs:
        block = rpc.call("eth_getBlockByNumber", [hex(height), False])
        if not isinstance(block, dict):
            raise DiscoveryError(f"provider={rpc.spec.provider_id} missing anchor")
        normalized.append({
            "number": decode_uint(block["number"]),
            "hash": normalize_hex(block["hash"], 32),
            "parent_hash": normalize_hex(block["parentHash"], 32),
            "timestamp": decode_uint(block["timestamp"]),
            "state_root": normalize_hex(block["stateRoot"], 32),
        })
    if len({stable(item) for item in normalized}) != 1:
        raise DiscoveryError(f"canonical anchor dissent: {normalized}")
    return normalized[0]


def state_ref(anchor: dict[str, Any]) -> dict[str, Any]:
    return {
        "blockHash": anchor["hash"],
        "requireCanonical": True,
    }


def eth_call(rpc: Rpc, to: str, data: str, anchor: dict[str, Any]) -> str:
    result = rpc.call(
        "eth_call",
        [{"to": normalize_hex(to, 20), "data": normalize_hex(data)}, state_ref(anchor)],
    )
    return normalize_hex(result)


def code_at(rpc: Rpc, address: str, anchor: dict[str, Any]) -> str:
    return normalize_hex(
        rpc.call("eth_getCode", [normalize_hex(address, 20), state_ref(anchor)])
    )


def first_code_block(rpc: Rpc, address: str, last: int) -> int:
    address = normalize_hex(address, 20)
    if normalize_hex(rpc.call("eth_getCode", [address, hex(last)])) in ("0x", "0x00"):
        raise DiscoveryError(f"no code for {address} at block {last}")
    lo, hi = 0, last
    while lo < hi:
        mid = (lo + hi) // 2
        code = normalize_hex(rpc.call("eth_getCode", [address, hex(mid)]))
        if code in ("0x", "0x00"):
            lo = mid + 1
        else:
            hi = mid
    return lo


def normalize_log(log: dict[str, Any]) -> dict[str, Any]:
    topics = log.get("topics")
    if not isinstance(topics, list):
        raise DiscoveryError("log topics missing")
    return {
        "address": normalize_hex(log["address"], 20),
        "block_number": decode_uint(log["blockNumber"]),
        "block_hash": normalize_hex(log["blockHash"], 32),
        "transaction_hash": normalize_hex(log["transactionHash"], 32),
        "transaction_index": decode_uint(log["transactionIndex"]),
        "log_index": decode_uint(log["logIndex"]),
        "topics": [normalize_hex(topic, 32) for topic in topics],
        "data": normalize_hex(log["data"]),
        "removed": bool(log.get("removed", False)),
    }


def log_order(log: dict[str, Any]) -> tuple[int, int, int]:
    return (
        log["block_number"],
        log["transaction_index"],
        log["log_index"],
    )


def configurator_lineage(
    rpc: Rpc,
    addresses_provider: str,
    current_configurator: str,
    provider_creation: int,
    anchor: dict[str, Any],
    selectors: Selectors,
    log_chunk: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    logs = [
        normalize_log(log)
        for log in rpc.get_logs(
            addresses_provider,
            selectors.pool_configurator_updated_topic,
            provider_creation,
            anchor["number"],
            log_chunk,
        )
    ]
    logs.sort(key=log_order)
    configurators = set()
    updates = []
    for log in logs:
        if log["removed"]:
            raise DiscoveryError("removed configurator update log in canonical scan")
        if len(log["topics"]) != 3:
            raise DiscoveryError("PoolConfiguratorUpdated topic cardinality mismatch")
        old_address = topic_address(log["topics"][1])
        new_address = topic_address(log["topics"][2])
        if old_address != ZERO_ADDRESS:
            configurators.add(old_address)
        if new_address == ZERO_ADDRESS:
            raise DiscoveryError("PoolConfiguratorUpdated produced zero new address")
        configurators.add(new_address)
        updates.append({
            "block_number": log["block_number"],
            "block_hash": log["block_hash"],
            "transaction_hash": log["transaction_hash"],
            "log_index": log["log_index"],
            "old": old_address,
            "new": new_address,
        })
    configurators.add(current_configurator)
    return updates, sorted(configurators)


def reserve_event_history(
    rpc: Rpc,
    configurators: Iterable[str],
    provider_creation: int,
    anchor: dict[str, Any],
    selectors: Selectors,
    log_chunk: int,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    events = []
    for configurator in sorted(set(configurators)):
        for kind, topic in (
            ("INITIALIZED", selectors.reserve_initialized_topic),
            ("DROPPED", selectors.reserve_dropped_topic),
        ):
            for raw in rpc.get_logs(
                configurator,
                topic,
                provider_creation,
                anchor["number"],
                log_chunk,
            ):
                log = normalize_log(raw)
                if log["removed"]:
                    raise DiscoveryError("removed reserve event in canonical scan")
                if len(log["topics"]) < 2:
                    raise DiscoveryError("reserve event missing indexed asset")
                events.append({
                    "kind": kind,
                    "asset": topic_address(log["topics"][1]),
                    "configurator": configurator,
                    "block_number": log["block_number"],
                    "block_hash": log["block_hash"],
                    "transaction_hash": log["transaction_hash"],
                    "transaction_index": log["transaction_index"],
                    "log_index": log["log_index"],
                })
    events.sort(
        key=lambda event: (
            event["block_number"],
            event["transaction_index"],
            event["log_index"],
            event["kind"],
        )
    )
    state: dict[str, str] = {}
    for event in events:
        asset = event["asset"]
        if asset == ZERO_ADDRESS:
            raise DiscoveryError("zero reserve asset in event history")
        state[asset] = "ACTIVE" if event["kind"] == "INITIALIZED" else "DROPPED"
    return events, state


def pool_enumeration(
    rpc: Rpc,
    pool: str,
    anchor: dict[str, Any],
    selectors: Selectors,
) -> dict[str, Any]:
    count = decode_uint(eth_call(rpc, pool, selectors.reserves_count, anchor))
    if count > 65535:
        raise DiscoveryError(f"reserve count exceeds uint16: {count}")
    calls = [
        (
            "eth_call",
            [
                {
                    "to": pool,
                    "data": encode_uint16_call(selectors.reserve_by_id, index),
                },
                state_ref(anchor),
            ],
        )
        for index in range(count)
    ]
    by_id_raw = rpc.call_batch(calls)
    by_id = [decode_address_word(value) for value in by_id_raw]
    nonzero_by_id = [address for address in by_id if address != ZERO_ADDRESS]
    if len(nonzero_by_id) != len(set(nonzero_by_id)):
        raise DiscoveryError("duplicate nonzero reserve in id enumeration")

    reserves_list = decode_address_array(
        eth_call(rpc, pool, selectors.reserves_list, anchor)
    )
    if len(reserves_list) != len(set(reserves_list)):
        raise DiscoveryError("duplicate reserve in getReservesList")
    if ZERO_ADDRESS in reserves_list:
        raise DiscoveryError("zero reserve in getReservesList")
    return {
        "reserves_count": count,
        "by_id": by_id,
        "active_by_id": sorted(nonzero_by_id),
        "reserves_list": sorted(reserves_list),
    }


def scan_provider(
    rpc: Rpc,
    addresses_provider: str,
    expected_pool: str,
    anchor: dict[str, Any],
    selectors: Selectors,
    log_chunk: int,
) -> dict[str, Any]:
    addresses_provider = normalize_hex(addresses_provider, 20)
    expected_pool = normalize_hex(expected_pool, 20)

    pool = decode_address_word(
        eth_call(rpc, addresses_provider, selectors.get_pool, anchor)
    )
    configurator = decode_address_word(
        eth_call(rpc, addresses_provider, selectors.get_pool_configurator, anchor)
    )
    if pool != expected_pool:
        raise DiscoveryError(
            f"provider={rpc.spec.provider_id} pool mismatch expected={expected_pool} got={pool}"
        )

    pool_provider = decode_address_word(
        eth_call(rpc, pool, selectors.addresses_provider, anchor)
    )
    if pool_provider != addresses_provider:
        raise DiscoveryError(
            f"provider={rpc.spec.provider_id} ADDRESSES_PROVIDER mismatch"
        )

    provider_creation = first_code_block(
        rpc, addresses_provider, anchor["number"]
    )
    configurator_updates, configurators = configurator_lineage(
        rpc,
        addresses_provider,
        configurator,
        provider_creation,
        anchor,
        selectors,
        log_chunk,
    )
    events, event_state = reserve_event_history(
        rpc,
        configurators,
        provider_creation,
        anchor,
        selectors,
        log_chunk,
    )
    enumeration = pool_enumeration(rpc, pool, anchor, selectors)

    event_active = sorted(
        asset for asset, state in event_state.items() if state == "ACTIVE"
    )
    historical_dropped = sorted(
        asset for asset, state in event_state.items() if state == "DROPPED"
    )

    getter_a = set(enumeration["active_by_id"])
    getter_b = set(enumeration["reserves_list"])
    event_set = set(event_active)
    mismatches = []
    if getter_a != getter_b:
        mismatches.append({
            "class": "POOL_ENUMERATION_DISSENT",
            "count_id_only": sorted(getter_a - getter_b),
            "list_only": sorted(getter_b - getter_a),
        })
    if getter_a != event_set:
        mismatches.append({
            "class": "EVENT_GETTER_DISSENT",
            "getter_only": sorted(getter_a - event_set),
            "event_active_only": sorted(event_set - getter_a),
        })

    result = {
        "schema_version": SCHEMA_VERSION,
        "chain_id": CHAIN_ID,
        "anchor": anchor,
        "addresses_provider": addresses_provider,
        "addresses_provider_creation_block": provider_creation,
        "pool": pool,
        "configurator_at_anchor": configurator,
        "configurator_updates": configurator_updates,
        "configurators_observed": configurators,
        "code": {
            "addresses_provider": code_digest(code_at(rpc, addresses_provider, anchor)),
            "pool": code_digest(code_at(rpc, pool, anchor)),
            "configurator_at_anchor": code_digest(code_at(rpc, configurator, anchor)),
        },
        "pool_enumeration": enumeration,
        "reserve_events": events,
        "event_state": [
            {"asset": asset, "state": event_state[asset]}
            for asset in sorted(event_state)
        ],
        "event_active": event_active,
        "historical_dropped": historical_dropped,
        "reconciliation": {
            "source_a_count_id": len(getter_a),
            "source_b_reserves_list": len(getter_b),
            "source_c_event_active": len(event_set),
            "union_count": len(getter_a | getter_b | event_set),
            "intersection_count": len(getter_a & getter_b & event_set),
            "unexplained_delta_count": len(mismatches),
            "mismatches": mismatches,
        },
    }
    for label, code in result["code"].items():
        if not code["present"]:
            raise DiscoveryError(f"provider={rpc.spec.provider_id} missing code for {label}")
    return result


def parse_provider(value: str) -> ProviderSpec:
    pieces = value.split("=", 1)
    if len(pieces) != 2:
        raise DiscoveryError("--provider must be id=url")
    provider_id, url = pieces
    if not provider_id or not url:
        raise DiscoveryError("empty provider id/url")
    return ProviderSpec(provider_id, url, 0.0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--addresses-provider", required=True)
    parser.add_argument("--expected-pool", required=True)
    parser.add_argument("--provider", action="append", required=True)
    parser.add_argument("--provider-min-interval", action="append", default=[])
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--attempts", type=int, default=8)
    parser.add_argument("--log-chunk", type=int, default=250_000)

    for name in (
        "get_pool",
        "get_pool_configurator",
        "addresses_provider",
        "reserves_count",
        "reserve_by_id",
        "reserves_list",
        "pool_configurator_updated_topic",
        "reserve_initialized_topic",
        "reserve_dropped_topic",
    ):
        parser.add_argument("--" + name.replace("_", "-"), required=True)

    args = parser.parse_args()
    specs = [parse_provider(value) for value in args.provider]
    intervals = {}
    for item in args.provider_min_interval:
        provider_id, sep, raw = item.partition("=")
        if not sep:
            raise DiscoveryError("--provider-min-interval must be id=seconds")
        intervals[provider_id] = float(raw)
    specs = [
        ProviderSpec(spec.provider_id, spec.url, intervals.get(spec.provider_id, 0.0))
        for spec in specs
    ]
    if len(specs) < 2 or len({spec.provider_id for spec in specs}) != len(specs):
        raise DiscoveryError("at least two uniquely named providers are required")

    selectors = Selectors(
        get_pool=args.get_pool,
        get_pool_configurator=args.get_pool_configurator,
        addresses_provider=args.addresses_provider,
        reserves_count=args.reserves_count,
        reserve_by_id=args.reserve_by_id,
        reserves_list=args.reserves_list,
        pool_configurator_updated_topic=args.pool_configurator_updated_topic,
        reserve_initialized_topic=args.reserve_initialized_topic,
        reserve_dropped_topic=args.reserve_dropped_topic,
    ).normalized()

    rpcs = [Rpc(spec, args.timeout, args.attempts) for spec in specs]
    anchor = exact_anchor(rpcs)
    results = {}
    for rpc in rpcs:
        results[rpc.spec.provider_id] = scan_provider(
            rpc,
            args.addresses_provider,
            args.expected_pool,
            anchor,
            selectors,
            args.log_chunk,
        )

    normalized = [stable(results[spec.provider_id]) for spec in specs]
    if len(set(normalized)) != 1:
        raise DiscoveryError("cross-provider normalized discovery dissent")
    canonical = results[specs[0].provider_id]
    if canonical["reconciliation"]["unexplained_delta_count"] != 0:
        raise DiscoveryError(
            f"unexplained discovery deltas: {canonical['reconciliation']['mismatches']}"
        )

    args.out.mkdir(parents=True, exist_ok=True)
    for spec in specs:
        path = args.out / f"provider-{spec.provider_id}.json"
        path.write_text(json.dumps(results[spec.provider_id], indent=2, sort_keys=True) + "\n")

    markets = []
    lifecycle = {row["asset"]: row["state"] for row in canonical["event_state"]}
    for asset in sorted(lifecycle):
        markets.append({
            "chain_id": CHAIN_ID,
            "protocol_family": "AAVE_V3",
            "addresses_provider": canonical["addresses_provider"],
            "pool": canonical["pool"],
            "asset": asset,
            "lifecycle": lifecycle[asset],
            "active_at_anchor": asset in set(canonical["event_active"]),
            "anchor": canonical["anchor"],
            "evidence_kind": "TWO_PROVIDER_GETTER_EVENT_RECONCILIATION",
        })
    with (args.out / "markets.ndjson").open("w") as handle:
        for row in markets:
            handle.write(stable(row) + "\n")

    summary = {
        "schema_version": SCHEMA_VERSION,
        "gate": "RMC_006_AAVE_DISCOVERY_RECONCILIATION",
        "status": "PASS",
        "chain_id": CHAIN_ID,
        "anchor": canonical["anchor"],
        "provider_ids": [spec.provider_id for spec in specs],
        "addresses_provider": canonical["addresses_provider"],
        "pool": canonical["pool"],
        "configurator_at_anchor": canonical["configurator_at_anchor"],
        "addresses_provider_creation_block": canonical["addresses_provider_creation_block"],
        "current_active_reserves": canonical["event_active"],
        "historical_dropped_reserves": canonical["historical_dropped"],
        "current_active_count": len(canonical["event_active"]),
        "historical_market_count": len(markets),
        "reconciliation": canonical["reconciliation"],
        "provider_result_sha256": sha256_text(stable(canonical)),
        "market_records_sha256": sha256_bytes((args.out / "markets.ndjson").read_bytes()),
        "truth_boundaries": {
            "global_aave_deployment_completeness": "NOT_PROVEN",
            "other_aave_deployments": "OUT_OF_SCOPE",
            "borrower_census": "NOT_TESTED",
            "economic_activity": "NOT_TESTED",
            "capital": "NOT_TESTED",
            "pnl": "NOT_TESTED",
            "shadow": "NOT_TESTED",
            "canary": "NOT_TESTED",
            "production": "NOT_CERTIFIED",
        },
        "rpc_usage": {
            rpc.spec.provider_id: {
                "http_requests": rpc.http_requests,
                "rpc_calls": rpc.rpc_calls,
            }
            for rpc in rpcs
        },
    }
    (args.out / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n"
    )

    mismatch = {
        "schema_version": SCHEMA_VERSION,
        "open_unexplained": canonical["reconciliation"]["mismatches"],
        "open_unexplained_count": canonical["reconciliation"]["unexplained_delta_count"],
    }
    (args.out / "mismatch-ledger.json").write_text(
        json.dumps(mismatch, indent=2, sort_keys=True) + "\n"
    )

    sums = []
    for path in sorted(args.out.iterdir()):
        if path.is_file() and path.name != "SHA256SUMS":
            sums.append(f"{sha256_bytes(path.read_bytes())}  {path.name}")
    (args.out / "SHA256SUMS").write_text("\n".join(sums) + "\n")

    print(
        "RMC_006_AAVE_DISCOVERY_PASS "
        f"anchor={anchor['number']} active={summary['current_active_count']} "
        f"historical={summary['historical_market_count']} "
        f"providers={len(specs)}"
    )


if __name__ == "__main__":
    try:
        main()
    except DiscoveryError as exc:
        print(f"RMC_006_AAVE_DISCOVERY_FAIL {exc}", file=os.sys.stderr)
        raise SystemExit(1)
