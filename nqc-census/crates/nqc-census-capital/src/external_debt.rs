//! Authenticated admission for collateralized and persistent external debt.
//!
//! This module models long-lived external principal separately from atomic or
//! transient funding. Every admitted observation is bound to an exact D11
//! StateAnchor, explicit collateral, persistent risk-model commitments and two
//! independent provider transcripts. The importer does not discover providers
//! and does not treat registry membership as live availability evidence.

use crate::{
    Amount256, CapitalAsset, CapitalCaps, CapitalClass, CapitalError, CapitalEvidenceRef,
    CapitalFailureMode, CapitalOwnership, CapitalProviderKind, CapitalSource, CapitalSourceSpec,
    CollateralRequirement, FeeModel, PersistentDebtTerms, RepaymentSemantics, RoundingMode,
    TemporaryLock, UtilizationConstraints,
};
use nqc_census_chain::json::Json;
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const EXTERNAL_DEBT_SCHEMA_VERSION: u64 = 1;
pub const COLLATERALIZED_BORROWING_PROVIDER_NAMESPACE: u16 = 0x2205;
pub const PERSISTENT_DEBT_PROVIDER_NAMESPACE: u16 = 0x2206;
pub const EXTERNAL_DEBT_FAMILY: &str = "NQC_EXTERNAL_DEBT_V1";
pub const EXTERNAL_DEBT_STATUS: &str = "RMC_011_EXTERNAL_DEBT_OBSERVED";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalDebtKind {
    CollateralizedBorrowing,
    PersistentDebt,
}

impl ExternalDebtKind {
    fn parse(value: &str) -> Result<Self, CapitalError> {
        match value {
            "COLLATERALIZED_BORROWING" => Ok(Self::CollateralizedBorrowing),
            "PERSISTENT_DEBT" => Ok(Self::PersistentDebt),
            _ => Err(CapitalError::InvalidCanonical(
                "unsupported external debt kind",
            )),
        }
    }

    const fn capital_class(self) -> CapitalClass {
        match self {
            Self::CollateralizedBorrowing => CapitalClass::CollateralizedBorrowing,
            Self::PersistentDebt => CapitalClass::PersistentDebt,
        }
    }

    const fn provider_namespace(self) -> u16 {
        match self {
            Self::CollateralizedBorrowing => COLLATERALIZED_BORROWING_PROVIDER_NAMESPACE,
            Self::PersistentDebt => PERSISTENT_DEBT_PROVIDER_NAMESPACE,
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::CollateralizedBorrowing => 1,
            Self::PersistentDebt => 2,
        }
    }

    const fn inactive_blocker(self) -> &'static str {
        match self {
            Self::CollateralizedBorrowing => "COLLATERALIZED_BORROWING_FACILITY_INACTIVE",
            Self::PersistentDebt => "PERSISTENT_DEBT_FACILITY_INACTIVE",
        }
    }
}

fn field<'a>(row: &'a Json, key: &'static str) -> Result<&'a Json, CapitalError> {
    row.get(key)
        .ok_or(CapitalError::InvalidCanonical("missing external debt field"))
}

fn text_field<'a>(row: &'a Json, key: &'static str) -> Result<&'a str, CapitalError> {
    field(row, key)?
        .as_str()
        .ok_or(CapitalError::InvalidCanonical(
            "external debt field is not text",
        ))
}

fn bool_field(row: &Json, key: &'static str) -> Result<bool, CapitalError> {
    field(row, key)?
        .as_bool()
        .ok_or(CapitalError::InvalidCanonical(
            "external debt field is not boolean",
        ))
}

fn u64_field(row: &Json, key: &'static str) -> Result<u64, CapitalError> {
    field(row, key)?
        .as_i64()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(CapitalError::InvalidCanonical(
            "external debt field is not a nonnegative integer",
        ))
}

fn array<'a>(row: &'a Json, key: &'static str) -> Result<&'a [Json], CapitalError> {
    field(row, key)?
        .as_array()
        .ok_or(CapitalError::InvalidCanonical(
            "external debt field is not array",
        ))
}

fn hash32(row: &Json, key: &'static str) -> Result<Hash32, CapitalError> {
    Hash32::parse_hex(text_field(row, key)?)
        .map_err(|_| CapitalError::InvalidCanonical("invalid external debt hash"))
}

fn optional_address(row: &Json, key: &'static str) -> Result<Option<Address>, CapitalError> {
    match field(row, key)? {
        Json::Null => Ok(None),
        Json::String(value) => Address::parse_hex(value)
            .map(Some)
            .map_err(|_| CapitalError::InvalidCanonical("invalid external debt address")),
        _ => Err(CapitalError::InvalidCanonical(
            "external debt address is not null or text",
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
            "external debt asset must be NATIVE_GAS or TOKEN:<address>",
        ))?;
    Address::parse_hex(address)
        .map(CapitalAsset::Token)
        .map_err(|_| CapitalError::InvalidCanonical("invalid external debt token"))
}

fn amount(row: &Json, key: &'static str) -> Result<Amount256, CapitalError> {
    amount_text(text_field(row, key)?)
}

fn amount_text(value: &str) -> Result<Amount256, CapitalError> {
    let raw = value
        .strip_prefix("0x")
        .ok_or(CapitalError::InvalidCanonical(
            "external debt amount must use 0x-prefixed uint256 hex",
        ))?;
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CapitalError::InvalidCanonical(
            "external debt amount must be 32-byte hex",
        ));
    }
    if raw.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(CapitalError::InvalidCanonical(
            "external debt amount hex must be lowercase",
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
            "external debt optional cap is not null or text",
        )),
    }
}

fn hex_nibble(byte: u8) -> Result<u8, CapitalError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(CapitalError::InvalidCanonical(
            "external debt hex contains non-canonical digit",
        )),
    }
}

fn observation_anchor(row: &Json) -> Result<StateAnchor, CapitalError> {
    let chain = ChainDomain::new(
        u64_field(row, "chain_id")?,
        hash32(row, "genesis_hash")?,
        hash32(row, "fork_lineage")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid external debt chain domain"))?;
    StateAnchor::new(
        chain,
        u64_field(row, "block_number")?,
        hash32(row, "block_hash")?,
        hash32(row, "parent_hash")?,
        u64_field(row, "timestamp")?,
        hash32(row, "state_root")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid external debt observation anchor"))
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

fn persistent_terms(row: &Json) -> Result<PersistentDebtTerms, CapitalError> {
    Ok(PersistentDebtTerms {
        interest_model_hash: hash32(row, "interest_model_hash")?,
        liquidation_model_hash: hash32(row, "liquidation_model_hash")?,
        solvency_model_hash: hash32(row, "solvency_model_hash")?,
        oracle_risk_hash: hash32(row, "oracle_risk_hash")?,
        liquidity_withdrawal_risk_hash: hash32(row, "liquidity_withdrawal_risk_hash")?,
        facility_disappearance_risk_hash: hash32(row, "facility_disappearance_risk_hash")?,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn external_debt_terms_commitment(
    kind: ExternalDebtKind,
    provider_identity: Hash32,
    principal_asset: CapitalAsset,
    collateral_asset: CapitalAsset,
    collateral_amount: Amount256,
    liquidation_conditions_hash: Hash32,
    fee_bps: u16,
    max_utilization_bps: u16,
    min_remaining: Amount256,
    protocol_cap: Option<Amount256>,
    market_cap: Option<Amount256>,
    risk: PersistentDebtTerms,
    active: bool,
) -> Result<Hash32, CapitalError> {
    if collateral_amount.is_zero() {
        return Err(CapitalError::ZeroValue("collateral_amount"));
    }
    if fee_bps > 10_000 {
        return Err(CapitalError::InvalidBasisPoints(fee_bps));
    }
    if max_utilization_bps > 10_000 {
        return Err(CapitalError::InvalidBasisPoints(max_utilization_bps));
    }

    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-EXTERNAL-DEBT-TERMS-V1");
    hasher.update([0]);
    hasher.update([kind.tag()]);
    hasher.update(provider_identity.as_bytes());
    encode_asset(&mut hasher, principal_asset);
    encode_asset(&mut hasher, collateral_asset);
    hasher.update(collateral_amount.as_be_bytes());
    hasher.update(liquidation_conditions_hash.as_bytes());
    hasher.update(fee_bps.to_be_bytes());
    hasher.update(max_utilization_bps.to_be_bytes());
    hasher.update(min_remaining.as_be_bytes());
    encode_optional_amount(&mut hasher, protocol_cap);
    encode_optional_amount(&mut hasher, market_cap);
    for hash in [
        risk.interest_model_hash,
        risk.liquidation_model_hash,
        risk.solvency_model_hash,
        risk.oracle_risk_hash,
        risk.liquidity_withdrawal_risk_hash,
        risk.facility_disappearance_risk_hash,
    ] {
        hasher.update(hash.as_bytes());
    }
    hasher.update([u8::from(active)]);
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero external debt terms commitment"))
}

#[allow(clippy::too_many_arguments)]
pub fn external_debt_facts_commitment(
    anchor: &StateAnchor,
    kind: ExternalDebtKind,
    provider_identity: Hash32,
    facility_contract: Option<Address>,
    principal_asset: CapitalAsset,
    terms: Hash32,
    facility_balance: Amount256,
    credit_limit: Amount256,
    outstanding: Amount256,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-EXTERNAL-DEBT-FACTS-V1");
    hasher.update([0]);
    hasher.update(anchor.chain().chain_id().to_be_bytes());
    hasher.update(anchor.chain().genesis_hash().as_bytes());
    hasher.update(anchor.chain().fork_lineage().as_bytes());
    hasher.update(anchor.block_number().to_be_bytes());
    hasher.update(anchor.block_hash().as_bytes());
    hasher.update(anchor.parent_hash().as_bytes());
    hasher.update(anchor.timestamp().to_be_bytes());
    hasher.update(anchor.state_root().as_bytes());
    hasher.update([kind.tag()]);
    hasher.update(provider_identity.as_bytes());
    encode_optional_address(&mut hasher, facility_contract);
    encode_asset(&mut hasher, principal_asset);
    hasher.update(terms.as_bytes());
    hasher.update(facility_balance.as_be_bytes());
    hasher.update(credit_limit.as_be_bytes());
    hasher.update(outstanding.as_be_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero external debt facts commitment"))
}

fn locator_hash(
    kind: ExternalDebtKind,
    provider_identity: Hash32,
    facility_contract: Option<Address>,
    principal_asset: CapitalAsset,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-EXTERNAL-DEBT-LOCATOR-V1");
    hasher.update([0]);
    hasher.update(kind.provider_namespace().to_be_bytes());
    hasher.update(provider_identity.as_bytes());
    encode_optional_address(&mut hasher, facility_contract);
    encode_asset(&mut hasher, principal_asset);
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero external debt locator hash"))
}

fn provider_evidence(
    row: &Json,
    expected_facts: Hash32,
) -> Result<Vec<CapitalEvidenceRef>, CapitalError> {
    let providers = array(row, "provider_observations")?;
    if providers.len() != 2 {
        return Err(CapitalError::InvalidCanonical(
            "external debt requires exactly two provider observations",
        ));
    }

    let mut previous: Option<&str> = None;
    let mut transcripts = BTreeSet::new();
    let mut evidence = Vec::with_capacity(3);
    evidence.push(CapitalEvidenceRef::Observation(*expected_facts.as_bytes()));

    for provider in providers {
        let provider_id = text_field(provider, "provider_id")?;
        if provider_id.is_empty() || previous.is_some_and(|value| value >= provider_id) {
            return Err(CapitalError::InvalidCanonical(
                "external debt provider ids must be non-empty and strictly sorted",
            ));
        }
        previous = Some(provider_id);
        if hash32(provider, "facts_commitment")? != expected_facts {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
        let transcript = hash32(provider, "transcript_sha256")?;
        if !transcripts.insert(transcript) {
            return Err(CapitalError::InvalidCanonical(
                "external debt provider transcript digests must be distinct",
            ));
        }
        evidence.push(CapitalEvidenceRef::Observation(*transcript.as_bytes()));
    }

    Ok(evidence)
}

pub fn import_external_debt_observation(
    bytes: &[u8],
    expected_anchor: &StateAnchor,
) -> Result<CapitalSource, CapitalError> {
    let row = Json::parse(bytes)
        .map_err(|_| CapitalError::InvalidCanonical("external debt JSON parse failed"))?;
    let canonical = row.canonical().map_err(|_| {
        CapitalError::InvalidCanonical("external debt canonicalization failed")
    })?;
    if canonical.as_slice() != bytes {
        return Err(CapitalError::InvalidCanonical(
            "external debt observation must be canonical JSON",
        ));
    }

    if u64_field(&row, "schema_version")? != EXTERNAL_DEBT_SCHEMA_VERSION
        || text_field(&row, "status")? != EXTERNAL_DEBT_STATUS
        || text_field(&row, "provider_family")? != EXTERNAL_DEBT_FAMILY
        || text_field(&row, "capital_ownership")? != "EXTERNAL"
    {
        return Err(CapitalError::InvalidCanonical(
            "external debt observation contract mismatch",
        ));
    }

    let anchor = observation_anchor(field(&row, "observation_anchor")?)?;
    if &anchor != expected_anchor {
        return Err(CapitalError::AnchorMismatch);
    }

    let kind = ExternalDebtKind::parse(text_field(&row, "debt_kind")?)?;
    let provider_identity = hash32(&row, "provider_identity")?;
    let facility_contract = optional_address(&row, "facility_contract")?;
    let principal_asset = parse_asset(text_field(&row, "principal_asset")?)?;
    let collateral_asset = parse_asset(text_field(&row, "collateral_asset")?)?;
    let collateral_amount = amount(&row, "collateral_amount")?;
    if collateral_amount.is_zero() {
        return Err(CapitalError::ZeroValue("collateral_amount"));
    }
    let liquidation_conditions_hash = hash32(&row, "liquidation_conditions_hash")?;

    let facility_balance = amount(&row, "facility_balance")?;
    let credit_limit = amount(&row, "credit_limit")?;
    let outstanding = amount(&row, "outstanding")?;
    if outstanding > credit_limit {
        return Err(CapitalError::InvalidCanonical(
            "external debt outstanding exceeds credit limit",
        ));
    }
    let maximum_available = facility_balance.min(credit_limit.checked_sub(outstanding)?);

    let fee_bps = u16::try_from(u64_field(&row, "fee_bps")?)
        .map_err(|_| CapitalError::InvalidCanonical("external debt fee overflow"))?;
    let max_utilization_bps = u16::try_from(u64_field(&row, "max_utilization_bps")?)
        .map_err(|_| CapitalError::InvalidCanonical("external debt utilization overflow"))?;
    let min_remaining = amount(&row, "min_remaining")?;
    let protocol_cap = optional_amount(&row, "protocol_cap")?;
    let market_cap = optional_amount(&row, "market_cap")?;
    let active = bool_field(&row, "active")?;
    let risk = persistent_terms(&row)?;

    let declared_terms = hash32(&row, "terms_commitment")?;
    let terms = external_debt_terms_commitment(
        kind,
        provider_identity,
        principal_asset,
        collateral_asset,
        collateral_amount,
        liquidation_conditions_hash,
        fee_bps,
        max_utilization_bps,
        min_remaining,
        protocol_cap,
        market_cap,
        risk,
        active,
    )?;
    if terms != declared_terms {
        return Err(CapitalError::CanonicalDigestMismatch);
    }

    let facts = external_debt_facts_commitment(
        &anchor,
        kind,
        provider_identity,
        facility_contract,
        principal_asset,
        terms,
        facility_balance,
        credit_limit,
        outstanding,
    )?;
    let evidence = provider_evidence(&row, facts)?;
    let provider_locator_hash =
        locator_hash(kind, provider_identity, facility_contract, principal_asset)?;

    let source = CapitalSource::new(CapitalSourceSpec {
        class: kind.capital_class(),
        anchor,
        provider_namespace: kind.provider_namespace(),
        provider_locator_hash,
        provider_kind: CapitalProviderKind::ExternalCreditFacility,
        ownership: CapitalOwnership::External,
        source_contract: facility_contract,
        asset: principal_asset,
        maximum_available,
        fee_model: FeeModel::basis_points_with_rounding(fee_bps, RoundingMode::Ceil)?,
        repayment_asset: principal_asset,
        repayment: RepaymentSemantics::Persistent(risk),
        collateral: CollateralRequirement::Required {
            asset: collateral_asset,
            amount: collateral_amount,
            liquidation_conditions_hash,
        },
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
            CapitalFailureMode::CollateralLiquidation,
            CapitalFailureMode::OracleRisk,
            CapitalFailureMode::LiquidityWithdrawal,
            CapitalFailureMode::FacilityDisappearance,
        ],
        evidence,
    })?;

    if active {
        Ok(source)
    } else {
        source.with_execution_blockers(vec![kind.inactive_blocker().to_owned()])
    }
}
