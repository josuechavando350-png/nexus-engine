use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::str;

use walle_core::supervisor::MicroVmSupervisorPlan;

use crate::artifact::{open_regular_no_symlinks, ArtifactError, SystemSha256};
use crate::evidence::{
    verify_evidence_chain, EvidenceError, EvidenceReceipt, EvidenceRun, EvidenceSeal,
};
use crate::guest_image::AdmittedGuestImageIdentity;
use crate::guest_protocol::{GuestAttestation, GuestCompletion};
use crate::safe_fs::{SecureDirectory, SecureFsError};
use crate::trusted_guest_proofs::{
    derive_trusted_guest_proof_payloads, TrustedGuestProofPayloads,
};

pub const TRUSTED_GUEST_EVIDENCE_DIRECTORY: &str = "trusted-guest-proofs";
pub const NETWORK_ISOLATION_EVIDENCE_KIND: &str = "network-isolation";
pub const GUEST_SECCOMP_EVIDENCE_KIND: &str = "guest-seccomp";
pub const GUEST_COMPLETION_ACK_EVIDENCE_KIND: &str = "guest-completion-ack";

const GUEST_ATTESTATION_CANDIDATE_EVIDENCE_KIND: &str = "guest-attestation-candidate";
const UNTRUSTED_GUEST_MARKER: &str = "UNTRUSTED_GUEST_CLAIM_PENDING_AGENT_IDENTITY";
const MAX_RECEIPT_BYTES: u64 = 4 * 1024;
const MAX_CANDIDATE_PAYLOAD_BYTES: u64 = 4 * 1024;

#[derive(Debug)]
pub enum TrustedGuestEvidenceError {
    PrimaryEvidenceBindingMismatch,
    DuplicateGuestAttestationCandidate,
    MalformedGuestAttestationCandidateReceipt,
    MalformedGuestAttestationCandidatePayload,
    BoundedReadExceeded(PathBuf),
    Artifact(ArtifactError),
    Evidence(EvidenceError),
    SecureFs(SecureFsError),
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl Display for TrustedGuestEvidenceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PrimaryEvidenceBindingMismatch => formatter.write_str(
                "primary supervisor evidence seal is not bound to the trusted guest run",
            ),
            Self::DuplicateGuestAttestationCandidate => formatter.write_str(
                "primary supervisor evidence contains more than one guest attestation candidate",
            ),
            Self::MalformedGuestAttestationCandidateReceipt => formatter.write_str(
                "guest attestation candidate receipt is not the canonical run-bound receipt shape",
            ),
            Self::MalformedGuestAttestationCandidatePayload => formatter.write_str(
                "guest attestation candidate payload is not canonical or identity-bound",
            ),
            Self::BoundedReadExceeded(path) => write!(
                formatter,
                "trusted guest evidence input exceeds its bounded read limit: {}",
                path.display()
            ),
            Self::Artifact(error) => Display::fmt(error, formatter),
            Self::Evidence(error) => Display::fmt(error, formatter),
            Self::SecureFs(error) => Display::fmt(error, formatter),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for TrustedGuestEvidenceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Artifact(error) => Some(error),
            Self::Evidence(error) => Some(error),
            Self::SecureFs(error) => Some(error),
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<ArtifactError> for TrustedGuestEvidenceError {
    fn from(value: ArtifactError) -> Self {
        Self::Artifact(value)
    }
}

impl From<EvidenceError> for TrustedGuestEvidenceError {
    fn from(value: EvidenceError) -> Self {
        Self::Evidence(value)
    }
}

impl From<SecureFsError> for TrustedGuestEvidenceError {
    fn from(value: SecureFsError) -> Self {
        Self::SecureFs(value)
    }
}

#[derive(Debug, Default)]
pub struct TrustedGuestProofEvidence {
    network_isolation_receipt: Option<EvidenceReceipt>,
    guest_seccomp_receipt: Option<EvidenceReceipt>,
    guest_completion_ack_receipt: Option<EvidenceReceipt>,
    seal: Option<EvidenceSeal>,
}

impl TrustedGuestProofEvidence {
    pub fn network_isolation_receipt(&self) -> Option<&EvidenceReceipt> {
        self.network_isolation_receipt.as_ref()
    }

    pub fn guest_seccomp_receipt(&self) -> Option<&EvidenceReceipt> {
        self.guest_seccomp_receipt.as_ref()
    }

    pub fn guest_completion_ack_receipt(&self) -> Option<&EvidenceReceipt> {
        self.guest_completion_ack_receipt.as_ref()
    }

    pub fn seal(&self) -> Option<&EvidenceSeal> {
        self.seal.as_ref()
    }

    pub fn is_empty(&self) -> bool {
        self.network_isolation_receipt.is_none()
            && self.guest_seccomp_receipt.is_none()
            && self.guest_completion_ack_receipt.is_none()
    }
}

/// Re-anchors the strict physical serial candidate to the already-proven guest
/// agent/rootfs identity and persists each qualifying guest proof in a separate
/// sealed evidence extension chain bound to the exact same run id and source
/// SHA-256 as the primary supervisor chain.
///
/// The primary supervisor path has already re-read and verified its complete
/// chain before returning. This function re-opens only that trusted root-owned
/// evidence directory, locates the canonical candidate receipt by deterministic
/// sequence, parses the exact canonical candidate payload and then applies the
/// trusted identity qualification. No candidate means no guest proof rather
/// than a fabricated result. Any malformed/duplicate candidate fails closed.
pub fn persist_trusted_guest_proof_evidence(
    evidence_root: &Path,
    sha256_program: impl Into<PathBuf>,
    plan: &MicroVmSupervisorPlan<'_>,
    identity: &AdmittedGuestImageIdentity,
    primary_seal: &EvidenceSeal,
) -> Result<TrustedGuestProofEvidence, TrustedGuestEvidenceError> {
    if primary_seal.run_id != plan.run_id || primary_seal.source_sha256 != plan.source_sha256 {
        return Err(TrustedGuestEvidenceError::PrimaryEvidenceBindingMismatch);
    }

    let primary_run_directory = evidence_root.join(plan.run_id);
    let primary_directory = SecureDirectory::open(primary_run_directory.clone())?;
    primary_directory.validate_trusted()?;

    let Some(attestation) = load_primary_guest_attestation_candidate(
        &primary_run_directory,
        primary_seal,
        plan,
    )? else {
        return Ok(TrustedGuestProofEvidence::default());
    };

    let Some(payloads) = derive_trusted_guest_proof_payloads(plan, identity, &attestation) else {
        return Ok(TrustedGuestProofEvidence::default());
    };
    if payloads.network_isolation.is_none()
        && payloads.guest_seccomp.is_none()
        && payloads.guest_completion_ack.is_none()
    {
        return Ok(TrustedGuestProofEvidence::default());
    }

    persist_extension_chain(
        evidence_root,
        sha256_program.into(),
        plan,
        payloads,
    )
}

fn persist_extension_chain(
    evidence_root: &Path,
    sha256_program: PathBuf,
    plan: &MicroVmSupervisorPlan<'_>,
    payloads: TrustedGuestProofPayloads,
) -> Result<TrustedGuestProofEvidence, TrustedGuestEvidenceError> {
    let root = SecureDirectory::open(evidence_root.to_path_buf())?;
    root.validate_trusted()?;
    let proof_root = root.create_child_directory(TRUSTED_GUEST_EVIDENCE_DIRECTORY, 0o700, true)?;
    proof_root.validate_trusted()?;

    let mut run = EvidenceRun::begin(
        proof_root.path().to_path_buf(),
        sha256_program.clone(),
        plan.run_id,
        plan.source_sha256,
    )?;
    let mut receipts = Vec::with_capacity(3);

    let network_isolation_receipt = match payloads.network_isolation {
        Some(payload) => {
            let receipt = run.append(NETWORK_ISOLATION_EVIDENCE_KIND, payload.as_bytes())?;
            receipts.push(receipt.clone());
            Some(receipt)
        }
        None => None,
    };
    let guest_seccomp_receipt = match payloads.guest_seccomp {
        Some(payload) => {
            let receipt = run.append(GUEST_SECCOMP_EVIDENCE_KIND, payload.as_bytes())?;
            receipts.push(receipt.clone());
            Some(receipt)
        }
        None => None,
    };
    let guest_completion_ack_receipt = match payloads.guest_completion_ack {
        Some(payload) => {
            let receipt = run.append(GUEST_COMPLETION_ACK_EVIDENCE_KIND, payload.as_bytes())?;
            receipts.push(receipt.clone());
            Some(receipt)
        }
        None => None,
    };

    let seal = run.seal()?;
    let hasher = SystemSha256::new(sha256_program)?;
    verify_evidence_chain(run.path(), &receipts, &seal, &hasher)?;

    Ok(TrustedGuestProofEvidence {
        network_isolation_receipt,
        guest_seccomp_receipt,
        guest_completion_ack_receipt,
        seal: Some(seal),
    })
}

fn load_primary_guest_attestation_candidate(
    primary_run_directory: &Path,
    primary_seal: &EvidenceSeal,
    plan: &MicroVmSupervisorPlan<'_>,
) -> Result<Option<GuestAttestation>, TrustedGuestEvidenceError> {
    let mut found = None;
    for sequence in 1..=primary_seal.entry_count {
        let receipt_path = primary_run_directory.join(format!("{sequence:06}.receipt.json"));
        let receipt_bytes = read_bounded(&receipt_path, MAX_RECEIPT_BYTES)?;
        let receipt_text = str::from_utf8(&receipt_bytes)
            .map_err(|_| TrustedGuestEvidenceError::MalformedGuestAttestationCandidateReceipt)?;
        if !receipt_text.starts_with(&format!(
            "{{\"kind\":\"{GUEST_ATTESTATION_CANDIDATE_EVIDENCE_KIND}\","
        )) {
            continue;
        }
        if found.is_some() {
            return Err(TrustedGuestEvidenceError::DuplicateGuestAttestationCandidate);
        }
        validate_candidate_receipt(receipt_text, sequence, plan)?;
        let payload_path = primary_run_directory.join(format!("{sequence:06}.payload"));
        let payload = read_bounded(&payload_path, MAX_CANDIDATE_PAYLOAD_BYTES)?;
        found = Some(parse_canonical_candidate(&payload, plan)?);
    }
    Ok(found)
}

fn validate_candidate_receipt(
    receipt: &str,
    sequence: u64,
    plan: &MicroVmSupervisorPlan<'_>,
) -> Result<(), TrustedGuestEvidenceError> {
    let payload_file = format!("{sequence:06}.payload");
    let required = [
        format!("\"payload_file\":\"{payload_file}\""),
        format!("\"run_id\":\"{}\"", plan.run_id),
        "\"schema_version\":1".to_owned(),
        format!("\"sequence\":{sequence}"),
        format!("\"source_sha256\":\"{}\"", plan.source_sha256),
    ];
    if required.iter().all(|needle| receipt.contains(needle))
        && receipt.ends_with('}')
        && receipt.matches("\"kind\":").count() == 1
        && receipt.matches("\"payload_file\":").count() == 1
        && receipt.matches("\"run_id\":").count() == 1
        && receipt.matches("\"sequence\":").count() == 1
        && receipt.matches("\"source_sha256\":").count() == 1
    {
        Ok(())
    } else {
        Err(TrustedGuestEvidenceError::MalformedGuestAttestationCandidateReceipt)
    }
}

fn parse_canonical_candidate(
    payload: &[u8],
    plan: &MicroVmSupervisorPlan<'_>,
) -> Result<GuestAttestation, TrustedGuestEvidenceError> {
    let text = str::from_utf8(payload)
        .map_err(|_| TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload)?;
    let completion = extract_string_field(text, "{\"completion\":\"", "\",")?;
    let network = extract_u32_after(text, "\"network_non_loopback_interfaces\":")?;
    let no_new_privs = extract_bool_after(text, "\"no_new_privs\":")?;
    let run_id = extract_string_after(text, "\"run_id\":\"")?;
    let seccomp_mode = extract_u8_after(text, "\"seccomp_mode\":")?;
    let seccomp_policy = extract_string_after(text, "\"seccomp_policy\":\"")?;
    let source_sha256 = extract_string_after(text, "\"source_sha256\":\"")?;
    let trust = extract_string_after(text, "\"trust\":\"")?;
    let workload_exit_code = extract_i32_after(text, "\"workload_exit_code\":")?;

    let completion = match completion {
        "SUCCESS" => GuestCompletion::Success,
        "FAILURE" => GuestCompletion::Failure,
        _ => return Err(TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload),
    };
    if run_id != plan.run_id
        || source_sha256 != plan.source_sha256
        || trust != UNTRUSTED_GUEST_MARKER
    {
        return Err(TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload);
    }

    let attestation = GuestAttestation {
        run_id: run_id.to_owned(),
        source_sha256: source_sha256.to_owned(),
        seccomp_mode,
        seccomp_policy: seccomp_policy.to_owned(),
        no_new_privs,
        network_non_loopback_interfaces: network,
        workload_exit_code,
        completion,
    };
    if attestation.canonical_json() != text {
        return Err(TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload);
    }
    Ok(attestation)
}

fn extract_string_field<'a>(
    text: &'a str,
    prefix: &str,
    suffix: &str,
) -> Result<&'a str, TrustedGuestEvidenceError> {
    let rest = text
        .strip_prefix(prefix)
        .ok_or(TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload)?;
    rest.split_once(suffix)
        .map(|(value, _)| value)
        .ok_or(TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload)
}

fn extract_string_after<'a>(
    text: &'a str,
    field_prefix: &str,
) -> Result<&'a str, TrustedGuestEvidenceError> {
    let start = text
        .find(field_prefix)
        .ok_or(TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload)?;
    let rest = &text[start + field_prefix.len()..];
    rest.split_once('"')
        .map(|(value, _)| value)
        .ok_or(TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload)
}

fn extract_u32_after(text: &str, field_prefix: &str) -> Result<u32, TrustedGuestEvidenceError> {
    extract_number_after(text, field_prefix)?.parse::<u32>().map_err(|_| {
        TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload
    })
}

fn extract_u8_after(text: &str, field_prefix: &str) -> Result<u8, TrustedGuestEvidenceError> {
    extract_number_after(text, field_prefix)?.parse::<u8>().map_err(|_| {
        TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload
    })
}

fn extract_i32_after(text: &str, field_prefix: &str) -> Result<i32, TrustedGuestEvidenceError> {
    extract_number_after(text, field_prefix)?.parse::<i32>().map_err(|_| {
        TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload
    })
}

fn extract_bool_after(text: &str, field_prefix: &str) -> Result<bool, TrustedGuestEvidenceError> {
    match extract_number_after(text, field_prefix)? {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload),
    }
}

fn extract_number_after<'a>(
    text: &'a str,
    field_prefix: &str,
) -> Result<&'a str, TrustedGuestEvidenceError> {
    let start = text
        .find(field_prefix)
        .ok_or(TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload)?;
    let rest = &text[start + field_prefix.len()..];
    let end = rest
        .find([',', '}'])
        .ok_or(TrustedGuestEvidenceError::MalformedGuestAttestationCandidatePayload)?;
    Ok(&rest[..end])
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, TrustedGuestEvidenceError> {
    let file = open_regular_no_symlinks(path)?;
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|source| TrustedGuestEvidenceError::Io {
            operation: "read trusted guest evidence input",
            source,
        })?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > max_bytes {
        return Err(TrustedGuestEvidenceError::BoundedReadExceeded(
            path.to_path_buf(),
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use walle_core::supervisor::CgroupV2Plan;

    const RUN_ID: &str = "run-0123456789abcdef0123456789abcdef";
    const SOURCE_SHA: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn plan() -> MicroVmSupervisorPlan<'static> {
        MicroVmSupervisorPlan {
            run_id: RUN_ID,
            workload_id: "seo-avengers-2500",
            source_sha256: SOURCE_SHA,
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

    fn candidate() -> GuestAttestation {
        GuestAttestation {
            run_id: RUN_ID.to_owned(),
            source_sha256: SOURCE_SHA.to_owned(),
            seccomp_mode: 2,
            seccomp_policy: "WALLE_GUEST_SECCOMP_V1".to_owned(),
            no_new_privs: true,
            network_non_loopback_interfaces: 0,
            workload_exit_code: 0,
            completion: GuestCompletion::Success,
        }
    }

    #[test]
    fn canonical_candidate_parser_round_trips_exact_guest_protocol_payload() {
        let canonical = candidate().canonical_json();
        let parsed = parse_canonical_candidate(canonical.as_bytes(), &plan()).expect("candidate");
        assert_eq!(parsed, candidate());
    }

    #[test]
    fn candidate_parser_rejects_cross_run_or_noncanonical_content() {
        let canonical = candidate().canonical_json();
        let wrong_run = canonical.replace(RUN_ID, "run-ffffffffffffffffffffffffffffffff");
        assert!(parse_canonical_candidate(wrong_run.as_bytes(), &plan()).is_err());

        let reordered = canonical.replace(
            "\"network_non_loopback_interfaces\":0,\"no_new_privs\":true",
            "\"no_new_privs\":true,\"network_non_loopback_interfaces\":0",
        );
        assert!(parse_canonical_candidate(reordered.as_bytes(), &plan()).is_err());
    }

    #[test]
    fn candidate_receipt_requires_exact_sequence_run_and_source_binding() {
        let receipt = format!(
            concat!(
                "{{",
                "\"kind\":\"guest-attestation-candidate\",",
                "\"payload_bytes\":512,",
                "\"payload_file\":\"000005.payload\",",
                "\"payload_sha256\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",",
                "\"previous_receipt_sha256\":\"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",",
                "\"run_id\":\"{}\",",
                "\"schema_version\":1,",
                "\"sequence\":5,",
                "\"source_sha256\":\"{}\"",
                "}}"
            ),
            RUN_ID, SOURCE_SHA,
        );
        assert!(validate_candidate_receipt(&receipt, 5, &plan()).is_ok());
        assert!(validate_candidate_receipt(&receipt, 6, &plan()).is_err());
        assert!(validate_candidate_receipt(
            &receipt.replace(RUN_ID, "run-ffffffffffffffffffffffffffffffff"),
            5,
            &plan()
        )
        .is_err());
    }

    #[test]
    fn empty_trusted_guest_evidence_projects_no_receipts_or_seal() {
        let empty = TrustedGuestProofEvidence::default();
        assert!(empty.is_empty());
        assert!(empty.network_isolation_receipt().is_none());
        assert!(empty.guest_seccomp_receipt().is_none());
        assert!(empty.guest_completion_ack_receipt().is_none());
        assert!(empty.seal().is_none());
    }
}
