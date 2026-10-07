//! Strict bridge from admitted RMC-008 state artifacts into RMC-011 capital sources.
//!
//! This module does not perform RPC calls and does not trust "latest" artifacts.
//! Its caller must bind the input bytes to admitted upstream authority. The importer
//! only accepts state rows that are reconstructable and tokens whose D08 execution
//! compatibility is explicitly proven.

use crate::{
    adapters::{
        AaveV3FlashObservation, UniswapV2FlashSwapObservation, AAVE_V3_PROVIDER_NAMESPACE,
        UNISWAP_V2_PROVIDER_NAMESPACE,
    },
    Amount256, CapitalAsset, CapitalError, CapitalEvidenceRef, CapitalSource, UpstreamCensusStage,
    UpstreamConsumptionReceipt, UpstreamStageAuthority,
};
use nqc_census_chain::{hex, json::Json};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapitalImportRejectionReason {
    HistoricalNoActiveState,
    StateNotReconstructable,
    TokenExecutionCompatibilityBlocked,
    FlashLoanDisabled,
    ReserveInactiveOrPaused,
    V2LiquidityUnavailable,
    FeeSemanticsUnsupported,
    FlashSwapReserveUnavailable,
}

impl CapitalImportRejectionReason {
    pub const fn code(self) -> &'static str {
        match self {
            Self::HistoricalNoActiveState => "HISTORICAL_NO_ACTIVE_STATE",
            Self::StateNotReconstructable => "STATE_NOT_RECONSTRUCTABLE",
            Self::TokenExecutionCompatibilityBlocked => "TOKEN_EXECUTION_COMPATIBILITY_BLOCKED",
            Self::FlashLoanDisabled => "FLASH_LOAN_DISABLED",
            Self::ReserveInactiveOrPaused => "RESERVE_INACTIVE_OR_PAUSED",
            Self::V2LiquidityUnavailable => "V2_LIQUIDITY_UNAVAILABLE",
            Self::FeeSemanticsUnsupported => "FEE_SEMANTICS_UNSUPPORTED",
            Self::FlashSwapReserveUnavailable => "FLASH_SWAP_RESERVE_UNAVAILABLE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalImportRejection {
    pub protocol: String,
    pub market_id: String,
    pub asset: CapitalAsset,
    pub reason: CapitalImportRejectionReason,
}

#[derive(Debug, Clone)]
pub struct D08CapitalImportContext {
    pub anchor: StateAnchor,
    pub evidence: Vec<CapitalEvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct D08CapitalImport {
    pub candidate_count: usize,
    pub admitted_count: usize,
    pub rejected_count: usize,
    pub coverage_commitment: Hash32,
    pub sources: Vec<CapitalSource>,
    pub rejections: Vec<CapitalImportRejection>,
    authority_artifact_sha256: Option<Hash32>,
}

impl D08CapitalImport {
    pub const fn is_conserved(&self) -> bool {
        self.candidate_count == self.admitted_count + self.rejected_count
            && self.admitted_count == self.sources.len()
            && self.rejected_count == self.rejections.len()
    }

    pub fn consumption_receipt(&self) -> Result<UpstreamConsumptionReceipt, CapitalError> {
        let authority_artifact_sha256 =
            self.authority_artifact_sha256
                .ok_or(CapitalError::InvalidUpstreamAuthority(
                    "D08 import is not bound to an admitted authority artifact",
                ))?;
        UpstreamConsumptionReceipt::for_sources(
            authority_artifact_sha256,
            self.coverage_commitment,
            self.sources.iter(),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ImportOutcome {
    protocol: String,
    market_id: String,
    asset: CapitalAsset,
    result: ImportOutcomeResult,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ImportOutcomeResult {
    Admitted([u8; 32]),
    Rejected(CapitalImportRejectionReason),
}

fn field<'a>(row: &'a Json, key: &'static str) -> Result<&'a Json, CapitalError> {
    row.get(key)
        .ok_or(CapitalError::InvalidCanonical("missing D08 field"))
}

fn text<'a>(row: &'a Json, key: &'static str) -> Result<&'a str, CapitalError> {
    field(row, key)?
        .as_str()
        .ok_or(CapitalError::InvalidCanonical("D08 field is not text"))
}

fn bool_field(row: &Json, key: &'static str) -> Result<bool, CapitalError> {
    field(row, key)?
        .as_bool()
        .ok_or(CapitalError::InvalidCanonical("D08 field is not boolean"))
}

fn u64_field(row: &Json, key: &'static str) -> Result<u64, CapitalError> {
    field(row, key)?
        .as_i64()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(CapitalError::InvalidCanonical(
            "D08 field is not a nonnegative integer",
        ))
}

fn array<'a>(row: &'a Json, key: &'static str) -> Result<&'a [Json], CapitalError> {
    field(row, key)?
        .as_array()
        .ok_or(CapitalError::InvalidCanonical("D08 field is not array"))
}

fn d08_hash(row: &Json, key: &'static str) -> Result<Hash32, CapitalError> {
    Hash32::parse_hex(text(row, key)?)
        .map_err(|_| CapitalError::InvalidCanonical("invalid D08 anchor hash"))
}

fn d08_observation_anchor(row: &Json) -> Result<StateAnchor, CapitalError> {
    let chain = ChainDomain::new(
        u64_field(row, "chain_id")?,
        d08_hash(row, "genesis_hash")?,
        d08_hash(row, "fork_lineage")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid D08 chain domain"))?;
    StateAnchor::new(
        chain,
        u64_field(row, "block_number")?,
        d08_hash(row, "block_hash")?,
        d08_hash(row, "parent_hash")?,
        u64_field(row, "timestamp")?,
        d08_hash(row, "state_root")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid D08 observation anchor"))
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

fn parse_jsonl(bytes: &[u8]) -> Result<Vec<Json>, CapitalError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| CapitalError::InvalidCanonical("D08 JSONL is not UTF-8"))?;
    let mut rows = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        rows.push(
            Json::parse(line.as_bytes())
                .map_err(|_| CapitalError::InvalidCanonical("D08 JSONL parse failed"))?,
        );
    }
    Ok(rows)
}

pub(crate) fn token_execution_blockers(
    bytes: &[u8],
) -> Result<BTreeMap<Address, Vec<String>>, CapitalError> {
    let mut tokens = BTreeMap::new();
    for row in parse_jsonl(bytes)? {
        let token = Address::parse_hex(text(&row, "token")?)
            .map_err(|_| CapitalError::InvalidCanonical("invalid D08 token address"))?;
        let execution = field(&row, "execution_compatibility")?;
        let raw_blockers = array(execution, "blockers")?;
        let mut blockers = raw_blockers
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(ToOwned::to_owned)
                    .ok_or(CapitalError::InvalidCanonical(
                        "D08 execution blocker is not text",
                    ))
            })
            .collect::<Result<Vec<_>, _>>()?;
        blockers.sort();
        if blockers.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(CapitalError::InvalidCanonical(
                "duplicate D08 execution blocker",
            ));
        }
        match text(execution, "status")? {
            "PROVEN_COMPATIBLE" if blockers.is_empty() => {}
            "BLOCKED" if !blockers.is_empty() => {}
            "PROVEN_COMPATIBLE" | "BLOCKED" => {
                return Err(CapitalError::InvalidCanonical(
                    "D08 token compatibility status contradicts blockers",
                ))
            }
            _ => {
                return Err(CapitalError::InvalidCanonical(
                    "unknown D08 token compatibility status",
                ))
            }
        }
        if tokens.insert(token, blockers).is_some() {
            return Err(CapitalError::InvalidCanonical(
                "duplicate D08 token admission",
            ));
        }
    }
    Ok(tokens)
}

pub(crate) fn execution_blockers(
    tokens: &BTreeMap<Address, Vec<String>>,
    token: Address,
) -> Result<&[String], CapitalError> {
    tokens
        .get(&token)
        .map(Vec::as_slice)
        .ok_or(CapitalError::InvalidCanonical(
            "D08 state row references token without admission record",
        ))
}

fn push_rejection(
    rejections: &mut Vec<CapitalImportRejection>,
    outcomes: &mut Vec<ImportOutcome>,
    protocol: &str,
    market_id: &str,
    asset: CapitalAsset,
    reason: CapitalImportRejectionReason,
) {
    rejections.push(CapitalImportRejection {
        protocol: protocol.to_owned(),
        market_id: market_id.to_owned(),
        asset,
        reason,
    });
    outcomes.push(ImportOutcome {
        protocol: protocol.to_owned(),
        market_id: market_id.to_owned(),
        asset,
        result: ImportOutcomeResult::Rejected(reason),
    });
}

fn push_source(
    sources: &mut Vec<CapitalSource>,
    outcomes: &mut Vec<ImportOutcome>,
    protocol: &str,
    market_id: &str,
    asset: CapitalAsset,
    source: CapitalSource,
) {
    outcomes.push(ImportOutcome {
        protocol: protocol.to_owned(),
        market_id: market_id.to_owned(),
        asset,
        // Coverage commits to the stable source identity, not the observation-specific
        // source id. Re-serialization of the same admitted D08 facts changes the
        // evidence-manifest digest (and therefore CapitalSourceId), but must not
        // change candidate coverage.
        result: ImportOutcomeResult::Admitted(*source.key_id().as_bytes()),
    });
    sources.push(source);
}

fn write_len_prefixed(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

fn protocol_contract_locator_hash(
    provider_namespace: u16,
    source_contract: Address,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-PROTOCOL-CONTRACT-LOCATOR-V1");
    hasher.update([0]);
    hasher.update(provider_namespace.to_be_bytes());
    hasher.update(source_contract.as_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero protocol contract locator hash"))
}

fn coverage_commitment(outcomes: &mut [ImportOutcome]) -> Result<Hash32, CapitalError> {
    outcomes.sort();
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-D08-CAPITAL-IMPORT-COVERAGE-V1");
    hasher.update([0]);
    hasher.update(
        u64::try_from(outcomes.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    for outcome in outcomes {
        write_len_prefixed(&mut hasher, outcome.protocol.as_bytes());
        write_len_prefixed(&mut hasher, outcome.market_id.as_bytes());
        match outcome.asset {
            CapitalAsset::NativeGas => hasher.update([0]),
            CapitalAsset::Token(address) => {
                hasher.update([1]);
                hasher.update(address.as_bytes());
            }
        }
        match outcome.result {
            ImportOutcomeResult::Admitted(source_id) => {
                hasher.update([1]);
                hasher.update(source_id);
            }
            ImportOutcomeResult::Rejected(reason) => {
                hasher.update([2]);
                write_len_prefixed(&mut hasher, reason.code().as_bytes());
            }
        }
    }
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 32];
    bytes.copy_from_slice(&digest);
    Hash32::new(bytes).map_err(|_| CapitalError::InvalidCanonical("zero D08 coverage commitment"))
}

/// Parse the exact Aave V3 Pool and FLASHLOAN_PREMIUM_TOTAL admitted by RMC-008.
pub fn d08_aave_flash_terms(bytes: &[u8]) -> Result<(Address, u16), CapitalError> {
    let root = Json::parse(bytes)
        .map_err(|_| CapitalError::InvalidCanonical("D08 pool facts JSON parse failed"))?;
    let aave = field(&root, "aave_pool")?;
    let pool = Address::parse_hex(text(aave, "pool")?)
        .map_err(|_| CapitalError::InvalidCanonical("invalid D08 Aave pool address"))?;
    let scalars = field(aave, "scalars")?;
    let premium = field(scalars, "FLASHLOAN_PREMIUM_TOTAL()")?;
    if text(premium, "status")? != "RETURNED" {
        return Err(CapitalError::InvalidCanonical(
            "D08 Aave flash premium was not returned",
        ));
    }
    let encoded = hex::decode_data(text(premium, "data")?)
        .map_err(|_| CapitalError::InvalidCanonical("invalid D08 Aave flash premium bytes"))?;
    if encoded.len() != 32 || encoded[..30].iter().any(|byte| *byte != 0) {
        return Err(CapitalError::InvalidCanonical(
            "D08 Aave flash premium is not canonical uint16",
        ));
    }
    let value = u16::from_be_bytes([encoded[30], encoded[31]]);
    if value > 10_000 {
        return Err(CapitalError::InvalidBasisPoints(value));
    }
    Ok((pool, value))
}

pub(crate) fn verify_d08_artifact_binding(
    state_manifest_jsonl: &[u8],
    token_admission_jsonl: &[u8],
    pool_and_factory_facts_json: &[u8],
    evidence_manifest_json: &[u8],
    authority: &UpstreamStageAuthority,
    context: &D08CapitalImportContext,
) -> Result<(), CapitalError> {
    if authority.stage != UpstreamCensusStage::Rmc008StateAdmission
        || authority.unresolved_mismatch_count != 0
        || authority.unknown_failure_count != 0
        || !authority.coverage_complete
        || !authority.admitted
    {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "RMC-008 authority is not certifiable",
        ));
    }
    if authority.observation_anchor != context.anchor {
        return Err(CapitalError::AnchorMismatch);
    }

    let manifest_digest: [u8; 32] = Sha256::digest(evidence_manifest_json).into();
    if &manifest_digest != authority.artifact_sha256.as_bytes() {
        return Err(CapitalError::CanonicalDigestMismatch);
    }
    let manifest = Json::parse(evidence_manifest_json)
        .map_err(|_| CapitalError::InvalidCanonical("D08 evidence manifest JSON parse failed"))?;
    if u64_field(&manifest, "schema_version")? != 1 {
        return Err(CapitalError::InvalidCanonical(
            "unsupported D08 evidence manifest schema",
        ));
    }
    if text(&manifest, "code_commit")? != authority.code_commit.to_hex()
        || text(&manifest, "code_tree")? != authority.code_tree.to_hex()
    {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "D08 evidence manifest code identity mismatch",
        ));
    }
    let manifest_anchor = d08_observation_anchor(field(&manifest, "observation_anchor")?)?;
    if manifest_anchor != authority.observation_anchor
        || manifest_anchor != context.anchor
        || text(&manifest, "generated_at")? != rfc3339(context.anchor.timestamp())
    {
        return Err(CapitalError::AnchorMismatch);
    }

    let expected: [(&str, &[u8]); 3] = [
        ("market-state-manifest.jsonl", state_manifest_jsonl),
        ("token-admission.jsonl", token_admission_jsonl),
        ("pool-and-factory-facts.json", pool_and_factory_facts_json),
    ];
    let artifacts = array(&manifest, "artifacts")?;
    let mut seen_paths = BTreeSet::new();
    let mut verified_paths = BTreeSet::new();
    for entry in artifacts {
        let path = text(entry, "path")?;
        if !seen_paths.insert(path.to_owned()) {
            return Err(CapitalError::InvalidCanonical(
                "duplicate D08 evidence manifest artifact path",
            ));
        }
        let Some((_, bytes)) = expected
            .iter()
            .find(|(expected_path, _)| *expected_path == path)
        else {
            continue;
        };
        let digest: [u8; 32] = Sha256::digest(*bytes).into();
        if text(entry, "sha256")? != hex::plain(&digest) {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
        let declared_bytes = u64_field(entry, "bytes")?;
        if declared_bytes
            != u64::try_from(bytes.len())
                .map_err(|_| CapitalError::InvalidCanonical("D08 artifact length overflow"))?
        {
            return Err(CapitalError::InvalidCanonical(
                "D08 evidence manifest artifact length mismatch",
            ));
        }
        verified_paths.insert(path.to_owned());
    }
    if verified_paths.len() != expected.len() {
        return Err(CapitalError::InvalidCanonical(
            "D08 evidence manifest is missing a consumed artifact",
        ));
    }

    let manifest_evidence = CapitalEvidenceRef::Artifact(authority.artifact_sha256);
    if context.evidence.as_slice() != [manifest_evidence] {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "D08 import evidence must be exactly its admitted authority artifact",
        ));
    }
    Ok(())
}

pub fn import_d08_capital_sources(
    state_manifest_jsonl: &[u8],
    token_admission_jsonl: &[u8],
    pool_and_factory_facts_json: &[u8],
    evidence_manifest_json: &[u8],
    authority: &UpstreamStageAuthority,
    context: &D08CapitalImportContext,
) -> Result<D08CapitalImport, CapitalError> {
    verify_d08_artifact_binding(
        state_manifest_jsonl,
        token_admission_jsonl,
        pool_and_factory_facts_json,
        evidence_manifest_json,
        authority,
        context,
    )?;
    let mut imported = import_d08_capital_sources_unbound(
        state_manifest_jsonl,
        token_admission_jsonl,
        pool_and_factory_facts_json,
        context,
    )?;
    imported.authority_artifact_sha256 = Some(authority.artifact_sha256);
    Ok(imported)
}

fn import_d08_capital_sources_unbound(
    state_manifest_jsonl: &[u8],
    token_admission_jsonl: &[u8],
    pool_and_factory_facts_json: &[u8],
    context: &D08CapitalImportContext,
) -> Result<D08CapitalImport, CapitalError> {
    if context.evidence.is_empty() {
        return Err(CapitalError::MissingEvidence);
    }
    let (aave_pool, aave_premium_total_bps) = d08_aave_flash_terms(pool_and_factory_facts_json)?;
    let tokens = token_execution_blockers(token_admission_jsonl)?;
    let mut sources = Vec::new();
    let mut rejections = Vec::new();
    let mut outcomes = Vec::new();
    let mut candidate_keys = BTreeSet::new();

    for row in parse_jsonl(state_manifest_jsonl)? {
        if u64_field(&row, "schema_version")? != 1 {
            return Err(CapitalError::InvalidCanonical(
                "unsupported D08 market-state schema",
            ));
        }
        let protocol = text(&row, "protocol")?;
        let market_id = text(&row, "market_id")?.to_owned();
        match protocol {
            "AAVE_V3" => {
                let asset_address = Address::parse_hex(text(&row, "asset")?)
                    .map_err(|_| CapitalError::InvalidCanonical("invalid Aave asset"))?;
                let asset = CapitalAsset::Token(asset_address);
                if !candidate_keys.insert((protocol.to_owned(), market_id.clone(), asset)) {
                    return Err(CapitalError::InvalidCanonical(
                        "duplicate D08 capital source candidate",
                    ));
                }
                if text(&row, "lifecycle")? != "CURRENT" {
                    push_rejection(
                        &mut rejections,
                        &mut outcomes,
                        protocol,
                        &market_id,
                        asset,
                        CapitalImportRejectionReason::HistoricalNoActiveState,
                    );
                    continue;
                }
                if text(&row, "stage_state_reconstructable")? != "ADVANCE" {
                    push_rejection(
                        &mut rejections,
                        &mut outcomes,
                        protocol,
                        &market_id,
                        asset,
                        CapitalImportRejectionReason::StateNotReconstructable,
                    );
                    continue;
                }
                let token_blockers = execution_blockers(&tokens, asset_address)?.to_vec();

                let facts = field(&row, "protocol_facts")?;
                let active = bool_field(facts, "active")?;
                let paused = bool_field(facts, "paused")?;
                let flash_loan_enabled = bool_field(facts, "flash_loan_enabled")?;
                let available = Amount256::parse_decimal(text(facts, "available_liquidity")?)?;
                let mut source_blockers = token_blockers;
                if !active || paused {
                    source_blockers.push(
                        CapitalImportRejectionReason::ReserveInactiveOrPaused
                            .code()
                            .to_owned(),
                    );
                }
                if !flash_loan_enabled {
                    source_blockers.push(
                        CapitalImportRejectionReason::FlashLoanDisabled
                            .code()
                            .to_owned(),
                    );
                }
                let source = AaveV3FlashObservation {
                    anchor: context.anchor.clone(),
                    pool: aave_pool,
                    asset: asset_address,
                    available_underlying: available,
                    premium_total_bps: aave_premium_total_bps,
                    flash_loan_enabled,
                    provider_locator_hash: protocol_contract_locator_hash(
                        AAVE_V3_PROVIDER_NAMESPACE,
                        aave_pool,
                    )?,
                    evidence: context.evidence.clone(),
                }
                .into_capital_source()?
                .with_execution_blockers(source_blockers)?;
                push_source(
                    &mut sources,
                    &mut outcomes,
                    protocol,
                    &market_id,
                    asset,
                    source,
                );
            }
            "UNISWAP_V2" => {
                let pair = Address::parse_hex(text(&row, "pair")?)
                    .map_err(|_| CapitalError::InvalidCanonical("invalid V2 pair"))?;
                let token0 = Address::parse_hex(text(&row, "token0")?)
                    .map_err(|_| CapitalError::InvalidCanonical("invalid V2 token0"))?;
                let token1 = Address::parse_hex(text(&row, "token1")?)
                    .map_err(|_| CapitalError::InvalidCanonical("invalid V2 token1"))?;
                if text(&row, "stage_state_reconstructable")? != "ADVANCE"
                    || !bool_field(&row, "factory_membership")?
                {
                    for token in [token0, token1] {
                        let asset = CapitalAsset::Token(token);
                        if !candidate_keys.insert((protocol.to_owned(), market_id.clone(), asset)) {
                            return Err(CapitalError::InvalidCanonical(
                                "duplicate D08 capital source candidate",
                            ));
                        }
                        push_rejection(
                            &mut rejections,
                            &mut outcomes,
                            protocol,
                            &market_id,
                            asset,
                            CapitalImportRejectionReason::StateNotReconstructable,
                        );
                    }
                    continue;
                }
                let fee = field(&row, "fee_semantics")?;
                if u64_field(fee, "swap_fee_bps")? != 30
                    || text(fee, "basis")?
                        != "EXPLICIT_CONFIGURATION_BOUND_TO_ADMITTED_PAIR_RUNTIME"
                {
                    for token in [token0, token1] {
                        let asset = CapitalAsset::Token(token);
                        if !candidate_keys.insert((protocol.to_owned(), market_id.clone(), asset)) {
                            return Err(CapitalError::InvalidCanonical(
                                "duplicate D08 capital source candidate",
                            ));
                        }
                        push_rejection(
                            &mut rejections,
                            &mut outcomes,
                            protocol,
                            &market_id,
                            asset,
                            CapitalImportRejectionReason::FeeSemanticsUnsupported,
                        );
                    }
                    continue;
                }
                let liquidity_state = text(&row, "liquidity_state")?;
                if !matches!(liquidity_state, "LIQUID" | "ZERO_LIQUIDITY_NOT_ROUTABLE") {
                    return Err(CapitalError::InvalidCanonical("unknown V2 liquidity state"));
                }
                let reserves = array(&row, "reserves")?;
                if reserves.len() != 3 {
                    return Err(CapitalError::InvalidCanonical(
                        "V2 reserve row is not three fields",
                    ));
                }
                let reserve0 = reserves[0]
                    .as_str()
                    .ok_or(CapitalError::InvalidCanonical(
                        "V2 reserve0 is not decimal text",
                    ))
                    .and_then(Amount256::parse_decimal)?;
                let reserve1 = reserves[1]
                    .as_str()
                    .ok_or(CapitalError::InvalidCanonical(
                        "V2 reserve1 is not decimal text",
                    ))
                    .and_then(Amount256::parse_decimal)?;
                let total_supply = Amount256::parse_decimal(text(&row, "total_supply")?)?;
                let derived_liquid =
                    !reserve0.is_zero() && !reserve1.is_zero() && !total_supply.is_zero();
                if (liquidity_state == "LIQUID") != derived_liquid {
                    return Err(CapitalError::InvalidCanonical(
                        "V2 liquidity state disagrees with reserves/total supply",
                    ));
                }

                for (token, reserve_amount) in [(token0, reserve0), (token1, reserve1)] {
                    let asset = CapitalAsset::Token(token);
                    if !candidate_keys.insert((protocol.to_owned(), market_id.clone(), asset)) {
                        return Err(CapitalError::InvalidCanonical(
                            "duplicate D08 capital source candidate",
                        ));
                    }
                    let mut source_blockers = execution_blockers(&tokens, token)?.to_vec();
                    if liquidity_state == "ZERO_LIQUIDITY_NOT_ROUTABLE" {
                        source_blockers.push(
                            CapitalImportRejectionReason::V2LiquidityUnavailable
                                .code()
                                .to_owned(),
                        );
                    }
                    let source = UniswapV2FlashSwapObservation {
                        anchor: context.anchor.clone(),
                        pair,
                        asset: token,
                        reserve: reserve_amount,
                        provider_locator_hash: protocol_contract_locator_hash(
                            UNISWAP_V2_PROVIDER_NAMESPACE,
                            pair,
                        )?,
                        evidence: context.evidence.clone(),
                    }
                    .into_capital_source()?
                    .with_execution_blockers(source_blockers)?;
                    push_source(
                        &mut sources,
                        &mut outcomes,
                        protocol,
                        &market_id,
                        asset,
                        source,
                    );
                }
            }
            _ => {
                return Err(CapitalError::InvalidCanonical(
                    "unsupported D08 protocol in capital import",
                ))
            }
        }
    }

    rejections.sort_by(|left, right| {
        (
            left.protocol.as_str(),
            left.market_id.as_str(),
            left.asset,
            left.reason,
        )
            .cmp(&(
                right.protocol.as_str(),
                right.market_id.as_str(),
                right.asset,
                right.reason,
            ))
    });
    sources.sort_by_key(CapitalSource::id);
    let candidate_count = candidate_keys.len();
    let admitted_count = sources.len();
    let rejected_count = rejections.len();
    if outcomes.len() != candidate_count || candidate_count != admitted_count + rejected_count {
        return Err(CapitalError::InvalidCanonical(
            "D08 capital source classification is not conserved",
        ));
    }
    let coverage_commitment = coverage_commitment(&mut outcomes)?;
    Ok(D08CapitalImport {
        candidate_count,
        admitted_count,
        rejected_count,
        coverage_commitment,
        sources,
        rejections,
        authority_artifact_sha256: None,
    })
}
