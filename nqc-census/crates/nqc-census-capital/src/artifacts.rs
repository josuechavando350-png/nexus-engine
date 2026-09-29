use crate::{
    Amount256, CapitalAsset, CapitalCensusLedger, CapitalCertificationContext, CapitalClass,
    CapitalError, CapitalFeasibility, CapitalRequirement, CapitalSource, FeasibilityRejection,
    RequirementKind,
};
use nqc_census_chain::json::Json;
use nqc_census_core::StateAnchor;
use sha2::{Digest, Sha256};

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
        ("asset", Json::string(source.asset().code())),
        (
            "maximum_available",
            Json::string(source.maximum_available().to_hex()),
        ),
        ("anchor", anchor_json(source.anchor())),
        (
            "canonical_record",
            Json::string(hex(&source.canonical_encode())),
        ),
    ]);
    Json::object(fields)
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
