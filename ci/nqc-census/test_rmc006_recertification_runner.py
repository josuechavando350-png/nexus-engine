#!/usr/bin/env python3
"""Rootless runner regressions: no real mount, RPC or network probe is used.

Mocked kernel observations prove the runner rejects a weaker isolation setup;
these tests do not themselves certify actual network disconnection. The runner
must also execute and record its actual namespace checks during recertification.
"""

from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
import errno
import hashlib
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import run_rmc006_recertification as runner


PARENT_NS = "net:[100]"
CHILD_NS = "net:[101]"
REJECT_ROUTE = " ".join(["0" * 32, "00", "0" * 32, "00", "0" * 32,
                         "ffffffff", "00000001", "00000000", "00200200", "lo"]) + "\n"
PROC_FILES = {
    "/proc/net/dev": "Inter-| Receive | Transmit\n face | bytes | bytes\n lo: 0 0 0 0\n",
    "/proc/net/if_inet6": "",
    "/proc/net/route": "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n",
    "/proc/net/ipv6_route": REJECT_ROUTE,
}


@contextmanager
def isolated_kernel(*, namespace=CHILD_NS, proc_changes=None, loopback_up=False,
                    ipv4_address=None, ipv4_errno=errno.ENETUNREACH,
                    ipv6_errno=errno.ENETUNREACH, ipv6_creation_errno=None,
                    address_ioctl_errno=errno.EADDRNOTAVAIL):
    """Model observed procfs, ioctl and sockets without touching actual networking."""
    files = {**PROC_FILES, **(proc_changes or {})}
    interface = mock.MagicMock(name="loopback_ioctl_socket")
    probe4 = mock.MagicMock(name="ipv4_probe")
    probe6 = mock.MagicMock(name="ipv6_probe")
    for value in (interface, probe4, probe6):
        value.__enter__.return_value = value
        value.__exit__.return_value = False
    if ipv4_errno is not None:
        probe4.connect.side_effect = OSError(ipv4_errno, "synthetic IPv4 result")
    if ipv6_errno is not None:
        probe6.connect.side_effect = OSError(ipv6_errno, "synthetic IPv6 result")

    def make_socket(family, kind, *args, **kwargs):
        if (family, kind) == (socket.AF_INET, socket.SOCK_DGRAM):
            return interface
        if (family, kind) == (socket.AF_INET, socket.SOCK_STREAM):
            return probe4
        if (family, kind) == (socket.AF_INET6, socket.SOCK_STREAM):
            if ipv6_creation_errno is not None:
                raise OSError(ipv6_creation_errno, "synthetic IPv6 socket creation")
            return probe6
        raise AssertionError(f"unexpected socket type {family}, {kind}")

    def ioctl(_descriptor, operation, _request):
        if operation == 0x8913:  # SIOCGIFFLAGS
            return struct.pack("16sH14x", b"lo", int(loopback_up))
        if operation == 0x8915:  # SIOCGIFADDR
            if ipv4_address is None:
                raise OSError(address_ioctl_errno, "synthetic unassigned IPv4")
            return struct.pack("16sH2x4s8x", b"lo", socket.AF_INET,
                               socket.inet_aton(ipv4_address))
        raise AssertionError(f"unexpected ioctl operation {operation}")

    def read_proc(path, *args, **kwargs):
        return files[str(path)]

    with ExitStack() as stack:
        readlink = stack.enter_context(mock.patch.object(runner.os, "readlink", return_value=namespace))
        stack.enter_context(mock.patch.object(runner.Path, "read_text", autospec=True, side_effect=read_proc))
        sockets = stack.enter_context(mock.patch.object(runner.socket, "socket", side_effect=make_socket))
        ioctls = stack.enter_context(mock.patch.object(runner.fcntl, "ioctl", side_effect=ioctl))
        yield SimpleNamespace(interface=interface, ipv4=probe4, ipv6=probe6,
                              sockets=sockets, ioctls=ioctls, readlink=readlink)


class VerificationTimeTests(unittest.TestCase):
    def setUp(self):
        self.started = datetime(2026, 10, 8, 21, 0, 0, 123456, tzinfo=timezone.utc)
        self.completed = self.started + timedelta(minutes=20)
        self.observation = 1790832215

    def test_new_verification_times_are_explicit_utc_and_separate_from_observation(self):
        actual = runner.verification_times(self.started, self.completed, self.observation)
        self.assertEqual(actual, {
            'verification_started_at': '2026-10-08T21:00:00.123456Z',
            'verification_completed_at': '2026-10-08T21:20:00.123456Z',
            'verification_time_basis': 'NEW_VERIFICATION_SYSTEM_UTC_CLOCK',
            'original_observation_at': '2026-10-01T05:23:35Z',
            'original_observation_time_basis': 'ORIGINAL_SOURCE_ANCHOR_BLOCK_TIMESTAMP',
        })
        self.assertLess(datetime.fromisoformat(actual['original_observation_at']),
                        datetime.fromisoformat(actual['verification_started_at']))

    def test_backwards_naive_or_non_utc_verification_clock_fails(self):
        for start, end in [(self.completed, self.started),
                           (self.started.replace(tzinfo=None), self.completed),
                           (self.started, self.completed.replace(tzinfo=None)),
                           (self.started.astimezone(timezone(timedelta(hours=1))), self.completed)]:
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                runner.verification_times(start, end, self.observation)

    def test_verification_never_backdates_a_future_source_observation(self):
        with self.assertRaises(ValueError):
            runner.verification_times(self.started, self.completed,
                                      int((self.completed + timedelta(days=1)).timestamp()))
        for bad in [True, '1790832215', 1790832215.0]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                runner.verification_times(self.started, self.completed, bad)

    def test_runner_takes_system_clock_and_existing_index_binds_report_bytes(self):
        implementation = Path(runner.__file__).read_text()
        self.assertIn('started_at = datetime.now(timezone.utc)', implementation)
        self.assertIn("verification_times(started_at, datetime.now(timezone.utc), pin['anchor']['timestamp'])", implementation)
        self.assertNotIn("add_argument('--verification", implementation)
        workflow = Path(runner.__file__).resolve().parents[2]/'.github/workflows/nqc-census-aave-discovery.yml'
        text = workflow.read_text()
        self.assertIn("root.rglob('*')", text)
        self.assertIn("hashlib.sha256(data).hexdigest()", text)
        self.assertIn("'schema': 'nqc-rmc006-evidence-index-v1'", text)


class NetworkProofTests(unittest.TestCase):
    def test_down_loopback_reject_ipv6_routes_no_addresses_and_actual_probes(self):
        with isolated_kernel() as kernel:
            proof = runner.network_proof(PARENT_NS)
            self.assertEqual(proof, {"parent_network_namespace": PARENT_NS,
                                    "network_namespace": CHILD_NS,
                                    "interfaces": ["lo"], "routable_network": False})
            kernel.readlink.assert_called_once_with("/proc/self/ns/net")
            kernel.ipv4.connect.assert_called_once_with(("1.1.1.1", 443))
            kernel.ipv6.connect.assert_called_once_with(("2606:4700:4700::1111", 443))
            kernel.ipv4.settimeout.assert_called_once_with(1)
            kernel.ipv6.settimeout.assert_called_once_with(1)
            self.assertIn(0x8913, [call.args[1] for call in kernel.ioctls.call_args_list])
            self.assertIn(0x8915, [call.args[1] for call in kernel.ioctls.call_args_list])

    def test_empty_ipv6_routes_are_also_disconnected(self):
        with isolated_kernel(proc_changes={"/proc/net/ipv6_route": ""}):
            self.assertFalse(runner.network_proof(PARENT_NS)["routable_network"])

    def test_same_network_namespace_fails_before_any_socket(self):
        with isolated_kernel(namespace=PARENT_NS) as kernel:
            with self.assertRaisesRegex(ValueError, "namespace"):
                runner.network_proof(PARENT_NS)
            kernel.sockets.assert_not_called()

    def test_extra_missing_or_live_interfaces_fail(self):
        for interfaces in ("lo: 0\neth0: 0\n", "eth0: 0\n", ""):
            with self.subTest(interfaces=interfaces), isolated_kernel(
                    proc_changes={"/proc/net/dev": interfaces}):
                with self.assertRaisesRegex(ValueError, "interface"):
                    runner.network_proof(PARENT_NS)
        with isolated_kernel(loopback_up=True):
            with self.assertRaisesRegex(ValueError, "loopback"):
                runner.network_proof(PARENT_NS)

    def test_any_ipv4_route_fails_even_if_socket_probe_would_be_unreachable(self):
        with isolated_kernel(proc_changes={"/proc/net/route": PROC_FILES["/proc/net/route"] +
                                           "lo 00000000 00000000 0001 0 0 0 00000000 0 0 0\n"}):
            with self.assertRaisesRegex(ValueError, "IPv4 routes"):
                runner.network_proof(PARENT_NS)

    def test_ipv6_nonreject_foreign_interface_and_malformed_routes_fail(self):
        for row in (REJECT_ROUTE.replace("00200200", "00000001"),
                    REJECT_ROUTE.replace(" lo", " eth0"), "malformed\n",
                    REJECT_ROUTE.replace("00200200", "nothex")):
            with self.subTest(row=row), isolated_kernel(proc_changes={"/proc/net/ipv6_route": row}):
                with self.assertRaises(ValueError):
                    runner.network_proof(PARENT_NS)

    def test_ipv6_address_on_down_loopback_is_rejected(self):
        with isolated_kernel(proc_changes={"/proc/net/if_inet6":
                                           "00000000000000000000000000000001 01 80 10 80 lo\n"}):
            with self.assertRaisesRegex(ValueError, "IPv6 address"):
                runner.network_proof(PARENT_NS)

    def test_ipv4_address_on_down_loopback_is_rejected(self):
        with isolated_kernel(ipv4_address="127.0.0.1"):
            with self.assertRaisesRegex(ValueError, "IPv4|address"):
                runner.network_proof(PARENT_NS)

    def test_inconclusive_ipv4_address_lookup_is_rejected(self):
        for error in (errno.EPERM, errno.EACCES, errno.EINVAL, errno.EIO):
            with self.subTest(error=error), isolated_kernel(address_ioctl_errno=error):
                with self.assertRaises((ValueError, OSError)):
                    runner.network_proof(PARENT_NS)

    def test_reachable_ipv4_or_ipv6_is_rejected(self):
        for options in ({"ipv4_errno": None}, {"ipv6_errno": None}):
            with self.subTest(options=options), isolated_kernel(**options):
                with self.assertRaisesRegex(ValueError, "reachable"):
                    runner.network_proof(PARENT_NS)

    def test_ipv4_probe_must_prove_unreachability_not_just_fail(self):
        for error in (errno.ECONNREFUSED, errno.EACCES, errno.EPERM, errno.ETIMEDOUT,
                      errno.EADDRNOTAVAIL, errno.EINTR):
            with self.subTest(error=error), isolated_kernel(ipv4_errno=error):
                with self.assertRaisesRegex(ValueError, "proving unreachable"):
                    runner.network_proof(PARENT_NS)

    def test_ipv6_probe_must_prove_unreachability_not_just_fail(self):
        for error in (errno.ECONNREFUSED, errno.EACCES, errno.EPERM, errno.ETIMEDOUT, errno.EINTR):
            with self.subTest(error=error), isolated_kernel(ipv6_errno=error):
                with self.assertRaisesRegex(ValueError, "proving unreachable"):
                    runner.network_proof(PARENT_NS)

    def test_accepted_ipv4_and_ipv6_unreachable_errors(self):
        for ipv4_error in (errno.ENETUNREACH, errno.EHOSTUNREACH):
            for ipv6_error in (errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EADDRNOTAVAIL):
                with self.subTest(ipv4=ipv4_error, ipv6=ipv6_error), isolated_kernel(
                        ipv4_errno=ipv4_error, ipv6_errno=ipv6_error):
                    self.assertFalse(runner.network_proof(PARENT_NS)["routable_network"])

    def test_ipv6_disabled_requires_eafnosupport_and_still_probes_ipv4(self):
        with isolated_kernel(ipv6_creation_errno=errno.EAFNOSUPPORT) as kernel:
            self.assertFalse(runner.network_proof(PARENT_NS)["routable_network"])
            kernel.ipv6.connect.assert_not_called()
            kernel.ipv4.connect.assert_called_once()
        for error in (errno.EPERM, errno.EACCES, errno.EMFILE):
            with self.subTest(error=error), isolated_kernel(ipv6_creation_errno=error):
                with self.assertRaisesRegex(ValueError, "availability"):
                    runner.network_proof(PARENT_NS)


class RunnerHelperTests(unittest.TestCase):
    def test_run_records_stdout_and_converts_arguments_without_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "run.log"
            result = subprocess.CompletedProcess(["tool"], 0, "complete\n")
            with mock.patch.object(runner.subprocess, "run", return_value=result) as execute:
                self.assertEqual(runner.run([Path("tool"), 123], log, cwd=tmp), "complete\n")
            self.assertEqual(log.read_text(), "complete\n")
            execute.assert_called_once_with(["tool", "123"], cwd=tmp, text=True,
                                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                            check=False)

    def test_run_rejects_unexpected_exit_and_preserves_failure_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "failure.log"
            result = subprocess.CompletedProcess(["tool"], 3, "failure evidence\n")
            with mock.patch.object(runner.subprocess, "run", return_value=result):
                with self.assertRaisesRegex(ValueError, "unexpected exit 3"):
                    runner.run(["tool"], log)
                self.assertEqual(runner.run(["tool"], expected=1), "failure evidence\n")
            self.assertEqual(log.read_text(), "failure evidence\n")
            with mock.patch.object(runner.subprocess, "run",
                                   return_value=subprocess.CompletedProcess(["tool"], 0, "")):
                with self.assertRaises(ValueError):
                    runner.run(["tool"], expected=1)

    def test_byte_snapshot_is_exact_and_detects_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "directory").mkdir()
            (root / "directory/member").write_bytes(b"original")
            before = runner.bytes_snapshot(root)
            self.assertEqual(before, {"directory/member": hashlib.sha256(b"original").hexdigest()})
            (root / "directory/member").write_bytes(b"changed")
            self.assertNotEqual(runner.bytes_snapshot(root), before)

    def test_byte_snapshot_rejects_symlink_and_special_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "target").write_bytes(b"original")
            (root / "link").symlink_to(root / "target")
            with self.assertRaisesRegex(ValueError, "symlink|non-regular"):
                runner.bytes_snapshot(root)
            (root / "link").unlink()
            runner.os.mkfifo(root / "fifo")
            with self.assertRaisesRegex(ValueError, "regular|special|unexpected"):
                runner.bytes_snapshot(root)


class ReadOnlyMountGuardTests(unittest.TestCase):
    @contextmanager
    def invocation(self, *, output_inside_source=False, output_exists=False, source_exists=True):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, repo = root / "source", root / "repo"
            if source_exists:
                source.mkdir()
            repo.mkdir()
            out = source / "output" if output_inside_source else root / "output"
            if output_exists:
                out.mkdir()
            argv = ["runner", "--source", str(source), "--out", str(out), "--repo", str(repo),
                    "--parent-network-namespace", PARENT_NS]
            with mock.patch.object(sys, "argv", argv), \
                    mock.patch.object(runner, "network_proof", return_value={}) as proof, \
                    mock.patch.object(runner, "run", return_value="") as execute, \
                    mock.patch.object(runner.os, "statvfs",
                                      return_value=SimpleNamespace(f_flag=runner.os.ST_RDONLY)) as statvfs:
                yield SimpleNamespace(source=source, out=out, repo=repo, proof=proof,
                                      execute=execute, statvfs=statvfs)

    def test_output_inside_source_existing_output_or_missing_source_fails_before_mount(self):
        for options in ({"output_inside_source": True}, {"output_exists": True},
                        {"source_exists": False}):
            with self.subTest(options=options), self.invocation(**options) as env:
                with self.assertRaises(ValueError):
                    runner.main()
                env.proof.assert_not_called()
                env.execute.assert_not_called()

    def test_failed_network_proof_prevents_mount_and_output(self):
        with self.invocation() as env:
            env.proof.side_effect = ValueError("network proof failed")
            with self.assertRaisesRegex(ValueError, "network proof failed"):
                runner.main()
            env.execute.assert_not_called()
            self.assertFalse(env.out.exists())

    def test_bind_or_readonly_remount_failure_stops_without_snapshot_or_output(self):
        for operation in (0, 1):
            with self.subTest(operation=operation), self.invocation() as env, \
                    mock.patch.object(runner, "bytes_snapshot") as snapshot:
                env.execute.side_effect = [""] * operation + [ValueError("mount failed")]
                with self.assertRaisesRegex(ValueError, "mount failed"):
                    runner.main()
                self.assertEqual(env.execute.call_count, operation + 1)
                snapshot.assert_not_called()
                self.assertFalse(env.out.exists())

    def test_successful_mount_commands_without_actual_readonly_flag_are_rejected(self):
        with self.invocation() as env, mock.patch.object(runner, "bytes_snapshot") as snapshot:
            env.statvfs.return_value.f_flag = 0
            with self.assertRaisesRegex(ValueError, "not read-only"):
                runner.main()
            self.assertEqual(env.execute.call_args_list, [
                mock.call(["mount", "--bind", env.source, env.source]),
                mock.call(["mount", "-o", "remount,bind,ro", env.source]),
            ])
            snapshot.assert_not_called()
            self.assertFalse(env.out.exists())

    def test_actual_readonly_check_precedes_first_source_snapshot(self):
        with self.invocation() as env:
            def stop_after_guard(_source):
                env.statvfs.assert_called_once_with(env.source)
                self.assertEqual(env.execute.call_count, 2)
                raise ValueError("intentional stop after read-only check")
            with mock.patch.object(runner, "bytes_snapshot", side_effect=stop_after_guard):
                with self.assertRaisesRegex(ValueError, "intentional stop"):
                    runner.main()
            self.assertFalse(env.out.exists())

    def test_changed_authenticated_index_fails_before_git_or_rust(self):
        with self.invocation() as env:
            (env.source / "evidence-index.json").write_text('{"files":[]}\n')
            directory = env.repo / "ci/nqc-census"
            directory.mkdir(parents=True)
            (directory / "rmc006-recertification-source.json").write_text(
                json.dumps({"index": {"sha256": "0" * 64}}))
            with self.assertRaisesRegex(ValueError, "source index changed"):
                runner.main()
            self.assertEqual(env.execute.call_count, 2)
            self.assertFalse((env.out / "offline-verification.json").exists())


if __name__ == "__main__":
    unittest.main()
