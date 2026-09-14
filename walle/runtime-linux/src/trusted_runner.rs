use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;

use walle_core::certification::CertificationEvidence;
use walle_core::supervisor::MicroVmSupervisorPlan;

use crate::evidence::EvidenceReceipt;
use crate::guest_image::{
    load_and_bind_guest_image_manifest, AdmittedGuestImageIdentity, GuestAgentRootfsBinding,
    GuestImageError, GuestImageManifestSource,
};
use crate::guest_rootfs::{
    verify_guest_agent_in_rootfs, GuestAgentRootfsProvenance, GuestRootfsError,
    GuestRootfsInspectorSource,
};
use crate::host::LinuxMicroVmHostConfig;
use crate::runner::{
    execute_linux_supervisor_with_admitted_guest_image, LinuxEvidencedRunError,
    LinuxSupervisorEvidenceBundle,
};
use crate::supervisor_evidence::EvidencedSupervisorResult;

#[derive(Debug)]
pub enum TrustedGuestRunError {
    GuestImage(GuestImageError),
    GuestRootfs(GuestRootfsError),
    Runner(LinuxEvidencedRunError),
}

impl Display for TrustedGuestRunError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GuestImage(error) => Display::fmt(error, formatter),
            Self::GuestRootfs(error) => Display::fmt(error, formatter),
            Self::Runner(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for TrustedGuestRunError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::GuestImage(error) => Some(error),
            Self::GuestRootfs(error) => Some(error),
            Self::Runner(error) => Some(error),
        }
    }
}

impl From<GuestImageError> for TrustedGuestRunError {
    fn from(value: GuestImageError) -> Self {
        Self::GuestImage(value)
    }
}

impl From<GuestRootfsError> for TrustedGuestRunError {
    fn from(value: GuestRootfsError) -> Self {
        Self::GuestRootfs(value)
    }
}

impl From<LinuxEvidencedRunError> for TrustedGuestRunError {
    fn from(value: LinuxEvidencedRunError) -> Self {
        Self::Runner(value)
    }
}

/// Result of a concrete Linux/Firecracker run whose kernel/rootfs identities
/// were first bound to a host-controlled guest image manifest and whose exact
/// guest-agent bytes were then verified at the mandatory init path inside that
/// admitted rootfs.
///
/// The admitted identity is preserved for operator inspection. Before lifecycle
/// execution begins, its canonical durable receipt also contains the exact
/// rootfs-to-agent provenance binding: rootfs digest, agent digest/path, byte
/// count and pinned read-only inspector identity. This closes the manifest-to-
/// rootfs byte relation but still does not by itself authenticate a serial claim
/// as having been emitted by that agent at runtime, so guest seccomp, network
/// isolation and completion acknowledgement remain non-certifying here.
#[derive(Debug)]
pub struct TrustedGuestEvidenceBundle {
    guest_image_identity: AdmittedGuestImageIdentity,
    guest_agent_rootfs_provenance: GuestAgentRootfsProvenance,
    execution: LinuxSupervisorEvidenceBundle,
}

impl TrustedGuestEvidenceBundle {
    pub fn guest_image_identity(&self) -> &AdmittedGuestImageIdentity {
        &self.guest_image_identity
    }

    pub fn guest_agent_rootfs_provenance(&self) -> &GuestAgentRootfsProvenance {
        &self.guest_agent_rootfs_provenance
    }

    pub fn guest_image_identity_receipt(&self) -> Option<&EvidenceReceipt> {
        self.execution
            .supervisor()
            .guest_image_identity_receipt
            .as_ref()
    }

    pub fn supervisor(&self) -> &EvidencedSupervisorResult {
        self.execution.supervisor()
    }

    pub fn certification_evidence(&self) -> Vec<CertificationEvidence<'_>> {
        self.execution.certification_evidence()
    }
}

/// Admits a trusted guest image identity, verifies the exact guest-agent bytes
/// inside the admitted rootfs with a pinned read-only host inspector, binds that
/// provenance into the canonical admitted identity, and only then creates the
/// concrete Linux supervisor execution.
///
/// The ordering is deliberate: an invalid, stale, tampered, non-canonical or
/// plan-mismatched guest image manifest fails before KVM/Firecracker execution.
/// The configured manifest SHA and debugfs SHA are host/operator inputs, not
/// values supplied by the guest. The manifest and inspector are both resolved
/// without symlinks and must satisfy their respective ownership/integrity
/// requirements. The rootfs verifier opens the admitted ext4 image, proves the
/// exact executable bytes at `/usr/libexec/walle/walle-guest-agent`, and hashes
/// the same rootfs fd before and after inspection. That result is then embedded
/// in the `guest-image-identity` receipt that is appended before lifecycle
/// execution; persistence failure is fail-closed.
///
/// The strict serial attestation remains non-certifying until a later slice
/// authenticates the physical runtime claim against this now-proven agent
/// identity instead of trusting arbitrary guest console output.
pub fn execute_linux_supervisor_with_trusted_guest_image(
    host_config: LinuxMicroVmHostConfig,
    evidence_root: impl Into<PathBuf>,
    plan: &MicroVmSupervisorPlan<'_>,
    guest_image_manifest: &GuestImageManifestSource,
    guest_rootfs_inspector: &GuestRootfsInspectorSource,
) -> Result<TrustedGuestEvidenceBundle, TrustedGuestRunError> {
    let mut guest_image_identity = load_and_bind_guest_image_manifest(
        guest_image_manifest,
        host_config.sha256_program.clone(),
        plan,
    )?;
    let guest_agent_rootfs_provenance = verify_guest_agent_in_rootfs(
        guest_rootfs_inspector,
        host_config.sha256_program.clone(),
        plan,
        &guest_image_identity,
    )?;
    guest_image_identity.bind_guest_agent_rootfs_provenance(GuestAgentRootfsBinding {
        debugfs_sha256: guest_agent_rootfs_provenance.debugfs_sha256.clone(),
        guest_agent_bytes: guest_agent_rootfs_provenance.guest_agent_bytes,
        guest_agent_path: guest_agent_rootfs_provenance.guest_agent_path.clone(),
        guest_agent_sha256: guest_agent_rootfs_provenance.guest_agent_sha256.clone(),
        rootfs_sha256: guest_agent_rootfs_provenance.rootfs_sha256.clone(),
    })?;

    let execution = execute_linux_supervisor_with_admitted_guest_image(
        host_config,
        evidence_root,
        plan,
        &guest_image_identity,
    )?;

    Ok(TrustedGuestEvidenceBundle {
        guest_image_identity,
        guest_agent_rootfs_provenance,
        execution,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_guest_error_preserves_guest_image_source() {
        let error = TrustedGuestRunError::GuestImage(GuestImageError::PlanImageMismatch);
        assert_eq!(
            error.to_string(),
            "supervisor kernel/rootfs identities do not match the admitted guest image"
        );
        assert!(error.source().is_some());
    }

    #[test]
    fn trusted_guest_error_preserves_rootfs_provenance_source() {
        let error = TrustedGuestRunError::GuestRootfs(GuestRootfsError::GuestAgentNotExecutable);
        assert_eq!(
            error.to_string(),
            "guest-agent path inside rootfs is not executable"
        );
        assert!(error.source().is_some());
    }
}
