#!/usr/bin/env python3
"""Process SEO Avengers 1200 outbox jobs outside the native request path."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from runtime.seo_avengers_1200 import SeoAvengers1200Runtime, canonical_hash  # noqa: E402
from runtime.wire import envelope_hash_v1  # noqa: E402

AUTHORITY = "NEXUS_SEO_AVENGERS_1200_EXTENSION_V1"


def repository_root_from_project(project_dir: Path) -> Path:
    resolved = project_dir.resolve()
    parts = resolved.parts
    try:
        apps_index = max(index for index, part in enumerate(parts) if part == "apps")
    except ValueError as exc:
        raise ValueError("project directory is not under repository apps/") from exc
    if apps_index == 0 or apps_index == len(parts) - 1:
        raise ValueError("project directory is not under repository apps/<project>")
    return Path(*parts[:apps_index])


def project_enabled(project_dir: Path) -> bool:
    try:
        manifest = json.loads((project_dir / "package.json").read_text("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    nexus = manifest.get("nexus")
    if not isinstance(nexus, dict):
        return False
    return (
        nexus.get("CONFIG_SEO_AVENGERS_200") is True
        and nexus.get("CONFIG_SEO_AVENGERS_1200") is True
    )


def load_and_verify_envelope(path: Path) -> dict[str, Any]:
    envelope = json.loads(path.read_text("utf-8"))
    if not isinstance(envelope, dict):
        raise ValueError("envelope must be an object")
    if envelope.get("authority") != AUTHORITY or envelope.get("schema_version") != 1:
        raise ValueError("unsupported envelope authority/schema")

    input_hash = envelope.get("input_hash")
    idempotency_key = envelope.get("idempotency_key")
    if not isinstance(input_hash, str) or input_hash != idempotency_key:
        raise ValueError("invalid envelope idempotency binding")

    core = {
        "authority": envelope.get("authority"),
        "schema_version": envelope.get("schema_version"),
        "site_id": envelope.get("site_id"),
        "source_revision": envelope.get("source_revision"),
        "payload": envelope.get("payload"),
        "runtime_config": envelope.get("runtime_config"),
    }
    if envelope_hash_v1(core) != input_hash:
        raise ValueError("envelope input_hash mismatch")
    if not isinstance(core["payload"], dict) or not isinstance(core["runtime_config"], dict):
        raise ValueError("invalid envelope payload/config schema")
    return envelope


def atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ) + "\n"
    with temporary.open("x", encoding="utf-8") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def process(project_dir: Path, limit: int) -> dict[str, Any]:
    # Re-check switches at consumption time so disabling a tenant prevents stale
    # queued jobs from executing.
    if not project_enabled(project_dir):
        return {"status": "DISABLED", "processed": 0, "rejected": 0, "halt_recommended": 0}

    repository_root = repository_root_from_project(project_dir)
    base = repository_root / ".artifacts" / "seo-avengers-1200"
    outbox = base / "outbox"
    results = base / "results"
    processed_dir = base / "processed"
    rejected_dir = base / "rejected"

    if not outbox.exists():
        return {"status": "IDLE", "processed": 0, "rejected": 0, "halt_recommended": 0}

    processed = 0
    rejected = 0
    halt_recommended = 0
    runtime = SeoAvengers1200Runtime()

    jobs = sorted(path for path in outbox.glob("*.json") if path.is_file())[:limit]
    for job_path in jobs:
        try:
            envelope = load_and_verify_envelope(job_path)
            runtime_config = dict(envelope["runtime_config"])
            # This is not caller-controlled activation: the worker already
            # revalidated both project switches immediately above.
            runtime_config["CONFIG_SEO_AVENGERS_1200"] = True
            result = runtime.execute(envelope["payload"], runtime_config)
            result_envelope = {
                "authority": "NEXUS_SEO_AVENGERS_1200_RESULT_V1",
                "site_id": envelope["site_id"],
                "source_revision": envelope["source_revision"],
                "input_hash": envelope["input_hash"],
                "result": result,
            }
            result_envelope["result_hash"] = canonical_hash(result_envelope)
            destination = results / job_path.name
            atomic_json_write(destination, result_envelope)

            m1102 = result.get("receipts", {}).get("M1102", {})
            if m1102.get("output", {}).get("deployment_halt_recommended") is True:
                halt_recommended += 1

            processed_dir.mkdir(parents=True, exist_ok=True)
            os.replace(job_path, processed_dir / job_path.name)
            processed += 1
        except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
            rejected_dir.mkdir(parents=True, exist_ok=True)
            rejected_record = {
                "authority": "NEXUS_SEO_AVENGERS_1200_REJECTION_V1",
                "job": job_path.name,
                "reason": type(exc).__name__,
                "detail": str(exc),
            }
            atomic_json_write(rejected_dir / job_path.name, rejected_record)
            os.replace(job_path, rejected_dir / f"{job_path.stem}.source.json")
            rejected += 1

    return {
        "status": "PROCESSED" if processed or rejected else "IDLE",
        "processed": processed,
        "rejected": rejected,
        "halt_recommended": halt_recommended,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()
    if args.limit < 1 or args.limit > 10_000:
        parser.error("--limit must be 1..10000")

    summary = process(Path(args.project_dir), args.limit)
    print(json.dumps(summary, sort_keys=True, separators=(",", ":")))
    return 0 if summary["rejected"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
