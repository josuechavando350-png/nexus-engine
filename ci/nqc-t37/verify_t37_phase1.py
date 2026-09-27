#!/usr/bin/env python3
import argparse
import csv
import hashlib
import json
from pathlib import Path

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def stable(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()

def digest(domain: str, *parts) -> str:
    h = hashlib.sha256()
    h.update(domain.encode())
    h.update(b"\x00")
    for part in parts:
        h.update(str(part).encode())
        h.update(b"\x00")
    return h.hexdigest()

def load_metrics(run_dir: Path):
    return json.loads((run_dir / "metrics.json").read_text())

def verify_metrics(m):
    assert m["scope"] == "SYNTHETIC_T37_SCALE_ARCHITECTURE_ONLY"
    assert m["markets"] >= 50_000
    assert m["synthetic_active_markets"] >= 25_000
    assert m["surfaces"] >= 250_000
    assert m["signals"] >= 1_000_000
    assert m["observed_markets"] == m["markets"]
    assert m["observed_cold_markets"] == m["cold_markets"]
    assert m["max_fanout"] <= 24
    assert m["full_market_scans"] == 0
    assert m["dropped_signals"] == 0
    assert m["authority_issuance"] == 0
    assert m["reorg_events"] > 0
    assert m["reorg_invalidated_pending"] > 0
    assert m["bundles_written"] >= 25_000
    assert m["real_market_evidence"] is False
    assert m["live_pnl_evidence"] is False
    assert m["production_certification"] == "NOT_CERTIFIED"
    naive_scan_ops = m["markets"] * m["signals"]
    assert m["total_fanout"] < naive_scan_ops // 1000
    return naive_scan_ops

def emit_bundles(run_dir: Path, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    records_path = run_dir / "execution-records.tsv"
    bundle_path = out_dir / "execution-evidence-bundles.ndjson"
    count = 0
    with records_path.open(newline="") as src, bundle_path.open("w") as dst:
        reader = csv.DictReader(src, delimiter="\t")
        for row in reader:
            seq = int(row["execution_seq"])
            market_id = int(row["market_id"])
            signal_id = int(row["signal_id"])
            generation = int(row["canonical_generation"])
            shard = int(row["shard"])
            included = row["canonical_included"] == "1"
            synthetic_net_units = int(row["synthetic_net_units"])

            signal_hash = digest("NQC_T37_SIGNAL_V1", signal_id, generation)
            market_identity_hash = digest("NQC_T37_SYNTHETIC_MARKET_V1", market_id)
            candidate_hash = digest(
                "NQC_T37_CANDIDATE_V1",
                signal_hash,
                market_identity_hash,
                generation,
                shard,
            )
            exact_sim_hash = digest(
                "NQC_T37_EXACT_SIM_MODEL_V1",
                candidate_hash,
                row["sim_digest_seed"],
            )
            funding_plan_hash = digest(
                "NQC_T37_FUNDING_PLAN_MODEL_V1",
                exact_sim_hash,
                row["funding_digest_seed"],
            )
            execution_identity_hash = digest(
                "NQC_T37_EXECUTION_IDENTITY_V1",
                candidate_hash,
                funding_plan_hash,
                generation,
            )
            action_hash = digest(
                "NQC_T37_ACTION_V1",
                execution_identity_hash,
                row["action_digest_seed"],
            )
            durable_wal_hash = digest(
                "NQC_T37_DURABLE_WAL_V1",
                action_hash,
                seq,
            )
            canonical_outcome_hash = digest(
                "NQC_T37_CANONICAL_OUTCOME_MODEL_V1",
                execution_identity_hash,
                int(included),
                generation,
            )
            economics_hash = digest(
                "NQC_T37_SYNTHETIC_ECONOMICS_V1",
                canonical_outcome_hash,
                synthetic_net_units,
            )

            bundle = {
                "schema_version": 1,
                "scope": "SYNTHETIC_T37_SCALE_ARCHITECTURE_ONLY",
                "execution_seq": seq,
                "execution_identity_sha256": execution_identity_hash,
                "signal_sha256": signal_hash,
                "synthetic_market_identity_sha256": market_identity_hash,
                "candidate_sha256": candidate_hash,
                "exact_sim_model_sha256": exact_sim_hash,
                "funding_plan_model_sha256": funding_plan_hash,
                "action_sha256": action_hash,
                "durable_wal_sha256": durable_wal_hash,
                "canonical_outcome_model_sha256": canonical_outcome_hash,
                "synthetic_economics_sha256": economics_hash,
                "canonical_generation": generation,
                "shard": shard,
                "canonical_included_model": included,
                "synthetic_net_units": synthetic_net_units,
                "authority_issued": False,
                "real_market_evidence": False,
                "live_pnl_evidence": False,
            }
            bundle["bundle_sha256"] = sha256_bytes(stable(bundle))
            dst.write(json.dumps(bundle, sort_keys=True, separators=(",", ":")) + "\n")
            count += 1
    return bundle_path, count

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-a", required=True)
    ap.add_argument("--run-b", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    run_a = Path(args.run_a)
    run_b = Path(args.run_b)
    out_dir = Path(args.out_dir)

    for name in ("metrics.json", "execution-records.tsv"):
        a = (run_a / name).read_bytes()
        b = (run_b / name).read_bytes()
        assert a == b, f"deterministic replay mismatch: {name}"

    metrics = load_metrics(run_a)
    assert metrics == load_metrics(run_b)
    naive_scan_ops = verify_metrics(metrics)

    bundles, count = emit_bundles(run_a, out_dir)
    assert count == metrics["bundles_written"]

    summary = {
        "schema_version": 1,
        "tranche": "T37_PHYSICAL_UNIFIED_DRYRUN_EVIDENCE_GENERATOR",
        "phase": "PHASE1_DETERMINISTIC_SCALE_ENVELOPE",
        "status": "PASS",
        "scope": "SYNTHETIC_ARCHITECTURE_CAPACITY_ONLY",
        "markets": metrics["markets"],
        "synthetic_active_markets": metrics["synthetic_active_markets"],
        "surfaces": metrics["surfaces"],
        "signals": metrics["signals"],
        "shards": metrics["shards"],
        "max_affected_market_fanout": metrics["max_fanout"],
        "total_affected_market_visits": metrics["total_fanout"],
        "naive_global_scan_operations_avoided_reference": naive_scan_ops,
        "full_market_scans": metrics["full_market_scans"],
        "cold_market_observability_complete": (
            metrics["observed_cold_markets"] == metrics["cold_markets"]
        ),
        "reorg_events": metrics["reorg_events"],
        "reorg_invalidated_pending": metrics["reorg_invalidated_pending"],
        "authority_issuance": metrics["authority_issuance"],
        "dropped_signals": metrics["dropped_signals"],
        "evidence_bundles": count,
        "deterministic_replay_byte_identical": True,
        "metrics_sha256": sha256_file(run_a / "metrics.json"),
        "execution_records_sha256": sha256_file(run_a / "execution-records.tsv"),
        "execution_bundles_sha256": sha256_file(bundles),
        "real_market_census": "NOT_TESTED",
        "real_live_market_evidence": False,
        "live_pnl_evidence": False,
        "physical_unified_path": "NOT_TESTED",
        "production_runtime_third_party_api_dependency": False,
        "secret_dependency": False,
        "production_certification": "NOT_CERTIFIED",
        "nqc_global_status": "NOT_CERTIFIED / ACCELERATION_EVIDENCE_NOT_TARGET_ADMISSION",
    }
    summary["attestation_sha256"] = sha256_bytes(stable(summary))
    (out_dir / "phase1-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n"
    )
    (out_dir / "metrics.json").write_bytes((run_a / "metrics.json").read_bytes())
    print(json.dumps(summary, indent=2, sort_keys=True))

if __name__ == "__main__":
    main()
