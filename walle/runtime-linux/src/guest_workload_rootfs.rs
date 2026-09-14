use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use walle_core::is_valid_sha256;
use walle_core::supervisor::MicroVmSupervisorPlan;

use crate::artifact::{open_regular_no_symlinks, ArtifactError, SystemSha256};
use crate::evidence::{
    verify_evidence_chain, EvidenceError, EvidenceReceipt, EvidenceRun, EvidenceSeal,
};
use crate::firecracker::GUEST_WORKLOAD_DIRECTORY;
use crate::guest_image::AdmittedGuestImageIdentity;
use crate::guest_rootfs::GuestRootfsInspectorSource;
use crate::safe_fs::{SecureDirectory, SecureFsError};

pub const GUEST_WORKLOAD_ROOTFS_EVIDENCE_DIRECTORY: &str = "guest-workload-rootfs-provenance";
pub const GUEST_WORKLOAD_ROOTFS_EVIDENCE_KIND: &str = "guest-workload-rootfs-provenance";
pub const MAX_GUEST_WORKLOAD_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DEBUGFS_STAT_BYTES: u64 = 16 * 1024;
const F_GETFD: i32 = 1;
const F_SETFD: i32 = 2;
const FD_CLOEXEC: i32 = 1;

extern "C" {
    fn fcntl(fd: i32, command: i32, ...) -> i32;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestWorkloadRootfsProvenance {
    debugfs_sha256: String,
    rootfs_sha256: String,
    run_id: String,
    source_sha256: String,
    workload_bytes: u64,
    workload_id: String,
    workload_path: String,
    workload_sha256: String,
}

impl GuestWorkloadRootfsProvenance {
    pub fn debugfs_sha256(&self) -> &str {
        &self.debugfs_sha256
    }

    pub fn rootfs_sha256(&self) -> &str {
        &self.rootfs_sha256
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn source_sha256(&self) -> &str {
        &self.source_sha256
    }

    pub fn workload_bytes(&self) -> u64 {
        self.workload_bytes
    }

    pub fn workload_id(&self) -> &str {
        &self.workload_id
    }

    pub fn workload_path(&self) -> &str {
        &self.workload_path
    }

    pub fn workload_sha256(&self) -> &str {
        &self.workload_sha256
    }

    pub fn canonical_json(&self) -> String {
        format!(
            concat!(
                "{{",
                "\"debugfs_sha256\":\"{}\",",
                "\"rootfs_sha256\":\"{}\",",
                "\"run_id\":\"{}\",",
                "\"source_sha256\":\"{}\",",
                "\"verification\":\"READ_ONLY_EXT4_WORKLOAD_BYTES_HASHED_FROM_EXACT_ROOTFS_FD\",",
                "\"workload_bytes\":{},",
                "\"workload_id\":\"{}\",",
                "\"workload_path\":\"{}\",",
                "\"workload_sha256\":\"{}\"",
                "}}"
            ),
            self.debugfs_sha256,
            self.rootfs_sha256,
            self.run_id,
            self.source_sha256,
            self.workload_bytes,
            self.workload_id,
            self.workload_path,
            self.workload_sha256,
        )
    }

    pub fn is_bound_to(
        &self,
        plan: &MicroVmSupervisorPlan<'_>,
        identity: &AdmittedGuestImageIdentity,
    ) -> bool {
        let Some(expected_path) = guest_workload_path(plan.workload_id) else {
            return false;
        };
        self.run_id == plan.run_id
            && self.source_sha256 == plan.source_sha256
            && self.rootfs_sha256 == plan.rootfs_sha256
            && self.rootfs_sha256 == identity.rootfs_sha256
            && self.workload_id == plan.workload_id
            && self.workload_path == expected_path
            && self.workload_bytes > 0
            && is_valid_sha256(&self.debugfs_sha256)
            && is_valid_sha256(&self.workload_sha256)
    }
}

#[derive(Debug)]
pub struct GuestWorkloadRootfsEvidence {
    run_directory: PathBuf,
    sha256_program: PathBuf,
    provenance: GuestWorkloadRootfsProvenance,
    receipt: EvidenceReceipt,
    seal: EvidenceSeal,
}

impl GuestWorkloadRootfsEvidence {
    pub fn provenance(&self) -> &GuestWorkloadRootfsProvenance {
        &self.provenance
    }

    pub fn receipt(&self) -> &EvidenceReceipt {
        &self.receipt
    }

    pub fn seal(&self) -> &EvidenceSeal {
        &self.seal
    }

    pub fn verify(&self) -> Result<(), GuestWorkloadRootfsError> {
        let hasher = SystemSha256::new(self.sha256_program.clone()).map_err(EvidenceError::from)?;
        verify_evidence_chain(
            &self.run_directory,
            std::slice::from_ref(&self.receipt),
            &self.seal,
            &hasher,
        )?;
        Ok(())
    }
}

#[derive(Debug)]
pub enum GuestWorkloadRootfsError {
    InvalidDebugfsSha256,
    UnsafeDebugfsProgram(PathBuf),
    DebugfsDigestMismatch {
        expected: String,
        actual: String,
    },
    GuestImageBindingMismatch,
    UnsafeWorkloadId(String),
    RootfsDigestMismatch {
        expected: String,
        actual: String,
    },
    DebugfsRequestFailed {
        request: &'static str,
        code: Option<i32>,
    },
    DebugfsOutputTooLarge {
        request: &'static str,
        limit: u64,
    },
    MalformedWorkloadStat,
    WorkloadNotRegular,
    WorkloadNotExecutable,
    WorkloadEmpty,
    ProvenanceBindingMismatch,
    Artifact(ArtifactError),
    Evidence(EvidenceError),
    SecureFs(SecureFsError),
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl Display for GuestWorkloadRootfsError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidDebugfsSha256 => {
                formatter.write_str("debugfs identity is not a canonical lowercase sha256")
            }
            Self::UnsafeDebugfsProgram(path) => write!(
                formatter,
                "debugfs program must be root-owned and not group/world writable: {}",
                path.display()
            ),
            Self::DebugfsDigestMismatch { expected, actual } => write!(
                formatter,
                "debugfs digest mismatch: expected {expected}, got {actual}"
            ),
            Self::GuestImageBindingMismatch => formatter.write_str(
                "workload rootfs provenance does not match the admitted guest image and supervisor plan",
            ),
            Self::UnsafeWorkloadId(value) => {
                write!(formatter, "unsafe guest workload id: {value}")
            }
            Self::RootfsDigestMismatch { expected, actual } => write!(
                formatter,
                "rootfs digest changed during guest-workload inspection: expected {expected}, got {actual}"
            ),
            Self::DebugfsRequestFailed { request, code } => {
                write!(formatter, "debugfs {request} request failed with exit code {code:?}")
            }
            Self::DebugfsOutputTooLarge { request, limit } => write!(
                formatter,
                "debugfs {request} output exceeded the declared limit of {limit} bytes"
            ),
            Self::MalformedWorkloadStat => {
                formatter.write_str("debugfs returned malformed guest-workload inode metadata")
            }
            Self::WorkloadNotRegular => {
                formatter.write_str("guest workload path inside rootfs is not a regular file")
            }
            Self::WorkloadNotExecutable => {
                formatter.write_str("guest workload path inside rootfs is not executable")
            }
            Self::WorkloadEmpty => formatter.write_str("guest workload inside rootfs is empty"),
            Self::ProvenanceBindingMismatch => formatter.write_str(
                "guest workload provenance is not exactly bound to the admitted rootfs, run and workload",
            ),
            Self::Artifact(error) => Display::fmt(error, formatter),
            Self::Evidence(error) => Display::fmt(error, formatter),
            Self::SecureFs(error) => Display::fmt(error, formatter),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for GuestWorkloadRootfsError {
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

impl From<ArtifactError> for GuestWorkloadRootfsError {
    fn from(value: ArtifactError) -> Self {
        Self::Artifact(value)
    }
}

impl From<EvidenceError> for GuestWorkloadRootfsError {
    fn from(value: EvidenceError) -> Self {
        Self::Evidence(value)
    }
}

impl From<SecureFsError> for GuestWorkloadRootfsError {
    fn from(value: SecureFsError) -> Self {
        Self::SecureFs(value)
    }
}

/// Proves the exact executable workload wrapper that the kernel boot arguments
/// select for this plan. The expected path is derived only from the validated
/// `workload_id`; the bytes are read from the exact manifest-admitted ext4 rootfs
/// through a pinned, root-owned, read-only debugfs binary. The rootfs is hashed
/// before and after inspection so the measurement cannot certify a different
/// image than the one Firecracker is later required to materialize.
pub fn verify_guest_workload_in_rootfs(
    inspector: &GuestRootfsInspectorSource,
    sha256_program: impl Into<PathBuf>,
    plan: &MicroVmSupervisorPlan<'_>,
    identity: &AdmittedGuestImageIdentity,
) -> Result<GuestWorkloadRootfsProvenance, GuestWorkloadRootfsError> {
    if !is_valid_sha256(&inspector.debugfs_sha256) {
        return Err(GuestWorkloadRootfsError::InvalidDebugfsSha256);
    }
    if identity.rootfs_sha256 != plan.rootfs_sha256 {
        return Err(GuestWorkloadRootfsError::GuestImageBindingMismatch);
    }
    let workload_path = guest_workload_path(plan.workload_id)
        .ok_or_else(|| GuestWorkloadRootfsError::UnsafeWorkloadId(plan.workload_id.to_owned()))?;

    let hasher = SystemSha256::new(sha256_program)?;
    let debugfs = open_regular_no_symlinks(&inspector.debugfs_program)?;
    let debugfs_metadata = debugfs
        .metadata()
        .map_err(|source| GuestWorkloadRootfsError::Io {
            operation: "inspect debugfs program",
            source,
        })?;
    if debugfs_metadata.uid() != 0 || debugfs_metadata.mode() & 0o022 != 0 {
        return Err(GuestWorkloadRootfsError::UnsafeDebugfsProgram(
            inspector.debugfs_program.clone(),
        ));
    }
    let debugfs_actual = hasher.hash_file(&debugfs)?;
    if debugfs_actual != inspector.debugfs_sha256 {
        return Err(GuestWorkloadRootfsError::DebugfsDigestMismatch {
            expected: inspector.debugfs_sha256.clone(),
            actual: debugfs_actual,
        });
    }

    let rootfs = open_regular_no_symlinks(Path::new(plan.rootfs_source))?;
    let rootfs_before = hasher.hash_file(&rootfs)?;
    if rootfs_before != plan.rootfs_sha256 {
        return Err(GuestWorkloadRootfsError::RootfsDigestMismatch {
            expected: plan.rootfs_sha256.to_owned(),
            actual: rootfs_before,
        });
    }

    let stat_request = format!("stat {workload_path}");
    let stat = run_debugfs_request(
        &inspector.debugfs_program,
        &rootfs,
        &stat_request,
        "stat guest workload",
        MAX_DEBUGFS_STAT_BYTES,
    )?;
    validate_workload_stat(&stat)?;

    let cat_request = format!("cat {workload_path}");
    let workload_bytes = run_debugfs_request(
        &inspector.debugfs_program,
        &rootfs,
        &cat_request,
        "read guest workload",
        MAX_GUEST_WORKLOAD_BYTES,
    )?;
    if workload_bytes.is_empty() {
        return Err(GuestWorkloadRootfsError::WorkloadEmpty);
    }
    let workload_sha256 = hasher.hash_bytes(&workload_bytes)?;

    let rootfs_after = hasher.hash_file(&rootfs)?;
    if rootfs_after != plan.rootfs_sha256 {
        return Err(GuestWorkloadRootfsError::RootfsDigestMismatch {
            expected: plan.rootfs_sha256.to_owned(),
            actual: rootfs_after,
        });
    }

    Ok(GuestWorkloadRootfsProvenance {
        debugfs_sha256: inspector.debugfs_sha256.clone(),
        rootfs_sha256: identity.rootfs_sha256.clone(),
        run_id: plan.run_id.to_owned(),
        source_sha256: plan.source_sha256.to_owned(),
        workload_bytes: u64::try_from(workload_bytes.len()).unwrap_or(u64::MAX),
        workload_id: plan.workload_id.to_owned(),
        workload_path,
        workload_sha256,
    })
}

/// Measures the exact rootfs workload and durably seals that measurement before
/// the microVM lifecycle starts. Any write, fsync or chain-verification failure
/// aborts the trusted execution path.
pub fn verify_and_persist_guest_workload_rootfs_provenance(
    evidence_root: &Path,
    sha256_program: impl Into<PathBuf>,
    inspector: &GuestRootfsInspectorSource,
    plan: &MicroVmSupervisorPlan<'_>,
    identity: &AdmittedGuestImageIdentity,
) -> Result<GuestWorkloadRootfsEvidence, GuestWorkloadRootfsError> {
    let sha256_program = sha256_program.into();
    let provenance =
        verify_guest_workload_in_rootfs(inspector, sha256_program.clone(), plan, identity)?;
    if !provenance.is_bound_to(plan, identity) {
        return Err(GuestWorkloadRootfsError::ProvenanceBindingMismatch);
    }

    let root = SecureDirectory::open(evidence_root.to_path_buf())?;
    root.validate_trusted()?;
    let provenance_root =
        root.create_child_directory(GUEST_WORKLOAD_ROOTFS_EVIDENCE_DIRECTORY, 0o700, true)?;
    provenance_root.validate_trusted()?;

    let mut run = EvidenceRun::begin(
        provenance_root.path().to_path_buf(),
        sha256_program.clone(),
        plan.run_id,
        plan.source_sha256,
    )?;
    let receipt = run.append(
        GUEST_WORKLOAD_ROOTFS_EVIDENCE_KIND,
        provenance.canonical_json().as_bytes(),
    )?;
    let seal = run.seal()?;
    let run_directory = run.path().to_path_buf();
    let hasher = SystemSha256::new(sha256_program.clone()).map_err(EvidenceError::from)?;
    verify_evidence_chain(
        &run_directory,
        std::slice::from_ref(&receipt),
        &seal,
        &hasher,
    )?;

    Ok(GuestWorkloadRootfsEvidence {
        run_directory,
        sha256_program,
        provenance,
        receipt,
        seal,
    })
}

fn guest_workload_path(workload_id: &str) -> Option<String> {
    if workload_id.is_empty() || workload_id.len() > 128 {
        return None;
    }
    let bytes = workload_id.as_bytes();
    if !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        || !bytes.iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(*byte, b'-' | b'_' | b'.')
        })
    {
        return None;
    }
    Some(format!("{GUEST_WORKLOAD_DIRECTORY}/{workload_id}"))
}

fn run_debugfs_request(
    program: &Path,
    rootfs: &File,
    request: &str,
    request_label: &'static str,
    output_limit: u64,
) -> Result<Vec<u8>, GuestWorkloadRootfsError> {
    let inherited = rootfs
        .try_clone()
        .map_err(|source| GuestWorkloadRootfsError::Io {
            operation: "clone rootfs fd for debugfs",
            source,
        })?;
    make_inheritable(&inherited)?;
    let device = format!("/proc/self/fd/{}", inherited.as_raw_fd());
    let mut child = Command::new(program)
        .args(["-R", request, device.as_str()])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|source| GuestWorkloadRootfsError::Io {
            operation: "spawn read-only debugfs",
            source,
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| GuestWorkloadRootfsError::Io {
            operation: "open debugfs stdout pipe",
            source: io::Error::new(io::ErrorKind::BrokenPipe, "debugfs stdout pipe missing"),
        })?;
    let mut bytes = Vec::new();
    if let Err(source) = stdout
        .take(output_limit.saturating_add(1))
        .read_to_end(&mut bytes)
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(GuestWorkloadRootfsError::Io {
            operation: "read bounded debugfs output",
            source,
        });
    }
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > output_limit {
        let _ = child.kill();
        let _ = child.wait();
        return Err(GuestWorkloadRootfsError::DebugfsOutputTooLarge {
            request: request_label,
            limit: output_limit,
        });
    }
    let status = child
        .wait()
        .map_err(|source| GuestWorkloadRootfsError::Io {
            operation: "wait for read-only debugfs",
            source,
        })?;
    ensure_debugfs_success(status, request_label)?;
    Ok(bytes)
}

fn make_inheritable(file: &File) -> Result<(), GuestWorkloadRootfsError> {
    let fd = file.as_raw_fd();
    // SAFETY: fcntl is called with a valid owned fd and integer-only commands.
    let flags = unsafe { fcntl(fd, F_GETFD) };
    if flags < 0 {
        return Err(GuestWorkloadRootfsError::Io {
            operation: "read rootfs fd flags",
            source: io::Error::last_os_error(),
        });
    }
    // SAFETY: only the private clone inherited by debugfs has CLOEXEC cleared.
    if unsafe { fcntl(fd, F_SETFD, flags & !FD_CLOEXEC) } != 0 {
        return Err(GuestWorkloadRootfsError::Io {
            operation: "make rootfs fd inheritable for debugfs",
            source: io::Error::last_os_error(),
        });
    }
    Ok(())
}

fn ensure_debugfs_success(
    status: ExitStatus,
    request: &'static str,
) -> Result<(), GuestWorkloadRootfsError> {
    if status.success() {
        Ok(())
    } else {
        Err(GuestWorkloadRootfsError::DebugfsRequestFailed {
            request,
            code: status.code(),
        })
    }
}

fn validate_workload_stat(bytes: &[u8]) -> Result<(), GuestWorkloadRootfsError> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| GuestWorkloadRootfsError::MalformedWorkloadStat)?;
    let mut inode_metadata = None;
    for line in text.lines() {
        let fields: Vec<&str> = line.split_ascii_whitespace().collect();
        if fields.first().copied() != Some("Inode:") {
            continue;
        }
        if inode_metadata.is_some() {
            return Err(GuestWorkloadRootfsError::MalformedWorkloadStat);
        }
        let type_index = fields
            .iter()
            .position(|field| *field == "Type:")
            .ok_or(GuestWorkloadRootfsError::MalformedWorkloadStat)?;
        let mode_index = fields
            .iter()
            .position(|field| *field == "Mode:")
            .ok_or(GuestWorkloadRootfsError::MalformedWorkloadStat)?;
        let file_type = *fields
            .get(type_index + 1)
            .ok_or(GuestWorkloadRootfsError::MalformedWorkloadStat)?;
        let mode_text = *fields
            .get(mode_index + 1)
            .ok_or(GuestWorkloadRootfsError::MalformedWorkloadStat)?;
        let normalized_mode = mode_text.trim_start_matches('0');
        let mode = u32::from_str_radix(
            if normalized_mode.is_empty() {
                "0"
            } else {
                normalized_mode
            },
            8,
        )
        .map_err(|_| GuestWorkloadRootfsError::MalformedWorkloadStat)?;
        inode_metadata = Some((file_type, mode));
    }
    let (file_type, mode) =
        inode_metadata.ok_or(GuestWorkloadRootfsError::MalformedWorkloadStat)?;
    if file_type != "regular" {
        return Err(GuestWorkloadRootfsError::WorkloadNotRegular);
    }
    if mode & 0o111 == 0 {
        return Err(GuestWorkloadRootfsError::WorkloadNotExecutable);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workload_path_is_derived_only_from_machine_safe_id() {
        assert_eq!(
            guest_workload_path("seo-avengers-2500").as_deref(),
            Some("/usr/libexec/walle/workloads/seo-avengers-2500")
        );
        assert!(guest_workload_path("../escape").is_none());
        assert!(guest_workload_path("UPPERCASE").is_none());
        assert!(guest_workload_path("").is_none());
    }

    #[test]
    fn workload_stat_requires_one_regular_executable_inode() {
        let valid = b"Inode: 42 Type: regular Mode: 0755 Flags: 0x80000\nSize: 1234\n";
        assert!(validate_workload_stat(valid).is_ok());

        let symlink = b"Inode: 42 Type: symlink Mode: 0777 Flags: 0x0\n";
        assert!(matches!(
            validate_workload_stat(symlink),
            Err(GuestWorkloadRootfsError::WorkloadNotRegular)
        ));

        let non_executable = b"Inode: 42 Type: regular Mode: 0644 Flags: 0x0\n";
        assert!(matches!(
            validate_workload_stat(non_executable),
            Err(GuestWorkloadRootfsError::WorkloadNotExecutable)
        ));
    }

    #[test]
    fn workload_stat_rejects_missing_or_duplicate_inode_metadata() {
        assert!(matches!(
            validate_workload_stat(b"Size: 1\n"),
            Err(GuestWorkloadRootfsError::MalformedWorkloadStat)
        ));
        assert!(matches!(
            validate_workload_stat(
                b"Inode: 1 Type: regular Mode: 0755\nInode: 2 Type: regular Mode: 0755\n"
            ),
            Err(GuestWorkloadRootfsError::MalformedWorkloadStat)
        ));
    }

    #[test]
    fn canonical_provenance_names_exact_rootfs_workload_identity() {
        let provenance = GuestWorkloadRootfsProvenance {
            debugfs_sha256:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            rootfs_sha256:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
            run_id: "run-0123456789abcdef0123456789abcdef".to_owned(),
            source_sha256:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_owned(),
            workload_bytes: 4096,
            workload_id: "seo-avengers-2500".to_owned(),
            workload_path: "/usr/libexec/walle/workloads/seo-avengers-2500".to_owned(),
            workload_sha256:
                "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_owned(),
        };
        let json = provenance.canonical_json();
        assert!(json.contains("READ_ONLY_EXT4_WORKLOAD_BYTES_HASHED_FROM_EXACT_ROOTFS_FD"));
        assert!(json.contains("\"workload_id\":\"seo-avengers-2500\""));
        assert!(json.contains("\"workload_bytes\":4096"));
        assert!(!json.contains('\n'));
    }
}
