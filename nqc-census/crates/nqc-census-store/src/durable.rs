//! Crash-safe publication primitives and the supported filesystem model.
//!
//! Supported model (validated where it can be, never merely assumed):
//!
//! * a local POSIX filesystem on Unix (ext4, xfs, btrfs; tmpfs gives the same
//!   atomicity without power-loss durability);
//! * `fsync(file)` persists file contents; `fsync(dir)` persists its entries;
//! * `link(2)` is atomic and refuses an existing target with `EEXIST`
//!   (probed at store creation);
//! * `rename(2)` atomically replaces a target in the same directory tree;
//! * every store directory is on one device (checked by `st_dev` on every open)
//!   and no store path is a symbolic link (checked before every read).
//!
//! Write-once objects are staged in `tmp/`, fsynced, hard-linked under their
//! final name and the directory fsynced. A partially written file therefore
//! never carries an authoritative name, and an existing name is never replaced:
//! a racing writer's link fails and the bytes are compared instead.

#[cfg(not(unix))]
compile_error!("nqc-census-store requires a POSIX (Unix) filesystem model");

use crate::error::StoreError;
use crate::fault::{FaultHook, FaultPoint};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static STAGING_COUNTER: AtomicU64 = AtomicU64::new(0);
const IMMUTABLE_MODE: u32 = 0o444;
const CACHE_MODE: u32 = 0o644;
const LINK_PROBE: &[u8] = b"NQC-CENSUS-STORE-LINK-PROBE-V1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Published {
    Created,
    AlreadyPresent,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct PublishPoints {
    pub(crate) staged: FaultPoint,
    pub(crate) linked: FaultPoint,
    pub(crate) durable: FaultPoint,
}

pub(crate) const OBJECT_POINTS: PublishPoints = PublishPoints {
    staged: FaultPoint::ObjectStaged,
    linked: FaultPoint::ObjectLinked,
    durable: FaultPoint::ObjectDurable,
};

pub(crate) const CHECKPOINT_POINTS: PublishPoints = PublishPoints {
    staged: FaultPoint::CheckpointStaged,
    linked: FaultPoint::CheckpointLinked,
    durable: FaultPoint::CheckpointDurable,
};

pub(crate) struct Disk<'a> {
    pub(crate) staging: &'a Path,
    pub(crate) device: u64,
    pub(crate) faults: Option<&'a FaultHook>,
}

impl Disk<'_> {
    pub(crate) fn fire(&self, point: FaultPoint) -> Result<(), StoreError> {
        match self.faults {
            Some(hook) if hook.fires(point) => Err(StoreError::InjectedFault(point)),
            _ => Ok(()),
        }
    }

    /// Publishes write-once bytes under `dir/name`. Returns `AlreadyPresent` only
    /// when the existing bytes are identical, after making them durable;
    /// different existing bytes are an `ObjectConflict` and are left untouched.
    pub(crate) fn publish_once(
        &self,
        dir: &Path,
        name: &str,
        bytes: &[u8],
        limit: u64,
        points: PublishPoints,
    ) -> Result<Published, StoreError> {
        let target = dir.join(name);
        if let Some(existing) = read_bounded(&target, limit, "published object")? {
            return settle_existing(&target, dir, &existing, bytes);
        }

        let staged = self.stage(bytes, IMMUTABLE_MODE)?;
        self.fire(points.staged)?;
        match fs::hard_link(&staged, &target) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                remove_staged(&staged)?;
                let existing =
                    read_bounded(&target, limit, "published object")?.ok_or_else(|| {
                        StoreError::io("link", &target, &std::io::Error::from(ErrorKind::NotFound))
                    })?;
                return settle_existing(&target, dir, &existing, bytes);
            }
            Err(error) => {
                remove_staged(&staged)?;
                return Err(StoreError::io("link", &target, &error));
            }
        }
        self.fire(points.linked)?;
        sync_dir(dir)?;
        self.fire(points.durable)?;
        remove_staged(&staged)?;
        Ok(Published::Created)
    }

    /// Atomically replaces a cache file. Used only for the HEAD cache.
    pub(crate) fn publish_replace(
        &self,
        dir: &Path,
        name: &str,
        bytes: &[u8],
    ) -> Result<(), StoreError> {
        let target = dir.join(name);
        let staged = self.stage(bytes, CACHE_MODE)?;
        self.fire(FaultPoint::HeadStaged)?;
        fs::rename(&staged, &target).map_err(|error| StoreError::io("rename", &target, &error))?;
        self.fire(FaultPoint::HeadRenamed)?;
        sync_dir(dir)
    }

    fn stage(&self, bytes: &[u8], mode: u32) -> Result<PathBuf, StoreError> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        for _ in 0..64 {
            let counter = STAGING_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = self
                .staging
                .join(format!("{}-{counter}-{nanos}.stage", std::process::id()));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(mode)
                .open(&path)
            {
                Ok(mut file) => {
                    file.write_all(bytes)
                        .map_err(|error| StoreError::io("write", &path, &error))?;
                    file.sync_all()
                        .map_err(|error| StoreError::io("fsync", &path, &error))?;
                    return Ok(path);
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(StoreError::io("create", &path, &error)),
            }
        }
        Err(StoreError::UnsupportedFilesystem(
            "could not allocate a unique staging name",
        ))
    }

    /// Creates `parent/name` as a directory if needed and checks it.
    pub(crate) fn ensure_dir(&self, parent: &Path, name: &str) -> Result<PathBuf, StoreError> {
        let path = parent.join(name);
        match fs::create_dir(&path) {
            Ok(()) => sync_dir(parent)?,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(StoreError::io("mkdir", &path, &error)),
        }
        require_dir(&path, self.device)?;
        Ok(path)
    }

    /// Proves at creation time that `link(2)` works and refuses existing targets.
    pub(crate) fn probe_hard_links(&self) -> Result<(), StoreError> {
        let source = self.stage(LINK_PROBE, IMMUTABLE_MODE)?;
        let mut alias = source.clone().into_os_string();
        alias.push(".probe");
        let alias = PathBuf::from(alias);
        let outcome = (|| {
            fs::hard_link(&source, &alias)
                .map_err(|_| StoreError::UnsupportedFilesystem("hard links are unavailable"))?;
            let links = fs::symlink_metadata(&source)
                .map_err(|error| StoreError::io("stat", &source, &error))?
                .nlink();
            if links != 2 {
                return Err(StoreError::UnsupportedFilesystem(
                    "hard link count is not reported",
                ));
            }
            match fs::hard_link(&source, &alias) {
                Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(()),
                _ => Err(StoreError::UnsupportedFilesystem(
                    "link does not refuse an existing target",
                )),
            }
        })();
        remove_if_present(&alias)?;
        remove_if_present(&source)?;
        outcome
    }
}

fn settle_existing(
    target: &Path,
    dir: &Path,
    existing: &[u8],
    bytes: &[u8],
) -> Result<Published, StoreError> {
    if existing != bytes {
        return Err(StoreError::ObjectConflict(target.to_path_buf()));
    }
    // The existing name may have been linked by a writer that died before its
    // directory fsync; make it durable before anything is built on top of it.
    sync_file(target)?;
    sync_dir(dir)?;
    Ok(Published::AlreadyPresent)
}

fn remove_staged(path: &Path) -> Result<(), StoreError> {
    fs::remove_file(path).map_err(|error| StoreError::io("unlink", path, &error))
}

pub(crate) fn remove_if_present(path: &Path) -> Result<(), StoreError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(StoreError::io("unlink", path, &error)),
    }
}

/// Reads a regular file of at most `limit` bytes. Symbolic links, directories
/// and other special files are rejected rather than followed.
pub(crate) fn read_bounded(
    path: &Path,
    limit: u64,
    object: &'static str,
) -> Result<Option<Vec<u8>>, StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(StoreError::io("stat", path, &error)),
    };
    if metadata.file_type().is_symlink() {
        return Err(StoreError::SymlinkRejected(path.to_path_buf()));
    }
    if !metadata.is_file() {
        return Err(StoreError::NotARegularFile(path.to_path_buf()));
    }
    if metadata.len() > limit {
        return Err(StoreError::ObjectTooLarge { object, limit });
    }
    let file = File::open(path).map_err(|error| StoreError::io("open", path, &error))?;
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| StoreError::io("read", path, &error))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(StoreError::ObjectTooLarge { object, limit });
    }
    Ok(Some(bytes))
}

/// The path must be a real directory (not a symlink) on `device`.
pub(crate) fn require_dir(path: &Path, device: u64) -> Result<(), StoreError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| StoreError::io("stat", path, &error))?;
    if metadata.file_type().is_symlink() {
        return Err(StoreError::SymlinkRejected(path.to_path_buf()));
    }
    if !metadata.is_dir() {
        return Err(StoreError::NotADirectory(path.to_path_buf()));
    }
    if metadata.dev() != device {
        return Err(StoreError::CrossDevice(path.to_path_buf()));
    }
    Ok(())
}

/// Device of a store root, which must be a real directory.
pub(crate) fn root_device(path: &Path) -> Result<u64, StoreError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| StoreError::io("stat", path, &error))?;
    if metadata.file_type().is_symlink() {
        return Err(StoreError::SymlinkRejected(path.to_path_buf()));
    }
    if !metadata.is_dir() {
        return Err(StoreError::NotADirectory(path.to_path_buf()));
    }
    Ok(metadata.dev())
}

pub(crate) fn sync_dir(path: &Path) -> Result<(), StoreError> {
    File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(|error| StoreError::io("fsync dir", path, &error))
}

pub(crate) fn sync_file(path: &Path) -> Result<(), StoreError> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| StoreError::io("fsync", path, &error))
}

/// Names of the entries of a directory, which must all be valid UTF-8.
pub(crate) fn entry_names(path: &Path) -> Result<Vec<String>, StoreError> {
    let reader = fs::read_dir(path).map_err(|error| StoreError::io("readdir", path, &error))?;
    let mut names = Vec::new();
    for entry in reader {
        let entry = entry.map_err(|error| StoreError::io("readdir", path, &error))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| StoreError::InvalidObjectName(entry.path()))?;
        names.push(name);
    }
    names.sort_unstable();
    Ok(names)
}
