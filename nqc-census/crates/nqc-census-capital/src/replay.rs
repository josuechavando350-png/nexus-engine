use crate::{
    artifacts::{
        parse_upstream_authority, verify_capital_artifact_bundle_for_code, CapitalArtifactBundle,
        CapitalArtifactVerification, CAPITAL_UPSTREAM_AUTHORITY_FILE,
    },
    demands::import_d09_borrower_demands,
    upstream::{import_d08_capital_sources, D08CapitalImportContext},
    CapitalCertificationContext, CapitalError, CapitalEvidenceRef, GitObjectId,
    UpstreamCensusStage, UpstreamConsumptionReceipt, UpstreamStageAuthority,
};
use nqc_census_chain::json::Json;
use nqc_census_core::Hash32;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy)]
pub struct D08ReplayInputs<'a> {
    pub state_manifest_jsonl: &'a [u8],
    pub token_admission_jsonl: &'a [u8],
    pub pool_and_factory_facts_json: &'a [u8],
    pub evidence_manifest_json: &'a [u8],
}

#[derive(Debug, Clone, Copy)]
pub struct D09ReplayInputs<'a> {
    pub account_manifest_jsonl: &'a [u8],
    pub account_summary_json: &'a [u8],
    pub evidence_manifest_json: &'a [u8],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct UpstreamAuthorityLockEntry {
    pub stage: UpstreamCensusStage,
    pub code_commit: GitObjectId,
    pub code_tree: GitObjectId,
    pub artifact_sha256: Hash32,
}

impl From<&UpstreamStageAuthority> for UpstreamAuthorityLockEntry {
    fn from(authority: &UpstreamStageAuthority) -> Self {
        Self {
            stage: authority.stage,
            code_commit: authority.code_commit,
            code_tree: authority.code_tree,
            artifact_sha256: authority.artifact_sha256,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamAuthorityLock {
    entries: Vec<UpstreamAuthorityLockEntry>,
    commitment: Hash32,
}

impl UpstreamAuthorityLock {
    pub fn new(mut entries: Vec<UpstreamAuthorityLockEntry>) -> Result<Self, CapitalError> {
        entries.sort_by_key(|entry| entry.stage);
        if entries.len() != UpstreamCensusStage::ALL.len() {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "authority lock must contain exactly RMC-006 through RMC-010",
            ));
        }
        for (expected, observed) in UpstreamCensusStage::ALL.into_iter().zip(&entries) {
            if observed.stage != expected {
                return Err(CapitalError::InvalidUpstreamAuthority(
                    "authority lock stage is missing or duplicated",
                ));
            }
        }

        let mut hasher = Sha256::new();
        hasher.update(b"NQC-RMC011-UPSTREAM-AUTHORITY-LOCK-V1");
        hasher.update([0]);
        hasher.update(
            u64::try_from(entries.len())
                .map_err(|_| {
                    CapitalError::InvalidUpstreamAuthority("authority lock stage count overflow")
                })?
                .to_be_bytes(),
        );
        for entry in &entries {
            hasher.update(entry.stage.code().as_bytes());
            hasher.update([0]);
            hasher.update(entry.code_commit.as_bytes());
            hasher.update(entry.code_tree.as_bytes());
            hasher.update(entry.artifact_sha256.as_bytes());
        }
        let digest: [u8; 32] = hasher.finalize().into();
        let commitment = Hash32::new(digest).map_err(|_| {
            CapitalError::InvalidUpstreamAuthority("zero upstream authority lock commitment")
        })?;
        Ok(Self {
            entries,
            commitment,
        })
    }

    pub fn from_context(context: &CapitalCertificationContext) -> Result<Self, CapitalError> {
        Self::new(
            context
                .stages()
                .iter()
                .map(UpstreamAuthorityLockEntry::from)
                .collect(),
        )
    }

    pub fn entries(&self) -> &[UpstreamAuthorityLockEntry] {
        &self.entries
    }

    pub const fn commitment(&self) -> Hash32 {
        self.commitment
    }

    pub fn verify(&self, context: &CapitalCertificationContext) -> Result<(), CapitalError> {
        if context.stages().len() != self.entries.len() {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "upstream authority lock stage count mismatch",
            ));
        }
        for (locked, observed) in self.entries.iter().zip(context.stages()) {
            if locked.stage != observed.stage
                || locked.code_commit != observed.code_commit
                || locked.code_tree != observed.code_tree
                || locked.artifact_sha256 != observed.artifact_sha256
            {
                return Err(CapitalError::InvalidUpstreamAuthority(
                    "upstream authority differs from external lock",
                ));
            }
        }
        Ok(())
    }

    pub fn canonical_json(&self) -> Result<Vec<u8>, CapitalError> {
        Json::object([
            ("schema_version", Json::uint(1)),
            (
                "authority_lock_commitment",
                Json::string(self.commitment.to_hex()),
            ),
            (
                "stages",
                Json::array(self.entries.iter().map(|entry| {
                    Json::object([
                        ("stage", Json::string(entry.stage.code())),
                        ("code_commit", Json::string(entry.code_commit.to_hex())),
                        ("code_tree", Json::string(entry.code_tree.to_hex())),
                        (
                            "artifact_sha256",
                            Json::string(entry.artifact_sha256.to_hex()),
                        ),
                    ])
                })),
            ),
        ])
        .canonical()
        .map_err(|_| CapitalError::InvalidCanonical("upstream authority lock JSON"))
    }

    pub fn parse_json(bytes: &[u8]) -> Result<Self, CapitalError> {
        let parsed = Json::parse(bytes)
            .map_err(|_| CapitalError::InvalidCanonical("invalid upstream authority lock JSON"))?;
        let canonical = parsed
            .canonical()
            .map_err(|_| CapitalError::InvalidCanonical("upstream authority lock JSON"))?;
        if canonical != bytes {
            return Err(CapitalError::InvalidCanonical(
                "upstream authority lock JSON is not canonical",
            ));
        }
        let schema = parsed
            .get("schema_version")
            .and_then(Json::as_i64)
            .and_then(|value| u64::try_from(value).ok())
            .ok_or(CapitalError::InvalidCanonical(
                "upstream authority lock schema missing",
            ))?;
        if schema != 1 {
            return Err(CapitalError::InvalidCanonical(
                "unsupported upstream authority lock schema",
            ));
        }
        let rows = parsed
            .get("stages")
            .and_then(Json::as_array)
            .ok_or(CapitalError::InvalidCanonical(
                "upstream authority lock stages missing",
            ))?;
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            let stage = UpstreamCensusStage::parse_code(
                row.str_field("stage")
                    .map_err(|_| CapitalError::InvalidCanonical("authority lock stage missing"))?,
            )?;
            let code_commit = GitObjectId::parse_hex(
                row.str_field("code_commit").map_err(|_| {
                    CapitalError::InvalidCanonical("authority lock code commit missing")
                })?,
            )?;
            let code_tree = GitObjectId::parse_hex(
                row.str_field("code_tree").map_err(|_| {
                    CapitalError::InvalidCanonical("authority lock code tree missing")
                })?,
            )?;
            let artifact_sha256 = Hash32::parse_hex(
                row.str_field("artifact_sha256").map_err(|_| {
                    CapitalError::InvalidCanonical("authority lock artifact digest missing")
                })?,
            )
            .map_err(|_| {
                CapitalError::InvalidCanonical("invalid authority lock artifact digest")
            })?;
            entries.push(UpstreamAuthorityLockEntry {
                stage,
                code_commit,
                code_tree,
                artifact_sha256,
            });
        }
        let lock = Self::new(entries)?;
        let declared = parsed
            .str_field("authority_lock_commitment")
            .map_err(|_| {
                CapitalError::InvalidCanonical("authority lock commitment missing")
            })?;
        if declared != lock.commitment.to_hex() {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
        Ok(lock)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpstreamReplayVerification {
    pub d08_source_count: usize,
    pub d09_requirement_count: usize,
    pub d08_receipt: UpstreamConsumptionReceipt,
    pub d09_receipt: UpstreamConsumptionReceipt,
}

fn stage_authority(
    context: &CapitalCertificationContext,
    stage: UpstreamCensusStage,
) -> Result<&UpstreamStageAuthority, CapitalError> {
    context
        .stages()
        .iter()
        .find(|authority| authority.stage == stage)
        .ok_or(CapitalError::InvalidUpstreamAuthority(
            "replay stage authority missing",
        ))
}

fn expected_receipt(
    context: &CapitalCertificationContext,
    stage: UpstreamCensusStage,
) -> Result<UpstreamConsumptionReceipt, CapitalError> {
    context
        .consumption_receipts()
        .copied()
        .find(|receipt| receipt.stage() == stage)
        .ok_or(CapitalError::InvalidUpstreamAuthority(
            "replay consumption receipt missing",
        ))
}

/// Re-runs the exact D08 and D09 importers over the consumed upstream bytes
/// and requires their deterministic receipts to equal the receipts committed
/// by the D11 certification context.
///
/// This is deliberately separate from ordinary artifact verification. A D11
/// artifact bundle alone cannot prove the relationship between upstream bytes
/// and downstream source/requirement IDs unless those upstream bytes are
/// supplied for replay.
pub fn verify_upstream_consumption_by_replay(
    context: &CapitalCertificationContext,
    d08: D08ReplayInputs<'_>,
    d09: D09ReplayInputs<'_>,
) -> Result<UpstreamReplayVerification, CapitalError> {
    let d08_authority = stage_authority(context, UpstreamCensusStage::Rmc008StateAdmission)?;
    let d09_authority = stage_authority(context, UpstreamCensusStage::Rmc009PositionUniverse)?;

    let d08_context = D08CapitalImportContext {
        anchor: context.observation_anchor().clone(),
        evidence: vec![CapitalEvidenceRef::Artifact(d08_authority.artifact_sha256)],
    };
    let d08_import = import_d08_capital_sources(
        d08.state_manifest_jsonl,
        d08.token_admission_jsonl,
        d08.pool_and_factory_facts_json,
        d08.evidence_manifest_json,
        d08_authority,
        &d08_context,
    )?;
    if !d08_import.is_conserved() {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "replayed RMC-008 capital import is not conserved",
        ));
    }
    let d08_receipt = d08_import.consumption_receipt()?;
    if d08_receipt != expected_receipt(context, UpstreamCensusStage::Rmc008StateAdmission)? {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "replayed RMC-008 receipt differs from committed receipt",
        ));
    }

    let d09_import = import_d09_borrower_demands(
        d09.account_manifest_jsonl,
        d09.account_summary_json,
        d09.evidence_manifest_json,
        d09_authority,
        context.observation_anchor(),
    )?;
    if !d09_import.is_conserved() {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "replayed RMC-009 demand import is not conserved",
        ));
    }
    let d09_receipt = d09_import.consumption_receipt()?;
    if d09_receipt != expected_receipt(context, UpstreamCensusStage::Rmc009PositionUniverse)? {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "replayed RMC-009 receipt differs from committed receipt",
        ));
    }

    Ok(UpstreamReplayVerification {
        d08_source_count: d08_import.sources.len(),
        d09_requirement_count: d09_import.requirements_certified,
        d08_receipt,
        d09_receipt,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalReplayVerification {
    pub capital: CapitalArtifactVerification,
    pub upstream: UpstreamReplayVerification,
    pub upstream_authority_lock_commitment: Hash32,
}

/// Verifies the self-contained D11 bundle against an exact code identity,
/// requires every RMC-006..RMC-010 authority identity to equal an external
/// immutable lock, and independently replays the exact RMC-008/RMC-009 bytes.
/// A self-asserted authority inside the D11 bundle is never sufficient for
/// real-source closeout.
pub fn verify_capital_bundle_with_upstream_replay_for_code(
    bundle: &CapitalArtifactBundle,
    expected_code_commit: &str,
    expected_code_tree: &str,
    authority_lock: &UpstreamAuthorityLock,
    d08: D08ReplayInputs<'_>,
    d09: D09ReplayInputs<'_>,
) -> Result<CapitalReplayVerification, CapitalError> {
    let capital =
        verify_capital_artifact_bundle_for_code(bundle, expected_code_commit, expected_code_tree)?;
    let authority_file =
        bundle
            .file(CAPITAL_UPSTREAM_AUTHORITY_FILE)
            .ok_or(CapitalError::InvalidCanonical(
                "capital bundle lacks upstream authority file",
            ))?;
    let (context, _) = parse_upstream_authority(&authority_file.bytes)?;
    authority_lock.verify(&context)?;
    let upstream = verify_upstream_consumption_by_replay(&context, d08, d09)?;
    Ok(CapitalReplayVerification {
        capital,
        upstream,
        upstream_authority_lock_commitment: authority_lock.commitment(),
    })
}
