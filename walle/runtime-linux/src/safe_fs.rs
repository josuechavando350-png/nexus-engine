use std::error::Error;
use std::ffi::{CString, OsStr};
use std::fmt::{Display, Formatter};
use std::fs::File;
use std::io;
use std::mem::size_of;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

const SYS_OPENAT2: i64 = 437;
const O_RDONLY: u64 = 0;
const O_RDWR: u64 = 0o2;
const O_CREAT: u64 = 0o100;
const O_EXCL: u64 = 0o200;
const O_NOFOLLOW: u64 = 0o400_000;
const O_DIRECTORY: u64 = 0o200_000;
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
    fn mkdirat(dirfd: i32, pathname: *const i8, mode: u32) -> i32;
    fn unlinkat(dirfd: i32, pathname: *const i8, flags: i32) -> i32;
}

#[derive(Debug)]
pub enum SecureFsError {
    UnsafeAbsolutePath(PathBuf),
    UnsafeChildName(String),
    InvalidMode(u32),
    NotDirectory(PathBuf),
    AlreadyExists(PathBuf),
    Openat2Failed {
        path: PathBuf,
        source: io::Error,
    },
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl Display for SecureFsError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsafeAbsolutePath(path) => {
                write!(
                    formatter,
                    "unsafe absolute directory path: {}",
                    path.display()
                )
            }
            Self::UnsafeChildName(name) => write!(formatter, "unsafe directory child name: {name}"),
            Self::InvalidMode(mode) => write!(formatter, "invalid filesystem mode: {mode:o}"),
            Self::NotDirectory(path) => {
                write!(formatter, "path is not a directory: {}", path.display())
            }
            Self::AlreadyExists(path) => {
                write!(formatter, "path already exists: {}", path.display())
            }
            Self::Openat2Failed { path, source } => {
                write!(formatter, "openat2 rejected {}: {source}", path.display())
            }
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for SecureFsError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Openat2Failed { source, .. } | Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub struct SecureDirectory {
    path: PathBuf,
    file: File,
}

impl SecureDirectory {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, SecureFsError> {
        let path = path.into();
        validate_absolute(&path)?;
        let file = open_absolute_directory(&path)?;
        Ok(Self { path, file })
    }

    pub fn create_leaf(path: impl Into<PathBuf>, mode: u32) -> Result<Self, SecureFsError> {
        validate_mode(mode)?;
        let path = path.into();
        validate_absolute(&path)?;
        if path == Path::new("/") {
            return Err(SecureFsError::UnsafeAbsolutePath(path));
        }
        let parent = path
            .parent()
            .ok_or_else(|| SecureFsError::UnsafeAbsolutePath(path.clone()))?;
        let name = path
            .file_name()
            .ok_or_else(|| SecureFsError::UnsafeAbsolutePath(path.clone()))?;
        let parent = Self::open(parent.to_path_buf())?;
        parent.create_child_directory_os(name, mode, false)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn as_raw_fd(&self) -> RawFd {
        self.file.as_raw_fd()
    }

    pub fn create_child_directory(
        &self,
        name: &str,
        mode: u32,
        allow_existing: bool,
    ) -> Result<Self, SecureFsError> {
        self.create_child_directory_os(OsStr::new(name), mode, allow_existing)
    }

    pub fn create_new_file(&self, name: &str, mode: u32) -> Result<File, SecureFsError> {
        self.create_new_file_with_cloexec(name, mode, true)
    }

    pub fn create_new_inheritable_file(
        &self,
        name: &str,
        mode: u32,
    ) -> Result<File, SecureFsError> {
        self.create_new_file_with_cloexec(name, mode, false)
    }

    pub fn remove_file(&self, name: &str) -> Result<(), SecureFsError> {
        validate_child_name(OsStr::new(name))?;
        let name_c = os_string_to_cstring(OsStr::new(name))?;
        let result = unsafe { unlinkat(self.file.as_raw_fd(), name_c.as_ptr(), 0) };
        if result != 0 {
            return Err(SecureFsError::Io {
                operation: "unlink secure runtime file",
                source: io::Error::last_os_error(),
            });
        }
        self.file.sync_all().map_err(|source| SecureFsError::Io {
            operation: "sync runtime directory after unlink",
            source,
        })
    }

    fn create_child_directory_os(
        &self,
        name: &OsStr,
        mode: u32,
        allow_existing: bool,
    ) -> Result<Self, SecureFsError> {
        validate_mode(mode)?;
        validate_child_name(name)?;
        let name_c = os_string_to_cstring(name)?;
        let child_path = self.path.join(name);
        let result = unsafe { mkdirat(self.file.as_raw_fd(), name_c.as_ptr(), mode) };
        if result != 0 {
            let source = io::Error::last_os_error();
            if source.raw_os_error() != Some(EEXIST) || !allow_existing {
                return if source.raw_os_error() == Some(EEXIST) {
                    Err(SecureFsError::AlreadyExists(child_path))
                } else {
                    Err(SecureFsError::Io {
                        operation: "mkdirat secure runtime directory",
                        source,
                    })
                };
            }
        } else {
            self.file.sync_all().map_err(|source| SecureFsError::Io {
                operation: "sync parent runtime directory",
                source,
            })?;
        }

        let file = open_relative(
            self.file.as_raw_fd(),
            name,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
            0,
            &child_path,
        )?;
        let metadata = file.metadata().map_err(|source| SecureFsError::Io {
            operation: "inspect secure runtime directory",
            source,
        })?;
        if !metadata.file_type().is_dir() {
            return Err(SecureFsError::NotDirectory(child_path));
        }
        Ok(Self {
            path: child_path,
            file,
        })
    }

    fn create_new_file_with_cloexec(
        &self,
        name: &str,
        mode: u32,
        cloexec: bool,
    ) -> Result<File, SecureFsError> {
        validate_mode(mode)?;
        validate_child_name(OsStr::new(name))?;
        let child_path = self.path.join(name);
        let mut flags = O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW;
        if cloexec {
            flags |= O_CLOEXEC;
        }
        match open_relative(
            self.file.as_raw_fd(),
            OsStr::new(name),
            flags,
            u64::from(mode),
            &child_path,
        ) {
            Err(SecureFsError::Openat2Failed { path, source })
                if source.raw_os_error() == Some(EEXIST) =>
            {
                Err(SecureFsError::AlreadyExists(path))
            }
            result => result,
        }
    }
}

fn open_absolute_directory(path: &Path) -> Result<File, SecureFsError> {
    if path == Path::new("/") {
        return File::open(path).map_err(|source| SecureFsError::Io {
            operation: "open host root directory",
            source,
        });
    }
    let root = File::open("/").map_err(|source| SecureFsError::Io {
        operation: "open host root directory",
        source,
    })?;
    let relative = path
        .strip_prefix("/")
        .map_err(|_| SecureFsError::UnsafeAbsolutePath(path.to_path_buf()))?;
    open_relative(
        root.as_raw_fd(),
        relative.as_os_str(),
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
        0,
        path,
    )
}

fn open_relative(
    dirfd: RawFd,
    relative: &OsStr,
    flags: u64,
    mode: u64,
    display_path: &Path,
) -> Result<File, SecureFsError> {
    let relative_c = os_string_to_cstring(relative)?;
    let how = OpenHow {
        flags,
        mode,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS,
    };
    let raw_fd = unsafe {
        syscall(
            SYS_OPENAT2,
            i64::from(dirfd),
            relative_c.as_ptr(),
            &how as *const OpenHow,
            size_of::<OpenHow>(),
        )
    };
    if raw_fd < 0 {
        return Err(SecureFsError::Openat2Failed {
            path: display_path.to_path_buf(),
            source: io::Error::last_os_error(),
        });
    }
    Ok(unsafe { File::from_raw_fd(raw_fd as i32) })
}

fn validate_absolute(path: &Path) -> Result<(), SecureFsError> {
    let bytes = path.as_os_str().as_bytes();
    if bytes.is_empty()
        || bytes.len() > 4096
        || bytes.contains(&0)
        || bytes.windows(2).any(|pair| pair == b"//")
        || (bytes.len() > 1 && bytes.ends_with(b"/"))
        || !path.is_absolute()
    {
        return Err(SecureFsError::UnsafeAbsolutePath(path.to_path_buf()));
    }
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::RootDir))
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(SecureFsError::UnsafeAbsolutePath(path.to_path_buf()));
    }
    Ok(())
}

fn validate_child_name(name: &OsStr) -> Result<(), SecureFsError> {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 255
        || bytes.contains(&0)
        || bytes.contains(&b'/')
        || bytes == b"."
        || bytes == b".."
    {
        return Err(SecureFsError::UnsafeChildName(
            name.to_string_lossy().into_owned(),
        ));
    }
    Ok(())
}

fn validate_mode(mode: u32) -> Result<(), SecureFsError> {
    if mode & !0o777 != 0 {
        return Err(SecureFsError::InvalidMode(mode));
    }
    Ok(())
}

fn os_string_to_cstring(value: &OsStr) -> Result<CString, SecureFsError> {
    CString::new(value.as_bytes())
        .map_err(|_| SecureFsError::UnsafeChildName(value.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    fn test_dir(label: &str) -> PathBuf {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "walle-secure-fs-{label}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test directory");
        path
    }

    #[test]
    fn leaf_directory_and_file_are_created_fd_relative() {
        let root = test_dir("create");
        let leaf = SecureDirectory::create_leaf(root.join("run-abc"), 0o700).expect("leaf");
        let file = leaf.create_new_file("evidence.log", 0o600).expect("file");
        assert!(file.metadata().expect("metadata").is_file());
        assert!(root.join("run-abc/evidence.log").is_file());
        drop(file);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn parent_symlink_is_rejected_by_openat2() {
        let root = test_dir("symlink");
        let real = root.join("real");
        fs::create_dir(&real).expect("real");
        let alias = root.join("alias");
        symlink(&real, &alias).expect("symlink");
        let error = SecureDirectory::create_leaf(alias.join("run-abc"), 0o700)
            .expect_err("symlink ancestor must fail");
        assert!(matches!(error, SecureFsError::Openat2Failed { .. }));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn existing_run_directory_is_not_reused() {
        let root = test_dir("existing");
        fs::create_dir(root.join("run-abc")).expect("existing");
        let error = SecureDirectory::create_leaf(root.join("run-abc"), 0o700)
            .expect_err("existing leaf must fail");
        assert!(matches!(error, SecureFsError::AlreadyExists(_)));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn child_names_cannot_escape_held_directory() {
        let root = test_dir("escape");
        let dir = SecureDirectory::open(&root).expect("open");
        assert!(matches!(
            dir.create_new_file("../escape", 0o600),
            Err(SecureFsError::UnsafeChildName(_))
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }
}
