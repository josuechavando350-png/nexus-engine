//! Strict admission for externally funded native-gas sponsorship.
//!
//! This module does not discover sponsors or contact providers. Acquisition must
//! produce one canonical reconciled observation backed by exactly two independent
//! provider transcripts. The importer recomputes the semantic commitments and
//! preserves inactive sponsorship as observed-but-non-executable capital.

use crate::{
    adapters::ExternalGasSponsorObservation, Amount256, CapitalAsset, CapitalError,
    CapitalEvidenceRef, CapitalSource, FeeModel,
};
use nqc_census_chain::json::Json;
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const EXTERNAL_GAS_SPONSOR_SCHEMA_VERSION: u64 = 1;
pub const EXTERNAL_GAS_SPONSOR_PROVIDER_NAMESPACE: u16 = 0x2203;
pub const EXTERNAL_GAS_SPONSOR_FAMILY: &str = "NQC_EXTERNAL_GAS_SPONSOR_V1";
pub const EXTERNAL_GAS_SPONSOR_STATUS: &str = "RMC_011_EXTERNAL_GAS_SPONSOR_OBSERVED";
pub const EXTERNAL_GAS_SPONSOR_DELIVERY_SEMANTICS: &str =
    "PRE_EXECUTION_NATIVE_GAS_TO_BORROWER_NO_OPERATOR_PREFUND_V1";

fn field<'a>(row: &'a Json, key: &'static str) -> Result<&'a Json, CapitalError> {
    row.get(key)
        .ok_or(CapitalError::InvalidCanonical("missing gas sponsor field"))
}

fn text_field<'a>(row: &'a Json, key: &'static str) -> Result<&'a str, CapitalError> {
    field(row, key)?
        .as_str()
        .ok_or(CapitalError::InvalidCanonical(
            "gas sponsor field is not text",
        ))
}

fn bool_field(row: &Json, key: &'static str) -> Result<bool, CapitalError> {
    field(row, key)?
        .as_bool()
        .ok_or(CapitalError::InvalidCanonical(
            "gas sponsor field is not boolean",
        ))
}

fn u64_field(row: &Json, key: &'static str) -> Result<u64, CapitalError> {
    field(row, key)?
        .as_i64()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(CapitalError::InvalidCanonical(
            "gas sponsor field is not a nonnegative integer",
        ))
}

fn array<'a>(row: &'a Json, key: &'static str) -> Result<&'a [Json], CapitalError> {
    field(row, key)?
        .as_array()
        .ok_or(CapitalError::InvalidCanonical(
            "gas sponsor field is not array",
        ))
}

fn hash32(row: &Json, key: &'static str) -> Result<Hash32, CapitalError> {
    Hash32::parse_hex(text_field(row, key)?)
        .map_err(|_| CapitalError::InvalidCanonical("invalid gas sponsor hash"))
}

fn optional_address(row: &Json, key: &'static str) -> Result<Option<Address>, CapitalError> {
    match field(row, key)? {
        Json::Null => Ok(None),
        Json::String(value) => Address::parse_hex(value)
            .map(Some)
            .map_err(|_| CapitalError::InvalidCanonical("invalid gas sponsor address")),
        _ => Err(CapitalError::InvalidCanonical(
            "gas sponsor address is not null or text",
        )),
    }
}

fn amount(row: &Json, key: &'static str) -> Result<Amount256, CapitalError> {
    amount_text(text_field(row, key)?)
}

fn amount_text(value: &str) -> Result<Amount256, CapitalError> {
    let raw = value
        .strip_prefix("0x")
        .ok_or(CapitalError::InvalidCanonical(
            "gas sponsor amount must use 0x-prefixed uint256 hex",
        ))?;
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CapitalError::InvalidCanonical(
            "gas sponsor amount must be 32-byte hex",
        ));
    }
    if raw.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(CapitalError::InvalidCanonical(
            "gas sponsor amount hex must be lowercase",
        ));
    }
    let mut bytes = [0_u8; 32];
    for (index, pair) in raw.as_bytes().chunks_exact(2).enumerate() {
        bytes[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Ok(Amount256::from_be_bytes(bytes))
}

fn hex_nibble(byte: u8) -> Result<u8, CapitalError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(CapitalError::InvalidCanonical(
            "gas sponsor hex contains non-canonical digit",
        )),
    }
}

fn observation_anchor(row: &Json) -> Result<StateAnchor, CapitalError> {
    let chain = ChainDomain::new(
        u64_field(row, "chain_id")?,
        hash32(row, "genesis_hash")?,
        hash32(row, "fork_lineage")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid gas sponsor chain domain"))?;
    StateAnchor::new(
        chain,
        u64_field(row, "block_number")?,
        hash32(row, "block_hash")?,
        hash32(row, "parent_hash")?,
        u64_field(row, "timestamp")?,
        hash32(row, "state_root")?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid gas sponsor observation anchor"))
}

fn parse_fee_asset(value: &str) -> Result<CapitalAsset, CapitalError> {
    if value == "NATIVE_GAS" {
        return Ok(CapitalAsset::NativeGas);
    }
    let address = value
        .strip_prefix("TOKEN:")
        .ok_or(CapitalError::InvalidCanonical(
            "gas sponsor fee asset must be NATIVE_GAS or TOKEN:<address>",
        ))?;
    Address::parse_hex(address)
        .map(CapitalAsset::Token)
        .map_err(|_| CapitalError::InvalidCanonical("invalid gas sponsor fee token"))
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

fn parse_fee(row: &Json) -> Result<(FeeModel, CapitalAsset), CapitalError> {
    let kind = text_field(row, "fee_kind")?;
    let fee_asset = parse_fee_asset(text_field(row, "fee_asset")?)?;
    let fee_amount = amount(row, "fee_amount")?;
    match kind {
        "NONE" => {
            if fee_asset != CapitalAsset::NativeGas || !fee_amount.is_zero() {
                return Err(CapitalError::InvalidCanonical(
                    "gas sponsor NONE fee must use NATIVE_GAS and zero amount",
                ));
            }
            Ok((FeeModel::None, fee_asset))
        }
        "FIXED" => {
            if fee_amount.is_zero() {
                return Err(CapitalError::ZeroValue("gas_sponsor_fixed_fee"));
            }
            Ok((
                FeeModel::Fixed {
                    asset: fee_asset,
                    amount: fee_amount,
                },
                fee_asset,
            ))
        }
        _ => Err(CapitalError::InvalidCanonical(
            "unsupported gas sponsor fee kind",
        )),
    }
}

pub fn external_gas_sponsor_terms_commitment(
    sponsor_identity: Hash32,
    fee_model: FeeModel,
    fee_asset: CapitalAsset,
    delivery_route_commitment: Hash32,
    operator_prefund_required: bool,
) -> Result<Hash32, CapitalError> {
    if operator_prefund_required {
        return Err(CapitalError::InvalidCanonical(
            "gas sponsor delivery requires operator prefunding",
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-EXTERNAL-GAS-SPONSOR-TERMS-V1");
    hasher.update([0]);
    hasher.update(sponsor_identity.as_bytes());
    match fee_model {
        FeeModel::None => {
            if fee_asset != CapitalAsset::NativeGas {
                return Err(CapitalError::InvalidCanonical(
                    "gas sponsor NONE fee asset must be native gas",
                ));
            }
            hasher.update([1]);
            encode_asset(&mut hasher, fee_asset);
            hasher.update(Amount256::ZERO.as_be_bytes());
        }
        FeeModel::Fixed { asset, amount } => {
            if asset != fee_asset || amount.is_zero() {
                return Err(CapitalError::InvalidCanonical(
                    "gas sponsor fixed fee metadata is inconsistent",
                ));
            }
            hasher.update([2]);
            encode_asset(&mut hasher, asset);
            hasher.update(amount.as_be_bytes());
        }
        _ => {
            return Err(CapitalError::InvalidCanonical(
                "gas sponsor supports only NONE or FIXED fees",
            ))
        }
    }
    hasher.update(EXTERNAL_GAS_SPONSOR_DELIVERY_SEMANTICS.as_bytes());
    hasher.update(delivery_route_commitment.as_bytes());
    hasher.update([u8::from(operator_prefund_required)]);
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero gas sponsor terms commitment"))
}

pub fn external_gas_sponsor_facts_commitment(
    anchor: &StateAnchor,
    sponsor_identity: Hash32,
    sponsor_contract: Option<Address>,
    terms: Hash32,
    maximum_native_gas: Amount256,
    active: bool,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-EXTERNAL-GAS-SPONSOR-FACTS-V1");
    hasher.update([0]);
    hasher.update(anchor.chain().chain_id().to_be_bytes());
    hasher.update(anchor.chain().genesis_hash().as_bytes());
    hasher.update(anchor.chain().fork_lineage().as_bytes());
    hasher.update(anchor.block_number().to_be_bytes());
    hasher.update(anchor.block_hash().as_bytes());
    hasher.update(anchor.parent_hash().as_bytes());
    hasher.update(anchor.timestamp().to_be_bytes());
    hasher.update(anchor.state_root().as_bytes());
    hasher.update(sponsor_identity.as_bytes());
    encode_optional_address(&mut hasher, sponsor_contract);
    hasher.update(terms.as_bytes());
    hasher.update(maximum_native_gas.as_be_bytes());
    hasher.update([u8::from(active)]);
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero gas sponsor facts commitment"))
}

fn locator_hash(
    sponsor_identity: Hash32,
    sponsor_contract: Option<Address>,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-EXTERNAL-GAS-SPONSOR-LOCATOR-V1");
    hasher.update([0]);
    hasher.update(EXTERNAL_GAS_SPONSOR_PROVIDER_NAMESPACE.to_be_bytes());
    hasher.update(sponsor_identity.as_bytes());
    encode_optional_address(&mut hasher, sponsor_contract);
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest).map_err(|_| CapitalError::InvalidCanonical("zero gas sponsor locator hash"))
}

fn provider_evidence(
    row: &Json,
    expected_facts: Hash32,
) -> Result<Vec<CapitalEvidenceRef>, CapitalError> {
    let providers = array(row, "provider_observations")?;
    if providers.len() != 2 {
        return Err(CapitalError::InvalidCanonical(
            "gas sponsor requires exactly two provider observations",
        ));
    }

    let mut previous: Option<&str> = None;
    let mut transcript_digests = BTreeSet::new();
    let mut evidence = Vec::with_capacity(providers.len() + 1);
    evidence.push(CapitalEvidenceRef::Observation(*expected_facts.as_bytes()));
    for provider in providers {
        let provider_id = text_field(provider, "provider_id")?;
        if provider_id.is_empty() {
            return Err(CapitalError::InvalidCanonical(
                "gas sponsor provider id is empty",
            ));
        }
        if previous.is_some_and(|value| value >= provider_id) {
            return Err(CapitalError::InvalidCanonical(
                "gas sponsor provider ids must be strictly sorted",
            ));
        }
        previous = Some(provider_id);
        if hash32(provider, "facts_commitment")? != expected_facts {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
        let digest = hash32(provider, "transcript_sha256")?;
        if !transcript_digests.insert(digest) {
            return Err(CapitalError::InvalidCanonical(
                "gas sponsor provider transcript digests must be distinct",
            ));
        }
        evidence.push(CapitalEvidenceRef::Observation(*digest.as_bytes()));
    }
    Ok(evidence)
}

/// Import one reconciled external sponsor observation into canonical D11 capital.
///
/// The sponsor must be able to deliver native gas before execution without
/// operator prefunding. Two independent provider transcripts must agree on the
/// exact semantic facts. Inactive sponsors remain in the census but are blocked
/// from executable capacity.
pub fn import_external_gas_sponsor_observation(
    bytes: &[u8],
    expected_anchor: &StateAnchor,
) -> Result<CapitalSource, CapitalError> {
    let row = Json::parse(bytes)
        .map_err(|_| CapitalError::InvalidCanonical("gas sponsor observation JSON parse failed"))?;
    let canonical = row.canonical().map_err(|_| {
        CapitalError::InvalidCanonical("gas sponsor observation canonicalization failed")
    })?;
    if canonical.as_slice() != bytes {
        return Err(CapitalError::InvalidCanonical(
            "gas sponsor observation must be canonical JSON",
        ));
    }
    if u64_field(&row, "schema_version")? != EXTERNAL_GAS_SPONSOR_SCHEMA_VERSION
        || text_field(&row, "status")? != EXTERNAL_GAS_SPONSOR_STATUS
        || text_field(&row, "provider_family")? != EXTERNAL_GAS_SPONSOR_FAMILY
        || text_field(&row, "capital_ownership")? != "EXTERNAL"
    {
        return Err(CapitalError::InvalidCanonical(
            "gas sponsor observation contract mismatch",
        ));
    }

    let anchor = observation_anchor(field(&row, "observation_anchor")?)?;
    if &anchor != expected_anchor {
        return Err(CapitalError::AnchorMismatch);
    }

    let sponsor_identity = hash32(&row, "sponsor_identity")?;
    let sponsor_contract = optional_address(&row, "sponsor_contract")?;
    let maximum_native_gas = amount(&row, "maximum_native_gas")?;
    let (fee_model, fee_asset) = parse_fee(&row)?;

    if text_field(&row, "delivery_semantics")? != EXTERNAL_GAS_SPONSOR_DELIVERY_SEMANTICS {
        return Err(CapitalError::InvalidCanonical(
            "gas sponsor is not available before execution",
        ));
    }
    let delivery_route_commitment = hash32(&row, "delivery_route_commitment")?;
    let operator_prefund_required = bool_field(&row, "operator_prefund_required")?;
    if operator_prefund_required {
        return Err(CapitalError::InvalidCanonical(
            "gas sponsor delivery requires operator prefunding",
        ));
    }
    let active = bool_field(&row, "active")?;

    let declared_terms = hash32(&row, "terms_commitment")?;
    let terms = external_gas_sponsor_terms_commitment(
        sponsor_identity,
        fee_model,
        fee_asset,
        delivery_route_commitment,
        operator_prefund_required,
    )?;
    if terms != declared_terms {
        return Err(CapitalError::CanonicalDigestMismatch);
    }

    let facts = external_gas_sponsor_facts_commitment(
        &anchor,
        sponsor_identity,
        sponsor_contract,
        terms,
        maximum_native_gas,
        active,
    )?;
    let evidence = provider_evidence(&row, facts)?;
    let provider_locator_hash = locator_hash(sponsor_identity, sponsor_contract)?;

    let source = ExternalGasSponsorObservation {
        anchor,
        provider_namespace: EXTERNAL_GAS_SPONSOR_PROVIDER_NAMESPACE,
        provider_locator_hash,
        sponsor_contract,
        maximum_native_gas,
        fee_model,
        fee_asset,
        evidence,
    }
    .into_capital_source()?;

    if active {
        Ok(source)
    } else {
        source.with_execution_blockers(vec!["GAS_SPONSOR_INACTIVE".to_owned()])
    }
}
