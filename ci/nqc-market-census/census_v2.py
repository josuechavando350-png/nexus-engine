#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ALL_PAIRS_LENGTH = "0x574f2ba3"
ALL_PAIRS = "0x1e3dd18b"
TOKEN0 = "0x0dfe1681"
TOKEN1 = "0xd21220a7"
GET_RESERVES = "0x0902f1ac"
ZERO_ADDRESS = "0x" + "00" * 20


class CensusError(RuntimeError):
    pass


def stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode())


def hex_quantity(value: int) -> str:
    return hex(value)


def decode_uint(result: str) -> int:
    if not isinstance(result, str) or not result.startswith("0x"):
        raise CensusError(f"invalid uint response {result!r}")
    return int(result, 16)


def decode_address(result: str) -> str:
    if not isinstance(result, str) or not result.startswith("0x"):
        raise CensusError(f"invalid address response {result!r}")
    raw = result[2:]
    if len(raw) < 64:
        raise CensusError(f"short address response {result!r}")
    address = "0x" + raw[-40:].lower()
    if len(address) != 42:
        raise CensusError(f"invalid decoded address {address!r}")
    return address


def decode_reserves(result: str) -> tuple[int, int, int]:
    if not isinstance(result, str) or not result.startswith("0x"):
        raise CensusError(f"invalid reserves response {result!r}")
    raw = result[2:]
    if len(raw) < 64 * 3:
        raise CensusError(f"short reserves response length={len(raw)}")
    words = [raw[i:i + 64] for i in range(0, 64 * 3, 64)]
    return int(words[0], 16), int(words[1], 16), int(words[2], 16)


def encode_all_pairs(index: int) -> str:
    return ALL_PAIRS + index.to_bytes(32, "big").hex()


@dataclass(frozen=True)
class Provider:
    provider_id: str
    url: str


class Rpc:
    def __init__(self, provider: Provider, timeout: int, max_attempts: int):
        self.provider = provider
        self.timeout = timeout
        self.max_attempts = max_attempts
        self.next_id = 1
        self.http_requests = 0
        self.rpc_calls = 0

    def _post(self, payload: Any) -> Any:
        body = json.dumps(payload, separators=(",", ":")).encode()
        delay = 1.0
        last_error: Exception | None = None
        for attempt in range(1, self.max_attempts + 1):
            request = urllib.request.Request(
                self.provider.url,
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "nqc-real-market-census-v1",
                },
            )
            try:
                self.http_requests += 1
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return json.loads(response.read())
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt == self.max_attempts:
                    break
                time.sleep(delay)
                delay = min(delay * 2.0, 12.0)
        raise CensusError(
            f"provider={self.provider.provider_id} request failed after {self.max_attempts} attempts: {last_error}"
        )

    def call(self, method: str, params: list[Any]) -> Any:
        request_id = self.next_id
        self.next_id += 1
        self.rpc_calls += 1
        result = self._post({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        })
        if not isinstance(result, dict) or result.get("id") != request_id:
            raise CensusError(f"provider={self.provider.provider_id} malformed RPC response")
        if result.get("error") is not None:
            raise CensusError(
                f"provider={self.provider.provider_id} method={method} RPC error={result['error']}"
            )
        return result.get("result")

    def batch(self, calls: list[tuple[str, list[Any]]]) -> list[dict[str, Any]]:
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
        result = self._post(payload)
        if not isinstance(result, list):
            raise CensusError(f"provider={self.provider.provider_id} batch response is not a list")
        by_id = {item.get("id"): item for item in result if isinstance(item, dict)}
        output = []
        for request_id in ids:
            item = by_id.get(request_id)
            if item is None:
                output.append({"ok": False, "error": "missing response"})
            elif item.get("error") is not None:
                output.append({"ok": False, "error": item.get("error")})
            else:
                output.append({"ok": True, "result": item.get("result")})
        return output


def eth_call(address: str, data: str, block_tag: str) -> tuple[str, list[Any]]:
    return "eth_call", [{"to": address, "data": data}, block_tag]


def get_anchor(rpcs: list[Rpc]) -> dict[str, Any]:
    finalized = []
    for rpc in rpcs:
        block = rpc.call("eth_getBlockByNumber", ["finalized", False])
        if not isinstance(block, dict) or block.get("number") is None:
            raise CensusError(f"provider={rpc.provider.provider_id} cannot serve finalized block")
        finalized.append(int(block["number"], 16))
    number = min(finalized)
    tag = hex_quantity(number)
    observations = []
    for rpc in rpcs:
        block = rpc.call("eth_getBlockByNumber", [tag, False])
        if not isinstance(block, dict):
            raise CensusError(f"provider={rpc.provider.provider_id} missing anchor block")
        observations.append({
            "number": int(block["number"], 16),
            "hash": str(block["hash"]).lower(),
            "parent_hash": str(block["parentHash"]).lower(),
            "timestamp": int(block["timestamp"], 16),
        })
    if len({stable(x) for x in observations}) != 1:
        raise CensusError(f"finalized anchor provider dissent: {observations}")
    return observations[0]


def ensure_anchor_stable(rpcs: list[Rpc], anchor: dict[str, Any]) -> None:
    tag = hex_quantity(anchor["number"])
    for rpc in rpcs:
        block = rpc.call("eth_getBlockByNumber", [tag, False])
        if not isinstance(block, dict):
            raise CensusError(f"provider={rpc.provider.provider_id} anchor disappeared")
        observed = {
            "number": int(block["number"], 16),
            "hash": str(block["hash"]).lower(),
            "parent_hash": str(block["parentHash"]).lower(),
            "timestamp": int(block["timestamp"], 16),
        }
        if observed != anchor:
            raise CensusError(
                f"provider={rpc.provider.provider_id} anchor changed expected={anchor} actual={observed}"
            )


def exact_single_call(rpcs: list[Rpc], method: str, params: list[Any]) -> Any:
    values = [rpc.call(method, params) for rpc in rpcs]
    if len({stable(v) for v in values}) != 1:
        raise CensusError(f"provider dissent method={method} params={params[:1]}")
    return values[0]


def query_pair_chunk(
    rpcs: list[Rpc],
    factory: str,
    indexes: list[int],
    block_tag: str,
) -> list[dict[str, Any]]:
    addresses_by_provider: list[list[dict[str, Any]]] = []
    for rpc in rpcs:
        calls = [eth_call(factory, encode_all_pairs(index), block_tag) for index in indexes]
        addresses_by_provider.append(rpc.batch(calls))

    addresses: list[str | None] = []
    address_errors: list[str | None] = []
    for pos, index in enumerate(indexes):
        decoded = []
        error = None
        for provider_results in addresses_by_provider:
            item = provider_results[pos]
            if not item["ok"]:
                error = f"allPairs error index={index}: {item['error']}"
                break
            try:
                decoded.append(decode_address(item["result"]))
            except Exception as exc:
                error = f"allPairs decode index={index}: {exc}"
                break
        if error is None and len(set(decoded)) != 1:
            raise CensusError(f"allPairs provider dissent index={index} values={decoded}")
        addresses.append(decoded[0] if error is None else None)
        address_errors.append(error)

    valid_positions = [pos for pos, address in enumerate(addresses) if address is not None]
    field_results: list[list[dict[str, Any]]] = []
    for rpc in rpcs:
        calls: list[tuple[str, list[Any]]] = []
        for pos in valid_positions:
            pair = addresses[pos]
            assert pair is not None
            calls.extend([
                ("eth_getCode", [pair, block_tag]),
                eth_call(pair, TOKEN0, block_tag),
                eth_call(pair, TOKEN1, block_tag),
                eth_call(pair, GET_RESERVES, block_tag),
            ])
        field_results.append(rpc.batch(calls))

    records: list[dict[str, Any]] = []
    field_offset = {pos: i * 4 for i, pos in enumerate(valid_positions)}
    for pos, index in enumerate(indexes):
        if addresses[pos] is None:
            records.append({"index": index, "observable": False, "reason": address_errors[pos]})
            continue
        pair = addresses[pos]
        assert pair is not None
        provider_fields = []
        failure = None
        for provider_idx, provider_results in enumerate(field_results):
            base = field_offset[pos]
            items = provider_results[base:base + 4]
            if len(items) != 4 or any(not item["ok"] for item in items):
                failure = (
                    f"field query failure index={index} provider={rpcs[provider_idx].provider.provider_id} "
                    f"errors={[item.get('error') for item in items if not item.get('ok')]}"
                )
                break
            try:
                code_hex = str(items[0]["result"]).lower()
                code_bytes = bytes.fromhex(code_hex[2:]) if code_hex.startswith("0x") else b""
                token0 = decode_address(items[1]["result"])
                token1 = decode_address(items[2]["result"])
                reserve0, reserve1, timestamp_last = decode_reserves(items[3]["result"])
                provider_fields.append({
                    "code_sha256": sha256_bytes(code_bytes),
                    "code_bytes": len(code_bytes),
                    "token0": token0,
                    "token1": token1,
                    "reserve0": str(reserve0),
                    "reserve1": str(reserve1),
                    "block_timestamp_last": timestamp_last,
                })
            except Exception as exc:
                failure = f"field decode failure index={index}: {exc}"
                break
        if failure is not None:
            records.append({"index": index, "market_address": pair, "observable": False, "reason": failure})
            continue
        if len({stable(fields) for fields in provider_fields}) != 1:
            raise CensusError(
                f"pair field provider dissent index={index} pair={pair} fields={provider_fields}"
            )
        records.append({
            "index": index,
            "market_address": pair,
            "observable": True,
            **provider_fields[0],
        })
    return records


def run(args: argparse.Namespace) -> None:
    contract = json.loads(args.contract.read_text())
    if contract.get("stage") != "REAL_MARKET_CENSUS" or contract.get("status") != "NOT_TESTED":
        raise CensusError("unexpected census contract stage/status")
    scope = contract["scope"]
    minimum = int(scope["minimum_counted_markets"])
    target = int(scope["collection_target_markets"])
    if target < minimum or minimum <= 25_000:
        raise CensusError("census target must remain strictly above 25,000 markets")

    providers = []
    for raw in args.provider:
        if "=" not in raw:
            raise CensusError("provider must be id=url")
        provider_id, url = raw.split("=", 1)
        providers.append(Provider(provider_id.strip(), url.strip()))
    if len(providers) != 2 or len({p.provider_id for p in providers}) != 2:
        raise CensusError("exactly two distinct providers are required")
    rpcs = [Rpc(provider, args.timeout, args.max_attempts) for provider in providers]

    args.output.mkdir(parents=True, exist_ok=True)
    anchor = get_anchor(rpcs)
    block_tag = hex_quantity(anchor["number"])

    inventory_path = args.output / "markets.jsonl"
    provider_consensus_hasher = hashlib.sha256()
    market_hasher = hashlib.sha256()
    seen_pairs: set[str] = set()
    counted = 0
    scanned = 0
    zero_reserve = 0
    unobservable = 0
    code_mismatch = 0
    invalid_assets = 0
    factory_summaries = []

    with inventory_path.open("w", encoding="utf8") as inventory:
        for universe in scope["protocol_universes"]:
            factory = universe["factory"].lower()
            reference_pair = universe["certified_reference_pair"].lower()
            fee_bps = int(universe["fee_bps"])
            factory_code = exact_single_call(rpcs, "eth_getCode", [factory, block_tag])
            if not isinstance(factory_code, str) or factory_code in {"0x", "0x0"}:
                raise CensusError(f"factory {factory} has no runtime code at anchor")
            factory_code_sha256 = sha256_bytes(bytes.fromhex(factory_code[2:]))
            reference_code = exact_single_call(rpcs, "eth_getCode", [reference_pair, block_tag])
            if not isinstance(reference_code, str) or reference_code in {"0x", "0x0"}:
                raise CensusError(f"reference pair {reference_pair} has no runtime code")
            reference_code_sha256 = sha256_bytes(bytes.fromhex(reference_code[2:]))
            pair_length_hex = exact_single_call(
                rpcs,
                "eth_call",
                [{"to": factory, "data": ALL_PAIRS_LENGTH}, block_tag],
            )
            pair_length = decode_uint(pair_length_hex)
            if pair_length < minimum:
                raise CensusError(
                    f"factory {factory} allPairsLength={pair_length} below census minimum={minimum}"
                )

            factory_counted_before = counted
            factory_scanned = 0
            for start in range(0, pair_length, args.chunk_size):
                if counted >= target:
                    break
                indexes = list(range(start, min(start + args.chunk_size, pair_length)))
                rows = query_pair_chunk(rpcs, factory, indexes, block_tag)
                for row in rows:
                    scanned += 1
                    factory_scanned += 1
                    if not row.get("observable"):
                        unobservable += 1
                        continue
                    pair = row["market_address"]
                    if pair in seen_pairs:
                        raise CensusError(f"duplicate pair in factory enumeration: {pair}")
                    seen_pairs.add(pair)
                    consensus_tuple = {
                        "factory": factory,
                        "index": row["index"],
                        "pair": pair,
                        "code_sha256": row["code_sha256"],
                        "token0": row["token0"],
                        "token1": row["token1"],
                        "reserve0": row["reserve0"],
                        "reserve1": row["reserve1"],
                        "block_timestamp_last": row["block_timestamp_last"],
                    }
                    provider_consensus_hasher.update((stable(consensus_tuple) + "\n").encode())
                    if row["code_bytes"] <= 0 or row["code_sha256"] != reference_code_sha256:
                        code_mismatch += 1
                        continue
                    if (
                        row["token0"] == ZERO_ADDRESS
                        or row["token1"] == ZERO_ADDRESS
                        or row["token0"] == row["token1"]
                    ):
                        invalid_assets += 1
                        continue
                    if int(row["reserve0"]) == 0 or int(row["reserve1"]) == 0:
                        zero_reserve += 1
                        continue

                    identity_material = {
                        "chain_id": int(scope["chain_id"]),
                        "factory": factory,
                        "factory_index": row["index"],
                        "market_address": pair,
                        "token0": row["token0"],
                        "token1": row["token1"],
                        "fee_bps": fee_bps,
                    }
                    market_id = sha256_text(stable(identity_material))
                    record = {
                        "schema_version": 1,
                        "market_id": market_id,
                        "chain_id": int(scope["chain_id"]),
                        "protocol_semantics": universe["protocol_semantics"],
                        "market_address": pair,
                        "code_identity": {
                            "runtime_code_sha256": row["code_sha256"],
                            "runtime_code_bytes": row["code_bytes"],
                            "canonical_reference_pair": reference_pair,
                            "canonical_reference_runtime_code_sha256": reference_code_sha256,
                            "matches_canonical_reference": True,
                        },
                        "asset_identities": {
                            "token0": row["token0"],
                            "token1": row["token1"],
                            "distinct_nonzero": True,
                        },
                        "canonical_state_anchor": {
                            **anchor,
                            "reserve0": row["reserve0"],
                            "reserve1": row["reserve1"],
                            "pair_block_timestamp_last": row["block_timestamp_last"],
                        },
                        "lifecycle_activity_status": "LIVE_NONZERO_RESERVES",
                        "signal_observability": {
                            "status": "SUPPORTED",
                            "basis": "CANONICAL_PAIR_RUNTIME_PLUS_EXACT_GET_RESERVES_AT_FINALIZED_ANCHOR",
                        },
                        "simulation_support_state": {
                            "status": "SUPPORTED",
                            "basis": "CERTIFIED_UNISWAP_V2_CONSTANT_PRODUCT_30_BPS_ROUTER_SEMANTICS",
                        },
                        "funding_compatibility_state": {
                            "status": "UNCLASSIFIED_AT_CENSUS",
                            "reason": "TOKEN_BEHAVIOR_AND_ROUTE_ECONOMICS_ARE_SHADOW_STAGE_CONCERNS",
                        },
                        "execution_compatibility_state": {
                            "status": "PAIR_RUNTIME_SUPPORTED_TOKEN_BEHAVIOR_UNCLASSIFIED",
                            "reason": "PAIR_CODE_IDENTITY_IS_CERTIFIED; TOKEN_EXECUTION_BEHAVIOR_REMAINS_DOWNSTREAM",
                        },
                        "evidence_provenance": {
                            "factory": factory,
                            "factory_runtime_code_sha256": factory_code_sha256,
                            "factory_index": row["index"],
                            "provider_ids": [p.provider_id for p in providers],
                            "provider_consensus": "EXACT_FIELD_EQUALITY_AT_FINALIZED_ANCHOR",
                        },
                    }
                    serialized = stable(record)
                    inventory.write(serialized + "\n")
                    market_hasher.update((serialized + "\n").encode())
                    counted += 1
                    if counted >= target:
                        break

            factory_summaries.append({
                "id": universe["id"],
                "factory": factory,
                "factory_runtime_code_sha256": factory_code_sha256,
                "all_pairs_length": pair_length,
                "scanned_indexes": factory_scanned,
                "counted_markets": counted - factory_counted_before,
                "reference_pair": reference_pair,
                "reference_pair_runtime_code_sha256": reference_code_sha256,
                "fee_bps": fee_bps,
            })
            if counted >= target:
                break

    ensure_anchor_stable(rpcs, anchor)
    inventory_sha256 = sha256_bytes(inventory_path.read_bytes())
    if inventory_sha256 != market_hasher.hexdigest():
        raise CensusError("inventory streaming digest mismatch")

    status = "PASS" if counted >= minimum else "FAIL"
    summary = {
        "schema_version": 1,
        "stage": "REAL_MARKET_CENSUS",
        "status": status,
        "protocol_fork_prerequisite": contract["prerequisite"],
        "anchor": anchor,
        "providers": [
            {
                "id": rpc.provider.provider_id,
                "url_sha256": sha256_text(rpc.provider.url),
                "http_requests": rpc.http_requests,
                "rpc_calls": rpc.rpc_calls,
            }
            for rpc in rpcs
        ],
        "provider_consensus": "PASS_EXACT_TWO_PROVIDER_FIELD_EQUALITY",
        "provider_consensus_digest_sha256": provider_consensus_hasher.hexdigest(),
        "minimum_counted_markets": minimum,
        "collection_target_markets": target,
        "counted_markets": counted,
        "strictly_above_25000": counted > 25_000,
        "collection_target_met": counted >= target,
        "scanned_factory_indexes": scanned,
        "zero_reserve_markets_rejected": zero_reserve,
        "unobservable_markets_rejected": unobservable,
        "code_identity_mismatches_rejected": code_mismatch,
        "invalid_asset_identity_markets_rejected": invalid_assets,
        "factories": factory_summaries,
        "inventory_file": inventory_path.name,
        "inventory_sha256": inventory_sha256,
        "truth_boundaries": contract["truth_boundaries"],
        "shadow_execution": "NOT_TESTED",
        "live_pnl_evidence": False,
        "production_authority_issued": False,
        "production_certification": "NOT_CERTIFIED",
    }
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    (args.output / "summary.json.sha256").write_text(
        sha256_bytes((args.output / "summary.json").read_bytes()) + "  summary.json\n"
    )
    print(
        "REAL_MARKET_CENSUS_PASS "
        f"anchor={anchor['number']} counted_markets={counted} scanned={scanned} "
        f"inventory_sha256={inventory_sha256}"
        if status == "PASS"
        else "REAL_MARKET_CENSUS_FAIL "
        f"anchor={anchor['number']} counted_markets={counted} minimum={minimum}"
    )
    if status != "PASS":
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--provider", action="append", default=[], required=True)
    parser.add_argument("--chunk-size", type=int, default=100)
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--max-attempts", type=int, default=6)
    args = parser.parse_args()
    if args.chunk_size < 1 or args.chunk_size > 250:
        raise CensusError("chunk-size must be 1..250")
    run(args)


if __name__ == "__main__":
    try:
        main()
    except CensusError as exc:
        print(f"REAL_MARKET_CENSUS_ERROR {exc}", file=sys.stderr)
        raise SystemExit(2)
