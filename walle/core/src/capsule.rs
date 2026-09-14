use std::fmt::{Display, Formatter};

use walle_core::{CertificationProfile, NetworkPolicy, ResourcePlan};

pub const CAPSULE_SCHEMA_VERSION: u32 = 1;
pub const MAX_ALLOWLIST_ITEMS: usize = 128;
pub const MAX_OUTPUT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilesystemCapability {
    None,
    ReadOnlyInputs,
    ScratchAndDeclaredOutput,
}

impl FilesystemCapability {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "NONE",
            Self::ReadOnlyInputs => "READ_ONLY_INPUTS",
            Self::ScratchAndDeclaredOutput => "SCRATCH_AND_DECLARED_OUTPUT",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildProcessCapability {
    Deny,
    Bounded,
}

impl ChildProcessCapability {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "DENY",
            Self::Bounded => "BOUNDED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancellationOwner {
    WalleControlPlane,
}

impl CancellationOwner {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WalleControlPlane => "WALLE_CONTROL_PLANE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CancellationPolicy {
    pub owner: CancellationOwner,
    pub grace_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilityRequest<'a> {
    pub filesystem: FilesystemCapability,
    pub network: NetworkPolicy,
    pub network_allowlist: &'a [&'a str],
    pub child_processes: ChildProcessCapability,
    pub secret_names: &'a [&'a str],
    pub device_names: &'a [&'a str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutionCapsule<'a> {
    pub run_id: &'a str,
    pub attempt: u32,
    pub adapter_id: &'a str,
    pub adapter_version: &'a str,
    pub workload_id: &'a str,
    pub source_sha256: &'a str,
    pub profile: CertificationProfile,
    pub resources: ResourcePlan,
    pub capabilities: CapabilityRequest<'a>,
    pub timeout_ms: u64,
    pub max_stdout_bytes: u64,
    pub max_stderr_bytes: u64,
    pub cancellation: CancellationPolicy,
}

impl ExecutionCapsule<'_> {
    pub fn validate(self) -> Result<(), CapsuleError> {
        if !is_run_id(self.run_id) {
            return Err(CapsuleError::InvalidRunId);
        }
        if self.attempt == 0 {
            return Err(CapsuleError::InvalidAttempt);
        }
        if !is_machine_token(self.adapter_id, 128) {
            return Err(CapsuleError::InvalidAdapterId);
        }
        if !is_machine_token(self.adapter_version, 64) {
            return Err(CapsuleError::InvalidAdapterVersion);
        }
        if !is_machine_token(self.workload_id, 128) {
            return Err(CapsuleError::InvalidWorkloadId);
        }
        if !walle_core::is_valid_sha256(self.source_sha256) {
            return Err(CapsuleError::InvalidSourceSha256);
        }
        self.resources
            .validate()
            .map_err(|_| CapsuleError::InvalidResources)?;

        let wall_time_ms = self
            .resources
            .wall_time_seconds
            .checked_mul(1_000)
            .ok_or(CapsuleError::TimeoutOutOfRange)?;
        if self.timeout_ms == 0 || self.timeout_ms > wall_time_ms {
            return Err(CapsuleError::TimeoutOutOfRange);
        }
        if self.max_stdout_bytes == 0
            || self.max_stderr_bytes == 0
            || self.max_stdout_bytes > MAX_OUTPUT_BYTES
            || self.max_stderr_bytes > MAX_OUTPUT_BYTES
        {
            return Err(CapsuleError::OutputLimitOutOfRange);
        }
        if self.cancellation.grace_ms > self.timeout_ms {
            return Err(CapsuleError::CancellationGraceOutOfRange);
        }

        validate_capabilities(self.capabilities)
    }

    pub fn canonical_json(self) -> Result<String, CapsuleError> {
        self.validate()?;
        let mut output = String::with_capacity(1_024);
        output.push('{');
        push_key_str(&mut output, "adapter_id", self.adapter_id);
        output.push(',');
        push_key_str(&mut output, "adapter_version", self.adapter_version);
        output.push(',');
        push_key_u64(&mut output, "attempt", u64::from(self.attempt));
        output.push(',');
        output.push_str("\"cancellation\":{");
        push_key_u64(&mut output, "grace_ms", self.cancellation.grace_ms);
        output.push(',');
        push_key_str(&mut output, "owner", self.cancellation.owner.as_str());
        output.push('}');
        output.push(',');
        output.push_str("\"capabilities\":{");
        push_key_str(
            &mut output,
            "child_processes",
            self.capabilities.child_processes.as_str(),
        );
        output.push(',');
        push_key_array(&mut output, "device_names", self.capabilities.device_names);
        output.push(',');
        push_key_str(
            &mut output,
            "filesystem",
            self.capabilities.filesystem.as_str(),
        );
        output.push(',');
        push_key_str(&mut output, "network", self.capabilities.network.as_str());
        output.push(',');
        push_key_array(
            &mut output,
            "network_allowlist",
            self.capabilities.network_allowlist,
        );
        output.push(',');
        push_key_array(&mut output, "secret_names", self.capabilities.secret_names);
        output.push('}');
        output.push(',');
        push_key_u64(&mut output, "max_stderr_bytes", self.max_stderr_bytes);
        output.push(',');
        push_key_u64(&mut output, "max_stdout_bytes", self.max_stdout_bytes);
        output.push(',');
        push_key_str(&mut output, "profile", self.profile.as_str());
        output.push(',');
        output.push_str("\"resources\":{");
        push_key_u64(
            &mut output,
            "cpu_cores",
            u64::from(self.resources.cpu_cores),
        );
        output.push(',');
        push_key_u64(&mut output, "memory_mib", self.resources.memory_mib);
        output.push(',');
        push_key_u64(
            &mut output,
            "pid_limit",
            u64::from(self.resources.pid_limit),
        );
        output.push(',');
        push_key_u64(
            &mut output,
            "scratch_disk_mib",
            self.resources.scratch_disk_mib,
        );
        output.push(',');
        push_key_u64(
            &mut output,
            "wall_time_seconds",
            self.resources.wall_time_seconds,
        );
        output.push('}');
        output.push(',');
        push_key_str(&mut output, "run_id", self.run_id);
        output.push(',');
        push_key_u64(
            &mut output,
            "schema_version",
            u64::from(CAPSULE_SCHEMA_VERSION),
        );
        output.push(',');
        push_key_str(&mut output, "source_sha256", self.source_sha256);
        output.push(',');
        push_key_u64(&mut output, "timeout_ms", self.timeout_ms);
        output.push(',');
        push_key_str(&mut output, "workload_id", self.workload_id);
        output.push('}');
        Ok(output)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionExitClass {
    Success,
    WorkloadFailure,
    TimedOut,
    Cancelled,
    PolicyViolation,
    MalformedOutput,
    InfrastructureError,
}

impl ExecutionExitClass {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "SUCCESS",
            Self::WorkloadFailure => "WORKLOAD_FAILURE",
            Self::TimedOut => "TIMED_OUT",
            Self::Cancelled => "CANCELLED",
            Self::PolicyViolation => "POLICY_VIOLATION",
            Self::MalformedOutput => "MALFORMED_OUTPUT",
            Self::InfrastructureError => "INFRASTRUCTURE_ERROR",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitObservation {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub policy_violation: bool,
    pub output_well_formed: bool,
}

pub const fn classify_exit(observation: ExitObservation) -> ExecutionExitClass {
    if observation.policy_violation {
        return ExecutionExitClass::PolicyViolation;
    }
    if observation.cancelled {
        return ExecutionExitClass::Cancelled;
    }
    if observation.timed_out {
        return ExecutionExitClass::TimedOut;
    }
    if !observation.output_well_formed {
        return ExecutionExitClass::MalformedOutput;
    }
    match observation.exit_code {
        Some(0) => ExecutionExitClass::Success,
        Some(_) => ExecutionExitClass::WorkloadFailure,
        None => ExecutionExitClass::InfrastructureError,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionPhase {
    Prepare,
    Isolate,
    Execute,
    Verify,
    Certify,
}

impl ExecutionPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Prepare => "PREPARE",
            Self::Isolate => "ISOLATE",
            Self::Execute => "EXECUTE",
            Self::Verify => "VERIFY",
            Self::Certify => "CERTIFY",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhaseOutcome {
    Pass,
    Blocked,
    InsufficientData,
    Cancelled,
}

impl PhaseOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "PASS",
            Self::Blocked => "BLOCKED",
            Self::InsufficientData => "INSUFFICIENT_DATA",
            Self::Cancelled => "CANCELLED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhaseReceipt<'a> {
    pub run_id: &'a str,
    pub sequence: u32,
    pub phase: ExecutionPhase,
    pub outcome: PhaseOutcome,
    pub reason_code: &'a str,
    pub evidence_sha256: Option<&'a str>,
}

impl PhaseReceipt<'_> {
    pub fn validate(self) -> Result<(), CapsuleError> {
        if !is_run_id(self.run_id) {
            return Err(CapsuleError::InvalidRunId);
        }
        if self.sequence == 0 {
            return Err(CapsuleError::InvalidReceiptSequence);
        }
        if !is_reason_code(self.reason_code) {
            return Err(CapsuleError::InvalidReasonCode);
        }
        if let Some(hash) = self.evidence_sha256 {
            if !walle_core::is_valid_sha256(hash) {
                return Err(CapsuleError::InvalidEvidenceSha256);
            }
        } else if self.outcome == PhaseOutcome::Pass {
            return Err(CapsuleError::PassingReceiptMissingEvidence);
        }
        Ok(())
    }

    pub fn canonical_json(self) -> Result<String, CapsuleError> {
        self.validate()?;
        let mut output = String::with_capacity(320);
        output.push('{');
        output.push_str("\"evidence_sha256\":");
        match self.evidence_sha256 {
            Some(value) => push_json_string(&mut output, value),
            None => output.push_str("null"),
        }
        output.push(',');
        push_key_str(&mut output, "outcome", self.outcome.as_str());
        output.push(',');
        push_key_str(&mut output, "phase", self.phase.as_str());
        output.push(',');
        push_key_str(&mut output, "reason_code", self.reason_code);
        output.push(',');
        push_key_str(&mut output, "run_id", self.run_id);
        output.push(',');
        push_key_u64(&mut output, "sequence", u64::from(self.sequence));
        output.push('}');
        Ok(output)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapsuleError {
    InvalidRunId,
    InvalidAttempt,
    InvalidAdapterId,
    InvalidAdapterVersion,
    InvalidWorkloadId,
    InvalidSourceSha256,
    InvalidResources,
    TimeoutOutOfRange,
    OutputLimitOutOfRange,
    CancellationGraceOutOfRange,
    InvalidNetworkAllowlist,
    NetworkAllowlistNotAllowed,
    NetworkAllowlistRequired,
    InvalidSecretNames,
    InvalidDeviceNames,
    InvalidReceiptSequence,
    InvalidReasonCode,
    InvalidEvidenceSha256,
    PassingReceiptMissingEvidence,
}

impl Display for CapsuleError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRunId => "invalid run id",
            Self::InvalidAttempt => "attempt must be greater than zero",
            Self::InvalidAdapterId => "invalid adapter id",
            Self::InvalidAdapterVersion => "invalid adapter version",
            Self::InvalidWorkloadId => "invalid workload id",
            Self::InvalidSourceSha256 => "invalid source sha256",
            Self::InvalidResources => "invalid resource plan",
            Self::TimeoutOutOfRange => "timeout is outside the resource wall-time budget",
            Self::OutputLimitOutOfRange => "stdout/stderr byte limits are outside allowed bounds",
            Self::CancellationGraceOutOfRange => "cancellation grace exceeds execution timeout",
            Self::InvalidNetworkAllowlist => "invalid network allowlist",
            Self::NetworkAllowlistNotAllowed => {
                "network allowlist provided for non-allowlist policy"
            }
            Self::NetworkAllowlistRequired => {
                "explicit network policy requires non-empty allowlist"
            }
            Self::InvalidSecretNames => "invalid secret name list",
            Self::InvalidDeviceNames => "invalid device name list",
            Self::InvalidReceiptSequence => "phase receipt sequence must be greater than zero",
            Self::InvalidReasonCode => "invalid phase receipt reason code",
            Self::InvalidEvidenceSha256 => "invalid phase receipt evidence sha256",
            Self::PassingReceiptMissingEvidence => "passing phase receipt requires evidence sha256",
        })
    }
}

fn validate_capabilities(capabilities: CapabilityRequest<'_>) -> Result<(), CapsuleError> {
    validate_sorted_unique_tokens(capabilities.secret_names, 96)
        .map_err(|_| CapsuleError::InvalidSecretNames)?;
    validate_sorted_unique_tokens(capabilities.device_names, 96)
        .map_err(|_| CapsuleError::InvalidDeviceNames)?;
    validate_sorted_unique_network_targets(capabilities.network_allowlist)?;

    match capabilities.network {
        NetworkPolicy::DenyAll | NetworkPolicy::LoopbackOnly => {
            if !capabilities.network_allowlist.is_empty() {
                return Err(CapsuleError::NetworkAllowlistNotAllowed);
            }
        }
        NetworkPolicy::ExplicitAllowlist => {
            if capabilities.network_allowlist.is_empty() {
                return Err(CapsuleError::NetworkAllowlistRequired);
            }
        }
    }
    Ok(())
}

fn validate_sorted_unique_network_targets(values: &[&str]) -> Result<(), CapsuleError> {
    if values.len() > MAX_ALLOWLIST_ITEMS {
        return Err(CapsuleError::InvalidNetworkAllowlist);
    }
    let mut previous: Option<&str> = None;
    for value in values {
        if value.is_empty()
            || value.len() > 253
            || !value.is_ascii()
            || value
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        {
            return Err(CapsuleError::InvalidNetworkAllowlist);
        }
        if previous.is_some_and(|prior| prior >= *value) {
            return Err(CapsuleError::InvalidNetworkAllowlist);
        }
        previous = Some(value);
    }
    Ok(())
}

fn validate_sorted_unique_tokens(values: &[&str], max_len: usize) -> Result<(), ()> {
    if values.len() > MAX_ALLOWLIST_ITEMS {
        return Err(());
    }
    let mut previous: Option<&str> = None;
    for value in values {
        if !is_machine_token(value, max_len) || previous.is_some_and(|prior| prior >= *value) {
            return Err(());
        }
        previous = Some(value);
    }
    Ok(())
}

fn is_run_id(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("run-") else {
        return false;
    };
    suffix.len() == 32
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_reason_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b'_'))
}

fn is_machine_token(value: &str, max_len: usize) -> bool {
    if value.is_empty() || value.len() > max_len {
        return false;
    }
    let bytes = value.as_bytes();
    (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(*byte, b'-' | b'_' | b'.')
        })
}

fn push_key_str(output: &mut String, key: &str, value: &str) {
    push_json_string(output, key);
    output.push(':');
    push_json_string(output, value);
}

fn push_key_u64(output: &mut String, key: &str, value: u64) {
    push_json_string(output, key);
    output.push(':');
    output.push_str(&value.to_string());
}

fn push_key_array(output: &mut String, key: &str, values: &[&str]) {
    push_json_string(output, key);
    output.push(':');
    output.push('[');
    for (index, value) in values.iter().enumerate() {
        if index != 0 {
            output.push(',');
        }
        push_json_string(output, value);
    }
    output.push(']');
}

fn push_json_string(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character <= '\u{1f}' => {
                let code = u32::from(character);
                output.push_str("\\u00");
                const HEX: &[u8; 16] = b"0123456789abcdef";
                output.push(char::from(HEX[((code >> 4) & 0x0f) as usize]));
                output.push(char::from(HEX[(code & 0x0f) as usize]));
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const EVIDENCE: &str =
        "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    fn valid_capsule() -> ExecutionCapsule<'static> {
        ExecutionCapsule {
            run_id: "run-0123456789abcdef0123456789abcdef",
            attempt: 1,
            adapter_id: "seo-avengers-2500",
            adapter_version: "1.0.0",
            workload_id: "seo-avengers-2500",
            source_sha256: SOURCE,
            profile: CertificationProfile::Certification,
            resources: ResourcePlan::baseline(CertificationProfile::Certification),
            capabilities: CapabilityRequest {
                filesystem: FilesystemCapability::ReadOnlyInputs,
                network: NetworkPolicy::DenyAll,
                network_allowlist: &[],
                child_processes: ChildProcessCapability::Bounded,
                secret_names: &[],
                device_names: &[],
            },
            timeout_ms: 1_200_000,
            max_stdout_bytes: 64 * 1024 * 1024,
            max_stderr_bytes: 64 * 1024,
            cancellation: CancellationPolicy {
                owner: CancellationOwner::WalleControlPlane,
                grace_ms: 5_000,
            },
        }
    }

    #[test]
    fn capsule_is_valid_and_canonical_json_is_byte_stable() {
        let capsule = valid_capsule();
        let first = capsule.canonical_json().expect("canonical manifest");
        let second = capsule.canonical_json().expect("canonical manifest");
        assert_eq!(first, second);
        assert!(first.starts_with("{\"adapter_id\":\"seo-avengers-2500\""));
        assert!(first.contains("\"schema_version\":1"));
        assert!(!first.contains(' '));
        assert!(!first.contains('\n'));
    }

    #[test]
    fn invalid_run_identity_is_rejected() {
        let mut capsule = valid_capsule();
        capsule.run_id = "run-not-a-real-id";
        assert_eq!(capsule.validate(), Err(CapsuleError::InvalidRunId));
    }

    #[test]
    fn timeout_cannot_exceed_wall_time_budget() {
        let mut capsule = valid_capsule();
        capsule.timeout_ms = capsule.resources.wall_time_seconds * 1_000 + 1;
        assert_eq!(capsule.validate(), Err(CapsuleError::TimeoutOutOfRange));
    }

    #[test]
    fn output_caps_are_bounded() {
        let mut capsule = valid_capsule();
        capsule.max_stdout_bytes = MAX_OUTPUT_BYTES + 1;
        assert_eq!(capsule.validate(), Err(CapsuleError::OutputLimitOutOfRange));
    }

    #[test]
    fn deny_all_rejects_network_allowlist() {
        let mut capsule = valid_capsule();
        capsule.capabilities.network_allowlist = &["example.com:443"];
        assert_eq!(
            capsule.validate(),
            Err(CapsuleError::NetworkAllowlistNotAllowed)
        );
    }

    #[test]
    fn explicit_network_requires_sorted_unique_targets() {
        let mut capsule = valid_capsule();
        capsule.capabilities.network = NetworkPolicy::ExplicitAllowlist;
        capsule.capabilities.network_allowlist = &[];
        assert_eq!(
            capsule.validate(),
            Err(CapsuleError::NetworkAllowlistRequired)
        );

        capsule.capabilities.network_allowlist = &["z.example:443", "a.example:443"];
        assert_eq!(
            capsule.validate(),
            Err(CapsuleError::InvalidNetworkAllowlist)
        );

        capsule.capabilities.network_allowlist = &["a.example:443", "z.example:443"];
        assert_eq!(capsule.validate(), Ok(()));
    }

    #[test]
    fn named_secret_and_device_grants_must_be_sorted_and_machine_safe() {
        let mut capsule = valid_capsule();
        capsule.capabilities.secret_names = &["token_b", "token_a"];
        assert_eq!(capsule.validate(), Err(CapsuleError::InvalidSecretNames));

        capsule.capabilities.secret_names = &["token_a", "token_b"];
        capsule.capabilities.device_names = &["/dev/kvm"];
        assert_eq!(capsule.validate(), Err(CapsuleError::InvalidDeviceNames));
    }

    #[test]
    fn exit_classifier_never_promotes_timeout_or_policy_failure_to_success() {
        assert_eq!(
            classify_exit(ExitObservation {
                exit_code: Some(0),
                timed_out: true,
                cancelled: false,
                policy_violation: false,
                output_well_formed: true,
            }),
            ExecutionExitClass::TimedOut
        );
        assert_eq!(
            classify_exit(ExitObservation {
                exit_code: Some(0),
                timed_out: false,
                cancelled: false,
                policy_violation: true,
                output_well_formed: true,
            }),
            ExecutionExitClass::PolicyViolation
        );
    }

    #[test]
    fn malformed_output_blocks_zero_exit() {
        assert_eq!(
            classify_exit(ExitObservation {
                exit_code: Some(0),
                timed_out: false,
                cancelled: false,
                policy_violation: false,
                output_well_formed: false,
            }),
            ExecutionExitClass::MalformedOutput
        );
    }

    #[test]
    fn passing_phase_receipt_requires_real_evidence_hash() {
        let receipt = PhaseReceipt {
            run_id: "run-0123456789abcdef0123456789abcdef",
            sequence: 1,
            phase: ExecutionPhase::Prepare,
            outcome: PhaseOutcome::Pass,
            reason_code: "SOURCE_BOUND",
            evidence_sha256: None,
        };
        assert_eq!(
            receipt.validate(),
            Err(CapsuleError::PassingReceiptMissingEvidence)
        );

        let receipt = PhaseReceipt {
            evidence_sha256: Some(EVIDENCE),
            ..receipt
        };
        let json = receipt.canonical_json().expect("receipt json");
        assert!(json.contains(EVIDENCE));
        assert!(json.contains("\"outcome\":\"PASS\""));
    }
}
