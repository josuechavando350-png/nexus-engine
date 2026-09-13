use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;

use walle_core::supervisor::MicroVmSupervisorPlan;

use crate::host::{LinuxHostError, LinuxMicroVmHost, LinuxMicroVmHostConfig};
use crate::supervisor_evidence::{
    EvidencedSupervisorResult, SupervisorEvidenceError, SupervisorEvidenceRun,
};

#[derive(Debug)]
pub enum LinuxEvidencedRunError {
    Host(LinuxHostError),
    Evidence(SupervisorEvidenceError),
}

impl Display for LinuxEvidencedRunError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Host(error) => Display::fmt(error, formatter),
            Self::Evidence(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for LinuxEvidencedRunError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Host(error) => Some(error),
            Self::Evidence(error) => Some(error),
        }
    }
}

impl From<LinuxHostError> for LinuxEvidencedRunError {
    fn from(value: LinuxHostError) -> Self {
        Self::Host(value)
    }
}

impl From<SupervisorEvidenceError> for LinuxEvidencedRunError {
    fn from(value: SupervisorEvidenceError) -> Self {
        Self::Evidence(value)
    }
}

/// Executes one exact supervisor plan through the concrete Linux host while
/// binding the run to the durable supervisor evidence chain.
///
/// The Linux host is constructed first so an invalid trusted-runtime
/// configuration cannot create an evidence directory that looks like an
/// attempted workload run. Once construction succeeds, `SupervisorEvidenceRun`
/// persists the canonical plan before any workload-side lifecycle effect,
/// executes the existing fail-closed supervisor, persists the terminal result,
/// seals the chain, and verifies the durable bytes before this function can
/// return success.
///
/// This function does not promote a successful lifecycle into WALLE
/// certification. KVM/Firecracker boot, guest completion, resource-control and
/// other required certification evidence remain separate proof obligations.
pub fn execute_linux_supervisor_with_evidence(
    host_config: LinuxMicroVmHostConfig,
    evidence_root: impl Into<PathBuf>,
    plan: &MicroVmSupervisorPlan<'_>,
) -> Result<EvidencedSupervisorResult, LinuxEvidencedRunError> {
    let evidence_hasher = host_config.sha256_program.clone();
    let mut host = LinuxMicroVmHost::new(host_config)?;
    let mut evidence = SupervisorEvidenceRun::begin(evidence_root, evidence_hasher, plan)?;
    evidence.execute(&mut host, plan).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_error_preserves_host_source() {
        let error = LinuxEvidencedRunError::Host(LinuxHostError::InvalidFirecrackerSha256);
        assert_eq!(
            error.to_string(),
            "Firecracker digest is not a canonical lowercase sha256"
        );
        assert!(error.source().is_some());
    }
}
