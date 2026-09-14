use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;

use walle_core::certification::CertificationEvidence;
use walle_core::supervisor::MicroVmSupervisorPlan;

use crate::guest_image::{
    load_and_bind_guest_image_manifest, AdmittedGuestImageIdentity, GuestImageError,
    GuestImageManifestSource,
};
use crate::host::LinuxMicroVmHostConfig;
use crate::runner::{
    execute_linux_supervisor_with_certification_evidence, LinuxEvidencedRunError,
    LinuxSupervisorEvidenceBundle,
};
use crate::supervisor_evidence::EvidencedSupervisorResult;

#[derive(Debug)]
pub enum TrustedGuestRunError {
    GuestImage(GuestImageError),
    Runner(LinuxEvidencedRunError),
}

impl Display for TrustedGuestRunError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GuestImage(error) => Display::fmt(error, formatter),
            Self::Runner(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for TrustedGuestRunError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::GuestImage(error) => Some(error),
            Self::Runner(error) => Some(error),
        }
    }
}

impl From<GuestImageError> for TrustedGuestRunError {
    fn from(value: GuestImageError) -> Self {
        Self::GuestImage(value)
    }
}

impl From<LinuxEvidencedRunError> for TrustedGuestRunError {
    fn from(value: LinuxEvidencedRunError) -> Self {
        Self::Runner(value)
    }
}

/// Result of a concrete Linux/Firecracker run whose kernel/rootfs identities
/// were first bound to a host-controlled guest image manifest.
///
/// The admitted identity is intentionally exposed separately from certification
/// evidence. This slice does not yet make it a durable receipt and therefore
/// must not upgrade guest seccomp, network isolation or completion acknowledgement
/// into `PROVEN` certification categories.
#[derive(Debug)]
pub struct TrustedGuestEvidenceBundle {
    guest_image_identity: AdmittedGuestImageIdentity,
    execution: LinuxSupervisorEvidenceBundle,
}

impl TrustedGuestEvidenceBundle {
    pub fn guest_image_identity(&self) -> &AdmittedGuestImageIdentity {
        &self.guest_image_identity
    }

    pub fn supervisor(&self) -> &EvidencedSupervisorResult {
        self.execution.supervisor()
    }

    pub fn certification_evidence(&self) -> Vec<CertificationEvidence<'_>> {
        self.execution.certification_evidence()
    }
}

/// Admits a trusted guest image identity before the concrete Linux supervisor
/// is created, then executes through the existing durable-evidence runner.
///
/// The ordering is deliberate: an invalid, stale, tampered, non-canonical or
/// plan-mismatched guest image manifest fails before KVM/Firecracker execution.
/// The configured manifest SHA is host/operator input, not a value supplied by
/// the guest. The manifest itself is resolved without symlinks, must be
/// root-owned and non-writable by group/world, and binds the exact kernel,
/// rootfs, guest-agent digest, agent path, protocol and seccomp policy.
///
/// This is still only an admission boundary. Until a subsequent slice persists
/// this admitted identity into the same sealed evidence chain and proves the
/// mandatory guest boot path, the strict serial attestation remains a
/// non-certifying candidate.
pub fn execute_linux_supervisor_with_trusted_guest_image(
    host_config: LinuxMicroVmHostConfig,
    evidence_root: impl Into<PathBuf>,
    plan: &MicroVmSupervisorPlan<'_>,
    guest_image_manifest: &GuestImageManifestSource,
) -> Result<TrustedGuestEvidenceBundle, TrustedGuestRunError> {
    let guest_image_identity = load_and_bind_guest_image_manifest(
        guest_image_manifest,
        host_config.sha256_program.clone(),
        plan,
    )?;
    let execution =
        execute_linux_supervisor_with_certification_evidence(host_config, evidence_root, plan)?;

    Ok(TrustedGuestEvidenceBundle {
        guest_image_identity,
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
}
