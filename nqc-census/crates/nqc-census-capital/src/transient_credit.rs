//! Authenticated admission for transient external credit.
//!
//! A transient facility is external principal that can fund a candidate without
//! operator-owned capital and must be repaid either in the same block or within
//! an explicit bounded block deadline. This importer requires canonical JSON,
//! an exact D11 anchor, two independent provider transcripts and recomputed
//! terms/state commitments. It never treats a registry row as live evidence.

use crate::{
    Amount256, CapitalAsset, CapitalCaps, CapitalClass, CapitalError, CapitalEvidenceRef,
    CapitalFailureMode, CapitalOwnership, CapitalProviderKind, CapitalSource, CapitalSourceSpec,
    CollateralRequirement, FeeModel, RepaymentSemantics, RoundingMode, TemporaryLock,
    UtilizationConstraints,
};
use nqc_census_chain::json::Json;
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const TRANSIENT_CREDIT_SCHEMA_VERSION: u64 = 1;
pub const TRANSIENT_CREDIT_PROVIDER_NAMESPACE: u16 = 0x2204;
pub const TRANSIENT_CREDIT_FAMILY: &str = "NQC_TRANSIENT_EXTERNAL_CREDIT_V1";
pub const TRANSIENT_CREDIT_STATUS: &str = "RMC_011_TRANSIENT_EXTERNAL_CREDIT_OBSERVED";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransientCreditRepaymentMode {
    SameBlock,
    DeadlineBlocks(u32),
}

fn field<'a>(row: &'a Json, key: &'static str) -> Result<&'a Json, CapitalError> {
    row.get(key).ok_or(CapitalError::InvalidCanonical(
        "missing transient credit field",
    ))
}

fn text_field<'a>(row: &'a Json, key: &'static str) -> Result<&'a str, CapitalError> {
    field(row, key)?
        .as_str()
        .ok_or(CapitalError::InvalidCanonical(
            "transient credit field is not text",
        ))
}

fn bool_field(row: &Json, key: &'static str) -> Result<bool, CapitalError> {
    field(row, key)?
        .as_bool()
        .ok_or(CapitalError::InvalidCanonical(
            "transient credit field is not boolean",
        ))
}

fn u64_field(row: &Json, key: &'static str) -> Result<u64, CapitalError> {
    field(row, key)?
        .as_i64()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(CapitalError::InvalidCanonical(
            "transient credit field is not a nonnegative integer",
        ))
}

fn array<'a>(row: &'a Json, key: &'static str) -> Result<&'a [Json], CapitalError> {
    field(row, key)?
        .as_array()
        .ok_or(CapitalError::InvalidCanonical(
            "transient credit field is not array",
        ))
}

fn hash32(row: &Json, key: &'static str) -> Result<Hash32, CapitalError> {
    Hash32::parse_hex(text_field(row, key)?)
        .map_err(|_| CapitalError::InvalidCanonical("invalid transient credit hash"))
}

fn optional_address(row: &Json, key: &'static str) -> Result<Option<Address>, CapitalError> {
    match field(row, key)? {
        Json::Null => Ok(None),
        Json::String(value) => Address::parse_hex(value)
            .map(Some)
            .map_err(|_| CapitalError::InvalidCanonical("invalid transient credit address")),
        _ => Err(CapitalError::InvalidCanonical(
            "transient credit address is not null or text",
        )),
    }
}

fn parse_asset(value: &str) -> Result<CapitalAsset, CapitalError> {
    if value == "NATIVE_GAS" {
        return Ok(CapitalAsset::NativeGas);
    }
    let address = value
        .strip_prefix("TOKEN:")
        .ok_or(CapitalError::InvalidCanonical(
            "transient credit asset must be NATIVE_GAS or TOKEN:<address>",
        ))?;
    Address::parse_hex(address)
        .map(CapitalAsset::Token)
        .map_err(|_| CapitalError::InvalidCanonical("invalid transient credit token"))
}

fn amount(row: &Json, key: &'static str) -> Result<Amount256, CapitalError> {
    amount_text(text_field(row, key)?)
}

fn amount_text(value: &str) -> Result<Amount256, CapitalError> {
    let raw = value
        .strip_prefix("0x")
        .ok_or(CapitalError::InvalidCanonical(
            "transient credit amount must use 0x-prefixed uint256 hex",
        ))?;
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CapitalError::InvalidCanonical(
            "transient credit amount must be 32-byte hex",
        ));
    }
    if raw.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(CapitalError::InvalidCanonical(
            "transient credit amount hex must be lowercase",
        ));
    }
    let mut bytes = [0_u8; 32];
    for (index, pair) in raw.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        bytes[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Ok(Amount256::from_be_bytes(bytes))
}

fn optional_amount(row: &Json, key: &'static str) -> Result<Option<Amount256>, CapitalError> {
    match field(row, key)? {
        Json::Null => Ok(None),
        Json::String(value) => amount_text(value).map(Some),
        _ => Err(CapitalError::InvalidCanonical(
            "transient credit optional cap is not null or text",
        )),
    }
}

fn hex_nibble(byte: u8) -> Result<u8, CapitalError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(CapitalError::InvalidCanonical(
            "transient credit hex contains non-canonical digit",
        )),
    }
}

fn observation_anchor(row: &Json) -> Result<StateAnchor, CapitalError> {
    let chain = ChainDomain::new(
        u64_field(row, "chain_id")?,
        hash32(row, "genesis_hash")?,
        hash32(row, "fork_lineage")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid transient credit chain domain"))?;
    StateAnchor::new(
        chain,
        u64_field(row, "block_number")?,
        hash32(row, "block_hash")?,
        hash32(row, "parent_hash")?,
        u64_field(row, "timestamp")?,
        hash32(row, "state_root")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid transient credit observation anchor"))
}

fn repayment_mode(row: &Json) -> Result<TransientCreditRepaymentMode, CapitalError> {
    let deadline = u64_field(row, "repayment_deadline_blocks")?;
    match text_field(row, "repayment_mode")? {
        "SAME_BLOCK" => {
            if deadline != 0 {
                return Err(CapitalError::InvalidCanonical(
                    "same-block transient credit must declare zero deadline blocks",
                ));
            }
            Ok(TransientCreditRepaymentMode::SameBlock)
        }
        "DEADLINE_BLOCKS" => {
            let deadline = u32::try_from(deadline).map_err(|_| {
                CapitalError::InvalidCanonical("transient credit deadline overflow")
            })?;
            if deadline == 0 {
                return Err(CapitalError::ZeroValue("repayment_deadline_blocks"));
            }
            Ok(TransientCreditRepaymentMode::DeadlineBlocks(deadline))
        }
        _ => Err(CapitalError::InvalidCanonical(
            "unsupported transient credit repayment mode",
        )),
    }
}

fn encode_asset(hasher: &mut Sha256, asset: CapitalAsset) {
    match asset {
        CapitalAsset::NativeGas => hasher.update([1]),
        CapitalAsset::Token(address) => {
            hasher.update([2]);
            hasher.update(address.as_bytes());
        }
    }
}

fn encode_optional_address(hasher: &mut Sha256, address: Option<Address>) {
    match address {
        None => hasher.update([0]),
        Some(address) => {
            hasher.update([1]);
            hasher.update(address.as_bytes());
        }
    }
}

fn encode_optional_amount(hasher: &mut Sha256, value: Option<Amount256>) {
    match value {
        None => hasher.update([0]),
        Some(amount) => {
            hasher.update([1]);
            hasher.update(amount.as_be_bytes());
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn transient_credit_terms_commitment(
    provider_identity: Hash32,
    asset: CapitalAsset,
    fee_bps: u16,
    repayment: TransientCreditRepaymentMode,
    max_utilization_bps: u16,
    min_remaining: Amount256,
    protocol_cap: Option<Amount256>,
    market_cap: Option<Amount256>,
    active: bool,
) -> Result<Hash32, CapitalError> {
    if fee_bps > 10_000 {
        return Err(CapitalError::InvalidBasisPoints(fee_bps));
    }
    if max_utilization_bps > 10_000 {
        return Err(CapitalError::InvalidBasisPoints(max_utilization_bps));
    }
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-TRANSIENT-CREDIT-TERMS-V1");
    hasher.update([0]);
    hasher.update(provider_identity.as_bytes());
    encode_asset(&mut hasher, asset);
    hasher.update(fee_bps.to_be_bytes());
    match repayment {
        TransientCreditRepaymentMode::SameBlock => {
            hasher.update([1]);
            hasher.update(0_u32.to_be_bytes());
        }
        TransientCreditRepaymentMode::DeadlineBlocks(blocks) => {
            if blocks == 0 {
                return Err(CapitalError::ZeroValue("repayment_deadline_blocks"));
            }
            hasher.update([2]);
            hasher.update(blocks.to_be_bytes());
        }
    }
    hasher.update(max_utilization_bps.to_be_bytes());
    hasher.update(min_remaining.as_be_bytes());
    encode_optional_amount(&mut hasher, protocol_cap);
    encode_optional_amount(&mut hasher, market_cap);
    hasher.update([u8::from(active)]);
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero transient credit terms commitment"))
}

#[allow(clippy::too_many_arguments)]
pub fn transient_credit_facts_commitment(
    anchor: &StateAnchor,
    provider_identity: Hash32,
    facility_contract: Option<Address>,
    asset: CapitalAsset,
    terms: Hash32,
    facility_balance: Amount256,
    credit_limit: Amount256,
    outstanding: Amount256,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-TRANSIENT-CREDIT-FACTS-V1");
    hasher.update([0]);
    hasher.update(anchor.chain().chain_id().to_be_bytes());
    hasher.update(anchor.chain().genesis_hash().as_bytes());
    hasher.update(anchor.chain().fork_lineage().as_bytes());
    hasher.update(anchor.block_number().to_be_bytes());
    hasher.update(anchor.block_hash().as_bytes());
    hasher.update(anchor.parent_hash().as_bytes());
    hasher.update(anchor.timestamp().to_be_bytes());
    hasher.update(anchor.state_root().as_bytes());
    hasher.update(provider_identity.as_bytes());
    encode_optional_address(&mut hasher, facility_contract);
    encode_asset(&mut hasher, asset);
    hasher.update(terms.as_bytes());
    hasher.update(facility_balance.as_be_bytes());
    hasher.update(credit_limit.as_be_bytes());
    hasher.update(outstanding.as_be_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero transient credit facts commitment"))
}

fn locator_hash(
    provider_identity: Hash32,
    facility_contract: Option<Address>,
    asset: CapitalAsset,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-TRANSIENT-CREDIT-LOCATOR-V1");
    hasher.update([0]);
    hasher.update(TRANSIENT_CREDIT_PROVIDER_NAMESPACE.to_be_bytes());
    hasher.update(provider_identity.as_bytes());
    encode_optional_address(&mut hasher, facility_contract);
    encode_asset(&mut hasher, asset);
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero transient credit locator hash"))
}

fn provider_evidence(
    row: &Json,
    expected_facts: Hash32,
) -> Result<Vec<CapitalEvidenceRef>, CapitalError> {
    let providers = array(row, "provider_observations")?;
    if providers.len() != 2 {
        return Err(CapitalError::InvalidCanonical(
            "transient credit requires exactly two provider observations",
        ));
    }
    let mut previous: Option<&str> = None;
    let mut transcripts = BTreeSet::new();
    let mut evidence = Vec::with_capacity(3);
    evidence.push(CapitalEvidenceRef::Observation(*expected_facts.as_bytes()));
    for provider in providers {
        let id = text_field(provider, "provider_id")?;
        if id.is_empty() || previous.is_some_and(|value| value >= id) {
            return Err(CapitalError::InvalidCanonical(
                "transient credit provider ids must be non-empty and strictly sorted",
            ));
        }
        previous = Some(id);
        if hash32(provider, "facts_commitment")? != expected_facts {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
        let transcript = hash32(provider, "transcript_sha256")?;
        if !transcripts.insert(transcript) {
            return Err(CapitalError::InvalidCanonical(
                "transient credit provider transcript digests must be distinct",
            ));
        }
        evidence.push(CapitalEvidenceRef::Observation(*transcript.as_bytes()));
    }
    Ok(evidence)
}

pub fn import_transient_credit_observation(
    bytes: &[u8],
    expected_anchor: &StateAnchor,
) -> Result<CapitalSource, CapitalError> {
    let row = Json::parse(bytes)
        .map_err(|_| CapitalError::InvalidCanonical("transient credit JSON parse failed"))?;
    let canonical = row
        .canonical()
        .map_err(|_| CapitalError::InvalidCanonical("transient credit canonicalization failed"))?;
    if canonical.as_slice() != bytes {
        return Err(CapitalError::InvalidCanonical(
            "transient credit observation must be canonical JSON",
        ));
    }
    if u64_field(&row, "schema_version")? != TRANSIENT_CREDIT_SCHEMA_VERSION
        || text_field(&row, "status")? != TRANSIENT_CREDIT_STATUS
        || text_field(&row, "provider_family")? != TRANSIENT_CREDIT_FAMILY
        || text_field(&row, "capital_ownership")? != "EXTERNAL"
    {
        return Err(CapitalError::InvalidCanonical(
            "transient credit observation contract mismatch",
        ));
    }

    let anchor = observation_anchor(field(&row, "observation_anchor")?)?;
    if &anchor != expected_anchor {
        return Err(CapitalError::AnchorMismatch);
    }

    let provider_identity = hash32(&row, "provider_identity")?;
    let facility_contract = optional_address(&row, "facility_contract")?;
    let asset = parse_asset(text_field(&row, "asset")?)?;
    let facility_balance = amount(&row, "facility_balance")?;
    let credit_limit = amount(&row, "credit_limit")?;
    let outstanding = amount(&row, "outstanding")?;
    if outstanding > credit_limit {
        return Err(CapitalError::InvalidCanonical(
            "transient credit outstanding exceeds credit limit",
        ));
    }
    let maximum_available = facility_balance.min(credit_limit.checked_sub(outstanding)?);

    let fee_bps = u16::try_from(u64_field(&row, "fee_bps")?)
        .map_err(|_| CapitalError::InvalidCanonical("transient credit fee overflow"))?;
    let repayment = repayment_mode(&row)?;
    let max_utilization_bps = u16::try_from(u64_field(&row, "max_utilization_bps")?)
        .map_err(|_| CapitalError::InvalidCanonical("transient credit utilization overflow"))?;
    let min_remaining = amount(&row, "min_remaining")?;
    let protocol_cap = optional_amount(&row, "protocol_cap")?;
    let market_cap = optional_amount(&row, "market_cap")?;
    let active = bool_field(&row, "active")?;

    let declared_terms = hash32(&row, "terms_commitment")?;
    let terms = transient_credit_terms_commitment(
        provider_identity,
        asset,
        fee_bps,
        repayment,
        max_utilization_bps,
        min_remaining,
        protocol_cap,
        market_cap,
        active,
    )?;
    if terms != declared_terms {
        return Err(CapitalError::CanonicalDigestMismatch);
    }
    let facts = transient_credit_facts_commitment(
        &anchor,
        provider_identity,
        facility_contract,
        asset,
        terms,
        facility_balance,
        credit_limit,
        outstanding,
    )?;
    let evidence = provider_evidence(&row, facts)?;
    let provider_locator_hash = locator_hash(provider_identity, facility_contract, asset)?;

    let repayment = match repayment {
        TransientCreditRepaymentMode::SameBlock => RepaymentSemantics::SameBlock,
        TransientCreditRepaymentMode::DeadlineBlocks(blocks) => {
            RepaymentSemantics::DeadlineBlocks(blocks)
        }
    };
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::TransientCredit,
        anchor,
        provider_namespace: TRANSIENT_CREDIT_PROVIDER_NAMESPACE,
        provider_locator_hash,
        provider_kind: CapitalProviderKind::ExternalCreditFacility,
        ownership: CapitalOwnership::External,
        source_contract: facility_contract,
        asset,
        maximum_available,
        fee_model: FeeModel::basis_points_with_rounding(fee_bps, RoundingMode::Ceil)?,
        repayment_asset: asset,
        repayment,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(max_utilization_bps, min_remaining)?,
        caps: CapitalCaps {
            protocol_cap,
            market_cap,
        },
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::SourceUnavailable,
            CapitalFailureMode::CapacityChanged,
            CapitalFailureMode::FeeChanged,
            CapitalFailureMode::ProtocolCapReached,
            CapitalFailureMode::MarketCapReached,
            CapitalFailureMode::RepaymentFailure,
            CapitalFailureMode::FacilityDisappearance,
        ],
        evidence,
    })?;

    if active {
        Ok(source)
    } else {
        source.with_execution_blockers(vec!["TRANSIENT_CREDIT_FACILITY_INACTIVE".to_owned()])
    }
}
