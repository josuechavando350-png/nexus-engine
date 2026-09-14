use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io::{self, Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::str;

use walle_core::is_valid_sha256;
use walle_core::supervisor::MicroVmSupervisorPlan;

use crate::artifact::{open_regular_no_symlinks, ArtifactError, SystemSha256};
use crate::guest_protocol::GUEST_SECCOMP_POLICY_ID;

pub const GUEST_IMAGE_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const GUEST_AGENT_PATH: &str = "/usr/libexec/walle/walle-guest-agent";
pub const GUEST_PROTOCOL_VERSION: u32 = 1;
pub const MAX_GUEST_IMAGE_MANIFEST_BYTES: u64 = 4 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestImageManifestSource {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmittedGuestImageIdentity {
    pub manifest_sha256: String,
    pub kernel_sha256: String,
    pub rootfs_sha256: String,
    pub guest_agent_sha256: String,
    pub guest_agent_path: String,
    pub guest_protocol: u32,
    pub guest_seccomp_policy: String,
}

impl AdmittedGuestImageIdentity {
    pub fn canonical_json(&self) -> String {
        format!(
            concat!(
                "{{",
                "\"guest_agent_path\":\"{}\",",
                "\"guest_agent_sha256\":\"{}\",",
                "\"guest_protocol\":{},",
                "\"guest_seccomp_policy\":\"{}\",",
                "\"kernel_sha256\":\"{}\",",
                "\"manifest_sha256\":\"{}\",",
                "\"rootfs_sha256\":\"{}\",",
                "\"schema_version\":{}",
                "}}"
            ),
            self.guest_agent_path,
            self.guest_agent_sha256,
            self.guest_protocol,
            self.guest_seccomp_policy,
            self.kernel_sha256,
            self.manifest_sha256,
            self.rootfs_sha256,
            GUEST_IMAGE_MANIFEST_SCHEMA_VERSION,
        )
    }
}

#[derive(Debug)]
pub enum GuestImageError {
    InvalidExpectedManifestSha256,
    UnsafeManifestOwnership(PathBuf),
    ManifestTooLarge(u64),
    ManifestDigestMismatch {
        expected: String,
        actual: String,
    },
    MalformedManifest,
    NonCanonicalManifest,
    UnsupportedSchemaVersion,
    InvalidKernelSha256,
    InvalidRootfsSha256,
    InvalidGuestAgentSha256,
    GuestAgentPathMismatch,
    GuestProtocolMismatch,
    GuestSeccompPolicyMismatch,
    PlanImageMismatch,
    Artifact(ArtifactError),
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl Display for GuestImageError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidExpectedManifestSha256 => formatter
                .write_str("guest image manifest digest is not a canonical lowercase sha256"),
            Self::UnsafeManifestOwnership(path) => write!(
                formatter,
                "guest image manifest must be root-owned and not group/world writable: {}",
                path.display()
            ),
            Self::ManifestTooLarge(bytes) => write!(
                formatter,
                "guest image manifest exceeds {MAX_GUEST_IMAGE_MANIFEST_BYTES} bytes: {bytes}"
            ),
            Self::ManifestDigestMismatch { expected, actual } => write!(
                formatter,
                "guest image manifest digest mismatch: expected {expected}, got {actual}"
            ),
            Self::MalformedManifest => formatter.write_str("guest image manifest is malformed"),
            Self::NonCanonicalManifest => {
                formatter.write_str("guest image manifest bytes are not canonical")
            }
            Self::UnsupportedSchemaVersion => {
                formatter.write_str("guest image manifest schema version is unsupported")
            }
            Self::InvalidKernelSha256 => {
                formatter.write_str("guest image kernel identity is not a canonical sha256")
            }
            Self::InvalidRootfsSha256 => {
                formatter.write_str("guest image rootfs identity is not a canonical sha256")
            }
            Self::InvalidGuestAgentSha256 => {
                formatter.write_str("guest agent identity is not a canonical sha256")
            }
            Self::GuestAgentPathMismatch => {
                formatter.write_str("guest image manifest does not use the required agent path")
            }
            Self::GuestProtocolMismatch => formatter
                .write_str("guest image manifest does not use the required protocol version"),
            Self::GuestSeccompPolicyMismatch => {
                formatter.write_str("guest image manifest does not use the required seccomp policy")
            }
            Self::PlanImageMismatch => formatter.write_str(
                "supervisor kernel/rootfs identities do not match the admitted guest image",
            ),
            Self::Artifact(error) => Display::fmt(error, formatter),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for GuestImageError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Artifact(error) => Some(error),
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<ArtifactError> for GuestImageError {
    fn from(value: ArtifactError) -> Self {
        Self::Artifact(value)
    }
}

/// Loads a host-controlled guest image manifest through no-symlink resolution,
/// verifies the exact configured manifest digest, requires root-owned immutable
/// metadata, parses only one canonical byte representation, and binds the
/// manifest's kernel/rootfs identities to the exact supervisor plan.
///
/// This is an admission trust anchor, not proof that the manifest was produced
/// by a particular build pipeline. Until a later slice records build provenance
/// and the admitted identity in the durable run chain, guest serial claims stay
/// non-certifying.
pub fn load_and_bind_guest_image_manifest(
    source: &GuestImageManifestSource,
    sha256_program: impl Into<PathBuf>,
    plan: &MicroVmSupervisorPlan<'_>,
) -> Result<AdmittedGuestImageIdentity, GuestImageError> {
    if !is_valid_sha256(&source.sha256) {
        return Err(GuestImageError::InvalidExpectedManifestSha256);
    }
    let mut file = open_regular_no_symlinks(&source.path)?;
    let metadata = file
        .metadata()
        .map_err(|source_error| GuestImageError::Io {
            operation: "inspect guest image manifest",
            source: source_error,
        })?;
    if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(GuestImageError::UnsafeManifestOwnership(
            source.path.clone(),
        ));
    }
    if metadata.len() > MAX_GUEST_IMAGE_MANIFEST_BYTES {
        return Err(GuestImageError::ManifestTooLarge(metadata.len()));
    }

    let hasher = SystemSha256::new(sha256_program)?;
    let actual = hasher.hash_file(&file)?;
    if actual != source.sha256 {
        return Err(GuestImageError::ManifestDigestMismatch {
            expected: source.sha256.clone(),
            actual,
        });
    }

    file.seek(SeekFrom::Start(0))
        .map_err(|source_error| GuestImageError::Io {
            operation: "rewind guest image manifest",
            source: source_error,
        })?;
    let mut bytes = Vec::new();
    file.take(MAX_GUEST_IMAGE_MANIFEST_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|source_error| GuestImageError::Io {
            operation: "read guest image manifest",
            source: source_error,
        })?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_GUEST_IMAGE_MANIFEST_BYTES {
        return Err(GuestImageError::ManifestTooLarge(
            u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        ));
    }

    let identity = parse_manifest_bytes(&bytes, &source.sha256)?;
    bind_manifest_to_plan(&identity, plan)?;
    Ok(identity)
}

pub fn bind_manifest_to_plan(
    identity: &AdmittedGuestImageIdentity,
    plan: &MicroVmSupervisorPlan<'_>,
) -> Result<(), GuestImageError> {
    if identity.kernel_sha256 != plan.kernel_sha256
        || identity.rootfs_sha256 != plan.rootfs_sha256
        || !plan.rootfs_read_only
        || !plan.guest_seccomp_required
        || plan.network_interfaces != 0
    {
        return Err(GuestImageError::PlanImageMismatch);
    }
    Ok(())
}

fn parse_manifest_bytes(
    bytes: &[u8],
    manifest_sha256: &str,
) -> Result<AdmittedGuestImageIdentity, GuestImageError> {
    if bytes.is_empty()
        || u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_GUEST_IMAGE_MANIFEST_BYTES
        || !bytes.ends_with(b"\n")
    {
        return Err(GuestImageError::MalformedManifest);
    }
    let text = str::from_utf8(bytes).map_err(|_| GuestImageError::MalformedManifest)?;
    let lines: Vec<&str> = text.split_terminator('\n').collect();
    if lines.len() != 7 {
        return Err(GuestImageError::MalformedManifest);
    }

    let schema_version = field(lines[0], "schema_version=")?
        .parse::<u32>()
        .map_err(|_| GuestImageError::MalformedManifest)?;
    if schema_version != GUEST_IMAGE_MANIFEST_SCHEMA_VERSION {
        return Err(GuestImageError::UnsupportedSchemaVersion);
    }
    let kernel_sha256 = field(lines[1], "kernel_sha256=")?;
    if !is_valid_sha256(kernel_sha256) {
        return Err(GuestImageError::InvalidKernelSha256);
    }
    let rootfs_sha256 = field(lines[2], "rootfs_sha256=")?;
    if !is_valid_sha256(rootfs_sha256) {
        return Err(GuestImageError::InvalidRootfsSha256);
    }
    let guest_agent_sha256 = field(lines[3], "guest_agent_sha256=")?;
    if !is_valid_sha256(guest_agent_sha256) {
        return Err(GuestImageError::InvalidGuestAgentSha256);
    }
    let guest_agent_path = field(lines[4], "guest_agent_path=")?;
    if guest_agent_path != GUEST_AGENT_PATH {
        return Err(GuestImageError::GuestAgentPathMismatch);
    }
    let guest_protocol = field(lines[5], "guest_protocol=")?
        .parse::<u32>()
        .map_err(|_| GuestImageError::MalformedManifest)?;
    if guest_protocol != GUEST_PROTOCOL_VERSION {
        return Err(GuestImageError::GuestProtocolMismatch);
    }
    let guest_seccomp_policy = field(lines[6], "guest_seccomp_policy=")?;
    if guest_seccomp_policy != GUEST_SECCOMP_POLICY_ID {
        return Err(GuestImageError::GuestSeccompPolicyMismatch);
    }

    let identity = AdmittedGuestImageIdentity {
        manifest_sha256: manifest_sha256.to_owned(),
        kernel_sha256: kernel_sha256.to_owned(),
        rootfs_sha256: rootfs_sha256.to_owned(),
        guest_agent_sha256: guest_agent_sha256.to_owned(),
        guest_agent_path: guest_agent_path.to_owned(),
        guest_protocol,
        guest_seccomp_policy: guest_seccomp_policy.to_owned(),
    };
    if canonical_manifest(&identity).as_bytes() != bytes {
        return Err(GuestImageError::NonCanonicalManifest);
    }
    Ok(identity)
}

fn field<'a>(line: &'a str, prefix: &str) -> Result<&'a str, GuestImageError> {
    let value = line
        .strip_prefix(prefix)
        .ok_or(GuestImageError::MalformedManifest)?;
    if value.is_empty()
        || value.contains('=')
        || value.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return Err(GuestImageError::MalformedManifest);
    }
    Ok(value)
}

fn canonical_manifest(identity: &AdmittedGuestImageIdentity) -> String {
    format!(
        concat!(
            "schema_version={}\n",
            "kernel_sha256={}\n",
            "rootfs_sha256={}\n",
            "guest_agent_sha256={}\n",
            "guest_agent_path={}\n",
            "guest_protocol={}\n",
            "guest_seccomp_policy={}\n"
        ),
        GUEST_IMAGE_MANIFEST_SCHEMA_VERSION,
        identity.kernel_sha256,
        identity.rootfs_sha256,
        identity.guest_agent_sha256,
        identity.guest_agent_path,
        identity.guest_protocol,
        identity.guest_seccomp_policy,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use walle_core::supervisor::{CgroupV2Plan, MicroVmSupervisorPlan};

    const MANIFEST_SHA: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const KERNEL_SHA: &str =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const ROOTFS_SHA: &str =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const AGENT_SHA: &str =
        "sha256:3333333333333333333333333333333333333333333333333333333333333333";

    fn manifest() -> String {
        format!(
            concat!(
                "schema_version=1\n",
                "kernel_sha256={}\n",
                "rootfs_sha256={}\n",
                "guest_agent_sha256={}\n",
                "guest_agent_path={}\n",
                "guest_protocol=1\n",
                "guest_seccomp_policy={}\n"
            ),
            KERNEL_SHA,
            ROOTFS_SHA,
            AGENT_SHA,
            GUEST_AGENT_PATH,
            GUEST_SECCOMP_POLICY_ID,
        )
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
                "sha256:4444444444444444444444444444444444444444444444444444444444444444",
            jailer_exec: "/opt/walle/jailer",
            jailer_sha256:
                "sha256:5555555555555555555555555555555555555555555555555555555555555555",
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

    #[test]
    fn canonical_manifest_binds_exact_image_agent_protocol_and_policy() {
        let identity = parse_manifest_bytes(manifest().as_bytes(), MANIFEST_SHA).expect("manifest");
        bind_manifest_to_plan(&identity, &plan()).expect("plan binding");

        assert_eq!(identity.kernel_sha256, KERNEL_SHA);
        assert_eq!(identity.rootfs_sha256, ROOTFS_SHA);
        assert_eq!(identity.guest_agent_sha256, AGENT_SHA);
        assert_eq!(identity.guest_agent_path, GUEST_AGENT_PATH);
        assert_eq!(identity.guest_protocol, GUEST_PROTOCOL_VERSION);
        assert_eq!(identity.guest_seccomp_policy, GUEST_SECCOMP_POLICY_ID);
        assert!(identity
            .canonical_json()
            .contains("\"manifest_sha256\":\"sha256:aaaaaaaa"));
    }

    #[test]
    fn malformed_or_policy_drifted_manifest_fails_closed() {
        let wrong_policy = manifest().replace(GUEST_SECCOMP_POLICY_ID, "UNRELATED_POLICY");
        assert!(matches!(
            parse_manifest_bytes(wrong_policy.as_bytes(), MANIFEST_SHA),
            Err(GuestImageError::GuestSeccompPolicyMismatch)
        ));

        let wrong_path = manifest().replace(GUEST_AGENT_PATH, "/tmp/agent");
        assert!(matches!(
            parse_manifest_bytes(wrong_path.as_bytes(), MANIFEST_SHA),
            Err(GuestImageError::GuestAgentPathMismatch)
        ));

        let noncanonical = manifest().replace("schema_version=1\n", "schema_version=01\n");
        assert!(matches!(
            parse_manifest_bytes(noncanonical.as_bytes(), MANIFEST_SHA),
            Err(GuestImageError::NonCanonicalManifest)
        ));
    }

    #[test]
    fn mismatched_supervisor_image_cannot_reuse_trusted_manifest() {
        let identity = parse_manifest_bytes(manifest().as_bytes(), MANIFEST_SHA).expect("manifest");
        let mut mismatched = plan();
        mismatched.rootfs_sha256 =
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        assert!(matches!(
            bind_manifest_to_plan(&identity, &mismatched),
            Err(GuestImageError::PlanImageMismatch)
        ));
    }

    #[test]
    fn weaker_plan_controls_cannot_bind_to_trusted_manifest() {
        let identity = parse_manifest_bytes(manifest().as_bytes(), MANIFEST_SHA).expect("manifest");
        let mut networked = plan();
        networked.network_interfaces = 1;
        assert!(matches!(
            bind_manifest_to_plan(&identity, &networked),
            Err(GuestImageError::PlanImageMismatch)
        ));

        let mut writable = plan();
        writable.rootfs_read_only = false;
        assert!(matches!(
            bind_manifest_to_plan(&identity, &writable),
            Err(GuestImageError::PlanImageMismatch)
        ));
    }
}
