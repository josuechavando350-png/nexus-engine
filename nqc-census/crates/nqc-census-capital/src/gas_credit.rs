//! Strict admission for externally funded native-gas credit facilities.
//!
//! This module intentionally does not perform RPC calls. The acquisition workflow
//! must capture the same block-pinned facility state from two independent providers,
//! content-address both transcripts, and pass the reconciled observation here.
//! Capacity is recomputed from raw facility facts; a declared available number is
//! never trusted.

use crate::{
    adapters::ExternalGasCreditObservation, Amount256, CapitalError, CapitalEvidenceRef,
    CapitalSource, RoundingMode,
};
use nqc_census_chain::json::Json;
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};

pub const EXTERNAL_GAS_CREDIT_SCHEMA_VERSION: u64 = 1;
pub const EXTERNAL_GAS_CREDIT_PROVIDER_NAMESPACE: u16 = 0x2202;
pub const EXTERNAL_GAS_CREDIT_FAMILY: &str = "NQC_EXTERNAL_GAS_CREDIT_V1";
pub const EXTERNAL_GAS_CREDIT_STATUS: &str = "RMC_011_EXTERNAL_GAS_CREDIT_OBSERVED";

fn field<'a>(row: &'a Json, key: &'static str) -> Result<&'a Json, CapitalError> {
    row.get(key)
        .ok_or(CapitalError::InvalidCanonical("missing gas credit field"))
}

fn text_field<'a>(row: &'a Json, key: &'static str) -> Result<&'a str, CapitalError> {
    field(row, key)?
        .as_str()
        .ok_or(CapitalError::InvalidCanonical("gas credit field is not text"))
}

fn bool_field(row: &Json, key: &'static str) -> Result<bool, CapitalError> {
    field(row, key)?
        .as_bool()
        .ok_or(CapitalError::InvalidCanonical("gas credit field is not boolean"))
}

fn u64_field(row: &Json, key: &'static str) -> Result<u64, CapitalError> {
    field(row, key)?
        .as_i64()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(CapitalError::InvalidCanonical(
            "gas credit field is not a nonnegative integer",
        ))
}

fn array<'a>(row: &'a Json, key: &'static str) -> Result<&'a [Json], CapitalError> {
    field(row, key)?
        .as_array()
        .ok_or(CapitalError::InvalidCanonical("gas credit field is not array"))
}

fn hash32(row: &Json, key: &'static str) -> Result<Hash32, CapitalError> {
    Hash32::parse_hex(text_field(row, key)?)
        .map_err(|_| CapitalError::InvalidCanonical("invalid gas credit hash"))
}

fn address(row: &Json, key: &'static str) -> Result<Address, CapitalError> {
    Address::parse_hex(text_field(row, key)?)
        .map_err(|_| CapitalError::InvalidCanonical("invalid gas credit address"))
}

fn amount(row: &Json, key: &'static str) -> Result<Amount256, CapitalError> {
    amount_text(text_field(row, key)?)
}

fn amount_text(value: &str) -> Result<Amount256, CapitalError> {
    let raw = value
        .strip_prefix("0x")
        .ok_or(CapitalError::InvalidCanonical(
            "gas credit amount must use 0x-prefixed uint256 hex",
        ))?;
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CapitalError::InvalidCanonical(
            "gas credit amount must be 32-byte hex",
        ));
    }
    if raw.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(CapitalError::InvalidCanonical(
            "gas credit amount hex must be lowercase",
        ));
    }
    let mut bytes = [0_u8; 32];
    for (index, pair) in raw.as_bytes().chunks_exact(2).enumerate() {
        bytes[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Ok(Amount256::from_be_bytes(bytes))
}

fn optional_amount(row: &Json, key: &'static str) -> Result<Option<Amount256>, CapitalError> {
    match field(row, key)? {
        Json::Null => Ok(None),
        Json::String(value) => amount_text(value).map(Some),
        _ => Err(CapitalError::InvalidCanonical(
            "gas credit optional cap is not null or text",
        )),
    }
}

fn hex_nibble(byte: u8) -> Result<u8, CapitalError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(CapitalError::InvalidCanonical(
            "gas credit hex contains non-canonical digit",
        )),
    }
}

fn observation_anchor(row: &Json) -> Result<StateAnchor, CapitalError> {
    let chain = ChainDomain::new(
        u64_field(row, "chain_id")?,
        hash32(row, "genesis_hash")?,
        hash32(row, "fork_lineage")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid gas credit chain domain"))?;
    StateAnchor::new(
        chain,
        u64_field(row, "block_number")?,
        hash32(row, "block_hash")?,
        hash32(row, "parent_hash")?,
        u64_field(row, "timestamp")?,
        hash32(row, "state_root")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid gas credit observation anchor"))
}

fn write_optional_amount(hasher: &mut Sha256, value: Option<Amount256>) {
    match value {
        None => hasher.update([0]),
        Some(amount) => {
            hasher.update([1]);
            hasher.update(amount.as_be_bytes());
        }
    }
}

pub fn external_gas_credit_terms_commitment(
    borrower: Address,
    lender: Address,
    fee_bps: u16,
    repayment_deadline_blocks: u32,
    max_utilization_bps: u16,
    min_remaining: Amount256,
    protocol_cap: Option<Amount256>,
    market_cap: Option<Amount256>,
    active: bool,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-EXTERNAL-GAS-CREDIT-TERMS-V1");
    hasher.update([0]);
    hasher.update(borrower.as_bytes());
    hasher.update(lender.as_bytes());
    hasher.update(fee_bps.to_be_bytes());
    hasher.update(repayment_deadline_blocks.to_be_bytes());
    hasher.update(max_utilization_bps.to_be_bytes());
    hasher.update(min_remaining.as_be_bytes());
    write_optional_amount(&mut hasher, protocol_cap);
    write_optional_amount(&mut hasher, market_cap);
    hasher.update([u8::from(active)]);
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero gas credit terms commitment"))
}

pub fn external_gas_credit_facts_commitment(
    anchor: &StateAnchor,
    facility: Address,
    borrower: Address,
    lender: Address,
    runtime_sha256: Hash32,
    terms: Hash32,
    facility_balance: Amount256,
    credit_limit: Amount256,
    outstanding: Amount256,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-EXTERNAL-GAS-CREDIT-FACTS-V1");
    hasher.update([0]);
    hasher.update(anchor.chain().chain_id().to_be_bytes());
    hasher.update(anchor.chain().genesis_hash().as_bytes());
    hasher.update(anchor.chain().fork_lineage().as_bytes());
    hasher.update(anchor.block_number().to_be_bytes());
    hasher.update(anchor.block_hash().as_bytes());
    hasher.update(anchor.parent_hash().as_bytes());
    hasher.update(anchor.timestamp().to_be_bytes());
    hasher.update(anchor.state_root().as_bytes());
    hasher.update(facility.as_bytes());
    hasher.update(borrower.as_bytes());
    hasher.update(lender.as_bytes());
    hasher.update(runtime_sha256.as_bytes());
    hasher.update(terms.as_bytes());
    hasher.update(facility_balance.as_be_bytes());
    hasher.update(credit_limit.as_be_bytes());
    hasher.update(outstanding.as_be_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero gas credit facts commitment"))
}

fn locator_hash(
    facility: Address,
    borrower: Address,
    lender: Address,
    runtime_sha256: Hash32,
    terms: Hash32,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-EXTERNAL-GAS-CREDIT-LOCATOR-V1");
    hasher.update([0]);
    hasher.update(EXTERNAL_GAS_CREDIT_PROVIDER_NAMESPACE.to_be_bytes());
    hasher.update(facility.as_bytes());
    hasher.update(borrower.as_bytes());
    hasher.update(lender.as_bytes());
    hasher.update(runtime_sha256.as_bytes());
    hasher.update(terms.as_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero gas credit locator hash"))
}

fn provider_evidence(
    row: &Json,
    expected_facts: Hash32,
) -> Result<Vec<CapitalEvidenceRef>, CapitalError> {
    let providers = array(row, "provider_observations")?;
    if providers.len() != 2 {
        return Err(CapitalError::InvalidCanonical(
            "gas credit requires exactly two provider observations",
        ));
    }

    let mut previous: Option<&str> = None;
    let mut evidence = Vec::with_capacity(providers.len());
    for provider in providers {
        let provider_id = text_field(provider, "provider_id")?;
        if provider_id.is_empty() {
            return Err(CapitalError::InvalidCanonical(
                "gas credit provider id is empty",
            ));
        }
        if previous.is_some_and(|value| value >= provider_id) {
            return Err(CapitalError::InvalidCanonical(
                "gas credit provider ids must be strictly sorted",
            ));
        }
        previous = Some(provider_id);
        let facts = hash32(provider, "facts_commitment")?;
        if facts != expected_facts {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
        let digest = hash32(provider, "transcript_sha256")?;
        evidence.push(CapitalEvidenceRef::Observation(*digest.as_bytes()));
    }
    Ok(evidence)
}

/// Convert one reconciled, two-provider facility observation into a canonical D11 source.
///
/// The observation must bind exact contract runtime, borrower/lender identities and
/// terms at the same StateAnchor as D11. The maximum raw draw is recomputed as
/// min(facility_balance, credit_limit - outstanding).
pub fn import_external_gas_credit_observation(
    bytes: &[u8],
    expected_anchor: &StateAnchor,
) -> Result<CapitalSource, CapitalError> {
    let row = Json::parse(bytes)
        .map_err(|_| CapitalError::InvalidCanonical("gas credit observation JSON parse failed"))?;
    let canonical = row
        .canonical()
        .map_err(|_| CapitalError::InvalidCanonical("gas credit observation canonicalization failed"))?;
    if canonical.as_slice() != bytes {
        return Err(CapitalError::InvalidCanonical(
            "gas credit observation must be canonical JSON",
        ));
    }
    if u64_field(&row, "schema_version")? != EXTERNAL_GAS_CREDIT_SCHEMA_VERSION
        || text_field(&row, "status")? != EXTERNAL_GAS_CREDIT_STATUS
        || text_field(&row, "provider_family")? != EXTERNAL_GAS_CREDIT_FAMILY
        || text_field(&row, "capital_ownership")? != "EXTERNAL"
    {
        return Err(CapitalError::InvalidCanonical(
            "gas credit observation contract mismatch",
        ));
    }

    let anchor = observation_anchor(field(&row, "observation_anchor")?)?;
    if &anchor != expected_anchor {
        return Err(CapitalError::AnchorMismatch);
    }

    let facility = address(&row, "facility_contract")?;
    let borrower = address(&row, "borrower")?;
    let lender = address(&row, "lender")?;
    if borrower == lender || facility == borrower || facility == lender {
        return Err(CapitalError::InvalidCanonical(
            "gas credit facility identities must be distinct",
        ));
    }

    let runtime_sha256 = hash32(&row, "facility_runtime_sha256")?;
    let declared_terms = hash32(&row, "terms_commitment")?;
    let facility_balance = amount(&row, "facility_balance_native")?;
    let credit_limit = amount(&row, "credit_limit_native")?;
    let outstanding = amount(&row, "outstanding_native")?;
    if outstanding > credit_limit {
        return Err(CapitalError::InvalidCanonical(
            "gas credit outstanding exceeds credit limit",
        ));
    }
    let undrawn = credit_limit.checked_sub(outstanding)?;
    let maximum_native_gas = if facility_balance < undrawn {
        facility_balance
    } else {
        undrawn
    };

    let fee_bps_u64 = u64_field(&row, "fee_bps")?;
    let fee_bps = u16::try_from(fee_bps_u64)
        .map_err(|_| CapitalError::InvalidCanonical("gas credit fee_bps overflow"))?;
    if fee_bps > 10_000 {
        return Err(CapitalError::InvalidBasisPoints(fee_bps));
    }
    let deadline_u64 = u64_field(&row, "repayment_deadline_blocks")?;
    let repayment_deadline_blocks = u32::try_from(deadline_u64)
        .map_err(|_| CapitalError::InvalidCanonical("gas credit deadline overflow"))?;
    if repayment_deadline_blocks == 0 {
        return Err(CapitalError::ZeroValue("repayment_deadline_blocks"));
    }
    let utilization_u64 = u64_field(&row, "max_utilization_bps")?;
    let max_utilization_bps = u16::try_from(utilization_u64)
        .map_err(|_| CapitalError::InvalidCanonical("gas credit utilization overflow"))?;
    if max_utilization_bps > 10_000 {
        return Err(CapitalError::InvalidBasisPoints(max_utilization_bps));
    }
    let min_remaining = amount(&row, "min_remaining_native_gas")?;
    let protocol_cap = optional_amount(&row, "protocol_cap")?;
    let market_cap = optional_amount(&row, "market_cap")?;
    let active = bool_field(&row, "active")?;

    let recomputed_terms = external_gas_credit_terms_commitment(
        borrower,
        lender,
        fee_bps,
        repayment_deadline_blocks,
        max_utilization_bps,
        min_remaining,
        protocol_cap,
        market_cap,
        active,
    )?;
    if recomputed_terms != declared_terms {
        return Err(CapitalError::CanonicalDigestMismatch);
    }

    let facts_commitment = external_gas_credit_facts_commitment(
        &anchor,
        facility,
        borrower,
        lender,
        runtime_sha256,
        recomputed_terms,
        facility_balance,
        credit_limit,
        outstanding,
    )?;
    let evidence = provider_evidence(&row, facts_commitment)?;
    let provider_locator_hash =
        locator_hash(facility, borrower, lender, runtime_sha256, recomputed_terms)?;

    ExternalGasCreditObservation {
        anchor,
        provider_namespace: EXTERNAL_GAS_CREDIT_PROVIDER_NAMESPACE,
        provider_locator_hash,
        facility_contract: facility,
        maximum_native_gas,
        fee_model: crate::FeeModel::basis_points_with_rounding(
            fee_bps,
            RoundingMode::Ceil,
        )?,
        repayment_deadline_blocks,
        max_utilization_bps,
        min_remaining_native_gas: min_remaining,
        protocol_cap,
        market_cap,
        active,
        evidence,
    }
    .into_capital_source()
}
