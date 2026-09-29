use crate::{
    Amount256, CapitalAsset, CapitalCaps, CapitalCensusLedger, CapitalCertificationContext,
    CapitalClass, CapitalError, CapitalEvidenceRef, CapitalFeasibility, CapitalRequirement,
    CapitalSource, CollateralRequirement, FeeModel, FeasibilityRejection, GitObjectId,
    LockRelease, RepaymentSemantics, RequirementKind, TemporaryLock,
};
use nqc_census_chain::json::Json;
use nqc_census_core::StateAnchor;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const CAPITAL_SOURCES_FILE: &str = "capital-sources.jsonl";
pub const CAPITAL_REQUIREMENTS_FILE: &str = "capital-requirements.jsonl";
pub const CAPITAL_FEASIBILITY_FILE: &str = "capital-feasibility.jsonl";
pub const CAPITAL_REJECTION_LEDGER_FILE: &str = "capital-rejection-ledger.jsonl";
pub const CAPITAL_SUMMARY_FILE: &str = "capital-census-summary.json";
pub const CAPITAL_EVIDENCE_MANIFEST_FILE: &str = "capital-evidence-manifest.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactProvenance {
    pub generated_at: String,
    pub code_commit: String,
    pub code_tree: String,
}

impl ArtifactProvenance {
    pub fn new(
        generated_at: impl Into<String>,
        code_commit: impl Into<String>,
        code_tree: impl Into<String>,
    ) -> Result<Self, CapitalError> {
        let generated_at = generated_at.into();
        let code_commit = code_commit.into();
        let code_tree = code_tree.into();
        if generated_at.is_empty() || code_commit.is_empty() || code_tree.is_empty() {
            return Err(CapitalError::InvalidCanonical(
                "artifact provenance fields must be nonempty",
            ));
        }
        GitObjectId::parse_hex(&code_commit)?;
        GitObjectId::parse_hex(&code_tree)?;
        Ok(Self {
            generated_at,
            code_commit,
            code_tree,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalArtifactFile {
    pub name: &'static str,
    pub bytes: Vec<u8>,
    pub sha256: [u8; 32],
}

impl CapitalArtifactFile {
    fn new(name: &'static str, bytes: Vec<u8>) -> Self {
        let sha256 = sha256(&bytes);
        Self {
            name,
            bytes,
            sha256,
        }
    }

    pub fn sha256_hex(&self) -> String {
        hex(&self.sha256)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalArtifactBundle {
    pub files: Vec<CapitalArtifactFile>,
}

impl CapitalArtifactBundle {
    pub fn file(&self, name: &str) -> Option<&CapitalArtifactFile> {
        self.files.iter().find(|file| file.name == name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalArtifactVerification {
    pub source_count: usize,
    pub requirement_count: usize,
    pub feasibility_count: usize,
    pub rejection_count: usize,
    pub capital_commitment: String,
    pub upstream_authority_commitment: String,
}

pub fn verify_capital_artifact_bundle(
    bundle: &CapitalArtifactBundle,
) -> Result<CapitalArtifactVerification, CapitalError> {
    const DATA_FILES: [&str; 5] = [
        CAPITAL_SOURCES_FILE,
        CAPITAL_REQUIREMENTS_FILE,
        CAPITAL_FEASIBILITY_FILE,
        CAPITAL_REJECTION_LEDGER_FILE,
        CAPITAL_SUMMARY_FILE,
    ];
    const ALL_FILES: [&str; 6] = [
        CAPITAL_SOURCES_FILE,
        CAPITAL_REQUIREMENTS_FILE,
        CAPITAL_FEASIBILITY_FILE,
        CAPITAL_REJECTION_LEDGER_FILE,
        CAPITAL_SUMMARY_FILE,
        CAPITAL_EVIDENCE_MANIFEST_FILE,
    ];

    if bundle.files.len() != ALL_FILES.len() {
        return Err(CapitalError::InvalidCanonical(
            "capital artifact bundle file count",
        ));
    }
    let mut by_name = BTreeMap::new();
    for file in &bundle.files {
        if by_name.insert(file.name, file).is_some() {
            return Err(CapitalError::InvalidCanonical(
                "duplicate capital artifact file name",
            ));
        }
        if file.sha256 != sha256(&file.bytes) {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
    }
    for name in ALL_FILES {
        if !by_name.contains_key(name) {
            return Err(CapitalError::InvalidCanonical(
                "capital artifact bundle missing required file",
            ));
        }
    }

    let manifest_file = by_name
        .get(CAPITAL_EVIDENCE_MANIFEST_FILE)
        .ok_or(CapitalError::InvalidCanonical("missing evidence manifest"))?;
    let manifest = Json::parse(&manifest_file.bytes)
        .map_err(|_| CapitalError::InvalidCanonical("invalid evidence manifest JSON"))?;
    require_canonical_json(manifest_file.bytes.as_slice(), &manifest)?;

    let manifest_artifacts = manifest
        .get("artifacts")
        .and_then(Json::as_array)
        .ok_or(CapitalError::InvalidCanonical(
            "evidence manifest artifacts missing",
        ))?;
    if manifest_artifacts.len() != DATA_FILES.len() {
        return Err(CapitalError::InvalidCanonical(
            "evidence manifest artifact count",
        ));
    }
    let mut listed = BTreeSet::new();
    for entry in manifest_artifacts {
        let name = entry
            .str_field("name")
            .map_err(|_| CapitalError::InvalidCanonical("manifest artifact name"))?;
        if !DATA_FILES.contains(&name) || !listed.insert(name.to_owned()) {
            return Err(CapitalError::InvalidCanonical(
                "manifest artifact name set",
            ));
        }
        let file = by_name
            .get(name)
            .ok_or(CapitalError::InvalidCanonical("manifest references missing file"))?;
        if entry
            .str_field("sha256")
            .map_err(|_| CapitalError::InvalidCanonical("manifest artifact sha256"))?
            != file.sha256_hex()
        {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
        let size = json_u64(entry, "size_bytes")?;
        if size
            != u64::try_from(file.bytes.len())
                .map_err(|_| CapitalError::InvalidCanonical("artifact size overflow"))?
        {
            return Err(CapitalError::InvalidCanonical(
                "manifest artifact size mismatch",
            ));
        }
    }

    let non_claims = manifest
        .get("non_claims")
        .and_then(Json::as_array)
        .ok_or(CapitalError::InvalidCanonical("manifest non-claims missing"))?;
    let expected_non_claims = [
        "PROFITABILITY_NOT_TESTED",
        "SHADOW_NOT_TESTED",
        "CANARY_NOT_TESTED",
        "REAL_PNL_NOT_TESTED",
    ];
    if non_claims.len() != expected_non_claims.len()
        || !expected_non_claims.iter().all(|expected| {
            non_claims
                .iter()
                .any(|value| value.as_str() == Some(*expected))
        })
    {
        return Err(CapitalError::InvalidCanonical(
            "manifest non-claims changed",
        ));
    }

    let sources = parse_jsonl(
        by_name
            .get(CAPITAL_SOURCES_FILE)
            .ok_or(CapitalError::InvalidCanonical("missing capital sources"))?
            .bytes
            .as_slice(),
    )?;
    let requirements = parse_jsonl(
        by_name
            .get(CAPITAL_REQUIREMENTS_FILE)
            .ok_or(CapitalError::InvalidCanonical("missing capital requirements"))?
            .bytes
            .as_slice(),
    )?;
    let feasibility = parse_jsonl(
        by_name
            .get(CAPITAL_FEASIBILITY_FILE)
            .ok_or(CapitalError::InvalidCanonical("missing capital feasibility"))?
            .bytes
            .as_slice(),
    )?;
    let rejections = parse_jsonl(
        by_name
            .get(CAPITAL_REJECTION_LEDGER_FILE)
            .ok_or(CapitalError::InvalidCanonical("missing rejection ledger"))?
            .bytes
            .as_slice(),
    )?;

    let mut source_ids = BTreeSet::new();
    for record in &sources {
        let encoded = decode_plain_hex(record.str_field("canonical_record").map_err(|_| {
            CapitalError::InvalidCanonical("source canonical record missing")
        })?)?;
        let decoded = CapitalSource::decode_canonical(&encoded)?;
        let provenance = record_provenance(record)?;
        if canonical(&source_record(&decoded, &provenance))? != canonical(record)? {
            return Err(CapitalError::InvalidCanonical(
                "source readable fields differ from canonical record",
            ));
        }
        if record
            .str_field("source_id")
            .map_err(|_| CapitalError::InvalidCanonical("source id missing"))?
            != decoded.id().to_hex()
            || record
                .str_field("source_key_id")
                .map_err(|_| CapitalError::InvalidCanonical("source key id missing"))?
                != decoded.key_id().to_hex()
        {
            return Err(CapitalError::InvalidCanonical(
                "source record identity mismatch",
            ));
        }
        if !source_ids.insert(decoded.id().to_hex()) {
            return Err(CapitalError::InvalidCanonical(
                "duplicate source id in artifacts",
            ));
        }
    }

    let mut requirement_ids = BTreeSet::new();
    for record in &requirements {
        let encoded = decode_plain_hex(record.str_field("canonical_record").map_err(|_| {
            CapitalError::InvalidCanonical("requirement canonical record missing")
        })?)?;
        let decoded = CapitalRequirement::decode_canonical(&encoded)?;
        let provenance = record_provenance(record)?;
        if canonical(&requirement_record(&decoded, &provenance))? != canonical(record)? {
            return Err(CapitalError::InvalidCanonical(
                "requirement readable fields differ from canonical record",
            ));
        }
        if record
            .str_field("requirement_id")
            .map_err(|_| CapitalError::InvalidCanonical("requirement id missing"))?
            != decoded.id().to_hex()
        {
            return Err(CapitalError::InvalidCanonical(
                "requirement record identity mismatch",
            ));
        }
        if !requirement_ids.insert(decoded.id().to_hex()) {
            return Err(CapitalError::InvalidCanonical(
                "duplicate requirement id in artifacts",
            ));
        }
    }

    let mut feasibility_ids = BTreeSet::new();
    let mut rejected = BTreeSet::new();
    for record in &feasibility {
        let requirement_id = record
            .str_field("requirement_id")
            .map_err(|_| CapitalError::InvalidCanonical("feasibility requirement id missing"))?;
        if !requirement_ids.contains(requirement_id)
            || !feasibility_ids.insert(requirement_id.to_owned())
        {
            return Err(CapitalError::InvalidCanonical(
                "feasibility requirement identity mismatch",
            ));
        }
        match record
            .str_field("status")
            .map_err(|_| CapitalError::InvalidCanonical("feasibility status missing"))?
        {
            "FEASIBLE" => {
                let allocations = record
                    .get("allocations")
                    .and_then(Json::as_array)
                    .ok_or(CapitalError::InvalidCanonical(
                        "feasible allocations missing",
                    ))?;
                for allocation in allocations {
                    let source_id = allocation.str_field("source_id").map_err(|_| {
                        CapitalError::InvalidCanonical("allocation source id missing")
                    })?;
                    if !source_ids.contains(source_id) {
                        return Err(CapitalError::MissingSourceForAllocation);
                    }
                    validate_amount_hex(allocation.str_field("amount").map_err(|_| {
                        CapitalError::InvalidCanonical("allocation amount missing")
                    })?)?;
                }
            }
            "REJECTED" => {
                let reason = record
                    .str_field("reason")
                    .map_err(|_| CapitalError::InvalidCanonical("rejection reason missing"))?;
                let failed_leg = nullable_string(record.get("failed_leg").ok_or(
                    CapitalError::InvalidCanonical("rejection failed_leg missing"),
                )?)?;
                rejected.insert((
                    requirement_id.to_owned(),
                    reason.to_owned(),
                    failed_leg,
                ));
            }
            _ => {
                return Err(CapitalError::InvalidCanonical(
                    "unknown feasibility status",
                ))
            }
        }
    }
    if feasibility_ids != requirement_ids {
        return Err(CapitalError::UnevaluatedRequirement);
    }

    let mut rejection_rows = BTreeSet::new();
    for record in &rejections {
        let requirement_id = record
            .str_field("requirement_id")
            .map_err(|_| CapitalError::InvalidCanonical("rejection requirement id missing"))?;
        let reason = record
            .str_field("reason")
            .map_err(|_| CapitalError::InvalidCanonical("rejection reason missing"))?;
        let failed_leg = nullable_string(
            record
                .get("failed_leg")
                .ok_or(CapitalError::InvalidCanonical("rejection failed_leg missing"))?,
        )?;
        rejection_rows.insert((
            requirement_id.to_owned(),
            reason.to_owned(),
            failed_leg,
        ));
    }
    if rejection_rows != rejected {
        return Err(CapitalError::InvalidCanonical(
            "rejection ledger differs from feasibility",
        ));
    }

    let summary_file = by_name
        .get(CAPITAL_SUMMARY_FILE)
        .ok_or(CapitalError::InvalidCanonical("missing capital summary"))?;
    let summary = Json::parse(&summary_file.bytes)
        .map_err(|_| CapitalError::InvalidCanonical("invalid capital summary JSON"))?;
    require_canonical_json(summary_file.bytes.as_slice(), &summary)?;

    let source_count = usize_json(&summary, "source_count")?;
    let requirement_count = usize_json(&summary, "requirement_count")?;
    let feasible_count = usize_json(&summary, "feasible_count")?;
    let rejected_count = usize_json(&summary, "rejected_count")?;
    if source_count != sources.len()
        || requirement_count != requirements.len()
        || feasibility.len() != requirement_count
        || rejected_count != rejections.len()
        || feasible_count
            .checked_add(rejected_count)
            .ok_or(CapitalError::InvalidCanonical("summary count overflow"))?
            != requirement_count
    {
        return Err(CapitalError::InvalidCanonical(
            "capital summary counts differ from artifacts",
        ));
    }
    if json_u64(&summary, "unexplained_capital_failure_count")? != 0 {
        return Err(CapitalError::UnknownFailureMode);
    }
    if summary.get("profitability_claimed").and_then(Json::as_bool) != Some(false) {
        return Err(CapitalError::InvalidCanonical(
            "capital artifacts claim profitability",
        ));
    }

    for key in ["generated_at", "code_commit", "code_tree"] {
        if summary
            .str_field(key)
            .map_err(|_| CapitalError::InvalidCanonical("summary provenance missing"))?
            != manifest
                .str_field(key)
                .map_err(|_| CapitalError::InvalidCanonical("manifest provenance missing"))?
        {
            return Err(CapitalError::InvalidCanonical(
                "summary/manifest provenance mismatch",
            ));
        }
    }
    let capital_commitment = summary
        .str_field("capital_commitment")
        .map_err(|_| CapitalError::InvalidCanonical("capital commitment missing"))?
        .to_owned();
    let upstream_authority_commitment = summary
        .str_field("upstream_authority_commitment")
        .map_err(|_| CapitalError::InvalidCanonical("upstream commitment missing"))?
        .to_owned();
    validate_digest_hex(&capital_commitment)?;
    validate_digest_hex(&upstream_authority_commitment)?;
    if manifest
        .str_field("capital_commitment")
        .map_err(|_| CapitalError::InvalidCanonical("manifest capital commitment missing"))?
        != capital_commitment
        || manifest
            .str_field("upstream_authority_commitment")
            .map_err(|_| CapitalError::InvalidCanonical("manifest upstream commitment missing"))?
            != upstream_authority_commitment
    {
        return Err(CapitalError::InvalidCanonical(
            "summary/manifest commitment mismatch",
        ));
    }

    Ok(CapitalArtifactVerification {
        source_count,
        requirement_count,
        feasibility_count,
        rejection_count,
        capital_commitment,
        upstream_authority_commitment,
    })
}

pub fn export_capital_artifacts(
    ledger: &CapitalCensusLedger,
    authority: &CapitalCertificationContext,
    provenance: &ArtifactProvenance,
) -> Result<CapitalArtifactBundle, CapitalError> {
    let certificate = ledger.certify(authority)?;

    let source_records = ledger
        .sources()
        .map(|source| source_record(source, provenance))
        .collect::<Vec<_>>();
    let requirement_records = ledger
        .requirements()
        .map(|requirement| requirement_record(requirement, provenance))
        .collect::<Vec<_>>();
    let feasibility_records = ledger
        .results()
        .map(|result| feasibility_record(result, provenance))
        .collect::<Vec<_>>();
    let rejection_records = ledger
        .results()
        .filter_map(|result| match result {
            CapitalFeasibility::Rejected { .. } => Some(rejection_record(result, provenance)),
            CapitalFeasibility::Feasible { .. } => None,
        })
        .collect::<Vec<_>>();

    let sources = CapitalArtifactFile::new(CAPITAL_SOURCES_FILE, jsonl(&source_records)?);
    let requirements =
        CapitalArtifactFile::new(CAPITAL_REQUIREMENTS_FILE, jsonl(&requirement_records)?);
    let feasibility =
        CapitalArtifactFile::new(CAPITAL_FEASIBILITY_FILE, jsonl(&feasibility_records)?);
    let rejections =
        CapitalArtifactFile::new(CAPITAL_REJECTION_LEDGER_FILE, jsonl(&rejection_records)?);

    let summary_json = Json::object([
        ("schema_version", Json::uint(1)),
        (
            "generated_at",
            Json::string(provenance.generated_at.clone()),
        ),
        ("code_commit", Json::string(provenance.code_commit.clone())),
        ("code_tree", Json::string(provenance.code_tree.clone())),
        (
            "capital_commitment",
            Json::string(certificate.commitment.to_hex()),
        ),
        (
            "upstream_authority_commitment",
            Json::string(certificate.upstream_authority_commitment.to_hex()),
        ),
        (
            "source_count",
            Json::uint(u64_count(certificate.summary.source_count)),
        ),
        (
            "requirement_count",
            Json::uint(u64_count(certificate.summary.requirement_count)),
        ),
        (
            "feasible_count",
            Json::uint(u64_count(certificate.summary.feasible_count)),
        ),
        (
            "rejected_count",
            Json::uint(u64_count(certificate.summary.rejected_count)),
        ),
        (
            "operator_owned_sources_observed",
            Json::uint(u64_count(
                certificate.summary.operator_owned_sources_observed,
            )),
        ),
        (
            "operator_owned_sources_used",
            Json::uint(u64_count(certificate.summary.operator_owned_sources_used)),
        ),
        (
            "zero_own_capital_proven",
            Json::Bool(certificate.summary.proves_zero_own_capital()),
        ),
        (
            "sources_by_class",
            Json::object(certificate.summary.sources_by_class.iter().map(
                |(class, count)| (class.code(), Json::uint(u64_count(*count))),
            )),
        ),
        ("unexplained_capital_failure_count", Json::uint(0)),
        ("profitability_claimed", Json::Bool(false)),
    ]);
    let summary = CapitalArtifactFile::new(CAPITAL_SUMMARY_FILE, canonical(&summary_json)?);

    let listed = [&sources, &requirements, &feasibility, &rejections, &summary];
    let manifest_json = Json::object([
        ("schema_version", Json::uint(1)),
        (
            "generated_at",
            Json::string(provenance.generated_at.clone()),
        ),
        ("code_commit", Json::string(provenance.code_commit.clone())),
        ("code_tree", Json::string(provenance.code_tree.clone())),
        (
            "capital_commitment",
            Json::string(certificate.commitment.to_hex()),
        ),
        (
            "upstream_authority_commitment",
            Json::string(certificate.upstream_authority_commitment.to_hex()),
        ),
        (
            "artifacts",
            Json::array(listed.into_iter().map(|file| {
                Json::object([
                    ("name", Json::string(file.name)),
                    ("sha256", Json::string(file.sha256_hex())),
                    (
                        "size_bytes",
                        Json::uint(u64::try_from(file.bytes.len()).unwrap_or(u64::MAX)),
                    ),
                ])
            })),
        ),
        (
            "non_claims",
            Json::array([
                Json::string("PROFITABILITY_NOT_TESTED"),
                Json::string("SHADOW_NOT_TESTED"),
                Json::string("CANARY_NOT_TESTED"),
                Json::string("REAL_PNL_NOT_TESTED"),
            ]),
        ),
    ]);
    let manifest =
        CapitalArtifactFile::new(CAPITAL_EVIDENCE_MANIFEST_FILE, canonical(&manifest_json)?);

    Ok(CapitalArtifactBundle {
        files: vec![
            sources,
            requirements,
            feasibility,
            rejections,
            summary,
            manifest,
        ],
    })
}

fn metadata(provenance: &ArtifactProvenance) -> Vec<(&'static str, Json)> {
    vec![
        ("schema_version", Json::uint(1)),
        (
            "generated_at",
            Json::string(provenance.generated_at.clone()),
        ),
        ("code_commit", Json::string(provenance.code_commit.clone())),
        ("code_tree", Json::string(provenance.code_tree.clone())),
    ]
}

fn source_record(source: &CapitalSource, provenance: &ArtifactProvenance) -> Json {
    let mut fields = metadata(provenance);
    let utilization = source.utilization();
    let caps = source.caps();
    fields.extend([
        ("source_id", Json::string(source.id().to_hex())),
        ("source_key_id", Json::string(source.key_id().to_hex())),
        ("capital_class", Json::string(source.class().code())),
        (
            "provider_namespace",
            Json::uint(u64::from(source.provider_namespace())),
        ),
        ("provider_kind", Json::string(source.provider_kind().code())),
        (
            "provider_locator_hash",
            Json::string(source.provider_locator_hash().to_hex()),
        ),
        (
            "source_contract",
            source
                .source_contract()
                .map(|address| Json::string(address.to_hex()))
                .unwrap_or(Json::Null),
        ),
        ("asset", Json::string(source.asset().code())),
        (
            "maximum_available",
            Json::string(source.maximum_available().to_hex()),
        ),
        (
            "effective_capacity",
            source
                .effective_capacity()
                .map(|amount| Json::string(amount.to_hex()))
                .unwrap_or(Json::Null),
        ),
        ("fee_model", fee_model_json(source.fee_model())),
        (
            "repayment_asset",
            Json::string(source.repayment_asset().code()),
        ),
        ("repayment_semantics", repayment_json(source.repayment())),
        ("collateral_required", collateral_json(source.collateral())),
        (
            "utilization_constraints",
            Json::object([
                (
                    "max_utilization_bps",
                    Json::uint(u64::from(utilization.max_utilization_bps)),
                ),
                (
                    "min_remaining",
                    Json::string(utilization.min_remaining.to_hex()),
                ),
            ]),
        ),
        (
            "protocol_cap",
            optional_amount_json(caps.protocol_cap),
        ),
        ("market_cap", optional_amount_json(caps.market_cap)),
        (
            "same_block_atomicity",
            Json::Bool(matches!(
                source.repayment(),
                RepaymentSemantics::AtomicSameTransaction | RepaymentSemantics::SameBlock
            )),
        ),
        ("temporary_lock", temporary_lock_json(source.temporary_lock())),
        (
            "failure_modes",
            Json::array(
                source
                    .failure_modes()
                    .iter()
                    .map(|mode| Json::string(mode.code())),
            ),
        ),
        (
            "evidence_refs",
            Json::array(source.evidence().iter().copied().map(evidence_ref_json)),
        ),
        ("anchor", anchor_json(source.anchor())),
        (
            "canonical_record",
            Json::string(hex(&source.canonical_encode())),
        ),
    ]);
    Json::object(fields)
}

fn optional_amount_json(amount: Option<Amount256>) -> Json {
    amount
        .map(|value| Json::string(value.to_hex()))
        .unwrap_or(Json::Null)
}

fn fee_model_json(model: FeeModel) -> Json {
    match model {
        FeeModel::None => Json::object([("kind", Json::string("NONE"))]),
        FeeModel::BasisPoints { bps, rounding } => Json::object([
            ("kind", Json::string("BASIS_POINTS")),
            ("bps", Json::uint(u64::from(bps))),
            ("rounding", Json::string(rounding.code())),
        ]),
        FeeModel::Fixed { asset, amount } => Json::object([
            ("kind", Json::string("FIXED")),
            ("asset", Json::string(asset.code())),
            ("amount", Json::string(amount.to_hex())),
        ]),
        FeeModel::ExactRatio {
            numerator,
            denominator,
            rounding,
        } => Json::object([
            ("kind", Json::string("EXACT_RATIO")),
            ("numerator", Json::uint(numerator)),
            ("denominator", Json::uint(denominator)),
            ("rounding", Json::string(rounding.code())),
        ]),
    }
}

fn repayment_json(repayment: RepaymentSemantics) -> Json {
    match repayment {
        RepaymentSemantics::AtomicSameTransaction => {
            Json::object([("kind", Json::string("ATOMIC_SAME_TRANSACTION"))])
        }
        RepaymentSemantics::SameBlock => Json::object([("kind", Json::string("SAME_BLOCK"))]),
        RepaymentSemantics::DeadlineBlocks(blocks) => Json::object([
            ("kind", Json::string("DEADLINE_BLOCKS")),
            ("blocks", Json::uint(u64::from(blocks))),
        ]),
        RepaymentSemantics::Persistent(terms) => Json::object([
            ("kind", Json::string("PERSISTENT")),
            (
                "interest_model_hash",
                Json::string(terms.interest_model_hash.to_hex()),
            ),
            (
                "liquidation_model_hash",
                Json::string(terms.liquidation_model_hash.to_hex()),
            ),
            (
                "solvency_model_hash",
                Json::string(terms.solvency_model_hash.to_hex()),
            ),
            (
                "oracle_risk_hash",
                Json::string(terms.oracle_risk_hash.to_hex()),
            ),
            (
                "liquidity_withdrawal_risk_hash",
                Json::string(terms.liquidity_withdrawal_risk_hash.to_hex()),
            ),
            (
                "facility_disappearance_risk_hash",
                Json::string(terms.facility_disappearance_risk_hash.to_hex()),
            ),
        ]),
        RepaymentSemantics::NoRepayment => {
            Json::object([("kind", Json::string("NO_REPAYMENT"))])
        }
    }
}

fn collateral_json(collateral: CollateralRequirement) -> Json {
    match collateral {
        CollateralRequirement::None => Json::object([("required", Json::Bool(false))]),
        CollateralRequirement::Required {
            asset,
            amount,
            liquidation_conditions_hash,
        } => Json::object([
            ("required", Json::Bool(true)),
            ("asset", Json::string(asset.code())),
            ("amount", Json::string(amount.to_hex())),
            (
                "liquidation_conditions_hash",
                Json::string(liquidation_conditions_hash.to_hex()),
            ),
        ]),
    }
}

fn temporary_lock_json(lock: TemporaryLock) -> Json {
    match lock {
        TemporaryLock::None => Json::object([("required", Json::Bool(false))]),
        TemporaryLock::Required {
            asset,
            amount,
            release,
        } => {
            let release = match release {
                LockRelease::EndOfTransaction => Json::string("END_OF_TRANSACTION"),
                LockRelease::EndOfBlock => Json::string("END_OF_BLOCK"),
                LockRelease::DeadlineBlocks(blocks) => Json::object([
                    ("kind", Json::string("DEADLINE_BLOCKS")),
                    ("blocks", Json::uint(u64::from(blocks))),
                ]),
            };
            Json::object([
                ("required", Json::Bool(true)),
                ("asset", Json::string(asset.code())),
                ("amount", Json::string(amount.to_hex())),
                ("release", release),
            ])
        }
    }
}

fn evidence_ref_json(reference: CapitalEvidenceRef) -> Json {
    match reference {
        CapitalEvidenceRef::Observation(digest) => Json::object([
            ("kind", Json::string("OBSERVATION")),
            ("digest", Json::string(hex(&digest))),
        ]),
        CapitalEvidenceRef::Artifact(hash) => Json::object([
            ("kind", Json::string("ARTIFACT")),
            ("sha256", Json::string(hash.to_hex())),
        ]),
    }
}

fn requirement_record(requirement: &CapitalRequirement, provenance: &ArtifactProvenance) -> Json {
    let mut fields = metadata(provenance);
    fields.extend([
        ("requirement_id", Json::string(requirement.id().to_hex())),
        (
            "target_id",
            Json::string(hex(requirement.target().as_bytes())),
        ),
        ("anchor", anchor_json(requirement.anchor())),
        ("atomicity", Json::string(requirement.atomicity().code())),
        (
            "requires_native_gas",
            Json::Bool(requirement.requires_native_gas()),
        ),
        (
            "legs",
            Json::array(requirement.legs().iter().map(|leg| {
                Json::object([
                    ("kind", Json::string(leg.kind().code())),
                    ("asset", Json::string(leg.asset().code())),
                    ("amount", Json::string(leg.amount().to_hex())),
                    (
                        "allowed_classes",
                        Json::array(
                            leg.allowed_classes()
                                .iter()
                                .map(|class| Json::string(class.code())),
                        ),
                    ),
                ])
            })),
        ),
        (
            "evidence_refs",
            Json::array(requirement.evidence().iter().copied().map(evidence_ref_json)),
        ),
        (
            "canonical_record",
            Json::string(hex(&requirement.canonical_encode())),
        ),
    ]);
    Json::object(fields)
}

fn feasibility_record(result: &CapitalFeasibility, provenance: &ArtifactProvenance) -> Json {
    let mut fields = metadata(provenance);
    match result {
        CapitalFeasibility::Feasible {
            requirement_id,
            allocations,
        } => {
            fields.extend([
                ("requirement_id", Json::string(requirement_id.to_hex())),
                ("status", Json::string("FEASIBLE")),
                (
                    "allocations",
                    Json::array(allocations.iter().map(|allocation| {
                        Json::object([
                            ("source_id", Json::string(allocation.source_id.to_hex())),
                            ("leg_kind", Json::string(allocation.leg_kind.code())),
                            ("amount", Json::string(allocation.amount.to_hex())),
                        ])
                    })),
                ),
            ]);
        }
        CapitalFeasibility::Rejected {
            requirement_id,
            reason,
            failed_leg,
        } => {
            fields.extend([
                ("requirement_id", Json::string(requirement_id.to_hex())),
                ("status", Json::string("REJECTED")),
                ("reason", Json::string(reason.code())),
                (
                    "failed_leg",
                    failed_leg
                        .map(|kind| Json::string(kind.code()))
                        .unwrap_or(Json::Null),
                ),
            ]);
        }
    }
    Json::object(fields)
}

fn rejection_record(result: &CapitalFeasibility, provenance: &ArtifactProvenance) -> Json {
    match result {
        CapitalFeasibility::Rejected {
            requirement_id,
            reason,
            failed_leg,
        } => {
            let mut fields = metadata(provenance);
            fields.extend([
                ("requirement_id", Json::string(requirement_id.to_hex())),
                ("reason", Json::string(reason.code())),
                (
                    "failed_leg",
                    failed_leg
                        .map(|kind| Json::string(kind.code()))
                        .unwrap_or(Json::Null),
                ),
                ("classified", Json::Bool(true)),
            ]);
            Json::object(fields)
        }
        CapitalFeasibility::Feasible { .. } => Json::Null,
    }
}

fn anchor_json(anchor: &StateAnchor) -> Json {
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

fn jsonl(records: &[Json]) -> Result<Vec<u8>, CapitalError> {
    let mut out = Vec::new();
    for record in records {
        out.extend_from_slice(&canonical(record)?);
        out.push(b'\n');
    }
    Ok(out)
}

fn canonical(value: &Json) -> Result<Vec<u8>, CapitalError> {
    value
        .canonical()
        .map_err(|_| CapitalError::InvalidCanonical("capital artifact JSON"))
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn hex(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(TABLE[usize::from(byte >> 4)]));
        out.push(char::from(TABLE[usize::from(byte & 0x0f)]));
    }
    out
}

fn u64_count(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

#[allow(dead_code)]
fn _type_fence(
    _amount: Amount256,
    _asset: CapitalAsset,
    _class: CapitalClass,
    _reason: FeasibilityRejection,
    _kind: RequirementKind,
) {
}


fn record_provenance(record: &Json) -> Result<ArtifactProvenance, CapitalError> {
    ArtifactProvenance::new(
        record
            .str_field("generated_at")
            .map_err(|_| CapitalError::InvalidCanonical("record generated_at missing"))?,
        record
            .str_field("code_commit")
            .map_err(|_| CapitalError::InvalidCanonical("record code_commit missing"))?,
        record
            .str_field("code_tree")
            .map_err(|_| CapitalError::InvalidCanonical("record code_tree missing"))?,
    )
}

fn parse_jsonl(bytes: &[u8]) -> Result<Vec<Json>, CapitalError> {
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        return Err(CapitalError::InvalidCanonical(
            "capital JSONL must end with newline",
        ));
    }
    let mut records = Vec::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        let parsed = Json::parse(line)
            .map_err(|_| CapitalError::InvalidCanonical("invalid capital JSONL record"))?;
        require_canonical_json(line, &parsed)?;
        records.push(parsed);
    }
    Ok(records)
}

fn require_canonical_json(bytes: &[u8], value: &Json) -> Result<(), CapitalError> {
    if canonical(value)? != bytes {
        return Err(CapitalError::InvalidCanonical(
            "non-canonical capital artifact JSON",
        ));
    }
    Ok(())
}

fn json_u64(value: &Json, key: &str) -> Result<u64, CapitalError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|number| u64::try_from(number).ok())
        .ok_or(CapitalError::InvalidCanonical(
            "capital artifact integer field",
        ))
}

fn usize_json(value: &Json, key: &str) -> Result<usize, CapitalError> {
    usize::try_from(json_u64(value, key)?)
        .map_err(|_| CapitalError::InvalidCanonical("capital artifact count overflow"))
}

fn nullable_string(value: &Json) -> Result<Option<String>, CapitalError> {
    match value {
        Json::Null => Ok(None),
        Json::String(text) => Ok(Some(text.clone())),
        _ => Err(CapitalError::InvalidCanonical(
            "expected string or null in capital artifact",
        )),
    }
}

fn decode_plain_hex(text: &str) -> Result<Vec<u8>, CapitalError> {
    if text.len() % 2 != 0 {
        return Err(CapitalError::InvalidCanonical("odd-length capital hex"));
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let high = hex_nibble(pair[0])?;
        let low = hex_nibble(pair[1])?;
        out.push((high << 4) | low);
    }
    Ok(out)
}

fn validate_amount_hex(text: &str) -> Result<(), CapitalError> {
    if text.len() != 64 {
        return Err(CapitalError::InvalidCanonical(
            "capital amount must be uint256 hex",
        ));
    }
    let _ = decode_plain_hex(text)?;
    Ok(())
}

fn hex_nibble(byte: u8) -> Result<u8, CapitalError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(CapitalError::InvalidCanonical(
            "non-canonical capital hex digit",
        )),
    }
}


fn validate_digest_hex(text: &str) -> Result<(), CapitalError> {
    if text.len() != 64 || decode_plain_hex(text)?.len() != 32 {
        return Err(CapitalError::InvalidCanonical(
            "capital commitment must be 32-byte hex",
        ));
    }
    Ok(())
}
