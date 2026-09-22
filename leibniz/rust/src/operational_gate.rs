//! Operational replay boundary for the isolated LEIBNIZ crate.
//!
//! The expected canonical bytes MUST come from a separate, trusted source;
//! reading a file and treating its own checksum as authentication is unsafe.
//! A source pin proves byte identity to the supplied reference, not the real-
//! world truth of its premises, author identity, or GAUSS numerical calibration.
use crate::formal_audit::{audit_trusted_handoff, AuditLimits, ReadOnlyAudit};
use crate::handoff::{GaussProblemV1, GaussResponseV1, HandoffLimits};
use crate::hol::{Derivation, Expr};
use crate::semantic_archive::SemanticArchive;
use std::path::Path;

/// Keep the closed mathematical proposition, independently checked proof, and
/// computational budget together. None of them establish external facts.
pub struct FormalCheck<'a> {
    pub proposition: &'a Expr,
    pub certificate: Option<&'a Derivation>,
    pub limits: AuditLimits,
}

/// Replays a persisted archive only if it is EXACTLY the independently pinned,
/// canonical source. Revalidates provenance, the response and the separate
/// closed HOL certificate without mutating the archive or calling GAUSS.
///
/// A changed, rechecksummed but individually well-formed archive is rejected
/// unless a trusted caller deliberately supplies a NEW expected source.
/// This function does not authenticate the caller, the pin or a symbolic
/// theorem's relevance to the numerical question.
pub fn audit_persisted_pinned(
    path: &Path,
    expected_canonical_bytes: &[u8],
    problem: &GaussProblemV1,
    response: &GaussResponseV1,
    handoff_limits: HandoffLimits,
    formal: FormalCheck<'_>,
) -> Result<ReadOnlyAudit, String> {
    if expected_canonical_bytes.is_empty() {
        return Err("independently pinned source bytes are required".into());
    }
    // Never follow symlinks at the point where the source is selected. This
    // only addresses symlinks at this point in time; a hostile concurrent
    // filesystem requires an OS-level pinned descriptor / directory policy.
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect pinned source: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("pinned source must be an ordinary file, not a symlink or directory".into());
    }
    let archive = SemanticArchive::load(path)?;
    let canonical = archive.to_bytes()?;
    if canonical != expected_canonical_bytes {
        return Err("persisted source differs from independently pinned canonical bytes".into());
    }
    audit_trusted_handoff(
        response,
        problem,
        &archive,
        handoff_limits,
        formal.proposition,
        formal.certificate,
        formal.limits,
    )
}
