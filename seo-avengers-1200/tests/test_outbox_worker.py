import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from runtime.wire import envelope_hash_v1


class OutboxWorkerTests(unittest.TestCase):
    def test_worker_rechecks_switches_and_processes_hash_bound_job(self):
        suite_root = Path(__file__).resolve().parents[1]
        worker = suite_root / "scripts" / "process-outbox.py"

        with tempfile.TemporaryDirectory() as temp:
            repo_root = Path(temp)
            project = repo_root / "apps" / "probe"
            project.mkdir(parents=True)
            (project / "package.json").write_text(
                json.dumps({
                    "name": "probe",
                    "nexus": {
                        "CONFIG_SEO_AVENGERS_200": True,
                        "CONFIG_SEO_AVENGERS_1200": True,
                    },
                }),
                encoding="utf-8",
            )

            payload = {
                "meta_telemetry": {
                    "server_cpu_utilization_percent": 40,
                    "cloudflare_kv_latency_ms": 900,
                    "active_pipeline_actions_pool": [],
                },
                "site_images_data": [],
                "upstream_evidence": [],
            }
            runtime_config = {
                "m901_max_safe_cpu_percent": 80,
                "m901_max_safe_kv_latency_ms": 150,
                "m901_kv_saturation_latency_ms": 1000,
                "m1102_max_failure_rate_ppm": 50000,
            }
            core = {
                "authority": "NEXUS_SEO_AVENGERS_1200_EXTENSION_V1",
                "schema_version": 1,
                "site_id": "probe",
                "source_revision": "fixture-revision",
                "payload": payload,
                "runtime_config": runtime_config,
            }
            input_hash = envelope_hash_v1(core)
            envelope = {
                **core,
                "input_hash": input_hash,
                "idempotency_key": input_hash,
            }

            outbox = repo_root / ".artifacts" / "seo-avengers-1200" / "outbox"
            outbox.mkdir(parents=True)
            job = outbox / f"{input_hash.removeprefix('sha256:')}.json"
            job.write_text(
                json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n",
                encoding="utf-8",
            )

            completed = subprocess.run(
                [sys.executable, str(worker), "--project-dir", str(project)],
                cwd=suite_root,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            summary = json.loads(completed.stdout)
            self.assertEqual(summary["processed"], 1)
            self.assertEqual(summary["rejected"], 0)

            result_path = repo_root / ".artifacts" / "seo-avengers-1200" / "results" / job.name
            result = json.loads(result_path.read_text("utf-8"))
            self.assertEqual(result["input_hash"], input_hash)
            self.assertEqual(result["result"]["suite"], "SEO_AVENGERS_1200")
            self.assertEqual(result["result"]["receipts"]["M901"]["output"]["kv_pressure_ppm"], 882353)

            processed_path = repo_root / ".artifacts" / "seo-avengers-1200" / "processed" / job.name
            self.assertTrue(processed_path.exists())
            self.assertFalse(job.exists())

    def test_worker_does_not_consume_stale_job_when_extension_is_off(self):
        suite_root = Path(__file__).resolve().parents[1]
        worker = suite_root / "scripts" / "process-outbox.py"

        with tempfile.TemporaryDirectory() as temp:
            repo_root = Path(temp)
            project = repo_root / "apps" / "probe"
            project.mkdir(parents=True)
            (project / "package.json").write_text(
                json.dumps({
                    "name": "probe",
                    "nexus": {
                        "CONFIG_SEO_AVENGERS_200": True,
                        "CONFIG_SEO_AVENGERS_1200": False,
                    },
                }),
                encoding="utf-8",
            )
            outbox = repo_root / ".artifacts" / "seo-avengers-1200" / "outbox"
            outbox.mkdir(parents=True)
            stale = outbox / "stale.json"
            stale.write_text("{}\n", encoding="utf-8")

            completed = subprocess.run(
                [sys.executable, str(worker), "--project-dir", str(project)],
                cwd=suite_root,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            summary = json.loads(completed.stdout)
            self.assertEqual(summary["status"], "DISABLED")
            self.assertTrue(stale.exists())


if __name__ == "__main__":
    unittest.main()
