use crate::{
    artifacts::{
        parse_upstream_authority, verify_capital_artifact_bundle_for_code, CapitalArtifactBundle,
        CapitalArtifactVerification, CAPITAL_UPSTREAM_AUTHORITY_FILE,
    },
    demands::import_d09_borrower_demands,
    upstream::{import_d08_capital_sources, D08CapitalImportContext},
    CapitalCertificationContext, CapitalError, CapitalEvidenceRef, GitObjectId,
    UpstreamCensusStage, UpstreamConsumptionReceipt, UpstreamStageAuthority,
    UpstreamStageAuthoritySpec,
};
use nqc_census_chain::json::Json;
use nqc_census_core::{ChainDomain, Hash32, StateAnchor};
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamAuthorityLockEntry {
    pub stage: UpstreamCensusStage,
    pub code_commit: GitObjectId,
    pub code_tree: GitObjectId,
    pub artifact_sha256: Hash32,
    pub observation_anchor: StateAnchor,
    pub unresolved_mismatch_count: u64,
    pub unknown_failure_count: u64,
    pub coverage_complete: bool,
    pub admitted: bool,
}

impl From<&UpstreamStageAuthority> for UpstreamAuthorityLockEntry {
    fn from(authority: &UpstreamStageAuthority) -> Self {
        Self {
            stage: authority.stage,
            code_commit: authority.code_commit,
            code_tree: authority.code_tree,
            artifact_sha256: authority.artifact_sha256,
            observation_anchor: authority.observation_anchor.clone(),
            unresolved_mismatch_count: authority.unresolved_mismatch_count,
            unknown_failure_count: authority.unknown_failure_count,
            coverage_complete: authority.coverage_complete,
            admitted: authority.admitted,
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
        let observation_anchor = entries
            .first()
            .ok_or(CapitalError::InvalidUpstreamAuthority(
                "authority lock is empty",
            ))?
            .observation_anchor
            .clone();
        if entries
            .iter()
            .any(|entry| entry.observation_anchor != observation_anchor)
        {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "authority lock stages do not share one exact observation anchor",
            ));
        }
        if entries.iter().any(|entry| {
            entry.unresolved_mismatch_count != 0
                || entry.unknown_failure_count != 0
                || !entry.coverage_complete
                || !entry.admitted
        }) {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "authority lock contains a non-certifiable upstream stage",
            ));
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
            hash_anchor(&mut hasher, &entry.observation_anchor);
            hasher.update(entry.unresolved_mismatch_count.to_be_bytes());
            hasher.update(entry.unknown_failure_count.to_be_bytes());
            hasher.update([u8::from(entry.coverage_complete)]);
            hasher.update([u8::from(entry.admitted)]);
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

    pub fn entries(&self) -> &[UpstreamAuthorityLockEntry] {
        &self.entries
    }

    pub fn certification_context(&self) -> Result<CapitalCertificationContext, CapitalError> {
        let mut stages = Vec::with_capacity(self.entries.len());
        let mut admitted_evidence = Vec::with_capacity(self.entries.len());
        for entry in &self.entries {
            let authority = UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
                stage: entry.stage,
                code_commit: entry.code_commit,
                code_tree: entry.code_tree,
                artifact_sha256: entry.artifact_sha256,
                observation_anchor: entry.observation_anchor.clone(),
                unresolved_mismatch_count: entry.unresolved_mismatch_count,
                unknown_failure_count: entry.unknown_failure_count,
                coverage_complete: entry.coverage_complete,
                admitted: entry.admitted,
            })?;
            admitted_evidence.push(CapitalEvidenceRef::Artifact(entry.artifact_sha256));
            stages.push(authority);
        }
        CapitalCertificationContext::new(stages, admitted_evidence)
    }

    pub const fn commitment(&self) -> Hash32 {
        self.commitment
    }

    pub fn observation_anchor(&self) -> &StateAnchor {
        &self.entries[0].observation_anchor
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
                || locked.observation_anchor != observed.observation_anchor
                || locked.unresolved_mismatch_count != observed.unresolved_mismatch_count
                || locked.unknown_failure_count != observed.unknown_failure_count
                || locked.coverage_complete != observed.coverage_complete
                || locked.admitted != observed.admitted
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
                        (
                            "observation_anchor",
                            authority_lock_anchor_json(&entry.observation_anchor),
                        ),
                        (
                            "unresolved_mismatch_count",
                            Json::uint(entry.unresolved_mismatch_count),
                        ),
                        (
                            "unknown_failure_count",
                            Json::uint(entry.unknown_failure_count),
                        ),
                        ("coverage_complete", Json::Bool(entry.coverage_complete)),
                        ("admitted", Json::Bool(entry.admitted)),
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
        let rows =
            parsed
                .get("stages")
                .and_then(Json::as_array)
                .ok_or(CapitalError::InvalidCanonical(
                    "upstream authority lock stages missing",
                ))?;
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            let stage =
                UpstreamCensusStage::parse_code(row.str_field("stage").map_err(|_| {
                    CapitalError::InvalidCanonical("authority lock stage missing")
                })?)?;
            let code_commit =
                GitObjectId::parse_hex(row.str_field("code_commit").map_err(|_| {
                    CapitalError::InvalidCanonical("authority lock code commit missing")
                })?)?;
            let code_tree = GitObjectId::parse_hex(row.str_field("code_tree").map_err(|_| {
                CapitalError::InvalidCanonical("authority lock code tree missing")
            })?)?;
            let artifact_sha256 =
                Hash32::parse_hex(row.str_field("artifact_sha256").map_err(|_| {
                    CapitalError::InvalidCanonical("authority lock artifact digest missing")
                })?)
                .map_err(|_| {
                    CapitalError::InvalidCanonical("invalid authority lock artifact digest")
                })?;
            let observation_anchor =
                parse_authority_lock_anchor(row.get("observation_anchor").ok_or(
                    CapitalError::InvalidCanonical("authority lock observation anchor missing"),
                )?)?;
            let unresolved_mismatch_count = lock_u64(row, "unresolved_mismatch_count")?;
            let unknown_failure_count = lock_u64(row, "unknown_failure_count")?;
            let coverage_complete = row.get("coverage_complete").and_then(Json::as_bool).ok_or(
                CapitalError::InvalidCanonical("authority lock coverage flag missing"),
            )?;
            let admitted = row.get("admitted").and_then(Json::as_bool).ok_or(
                CapitalError::InvalidCanonical("authority lock admitted flag missing"),
            )?;
            entries.push(UpstreamAuthorityLockEntry {
                stage,
                code_commit,
                code_tree,
                artifact_sha256,
                observation_anchor,
                unresolved_mismatch_count,
                unknown_failure_count,
                coverage_complete,
                admitted,
            });
        }
        let lock = Self::new(entries)?;
        let declared = parsed
            .str_field("authority_lock_commitment")
            .map_err(|_| CapitalError::InvalidCanonical("authority lock commitment missing"))?;
        if declared != lock.commitment.to_hex() {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
        if lock.canonical_json()? != bytes {
            return Err(CapitalError::InvalidCanonical(
                "upstream authority lock contains unknown or non-normalized fields",
            ));
        }
        Ok(lock)
    }
}

fn hash_anchor(hasher: &mut Sha256, anchor: &StateAnchor) {
    hasher.update(anchor.chain().chain_id().to_be_bytes());
    hasher.update(anchor.chain().genesis_hash().as_bytes());
    hasher.update(anchor.chain().fork_lineage().as_bytes());
    hasher.update(anchor.block_number().to_be_bytes());
    hasher.update(anchor.block_hash().as_bytes());
    hasher.update(anchor.parent_hash().as_bytes());
    hasher.update(anchor.timestamp().to_be_bytes());
    hasher.update(anchor.state_root().as_bytes());
}

fn authority_lock_anchor_json(anchor: &StateAnchor) -> Json {
    Json::object([
        ("chain_id", Json::uint(anchor.chain().chain_id())),
        (
            "genesis_hash",
            Json::string(anchor.chain().genesis_hash().to_hex()),
        ),
        (
            "fork_lineage",
            Json::string(anchor.chain().fork_lineage().to_hex()),
        ),
        ("block_number", Json::uint(anchor.block_number())),
        ("block_hash", Json::string(anchor.block_hash().to_hex())),
        ("parent_hash", Json::string(anchor.parent_hash().to_hex())),
        ("timestamp", Json::uint(anchor.timestamp())),
        ("state_root", Json::string(anchor.state_root().to_hex())),
    ])
}

fn lock_u64(value: &Json, key: &'static str) -> Result<u64, CapitalError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|number| u64::try_from(number).ok())
        .ok_or(CapitalError::InvalidCanonical(
            "authority lock anchor integer missing",
        ))
}

fn lock_hash(value: &Json, key: &'static str) -> Result<Hash32, CapitalError> {
    Hash32::parse_hex(
        value
            .str_field(key)
            .map_err(|_| CapitalError::InvalidCanonical("authority lock anchor hash missing"))?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid authority lock anchor hash"))
}

fn parse_authority_lock_anchor(value: &Json) -> Result<StateAnchor, CapitalError> {
    let chain = ChainDomain::new(
        lock_u64(value, "chain_id")?,
        lock_hash(value, "genesis_hash")?,
        lock_hash(value, "fork_lineage")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid authority lock chain domain"))?;
    StateAnchor::new(
        chain,
        lock_u64(value, "block_number")?,
        lock_hash(value, "block_hash")?,
        lock_hash(value, "parent_hash")?,
        lock_u64(value, "timestamp")?,
        lock_hash(value, "state_root")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid authority lock observation anchor"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpstreamReplayVerification {
    pub d08_candidate_count: usize,
    pub d08_source_count: usize,
    pub d08_rejected_count: usize,
    pub d09_borrower_count: usize,
    pub d09_below_one_count: usize,
    pub d09_not_below_one_count: usize,
    pub d09_unavailable_count: usize,
    pub d09_blocked_count: usize,
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
        d08_candidate_count: d08_import.candidate_count,
        d08_source_count: d08_import.sources.len(),
        d08_rejected_count: d08_import.rejected_count,
        d09_borrower_count: d09_import.borrower_count,
        d09_below_one_count: d09_import.below_one_count,
        d09_not_below_one_count: d09_import.not_below_one_count,
        d09_unavailable_count: d09_import.unavailable_count,
        d09_blocked_count: d09_import.blocked_count,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealSourceCloseout {
    pub generated_at: String,
    pub observation_anchor: StateAnchor,
    pub code_commit: String,
    pub code_tree: String,
    pub source_count: usize,
    pub requirement_count: usize,
    pub feasible_count: usize,
    pub feasible_external_gas_count: usize,
    pub rejected_count: usize,
    pub d08_candidate_count: usize,
    pub d08_source_count: usize,
    pub d08_rejected_count: usize,
    pub d09_borrower_count: usize,
    pub d09_below_one_count: usize,
    pub d09_not_below_one_count: usize,
    pub d09_unavailable_count: usize,
    pub d09_blocked_count: usize,
    pub d09_requirement_count: usize,
    pub d08_authority_artifact_sha256: Hash32,
    pub d08_coverage_commitment: Hash32,
    pub d08_output_set_commitment: Hash32,
    pub d09_authority_artifact_sha256: Hash32,
    pub d09_coverage_commitment: Hash32,
    pub d09_output_set_commitment: Hash32,
    pub zero_own_capital_proven: bool,
    pub capital_commitment: String,
    pub upstream_authority_commitment: String,
    pub upstream_authority_lock_commitment: Hash32,
    pub upstream_authority_lock_sha256: Hash32,
    pub closeout_commitment: Hash32,
}

impl RealSourceCloseout {
    pub const fn opportunity_level_capital_feasibility_claimed(&self) -> bool {
        self.feasible_count > 0
    }

    /// The current real-source artifact certifies only the exact source subset
    /// imported from admitted RMC-008 bytes. It is intentionally not the
    /// terminal, globally exhaustive Capital Census.
    pub const fn terminal_capital_census_complete(&self) -> bool {
        false
    }

    /// RMC-009 explicitly does not claim liquidatability, so actionable
    /// requirement construction remains downstream RMC-012 authority.
    pub const fn actionable_requirement_coverage_complete(&self) -> bool {
        false
    }

    fn payload_json(&self) -> Result<Json, CapitalError> {
        Ok(Json::object([
            ("schema_version", Json::uint(3)),
            ("status", Json::string("RMC_011_REAL_SOURCE_CLOSEOUT_PASS")),
            (
                "source_universe_basis",
                Json::string("RMC008_ADMITTED_MARKETS_AND_CAPITAL_IMPORT_ONLY"),
            ),
            (
                "global_capital_source_completeness_claimed",
                Json::Bool(false),
            ),
            ("repayment_cashflow_sufficiency_claimed", Json::Bool(false)),
            (
                "terminal_capital_census_complete",
                Json::Bool(self.terminal_capital_census_complete()),
            ),
            (
                "actionable_requirement_coverage_complete",
                Json::Bool(self.actionable_requirement_coverage_complete()),
            ),
            (
                "terminal_blockers",
                Json::array([
                    "GLOBAL_CAPITAL_SOURCE_UNIVERSE_NOT_CERTIFIED",
                    "ACTIONABLE_REQUIREMENT_COVERAGE_DEFERRED_TO_RMC012",
                    "REPAYMENT_CASHFLOW_SUFFICIENCY_NOT_CERTIFIED",
                ].into_iter().map(Json::string)),
            ),
            ("generated_at", Json::string(self.generated_at.clone())),
            (
                "generated_at_basis",
                Json::string("OBSERVATION_ANCHOR_BLOCK_TIMESTAMP"),
            ),
            (
                "observation_anchor",
                authority_lock_anchor_json(&self.observation_anchor),
            ),
            ("code_commit", Json::string(self.code_commit.clone())),
            ("code_tree", Json::string(self.code_tree.clone())),
            (
                "source_count",
                Json::uint(closeout_count(self.source_count)?),
            ),
            (
                "requirement_count",
                Json::uint(closeout_count(self.requirement_count)?),
            ),
            (
                "feasible_count",
                Json::uint(closeout_count(self.feasible_count)?),
            ),
            (
                "feasible_external_gas_count",
                Json::uint(closeout_count(self.feasible_external_gas_count)?),
            ),
            (
                "rejected_count",
                Json::uint(closeout_count(self.rejected_count)?),
            ),
            (
                "d08_candidate_count",
                Json::uint(closeout_count(self.d08_candidate_count)?),
            ),
            (
                "d08_source_count",
                Json::uint(closeout_count(self.d08_source_count)?),
            ),
            (
                "d08_rejected_count",
                Json::uint(closeout_count(self.d08_rejected_count)?),
            ),
            (
                "d09_borrower_count",
                Json::uint(closeout_count(self.d09_borrower_count)?),
            ),
            (
                "d09_below_one_count",
                Json::uint(closeout_count(self.d09_below_one_count)?),
            ),
            (
                "d09_not_below_one_count",
                Json::uint(closeout_count(self.d09_not_below_one_count)?),
            ),
            (
                "d09_unavailable_count",
                Json::uint(closeout_count(self.d09_unavailable_count)?),
            ),
            (
                "d09_blocked_count",
                Json::uint(closeout_count(self.d09_blocked_count)?),
            ),
            (
                "d09_requirement_count",
                Json::uint(closeout_count(self.d09_requirement_count)?),
            ),
            (
                "d08_authority_artifact_sha256",
                Json::string(self.d08_authority_artifact_sha256.to_hex()),
            ),
            (
                "d08_coverage_commitment",
                Json::string(self.d08_coverage_commitment.to_hex()),
            ),
            (
                "d08_output_set_commitment",
                Json::string(self.d08_output_set_commitment.to_hex()),
            ),
            (
                "d09_authority_artifact_sha256",
                Json::string(self.d09_authority_artifact_sha256.to_hex()),
            ),
            (
                "d09_coverage_commitment",
                Json::string(self.d09_coverage_commitment.to_hex()),
            ),
            (
                "d09_output_set_commitment",
                Json::string(self.d09_output_set_commitment.to_hex()),
            ),
            (
                "zero_own_capital_proven",
                Json::Bool(self.zero_own_capital_proven),
            ),
            ("real_source_certification", Json::Bool(true)),
            (
                "opportunity_level_capital_feasibility_claimed",
                Json::Bool(self.opportunity_level_capital_feasibility_claimed()),
            ),
            ("portfolio_concurrent_capacity_claimed", Json::Bool(false)),
            ("profitability_claimed", Json::Bool(false)),
            ("shadow_eligibility_claimed", Json::Bool(false)),
            ("canary_claimed", Json::Bool(false)),
            ("real_pnl_claimed", Json::Bool(false)),
            (
                "capital_commitment",
                Json::string(self.capital_commitment.clone()),
            ),
            (
                "upstream_authority_commitment",
                Json::string(self.upstream_authority_commitment.clone()),
            ),
            (
                "upstream_authority_lock_commitment",
                Json::string(self.upstream_authority_lock_commitment.to_hex()),
            ),
            (
                "upstream_authority_lock_sha256",
                Json::string(self.upstream_authority_lock_sha256.to_hex()),
            ),
            (
                "non_claims",
                Json::array(
                    [
                        "PORTFOLIO_CONCURRENT_CAPACITY_NOT_CERTIFIED",
                        "PROFITABILITY_NOT_CERTIFIED",
                        "SHADOW_NOT_CERTIFIED",
                        "CANARY_NOT_CERTIFIED",
                        "REAL_PNL_NOT_CERTIFIED",
                        "GLOBAL_CAPITAL_SOURCE_UNIVERSE_NOT_CERTIFIED",
                        "REPAYMENT_CASHFLOW_SUFFICIENCY_NOT_CERTIFIED",
                        "TERMINAL_CAPITAL_CENSUS_NOT_CERTIFIED",
                        "ACTIONABLE_REQUIREMENT_COVERAGE_NOT_CERTIFIED",
                    ]
                    .into_iter()
                    .chain(
                        (!self.opportunity_level_capital_feasibility_claimed())
                            .then_some("OPPORTUNITY_LEVEL_CAPITAL_FEASIBILITY_NOT_CERTIFIED"),
                    )
                    .map(Json::string),
                ),
            ),
        ]))
    }

    pub fn canonical_json(&self) -> Result<Vec<u8>, CapitalError> {
        let payload = self.payload_json()?;
        let commitment = real_source_closeout_commitment(&payload)?;
        if commitment != self.closeout_commitment {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
        let payload_bytes = payload
            .canonical()
            .map_err(|_| CapitalError::InvalidCanonical("real-source closeout JSON"))?;
        let payload_text = std::str::from_utf8(&payload_bytes)
            .map_err(|_| CapitalError::InvalidCanonical("real-source closeout is not UTF-8"))?;
        let closing = payload_text
            .strip_suffix('}')
            .ok_or(CapitalError::InvalidCanonical(
                "real-source closeout object malformed",
            ))?;
        let mut out = closing.as_bytes().to_vec();
        out.extend_from_slice(
            format!(
                ",\"closeout_commitment\":\"{}\"}}",
                self.closeout_commitment.to_hex()
            )
            .as_bytes(),
        );
        let parsed = Json::parse(&out)
            .map_err(|_| CapitalError::InvalidCanonical("real-source closeout JSON"))?;
        parsed
            .canonical()
            .map_err(|_| CapitalError::InvalidCanonical("real-source closeout JSON"))
    }
}

fn closeout_count(value: usize) -> Result<u64, CapitalError> {
    u64::try_from(value)
        .map_err(|_| CapitalError::InvalidCanonical("real-source closeout count overflow"))
}

fn real_source_closeout_commitment(payload: &Json) -> Result<Hash32, CapitalError> {
    let bytes = payload
        .canonical()
        .map_err(|_| CapitalError::InvalidCanonical("real-source closeout payload"))?;
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-REAL-SOURCE-CLOSEOUT-V3");
    hasher.update([0]);
    hasher.update(
        u64::try_from(bytes.len())
            .map_err(|_| CapitalError::InvalidCanonical("closeout payload length overflow"))?
            .to_be_bytes(),
    );
    hasher.update(&bytes);
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero real-source closeout commitment"))
}

fn sha256_hash32(bytes: &[u8]) -> Result<Hash32, CapitalError> {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    Hash32::new(digest).map_err(|_| CapitalError::InvalidCanonical("zero SHA-256 digest"))
}

fn require_nonempty_real_source_census(
    capital_source_count: usize,
    replay_source_count: usize,
) -> Result<(), CapitalError> {
    if capital_source_count == 0 || replay_source_count == 0 {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "real-source closeout requires a non-empty observed capital-source census",
        ));
    }
    Ok(())
}

pub fn verify_real_source_closeout_for_code(
    bundle: &CapitalArtifactBundle,
    expected_code_commit: &str,
    expected_code_tree: &str,
    authority_lock: &UpstreamAuthorityLock,
    d08: D08ReplayInputs<'_>,
    d09: D09ReplayInputs<'_>,
) -> Result<RealSourceCloseout, CapitalError> {
    let verified = verify_capital_bundle_with_upstream_replay_for_code(
        bundle,
        expected_code_commit,
        expected_code_tree,
        authority_lock,
        d08,
        d09,
    )?;
    if verified.capital.source_count != verified.upstream.d08_source_count
        || verified.capital.requirement_count != verified.upstream.d09_requirement_count
    {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "real-source replay counts differ from capital artifacts",
        ));
    }
    require_nonempty_real_source_census(
        verified.capital.source_count,
        verified.upstream.d08_source_count,
    )?;
    if verified.capital.requirement_count == 0 && verified.capital.zero_own_capital_proven {
        return Err(CapitalError::InvalidCanonical(
            "zero-own-capital cannot be proven without a certified requirement",
        ));
    }

    let lock_bytes = authority_lock.canonical_json()?;
    let lock_sha256 = sha256_hash32(&lock_bytes)?;
    let mut closeout = RealSourceCloseout {
        generated_at: verified.capital.generated_at,
        observation_anchor: verified.capital.observation_anchor,
        code_commit: verified.capital.code_commit,
        code_tree: verified.capital.code_tree,
        source_count: verified.capital.source_count,
        requirement_count: verified.capital.requirement_count,
        feasible_count: verified.capital.feasible_count,
        feasible_external_gas_count: verified.capital.feasible_external_gas_count,
        rejected_count: verified.capital.rejection_count,
        d08_candidate_count: verified.upstream.d08_candidate_count,
        d08_source_count: verified.upstream.d08_source_count,
        d08_rejected_count: verified.upstream.d08_rejected_count,
        d09_borrower_count: verified.upstream.d09_borrower_count,
        d09_below_one_count: verified.upstream.d09_below_one_count,
        d09_not_below_one_count: verified.upstream.d09_not_below_one_count,
        d09_unavailable_count: verified.upstream.d09_unavailable_count,
        d09_blocked_count: verified.upstream.d09_blocked_count,
        d09_requirement_count: verified.upstream.d09_requirement_count,
        d08_authority_artifact_sha256: verified.upstream.d08_receipt.authority_artifact_sha256(),
        d08_coverage_commitment: verified.upstream.d08_receipt.coverage_commitment(),
        d08_output_set_commitment: verified.upstream.d08_receipt.output_set_commitment(),
        d09_authority_artifact_sha256: verified.upstream.d09_receipt.authority_artifact_sha256(),
        d09_coverage_commitment: verified.upstream.d09_receipt.coverage_commitment(),
        d09_output_set_commitment: verified.upstream.d09_receipt.output_set_commitment(),
        zero_own_capital_proven: verified.capital.zero_own_capital_proven,
        capital_commitment: verified.capital.capital_commitment,
        upstream_authority_commitment: verified.capital.upstream_authority_commitment,
        upstream_authority_lock_commitment: verified.upstream_authority_lock_commitment,
        upstream_authority_lock_sha256: lock_sha256,
        closeout_commitment: lock_sha256,
    };
    closeout.closeout_commitment = real_source_closeout_commitment(&closeout.payload_json()?)?;
    Ok(closeout)
}

pub fn verify_real_source_closeout_bytes_for_code(
    closeout_bytes: &[u8],
    bundle: &CapitalArtifactBundle,
    expected_code_commit: &str,
    expected_code_tree: &str,
    authority_lock: &UpstreamAuthorityLock,
    d08: D08ReplayInputs<'_>,
    d09: D09ReplayInputs<'_>,
) -> Result<RealSourceCloseout, CapitalError> {
    let closeout = verify_real_source_closeout_for_code(
        bundle,
        expected_code_commit,
        expected_code_tree,
        authority_lock,
        d08,
        d09,
    )?;
    if closeout.canonical_json()? != closeout_bytes {
        return Err(CapitalError::CanonicalDigestMismatch);
    }
    Ok(closeout)
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

#[cfg(test)]
mod real_source_shape_tests {
    use super::{require_nonempty_real_source_census, RealSourceCloseout};
    use nqc_census_core::{ChainDomain, Hash32, StateAnchor};

    fn hash(byte: u8) -> Hash32 {
        Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
    }

    fn anchor() -> StateAnchor {
        StateAnchor::new(
            ChainDomain::new(1, hash(1), hash(2)).unwrap_or_else(|_| unreachable!()),
            25_437_474,
            hash(3),
            hash(4),
            1_700_000_000,
            hash(5),
        )
        .unwrap_or_else(|_| unreachable!())
    }

    fn closeout_shape() -> RealSourceCloseout {
        RealSourceCloseout {
            generated_at: "2023-11-14T22:13:20Z".to_owned(),
            observation_anchor: anchor(),
            code_commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            code_tree: "89abcdef0123456789abcdef0123456789abcdef".to_owned(),
            source_count: 1,
            requirement_count: 0,
            feasible_count: 0,
            feasible_external_gas_count: 0,
            rejected_count: 0,
            d08_candidate_count: 1,
            d08_source_count: 1,
            d08_rejected_count: 0,
            d09_borrower_count: 1,
            d09_below_one_count: 1,
            d09_not_below_one_count: 0,
            d09_unavailable_count: 0,
            d09_blocked_count: 1,
            d09_requirement_count: 0,
            d08_authority_artifact_sha256: hash(6),
            d08_coverage_commitment: hash(7),
            d08_output_set_commitment: hash(8),
            d09_authority_artifact_sha256: hash(9),
            d09_coverage_commitment: hash(10),
            d09_output_set_commitment: hash(11),
            zero_own_capital_proven: false,
            capital_commitment: hash(12).to_hex(),
            upstream_authority_commitment: hash(13).to_hex(),
            upstream_authority_lock_commitment: hash(14),
            upstream_authority_lock_sha256: hash(15),
            closeout_commitment: hash(16),
        }
    }

    #[test]
    fn real_source_closeout_rejects_empty_source_census() {
        assert!(require_nonempty_real_source_census(0, 0).is_err());
        assert!(require_nonempty_real_source_census(0, 1).is_err());
        assert!(require_nonempty_real_source_census(1, 0).is_err());
        assert!(require_nonempty_real_source_census(1, 1).is_ok());
    }

    #[test]
    fn real_source_subset_cannot_masquerade_as_terminal_capital_census() {
        let closeout = closeout_shape();
        assert!(!closeout.terminal_capital_census_complete());
        assert!(!closeout.actionable_requirement_coverage_complete());

        let payload = closeout.payload_json().unwrap_or_else(|_| unreachable!());
        assert_eq!(
            payload
                .get("terminal_capital_census_complete")
                .and_then(nqc_census_chain::json::Json::as_bool),
            Some(false)
        );
        assert_eq!(
            payload
                .get("actionable_requirement_coverage_complete")
                .and_then(nqc_census_chain::json::Json::as_bool),
            Some(false)
        );
        let blockers = payload
            .get("terminal_blockers")
            .and_then(nqc_census_chain::json::Json::as_array)
            .unwrap_or_else(|| unreachable!());
        for expected in [
            "GLOBAL_CAPITAL_SOURCE_UNIVERSE_NOT_CERTIFIED",
            "ACTIONABLE_REQUIREMENT_COVERAGE_DEFERRED_TO_RMC012",
            "REPAYMENT_CASHFLOW_SUFFICIENCY_NOT_CERTIFIED",
        ] {
            assert!(blockers.iter().any(|value| value.as_str() == Some(expected)));
        }
        let non_claims = payload
            .get("non_claims")
            .and_then(nqc_census_chain::json::Json::as_array)
            .unwrap_or_else(|| unreachable!());
        for expected in [
            "TERMINAL_CAPITAL_CENSUS_NOT_CERTIFIED",
            "ACTIONABLE_REQUIREMENT_COVERAGE_NOT_CERTIFIED",
        ] {
            assert!(non_claims.iter().any(|value| value.as_str() == Some(expected)));
        }
    }
}
