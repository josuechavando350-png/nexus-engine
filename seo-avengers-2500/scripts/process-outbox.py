#!/usr/bin/env python3
"""Process SEO Avengers 2500 jobs outside the native site request path."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from runtime.service import execute_avengers_2500  # noqa: E402

AUTHORITY = "NEXUS_SEO_AVENGERS_2500_SIDECAR_V1"
RESULT_AUTHORITY = "NEXUS_SEO_AVENGERS_2500_RESULT_V1"
REJECTION_AUTHORITY = "NEXUS_SEO_AVENGERS_2500_REJECTION_V1"


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


def project_config(project_dir: Path) -> tuple[bool, str | None]:
    try:
        manifest = json.loads((project_dir / "package.json").read_text("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False, None
    if not isinstance(manifest, dict):
        return False, None
    nexus = manifest.get("nexus")
    if not isinstance(nexus, dict):
        nexus = {}
    raw_name = manifest.get("name")
    site_id = nexus.get("siteId")
    if not isinstance(site_id, str) or not site_id.strip():
        if isinstance(raw_name, str) and raw_name.strip():
            site_id = raw_name.removeprefix("@nexus/").strip()
        else:
            site_id = None
    return nexus.get("CONFIG_SEO_AVENGERS_2500") is True, site_id


def wire_bytes(value: Any) -> bytes:
    if value is None:
        return b"n;"
    if isinstance(value, bool):
        return b"b1;" if value else b"b0;"
    if isinstance(value, int) and not isinstance(value, bool):
        return f"i{value};".encode("ascii")
    if isinstance(value, float):
        raise TypeError("wire values may not contain floats")
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        return f"s{len(encoded)}:".encode("ascii") + encoded
    if isinstance(value, list):
        parts = [f"a{len(value)}[".encode("ascii")]
        parts.extend(wire_bytes(item) for item in value)
        parts.append(b"]")
        return b"".join(parts)
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("wire object keys must be strings")
        keys = sorted(value)
        parts = [f"o{len(keys)}{{".encode("ascii")]
        for key in keys:
            parts.append(wire_bytes(key))
            parts.append(wire_bytes(value[key]))
        parts.append(b"}")
        return b"".join(parts)
    raise TypeError("wire values must be JSON-compatible")


def envelope_hash_v1(value: Any) -> str:
    return "sha256:" + hashlib.sha256(wire_bytes(value)).hexdigest()


def load_and_verify_envelope(path: Path, expected_site_id: str) -> dict[str, Any]:
    envelope = json.loads(path.read_text("utf-8"))
    if not isinstance(envelope, dict):
        raise ValueError("envelope must be an object")
    if envelope.get("authority") != AUTHORITY or envelope.get("schema_version") != 1:
        raise ValueError("unsupported envelope authority/schema")
    if envelope.get("site_id") != expected_site_id:
        raise ValueError("cross-tenant envelope rejected")

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
    data = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n"
    with temporary.open("x", encoding="utf-8") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def process(project_dir: Path, limit: int) -> dict[str, Any]:
    enabled, site_id = project_config(project_dir)
    if not enabled or not site_id:
        return {"status": "DISABLED", "processed": 0, "rejected": 0, "blocked": 0}

    repository_root = repository_root_from_project(project_dir)
    base = repository_root / ".artifacts" / "seo-avengers-2500"
    outbox = base / "outbox"
    results = base / "results"
    processed_dir = base / "processed"
    rejected_dir = base / "rejected"

    if not outbox.exists():
        return {"status": "IDLE", "processed": 0, "rejected": 0, "blocked": 0}

    processed = 0
    rejected = 0
    blocked = 0
    jobs = sorted(path for path in outbox.glob("*.json") if path.is_file())[:limit]

    for job_path in jobs:
        try:
            current_enabled, current_site_id = project_config(project_dir)
            if not current_enabled or current_site_id != site_id:
                return {"status": "DISABLED", "processed": processed, "rejected": rejected, "blocked": blocked}

            envelope = load_and_verify_envelope(job_path, site_id)
            runtime_config = dict(envelope["runtime_config"])
            runtime_config["CONFIG_SEO_AVENGERS_2500"] = True
            result = execute_avengers_2500(envelope["payload"], runtime_config)
            if result.get("enabled") is not True:
                raise RuntimeError("runtime activation unexpectedly disabled")

            result_envelope = {
                "authority": RESULT_AUTHORITY,
                "site_id": site_id,
                "source_revision": envelope["source_revision"],
                "input_hash": envelope["input_hash"],
                "result": result,
            }
            result_envelope["result_hash"] = envelope_hash_v1(result_envelope)
            atomic_json_write(results / job_path.name, result_envelope)

            if result.get("release_safe") is not True:
                blocked += 1

            processed_dir.mkdir(parents=True, exist_ok=True)
            os.replace(job_path, processed_dir / job_path.name)
            processed += 1
        except Exception as exc:  # fail closed at the sidecar boundary
            rejected_dir.mkdir(parents=True, exist_ok=True)
            rejected_record = {
                "authority": REJECTION_AUTHORITY,
                "job": job_path.name,
                "reason": type(exc).__name__,
                "detail": str(exc),
            }
            atomic_json_write(rejected_dir / job_path.name, rejected_record)
            if job_path.exists():
                os.replace(job_path, rejected_dir / f"{job_path.stem}.source.json")
            rejected += 1

    return {
        "status": "PROCESSED" if processed or rejected else "IDLE",
        "processed": processed,
        "rejected": rejected,
        "blocked": blocked,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()
    if args.limit < 1 or args.limit > 100:
        parser.error("--limit must be 1..100")

    summary = process(Path(args.project_dir), args.limit)
    print(json.dumps(summary, sort_keys=True, separators=(",", ":")))
    return 0 if summary["rejected"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
