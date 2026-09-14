use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io::Read;
use std::path::{Path, PathBuf};

use walle_core::isolation::{
    assess_isolation_host, collect_isolation_host_facts, IsolationHostAssessment,
    IsolationHostVerdict,
};
use walle_core::supervisor::MicroVmSupervisorPlan;
use walle_core::supervisor_lifecycle::{
    execute_supervisor_lifecycle, GracefulTerminationOutcome, MicroVmSupervisorHost, SpawnAttempt,
    SupervisorLifecycleReason, SupervisorLifecycleResult, SupervisorTerminalStatus, WaitOutcome,
};

use crate::artifact::{open_regular_no_symlinks, SystemSha256};
use crate::evidence::{
    verify_evidence_chain, EvidenceError, EvidenceReceipt, EvidenceRun, EvidenceSeal,
};
use crate::firecracker::{RUN_ID_BOOT_ARG_PREFIX, SOURCE_SHA_BOOT_ARG_PREFIX};
use crate::guest_protocol::parse_guest_attestation;
use crate::host::LinuxMicroVmHost;
use crate::host_facts::{collect_linux_host_facts, HostPreflightVerdict, LinuxHostFacts};

pub const SUPERVISOR_PLAN_EVIDENCE_KIND: &str = "supervisor-plan";
pub const SOURCE_IDENTITY_EVIDENCE_KIND: &str = "source-identity";
pub const HOST_ISOLATION_EVIDENCE_KIND: &str = "host-isolation";
pub const MICROVM_BOOT_EVIDENCE_KIND: &str = "microvm-boot";
pub const GUEST_ATTESTATION_CANDIDATE_EVIDENCE_KIND: &str = "guest-attestation-candidate";
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
    pub host_isolation_receipt: Option<EvidenceReceipt>,
    pub microvm_boot_receipt: Option<EvidenceReceipt>,
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
/// receipt, and then probes the live Linux host. `HOST_ISOLATION` is persisted
/// only when two independent concrete probes agree that the current process is
/// on Linux x86_64, privileged, has usable KVM API 12, cgroup v2/controllers,
/// host seccomp support, and observable root/proc/cgroup-v2 mounts. A missing,
/// denied or inconsistent prerequisite produces no host-isolation proof.
///
/// `MICROVM_BOOT` is materially different from process-spawn evidence. The
/// concrete Firecracker configuration injects the exact run id and source hash
/// into the guest kernel command line. Before cleanup removes the private run
/// root, this layer opens the bounded serial stdout log with no-symlink Linux
/// resolution and requires a guest `Linux version` banner plus both exact
/// bindings. The same concrete serial capture may also persist one strict
/// `guest-attestation-candidate` receipt, but that payload retains the explicit
/// `UNTRUSTED_GUEST_CLAIM_PENDING_AGENT_IDENTITY` marker and is never projected
/// as guest-seccomp, network-isolation or guest-completion certification proof.
/// Generic/fake lifecycle hosts never enable this physical capture.
///
/// A successful `LinuxMicroVmHost::apply_cgroup` is tracked as the
/// `RESOURCE_CONTROLS` proof boundary because that implementation creates the
/// exact cgroup-v2 leaf, writes CPU/memory/PID limits and reads every limit back
/// before returning success. A successful materialization is the independent
/// runtime/image identity boundary. `OUTPUT_BOUNDS` is appended only for the
/// concrete terminal shape reached after Linux has joined both bounded output
/// drains and checked their overflow flags. The exact canonical terminal result
/// is then persisted, the chain is sealed, and all durable bytes are re-read and
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
    /// physical boot, host-isolation, guest-attestation, cgroup, runtime, image
    /// or output-bound receipts merely by returning success from trait methods.
    pub fn execute(
        &mut self,
        host: &mut LinuxMicroVmHost,
        plan: &MicroVmSupervisorPlan<'_>,
    ) -> Result<EvidencedSupervisorResult, SupervisorEvidenceError> {
        if plan.run_id != self.run_id || plan.source_sha256 != self.source_sha256 {
            return Err(SupervisorEvidenceError::PlanBindingMismatch);
        }
        let host_isolation_payload = collect_host_isolation_payload(plan);
        let (result, guest_attestation_candidate_receipt) =
            execute_with_sink_and_host_isolation_capture(
                host,
                plan,
                &mut self.evidence,
                host_isolation_payload.as_deref(),
                true,
            )?;
        let mut receipts = Vec::with_capacity(10);
        receipts.push(result.plan_receipt.clone());
        receipts.push(result.source_identity_receipt.clone());
        if let Some(receipt) = result.host_isolation_receipt.as_ref() {
            receipts.push(receipt.clone());
        }
        if let Some(receipt) = result.microvm_boot_receipt.as_ref() {
            receipts.push(receipt.clone());
        }
        if let Some(receipt) = guest_attestation_candidate_receipt.as_ref() {
            receipts.push(receipt.clone());
        }
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
    capture_physical_boot: bool,
    microvm_boot_payload: Option<String>,
    guest_attestation_candidate_payload: Option<String>,
    resource_controls_applied: bool,
    materialized: bool,
}

impl<'a, H> ProofTrackingHost<'a, H> {
    fn new(inner: &'a mut H, capture_physical_boot: bool) -> Self {
        Self {
            inner,
            capture_physical_boot,
            microvm_boot_payload: None,
            guest_attestation_candidate_payload: None,
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
        if self.capture_physical_boot
            && (self.microvm_boot_payload.is_none()
                || self.guest_attestation_candidate_payload.is_none())
        {
            if let Some(serial) = read_bounded_serial(plan) {
                if self.microvm_boot_payload.is_none()
                    && serial_bytes_prove_microvm_boot(plan, &serial)
                {
                    self.microvm_boot_payload = Some(microvm_boot_payload(plan));
                }
                if self.guest_attestation_candidate_payload.is_none() {
                    self.guest_attestation_candidate_payload =
                        guest_attestation_candidate_payload(plan, &serial);
                }
            }
        }
        self.inner.cleanup(plan)
    }
}

#[cfg(test)]
fn execute_with_sink<H, S>(
    host: &mut H,
    plan: &MicroVmSupervisorPlan<'_>,
    sink: &mut S,
) -> Result<EvidencedSupervisorResult, EvidenceError>
where
    H: MicroVmSupervisorHost,
    S: SupervisorEvidenceSink,
{
    execute_with_sink_and_host_isolation(host, plan, sink, None, false)
}

#[cfg(test)]
fn execute_with_sink_and_host_isolation<H, S>(
    host: &mut H,
    plan: &MicroVmSupervisorPlan<'_>,
    sink: &mut S,
    host_isolation_payload: Option<&str>,
    capture_physical_boot: bool,
) -> Result<EvidencedSupervisorResult, EvidenceError>
where
    H: MicroVmSupervisorHost,
    S: SupervisorEvidenceSink,
{
    execute_with_sink_and_host_isolation_capture(
        host,
        plan,
        sink,
        host_isolation_payload,
        capture_physical_boot,
    )
    .map(|(result, _candidate)| result)
}

fn execute_with_sink_and_host_isolation_capture<H, S>(
    host: &mut H,
    plan: &MicroVmSupervisorPlan<'_>,
    sink: &mut S,
    host_isolation_payload: Option<&str>,
    capture_physical_boot: bool,
) -> Result<(EvidencedSupervisorResult, Option<EvidenceReceipt>), EvidenceError>
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
    let host_isolation_receipt = match host_isolation_payload {
        Some(payload) => Some(sink.append(HOST_ISOLATION_EVIDENCE_KIND, payload.as_bytes())?),
        None => None,
    };

    let mut tracked_host = ProofTrackingHost::new(host, capture_physical_boot);
    let lifecycle = execute_supervisor_lifecycle(&mut tracked_host, plan);

    let microvm_boot_receipt = match tracked_host.microvm_boot_payload.as_deref() {
        Some(payload) => Some(sink.append(MICROVM_BOOT_EVIDENCE_KIND, payload.as_bytes())?),
        None => None,
    };
    let guest_attestation_candidate_receipt =
        match tracked_host.guest_attestation_candidate_payload.as_deref() {
            Some(payload) => Some(sink.append(
                GUEST_ATTESTATION_CANDIDATE_EVIDENCE_KIND,
                payload.as_bytes(),
            )?),
            None => None,
        };

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

    Ok((
        EvidencedSupervisorResult {
            lifecycle,
            plan_receipt,
            source_identity_receipt,
            host_isolation_receipt,
            microvm_boot_receipt,
            resource_controls_receipt,
            runtime_binary_identity_receipt,
            image_integrity_receipt,
            output_bounds_receipt,
            lifecycle_receipt,
            seal,
        },
        guest_attestation_candidate_receipt,
    ))
}

fn proves_output_bounds(lifecycle: &SupervisorLifecycleResult) -> bool {
    lifecycle.status == SupervisorTerminalStatus::Exited
        && lifecycle.reason == SupervisorLifecycleReason::ProcessExited
}

fn collect_host_isolation_payload(plan: &MicroVmSupervisorPlan<'_>) -> Option<String> {
    let linux_facts = collect_linux_host_facts().ok()?;
    let isolation = assess_isolation_host(collect_isolation_host_facts());
    host_isolation_payload(plan, &linux_facts, &isolation)
}

fn host_isolation_payload(
    plan: &MicroVmSupervisorPlan<'_>,
    linux_facts: &LinuxHostFacts,
    isolation: &IsolationHostAssessment,
) -> Option<String> {
    if linux_facts.preflight_verdict() != HostPreflightVerdict::Ready
        || isolation.verdict != IsolationHostVerdict::Ready
        || !isolation.linux_verified
        || !isolation.x86_64_verified
        || !isolation.privileged_supervisor_verified
        || !isolation.kvm_verified
        || !isolation.cgroup_v2_verified
        || !isolation.cgroup_controllers_verified
        || !isolation.seccomp_verified
    {
        return None;
    }
    let effective_uid = isolation.facts.effective_uid?;
    let kvm_api_version = isolation.facts.kvm_api_version?;

    Some(format!(
        concat!(
            "{{",
            "\"architecture\":\"{}\",",
            "\"cgroup_controllers_verified\":true,",
            "\"cgroup_v2_verified\":true,",
            "\"effective_uid\":{},",
            "\"host_facts\":{},",
            "\"kvm_api_version\":{},",
            "\"kvm_verified\":true,",
            "\"linux_verified\":true,",
            "\"os\":\"{}\",",
            "\"privileged_supervisor_verified\":true,",
            "\"run_id\":\"{}\",",
            "\"seccomp_verified\":true,",
            "\"source_sha256\":\"{}\",",
            "\"verification\":\"LIVE_LINUX_X86_64_KVM_CGROUP_SECCOMP_PREFLIGHT_READY\",",
            "\"x86_64_verified\":true",
            "}}"
        ),
        isolation.facts.architecture,
        effective_uid,
        linux_facts.canonical_json(),
        kvm_api_version,
        isolation.facts.os,
        plan.run_id,
        plan.source_sha256,
    ))
}

fn read_bounded_serial(plan: &MicroVmSupervisorPlan<'_>) -> Option<Vec<u8>> {
    let stdout_path = Path::new(plan.run_root).join("stdout.log");
    let file = open_regular_no_symlinks(&stdout_path).ok()?;
    let mut serial = Vec::new();
    file.take(plan.max_stdout_bytes.saturating_add(1))
        .read_to_end(&mut serial)
        .ok()?;
    (u64::try_from(serial.len()).ok()? <= plan.max_stdout_bytes).then_some(serial)
}

fn serial_bytes_prove_microvm_boot(plan: &MicroVmSupervisorPlan<'_>, serial: &[u8]) -> bool {
    let run_binding = format!("{RUN_ID_BOOT_ARG_PREFIX}{}", plan.run_id);
    let source_binding = format!("{SOURCE_SHA_BOOT_ARG_PREFIX}{}", plan.source_sha256);
    contains_bytes(serial, b"Linux version ")
        && contains_bytes(serial, run_binding.as_bytes())
        && contains_bytes(serial, source_binding.as_bytes())
}

fn guest_attestation_candidate_payload(
    plan: &MicroVmSupervisorPlan<'_>,
    serial: &[u8],
) -> Option<String> {
    if !serial_bytes_prove_microvm_boot(plan, serial) {
        return None;
    }
    parse_guest_attestation(serial, plan.run_id, plan.source_sha256)
        .map(|attestation| attestation.canonical_json())
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn microvm_boot_payload(plan: &MicroVmSupervisorPlan<'_>) -> String {
    format!(
        concat!(
            "{{",
            "\"kernel_sha256\":\"{}\",",
            "\"rootfs_sha256\":\"{}\",",
            "\"run_id\":\"{}\",",
            "\"source_sha256\":\"{}\",",
            "\"verification\":\"FIRECRACKER_GUEST_SERIAL_KERNEL_BOOT_BOUND_TO_RUN_SOURCE\"",
            "}}"
        ),
        plan.kernel_sha256, plan.rootfs_sha256, plan.run_id, plan.source_sha256,
    )
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
    use crate::host_facts::{KvmObservation, MountObservation};
    use walle_core::isolation::IsolationHostFacts;
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

    fn mount(mount_point: &str, fs_type: &str, source: &str) -> MountObservation {
        MountObservation {
            mount_point: mount_point.to_owned(),
            fs_type: fs_type.to_owned(),
            source: source.to_owned(),
        }
    }

    fn ready_linux_facts() -> LinuxHostFacts {
        LinuxHostFacts {
            kernel_release: "6.8.0-test".to_owned(),
            kvm: KvmObservation::Usable { api_version: 12 },
            root_mount: Some(mount("/", "ext4", "/dev/vda1")),
            proc_mount: Some(mount("/proc", "proc", "proc")),
            cgroup_v2_mounts: vec![mount("/sys/fs/cgroup", "cgroup2", "cgroup")],
        }
    }

    fn ready_isolation_assessment() -> IsolationHostAssessment {
        IsolationHostAssessment {
            facts: IsolationHostFacts {
                os: "linux".to_owned(),
                architecture: "x86_64".to_owned(),
                effective_uid: Some(0),
                kvm_exists: true,
                kvm_is_character_device: true,
                kvm_open_read_write: true,
                kvm_api_version: Some(12),
                kvm_api_compatible: true,
                cgroup_v2: true,
                cgroup_controllers: vec![
                    "cpu".to_owned(),
                    "io".to_owned(),
                    "memory".to_owned(),
                    "pids".to_owned(),
                ],
                seccomp_actions: vec!["errno".to_owned(), "kill_process".to_owned()],
            },
            linux_verified: true,
            x86_64_verified: true,
            privileged_supervisor_verified: true,
            kvm_verified: true,
            cgroup_v2_verified: true,
            cgroup_controllers_verified: true,
            seccomp_verified: true,
            verdict: IsolationHostVerdict::Ready,
            reason: "MICROVM_HOST_PREREQUISITES_READY",
        }
    }

    #[test]
    fn host_isolation_payload_requires_both_live_preflights_to_be_ready() {
        let plan = plan();
        let linux = ready_linux_facts();
        let isolation = ready_isolation_assessment();
        let payload = host_isolation_payload(&plan, &linux, &isolation).expect("host proof");

        assert!(payload.contains("\"kvm_api_version\":12"));
        assert!(payload.contains("\"preflight\":\"READY\""));
        assert!(payload.contains("\"run_id\":\"run-0123456789abcdef0123456789abcdef\""));
        assert!(payload.contains("LIVE_LINUX_X86_64_KVM_CGROUP_SECCOMP_PREFLIGHT_READY"));

        let mut blocked_linux = linux.clone();
        blocked_linux.kvm = KvmObservation::Missing;
        assert!(host_isolation_payload(&plan, &blocked_linux, &isolation).is_none());

        let mut blocked_isolation = isolation.clone();
        blocked_isolation.verdict = IsolationHostVerdict::Unavailable;
        assert!(host_isolation_payload(&plan, &linux, &blocked_isolation).is_none());
    }

    #[test]
    fn physical_boot_serial_requires_kernel_banner_and_exact_run_source_bindings() {
        let plan = plan();
        let valid = format!(
            "[    0.000000] Linux version 6.8.0-walle\n[    0.000000] Kernel command line: console=ttyS0 {RUN_ID_BOOT_ARG_PREFIX}{} {SOURCE_SHA_BOOT_ARG_PREFIX}{}\n",
            plan.run_id, plan.source_sha256
        );
        assert!(serial_bytes_prove_microvm_boot(&plan, valid.as_bytes()));

        let wrong_run = valid.replace(plan.run_id, "run-ffffffffffffffffffffffffffffffff");
        assert!(!serial_bytes_prove_microvm_boot(
            &plan,
            wrong_run.as_bytes()
        ));
        let wrong_source = valid.replace(
            plan.source_sha256,
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        );
        assert!(!serial_bytes_prove_microvm_boot(
            &plan,
            wrong_source.as_bytes()
        ));
        let no_kernel = valid.replace("Linux version ", "guest text ");
        assert!(!serial_bytes_prove_microvm_boot(
            &plan,
            no_kernel.as_bytes()
        ));

        let payload = microvm_boot_payload(&plan);
        assert!(payload.contains(plan.run_id));
        assert!(payload.contains(plan.source_sha256));
        assert!(payload.contains(plan.kernel_sha256));
        assert!(payload.contains(plan.rootfs_sha256));
    }

    #[test]
    fn guest_attestation_candidate_requires_physical_boot_and_remains_untrusted() {
        let plan = plan();
        let line = format!(
            "WALLE_GUEST_ATTESTATION_V1 run_id={} source_sha256={} seccomp_mode=2 seccomp_policy=WALLE_GUEST_SECCOMP_V1 no_new_privs=1 network_non_loopback_interfaces=0 workload_exit_code=0 completion=SUCCESS",
            plan.run_id, plan.source_sha256
        );
        let serial = format!(
            "[    0.000000] Linux version 6.8.0-walle\n[    0.000000] Kernel command line: console=ttyS0 {RUN_ID_BOOT_ARG_PREFIX}{} {SOURCE_SHA_BOOT_ARG_PREFIX}{}\n{line}\n",
            plan.run_id, plan.source_sha256
        );
        let payload = guest_attestation_candidate_payload(&plan, serial.as_bytes())
            .expect("identity-bound physical guest candidate");
        assert!(payload.contains("\"seccomp_mode\":2"));
        assert!(payload.contains("\"seccomp_policy\":\"WALLE_GUEST_SECCOMP_V1\""));
        assert!(payload.contains("\"network_non_loopback_interfaces\":0"));
        assert!(payload.contains("\"completion\":\"SUCCESS\""));
        assert!(payload.contains("UNTRUSTED_GUEST_CLAIM_PENDING_AGENT_IDENTITY"));

        let no_kernel = format!("host text\n{line}\n");
        assert!(guest_attestation_candidate_payload(&plan, no_kernel.as_bytes()).is_none());

        let duplicate = format!("{serial}{line}\n");
        assert!(guest_attestation_candidate_payload(&plan, duplicate.as_bytes()).is_none());
    }

    #[test]
    fn explicit_host_isolation_receipt_is_persisted_before_lifecycle() {
        let plan = plan();
        let mut host = FakeHost::exited();
        let mut sink = FakeSink::healthy();
        let payload =
            host_isolation_payload(&plan, &ready_linux_facts(), &ready_isolation_assessment())
                .expect("host payload");

        let result = execute_with_sink_and_host_isolation(
            &mut host,
            &plan,
            &mut sink,
            Some(&payload),
            false,
        )
        .expect("record lifecycle");

        assert_eq!(result.seal.entry_count, 8);
        assert_eq!(
            result
                .host_isolation_receipt
                .as_ref()
                .expect("host receipt")
                .kind,
            HOST_ISOLATION_EVIDENCE_KIND
        );
        assert!(result.microvm_boot_receipt.is_none());
        assert_eq!(sink.writes[2].0, HOST_ISOLATION_EVIDENCE_KIND);
        assert_eq!(sink.writes[2].1, payload);
        assert_ne!(
            result
                .host_isolation_receipt
                .as_ref()
                .expect("host receipt")
                .receipt_sha256,
            result.source_identity_receipt.receipt_sha256
        );
    }

    #[test]
    fn host_isolation_write_failure_prevents_execution() {
        let plan = plan();
        let mut host = FakeHost::exited();
        let mut sink = FakeSink::fail_append_at(2);
        let payload =
            host_isolation_payload(&plan, &ready_linux_facts(), &ready_isolation_assessment())
                .expect("host payload");

        let result = execute_with_sink_and_host_isolation(
            &mut host,
            &plan,
            &mut sink,
            Some(&payload),
            false,
        );

        assert!(matches!(result, Err(EvidenceError::InvalidKind)));
        assert!(host.events.is_empty());
        assert!(!sink.sealed);
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
        assert_eq!(
            result.source_identity_receipt.kind,
            SOURCE_IDENTITY_EVIDENCE_KIND
        );
        assert!(result.host_isolation_receipt.is_none());
        assert!(result.microvm_boot_receipt.is_none());
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
        assert_ne!(
            result.source_identity_receipt.receipt_sha256,
            result.plan_receipt.receipt_sha256
        );
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
        assert_eq!(
            result.source_identity_receipt.kind,
            SOURCE_IDENTITY_EVIDENCE_KIND
        );
        assert!(result.host_isolation_receipt.is_none());
        assert!(result.microvm_boot_receipt.is_none());
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
        assert_eq!(
            result.source_identity_receipt.kind,
            SOURCE_IDENTITY_EVIDENCE_KIND
        );
        assert!(result.host_isolation_receipt.is_none());
        assert!(result.microvm_boot_receipt.is_none());
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
        assert_eq!(
            result.source_identity_receipt.kind,
            SOURCE_IDENTITY_EVIDENCE_KIND
        );
        assert!(result.host_isolation_receipt.is_none());
        assert!(result.microvm_boot_receipt.is_none());
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
        assert_eq!(
            result.source_identity_receipt.kind,
            SOURCE_IDENTITY_EVIDENCE_KIND
        );
        assert!(result.host_isolation_receipt.is_none());
        assert!(result.microvm_boot_receipt.is_none());
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
