use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

use walle_core::supervisor::MicroVmSupervisorPlan;
use walle_core::supervisor_lifecycle::{
    execute_supervisor_lifecycle, MicroVmSupervisorHost, SupervisorLifecycleResult,
};

use crate::artifact::SystemSha256;
use crate::evidence::{
    verify_evidence_chain, EvidenceError, EvidenceReceipt, EvidenceRun, EvidenceSeal,
};

pub const SUPERVISOR_PLAN_EVIDENCE_KIND: &str = "supervisor-plan";
pub const SUPERVISOR_LIFECYCLE_EVIDENCE_KIND: &str = "supervisor-lifecycle-result";

#[derive(Debug)]
pub enum SupervisorEvidenceError {
    PlanBindingMismatch,
    Evidence(EvidenceError),
}

impl Display for SupervisorEvidenceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PlanBindingMismatch => formatter.write_str(
                "supervisor evidence run is bound to a different run id or source digest",
            ),
            Self::Evidence(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for SupervisorEvidenceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Evidence(error) => Some(error),
            Self::PlanBindingMismatch => None,
        }
    }
}

impl From<EvidenceError> for SupervisorEvidenceError {
    fn from(value: EvidenceError) -> Self {
        Self::Evidence(value)
    }
}

#[derive(Debug)]
pub struct EvidencedSupervisorResult {
    pub lifecycle: SupervisorLifecycleResult,
    pub plan_receipt: EvidenceReceipt,
    pub lifecycle_receipt: EvidenceReceipt,
    pub seal: EvidenceSeal,
}

/// Owns one durable evidence chain that is cryptographically bound to the
/// supervisor plan's run id and source digest.
///
/// Construction does not execute the workload. `execute` first persists the
/// exact canonical supervisor plan, then runs the lifecycle, persists the exact
/// canonical terminal result, seals the chain, and re-reads/verifies the sealed
/// bytes before returning success. If any evidence operation or terminal
/// integrity check fails, the caller receives an error and no certification
/// claim can be made from this API.
#[derive(Debug)]
pub struct SupervisorEvidenceRun {
    evidence: EvidenceRun,
    hasher: SystemSha256,
    run_id: String,
    source_sha256: String,
}

impl SupervisorEvidenceRun {
    pub fn begin(
        evidence_root: impl Into<PathBuf>,
        sha256_program: impl Into<PathBuf>,
        plan: &MicroVmSupervisorPlan<'_>,
    ) -> Result<Self, SupervisorEvidenceError> {
        let sha256_program = sha256_program.into();
        let hasher = SystemSha256::new(sha256_program.clone()).map_err(EvidenceError::from)?;
        let evidence = EvidenceRun::begin(
            evidence_root,
            sha256_program,
            plan.run_id,
            plan.source_sha256,
        )?;
        Ok(Self {
            evidence,
            hasher,
            run_id: plan.run_id.to_owned(),
            source_sha256: plan.source_sha256.to_owned(),
        })
    }

    pub fn path(&self) -> &Path {
        self.evidence.path()
    }

    pub fn execute<H: MicroVmSupervisorHost>(
        &mut self,
        host: &mut H,
        plan: &MicroVmSupervisorPlan<'_>,
    ) -> Result<EvidencedSupervisorResult, SupervisorEvidenceError> {
        if plan.run_id != self.run_id || plan.source_sha256 != self.source_sha256 {
            return Err(SupervisorEvidenceError::PlanBindingMismatch);
        }
        let result = execute_with_sink(host, plan, &mut self.evidence)?;
        let receipts = [
            result.plan_receipt.clone(),
            result.lifecycle_receipt.clone(),
        ];
        verify_evidence_chain(self.evidence.path(), &receipts, &result.seal, &self.hasher)?;
        Ok(result)
    }
}

trait SupervisorEvidenceSink {
    fn append(&mut self, kind: &str, payload: &[u8]) -> Result<EvidenceReceipt, EvidenceError>;
    fn seal(&mut self) -> Result<EvidenceSeal, EvidenceError>;
}

impl SupervisorEvidenceSink for EvidenceRun {
    fn append(&mut self, kind: &str, payload: &[u8]) -> Result<EvidenceReceipt, EvidenceError> {
        EvidenceRun::append(self, kind, payload)
    }

    fn seal(&mut self) -> Result<EvidenceSeal, EvidenceError> {
        EvidenceRun::seal(self)
    }
}

fn execute_with_sink<H, S>(
    host: &mut H,
    plan: &MicroVmSupervisorPlan<'_>,
    sink: &mut S,
) -> Result<EvidencedSupervisorResult, EvidenceError>
where
    H: MicroVmSupervisorHost,
    S: SupervisorEvidenceSink,
{
    let plan_json = plan.canonical_json();
    let plan_receipt = sink.append(SUPERVISOR_PLAN_EVIDENCE_KIND, plan_json.as_bytes())?;

    let lifecycle = execute_supervisor_lifecycle(host, plan);
    let lifecycle_json = lifecycle.canonical_json();
    let lifecycle_receipt = sink.append(
        SUPERVISOR_LIFECYCLE_EVIDENCE_KIND,
        lifecycle_json.as_bytes(),
    )?;
    let seal = sink.seal()?;

    Ok(EvidencedSupervisorResult {
        lifecycle,
        plan_receipt,
        lifecycle_receipt,
        seal,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use walle_core::supervisor::{CgroupV2Plan, MicroVmSupervisorPlan};
    use walle_core::supervisor_lifecycle::{
        GracefulTerminationOutcome, SpawnAttempt, SupervisorLifecycleReason,
        SupervisorTerminalStatus, WaitOutcome,
    };

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct FakeError;

    struct FakeHost {
        events: Vec<&'static str>,
        wait: Result<WaitOutcome, FakeError>,
    }

    impl FakeHost {
        fn exited() -> Self {
            Self {
                events: Vec::new(),
                wait: Ok(WaitOutcome::Exited(0)),
            }
        }

        fn wait_failure() -> Self {
            Self {
                events: Vec::new(),
                wait: Err(FakeError),
            }
        }
    }

    impl MicroVmSupervisorHost for FakeHost {
        type Process = u64;
        type Error = FakeError;

        fn verify_inputs(&mut self, _plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
            self.events.push("verify");
            Ok(())
        }

        fn prepare_run_root(
            &mut self,
            _plan: &MicroVmSupervisorPlan<'_>,
        ) -> Result<(), Self::Error> {
            self.events.push("prepare");
            Ok(())
        }

        fn apply_cgroup(&mut self, _plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
            self.events.push("cgroup");
            Ok(())
        }

        fn materialize_runtime(
            &mut self,
            _plan: &MicroVmSupervisorPlan<'_>,
        ) -> Result<(), Self::Error> {
            self.events.push("materialize");
            Ok(())
        }

        fn spawn(
            &mut self,
            _plan: &MicroVmSupervisorPlan<'_>,
        ) -> SpawnAttempt<Self::Process, Self::Error> {
            self.events.push("spawn");
            SpawnAttempt::Running(7)
        }

        fn wait(
            &mut self,
            _process: &mut Self::Process,
            _timeout_ms: u64,
        ) -> Result<WaitOutcome, Self::Error> {
            self.events.push("wait");
            self.wait
        }

        fn terminate_and_wait(
            &mut self,
            _process: &mut Self::Process,
            _grace_ms: u64,
        ) -> Result<GracefulTerminationOutcome, Self::Error> {
            self.events.push("terminate");
            Ok(GracefulTerminationOutcome::StillRunning)
        }

        fn force_kill_and_reap(&mut self, _process: &mut Self::Process) -> Result<(), Self::Error> {
            self.events.push("force");
            Ok(())
        }

        fn cleanup(&mut self, _plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
            self.events.push("cleanup");
            Ok(())
        }
    }

    #[derive(Debug)]
    struct FakeSink {
        writes: Vec<(String, String)>,
        fail_append_at: Option<usize>,
        sealed: bool,
    }

    impl FakeSink {
        fn healthy() -> Self {
            Self {
                writes: Vec::new(),
                fail_append_at: None,
                sealed: false,
            }
        }

        fn fail_append_at(index: usize) -> Self {
            Self {
                writes: Vec::new(),
                fail_append_at: Some(index),
                sealed: false,
            }
        }
    }

    impl SupervisorEvidenceSink for FakeSink {
        fn append(&mut self, kind: &str, payload: &[u8]) -> Result<EvidenceReceipt, EvidenceError> {
            let next = self.writes.len();
            if self.fail_append_at == Some(next) {
                return Err(EvidenceError::InvalidKind);
            }
            self.writes.push((
                kind.to_owned(),
                String::from_utf8(payload.to_vec()).expect("canonical evidence payload is utf-8"),
            ));
            let sequence = u64::try_from(next + 1).expect("test sequence fits u64");
            Ok(EvidenceReceipt {
                sequence,
                kind: kind.to_owned(),
                payload_file: format!("{sequence:06}.payload"),
                payload_sha256:
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        .to_owned(),
                payload_bytes: u64::try_from(payload.len()).expect("payload length fits u64"),
                previous_receipt_sha256: None,
                receipt_file: format!("{sequence:06}.receipt.json"),
                receipt_sha256:
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                        .to_owned(),
            })
        }

        fn seal(&mut self) -> Result<EvidenceSeal, EvidenceError> {
            self.sealed = true;
            Ok(EvidenceSeal {
                run_id: "run-0123456789abcdef0123456789abcdef".to_owned(),
                source_sha256:
                    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                        .to_owned(),
                entry_count: u64::try_from(self.writes.len()).expect("test count fits u64"),
                head_receipt_sha256:
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                        .to_owned(),
                seal_file: "seal.json".to_owned(),
                seal_sha256:
                    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                        .to_owned(),
            })
        }
    }

    fn plan() -> MicroVmSupervisorPlan<'static> {
        MicroVmSupervisorPlan {
            run_id: "run-0123456789abcdef0123456789abcdef",
            workload_id: "seo-avengers-2500",
            source_sha256:
                "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            backend_id: "firecracker-microvm-v1",
            firecracker_exec: "/opt/walle/firecracker",
            firecracker_sha256:
                "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            jailer_exec: "/opt/walle/jailer",
            jailer_sha256:
                "sha256:4444444444444444444444444444444444444444444444444444444444444444",
            run_root: "/var/lib/walle/runs/run-0123456789abcdef0123456789abcdef",
            kernel_source: "/opt/walle/images/vmlinux",
            rootfs_source: "/opt/walle/images/rootfs.ext4",
            kernel_sha256:
                "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            rootfs_sha256:
                "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            jail_uid: 10001,
            jail_gid: 10001,
            cgroup: CgroupV2Plan {
                cpu_quota_us: 100_000,
                cpu_period_us: 100_000,
                memory_max_bytes: 512 * 1024 * 1024,
                pids_max: 128,
            },
            vcpu_count: 1,
            memory_mib: 512,
            scratch_disk_mib: 64,
            filesystem_mode: "SCRATCH_AND_DECLARED_OUTPUT",
            max_stdout_bytes: 4096,
            max_stderr_bytes: 4096,
            timeout_ms: 30_000,
            cancellation_grace_ms: 500,
            rootfs_read_only: true,
            network_interfaces: 0,
            guest_seccomp_required: true,
            guest_kernel_path: "/walle/kernel",
            guest_rootfs_path: "/walle/rootfs",
            guest_config_path: "/walle/firecracker-config.json",
            image_digest_verification_required: true,
            atomic_runtime_materialization_required: true,
            kill_on_timeout_required: true,
            kill_on_cancel_required: true,
            cgroup_cleanup_required: true,
        }
    }

    #[test]
    fn records_exact_plan_then_terminal_result_and_seals() {
        let plan = plan();
        let mut host = FakeHost::exited();
        let mut sink = FakeSink::healthy();

        let result = execute_with_sink(&mut host, &plan, &mut sink).expect("record lifecycle");

        assert_eq!(result.lifecycle.status, SupervisorTerminalStatus::Exited);
        assert_eq!(
            result.lifecycle.reason,
            SupervisorLifecycleReason::ProcessExited
        );
        assert_eq!(result.seal.entry_count, 2);
        assert!(sink.sealed);
        assert_eq!(
            sink.writes,
            vec![
                (
                    SUPERVISOR_PLAN_EVIDENCE_KIND.to_owned(),
                    plan.canonical_json(),
                ),
                (
                    SUPERVISOR_LIFECYCLE_EVIDENCE_KIND.to_owned(),
                    result.lifecycle.canonical_json(),
                ),
            ]
        );
        assert_eq!(
            host.events,
            vec![
                "verify",
                "prepare",
                "cgroup",
                "materialize",
                "spawn",
                "wait",
                "cleanup"
            ]
        );
    }

    #[test]
    fn blocked_lifecycle_is_still_persisted_and_sealed() {
        let plan = plan();
        let mut host = FakeHost::wait_failure();
        let mut sink = FakeSink::healthy();

        let result = execute_with_sink(&mut host, &plan, &mut sink).expect("record blocked result");

        assert_eq!(result.lifecycle.status, SupervisorTerminalStatus::Blocked);
        assert_eq!(
            result.lifecycle.reason,
            SupervisorLifecycleReason::WaitFailed
        );
        assert!(sink.sealed);
        assert_eq!(sink.writes.len(), 2);
        assert_eq!(sink.writes[1].1, result.lifecycle.canonical_json());
        assert_eq!(
            host.events,
            vec![
                "verify",
                "prepare",
                "cgroup",
                "materialize",
                "spawn",
                "wait",
                "terminate",
                "force",
                "cleanup",
            ]
        );
    }

    #[test]
    fn plan_write_failure_prevents_execution() {
        let plan = plan();
        let mut host = FakeHost::exited();
        let mut sink = FakeSink::fail_append_at(0);

        let result = execute_with_sink(&mut host, &plan, &mut sink);

        assert!(matches!(result, Err(EvidenceError::InvalidKind)));
        assert!(host.events.is_empty());
        assert!(!sink.sealed);
    }

    #[test]
    fn terminal_write_failure_prevents_seal_after_execution() {
        let plan = plan();
        let mut host = FakeHost::exited();
        let mut sink = FakeSink::fail_append_at(1);

        let result = execute_with_sink(&mut host, &plan, &mut sink);

        assert!(matches!(result, Err(EvidenceError::InvalidKind)));
        assert_eq!(
            host.events,
            vec![
                "verify",
                "prepare",
                "cgroup",
                "materialize",
                "spawn",
                "wait",
                "cleanup"
            ]
        );
        assert!(!sink.sealed);
    }
}
