#!/usr/bin/env python3
"""Source-bound WETH/WETH historical liquidation cost budgets; never NQC P&L.

All four GitHub source archives must be SHA-pinned and internally consistent.
This is a retrospectively selected competitor baseline, not ex-ante execution
proof, a financing commitment, a capture probability or a Census closeout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

from rmc016_two_operator_receipts import load_source
from rmc016_resume_verified_receipts import authenticated_drpc_checkpoint

EVENT_SHA = "6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204"
RECEIPT_SHA = "182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6"
LEGS_SHA = "b5927f49a5099a9fe8971df82f1ea5fa2c4a169b11a846f2f3c2671b1efa71ee"
PRICE_SHA = "5ae6c45b53ded26f327270758c248f7f4ec0ff1365f550e54dcf28feb4a83a03"
WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
TOP_TWO = (
    "0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba",
    "0x3c8757b8e83e098f64d88d0244709c7cdcf50ef67238e24d32357bcb679b5adb",
)
# Only a sensitivity: not a historical flash quote or lender admission.
HYPOTHETICAL_FLASH_BPS = 5
HISTORICAL_EXPECTED = (
    (10684013854557827871, 19694395579376, 96136430295441074),
    (866504893554112580, 216584522059332, 38776135687875734),
)
WEI = 10**18
USD_ORACLE_BASE = 10**8
UINT = re.compile(r"(?:0|[1-9][0-9]*)\Z")
HEX64 = re.compile(r"0x[0-9a-f]{64}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")


def require(value, reason):
    if not value:
        raise ValueError(reason)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def uint(value, label, *, positive=False):
    require(type(value) is str and UINT.fullmatch(value) is not None, label + " must be canonical unsigned decimal")
    n = int(value)
    require(not positive or n > 0, label + " must be positive")
    return n


def unique_json(raw):
    def unique(pairs):
        result = {}
        for k, v in pairs:
            require(k not in result, "duplicate JSON key")
            result[k] = v
        return result
    return json.loads(raw, object_pairs_hook=unique)


def authenticated_zip(path, expected_sha, expected_members):
    raw = path.read_bytes()
    require(len(raw) < 3_000_000 and digest(raw) == expected_sha, "immutable ZIP SHA256 mismatch")
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]
        require(len(names) == len(set(names)) and set(names) == expected_members | {"archive.sha256"},
                "unexpected, missing or duplicate ZIP members")
        for item in infos:
            require(item.filename == Path(item.filename).name, "unsafe ZIP path")
            require((item.external_attr >> 16) & 0o170000 != 0o120000, "ZIP symlink")
            require(item.file_size <= 2_000_000, "ZIP member exceeds limit")
        files = {name: z.read(name) for name in names}
    manifest = files["archive.sha256"].decode("ascii")
    checked = set()
    for line in manifest.splitlines():
        require(re.fullmatch(r"[0-9a-f]{64}  [a-zA-Z0-9._-]+", line) is not None,
                "malformed inner SHA256 record")
        actual, name = line.split("  ")
        require(name in expected_members and name not in checked, "missing or duplicate inner SHA256 record")
        require(actual == digest(files[name]), "inner archive SHA256 manifest drift")
        checked.add(name)
    require(checked == expected_members, "inner SHA256 coverage incomplete")
    return files


def reconcile_legs(original, ids, decoded_blob, legs_report):
    require(decoded_blob.endswith(b"\n"), "decoded legs must terminate in newline")
    require(legs_report.get("status") == "RMC016_SINGLE_OPERATOR_REAL_INTEGER_LIQUIDATION_LEGS_SOURCE_MATCH"
            and legs_report.get("events") == 139
            and legs_report.get("unique_winner_transactions") == 127
            and legs_report.get("event_rows_sha256") == digest(decoded_blob)
            and legs_report.get("nexus_net_profitability_proven") is False,
            "decoded legs report does not authenticate claimed scope")
    seen = set()
    decoded = []
    for raw in decoded_blob.splitlines():
        row = unique_json(raw)
        require(type(row) is dict and canonical(row).rstrip(b"\n") == raw, "noncanonical decoded leg")
        tx = row.get("transaction_hash")
        bh = row.get("block_hash")
        idx = row.get("log_index")
        require(type(tx) is str and HEX64.fullmatch(tx) and tx in original, "unknown transaction in decoded leg")
        require(type(bh) is str and HEX64.fullmatch(bh) and type(idx) is int and idx >= 0,
                "invalid decoded event identity")
        key = (tx, bh, idx)
        require(key not in seen, "duplicate decoded event")
        seen.add(key)
        witness = [e for e in original[tx] if e["block_hash"] == bh and e["log_index"] == idx]
        require(len(witness) == 1, "unmatched decoded event identity")
        src = witness[0]
        require(row.get("original_event_commitment_sha256") == src["event_commitment_sha256"]
                and row.get("block_number") == src["block_number"]
                and row.get("transaction_index") == src["transaction_index"],
                "raw integer amount is not source-event bound")
        for field in ("collateral_asset", "debt_asset"):
            asset = row.get(field)
            require(type(asset) is str and re.fullmatch(r"0x[0-9a-f]{40}", asset),
                    "asset identity malformed")
        uint(row.get("debt_to_cover_raw"), "debt", positive=True)
        uint(row.get("collateral_liquidated_raw"), "collateral", positive=True)
        require(type(row.get("receive_a_token")) is bool, "receiveAToken must be a boolean")
        decoded.append(row)
    require(len(decoded) == 139 and {r["transaction_hash"] for r in decoded} == set(ids),
            "not all 139 real events and 127 winner transactions conserved")
    require(len(seen) == sum(map(len, original.values())), "not all original events decoded")
    return decoded


def signed_usd_wad(wei, oracle_price):
    p = uint(oracle_price, "historical WETH/USD oracle", positive=True)
    return (1 if wei >= 0 else -1) * (abs(wei) * p // USD_ORACLE_BASE)


def calculate(legs, receipts, price_rows):
    require(len(legs) == 139 and len(receipts) == 127, "historical 139/127 corpus not conserved")
    by = {}
    for row in legs:
        tx = row["transaction_hash"]
        require(tx in receipts, "decoded leg has no authenticated winner receipt")
        if row["debt_asset"] == WETH and row["collateral_asset"] == WETH:
            by.setdefault(tx, []).append(row)
    pair_counts = {}
    for leg in legs:
        key = (leg["collateral_asset"], leg["debt_asset"])
        pair_counts[key] = pair_counts.get(key, 0) + 1
    require(len(by) == 9 and sum(map(len, by.values())) == 9,
            "source must contain exactly nine WETH/WETH winner events: observed "
            + str(sum(map(len, by.values()))) + " events / " + str(len(by))
            + " tx; WETH collateral events " +
            str(sum(v for (c, d), v in pair_counts.items() if c == WETH))
            + "; WETH debt events " +
            str(sum(v for (c, d), v in pair_counts.items() if d == WETH))
            + "; observed pair counts " +
            str(sorted(pair_counts.items(), key=lambda p: -p[1])[:12]))
    rows = []
    for tx, group in by.items():
        rec = receipts[tx]
        require(all(x["block_number"] == rec["block_number"]
                    and x["block_hash"] == rec["block_hash"] for x in group),
                "winner receipt/leg block mismatch")
        debt = sum(uint(x["debt_to_cover_raw"], "WETH debt", positive=True) for x in group)
        collateral = sum(uint(x["collateral_liquidated_raw"], "WETH collateral", positive=True) for x in group)
        gas = uint(rec["total_gas_paid_wei"], "historical winner gas", positive=True)
        flash_fee = (debt * HYPOTHETICAL_FLASH_BPS + 9999) // 10000
        # Entire historical winner transaction gas is charged conservatively
        # to this leg, including any other unrelated liquidation in that tx.
        after_gas = collateral - debt - gas
        remaining = after_gas - flash_fee
        rows.append({
            "transaction_hash": tx,
            "block_number": rec["block_number"],
            "block_hash": rec["block_hash"],
            "winner_full_tx_gas_wei": str(gas),
            "historical_weth_debt_raw_wei": str(debt),
            "historical_weth_collateral_raw_wei": str(collateral),
            "collateral_minus_debt_wei": str(collateral - debt),
            "collateral_minus_debt_minus_winner_gas_wei": str(after_gas),
            "hypothetical_5bps_flash_premium_wei_ceil": str(flash_fee),
            "conditional_remaining_before_other_costs_wei": str(remaining),
            "receive_a_token": any(x["receive_a_token"] for x in group),
            "direct_liquid_weth_collateral_unproven": any(x["receive_a_token"] for x in group),
            "historical_competitor_gas_not_nexus_gas": True,
            "fully_executable_by_nexus": False,
            "positive_after_historical_competitor_gas": after_gas > 0,
            "positive_after_hypothetical_5bps": remaining > 0,
        })
    positive_count = sum(r["positive_after_historical_competitor_gas"] for r in rows)
    require(positive_count == 7,
            "historical gross-minus-winner-gas count differs from prior claim: observed="
            + str(positive_count) + " of " + str(len(rows)) +
            " values=" + str([(r["transaction_hash"], r["collateral_minus_debt_minus_winner_gas_wei"],
                             r["receive_a_token"]) for r in rows]))
    rows.sort(key=lambda r: (-int(r["collateral_minus_debt_minus_winner_gas_wei"]),
                             r["transaction_hash"]))
    require(tuple(x["transaction_hash"] for x in rows[:2]) == TOP_TWO,
            "retrospective top-two selection diverged from full seven-event census")
    require(type(price_rows) is list and len(price_rows) == 2, "two-source price reference must contain two rows")
    price_by = {}
    for p in price_rows:
        tx = p.get("transaction_hash")
        require(tx in TOP_TWO and tx not in price_by, "unexpected or duplicate historical priced winner")
        price_by[tx] = p
    require(set(price_by) == set(TOP_TWO), "missing priced winner")
    for i, tx in enumerate(TOP_TWO):
        row = rows[i]
        p = price_by[tx]
        pre = p.get("preblock")
        end = p.get("block_end")
        require(type(pre) is dict and type(end) is dict and
                pre.get("block") == row["block_number"] - 1 and
                end.get("block") == row["block_number"] and
                end.get("hash") == row["block_hash"] and
                p.get("block_number") == row["block_number"] and
                p.get("historical_winner_gas_wei") == row["winner_full_tx_gas_wei"] and
                p.get("two_operator_preblock_oracle_consensus") is True and
                p.get("exact_transaction_prestate_proven") is False,
                "two-provider price not pinned to historical winner receipt")
        for hdr in (pre, end):
            require(type(hdr.get("hash")) is str and HEX64.fullmatch(hdr["hash"]),
                    "invalid price reference block hash")
            uint(hdr.get("oracle_usd_base_1e8"), "price sample", positive=True)
        # Expected raw quantities anchor two retrospectively selected examples
        # independently to the previously source-authenticated sample contract.
        known_debt, known_gas, known_after_gas = HISTORICAL_EXPECTED[i]
        require(int(row["historical_weth_debt_raw_wei"]) == known_debt and
                int(row["winner_full_tx_gas_wei"]) == known_gas and
                int(row["collateral_minus_debt_minus_winner_gas_wei"]) == known_after_gas,
                "known historical WETH/WETH source quantities disagree")
        row["preblock_weth_usd_oracle_1e8"] = pre["oracle_usd_base_1e8"]
        row["preblock_usd_wad_conditional_cost_budget"] = str(signed_usd_wad(
            int(row["conditional_remaining_before_other_costs_wei"]),
            pre["oracle_usd_base_1e8"]))
        row["historical_preblock_price_not_transaction_prestate"] = True
    return rows


def audit(event_zip, receipt_zip, legs_zip, price_zip):
    _, source, ids = load_source(event_zip, EVENT_SHA)
    receipts, checkpoint_events, checkpoint_ids = authenticated_drpc_checkpoint(receipt_zip, event_zip)
    require(source == checkpoint_events and ids == checkpoint_ids,
            "event and receipt source commitments differ")
    data = authenticated_zip(legs_zip, LEGS_SHA,
                             {"decoded-liquidation-legs.jsonl", "decoded-legs-report.json"})
    decoded = reconcile_legs(source, ids, data["decoded-liquidation-legs.jsonl"],
                             unique_json(data["decoded-legs-report.json"]))
    price_data = authenticated_zip(price_zip, PRICE_SHA, {"top-two-weth-prices.json"})
    priced = unique_json(price_data["top-two-weth-prices.json"])
    require(priced.get("status") == "TWO_HISTORICAL_WETH_WINNER_PREBLOCK_ORACLE_PRICES_PASS"
            and priced.get("source_scope") == "TWO_OBSERVED_COMPETITOR_WINNERS_NOT_NEXUS"
            and priced.get("nexus_capture_proven") is False
            and priced.get("nexus_realized_profitability_proven") is False
            and priced.get("real_market_census_closed") is False
            and priced.get("exact_intratransaction_price_proven") is False,
            "two-price source claim/status mismatch")
    records = calculate(decoded, receipts, priced["transactions"])
    selected = records[:2]
    out = {
        "schema_version": 1,
        "status": "RMC016_HISTORICAL_WETH_WETH_COST_BUDGET_DIAGNOSTIC_ONLY",
        "source_archive_sha256": {"event": EVENT_SHA, "receipt": RECEIPT_SHA,
                                  "raw_legs": LEGS_SHA, "preblock_price": PRICE_SHA},
        "historical_winner_transactions": 127,
        "historical_liquidation_events": 139,
        "historical_weth_weth_winner_transactions": 9,
        "historical_weth_weth_positive_after_competitor_gas_transactions": 7,
        "historical_positive_after_hypothetical_5bps_transactions": sum(
            r["positive_after_hypothetical_5bps"] for r in records),
        "all_nine_weth_weth_records": records,
        "retrospective_top_two_transaction_hashes": list(TOP_TWO),
        "conditional_two_winner_reference_usd_wad_sum": str(sum(
            int(r["preblock_usd_wad_conditional_cost_budget"]) for r in selected)),
        "hypothetical_flash_premium_bps": HYPOTHETICAL_FLASH_BPS,
        "hypothetical_flash_premium_is_provider_quote": False,
        "competitor_gas_is_nexus_gas": False,
        "preblock_oracle_is_exact_transaction_prestate": False,
        "external_gas_financing_authenticated": False,
        "external_flash_principal_authenticated": False,
        "real_nexus_execution_or_capture_proven": False,
        "capture_adjusted_or_monthly_net_proven": False,
        "own_capital_usd": "0",
        "real_market_census_closed": False,
        "blocking_reasons": [
            "NO_INDEPENDENT_EXTERNAL_GAS_SPONSOR",
            "NO_BLOCK_PINNED_AUTHORIZED_FLASH_CAPITAL_AND_FEE_QUOTE",
            "NO_NEXUS_PRE_TX_FORK_ROUTE_AND_FULL_COST_REPLAY",
            "NO_EX_ANTE_INCLUSION_OR_CAPTURE_CALIBRATION",
            "NO_OUT_OF_SAMPLE_MONTHLY_NET_EVIDENCE",
        ],
    }
    out["report_sha256"] = digest(canonical(out))
    return out


def main():
    p = argparse.ArgumentParser()
    for name in ("event-zip", "receipt-zip", "legs-zip", "price-zip", "out"):
        p.add_argument("--" + name, required=True, type=Path)
    args = p.parse_args()
    require(not args.out.exists(), "append-only audit output required")
    out = audit(args.event_zip, args.receipt_zip, args.legs_zip, args.price_zip)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(canonical(out))
    print(out["status"], "observed_weth_weth_tx", 9, "positive_after_winner_gas", 7,
          "two_historical_winner_conditional_reference_usd_wad",
          out["conditional_two_winner_reference_usd_wad_sum"],
          "nexus_monthly_net_UNPROVEN")


if __name__ == "__main__":
    main()
