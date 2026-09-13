use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

use walle_core::supervisor::MicroVmSupervisorPlan;
use walle_core::supervisor_lifecycle::{
    execute_supervisor_lifecycle, GracefulTerminationOutcome, MicroVmSupervisorHost, SpawnAttempt,
    SupervisorLifecycleReason, SupervisorLifecycleResult, SupervisorTerminalStatus, WaitOutcome,
};

use crate::artifact::SystemSha256;
use crate::evidence::{
    verify_evidence_chain, EvidenceError, EvidenceReceipt, EvidenceRun, EvidenceSeal,
};
use crate::host::LinuxMicroVmHost;

pub const SUPERVISOR_PLAN_EVIDENCE_KIND: &str = "supervisor-plan";
pub const SOURCE_IDENTITY_EVIDENCE_KIND: &str = "source-identity";
pub const RESOURCE_CONTROLS_EVIDENCE_KIND: &str = "resource-controls";
pub const RUNTIME_BINARY_IDENTITY_EVIDENCE_KIND: &str = "runtime-binary-identity";
pub const IMAGE_INTEGRITY_EVIDENCE_KIND: &str = "image-integrity";
pub const SUPERVISOR_OUTPUT_BOUNDS_EVIDENCE_KIND: &str = "supervisor-output-bounds";
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
    pub source_identity_receipt: EvidenceReceipt,
    pub resource_controls_receipt: Option<EvidenceReceipt>,
    pub runtime_binary_identity_receipt: Option<EvidenceReceipt>,
    pub image_integrity_receipt: Option<EvidenceReceipt>,
    pub output_bounds_receipt: Option<EvidenceReceipt>,
    pub lifecycle_receipt: EvidenceReceipt,
    pub seal: EvidenceSeal,
}

/// Owns one durable evidence chain that is cryptographically bound to the
/// supervisor plan's run id and source digest.
///
/// Construction does not execute the workload. `execute` first verifies that
/// the caller's plan is still bound to the exact run id/source digest captured
/// at `begin`, persists the canonical plan and a dedicated source-identity
/// receipt, then runs the concrete Linux lifecycle. A successful
/// `LinuxMicroVmHost::apply_cgroup` is tracked as the `RESOURCE_CONTROLS` proof
/// boundary because that implementation creates the exact cgroup-v2 leaf,
/// writes CPU/memory/PID limits and reads every limit back before returning
/// success. A successful materialization is the independent runtime/image
/// identity boundary. `OUTPUT_BOUNDS` is appended only for the concrete
/// terminal shape reached after Linux has joined both bounded output drains and
/// checked their overflow flags. The exact canonical terminal result is then
/// persisted, the chain is sealed, and all durable bytes are re-read and
/// verified before success can return.
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

    /// Executes only through the concrete Linux host. Keeping this public
    /// boundary concrete prevents a generic test/dummy host from manufacturing
    /// cgroup, runtime, image or output-bound receipts merely by returning
    /// success from trait methods.
    pub fn execute(
        &mut self,
        host: &mut LinuxMicroVmHost,
        plan: &MicroVmSupervisorPlan<'_>,
    ) -> Result<EvidencedSupervisorResult, SupervisorEvidenceError> {
        if plan.run_id != self.run_id || plan.source_sha256 != self.source_sha256 {
            return Err(SupervisorEvidenceError::PlanBindingMismatch);
        }
        let result = execute_with_sink(host, plan, &mut self.evidence)?;
        let mut receipts = Vec::with_capacity(7);
        receipts.push(result.plan_receipt.clone());
        receipts.push(result.source_identity_receipt.clone());
        if let Some(receipt) = result.resource_controls_receipt.as_ref() {
            receipts.push(receipt.clone());
        }
        if let Some(receipt) = result.runtime_binary_identity_receipt.as_ref() {
            receipts.push(receipt.clone());
        }
        if let Some(receipt) = result.image_integrity_receipt.as_ref() {
            receipts.push(receipt.clone());
        }
        if let Some(receipt) = result.output_bounds_receipt.as_ref() {
            receipts.push(receipt.clone());
        }
        receipts.push(result.lifecycle_receipt.clone());
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

/// Private lifecycle wrapper used to observe only successful proof boundaries.
/// The public caller is restricted to `LinuxMicroVmHost`: its cgroup path
/// writes and reads back the exact cgroup-v2 limits, while its materialization
/// path hashes each staged runtime/image artifact and fails closed on mismatch.
struct ProofTrackingHost<'a, H> {
    inner: &'a mut H,
    resource_controls_applied: bool,
    materialized: bool,
}

impl<'a, H> ProofTrackingHost<'a, H> {
    fn new(inner: &'a mut H) -> Self {
        Self {
            inner,
            resource_controls_applied: false,
            materialized: false,
        }
    }
}

impl<H: MicroVmSupervisorHost> MicroVmSupervisorHost for ProofTrackingHost<'_, H> {
    type Process = H::Process;
    type Error = H::Error;

    fn verify_inputs(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
        self.inner.verify_inputs(plan)
    }

    fn prepare_run_root(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
        self.inner.prepare_run_root(plan)
    }

    fn apply_cgroup(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
        let result = self.inner.apply_cgroup(plan);
        if result.is_ok() {
            self.resource_controls_applied = true;
        }
        result
    }

    fn materialize_runtime(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
        let result = self.inner.materialize_runtime(plan);
        if result.is_ok() {
            self.materialized = true;
        }
        result
    }

    fn spawn(
        &mut self,
        plan: &MicroVmSupervisorPlan<'_>,
    ) -> SpawnAttempt<Self::Process, Self::Error> {
        self.inner.spawn(plan)
    }

    fn wait(
        &mut self,
        process: &mut Self::Process,
        timeout_ms: u64,
    ) -> Result<WaitOutcome, Self::Error> {
        self.inner.wait(process, timeout_ms)
    }

    fn terminate_and_wait(
        &mut self,
        process: &mut Self::Process,
        grace_ms: u64,
    ) -> Result<GracefulTerminationOutcome, Self::Error> {
        self.inner.terminate_and_wait(process, grace_ms)
    }

    fn force_kill_and_reap(&mut self, process: &mut Self::Process) -> Result<(), Self::Error> {
        self.inner.force_kill_and_reap(process)
    }

    fn cleanup(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
        self.inner.cleanup(plan)
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
    let source_identity_json = source_identity_payload(plan);
    let source_identity_receipt = sink.append(
        SOURCE_IDENTITY_EVIDENCE_KIND,
        source_identity_json.as_bytes(),
    )?;

    let mut tracked_host = ProofTrackingHost::new(host);
    let lifecycle = execute_supervisor_lifecycle(&mut tracked_host, plan);

    let resource_controls_receipt = if tracked_host.resource_controls_applied {
        let payload = resource_controls_payload(plan);
        Some(sink.append(RESOURCE_CONTROLS_EVIDENCE_KIND, payload.as_bytes())?)
    } else {
        None
    };

    let (runtime_binary_identity_receipt, image_integrity_receipt) = if tracked_host.materialized {
        let runtime_payload = runtime_binary_identity_payload(plan);
        let runtime_receipt = sink.append(
            RUNTIME_BINARY_IDENTITY_EVIDENCE_KIND,
            runtime_payload.as_bytes(),
        )?;
        let image_payload = image_integrity_payload(plan);
        let image_receipt = sink.append(IMAGE_INTEGRITY_EVIDENCE_KIND, image_payload.as_bytes())?;
        (Some(runtime_receipt), Some(image_receipt))
    } else {
        (None, None)
    };

    let output_bounds_receipt = if proves_output_bounds(&lifecycle) {
        let payload = output_bounds_payload(plan);
        Some(sink.append(SUPERVISOR_OUTPUT_BOUNDS_EVIDENCE_KIND, payload.as_bytes())?)
    } else {
        None
    };

    let lifecycle_json = lifecycle.canonical_json();
    let lifecycle_receipt = sink.append(
        SUPERVISOR_LIFECYCLE_EVIDENCE_KIND,
        lifecycle_json.as_bytes(),
    )?;
    let seal = sink.seal()?;

    Ok(EvidencedSupervisorResult {
        lifecycle,
        plan_receipt,
        source_identity_receipt,
        resource_controls_receipt,
        runtime_binary_identity_receipt,
        image_integrity_receipt,
        output_bounds_receipt,
        lifecycle_receipt,
        seal,
    })
}

fn proves_output_bounds(lifecycle: &SupervisorLifecycleResult) -> bool {
    lifecycle.status == SupervisorTerminalStatus::Exited
        && lifecycle.reason == SupervisorLifecycleReason::ProcessExited
}

fn source_identity_payload(plan: &MicroVmSupervisorPlan<'_>) -> String {
    format!(
        concat!(
            "{{",
            "\"run_id\":\"{}\",",
            "\"source_sha256\":\"{}\",",
            "\"verification\":\"EVIDENCE_RUN_PLAN_SOURCE_BINDING_VERIFIED\"",
            "}}"
        ),
        plan.run_id, plan.source_sha256,
    )
}

fn resource_controls_payload(plan: &MicroVmSupervisorPlan<'_>) -> String {
    format!(
        concat!(
            "{{",
            "\"cpu_period_us\":{},",
            "\"cpu_quota_us\":{},",
            "\"memory_max_bytes\":{},",
            "\"pids_max\":{},",
            "\"run_id\":\"{}\",",
            "\"verification\":\"LINUX_CGROUP_V2_LIMITS_WRITTEN_READ_BACK_VERIFIED\"",
            "}}"
        ),
        plan.cgroup.cpu_period_us,
        plan.cgroup.cpu_quota_us,
        plan.cgroup.memory_max_bytes,
        plan.cgroup.pids_max,
        plan.run_id,
    )
}

fn runtime_binary_identity_payload(plan: &MicroVmSupervisorPlan<'_>) -> String {
    format!(
        concat!(
            "{{",
            "\"firecracker_sha256\":\"{}\",",
            "\"jailer_sha256\":\"{}\",",
            "\"run_id\":\"{}\",",
            "\"verification\":\"LINUX_MATERIALIZED_BYTES_SHA256_VERIFIED\"",
            "}}"
        ),
        plan.firecracker_sha256, plan.jailer_sha256, plan.run_id,
    )
}

fn image_integrity_payload(plan: &MicroVmSupervisorPlan<'_>) -> String {
    format!(
        concat!(
            "{{",
            "\"kernel_sha256\":\"{}\",",
            "\"rootfs_sha256\":\"{}\",",
            "\"run_id\":\"{}\",",
            "\"verification\":\"LINUX_MATERIALIZED_BYTES_SHA256_VERIFIED\"",
            "}}"
        ),
        plan.kernel_sha256, plan.rootfs_sha256, plan.run_id,
    )
}

fn output_bounds_payload(plan: &MicroVmSupervisorPlan<'_>) -> String {
    format!(
        concat!(
            "{{",
            "\"max_stderr_bytes\":{},",
            "\"max_stdout_bytes\":{},",
            "\"run_id\":\"{}\",",
            "\"verification\":\"LINUX_OUTPUT_DRAINS_JOINED_LIMITS_CHECKED\"",
            "}}"
        ),
        plan.max_stderr_bytes, plan.max_stdout_bytes, plan.run_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use walle_core::supervisor::{CgroupV2Plan, MicroVmSupervisorPlan};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct FakeError;

    struct FakeHost {
        events: Vec<&'static str>,
        cgroup: Result<(), FakeError>,
        materialize: Result<(), FakeError>,
        wait: Result<WaitOutcome, FakeError>,
    }

    impl FakeHost {
        fn exited() -> Self {
            Self {
                events: Vec::new(),
                cgroup: Ok(()),
                materialize: Ok(()),
                wait: Ok(WaitOutcome::Exited(0)),
            }
        }

        fn nonzero_exit() -> Self {
            Self {
                events: Vec::new(),
                cgroup: Ok(()),
                materialize: Ok(()),
                wait: Ok(WaitOutcome::Exited(9)),
            }
        }

        fn wait_failure() -> Self {
            Self {
                events: Vec::new(),
                cgroup: Ok(()),
                materialize: Ok(()),
                wait: Err(FakeError),
            }
        }

        fn materialization_failure() -> Self {
            Self {
                events: Vec::new(),
                cgroup: Ok(()),
                materialize: Err(FakeError),
                wait: Ok(WaitOutcome::Exited(0)),
            }
        }

        fn cgroup_failure() -> Self {
            Self {
                events: Vec::new(),
                cgroup: Err(FakeError),
                materialize: Ok(()),
                wait: Ok(WaitOutcome::Exited(0)),
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
            self.cgroup
        }

        fn materialize_runtime(
            &mut self,
            _plan: &MicroVmSupervisorPlan<'_>,
        ) -> Result<(), Self::Error> {
            self.events.push("materialize");
            self.materialize
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
            let nibble = char::from_digit(u32::try_from((next % 15) + 1).expect("nibble"), 16)
                .expect("hex nibble");
            Ok(EvidenceReceipt {
                sequence,
                kind: kind.to_owned(),
                payload_file: format!("{sequence:06}.payload"),
                payload_sha256: format!("sha256:{}", nibble.to_string().repeat(64)),
                payload_bytes: u64::try_from(payload.len()).expect("payload length fits u64"),
                previous_receipt_sha256: None,
                receipt_file: format!("{sequence:06}.receipt.json"),
                receipt_sha256: format!("sha256:{}", nibble.to_string().repeat(64)),
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
                head_receipt_sha256: self
                    .writes
                    .len()
                    .checked_sub(1)
                    .map(|index| {
                        let nibble =
                            char::from_digit(u32::try_from((index % 15) + 1).expect("nibble"), 16)
                                .expect("hex nibble");
                        format!("sha256:{}", nibble.to_string().repeat(64))
                    })
                    .unwrap_or_else(|| {
                        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                            .to_owned()
                    }),
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
    fn successful_run_persists_source_resource_runtime_image_output_and_lifecycle_receipts() {
        let plan = plan();
        let mut host = FakeHost::exited();
        let mut sink = FakeSink::healthy();

        let result = execute_with_sink(&mut host, &plan, &mut sink).expect("record lifecycle");

        assert_eq!(result.lifecycle.status, SupervisorTerminalStatus::Exited);
        assert_eq!(
            result.lifecycle.reason,
            SupervisorLifecycleReason::ProcessExited
        );
        assert_eq!(result.seal.entry_count, 7);
        assert_eq!(result.source_identity_receipt.kind, SOURCE_IDENTITY_EVIDENCE_KIND);
        assert!(result.resource_controls_receipt.is_some());
        assert!(result.runtime_binary_identity_receipt.is_some());
        assert!(result.image_integrity_receipt.is_some());
        assert!(result.output_bounds_receipt.is_some());
        assert!(sink.sealed);
        assert_eq!(sink.writes[0].0, SUPERVISOR_PLAN_EVIDENCE_KIND);
        assert_eq!(sink.writes[0].1, plan.canonical_json());
        assert_eq!(sink.writes[1].0, SOURCE_IDENTITY_EVIDENCE_KIND);
        assert_eq!(sink.writes[1].1, source_identity_payload(&plan));
        assert_eq!(sink.writes[2].0, RESOURCE_CONTROLS_EVIDENCE_KIND);
        assert_eq!(sink.writes[2].1, resource_controls_payload(&plan));
        assert_eq!(sink.writes[3].0, RUNTIME_BINARY_IDENTITY_EVIDENCE_KIND);
        assert_eq!(sink.writes[3].1, runtime_binary_identity_payload(&plan));
        assert_eq!(sink.writes[4].0, IMAGE_INTEGRITY_EVIDENCE_KIND);
        assert_eq!(sink.writes[4].1, image_integrity_payload(&plan));
        assert_eq!(sink.writes[5].0, SUPERVISOR_OUTPUT_BOUNDS_EVIDENCE_KIND);
        assert_eq!(sink.writes[5].1, output_bounds_payload(&plan));
        assert_eq!(sink.writes[6].0, SUPERVISOR_LIFECYCLE_EVIDENCE_KIND);
        assert_eq!(sink.writes[6].1, result.lifecycle.canonical_json());
        assert_ne!(result.source_identity_receipt.receipt_sha256, result.plan_receipt.receipt_sha256);
        assert_ne!(
            result.source_identity_receipt.receipt_sha256,
            result
                .resource_controls_receipt
                .as_ref()
                .expect("resource receipt")
                .receipt_sha256
        );
        assert_ne!(
            result
                .resource_controls_receipt
                .as_ref()
                .expect("resource receipt")
                .receipt_sha256,
            result
                .runtime_binary_identity_receipt
                .as_ref()
                .expect("runtime receipt")
                .receipt_sha256
        );
    }

    #[test]
    fn cgroup_failure_keeps_source_identity_but_cannot_emit_resource_or_later_proof() {
        let plan = plan();
        let mut host = FakeHost::cgroup_failure();
        let mut sink = FakeSink::healthy();

        let result = execute_with_sink(&mut host, &plan, &mut sink).expect("record blocked result");

        assert_eq!(result.lifecycle.status, SupervisorTerminalStatus::Blocked);
        assert_eq!(
            result.lifecycle.reason,
            SupervisorLifecycleReason::CgroupApplicationFailed
        );
        assert_eq!(result.source_identity_receipt.kind, SOURCE_IDENTITY_EVIDENCE_KIND);
        assert!(result.resource_controls_receipt.is_none());
        assert!(result.runtime_binary_identity_receipt.is_none());
        assert!(result.image_integrity_receipt.is_none());
        assert!(result.output_bounds_receipt.is_none());
        assert_eq!(result.seal.entry_count, 3);
        assert_eq!(host.events, vec!["verify", "prepare", "cgroup", "cleanup"]);
    }

    #[test]
    fn materialization_failure_keeps_verified_source_and_resource_proof_only() {
        let plan = plan();
        let mut host = FakeHost::materialization_failure();
        let mut sink = FakeSink::healthy();

        let result = execute_with_sink(&mut host, &plan, &mut sink).expect("record blocked result");

        assert_eq!(result.lifecycle.status, SupervisorTerminalStatus::Blocked);
        assert_eq!(
            result.lifecycle.reason,
            SupervisorLifecycleReason::MaterializationFailed
        );
        assert_eq!(result.source_identity_receipt.kind, SOURCE_IDENTITY_EVIDENCE_KIND);
        assert!(result.resource_controls_receipt.is_some());
        assert!(result.runtime_binary_identity_receipt.is_none());
        assert!(result.image_integrity_receipt.is_none());
        assert!(result.output_bounds_receipt.is_none());
        assert_eq!(result.seal.entry_count, 4);
        assert_eq!(sink.writes[2].0, RESOURCE_CONTROLS_EVIDENCE_KIND);
    }

    #[test]
    fn nonzero_exit_keeps_source_resource_and_output_proof() {
        let plan = plan();
        let mut host = FakeHost::nonzero_exit();
        let mut sink = FakeSink::healthy();

        let result = execute_with_sink(&mut host, &plan, &mut sink).expect("record lifecycle");

        assert_eq!(result.lifecycle.exit_code, Some(9));
        assert_eq!(result.source_identity_receipt.kind, SOURCE_IDENTITY_EVIDENCE_KIND);
        assert!(result.resource_controls_receipt.is_some());
        assert!(result.output_bounds_receipt.is_some());
        assert_eq!(result.seal.entry_count, 7);
    }

    #[test]
    fn wait_failure_keeps_prior_proof_but_not_output_bounds() {
        let plan = plan();
        let mut host = FakeHost::wait_failure();
        let mut sink = FakeSink::healthy();

        let result = execute_with_sink(&mut host, &plan, &mut sink).expect("record blocked result");

        assert_eq!(result.lifecycle.status, SupervisorTerminalStatus::Blocked);
        assert_eq!(
            result.lifecycle.reason,
            SupervisorLifecycleReason::WaitFailed
        );
        assert_eq!(result.source_identity_receipt.kind, SOURCE_IDENTITY_EVIDENCE_KIND);
        assert!(result.resource_controls_receipt.is_some());
        assert!(result.runtime_binary_identity_receipt.is_some());
        assert!(result.image_integrity_receipt.is_some());
        assert!(result.output_bounds_receipt.is_none());
        assert_eq!(result.seal.entry_count, 6);
        assert!(sink.sealed);
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
    fn source_identity_write_failure_prevents_execution() {
        let plan = plan();
        let mut host = FakeHost::exited();
        let mut sink = FakeSink::fail_append_at(1);

        let result = execute_with_sink(&mut host, &plan, &mut sink);

        assert!(matches!(result, Err(EvidenceError::InvalidKind)));
        assert_eq!(sink.writes.len(), 1);
        assert_eq!(sink.writes[0].0, SUPERVISOR_PLAN_EVIDENCE_KIND);
        assert!(host.events.is_empty());
        assert!(!sink.sealed);
    }

    #[test]
    fn resource_write_failure_prevents_seal_after_verified_cgroup_application() {
        let plan = plan();
        let mut host = FakeHost::exited();
        let mut sink = FakeSink::fail_append_at(2);

        let result = execute_with_sink(&mut host, &plan, &mut sink);

        assert!(matches!(result, Err(EvidenceError::InvalidKind)));
        assert!(!sink.sealed);
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
    fn output_bounds_write_failure_prevents_seal_after_verified_exit() {
        let plan = plan();
        let mut host = FakeHost::exited();
        let mut sink = FakeSink::fail_append_at(5);

        let result = execute_with_sink(&mut host, &plan, &mut sink);

        assert!(matches!(result, Err(EvidenceError::InvalidKind)));
        assert!(!sink.sealed);
    }

    #[test]
    fn terminal_write_failure_prevents_seal_after_execution() {
        let plan = plan();
        let mut host = FakeHost::exited();
        let mut sink = FakeSink::fail_append_at(6);

        let result = execute_with_sink(&mut host, &plan, &mut sink);

        assert!(matches!(result, Err(EvidenceError::InvalidKind)));
        assert!(!sink.sealed);
    }
}
