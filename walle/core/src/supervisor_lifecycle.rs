use crate::supervisor::MicroVmSupervisorPlan;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorTerminalStatus {
    Exited,
    TimedOut,
    Cancelled,
    Blocked,
}

impl SupervisorTerminalStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Exited => "EXITED",
            Self::TimedOut => "TIMED_OUT",
            Self::Cancelled => "CANCELLED",
            Self::Blocked => "BLOCKED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorLifecycleReason {
    ProcessExited,
    InputVerificationFailed,
    RunRootPreparationFailed,
    CgroupApplicationFailed,
    MaterializationFailed,
    SpawnFailed,
    WaitFailed,
    TimeoutContained,
    CancellationContained,
    ContainmentFailed,
    CleanupFailed,
}

impl SupervisorLifecycleReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProcessExited => "PROCESS_EXITED",
            Self::InputVerificationFailed => "INPUT_VERIFICATION_FAILED",
            Self::RunRootPreparationFailed => "RUN_ROOT_PREPARATION_FAILED",
            Self::CgroupApplicationFailed => "CGROUP_APPLICATION_FAILED",
            Self::MaterializationFailed => "MATERIALIZATION_FAILED",
            Self::SpawnFailed => "SPAWN_FAILED",
            Self::WaitFailed => "WAIT_FAILED",
            Self::TimeoutContained => "TIMEOUT_CONTAINED",
            Self::CancellationContained => "CANCELLATION_CONTAINED",
            Self::ContainmentFailed => "CONTAINMENT_FAILED",
            Self::CleanupFailed => "CLEANUP_FAILED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainmentMode {
    Graceful,
    Forced,
}

impl ContainmentMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Graceful => "GRACEFUL",
            Self::Forced => "FORCED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisorLifecycleResult {
    pub status: SupervisorTerminalStatus,
    pub reason: SupervisorLifecycleReason,
    pub exit_code: Option<i32>,
    pub containment: Option<ContainmentMode>,
}

impl SupervisorLifecycleResult {
    pub fn canonical_json(self) -> String {
        let exit_code = self
            .exit_code
            .map_or_else(|| "null".to_owned(), |value| value.to_string());
        let containment = self.containment.map_or_else(
            || "null".to_owned(),
            |value| format!("\"{}\"", value.as_str()),
        );
        format!(
            concat!(
                "{{",
                "\"containment\":{},",
                "\"exit_code\":{},",
                "\"reason\":\"{}\",",
                "\"status\":\"{}\"",
                "}}"
            ),
            containment,
            exit_code,
            self.reason.as_str(),
            self.status.as_str(),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitOutcome {
    Exited(i32),
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GracefulTerminationOutcome {
    Exited,
    StillRunning,
}

#[derive(Debug)]
pub enum SpawnAttempt<P, E> {
    Running(P),
    Failed { error: E, process: Option<P> },
}

/// Host implementations own the side effects. The orchestrator owns ordering,
/// containment, and the rule that cleanup cannot promote an unsafe run.
///
/// `verify_inputs` must be read-only. `spawn` must return a process handle in
/// the failure variant whenever a child may have been created. `force_kill_and_reap`
/// may return `Ok(())` only after the process can no longer execute.
pub trait MicroVmSupervisorHost {
    type Process;
    type Error;

    fn verify_inputs(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error>;
    fn prepare_run_root(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error>;
    fn apply_cgroup(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error>;
    fn materialize_runtime(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error>;
    fn spawn(
        &mut self,
        plan: &MicroVmSupervisorPlan<'_>,
    ) -> SpawnAttempt<Self::Process, Self::Error>;
    fn wait(
        &mut self,
        process: &mut Self::Process,
        timeout_ms: u64,
    ) -> Result<WaitOutcome, Self::Error>;
    fn terminate_and_wait(
        &mut self,
        process: &mut Self::Process,
        grace_ms: u64,
    ) -> Result<GracefulTerminationOutcome, Self::Error>;
    fn force_kill_and_reap(&mut self, process: &mut Self::Process) -> Result<(), Self::Error>;
    fn cleanup(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error>;
}

pub fn execute_supervisor_lifecycle<H: MicroVmSupervisorHost>(
    host: &mut H,
    plan: &MicroVmSupervisorPlan<'_>,
) -> SupervisorLifecycleResult {
    if host.verify_inputs(plan).is_err() {
        return blocked(SupervisorLifecycleReason::InputVerificationFailed, None);
    }
    if host.prepare_run_root(plan).is_err() {
        return blocked_after_cleanup(
            host,
            plan,
            SupervisorLifecycleReason::RunRootPreparationFailed,
            None,
        );
    }
    if host.apply_cgroup(plan).is_err() {
        return blocked_after_cleanup(
            host,
            plan,
            SupervisorLifecycleReason::CgroupApplicationFailed,
            None,
        );
    }
    if host.materialize_runtime(plan).is_err() {
        return blocked_after_cleanup(
            host,
            plan,
            SupervisorLifecycleReason::MaterializationFailed,
            None,
        );
    }

    let mut process = match host.spawn(plan) {
        SpawnAttempt::Running(process) => process,
        SpawnAttempt::Failed { error: _, process } => {
            if let Some(mut process) = process {
                if host.force_kill_and_reap(&mut process).is_err() {
                    return blocked(SupervisorLifecycleReason::ContainmentFailed, None);
                }
                return blocked_after_cleanup(
                    host,
                    plan,
                    SupervisorLifecycleReason::SpawnFailed,
                    Some(ContainmentMode::Forced),
                );
            }
            return blocked_after_cleanup(host, plan, SupervisorLifecycleReason::SpawnFailed, None);
        }
    };

    match host.wait(&mut process, plan.timeout_ms) {
        Ok(WaitOutcome::Exited(exit_code)) => {
            if host.cleanup(plan).is_err() {
                return blocked(SupervisorLifecycleReason::CleanupFailed, None);
            }
            SupervisorLifecycleResult {
                status: SupervisorTerminalStatus::Exited,
                reason: SupervisorLifecycleReason::ProcessExited,
                exit_code: Some(exit_code),
                containment: None,
            }
        }
        Ok(WaitOutcome::TimedOut) => finish_contained_terminal(
            host,
            plan,
            &mut process,
            SupervisorTerminalStatus::TimedOut,
            SupervisorLifecycleReason::TimeoutContained,
        ),
        Ok(WaitOutcome::Cancelled) => finish_contained_terminal(
            host,
            plan,
            &mut process,
            SupervisorTerminalStatus::Cancelled,
            SupervisorLifecycleReason::CancellationContained,
        ),
        Err(_) => {
            let containment = match contain_process(host, &mut process, plan.cancellation_grace_ms)
            {
                Some(containment) => containment,
                None => return blocked(SupervisorLifecycleReason::ContainmentFailed, None),
            };
            blocked_after_cleanup(
                host,
                plan,
                SupervisorLifecycleReason::WaitFailed,
                Some(containment),
            )
        }
    }
}

fn finish_contained_terminal<H: MicroVmSupervisorHost>(
    host: &mut H,
    plan: &MicroVmSupervisorPlan<'_>,
    process: &mut H::Process,
    status: SupervisorTerminalStatus,
    reason: SupervisorLifecycleReason,
) -> SupervisorLifecycleResult {
    let containment = match contain_process(host, process, plan.cancellation_grace_ms) {
        Some(containment) => containment,
        None => return blocked(SupervisorLifecycleReason::ContainmentFailed, None),
    };
    if host.cleanup(plan).is_err() {
        return blocked(SupervisorLifecycleReason::CleanupFailed, Some(containment));
    }
    SupervisorLifecycleResult {
        status,
        reason,
        exit_code: None,
        containment: Some(containment),
    }
}

fn contain_process<H: MicroVmSupervisorHost>(
    host: &mut H,
    process: &mut H::Process,
    grace_ms: u64,
) -> Option<ContainmentMode> {
    match host.terminate_and_wait(process, grace_ms) {
        Ok(GracefulTerminationOutcome::Exited) => Some(ContainmentMode::Graceful),
        Ok(GracefulTerminationOutcome::StillRunning) | Err(_) => host
            .force_kill_and_reap(process)
            .ok()
            .map(|()| ContainmentMode::Forced),
    }
}

fn blocked_after_cleanup<H: MicroVmSupervisorHost>(
    host: &mut H,
    plan: &MicroVmSupervisorPlan<'_>,
    reason: SupervisorLifecycleReason,
    containment: Option<ContainmentMode>,
) -> SupervisorLifecycleResult {
    if host.cleanup(plan).is_err() {
        blocked(SupervisorLifecycleReason::CleanupFailed, containment)
    } else {
        blocked(reason, containment)
    }
}

const fn blocked(
    reason: SupervisorLifecycleReason,
    containment: Option<ContainmentMode>,
) -> SupervisorLifecycleResult {
    SupervisorLifecycleResult {
        status: SupervisorTerminalStatus::Blocked,
        reason,
        exit_code: None,
        containment,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::{CgroupV2Plan, MicroVmSupervisorPlan};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct FakeError;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum FailurePoint {
        Verify,
        Prepare,
        Cgroup,
        Materialize,
        Spawn,
        SpawnWithLiveProcess,
        Wait,
        Terminate,
        ForceKill,
        Cleanup,
    }

    struct FakeHost {
        events: Vec<&'static str>,
        failure: Option<FailurePoint>,
        wait_outcome: WaitOutcome,
        termination_outcome: GracefulTerminationOutcome,
    }

    impl FakeHost {
        fn new(wait_outcome: WaitOutcome) -> Self {
            Self {
                events: Vec::new(),
                failure: None,
                wait_outcome,
                termination_outcome: GracefulTerminationOutcome::Exited,
            }
        }

        fn fails(&self, point: FailurePoint) -> bool {
            self.failure == Some(point)
        }
    }

    impl MicroVmSupervisorHost for FakeHost {
        type Process = u64;
        type Error = FakeError;

        fn verify_inputs(&mut self, _plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
            self.events.push("verify");
            if self.fails(FailurePoint::Verify) {
                Err(FakeError)
            } else {
                Ok(())
            }
        }

        fn prepare_run_root(
            &mut self,
            _plan: &MicroVmSupervisorPlan<'_>,
        ) -> Result<(), Self::Error> {
            self.events.push("prepare");
            if self.fails(FailurePoint::Prepare) {
                Err(FakeError)
            } else {
                Ok(())
            }
        }

        fn apply_cgroup(&mut self, _plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
            self.events.push("cgroup");
            if self.fails(FailurePoint::Cgroup) {
                Err(FakeError)
            } else {
                Ok(())
            }
        }

        fn materialize_runtime(
            &mut self,
            _plan: &MicroVmSupervisorPlan<'_>,
        ) -> Result<(), Self::Error> {
            self.events.push("materialize");
            if self.fails(FailurePoint::Materialize) {
                Err(FakeError)
            } else {
                Ok(())
            }
        }

        fn spawn(
            &mut self,
            _plan: &MicroVmSupervisorPlan<'_>,
        ) -> SpawnAttempt<Self::Process, Self::Error> {
            self.events.push("spawn");
            if self.fails(FailurePoint::SpawnWithLiveProcess) {
                SpawnAttempt::Failed {
                    error: FakeError,
                    process: Some(7),
                }
            } else if self.fails(FailurePoint::Spawn) {
                SpawnAttempt::Failed {
                    error: FakeError,
                    process: None,
                }
            } else {
                SpawnAttempt::Running(7)
            }
        }

        fn wait(
            &mut self,
            _process: &mut Self::Process,
            _timeout_ms: u64,
        ) -> Result<WaitOutcome, Self::Error> {
            self.events.push("wait");
            if self.fails(FailurePoint::Wait) {
                Err(FakeError)
            } else {
                Ok(self.wait_outcome)
            }
        }

        fn terminate_and_wait(
            &mut self,
            _process: &mut Self::Process,
            _grace_ms: u64,
        ) -> Result<GracefulTerminationOutcome, Self::Error> {
            self.events.push("terminate");
            if self.fails(FailurePoint::Terminate) {
                Err(FakeError)
            } else {
                Ok(self.termination_outcome)
            }
        }

        fn force_kill_and_reap(&mut self, _process: &mut Self::Process) -> Result<(), Self::Error> {
            self.events.push("force-kill");
            if self.fails(FailurePoint::ForceKill) {
                Err(FakeError)
            } else {
                Ok(())
            }
        }

        fn cleanup(&mut self, _plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
            self.events.push("cleanup");
            if self.fails(FailurePoint::Cleanup) {
                Err(FakeError)
            } else {
                Ok(())
            }
        }
    }

    fn plan() -> MicroVmSupervisorPlan<'static> {
        MicroVmSupervisorPlan {
            run_id: "run-0123456789abcdef0123456789abcdef",
            workload_id: "seo-avengers-2500",
            source_sha256:
                "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            backend_id: "firecracker-microvm-v1",
            firecracker_exec: "/opt/walle/bin/firecracker",
            jailer_exec: "/opt/walle/bin/jailer",
            run_root: "/var/lib/walle/runs/run-0123456789abcdef0123456789abcdef",
            kernel_source: "/var/lib/walle/images/kernel-v1.bin",
            rootfs_source: "/var/lib/walle/images/rootfs-v1.ext4",
            kernel_sha256:
                "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            rootfs_sha256:
                "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            jail_uid: 65_534,
            jail_gid: 65_534,
            cgroup: CgroupV2Plan {
                cpu_quota_us: 1_600_000,
                cpu_period_us: 100_000,
                memory_max_bytes: 68_719_476_736,
                pids_max: 1_024,
            },
            vcpu_count: 16,
            memory_mib: 65_536,
            scratch_disk_mib: 65_536,
            filesystem_mode: "SCRATCH_AND_DECLARED_OUTPUT",
            timeout_ms: 1_200_000,
            cancellation_grace_ms: 5_000,
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
    fn exited_process_is_cleaned_before_result_release() {
        let mut host = FakeHost::new(WaitOutcome::Exited(0));
        let result = execute_supervisor_lifecycle(&mut host, &plan());
        assert_eq!(result.status, SupervisorTerminalStatus::Exited);
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.containment, None);
        assert_eq!(
            host.events,
            [
                "verify",
                "prepare",
                "cgroup",
                "materialize",
                "spawn",
                "wait",
                "cleanup"
            ]
        );
        assert_eq!(
            result.canonical_json(),
            "{\"containment\":null,\"exit_code\":0,\"reason\":\"PROCESS_EXITED\",\"status\":\"EXITED\"}"
        );
    }

    #[test]
    fn timeout_is_not_released_until_process_is_contained_and_cleaned() {
        let mut host = FakeHost::new(WaitOutcome::TimedOut);
        host.termination_outcome = GracefulTerminationOutcome::StillRunning;
        let result = execute_supervisor_lifecycle(&mut host, &plan());
        assert_eq!(result.status, SupervisorTerminalStatus::TimedOut);
        assert_eq!(result.containment, Some(ContainmentMode::Forced));
        assert_eq!(
            host.events,
            [
                "verify",
                "prepare",
                "cgroup",
                "materialize",
                "spawn",
                "wait",
                "terminate",
                "force-kill",
                "cleanup"
            ]
        );
    }

    #[test]
    fn cancellation_can_complete_through_graceful_containment() {
        let mut host = FakeHost::new(WaitOutcome::Cancelled);
        let result = execute_supervisor_lifecycle(&mut host, &plan());
        assert_eq!(result.status, SupervisorTerminalStatus::Cancelled);
        assert_eq!(result.containment, Some(ContainmentMode::Graceful));
        assert_eq!(host.events.last(), Some(&"cleanup"));
    }

    #[test]
    fn wait_failure_forces_containment_before_blocking() {
        let mut host = FakeHost::new(WaitOutcome::Exited(0));
        host.failure = Some(FailurePoint::Wait);
        host.termination_outcome = GracefulTerminationOutcome::StillRunning;
        let result = execute_supervisor_lifecycle(&mut host, &plan());
        assert_eq!(result.status, SupervisorTerminalStatus::Blocked);
        assert_eq!(result.reason, SupervisorLifecycleReason::WaitFailed);
        assert_eq!(result.containment, Some(ContainmentMode::Forced));
        assert_eq!(
            &host.events[host.events.len() - 3..],
            ["terminate", "force-kill", "cleanup"]
        );
    }

    #[test]
    fn containment_failure_does_not_remove_runtime_under_a_possibly_live_process() {
        let mut host = FakeHost::new(WaitOutcome::TimedOut);
        host.failure = Some(FailurePoint::ForceKill);
        host.termination_outcome = GracefulTerminationOutcome::StillRunning;
        let result = execute_supervisor_lifecycle(&mut host, &plan());
        assert_eq!(result.status, SupervisorTerminalStatus::Blocked);
        assert_eq!(result.reason, SupervisorLifecycleReason::ContainmentFailed);
        assert_eq!(host.events.last(), Some(&"force-kill"));
        assert!(!host.events.contains(&"cleanup"));
    }

    #[test]
    fn live_child_reported_by_failed_spawn_is_force_killed_before_cleanup() {
        let mut host = FakeHost::new(WaitOutcome::Exited(0));
        host.failure = Some(FailurePoint::SpawnWithLiveProcess);
        let result = execute_supervisor_lifecycle(&mut host, &plan());
        assert_eq!(result.status, SupervisorTerminalStatus::Blocked);
        assert_eq!(result.reason, SupervisorLifecycleReason::SpawnFailed);
        assert_eq!(result.containment, Some(ContainmentMode::Forced));
        assert_eq!(
            &host.events[host.events.len() - 3..],
            ["spawn", "force-kill", "cleanup"]
        );
    }

    #[test]
    fn pre_spawn_failure_still_cleans_partial_host_state() {
        let mut host = FakeHost::new(WaitOutcome::Exited(0));
        host.failure = Some(FailurePoint::Cgroup);
        let result = execute_supervisor_lifecycle(&mut host, &plan());
        assert_eq!(result.status, SupervisorTerminalStatus::Blocked);
        assert_eq!(
            result.reason,
            SupervisorLifecycleReason::CgroupApplicationFailed
        );
        assert_eq!(host.events, ["verify", "prepare", "cgroup", "cleanup"]);
    }

    #[test]
    fn cleanup_failure_suppresses_successful_process_exit() {
        let mut host = FakeHost::new(WaitOutcome::Exited(0));
        host.failure = Some(FailurePoint::Cleanup);
        let result = execute_supervisor_lifecycle(&mut host, &plan());
        assert_eq!(result.status, SupervisorTerminalStatus::Blocked);
        assert_eq!(result.reason, SupervisorLifecycleReason::CleanupFailed);
        assert_eq!(result.exit_code, None);
    }

    #[test]
    fn input_verification_failure_is_read_only_and_does_not_cleanup() {
        let mut host = FakeHost::new(WaitOutcome::Exited(0));
        host.failure = Some(FailurePoint::Verify);
        let result = execute_supervisor_lifecycle(&mut host, &plan());
        assert_eq!(result.status, SupervisorTerminalStatus::Blocked);
        assert_eq!(
            result.reason,
            SupervisorLifecycleReason::InputVerificationFailed
        );
        assert_eq!(host.events, ["verify"]);
    }

    #[test]
    fn unused_failure_points_remain_covered_by_the_fake_contract() {
        for point in [
            FailurePoint::Prepare,
            FailurePoint::Materialize,
            FailurePoint::Spawn,
            FailurePoint::Terminate,
        ] {
            let mut host = FakeHost::new(WaitOutcome::TimedOut);
            host.failure = Some(point);
            let _ = execute_supervisor_lifecycle(&mut host, &plan());
        }
    }
}
