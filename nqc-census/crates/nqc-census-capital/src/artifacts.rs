use crate::{
    Amount256, CapitalAsset, CapitalCensusLedger, CapitalCertificationContext, CapitalClass,
    CapitalError, CapitalEvidenceRef, CapitalFeasibility, CapitalRequirement, CapitalSource,
    CollateralRequirement, FeasibilityRejection, FeeModel, GitObjectId, LockRelease,
    RepaymentSemantics, RequirementKind, TemporaryLock, UpstreamCensusStage,
    UpstreamConsumptionReceipt, UpstreamStageAuthority, UpstreamStageAuthoritySpec,
    CAPITAL_SCHEMA_VERSION,
};
use nqc_census_chain::json::Json;
use nqc_census_core::{ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const CAPITAL_SOURCES_FILE: &str = "capital-sources.jsonl";
pub const CAPITAL_REQUIREMENTS_FILE: &str = "capital-requirements.jsonl";
pub const CAPITAL_FEASIBILITY_FILE: &str = "capital-feasibility.jsonl";
pub const CAPITAL_REJECTION_LEDGER_FILE: &str = "capital-rejection-ledger.jsonl";
pub const CAPITAL_SUMMARY_FILE: &str = "capital-census-summary.json";
pub const CAPITAL_UPSTREAM_AUTHORITY_FILE: &str = "capital-upstream-authority.json";
pub const CAPITAL_EVIDENCE_MANIFEST_FILE: &str = "capital-evidence-manifest.json";

const CAPITAL_SUMMARY_SCHEMA_VERSION: u64 = 5;
const CAPITAL_EVIDENCE_MANIFEST_SCHEMA_VERSION: u64 = 3;
const UPSTREAM_AUTHORITY_SCHEMA_VERSION: u64 = 7;
const GENERATED_AT_BASIS: &str = "OBSERVATION_ANCHOR_BLOCK_TIMESTAMP";

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

    pub fn for_anchor(
        anchor: &StateAnchor,
        code_commit: impl Into<String>,
        code_tree: impl Into<String>,
    ) -> Result<Self, CapitalError> {
        Self::new(rfc3339(anchor.timestamp()), code_commit, code_tree)
    }

    fn validate_anchor(&self, anchor: &StateAnchor) -> Result<(), CapitalError> {
        if self.generated_at != rfc3339(anchor.timestamp()) {
            return Err(CapitalError::InvalidCanonical(
                "artifact generated_at must equal observation anchor timestamp",
            ));
        }
        Ok(())
    }
}

fn rfc3339(timestamp: u64) -> String {
    let days = timestamp / 86_400;
    let seconds = timestamp % 86_400;
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3_600,
        (seconds % 3_600) / 60,
        seconds % 60
    )
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
    pub feasible_count: usize,
    pub rejection_count: usize,
    pub capital_commitment: String,
    pub upstream_authority_commitment: String,
    pub generated_at: String,
    pub observation_anchor: StateAnchor,
    pub zero_own_capital_proven: bool,
    pub code_commit: String,
    pub code_tree: String,
}

pub fn verify_capital_artifact_bundle(
    bundle: &CapitalArtifactBundle,
) -> Result<CapitalArtifactVerification, CapitalError> {
    const DATA_FILES: [&str; 6] = [
        CAPITAL_SOURCES_FILE,
        CAPITAL_REQUIREMENTS_FILE,
        CAPITAL_FEASIBILITY_FILE,
        CAPITAL_REJECTION_LEDGER_FILE,
        CAPITAL_SUMMARY_FILE,
        CAPITAL_UPSTREAM_AUTHORITY_FILE,
    ];
    const ALL_FILES: [&str; 7] = [
        CAPITAL_SOURCES_FILE,
        CAPITAL_REQUIREMENTS_FILE,
        CAPITAL_FEASIBILITY_FILE,
        CAPITAL_REJECTION_LEDGER_FILE,
        CAPITAL_SUMMARY_FILE,
        CAPITAL_UPSTREAM_AUTHORITY_FILE,
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
    if json_u64(&manifest, "schema_version")? != CAPITAL_EVIDENCE_MANIFEST_SCHEMA_VERSION {
        return Err(CapitalError::InvalidCanonical(
            "unsupported capital evidence manifest schema",
        ));
    }

    let manifest_artifacts = manifest.get("artifacts").and_then(Json::as_array).ok_or(
        CapitalError::InvalidCanonical("evidence manifest artifacts missing"),
    )?;
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
            return Err(CapitalError::InvalidCanonical("manifest artifact name set"));
        }
        let file = by_name.get(name).ok_or(CapitalError::InvalidCanonical(
            "manifest references missing file",
        ))?;
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

    let non_claims = manifest.get("non_claims").and_then(Json::as_array).ok_or(
        CapitalError::InvalidCanonical("manifest non-claims missing"),
    )?;
    let expected_non_claims = [
        "REAL_SOURCE_CERTIFICATION_NOT_TESTED",
        "PORTFOLIO_CONCURRENT_CAPACITY_NOT_TESTED",
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

    let authority_file =
        by_name
            .get(CAPITAL_UPSTREAM_AUTHORITY_FILE)
            .ok_or(CapitalError::InvalidCanonical(
                "missing upstream authority artifact",
            ))?;
    let (authority, authority_provenance) =
        parse_upstream_authority(authority_file.bytes.as_slice())?;
    let manifest_provenance = provenance_fields(&manifest, "manifest provenance missing")?;
    require_generated_at_basis(&manifest)?;
    manifest_provenance.validate_anchor(authority.observation_anchor())?;
    require_observation_anchor(&manifest, authority.observation_anchor())?;
    if authority_provenance != manifest_provenance {
        return Err(CapitalError::InvalidCanonical(
            "upstream authority/manifest provenance mismatch",
        ));
    }
    let authority_commitment = hex(authority.commitment().as_bytes());

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
            .ok_or(CapitalError::InvalidCanonical(
                "missing capital requirements",
            ))?
            .bytes
            .as_slice(),
    )?;
    let feasibility = parse_jsonl(
        by_name
            .get(CAPITAL_FEASIBILITY_FILE)
            .ok_or(CapitalError::InvalidCanonical(
                "missing capital feasibility",
            ))?
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

    let mut reconstructed = CapitalCensusLedger::evidentiary();
    let mut source_ids = BTreeSet::new();
    let mut source_key_ids = BTreeSet::new();
    for record in &sources {
        let encoded = decode_plain_hex(
            record
                .str_field("canonical_record")
                .map_err(|_| CapitalError::InvalidCanonical("source canonical record missing"))?,
        )?;
        let decoded = CapitalSource::decode_canonical(&encoded)?;
        let provenance = record_provenance(record)?;
        provenance.validate_anchor(decoded.anchor())?;
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
        if !source_key_ids.insert(decoded.key_id().to_hex()) {
            return Err(CapitalError::InvalidCanonical(
                "duplicate source key in artifacts",
            ));
        }
        reconstructed.register_source(decoded)?;
    }

    let mut requirement_ids = BTreeSet::new();
    for record in &requirements {
        let encoded = decode_plain_hex(record.str_field("canonical_record").map_err(|_| {
            CapitalError::InvalidCanonical("requirement canonical record missing")
        })?)?;
        let decoded = CapitalRequirement::decode_canonical(&encoded)?;
        let provenance = record_provenance(record)?;
        provenance.validate_anchor(decoded.anchor())?;
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
        reconstructed.register_requirement(decoded)?;
    }

    let mut feasibility_ids = BTreeSet::new();
    let mut rejected = BTreeSet::new();
    for record in &feasibility {
        let provenance = record_provenance(record)?;
        provenance.validate_anchor(authority.observation_anchor())?;
        require_observation_anchor(record, authority.observation_anchor())?;
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
                let allocations = record.get("allocations").and_then(Json::as_array).ok_or(
                    CapitalError::InvalidCanonical("feasible allocations missing"),
                )?;
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
                rejected.insert((requirement_id.to_owned(), reason.to_owned(), failed_leg));
            }
            _ => return Err(CapitalError::InvalidCanonical("unknown feasibility status")),
        }
    }
    if feasibility_ids != requirement_ids {
        return Err(CapitalError::UnevaluatedRequirement);
    }

    let mut rejection_rows = BTreeSet::new();
    for record in &rejections {
        let provenance = record_provenance(record)?;
        provenance.validate_anchor(authority.observation_anchor())?;
        require_observation_anchor(record, authority.observation_anchor())?;
        let requirement_id = record
            .str_field("requirement_id")
            .map_err(|_| CapitalError::InvalidCanonical("rejection requirement id missing"))?;
        let reason = record
            .str_field("reason")
            .map_err(|_| CapitalError::InvalidCanonical("rejection reason missing"))?;
        let failed_leg = nullable_string(record.get("failed_leg").ok_or(
            CapitalError::InvalidCanonical("rejection failed_leg missing"),
        )?)?;
        rejection_rows.insert((requirement_id.to_owned(), reason.to_owned(), failed_leg));
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
    let zero_own_capital_proven = summary
        .get("zero_own_capital_proven")
        .and_then(Json::as_bool)
        .ok_or(CapitalError::InvalidCanonical(
            "summary zero-own-capital flag missing",
        ))?;
    if summary
        .get("real_source_certification")
        .and_then(Json::as_bool)
        != Some(false)
    {
        return Err(CapitalError::InvalidCanonical(
            "capital artifacts claim real source certification",
        ));
    }
    if summary.get("profitability_claimed").and_then(Json::as_bool) != Some(false) {
        return Err(CapitalError::InvalidCanonical(
            "capital artifacts claim profitability",
        ));
    }

    let summary_provenance_checked = summary_provenance(&summary)?;
    summary_provenance_checked.validate_anchor(authority.observation_anchor())?;
    require_observation_anchor(&summary, authority.observation_anchor())?;

    for key in [
        "generated_at",
        "generated_at_basis",
        "code_commit",
        "code_tree",
    ] {
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
        || upstream_authority_commitment != authority_commitment
    {
        return Err(CapitalError::InvalidCanonical(
            "summary/manifest/upstream authority commitment mismatch",
        ));
    }

    reconstructed.evaluate_all()?;
    let provenance = summary_provenance(&summary)?;
    let regenerated = export_capital_artifacts(&reconstructed, &authority, &provenance)?;
    if regenerated.files.len() != bundle.files.len() {
        return Err(CapitalError::InvalidCanonical(
            "regenerated capital artifact file count differs",
        ));
    }
    for expected_file in &regenerated.files {
        let observed_file =
            by_name
                .get(expected_file.name)
                .ok_or(CapitalError::InvalidCanonical(
                    "regenerated artifact missing from bundle",
                ))?;
        if observed_file.bytes != expected_file.bytes
            || observed_file.sha256 != expected_file.sha256
        {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
    }
    let regenerated_certificate = reconstructed.certify(&authority)?;
    if regenerated_certificate.commitment.to_hex() != capital_commitment {
        return Err(CapitalError::CanonicalDigestMismatch);
    }
    if regenerated_certificate.summary.proves_zero_own_capital() != zero_own_capital_proven {
        return Err(CapitalError::InvalidCanonical(
            "summary zero-own-capital claim differs from regenerated certificate",
        ));
    }

    Ok(CapitalArtifactVerification {
        source_count,
        requirement_count,
        feasibility_count: feasibility.len(),
        feasible_count,
        rejection_count: rejected_count,
        capital_commitment,
        upstream_authority_commitment,
        generated_at: provenance.generated_at,
        observation_anchor: authority.observation_anchor().clone(),
        zero_own_capital_proven,
        code_commit: provenance.code_commit,
        code_tree: provenance.code_tree,
    })
}

pub fn verify_capital_artifact_bundle_for_code(
    bundle: &CapitalArtifactBundle,
    expected_code_commit: &str,
    expected_code_tree: &str,
) -> Result<CapitalArtifactVerification, CapitalError> {
    GitObjectId::parse_hex(expected_code_commit)?;
    GitObjectId::parse_hex(expected_code_tree)?;
    let verified = verify_capital_artifact_bundle(bundle)?;
    if verified.code_commit != expected_code_commit || verified.code_tree != expected_code_tree {
        return Err(CapitalError::InvalidCanonical(
            "capital artifacts do not match expected exact code identity",
        ));
    }
    Ok(verified)
}

pub fn export_capital_artifacts(
    ledger: &CapitalCensusLedger,
    authority: &CapitalCertificationContext,
    provenance: &ArtifactProvenance,
) -> Result<CapitalArtifactBundle, CapitalError> {
    provenance.validate_anchor(authority.observation_anchor())?;
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
        .map(|result| feasibility_record(result, provenance, authority.observation_anchor()))
        .collect::<Vec<_>>();
    let rejection_records = ledger
        .results()
        .filter_map(|result| match result {
            CapitalFeasibility::Rejected { .. } => Some(rejection_record(
                result,
                provenance,
                authority.observation_anchor(),
            )),
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
    let upstream_authority = CapitalArtifactFile::new(
        CAPITAL_UPSTREAM_AUTHORITY_FILE,
        canonical(&upstream_authority_json(authority, provenance))?,
    );

    let summary_json = Json::object([
        ("schema_version", Json::uint(CAPITAL_SUMMARY_SCHEMA_VERSION)),
        (
            "generated_at",
            Json::string(provenance.generated_at.clone()),
        ),
        ("generated_at_basis", Json::string(GENERATED_AT_BASIS)),
        (
            "observation_anchor",
            anchor_json(authority.observation_anchor()),
        ),
        ("code_commit", Json::string(provenance.code_commit.clone())),
        ("code_tree", Json::string(provenance.code_tree.clone())),
        (
            "capital_commitment",
            Json::string(certificate.commitment.to_hex()),
        ),
        (
            "upstream_authority_commitment",
            Json::string(hex(certificate.upstream_authority_commitment.as_bytes())),
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
            "feasibility_scope",
            Json::string("PER_REQUIREMENT_INDEPENDENT"),
        ),
        ("real_source_certification", Json::Bool(false)),
        ("portfolio_concurrent_capacity_claimed", Json::Bool(false)),
        (
            "sources_by_class",
            Json::object(
                certificate
                    .summary
                    .sources_by_class
                    .iter()
                    .map(|(class, count)| (class.code(), Json::uint(u64_count(*count)))),
            ),
        ),
        ("unexplained_capital_failure_count", Json::uint(0)),
        ("profitability_claimed", Json::Bool(false)),
    ]);
    let summary = CapitalArtifactFile::new(CAPITAL_SUMMARY_FILE, canonical(&summary_json)?);

    let listed = [
        &sources,
        &requirements,
        &feasibility,
        &rejections,
        &summary,
        &upstream_authority,
    ];
    let manifest_json = Json::object([
        (
            "schema_version",
            Json::uint(CAPITAL_EVIDENCE_MANIFEST_SCHEMA_VERSION),
        ),
        (
            "generated_at",
            Json::string(provenance.generated_at.clone()),
        ),
        ("generated_at_basis", Json::string(GENERATED_AT_BASIS)),
        (
            "observation_anchor",
            anchor_json(authority.observation_anchor()),
        ),
        ("code_commit", Json::string(provenance.code_commit.clone())),
        ("code_tree", Json::string(provenance.code_tree.clone())),
        (
            "capital_commitment",
            Json::string(certificate.commitment.to_hex()),
        ),
        (
            "upstream_authority_commitment",
            Json::string(hex(certificate.upstream_authority_commitment.as_bytes())),
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
                Json::string("REAL_SOURCE_CERTIFICATION_NOT_TESTED"),
                Json::string("PORTFOLIO_CONCURRENT_CAPACITY_NOT_TESTED"),
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
            upstream_authority,
            manifest,
        ],
    })
}

fn upstream_authority_json(
    authority: &CapitalCertificationContext,
    provenance: &ArtifactProvenance,
) -> Json {
    Json::object([
        (
            "schema_version",
            Json::uint(UPSTREAM_AUTHORITY_SCHEMA_VERSION),
        ),
        (
            "generated_at",
            Json::string(provenance.generated_at.clone()),
        ),
        ("generated_at_basis", Json::string(GENERATED_AT_BASIS)),
        (
            "observation_anchor",
            anchor_json(authority.observation_anchor()),
        ),
        ("code_commit", Json::string(provenance.code_commit.clone())),
        ("code_tree", Json::string(provenance.code_tree.clone())),
        (
            "upstream_authority_commitment",
            Json::string(hex(authority.commitment().as_bytes())),
        ),
        (
            "admitted_evidence_refs",
            Json::array(
                authority
                    .admitted_evidence()
                    .copied()
                    .map(evidence_ref_json),
            ),
        ),
        (
            "consumption_receipts",
            Json::array(authority.consumption_receipts().map(|receipt| {
                Json::object([
                    ("stage", Json::string(receipt.stage().code())),
                    (
                        "authority_artifact_sha256",
                        Json::string(receipt.authority_artifact_sha256().to_hex()),
                    ),
                    (
                        "coverage_commitment",
                        Json::string(receipt.coverage_commitment().to_hex()),
                    ),
                    ("output_count", Json::uint(receipt.output_count())),
                    (
                        "output_set_commitment",
                        Json::string(receipt.output_set_commitment().to_hex()),
                    ),
                ])
            })),
        ),
        (
            "stages",
            Json::array(authority.stages().iter().map(|stage| {
                Json::object([
                    ("stage", Json::string(stage.stage.code())),
                    ("code_commit", Json::string(stage.code_commit.to_hex())),
                    ("code_tree", Json::string(stage.code_tree.to_hex())),
                    (
                        "artifact_sha256",
                        Json::string(stage.artifact_sha256.to_hex()),
                    ),
                    ("observation_anchor", anchor_json(&stage.observation_anchor)),
                    (
                        "unresolved_mismatch_count",
                        Json::uint(stage.unresolved_mismatch_count),
                    ),
                    (
                        "unknown_failure_count",
                        Json::uint(stage.unknown_failure_count),
                    ),
                    ("coverage_complete", Json::Bool(stage.coverage_complete)),
                    ("admitted", Json::Bool(stage.admitted)),
                ])
            })),
        ),
    ])
}

pub(crate) fn parse_upstream_authority(
    bytes: &[u8],
) -> Result<(CapitalCertificationContext, ArtifactProvenance), CapitalError> {
    let parsed = Json::parse(bytes)
        .map_err(|_| CapitalError::InvalidCanonical("invalid upstream authority JSON"))?;
    require_canonical_json(bytes, &parsed)?;
    if json_u64(&parsed, "schema_version")? != UPSTREAM_AUTHORITY_SCHEMA_VERSION {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "unsupported upstream authority schema",
        ));
    }
    let provenance = provenance_fields(&parsed, "upstream authority provenance missing")?;
    let stages = parsed.get("stages").and_then(Json::as_array).ok_or(
        CapitalError::InvalidUpstreamAuthority("upstream authority stages missing"),
    )?;
    if stages.len() != UpstreamCensusStage::ALL.len() {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "upstream authority stage count differs",
        ));
    }

    let mut authorities = Vec::with_capacity(stages.len());
    for row in stages {
        let stage = UpstreamCensusStage::parse_code(
            row.str_field("stage")
                .map_err(|_| CapitalError::InvalidUpstreamAuthority("stage code missing"))?,
        )?;
        let code_commit = GitObjectId::parse_hex(
            row.str_field("code_commit")
                .map_err(|_| CapitalError::InvalidUpstreamAuthority("code commit missing"))?,
        )?;
        let code_tree = GitObjectId::parse_hex(
            row.str_field("code_tree")
                .map_err(|_| CapitalError::InvalidUpstreamAuthority("code tree missing"))?,
        )?;
        let artifact_sha256 = Hash32::parse_hex(
            row.str_field("artifact_sha256")
                .map_err(|_| CapitalError::InvalidUpstreamAuthority("artifact sha256 missing"))?,
        )
        .map_err(|_| CapitalError::InvalidUpstreamAuthority("invalid artifact sha256"))?;
        let coverage_complete = row.get("coverage_complete").and_then(Json::as_bool).ok_or(
            CapitalError::InvalidUpstreamAuthority("upstream coverage-complete flag missing"),
        )?;
        let admitted = row.get("admitted").and_then(Json::as_bool).ok_or(
            CapitalError::InvalidUpstreamAuthority("upstream admitted flag missing"),
        )?;
        let observation_anchor = parse_anchor_json(row.get("observation_anchor").ok_or(
            CapitalError::InvalidUpstreamAuthority("observation anchor missing"),
        )?)?;
        authorities.push(UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
            stage,
            code_commit,
            code_tree,
            artifact_sha256,
            observation_anchor,
            unresolved_mismatch_count: json_u64(row, "unresolved_mismatch_count")?,
            unknown_failure_count: json_u64(row, "unknown_failure_count")?,
            coverage_complete,
            admitted,
        })?);
    }

    let evidence_rows = parsed
        .get("admitted_evidence_refs")
        .and_then(Json::as_array)
        .ok_or(CapitalError::InvalidUpstreamAuthority(
            "admitted evidence refs missing",
        ))?;
    let mut admitted_evidence = Vec::with_capacity(evidence_rows.len());
    for row in evidence_rows {
        admitted_evidence.push(parse_evidence_ref_json(row)?);
    }

    let receipt_rows = parsed
        .get("consumption_receipts")
        .and_then(Json::as_array)
        .ok_or(CapitalError::InvalidUpstreamAuthority(
            "upstream consumption receipts missing",
        ))?;
    let mut consumption_receipts = Vec::with_capacity(receipt_rows.len());
    for row in receipt_rows {
        let stage = UpstreamCensusStage::parse_code(row.str_field("stage").map_err(|_| {
            CapitalError::InvalidUpstreamAuthority("consumption receipt stage missing")
        })?)?;
        let authority_artifact_sha256 =
            Hash32::parse_hex(row.str_field("authority_artifact_sha256").map_err(|_| {
                CapitalError::InvalidUpstreamAuthority(
                    "consumption receipt authority artifact missing",
                )
            })?)
            .map_err(|_| {
                CapitalError::InvalidUpstreamAuthority(
                    "invalid consumption receipt authority artifact",
                )
            })?;
        let coverage_commitment =
            Hash32::parse_hex(row.str_field("coverage_commitment").map_err(|_| {
                CapitalError::InvalidUpstreamAuthority(
                    "consumption receipt coverage commitment missing",
                )
            })?)
            .map_err(|_| {
                CapitalError::InvalidUpstreamAuthority(
                    "invalid consumption receipt coverage commitment",
                )
            })?;
        let output_count = json_u64(row, "output_count")?;
        let output_set_commitment =
            Hash32::parse_hex(row.str_field("output_set_commitment").map_err(|_| {
                CapitalError::InvalidUpstreamAuthority(
                    "consumption receipt output-set commitment missing",
                )
            })?)
            .map_err(|_| {
                CapitalError::InvalidUpstreamAuthority(
                    "invalid consumption receipt output-set commitment",
                )
            })?;
        consumption_receipts.push(UpstreamConsumptionReceipt::from_parts(
            stage,
            authority_artifact_sha256,
            coverage_commitment,
            output_count,
            output_set_commitment,
        )?);
    }

    let authority = CapitalCertificationContext::new(authorities, admitted_evidence)?
        .with_consumption_receipts(consumption_receipts)?;
    provenance.validate_anchor(authority.observation_anchor())?;
    require_generated_at_basis(&parsed)?;
    require_observation_anchor(&parsed, authority.observation_anchor())?;
    let declared_commitment = parsed
        .str_field("upstream_authority_commitment")
        .map_err(|_| {
            CapitalError::InvalidUpstreamAuthority("upstream authority commitment missing")
        })?;
    validate_digest_hex(declared_commitment)?;
    if declared_commitment != hex(authority.commitment().as_bytes()) {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "upstream authority commitment mismatch",
        ));
    }
    if canonical(&upstream_authority_json(&authority, &provenance))? != bytes {
        return Err(CapitalError::InvalidCanonical(
            "upstream authority artifact is not normalized",
        ));
    }
    Ok((authority, provenance))
}

fn metadata(provenance: &ArtifactProvenance) -> Vec<(&'static str, Json)> {
    vec![
        (
            "schema_version",
            Json::uint(u64::from(CAPITAL_SCHEMA_VERSION)),
        ),
        (
            "generated_at",
            Json::string(provenance.generated_at.clone()),
        ),
        ("generated_at_basis", Json::string(GENERATED_AT_BASIS)),
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
        ("capital_ownership", Json::string(source.ownership().code())),
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
        (
            "executable_capacity",
            source
                .executable_capacity()
                .map(|amount| Json::string(amount.to_hex()))
                .unwrap_or(Json::Null),
        ),
        (
            "execution_eligible",
            Json::Bool(source.execution_eligible()),
        ),
        (
            "execution_blockers",
            Json::array(
                source
                    .execution_blockers()
                    .iter()
                    .cloned()
                    .map(Json::string),
            ),
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
        ("protocol_cap", optional_amount_json(caps.protocol_cap)),
        ("market_cap", optional_amount_json(caps.market_cap)),
        (
            "same_block_atomicity",
            Json::Bool(matches!(
                source.repayment(),
                RepaymentSemantics::AtomicSameTransaction | RepaymentSemantics::SameBlock
            )),
        ),
        (
            "temporary_lock",
            temporary_lock_json(source.temporary_lock()),
        ),
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
        RepaymentSemantics::NoRepayment => Json::object([("kind", Json::string("NO_REPAYMENT"))]),
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

fn parse_evidence_ref_json(value: &Json) -> Result<CapitalEvidenceRef, CapitalError> {
    match value
        .str_field("kind")
        .map_err(|_| CapitalError::InvalidUpstreamAuthority("evidence kind missing"))?
    {
        "OBSERVATION" => {
            let text = value.str_field("digest").map_err(|_| {
                CapitalError::InvalidUpstreamAuthority("observation digest missing")
            })?;
            let bytes = decode_plain_hex(text)?;
            let digest: [u8; 32] = bytes.try_into().map_err(|_| {
                CapitalError::InvalidUpstreamAuthority("invalid observation digest")
            })?;
            if digest == [0; 32] {
                return Err(CapitalError::InvalidUpstreamAuthority(
                    "zero observation digest",
                ));
            }
            Ok(CapitalEvidenceRef::Observation(digest))
        }
        "ARTIFACT" => {
            Ok(CapitalEvidenceRef::Artifact(
                Hash32::parse_hex(value.str_field("sha256").map_err(|_| {
                    CapitalError::InvalidUpstreamAuthority("artifact digest missing")
                })?)
                .map_err(|_| CapitalError::InvalidUpstreamAuthority("invalid artifact digest"))?,
            ))
        }
        _ => Err(CapitalError::InvalidUpstreamAuthority(
            "unknown evidence reference kind",
        )),
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
            Json::array(
                requirement
                    .evidence()
                    .iter()
                    .copied()
                    .map(evidence_ref_json),
            ),
        ),
        (
            "canonical_record",
            Json::string(hex(&requirement.canonical_encode())),
        ),
    ]);
    Json::object(fields)
}

fn feasibility_record(
    result: &CapitalFeasibility,
    provenance: &ArtifactProvenance,
    anchor: &StateAnchor,
) -> Json {
    let mut fields = metadata(provenance);
    fields.push(("observation_anchor", anchor_json(anchor)));
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

fn rejection_record(
    result: &CapitalFeasibility,
    provenance: &ArtifactProvenance,
    anchor: &StateAnchor,
) -> Json {
    match result {
        CapitalFeasibility::Rejected {
            requirement_id,
            reason,
            failed_leg,
        } => {
            let mut fields = metadata(provenance);
            fields.extend([
                ("observation_anchor", anchor_json(anchor)),
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

fn parse_anchor_json(value: &Json) -> Result<StateAnchor, CapitalError> {
    let chain = ChainDomain::new(
        json_u64(value, "chain_id")?,
        Hash32::parse_hex(
            value
                .str_field("genesis_hash")
                .map_err(|_| CapitalError::InvalidUpstreamAuthority("genesis hash missing"))?,
        )
        .map_err(|_| CapitalError::InvalidUpstreamAuthority("invalid genesis hash"))?,
        Hash32::parse_hex(
            value
                .str_field("fork_lineage")
                .map_err(|_| CapitalError::InvalidUpstreamAuthority("fork lineage missing"))?,
        )
        .map_err(|_| CapitalError::InvalidUpstreamAuthority("invalid fork lineage"))?,
    )
    .map_err(|_| CapitalError::InvalidUpstreamAuthority("invalid chain domain"))?;
    StateAnchor::new(
        chain,
        json_u64(value, "block_number")?,
        Hash32::parse_hex(
            value
                .str_field("block_hash")
                .map_err(|_| CapitalError::InvalidUpstreamAuthority("block hash missing"))?,
        )
        .map_err(|_| CapitalError::InvalidUpstreamAuthority("invalid block hash"))?,
        Hash32::parse_hex(
            value
                .str_field("parent_hash")
                .map_err(|_| CapitalError::InvalidUpstreamAuthority("parent hash missing"))?,
        )
        .map_err(|_| CapitalError::InvalidUpstreamAuthority("invalid parent hash"))?,
        json_u64(value, "timestamp")?,
        Hash32::parse_hex(
            value
                .str_field("state_root")
                .map_err(|_| CapitalError::InvalidUpstreamAuthority("state root missing"))?,
        )
        .map_err(|_| CapitalError::InvalidUpstreamAuthority("invalid state root"))?,
    )
    .map_err(|_| CapitalError::InvalidUpstreamAuthority("invalid observation anchor"))
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

fn require_generated_at_basis(record: &Json) -> Result<(), CapitalError> {
    if record
        .str_field("generated_at_basis")
        .map_err(|_| CapitalError::InvalidCanonical("generated_at basis missing"))?
        != GENERATED_AT_BASIS
    {
        return Err(CapitalError::InvalidCanonical(
            "generated_at basis is not observation anchor timestamp",
        ));
    }
    Ok(())
}

fn require_observation_anchor(record: &Json, expected: &StateAnchor) -> Result<(), CapitalError> {
    let observed = parse_anchor_json(record.get("observation_anchor").ok_or(
        CapitalError::InvalidCanonical("artifact observation anchor missing"),
    )?)?;
    if &observed != expected {
        return Err(CapitalError::AnchorMismatch);
    }
    Ok(())
}

fn provenance_fields(
    record: &Json,
    missing_field_error: &'static str,
) -> Result<ArtifactProvenance, CapitalError> {
    ArtifactProvenance::new(
        record
            .str_field("generated_at")
            .map_err(|_| CapitalError::InvalidCanonical(missing_field_error))?,
        record
            .str_field("code_commit")
            .map_err(|_| CapitalError::InvalidCanonical(missing_field_error))?,
        record
            .str_field("code_tree")
            .map_err(|_| CapitalError::InvalidCanonical(missing_field_error))?,
    )
}

fn record_provenance(record: &Json) -> Result<ArtifactProvenance, CapitalError> {
    if json_u64(record, "schema_version")? != u64::from(CAPITAL_SCHEMA_VERSION) {
        return Err(CapitalError::InvalidCanonical(
            "unsupported capital record schema",
        ));
    }
    require_generated_at_basis(record)?;
    provenance_fields(record, "record provenance missing")
}

fn summary_provenance(summary: &Json) -> Result<ArtifactProvenance, CapitalError> {
    if json_u64(summary, "schema_version")? != CAPITAL_SUMMARY_SCHEMA_VERSION {
        return Err(CapitalError::InvalidCanonical(
            "unsupported capital summary schema",
        ));
    }
    require_generated_at_basis(summary)?;
    provenance_fields(summary, "summary provenance missing")
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
    if !text.len().is_multiple_of(2) {
        return Err(CapitalError::InvalidCanonical("odd-length capital hex"));
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    for pair in bytes.as_chunks::<2>().0 {
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
