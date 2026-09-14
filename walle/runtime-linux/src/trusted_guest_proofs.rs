use walle_core::is_valid_sha256;
use walle_core::supervisor::MicroVmSupervisorPlan;

use crate::guest_image::{
    AdmittedGuestImageIdentity, GUEST_AGENT_PATH, GUEST_PROTOCOL_VERSION,
};
use crate::guest_protocol::{GuestAttestation, GuestCompletion, GUEST_SECCOMP_POLICY_ID};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedGuestProofPayloads {
    pub network_isolation: Option<String>,
    pub guest_seccomp: Option<String>,
    pub guest_completion_ack: Option<String>,
}

/// Qualifies certification-shaped guest proof payloads only after the host has
/// already admitted the exact kernel/rootfs identity and proved the exact guest
/// agent bytes inside that rootfs. The serial attestation must be bound to the
/// same run/source identity. Each proof remains independently fail-closed so a
/// valid observation for one category cannot manufacture another category.
pub fn derive_trusted_guest_proof_payloads(
    plan: &MicroVmSupervisorPlan<'_>,
    identity: &AdmittedGuestImageIdentity,
    attestation: &GuestAttestation,
) -> Option<TrustedGuestProofPayloads> {
    if !trusted_guest_identity_matches(plan, identity)
        || attestation.run_id != plan.run_id
        || attestation.source_sha256 != plan.source_sha256
    {
        return None;
    }

    let network_isolation = (plan.network_interfaces == 0
        && attestation.network_non_loopback_interfaces == 0)
        .then(|| network_isolation_payload(plan, identity, attestation));

    let guest_seccomp = (plan.guest_seccomp_required
        && attestation.seccomp_mode == 2
        && attestation.no_new_privs
        && attestation.seccomp_policy == identity.guest_seccomp_policy
        && attestation.seccomp_policy == GUEST_SECCOMP_POLICY_ID)
        .then(|| guest_seccomp_payload(plan, identity, attestation));

    let guest_completion_ack = (attestation.completion == GuestCompletion::Success
        && attestation.workload_exit_code == 0)
        .then(|| guest_completion_ack_payload(plan, identity, attestation));

    Some(TrustedGuestProofPayloads {
        network_isolation,
        guest_seccomp,
        guest_completion_ack,
    })
}

fn trusted_guest_identity_matches(
    plan: &MicroVmSupervisorPlan<'_>,
    identity: &AdmittedGuestImageIdentity,
) -> bool {
    let Some(binding) = identity.guest_agent_rootfs_binding.as_ref() else {
        return false;
    };

    plan.rootfs_read_only
        && plan.network_interfaces == 0
        && plan.guest_seccomp_required
        && identity.kernel_sha256 == plan.kernel_sha256
        && identity.rootfs_sha256 == plan.rootfs_sha256
        && identity.guest_agent_path == GUEST_AGENT_PATH
        && identity.guest_protocol == GUEST_PROTOCOL_VERSION
        && identity.guest_seccomp_policy == GUEST_SECCOMP_POLICY_ID
        && is_valid_sha256(&identity.manifest_sha256)
        && is_valid_sha256(&identity.guest_agent_sha256)
        && is_valid_sha256(&binding.debugfs_sha256)
        && binding.guest_agent_bytes > 0
        && binding.guest_agent_path == identity.guest_agent_path
        && binding.guest_agent_sha256 == identity.guest_agent_sha256
        && binding.rootfs_sha256 == identity.rootfs_sha256
}

fn network_isolation_payload(
    plan: &MicroVmSupervisorPlan<'_>,
    identity: &AdmittedGuestImageIdentity,
    attestation: &GuestAttestation,
) -> String {
    format!(
        concat!(
            "{{",
            "\"guest_agent_sha256\":\"{}\",",
            "\"manifest_sha256\":\"{}\",",
            "\"network_non_loopback_interfaces\":{},",
            "\"rootfs_sha256\":\"{}\",",
            "\"run_id\":\"{}\",",
            "\"source_sha256\":\"{}\",",
            "\"verification\":\"FIRECRACKER_ZERO_NIC_AND_TRUSTED_GUEST_AGENT_OBSERVED_NO_NON_LOOPBACK_INTERFACES\"",
            "}}"
        ),
        identity.guest_agent_sha256,
        identity.manifest_sha256,
        attestation.network_non_loopback_interfaces,
        identity.rootfs_sha256,
        plan.run_id,
        plan.source_sha256,
    )
}

fn guest_seccomp_payload(
    plan: &MicroVmSupervisorPlan<'_>,
    identity: &AdmittedGuestImageIdentity,
    attestation: &GuestAttestation,
) -> String {
    format!(
        concat!(
            "{{",
            "\"guest_agent_sha256\":\"{}\",",
            "\"manifest_sha256\":\"{}\",",
            "\"no_new_privs\":true,",
            "\"rootfs_sha256\":\"{}\",",
            "\"run_id\":\"{}\",",
            "\"seccomp_mode\":{},",
            "\"seccomp_policy\":\"{}\",",
            "\"source_sha256\":\"{}\",",
            "\"verification\":\"TRUSTED_GUEST_AGENT_OBSERVED_WALLE_SECCOMP_FILTER_AND_NO_NEW_PRIVS\"",
            "}}"
        ),
        identity.guest_agent_sha256,
        identity.manifest_sha256,
        identity.rootfs_sha256,
        plan.run_id,
        attestation.seccomp_mode,
        attestation.seccomp_policy,
        plan.source_sha256,
    )
}

fn guest_completion_ack_payload(
    plan: &MicroVmSupervisorPlan<'_>,
    identity: &AdmittedGuestImageIdentity,
    attestation: &GuestAttestation,
) -> String {
    format!(
        concat!(
            "{{",
            "\"completion\":\"{}\",",
            "\"guest_agent_sha256\":\"{}\",",
            "\"manifest_sha256\":\"{}\",",
            "\"rootfs_sha256\":\"{}\",",
            "\"run_id\":\"{}\",",
            "\"source_sha256\":\"{}\",",
            "\"verification\":\"TRUSTED_GUEST_AGENT_ACKNOWLEDGED_SUCCESSFUL_WORKLOAD_COMPLETION\",",
            "\"workload_exit_code\":{}",
            "}}"
        ),
        attestation.completion.as_str(),
        identity.guest_agent_sha256,
        identity.manifest_sha256,
        identity.rootfs_sha256,
        plan.run_id,
        plan.source_sha256,
        attestation.workload_exit_code,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guest_image::GuestAgentRootfsBinding;
    use walle_core::supervisor::CgroupV2Plan;

    const RUN_ID: &str = "run-0123456789abcdef0123456789abcdef";
    const SOURCE_SHA: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const KERNEL_SHA: &str =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const ROOTFS_SHA: &str =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const AGENT_SHA: &str =
        "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const MANIFEST_SHA: &str =
        "sha256:4444444444444444444444444444444444444444444444444444444444444444";
    const DEBUGFS_SHA: &str =
        "sha256:5555555555555555555555555555555555555555555555555555555555555555";

    fn plan() -> MicroVmSupervisorPlan<'static> {
        MicroVmSupervisorPlan {
            run_id: RUN_ID,
            workload_id: "seo-avengers-2500",
            source_sha256: SOURCE_SHA,
            backend_id: "firecracker-microvm-v1",
            firecracker_exec: "/opt/walle/firecracker",
            firecracker_sha256:
                "sha256:6666666666666666666666666666666666666666666666666666666666666666",
            jailer_exec: "/opt/walle/jailer",
            jailer_sha256:
                "sha256:7777777777777777777777777777777777777777777777777777777777777777",
            run_root: "/var/lib/walle/runs/run-0123456789abcdef0123456789abcdef",
            kernel_source: "/opt/walle/images/vmlinux",
            rootfs_source: "/opt/walle/images/rootfs.ext4",
            kernel_sha256: KERNEL_SHA,
            rootfs_sha256: ROOTFS_SHA,
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
            scratch_disk_mib: 0,
            filesystem_mode: "READ_ONLY_INPUTS",
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

    fn identity() -> AdmittedGuestImageIdentity {
        AdmittedGuestImageIdentity {
            manifest_sha256: MANIFEST_SHA.to_owned(),
            kernel_sha256: KERNEL_SHA.to_owned(),
            rootfs_sha256: ROOTFS_SHA.to_owned(),
            guest_agent_sha256: AGENT_SHA.to_owned(),
            guest_agent_path: GUEST_AGENT_PATH.to_owned(),
            guest_protocol: GUEST_PROTOCOL_VERSION,
            guest_seccomp_policy: GUEST_SECCOMP_POLICY_ID.to_owned(),
            guest_agent_rootfs_binding: Some(GuestAgentRootfsBinding {
                debugfs_sha256: DEBUGFS_SHA.to_owned(),
                guest_agent_bytes: 4096,
                guest_agent_path: GUEST_AGENT_PATH.to_owned(),
                guest_agent_sha256: AGENT_SHA.to_owned(),
                rootfs_sha256: ROOTFS_SHA.to_owned(),
            }),
        }
    }

    fn attestation() -> GuestAttestation {
        GuestAttestation {
            run_id: RUN_ID.to_owned(),
            source_sha256: SOURCE_SHA.to_owned(),
            seccomp_mode: 2,
            seccomp_policy: GUEST_SECCOMP_POLICY_ID.to_owned(),
            no_new_privs: true,
            network_non_loopback_interfaces: 0,
            workload_exit_code: 0,
            completion: GuestCompletion::Success,
        }
    }

    #[test]
    fn exact_trusted_identity_and_guest_observation_qualify_three_distinct_payloads() {
        let proofs = derive_trusted_guest_proof_payloads(&plan(), &identity(), &attestation())
            .expect("trusted guest proof context");

        let network = proofs.network_isolation.expect("network proof");
        let seccomp = proofs.guest_seccomp.expect("seccomp proof");
        let completion = proofs.guest_completion_ack.expect("completion proof");
        assert!(network.contains("FIRECRACKER_ZERO_NIC_AND_TRUSTED_GUEST_AGENT"));
        assert!(seccomp.contains("TRUSTED_GUEST_AGENT_OBSERVED_WALLE_SECCOMP_FILTER"));
        assert!(completion.contains("TRUSTED_GUEST_AGENT_ACKNOWLEDGED_SUCCESSFUL"));
        for payload in [&network, &seccomp, &completion] {
            assert!(payload.contains(AGENT_SHA));
            assert!(payload.contains(MANIFEST_SHA));
            assert!(payload.contains(ROOTFS_SHA));
            assert!(payload.contains(RUN_ID));
            assert!(payload.contains(SOURCE_SHA));
        }
        assert_ne!(network, seccomp);
        assert_ne!(network, completion);
        assert_ne!(seccomp, completion);
    }

    #[test]
    fn missing_rootfs_agent_binding_rejects_the_entire_trust_context() {
        let mut unbound = identity();
        unbound.guest_agent_rootfs_binding = None;
        assert!(derive_trusted_guest_proof_payloads(&plan(), &unbound, &attestation()).is_none());
    }

    #[test]
    fn cross_run_or_source_attestation_rejects_the_entire_trust_context() {
        let mut claim = attestation();
        claim.run_id = "run-ffffffffffffffffffffffffffffffff".to_owned();
        assert!(derive_trusted_guest_proof_payloads(&plan(), &identity(), &claim).is_none());

        let mut claim = attestation();
        claim.source_sha256 =
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                .to_owned();
        assert!(derive_trusted_guest_proof_payloads(&plan(), &identity(), &claim).is_none());
    }

    #[test]
    fn guest_categories_fail_closed_independently() {
        let mut claim = attestation();
        claim.network_non_loopback_interfaces = 1;
        let proofs = derive_trusted_guest_proof_payloads(&plan(), &identity(), &claim)
            .expect("trusted context");
        assert!(proofs.network_isolation.is_none());
        assert!(proofs.guest_seccomp.is_some());
        assert!(proofs.guest_completion_ack.is_some());

        let mut claim = attestation();
        claim.seccomp_mode = 1;
        let proofs = derive_trusted_guest_proof_payloads(&plan(), &identity(), &claim)
            .expect("trusted context");
        assert!(proofs.network_isolation.is_some());
        assert!(proofs.guest_seccomp.is_none());
        assert!(proofs.guest_completion_ack.is_some());

        let mut claim = attestation();
        claim.workload_exit_code = 9;
        claim.completion = GuestCompletion::Failure;
        let proofs = derive_trusted_guest_proof_payloads(&plan(), &identity(), &claim)
            .expect("trusted context");
        assert!(proofs.network_isolation.is_some());
        assert!(proofs.guest_seccomp.is_some());
        assert!(proofs.guest_completion_ack.is_none());
    }

    #[test]
    fn plan_that_does_not_require_the_hardened_guest_contract_is_rejected() {
        let mut unsafe_plan = plan();
        unsafe_plan.rootfs_read_only = false;
        assert!(derive_trusted_guest_proof_payloads(&unsafe_plan, &identity(), &attestation()).is_none());

        let mut unsafe_plan = plan();
        unsafe_plan.network_interfaces = 1;
        assert!(derive_trusted_guest_proof_payloads(&unsafe_plan, &identity(), &attestation()).is_none());

        let mut unsafe_plan = plan();
        unsafe_plan.guest_seccomp_required = false;
        assert!(derive_trusted_guest_proof_payloads(&unsafe_plan, &identity(), &attestation()).is_none());
    }
}
