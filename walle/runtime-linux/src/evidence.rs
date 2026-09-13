use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use walle_core::is_valid_sha256;

use crate::artifact::{open_regular_no_symlinks, ArtifactError, SystemSha256};
use crate::safe_fs::{SecureDirectory, SecureFsError};

pub const EVIDENCE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceReceipt {
    pub sequence: u64,
    pub kind: String,
    pub payload_file: String,
    pub payload_sha256: String,
    pub payload_bytes: u64,
    pub previous_receipt_sha256: Option<String>,
    pub receipt_file: String,
    pub receipt_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceSeal {
    pub run_id: String,
    pub source_sha256: String,
    pub entry_count: u64,
    pub head_receipt_sha256: String,
    pub seal_file: String,
    pub seal_sha256: String,
}

#[derive(Debug)]
pub enum EvidenceError {
    InvalidRunId,
    InvalidSourceSha256,
    InvalidKind,
    PayloadTooLarge,
    EmptyEvidenceSet,
    Sealed,
    Poisoned,
    ChainMismatch,
    CanonicalContentMismatch(PathBuf),
    PayloadLengthMismatch {
        path: PathBuf,
        expected: u64,
        actual: u64,
    },
    TamperDetected {
        path: PathBuf,
        expected: String,
        actual: String,
    },
    Artifact(ArtifactError),
    SecureFs(SecureFsError),
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl Display for EvidenceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRunId => formatter.write_str("evidence run id is invalid"),
            Self::InvalidSourceSha256 => {
                formatter.write_str("evidence source digest is not a canonical lowercase sha256")
            }
            Self::InvalidKind => formatter.write_str("evidence kind is not machine-safe"),
            Self::PayloadTooLarge => formatter.write_str("evidence payload length overflowed u64"),
            Self::EmptyEvidenceSet => formatter.write_str("cannot seal an empty evidence run"),
            Self::Sealed => formatter.write_str("evidence run is already sealed"),
            Self::Poisoned => formatter.write_str(
                "evidence run has a partial durable write and is fail-closed until operator recovery",
            ),
            Self::ChainMismatch => formatter.write_str("evidence receipt hash chain is inconsistent"),
            Self::CanonicalContentMismatch(path) => write!(
                formatter,
                "evidence canonical bytes do not match metadata: {}",
                path.display()
            ),
            Self::PayloadLengthMismatch {
                path,
                expected,
                actual,
            } => write!(
                formatter,
                "evidence payload length mismatch for {}: expected {expected}, got {actual}",
                path.display()
            ),
            Self::TamperDetected {
                path,
                expected,
                actual,
            } => write!(
                formatter,
                "evidence tamper detected for {}: expected {expected}, got {actual}",
                path.display()
            ),
            Self::Artifact(error) => Display::fmt(error, formatter),
            Self::SecureFs(error) => Display::fmt(error, formatter),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for EvidenceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Artifact(error) => Some(error),
            Self::SecureFs(error) => Some(error),
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<ArtifactError> for EvidenceError {
    fn from(value: ArtifactError) -> Self {
        Self::Artifact(value)
    }
}

impl From<SecureFsError> for EvidenceError {
    fn from(value: SecureFsError) -> Self {
        Self::SecureFs(value)
    }
}

#[derive(Debug)]
pub struct EvidenceRun {
    run_id: String,
    source_sha256: String,
    directory: SecureDirectory,
    hasher: SystemSha256,
    next_sequence: u64,
    head_receipt_sha256: Option<String>,
    sealed: bool,
    poisoned: bool,
}

impl EvidenceRun {
    pub fn begin(
        evidence_root: impl Into<PathBuf>,
        sha256_program: impl Into<PathBuf>,
        run_id: &str,
        source_sha256: &str,
    ) -> Result<Self, EvidenceError> {
        Self::begin_inner(
            evidence_root.into(),
            sha256_program.into(),
            run_id,
            source_sha256,
            true,
        )
    }

    fn begin_inner(
        evidence_root: PathBuf,
        sha256_program: PathBuf,
        run_id: &str,
        source_sha256: &str,
        require_trusted_root: bool,
    ) -> Result<Self, EvidenceError> {
        validate_run_id(run_id)?;
        if !is_valid_sha256(source_sha256) {
            return Err(EvidenceError::InvalidSourceSha256);
        }
        let root = SecureDirectory::open(evidence_root)?;
        if require_trusted_root {
            root.validate_trusted()?;
        }
        let directory = root.create_child_directory(run_id, 0o700, false)?;
        if require_trusted_root {
            directory.validate_trusted()?;
        }
        Ok(Self {
            run_id: run_id.to_owned(),
            source_sha256: source_sha256.to_owned(),
            directory,
            hasher: SystemSha256::new(sha256_program)?,
            next_sequence: 1,
            head_receipt_sha256: None,
            sealed: false,
            poisoned: false,
        })
    }

    pub fn path(&self) -> &Path {
        self.directory.path()
    }

    pub fn append(&mut self, kind: &str, payload: &[u8]) -> Result<EvidenceReceipt, EvidenceError> {
        if self.sealed {
            return Err(EvidenceError::Sealed);
        }
        if self.poisoned {
            return Err(EvidenceError::Poisoned);
        }
        validate_kind(kind)?;
        let payload_bytes =
            u64::try_from(payload.len()).map_err(|_| EvidenceError::PayloadTooLarge)?;
        let sequence = self.next_sequence;
        let payload_file = format!("{sequence:06}.payload");
        let receipt_file = format!("{sequence:06}.receipt.json");

        let payload_sha256 =
            match write_and_hash(&self.directory, &payload_file, payload, 0o400, &self.hasher) {
                Ok(value) => value,
                Err(error) => {
                    self.poisoned = true;
                    return Err(error);
                }
            };

        let receipt_json = canonical_receipt_json(CanonicalReceipt {
            run_id: &self.run_id,
            source_sha256: &self.source_sha256,
            sequence,
            kind,
            payload_file: &payload_file,
            payload_sha256: &payload_sha256,
            payload_bytes,
            previous_receipt_sha256: self.head_receipt_sha256.as_deref(),
        });
        let receipt_sha256 = match write_and_hash(
            &self.directory,
            &receipt_file,
            receipt_json.as_bytes(),
            0o400,
            &self.hasher,
        ) {
            Ok(value) => value,
            Err(error) => {
                self.poisoned = true;
                return Err(error);
            }
        };

        let receipt = EvidenceReceipt {
            sequence,
            kind: kind.to_owned(),
            payload_file,
            payload_sha256,
            payload_bytes,
            previous_receipt_sha256: self.head_receipt_sha256.clone(),
            receipt_file,
            receipt_sha256: receipt_sha256.clone(),
        };
        self.head_receipt_sha256 = Some(receipt_sha256);
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(EvidenceError::PayloadTooLarge)?;
        Ok(receipt)
    }

    pub fn seal(&mut self) -> Result<EvidenceSeal, EvidenceError> {
        if self.sealed {
            return Err(EvidenceError::Sealed);
        }
        if self.poisoned {
            return Err(EvidenceError::Poisoned);
        }
        let head = self
            .head_receipt_sha256
            .as_deref()
            .ok_or(EvidenceError::EmptyEvidenceSet)?;
        let entry_count = self.next_sequence - 1;
        let seal_file = "seal.json".to_owned();
        let seal_json = canonical_seal_json(&self.run_id, &self.source_sha256, entry_count, head);
        let seal_sha256 = match write_and_hash(
            &self.directory,
            &seal_file,
            seal_json.as_bytes(),
            0o400,
            &self.hasher,
        ) {
            Ok(value) => value,
            Err(error) => {
                self.poisoned = true;
                return Err(error);
            }
        };
        self.sealed = true;
        Ok(EvidenceSeal {
            run_id: self.run_id.clone(),
            source_sha256: self.source_sha256.clone(),
            entry_count,
            head_receipt_sha256: head.to_owned(),
            seal_file,
            seal_sha256,
        })
    }

    #[cfg(test)]
    fn begin_untrusted_for_test(
        evidence_root: impl Into<PathBuf>,
        sha256_program: impl Into<PathBuf>,
        run_id: &str,
        source_sha256: &str,
    ) -> Result<Self, EvidenceError> {
        Self::begin_inner(
            evidence_root.into(),
            sha256_program.into(),
            run_id,
            source_sha256,
            false,
        )
    }
}

pub fn verify_evidence_chain(
    run_directory: &Path,
    receipts: &[EvidenceReceipt],
    seal: &EvidenceSeal,
    hasher: &SystemSha256,
) -> Result<(), EvidenceError> {
    validate_run_id(&seal.run_id)?;
    if !is_valid_sha256(&seal.source_sha256) {
        return Err(EvidenceError::InvalidSourceSha256);
    }
    if receipts.is_empty()
        || seal.entry_count != receipts.len() as u64
        || seal.seal_file != "seal.json"
        || !is_valid_sha256(&seal.head_receipt_sha256)
        || !is_valid_sha256(&seal.seal_sha256)
    {
        return Err(EvidenceError::ChainMismatch);
    }

    let mut previous: Option<&str> = None;
    for (index, receipt) in receipts.iter().enumerate() {
        let expected_sequence =
            u64::try_from(index + 1).map_err(|_| EvidenceError::ChainMismatch)?;
        let expected_payload_file = format!("{expected_sequence:06}.payload");
        let expected_receipt_file = format!("{expected_sequence:06}.receipt.json");
        validate_kind(&receipt.kind)?;
        if receipt.sequence != expected_sequence
            || receipt.payload_file != expected_payload_file
            || receipt.receipt_file != expected_receipt_file
            || receipt.previous_receipt_sha256.as_deref() != previous
            || !is_valid_sha256(&receipt.payload_sha256)
            || !is_valid_sha256(&receipt.receipt_sha256)
        {
            return Err(EvidenceError::ChainMismatch);
        }

        verify_payload_file(
            &run_directory.join(&receipt.payload_file),
            &receipt.payload_sha256,
            receipt.payload_bytes,
            hasher,
        )?;
        let expected_receipt = canonical_receipt_json(CanonicalReceipt {
            run_id: &seal.run_id,
            source_sha256: &seal.source_sha256,
            sequence: receipt.sequence,
            kind: &receipt.kind,
            payload_file: &receipt.payload_file,
            payload_sha256: &receipt.payload_sha256,
            payload_bytes: receipt.payload_bytes,
            previous_receipt_sha256: receipt.previous_receipt_sha256.as_deref(),
        });
        verify_canonical_file(
            &run_directory.join(&receipt.receipt_file),
            expected_receipt.as_bytes(),
            &receipt.receipt_sha256,
            hasher,
        )?;
        previous = Some(&receipt.receipt_sha256);
    }

    if previous != Some(seal.head_receipt_sha256.as_str()) {
        return Err(EvidenceError::ChainMismatch);
    }
    let expected_seal = canonical_seal_json(
        &seal.run_id,
        &seal.source_sha256,
        seal.entry_count,
        &seal.head_receipt_sha256,
    );
    verify_canonical_file(
        &run_directory.join(&seal.seal_file),
        expected_seal.as_bytes(),
        &seal.seal_sha256,
        hasher,
    )?;
    Ok(())
}

fn write_and_hash(
    directory: &SecureDirectory,
    name: &str,
    bytes: &[u8],
    mode: u32,
    hasher: &SystemSha256,
) -> Result<String, EvidenceError> {
    let mut file = directory.create_new_file(name, mode)?;
    file.write_all(bytes).map_err(|source| EvidenceError::Io {
        operation: "write evidence file",
        source,
    })?;
    file.flush().map_err(|source| EvidenceError::Io {
        operation: "flush evidence file",
        source,
    })?;
    file.sync_all().map_err(|source| EvidenceError::Io {
        operation: "sync evidence file",
        source,
    })?;
    hasher.hash_file(&file).map_err(EvidenceError::from)
}

fn verify_payload_file(
    path: &Path,
    expected_sha256: &str,
    expected_bytes: u64,
    hasher: &SystemSha256,
) -> Result<(), EvidenceError> {
    let file = open_regular_no_symlinks(path)?;
    let actual_bytes = file
        .metadata()
        .map_err(|source| EvidenceError::Io {
            operation: "inspect evidence payload",
            source,
        })?
        .len();
    if actual_bytes != expected_bytes {
        return Err(EvidenceError::PayloadLengthMismatch {
            path: path.to_path_buf(),
            expected: expected_bytes,
            actual: actual_bytes,
        });
    }
    verify_open_file_hash(path, file, expected_sha256, hasher)
}

fn verify_canonical_file(
    path: &Path,
    expected_bytes: &[u8],
    expected_sha256: &str,
    hasher: &SystemSha256,
) -> Result<(), EvidenceError> {
    let mut file = open_regular_no_symlinks(path)?;
    let actual_sha256 = hasher.hash_file(&file)?;
    if actual_sha256 != expected_sha256 {
        return Err(EvidenceError::TamperDetected {
            path: path.to_path_buf(),
            expected: expected_sha256.to_owned(),
            actual: actual_sha256,
        });
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|source| EvidenceError::Io {
            operation: "rewind canonical evidence file",
            source,
        })?;
    let mut actual_bytes = Vec::new();
    file.read_to_end(&mut actual_bytes)
        .map_err(|source| EvidenceError::Io {
            operation: "read canonical evidence file",
            source,
        })?;
    if actual_bytes != expected_bytes {
        return Err(EvidenceError::CanonicalContentMismatch(path.to_path_buf()));
    }
    Ok(())
}

fn verify_open_file_hash(
    path: &Path,
    file: std::fs::File,
    expected_sha256: &str,
    hasher: &SystemSha256,
) -> Result<(), EvidenceError> {
    let actual = hasher.hash_file(&file)?;
    if actual != expected_sha256 {
        return Err(EvidenceError::TamperDetected {
            path: path.to_path_buf(),
            expected: expected_sha256.to_owned(),
            actual,
        });
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct CanonicalReceipt<'a> {
    run_id: &'a str,
    source_sha256: &'a str,
    sequence: u64,
    kind: &'a str,
    payload_file: &'a str,
    payload_sha256: &'a str,
    payload_bytes: u64,
    previous_receipt_sha256: Option<&'a str>,
}

fn canonical_receipt_json(receipt: CanonicalReceipt<'_>) -> String {
    let previous = receipt.previous_receipt_sha256.map_or_else(
        || "null".to_owned(),
        |value| format!("\"{}\"", escape_json(value)),
    );
    format!(
        concat!(
            "{{",
            "\"kind\":\"{}\",",
            "\"payload_bytes\":{},",
            "\"payload_file\":\"{}\",",
            "\"payload_sha256\":\"{}\",",
            "\"previous_receipt_sha256\":{},",
            "\"run_id\":\"{}\",",
            "\"schema_version\":{},",
            "\"sequence\":{},",
            "\"source_sha256\":\"{}\"",
            "}}"
        ),
        escape_json(receipt.kind),
        receipt.payload_bytes,
        escape_json(receipt.payload_file),
        escape_json(receipt.payload_sha256),
        previous,
        escape_json(receipt.run_id),
        EVIDENCE_SCHEMA_VERSION,
        receipt.sequence,
        escape_json(receipt.source_sha256),
    )
}

fn canonical_seal_json(
    run_id: &str,
    source_sha256: &str,
    entry_count: u64,
    head_receipt_sha256: &str,
) -> String {
    format!(
        concat!(
            "{{",
            "\"entry_count\":{},",
            "\"head_receipt_sha256\":\"{}\",",
            "\"run_id\":\"{}\",",
            "\"schema_version\":{},",
            "\"source_sha256\":\"{}\"",
            "}}"
        ),
        entry_count,
        escape_json(head_receipt_sha256),
        escape_json(run_id),
        EVIDENCE_SCHEMA_VERSION,
        escape_json(source_sha256),
    )
}

fn escape_json(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(output, "\\u{:04x}", u32::from(character));
            }
            character => output.push(character),
        }
    }
    output
}

fn validate_run_id(value: &str) -> Result<(), EvidenceError> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(EvidenceError::InvalidRunId);
    }
    Ok(())
}

fn validate_kind(value: &str) -> Result<(), EvidenceError> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(EvidenceError::InvalidKind);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    const SOURCE_SHA: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    fn test_root(label: &str) -> PathBuf {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "walle-evidence-{label}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test root");
        path
    }

    fn sha256_program() -> &'static str {
        for path in ["/usr/bin/sha256sum", "/bin/sha256sum"] {
            if Path::new(path).is_file() {
                return path;
            }
        }
        panic!("sha256sum is required by Linux evidence tests");
    }

    fn make_writable_and_replace(path: &Path, bytes: &[u8]) {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).expect("make writable");
        fs::write(path, bytes).expect("replace evidence bytes");
    }

    #[test]
    fn receipts_are_hash_chained_and_seal_is_immutable() {
        let root = test_root("chain");
        let mut run = EvidenceRun::begin_untrusted_for_test(
            &root,
            sha256_program(),
            "run-0123456789abcdef",
            SOURCE_SHA,
        )
        .expect("begin evidence");
        let first = run.append("host-facts", b"host facts\n").expect("first");
        let second = run.append("stdout", b"workload output\n").expect("second");
        assert_eq!(
            second.previous_receipt_sha256.as_deref(),
            Some(first.receipt_sha256.as_str())
        );
        let seal = run.seal().expect("seal");
        assert_eq!(seal.entry_count, 2);
        assert_eq!(seal.head_receipt_sha256, second.receipt_sha256);
        assert!(matches!(
            run.append("stderr", b"late"),
            Err(EvidenceError::Sealed)
        ));
        assert!(matches!(run.seal(), Err(EvidenceError::Sealed)));
        let hasher = SystemSha256::new(sha256_program()).expect("hasher");
        verify_evidence_chain(run.path(), &[first, second], &seal, &hasher)
            .expect("verify complete chain");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn verifier_detects_payload_tampering() {
        let root = test_root("tamper");
        let mut run = EvidenceRun::begin_untrusted_for_test(
            &root,
            sha256_program(),
            "run-abcdef0123456789",
            SOURCE_SHA,
        )
        .expect("begin evidence");
        let receipt = run.append("stderr", b"original\n").expect("append");
        let seal = run.seal().expect("seal");
        let run_path = run.path().to_path_buf();
        make_writable_and_replace(&run_path.join(&receipt.payload_file), b"tampered\n");
        let hasher = SystemSha256::new(sha256_program()).expect("hasher");
        assert!(matches!(
            verify_evidence_chain(&run_path, &[receipt], &seal, &hasher),
            Err(EvidenceError::TamperDetected { .. })
                | Err(EvidenceError::PayloadLengthMismatch { .. })
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn verifier_binds_receipt_metadata_to_canonical_file_bytes() {
        let root = test_root("receipt-tamper");
        let mut run = EvidenceRun::begin_untrusted_for_test(
            &root,
            sha256_program(),
            "run-fedcba9876543210",
            SOURCE_SHA,
        )
        .expect("begin evidence");
        let mut receipt = run.append("runtime-config", b"{}\n").expect("append");
        let seal = run.seal().expect("seal");
        receipt.kind = "stdout".to_owned();
        let hasher = SystemSha256::new(sha256_program()).expect("hasher");
        assert!(matches!(
            verify_evidence_chain(run.path(), &[receipt], &seal, &hasher),
            Err(EvidenceError::CanonicalContentMismatch(_))
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn canonical_receipt_bytes_are_stable() {
        let receipt = CanonicalReceipt {
            run_id: "run-0123",
            source_sha256: SOURCE_SHA,
            sequence: 1,
            kind: "runtime-config",
            payload_file: "000001.payload",
            payload_sha256: SOURCE_SHA,
            payload_bytes: 42,
            previous_receipt_sha256: None,
        };
        let value = canonical_receipt_json(receipt);
        assert_eq!(value, canonical_receipt_json(receipt));
        assert!(value.contains("\"previous_receipt_sha256\":null"));
    }

    #[test]
    fn invalid_identities_fail_before_any_evidence_directory_is_created() {
        let root = test_root("invalid");
        assert!(matches!(
            EvidenceRun::begin_untrusted_for_test(&root, sha256_program(), "../escape", SOURCE_SHA),
            Err(EvidenceError::InvalidRunId)
        ));
        assert!(matches!(
            EvidenceRun::begin_untrusted_for_test(
                &root,
                sha256_program(),
                "run-valid",
                "sha256:ABC"
            ),
            Err(EvidenceError::InvalidSourceSha256)
        ));
        assert_eq!(fs::read_dir(&root).expect("read root").count(), 0);
        fs::remove_dir_all(root).expect("cleanup");
    }
}
