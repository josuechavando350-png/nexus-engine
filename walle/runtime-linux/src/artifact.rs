use std::error::Error;
use std::ffi::CString;
use std::fmt::{Display, Formatter};
use std::fs::{self, File};
use std::io::{self, Seek, SeekFrom, Write};
use std::mem::size_of;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use walle_core::is_valid_sha256;

// Linux x86_64 UAPI constants. This crate intentionally supports only the host
// architecture admitted by WALLE's Firecracker preflight.
const SYS_OPENAT2: i64 = 437;
const O_RDWR: u64 = 0o2;
const O_CREAT: u64 = 0o100;
const O_EXCL: u64 = 0o200;
const O_NOFOLLOW: u64 = 0o400_000;
const O_CLOEXEC: u64 = 0o2_000_000;
const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;
const EEXIST: i32 = 17;

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

extern "C" {
    fn syscall(number: i64, ...) -> i64;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedArtifact {
    pub staged_path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug)]
pub enum ArtifactError {
    InvalidExpectedSha256,
    InvalidDestinationMode(u32),
    UnsafeAbsolutePath(PathBuf),
    HashProgramNotRegular(PathBuf),
    HashProgramUnsafeOwnership(PathBuf),
    SourceNotRegular(PathBuf),
    Openat2Failed {
        path: PathBuf,
        source: io::Error,
    },
    DestinationExists(PathBuf),
    Io {
        operation: &'static str,
        source: io::Error,
    },
    HashProgramFailed {
        code: Option<i32>,
    },
    MalformedHashOutput,
    DigestMismatch {
        expected: String,
        actual: String,
    },
}

impl Display for ArtifactError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidExpectedSha256 => {
                formatter.write_str("expected digest is not a canonical lowercase sha256")
            }
            Self::InvalidDestinationMode(mode) => {
                write!(formatter, "invalid staging file mode: {mode:o}")
            }
            Self::UnsafeAbsolutePath(path) => write!(
                formatter,
                "unsafe or non-normalized absolute path: {}",
                path.display()
            ),
            Self::HashProgramNotRegular(path) => write!(
                formatter,
                "sha256 program is not a regular file: {}",
                path.display()
            ),
            Self::HashProgramUnsafeOwnership(path) => write!(
                formatter,
                "sha256 program must be root-owned and not group/world writable: {}",
                path.display()
            ),
            Self::SourceNotRegular(path) => write!(
                formatter,
                "artifact source is not a regular file: {}",
                path.display()
            ),
            Self::Openat2Failed { path, source } => write!(
                formatter,
                "openat2 rejected artifact path {}: {source}",
                path.display()
            ),
            Self::DestinationExists(path) => write!(
                formatter,
                "staging destination already exists: {}",
                path.display()
            ),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::HashProgramFailed { code } => {
                write!(formatter, "sha256 program failed with exit code {code:?}")
            }
            Self::MalformedHashOutput => {
                formatter.write_str("sha256 program returned malformed output")
            }
            Self::DigestMismatch { expected, actual } => write!(
                formatter,
                "artifact digest mismatch: expected {expected}, got {actual}"
            ),
        }
    }
}

impl Error for ArtifactError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Openat2Failed { source, .. } | Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemSha256 {
    program: PathBuf,
}

impl SystemSha256 {
    pub fn new(program: impl Into<PathBuf>) -> Result<Self, ArtifactError> {
        let program = program.into();
        validate_normalized_absolute(&program)?;
        // Kernel-enforced no-symlink resolution is used for admission. We still
        // execute the system path later, so also require root ownership and no
        // group/world write bits. Root compromise is outside this runtime's
        // local artifact-race threat model.
        let admitted = open_regular_no_symlinks(&program)?;
        let metadata = admitted.metadata().map_err(|source| ArtifactError::Io {
            operation: "inspect sha256 program",
            source,
        })?;
        if !metadata.file_type().is_file() {
            return Err(ArtifactError::HashProgramNotRegular(program));
        }
        if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(ArtifactError::HashProgramUnsafeOwnership(program));
        }
        Ok(Self { program })
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn hash_file(&self, file: &File) -> Result<String, ArtifactError> {
        let mut input = file.try_clone().map_err(|source| ArtifactError::Io {
            operation: "clone artifact fd for hashing",
            source,
        })?;
        input
            .seek(SeekFrom::Start(0))
            .map_err(|source| ArtifactError::Io {
                operation: "rewind artifact fd for hashing",
                source,
            })?;
        let output = Command::new(&self.program)
            .arg("-")
            .env_clear()
            .stdin(Stdio::from(input))
            .output()
            .map_err(|source| ArtifactError::Io {
                operation: "execute sha256 program",
                source,
            })?;
        if !output.status.success() {
            return Err(ArtifactError::HashProgramFailed {
                code: output.status.code(),
            });
        }
        parse_sha256_stdout(&output.stdout)
    }

    pub fn hash_path(&self, path: &Path) -> Result<String, ArtifactError> {
        let file = open_regular_no_symlinks(path)?;
        self.hash_file(&file)
    }
}

/// Opens an absolute host artifact using Linux openat2 with RESOLVE_BENEATH,
/// RESOLVE_NO_MAGICLINKS and RESOLVE_NO_SYMLINKS. There is deliberately no
/// fallback to a weaker open when the kernel cannot enforce these constraints.
pub fn open_regular_no_symlinks(path: &Path) -> Result<File, ArtifactError> {
    let file = openat2_absolute(path, O_CLOEXEC | O_NOFOLLOW, 0)?;
    let metadata = file.metadata().map_err(|source| ArtifactError::Io {
        operation: "inspect opened artifact",
        source,
    })?;
    if !metadata.file_type().is_file() {
        return Err(ArtifactError::SourceNotRegular(path.to_path_buf()));
    }
    Ok(file)
}

/// Copies bytes from one immutable opened source fd into a fresh private
/// destination fd. The destination itself is created with openat2 + O_EXCL, so
/// neither source nor destination traversal can be redirected through symlinks.
/// SHA-256 is computed from the still-open staged fd, never by reopening the
/// staged path.
pub fn stage_verified_regular_file(
    source: &Path,
    destination: &Path,
    expected_sha256: &str,
    destination_mode: u32,
    hasher: &SystemSha256,
) -> Result<VerifiedArtifact, ArtifactError> {
    if !is_valid_sha256(expected_sha256) {
        return Err(ArtifactError::InvalidExpectedSha256);
    }
    if destination_mode & !0o777 != 0 {
        return Err(ArtifactError::InvalidDestinationMode(destination_mode));
    }

    let mut input = open_regular_no_symlinks(source)?;
    let mut output = match openat2_absolute(
        destination,
        O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
        u64::from(destination_mode),
    ) {
        Ok(file) => file,
        Err(ArtifactError::Openat2Failed { path, source })
            if source.raw_os_error() == Some(EEXIST) =>
        {
            return Err(ArtifactError::DestinationExists(path));
        }
        Err(error) => return Err(error),
    };

    let copied = match io::copy(&mut input, &mut output) {
        Ok(value) => value,
        Err(source) => {
            drop(output);
            let _ = fs::remove_file(destination);
            return Err(ArtifactError::Io {
                operation: "copy artifact into private staging",
                source,
            });
        }
    };
    if let Err(source) = output.flush().and_then(|()| output.sync_all()) {
        drop(output);
        let _ = fs::remove_file(destination);
        return Err(ArtifactError::Io {
            operation: "sync staged artifact",
            source,
        });
    }

    let actual_sha256 = match hasher.hash_file(&output) {
        Ok(value) => value,
        Err(error) => {
            drop(output);
            let _ = fs::remove_file(destination);
            return Err(error);
        }
    };
    drop(output);

    if actual_sha256 != expected_sha256 {
        let _ = fs::remove_file(destination);
        return Err(ArtifactError::DigestMismatch {
            expected: expected_sha256.to_owned(),
            actual: actual_sha256,
        });
    }

    Ok(VerifiedArtifact {
        staged_path: destination.to_path_buf(),
        sha256: actual_sha256,
        bytes: copied,
    })
}

fn openat2_absolute(path: &Path, flags: u64, mode: u64) -> Result<File, ArtifactError> {
    validate_normalized_absolute(path)?;
    let relative = path
        .strip_prefix("/")
        .map_err(|_| ArtifactError::UnsafeAbsolutePath(path.to_path_buf()))?;
    if relative.as_os_str().is_empty() {
        return Err(ArtifactError::UnsafeAbsolutePath(path.to_path_buf()));
    }
    let relative_c = CString::new(relative.as_os_str().as_bytes())
        .map_err(|_| ArtifactError::UnsafeAbsolutePath(path.to_path_buf()))?;
    let root = File::open("/").map_err(|source| ArtifactError::Io {
        operation: "open host root directory",
        source,
    })?;
    let how = OpenHow {
        flags,
        mode,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS,
    };
    // SAFETY: openat2 receives a valid root fd, a NUL-terminated relative path,
    // and a correctly sized OpenHow structure. A successful fd is uniquely
    // owned by the File created below.
    let raw_fd = unsafe {
        syscall(
            SYS_OPENAT2,
            i64::from(root.as_raw_fd()),
            relative_c.as_ptr(),
            &how as *const OpenHow,
            size_of::<OpenHow>(),
        )
    };
    if raw_fd < 0 {
        return Err(ArtifactError::Openat2Failed {
            path: path.to_path_buf(),
            source: io::Error::last_os_error(),
        });
    }
    // SAFETY: openat2 returned a new owned descriptor and this is its sole
    // conversion into a File.
    Ok(unsafe { File::from_raw_fd(raw_fd as i32) })
}

fn parse_sha256_stdout(stdout: &[u8]) -> Result<String, ArtifactError> {
    let stdout = std::str::from_utf8(stdout).map_err(|_| ArtifactError::MalformedHashOutput)?;
    let digest = stdout
        .split_ascii_whitespace()
        .next()
        .ok_or(ArtifactError::MalformedHashOutput)?;
    if digest.len() != 64
        || !digest
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(ArtifactError::MalformedHashOutput);
    }
    Ok(format!("sha256:{digest}"))
}

fn validate_normalized_absolute(path: &Path) -> Result<(), ArtifactError> {
    let bytes = path.as_os_str().as_bytes();
    if bytes.is_empty()
        || bytes.len() > 4096
        || bytes.contains(&0)
        || bytes.windows(2).any(|pair| pair == b"//")
        || (bytes.len() > 1 && bytes.ends_with(b"/"))
        || !path.is_absolute()
    {
        return Err(ArtifactError::UnsafeAbsolutePath(path.to_path_buf()));
    }
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::RootDir))
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ArtifactError::UnsafeAbsolutePath(path.to_path_buf()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicU64, Ordering};

    const TEST_SHA: &str =
        "sha256:a47d1dc72929cf5d67c7cbe424dfd8fbfd99b2db84b7ef8e0e9b57b62c66923b";
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    fn test_dir(label: &str) -> PathBuf {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("walle-runtime-{label}-{}-{id}", std::process::id()));
        fs::create_dir(&path).expect("create test directory");
        path
    }

    fn system_hasher() -> SystemSha256 {
        for path in ["/usr/bin/sha256sum", "/bin/sha256sum"] {
            if Path::new(path).is_file() {
                if let Ok(hasher) = SystemSha256::new(path) {
                    return hasher;
                }
            }
        }
        panic!("a root-owned, non-writable sha256sum is required by the Linux runtime test host");
    }

    #[test]
    fn exact_bytes_are_staged_and_bound_to_digest() {
        let root = test_dir("stage-ok");
        let source = root.join("source.img");
        let staging = root.join("staging");
        fs::create_dir(&staging).expect("staging dir");
        fs::write(&source, b"walle-runtime-test\n").expect("source bytes");
        let destination = staging.join("artifact.img");

        let verified =
            stage_verified_regular_file(&source, &destination, TEST_SHA, 0o400, &system_hasher())
                .expect("verified stage");
        assert_eq!(verified.sha256, TEST_SHA);
        assert_eq!(verified.bytes, 19);
        assert_eq!(
            fs::read(&destination).expect("staged bytes"),
            b"walle-runtime-test\n"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn final_symlink_source_is_rejected_by_kernel_resolution() {
        let root = test_dir("symlink-final");
        let real = root.join("real.img");
        let link = root.join("link.img");
        fs::write(&real, b"walle-runtime-test\n").expect("real bytes");
        symlink(&real, &link).expect("symlink");
        let error = open_regular_no_symlinks(&link).expect_err("symlink must fail");
        assert!(matches!(error, ArtifactError::Openat2Failed { .. }));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn parent_symlink_source_is_rejected_by_kernel_resolution() {
        let root = test_dir("symlink-parent");
        let real_dir = root.join("real");
        fs::create_dir(&real_dir).expect("real dir");
        fs::write(real_dir.join("artifact.img"), b"walle-runtime-test\n").expect("bytes");
        let alias = root.join("alias");
        symlink(&real_dir, &alias).expect("parent symlink");
        let error = open_regular_no_symlinks(&alias.join("artifact.img"))
            .expect_err("parent symlink must fail");
        assert!(matches!(error, ArtifactError::Openat2Failed { .. }));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn destination_parent_symlink_is_rejected_by_kernel_resolution() {
        let root = test_dir("destination-parent-symlink");
        let source = root.join("source.img");
        fs::write(&source, b"walle-runtime-test\n").expect("source bytes");
        let real_staging = root.join("real-staging");
        fs::create_dir(&real_staging).expect("real staging");
        let staging_alias = root.join("staging-alias");
        symlink(&real_staging, &staging_alias).expect("staging symlink");
        let destination = staging_alias.join("artifact.img");
        let error =
            stage_verified_regular_file(&source, &destination, TEST_SHA, 0o400, &system_hasher())
                .expect_err("destination ancestor symlink must fail");
        assert!(matches!(error, ArtifactError::Openat2Failed { .. }));
        assert!(!real_staging.join("artifact.img").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn digest_mismatch_deletes_untrusted_staged_copy() {
        let root = test_dir("mismatch");
        let source = root.join("source.img");
        let staging = root.join("staging");
        fs::create_dir(&staging).expect("staging dir");
        fs::write(&source, b"wrong bytes\n").expect("source bytes");
        let destination = staging.join("artifact.img");
        let error =
            stage_verified_regular_file(&source, &destination, TEST_SHA, 0o400, &system_hasher())
                .expect_err("digest mismatch must fail");
        assert!(matches!(error, ArtifactError::DigestMismatch { .. }));
        assert!(!destination.exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn staged_bytes_do_not_follow_later_source_changes() {
        let root = test_dir("source-moves");
        let source = root.join("source.img");
        let staging = root.join("staging");
        fs::create_dir(&staging).expect("staging dir");
        fs::write(&source, b"walle-runtime-test\n").expect("source bytes");
        let destination = staging.join("artifact.img");
        stage_verified_regular_file(&source, &destination, TEST_SHA, 0o400, &system_hasher())
            .expect("verified stage");
        fs::write(&source, b"changed after staging\n").expect("mutate source");
        assert_eq!(
            fs::read(&destination).expect("staged bytes"),
            b"walle-runtime-test\n"
        );
        assert_eq!(
            system_hasher().hash_path(&destination).expect("digest"),
            TEST_SHA
        );
        fs::remove_dir_all(root).expect("cleanup");
    }
}
