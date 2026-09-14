use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::artifact::{ArtifactError, SystemSha256};
use crate::guest_image::{
    GUEST_AGENT_PATH, GUEST_IMAGE_MANIFEST_SCHEMA_VERSION, GUEST_PROTOCOL_VERSION,
};
use crate::guest_protocol::GUEST_SECCOMP_POLICY_ID;
use crate::safe_fs::{SecureDirectory, SecureFsError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltGuestImageManifest {
    kernel_sha256: String,
    rootfs_sha256: String,
    guest_agent_sha256: String,
    manifest_sha256: String,
    canonical_bytes: String,
}

impl BuiltGuestImageManifest {
    pub fn kernel_sha256(&self) -> &str {
        &self.kernel_sha256
    }

    pub fn rootfs_sha256(&self) -> &str {
        &self.rootfs_sha256
    }

    pub fn guest_agent_sha256(&self) -> &str {
        &self.guest_agent_sha256
    }

    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }
}

#[derive(Debug)]
pub enum GuestManifestBuildError {
    Artifact(ArtifactError),
    SecureFs(SecureFsError),
    InvalidOutputPath(PathBuf),
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl Display for GuestManifestBuildError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Artifact(error) => Display::fmt(error, formatter),
            Self::SecureFs(error) => Display::fmt(error, formatter),
            Self::InvalidOutputPath(path) => write!(
                formatter,
                "guest manifest output must be an absolute path with a UTF-8 file name and trusted parent: {}",
                path.display()
            ),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for GuestManifestBuildError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Artifact(error) => Some(error),
            Self::SecureFs(error) => Some(error),
            Self::Io { source, .. } => Some(source),
            Self::InvalidOutputPath(_) => None,
        }
    }
}

impl From<ArtifactError> for GuestManifestBuildError {
    fn from(value: ArtifactError) -> Self {
        Self::Artifact(value)
    }
}

impl From<SecureFsError> for GuestManifestBuildError {
    fn from(value: SecureFsError) -> Self {
        Self::SecureFs(value)
    }
}

/// Hashes the exact kernel, rootfs and guest-agent source artifacts through the
/// admitted system SHA-256 program and renders the only byte representation
/// accepted by WALLE's guest-image admission parser.
///
/// This builder deliberately does not claim that the supplied standalone agent
/// bytes are present inside the rootfs. The physical certification runtime still
/// re-opens the admitted rootfs with the pinned inspector and proves that exact
/// `/usr/libexec/walle/walle-guest-agent` byte identity before execution.
pub fn build_guest_image_manifest(
    sha256_program: impl Into<PathBuf>,
    kernel_path: &Path,
    rootfs_path: &Path,
    guest_agent_path: &Path,
) -> Result<BuiltGuestImageManifest, GuestManifestBuildError> {
    let hasher = SystemSha256::new(sha256_program)?;
    let kernel_sha256 = hasher.hash_path(kernel_path)?;
    let rootfs_sha256 = hasher.hash_path(rootfs_path)?;
    let guest_agent_sha256 = hasher.hash_path(guest_agent_path)?;
    let canonical_bytes =
        render_canonical_manifest(&kernel_sha256, &rootfs_sha256, &guest_agent_sha256);
    let manifest_sha256 = hasher.hash_bytes(canonical_bytes.as_bytes())?;

    Ok(BuiltGuestImageManifest {
        kernel_sha256,
        rootfs_sha256,
        guest_agent_sha256,
        manifest_sha256,
        canonical_bytes,
    })
}

/// Creates the manifest exactly once beneath a root-owned, non-group/world-
/// writable directory chain. Existing files are never replaced. The file is
/// written mode 0400, flushed and fsynced before success is returned.
pub fn write_guest_image_manifest(
    output_path: &Path,
    manifest: &BuiltGuestImageManifest,
) -> Result<(), GuestManifestBuildError> {
    if !output_path.is_absolute() {
        return Err(GuestManifestBuildError::InvalidOutputPath(
            output_path.to_path_buf(),
        ));
    }
    let parent = output_path
        .parent()
        .filter(|parent| parent.is_absolute())
        .ok_or_else(|| GuestManifestBuildError::InvalidOutputPath(output_path.to_path_buf()))?;
    let name = output_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| GuestManifestBuildError::InvalidOutputPath(output_path.to_path_buf()))?;

    let directory = SecureDirectory::open(parent.to_path_buf())?;
    directory.validate_trusted()?;
    let mut file = directory.create_new_file(name, 0o400)?;
    file.write_all(manifest.canonical_bytes.as_bytes())
        .map_err(|source| GuestManifestBuildError::Io {
            operation: "write guest image manifest",
            source,
        })?;
    file.flush()
        .and_then(|()| file.sync_all())
        .map_err(|source| GuestManifestBuildError::Io {
            operation: "sync guest image manifest",
            source,
        })?;
    Ok(())
}

fn render_canonical_manifest(
    kernel_sha256: &str,
    rootfs_sha256: &str,
    guest_agent_sha256: &str,
) -> String {
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
        kernel_sha256,
        rootfs_sha256,
        guest_agent_sha256,
        GUEST_AGENT_PATH,
        GUEST_PROTOCOL_VERSION,
        GUEST_SECCOMP_POLICY_ID,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const KERNEL_SHA: &str =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const ROOTFS_SHA: &str =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const AGENT_SHA: &str =
        "sha256:3333333333333333333333333333333333333333333333333333333333333333";

    #[test]
    fn canonical_builder_bytes_match_guest_admission_contract() {
        assert_eq!(
            render_canonical_manifest(KERNEL_SHA, ROOTFS_SHA, AGENT_SHA),
            concat!(
                "schema_version=1\n",
                "kernel_sha256=sha256:1111111111111111111111111111111111111111111111111111111111111111\n",
                "rootfs_sha256=sha256:2222222222222222222222222222222222222222222222222222222222222222\n",
                "guest_agent_sha256=sha256:3333333333333333333333333333333333333333333333333333333333333333\n",
                "guest_agent_path=/usr/libexec/walle/walle-guest-agent\n",
                "guest_protocol=1\n",
                "guest_seccomp_policy=WALLE_GUEST_SECCOMP_V1\n"
            )
        );
    }

    #[test]
    fn relative_output_path_is_rejected_before_filesystem_access() {
        let manifest = BuiltGuestImageManifest {
            kernel_sha256: KERNEL_SHA.to_owned(),
            rootfs_sha256: ROOTFS_SHA.to_owned(),
            guest_agent_sha256: AGENT_SHA.to_owned(),
            manifest_sha256:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            canonical_bytes: render_canonical_manifest(KERNEL_SHA, ROOTFS_SHA, AGENT_SHA),
        };
        assert!(matches!(
            write_guest_image_manifest(Path::new("guest-manifest.txt"), &manifest),
            Err(GuestManifestBuildError::InvalidOutputPath(_))
        ));
    }

    #[test]
    fn built_manifest_identity_fields_are_read_only_through_accessors() {
        let manifest = BuiltGuestImageManifest {
            kernel_sha256: KERNEL_SHA.to_owned(),
            rootfs_sha256: ROOTFS_SHA.to_owned(),
            guest_agent_sha256: AGENT_SHA.to_owned(),
            manifest_sha256:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            canonical_bytes: render_canonical_manifest(KERNEL_SHA, ROOTFS_SHA, AGENT_SHA),
        };
        assert_eq!(manifest.kernel_sha256(), KERNEL_SHA);
        assert_eq!(manifest.rootfs_sha256(), ROOTFS_SHA);
        assert_eq!(manifest.guest_agent_sha256(), AGENT_SHA);
        assert_eq!(
            manifest.manifest_sha256(),
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
    }
}
