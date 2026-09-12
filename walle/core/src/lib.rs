use std::error::Error;
use std::fmt::{Display, Formatter};
use std::str::FromStr;

pub const ENGINE_NAME: &str = "WALLE";
pub const ENGINE_VERSION: &str = "0.1.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertificationProfile {
    Fast,
    Hardened,
    Certification,
}

impl CertificationProfile {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "FAST",
            Self::Hardened => "HARDENED",
            Self::Certification => "CERTIFICATION",
        }
    }
}

impl Display for CertificationProfile {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for CertificationProfile {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_uppercase().as_str() {
            "FAST" => Ok(Self::Fast),
            "HARDENED" => Ok(Self::Hardened),
            "CERTIFICATION" => Ok(Self::Certification),
            _ => Err(ParseEnumError::new("certification profile", value)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkPolicy {
    DenyAll,
    LoopbackOnly,
    ExplicitAllowlist,
}

impl NetworkPolicy {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DenyAll => "DENY_ALL",
            Self::LoopbackOnly => "LOOPBACK_ONLY",
            Self::ExplicitAllowlist => "EXPLICIT_ALLOWLIST",
        }
    }
}

impl Display for NetworkPolicy {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourcePlan {
    pub cpu_cores: u16,
    pub memory_mib: u64,
    pub wall_time_seconds: u64,
    pub pid_limit: u32,
    pub scratch_disk_mib: u64,
}

impl ResourcePlan {
    pub const fn baseline(profile: CertificationProfile) -> Self {
        match profile {
            CertificationProfile::Fast => Self {
                cpu_cores: 2,
                memory_mib: 4_096,
                wall_time_seconds: 600,
                pid_limit: 256,
                scratch_disk_mib: 8_192,
            },
            CertificationProfile::Hardened => Self {
                cpu_cores: 8,
                memory_mib: 16_384,
                wall_time_seconds: 1_800,
                pid_limit: 512,
                scratch_disk_mib: 32_768,
            },
            CertificationProfile::Certification => Self {
                cpu_cores: 16,
                memory_mib: 65_536,
                wall_time_seconds: 3_600,
                pid_limit: 1_024,
                scratch_disk_mib: 65_536,
            },
        }
    }

    pub fn validate(self) -> Result<(), ContractValidationError> {
        if self.cpu_cores == 0 {
            return Err(ContractValidationError::ZeroCpu);
        }
        if self.memory_mib == 0 {
            return Err(ContractValidationError::ZeroMemory);
        }
        if self.wall_time_seconds == 0 {
            return Err(ContractValidationError::ZeroWallTime);
        }
        if self.pid_limit == 0 {
            return Err(ContractValidationError::ZeroPidLimit);
        }
        if self.scratch_disk_mib == 0 {
            return Err(ContractValidationError::ZeroScratchDisk);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkloadContract<'a> {
    pub workload_id: &'a str,
    pub source_sha256: &'a str,
    pub profile: CertificationProfile,
    pub network_policy: NetworkPolicy,
    pub resources: ResourcePlan,
}

impl WorkloadContract<'_> {
    pub fn validate(self) -> Result<(), ContractValidationError> {
        if !is_valid_workload_id(self.workload_id) {
            return Err(ContractValidationError::InvalidWorkloadId);
        }
        if !is_valid_sha256(self.source_sha256) {
            return Err(ContractValidationError::InvalidSourceSha256);
        }
        self.resources.validate()
    }
}

pub fn is_valid_workload_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }

    let bytes = value.as_bytes();
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }

    bytes.iter().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(*byte, b'-' | b'_' | b'.')
    })
}

pub fn is_valid_sha256(value: &str) -> bool {
    if value.len() != 71 || !value.starts_with("sha256:") {
        return false;
    }

    value.as_bytes()[7..]
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Planned,
    Preparing,
    Isolated,
    Executing,
    Verifying,
    Certifying,
    Certified,
    Blocked,
    InsufficientData,
    Cancelled,
}

impl RunState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "PLANNED",
            Self::Preparing => "PREPARING",
            Self::Isolated => "ISOLATED",
            Self::Executing => "EXECUTING",
            Self::Verifying => "VERIFYING",
            Self::Certifying => "CERTIFYING",
            Self::Certified => "CERTIFIED",
            Self::Blocked => "BLOCKED",
            Self::InsufficientData => "INSUFFICIENT_DATA",
            Self::Cancelled => "CANCELLED",
        }
    }

    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Certified | Self::Blocked | Self::InsufficientData | Self::Cancelled
        )
    }

    pub const fn can_transition_to(self, next: Self) -> bool {
        if self.is_terminal() {
            return false;
        }

        matches!(
            (self, next),
            (Self::Planned, Self::Preparing)
                | (Self::Preparing, Self::Isolated)
                | (Self::Isolated, Self::Executing)
                | (Self::Executing, Self::Verifying)
                | (Self::Verifying, Self::Certifying)
                | (Self::Certifying, Self::Certified)
                | (_, Self::Blocked)
                | (_, Self::Cancelled)
                | (Self::Preparing, Self::InsufficientData)
                | (Self::Isolated, Self::InsufficientData)
                | (Self::Executing, Self::InsufficientData)
                | (Self::Verifying, Self::InsufficientData)
                | (Self::Certifying, Self::InsufficientData)
        )
    }
}

impl Display for RunState {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for RunState {
    type Err = ParseEnumError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_uppercase().as_str() {
            "PLANNED" => Ok(Self::Planned),
            "PREPARING" => Ok(Self::Preparing),
            "ISOLATED" => Ok(Self::Isolated),
            "EXECUTING" => Ok(Self::Executing),
            "VERIFYING" => Ok(Self::Verifying),
            "CERTIFYING" => Ok(Self::Certifying),
            "CERTIFIED" => Ok(Self::Certified),
            "BLOCKED" => Ok(Self::Blocked),
            "INSUFFICIENT_DATA" => Ok(Self::InsufficientData),
            "CANCELLED" => Ok(Self::Cancelled),
            _ => Err(ParseEnumError::new("run state", value)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunMachine {
    state: RunState,
}

impl Default for RunMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl RunMachine {
    pub const fn new() -> Self {
        Self {
            state: RunState::Planned,
        }
    }

    pub const fn state(self) -> RunState {
        self.state
    }

    pub fn transition(&mut self, next: RunState) -> Result<(), TransitionError> {
        if !self.state.can_transition_to(next) {
            return Err(TransitionError {
                from: self.state,
                to: next,
            });
        }
        self.state = next;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseEnumError {
    kind: &'static str,
    value: String,
}

impl ParseEnumError {
    fn new(kind: &'static str, value: &str) -> Self {
        Self {
            kind,
            value: value.to_owned(),
        }
    }
}

impl Display for ParseEnumError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "invalid {}: {}", self.kind, self.value)
    }
}

impl Error for ParseEnumError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContractValidationError {
    InvalidWorkloadId,
    InvalidSourceSha256,
    ZeroCpu,
    ZeroMemory,
    ZeroWallTime,
    ZeroPidLimit,
    ZeroScratchDisk,
}

impl Display for ContractValidationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidWorkloadId => "invalid workload id",
            Self::InvalidSourceSha256 => "invalid source sha256",
            Self::ZeroCpu => "cpu_cores must be greater than zero",
            Self::ZeroMemory => "memory_mib must be greater than zero",
            Self::ZeroWallTime => "wall_time_seconds must be greater than zero",
            Self::ZeroPidLimit => "pid_limit must be greater than zero",
            Self::ZeroScratchDisk => "scratch_disk_mib must be greater than zero",
        };
        formatter.write_str(message)
    }
}

impl Error for ContractValidationError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransitionError {
    pub from: RunState,
    pub to: RunState,
}

impl Display for TransitionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "invalid WALLE state transition: {} -> {}",
            self.from, self.to
        )
    }
}

impl Error for TransitionError {}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_SHA: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn happy_path_reaches_certified_exactly() {
        let mut machine = RunMachine::new();
        for next in [
            RunState::Preparing,
            RunState::Isolated,
            RunState::Executing,
            RunState::Verifying,
            RunState::Certifying,
            RunState::Certified,
        ] {
            machine.transition(next).expect("valid transition");
        }
        assert_eq!(machine.state(), RunState::Certified);
        assert!(machine.state().is_terminal());
    }

    #[test]
    fn terminal_states_are_immutable() {
        for terminal in [
            RunState::Certified,
            RunState::Blocked,
            RunState::InsufficientData,
            RunState::Cancelled,
        ] {
            for candidate in [
                RunState::Planned,
                RunState::Preparing,
                RunState::Isolated,
                RunState::Executing,
                RunState::Verifying,
                RunState::Certifying,
                RunState::Certified,
                RunState::Blocked,
                RunState::InsufficientData,
                RunState::Cancelled,
            ] {
                assert!(!terminal.can_transition_to(candidate));
            }
        }
    }

    #[test]
    fn skipped_happy_path_transition_is_rejected() {
        assert!(!RunState::Planned.can_transition_to(RunState::Executing));
        assert!(!RunState::Executing.can_transition_to(RunState::Certified));
        assert!(!RunState::Verifying.can_transition_to(RunState::Isolated));
    }

    #[test]
    fn fail_closed_terminal_exits_are_available() {
        assert!(RunState::Planned.can_transition_to(RunState::Blocked));
        assert!(RunState::Executing.can_transition_to(RunState::Blocked));
        assert!(RunState::Certifying.can_transition_to(RunState::Cancelled));
        assert!(RunState::Executing.can_transition_to(RunState::InsufficientData));
        assert!(!RunState::Planned.can_transition_to(RunState::InsufficientData));
    }

    #[test]
    fn sha256_identity_is_strict_and_lowercase() {
        assert!(is_valid_sha256(VALID_SHA));
        assert!(!is_valid_sha256("0123456789abcdef"));
        assert!(!is_valid_sha256(
            "sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(!is_valid_sha256("sha256:deadbeef"));
    }

    #[test]
    fn workload_id_is_bounded_and_machine_safe() {
        assert!(is_valid_workload_id("seo-avengers-2500"));
        assert!(is_valid_workload_id("nexus.pipeline_v7"));
        assert!(!is_valid_workload_id(""));
        assert!(!is_valid_workload_id("Uppercase"));
        assert!(!is_valid_workload_id("../escape"));
        assert!(!is_valid_workload_id("contains space"));
    }

    #[test]
    fn contract_rejects_zero_resource_limits() {
        let contract = WorkloadContract {
            workload_id: "example",
            source_sha256: VALID_SHA,
            profile: CertificationProfile::Certification,
            network_policy: NetworkPolicy::DenyAll,
            resources: ResourcePlan {
                cpu_cores: 0,
                ..ResourcePlan::baseline(CertificationProfile::Certification)
            },
        };
        assert_eq!(contract.validate(), Err(ContractValidationError::ZeroCpu));
    }

    #[test]
    fn baseline_plans_are_monotonic() {
        let fast = ResourcePlan::baseline(CertificationProfile::Fast);
        let hardened = ResourcePlan::baseline(CertificationProfile::Hardened);
        let certification = ResourcePlan::baseline(CertificationProfile::Certification);

        assert!(fast.cpu_cores < hardened.cpu_cores);
        assert!(hardened.cpu_cores < certification.cpu_cores);
        assert!(fast.memory_mib < hardened.memory_mib);
        assert!(hardened.memory_mib < certification.memory_mib);
        assert!(fast.wall_time_seconds < hardened.wall_time_seconds);
        assert!(hardened.wall_time_seconds < certification.wall_time_seconds);
        assert!(fast.pid_limit < hardened.pid_limit);
        assert!(hardened.pid_limit < certification.pid_limit);
        assert!(fast.scratch_disk_mib < hardened.scratch_disk_mib);
        assert!(hardened.scratch_disk_mib < certification.scratch_disk_mib);
    }

    #[test]
    fn enums_round_trip_through_display_and_parser() {
        for profile in [
            CertificationProfile::Fast,
            CertificationProfile::Hardened,
            CertificationProfile::Certification,
        ] {
            assert_eq!(
                profile.to_string().parse::<CertificationProfile>(),
                Ok(profile)
            );
        }

        for state in [
            RunState::Planned,
            RunState::Preparing,
            RunState::Isolated,
            RunState::Executing,
            RunState::Verifying,
            RunState::Certifying,
            RunState::Certified,
            RunState::Blocked,
            RunState::InsufficientData,
            RunState::Cancelled,
        ] {
            assert_eq!(state.to_string().parse::<RunState>(), Ok(state));
        }
    }

    #[test]
    fn valid_contract_passes_without_hidden_defaults() {
        let profile = CertificationProfile::Certification;
        let contract = WorkloadContract {
            workload_id: "seo-avengers-2500",
            source_sha256: VALID_SHA,
            profile,
            network_policy: NetworkPolicy::DenyAll,
            resources: ResourcePlan::baseline(profile),
        };
        assert_eq!(contract.validate(), Ok(()));
    }
}
