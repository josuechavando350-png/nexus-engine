use crate::fault::FaultPoint;
use nqc_census_core::{IdentityError, ObservationError};
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

/// Every failure the store or the offline verifier can report.
///
/// There is deliberately no "warning" or "degraded" variant: any condition the
/// store cannot prove safe is an error and the operation does not take effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    Io {
        operation: &'static str,
        path: PathBuf,
        kind: std::io::ErrorKind,
        message: String,
    },
    /// A canonical object failed strict decoding.
    Malformed {
        object: &'static str,
        reason: &'static str,
    },
    UnsupportedFormatVersion(u16),
    InvalidConfig(&'static str),
    /// The persisted store policy differs from the policy the caller requires.
    ConfigMismatch,
    /// A manifest was produced under a different persisted store policy.
    ForeignConfig,
    StoreNotInitialized(PathBuf),
    UnsupportedFilesystem(&'static str),
    CrossDevice(PathBuf),
    NotARegularFile(PathBuf),
    NotADirectory(PathBuf),
    SymlinkRejected(PathBuf),
    UnexpectedEntry(PathBuf),
    InvalidObjectName(PathBuf),
    ObjectTooLarge {
        object: &'static str,
        limit: u64,
    },
    ArtifactEmpty,
    ArtifactTooLarge {
        length: u64,
        limit: u64,
    },
    ArtifactMissing(String),
    ChunkMissing(String),
    /// Content does not match the digest that names or references it.
    DigestMismatch {
        object: &'static str,
    },
    /// Content is valid but is not the unique canonical encoding.
    NonCanonical {
        object: &'static str,
    },
    /// A write-once path already holds different bytes. Nothing was overwritten.
    ObjectConflict(PathBuf),
    Codec(&'static str),
    InvalidScope(&'static str),
    ScopeMismatch,
    InvalidCheckpoint(&'static str),
    /// The predecessor of the requested sequence is not durable.
    SequenceGap {
        requested: u64,
    },
    /// The same sequence is already committed with different bytes.
    SequenceConflict {
        sequence: u64,
    },
    PredecessorMismatch {
        sequence: u64,
    },
    Discontinuity {
        sequence: u64,
        reason: &'static str,
    },
    /// The stream directory exists but its checkpoint set is not a contiguous prefix.
    CatalogGap {
        missing: u64,
    },
    StreamNotRegistered(String),
    HeadCorrupt,
    HeadConflictsWithAuthority,
    HeadAheadOfAuthority {
        head_sequence: u64,
    },
    RangeInvalid,
    RangeBeforeOrigin {
        requested_first: u64,
        origin: u64,
    },
    RangeIncomplete {
        requested_last: u64,
        covered_last: Option<u64>,
    },
    TipMismatch,
    InjectedFault(FaultPoint),
    Identity(IdentityError),
    Observation(ObservationError),
}

impl StoreError {
    pub(crate) fn io(operation: &'static str, path: &Path, error: &std::io::Error) -> Self {
        Self::Io {
            operation,
            path: path.to_path_buf(),
            kind: error.kind(),
            message: error.to_string(),
        }
    }

    pub(crate) const fn malformed(object: &'static str, reason: &'static str) -> Self {
        Self::Malformed { object, reason }
    }

    /// Stable machine-readable code used by the offline verifier report.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Io { .. } => "IO",
            Self::Malformed { .. } => "MALFORMED",
            Self::UnsupportedFormatVersion(_) => "UNSUPPORTED_FORMAT_VERSION",
            Self::InvalidConfig(_) => "INVALID_CONFIG",
            Self::ConfigMismatch => "CONFIG_MISMATCH",
            Self::ForeignConfig => "FOREIGN_CONFIG",
            Self::StoreNotInitialized(_) => "STORE_NOT_INITIALIZED",
            Self::UnsupportedFilesystem(_) => "UNSUPPORTED_FILESYSTEM",
            Self::CrossDevice(_) => "CROSS_DEVICE",
            Self::NotARegularFile(_) => "NOT_A_REGULAR_FILE",
            Self::NotADirectory(_) => "NOT_A_DIRECTORY",
            Self::SymlinkRejected(_) => "SYMLINK_REJECTED",
            Self::UnexpectedEntry(_) => "UNEXPECTED_ENTRY",
            Self::InvalidObjectName(_) => "INVALID_OBJECT_NAME",
            Self::ObjectTooLarge { .. } => "OBJECT_TOO_LARGE",
            Self::ArtifactEmpty => "ARTIFACT_EMPTY",
            Self::ArtifactTooLarge { .. } => "ARTIFACT_TOO_LARGE",
            Self::ArtifactMissing(_) => "ARTIFACT_MISSING",
            Self::ChunkMissing(_) => "CHUNK_MISSING",
            Self::DigestMismatch { .. } => "DIGEST_MISMATCH",
            Self::NonCanonical { .. } => "NON_CANONICAL",
            Self::ObjectConflict(_) => "OBJECT_CONFLICT",
            Self::Codec(_) => "CODEC",
            Self::InvalidScope(_) => "INVALID_SCOPE",
            Self::ScopeMismatch => "SCOPE_MISMATCH",
            Self::InvalidCheckpoint(_) => "INVALID_CHECKPOINT",
            Self::SequenceGap { .. } => "SEQUENCE_GAP",
            Self::SequenceConflict { .. } => "SEQUENCE_CONFLICT",
            Self::PredecessorMismatch { .. } => "PREDECESSOR_MISMATCH",
            Self::Discontinuity { .. } => "DISCONTINUITY",
            Self::CatalogGap { .. } => "CATALOG_GAP",
            Self::StreamNotRegistered(_) => "STREAM_NOT_REGISTERED",
            Self::HeadCorrupt => "HEAD_CORRUPT",
            Self::HeadConflictsWithAuthority => "HEAD_CONFLICTS_WITH_AUTHORITY",
            Self::HeadAheadOfAuthority { .. } => "HEAD_AHEAD_OF_AUTHORITY",
            Self::RangeInvalid => "RANGE_INVALID",
            Self::RangeBeforeOrigin { .. } => "RANGE_BEFORE_ORIGIN",
            Self::RangeIncomplete { .. } => "RANGE_INCOMPLETE",
            Self::TipMismatch => "TIP_MISMATCH",
            Self::InjectedFault(_) => "INJECTED_FAULT",
            Self::Identity(_) => "IDENTITY",
            Self::Observation(_) => "OBSERVATION",
        }
    }
}

impl Display for StoreError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io {
                operation,
                path,
                kind,
                message,
            } => write!(
                f,
                "{operation} failed for {}: {kind:?}: {message}",
                path.display()
            ),
            Self::Malformed { object, reason } => write!(f, "malformed {object}: {reason}"),
            Self::UnsupportedFormatVersion(v) => write!(f, "unsupported store format version {v}"),
            Self::InvalidConfig(reason) => write!(f, "invalid store config: {reason}"),
            Self::ConfigMismatch => f.write_str("persisted store config differs from required"),
            Self::ForeignConfig => f.write_str("manifest bound to a different store config"),
            Self::StoreNotInitialized(p) => write!(f, "no store at {}", p.display()),
            Self::UnsupportedFilesystem(reason) => write!(f, "unsupported filesystem: {reason}"),
            Self::CrossDevice(p) => write!(f, "{} is on a different filesystem", p.display()),
            Self::NotARegularFile(p) => write!(f, "{} is not a regular file", p.display()),
            Self::NotADirectory(p) => write!(f, "{} is not a directory", p.display()),
            Self::SymlinkRejected(p) => write!(f, "{} is a symbolic link", p.display()),
            Self::UnexpectedEntry(p) => write!(f, "unexpected entry {}", p.display()),
            Self::InvalidObjectName(p) => write!(f, "non-canonical object name {}", p.display()),
            Self::ObjectTooLarge { object, limit } => {
                write!(f, "{object} exceeds bound of {limit} bytes")
            }
            Self::ArtifactEmpty => f.write_str("empty artifacts are not evidence"),
            Self::ArtifactTooLarge { length, limit } => {
                write!(f, "artifact of {length} bytes exceeds limit {limit}")
            }
            Self::ArtifactMissing(id) => write!(f, "artifact {id} is absent"),
            Self::ChunkMissing(id) => write!(f, "chunk {id} is absent"),
            Self::DigestMismatch { object } => write!(f, "{object} digest mismatch"),
            Self::NonCanonical { object } => write!(f, "{object} is not canonically encoded"),
            Self::ObjectConflict(p) => {
                write!(f, "{} already holds different bytes", p.display())
            }
            Self::Codec(reason) => write!(f, "codec rejected payload: {reason}"),
            Self::InvalidScope(reason) => write!(f, "invalid stream scope: {reason}"),
            Self::ScopeMismatch => f.write_str("object belongs to a different stream scope"),
            Self::InvalidCheckpoint(reason) => write!(f, "invalid checkpoint: {reason}"),
            Self::SequenceGap { requested } => {
                write!(f, "sequence {requested} has no durable predecessor")
            }
            Self::SequenceConflict { sequence } => {
                write!(f, "sequence {sequence} is committed with different content")
            }
            Self::PredecessorMismatch { sequence } => {
                write!(f, "sequence {sequence} names the wrong predecessor")
            }
            Self::Discontinuity { sequence, reason } => {
                write!(f, "sequence {sequence} is discontinuous: {reason}")
            }
            Self::CatalogGap { missing } => write!(f, "catalog is missing sequence {missing}"),
            Self::StreamNotRegistered(id) => write!(f, "stream {id} is not registered"),
            Self::HeadCorrupt => f.write_str("HEAD cache is corrupt"),
            Self::HeadConflictsWithAuthority => {
                f.write_str("HEAD cache contradicts the authoritative checkpoint catalog")
            }
            Self::HeadAheadOfAuthority { head_sequence } => write!(
                f,
                "HEAD cache names sequence {head_sequence}, which is not durable"
            ),
            Self::RangeInvalid => f.write_str("requested range is empty or inverted"),
            Self::RangeBeforeOrigin {
                requested_first,
                origin,
            } => write!(
                f,
                "requested block {requested_first} precedes stream origin {origin}"
            ),
            Self::RangeIncomplete {
                requested_last,
                covered_last,
            } => match covered_last {
                Some(covered) => write!(
                    f,
                    "range incomplete: requested through {requested_last}, durable through {covered}"
                ),
                None => write!(
                    f,
                    "range incomplete: requested through {requested_last}, nothing durable"
                ),
            },
            Self::TipMismatch => f.write_str("stream tip differs from the expected commitment"),
            Self::InjectedFault(point) => write!(f, "injected fault at {point:?}"),
            Self::Identity(error) => write!(f, "identity: {error}"),
            Self::Observation(error) => write!(f, "observation: {error}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<IdentityError> for StoreError {
    fn from(error: IdentityError) -> Self {
        Self::Identity(error)
    }
}

impl From<ObservationError> for StoreError {
    fn from(error: ObservationError) -> Self {
        Self::Observation(error)
    }
}
