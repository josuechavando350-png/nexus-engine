//! Exact Aave V3 persistent-debt facility discovery from admitted RMC-008 bytes.
//!
//! This module deliberately stops before CapitalSource admission. Aave borrowing
//! uses account/portfolio collateral, health factor, eMode/isolation and oracle
//! semantics that cannot be truthfully reduced to a single collateral token.
//! The output is therefore a block-pinned facility census with conservative
//! protocol-borrowability blockers, not a capital-feasibility claim.

use crate::{
    upstream::{d08_aave_flash_terms, verify_d08_artifact_binding, D08CapitalImportContext},
    Amount256, CapitalError, CapitalEvidenceRef, UpstreamStageAuthority,
};
use nqc_census_chain::json::Json;
use nqc_census_core::{Address, Hash32};
use sha2::{Digest, Sha256};

const DISCOVERY_DOMAIN: &[u8] = b"NQC-RMC011-AAVE-V3-DEBT-DISCOVERY-V1";
const FACILITY_DOMAIN: &[u8] = b"NQC-RMC011-AAVE-V3-DEBT-FACILITY-V1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AaveDebtFacilityBlocker {
    ReserveInactive,
    ReservePaused,
    ReserveFrozen,
    BorrowingDisabled,
    BorrowCapReached,
    ZeroAvailableLiquidity,
}

impl AaveDebtFacilityBlocker {
    pub const fn code(self) -> &'static str {
        match self {
            Self::ReserveInactive => "AAVE_DEBT_RESERVE_INACTIVE",
            Self::ReservePaused => "AAVE_DEBT_RESERVE_PAUSED",
            Self::ReserveFrozen => "AAVE_DEBT_RESERVE_FROZEN",
            Self::BorrowingDisabled => "AAVE_DEBT_BORROWING_DISABLED",
            Self::BorrowCapReached => "AAVE_DEBT_BORROW_CAP_REACHED",
            Self::ZeroAvailableLiquidity => "AAVE_DEBT_ZERO_AVAILABLE_LIQUIDITY",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AaveDebtDiscoveryRejectionReason {
    HistoricalNoActiveState,
    StateNotReconstructable,
}

impl AaveDebtDiscoveryRejectionReason {
    pub const fn code(self) -> &'static str {
        match self {
            Self::HistoricalNoActiveState => "HISTORICAL_NO_ACTIVE_STATE",
            Self::StateNotReconstructable => "STATE_NOT_RECONSTRUCTABLE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AaveDebtFacility {
    pub market_id: Hash32,
    pub pool: Address,
    pub asset: Address,
    pub reserve_id: u16,
    pub decimals: u8,
    pub observed_available_liquidity: Amount256,
    pub total_variable_and_stable_debt: Amount256,
    pub borrow_cap: Option<Amount256>,
    pub borrow_cap_remaining: Option<Amount256>,
    pub observed_borrowable_upper_bound: Amount256,
    pub protocol_borrowable_upper_bound: Amount256,
    pub current_variable_borrow_rate_ray: Amount256,
    pub ltv_bps: u16,
    pub liquidation_threshold_bps: u16,
    pub liquidation_bonus_bps: u16,
    pub reserve_factor_bps: u16,
    pub debt_ceiling_centi_units: u64,
    pub borrowable_in_isolation: bool,
    pub siloed_borrowing: bool,
    pub reserve_terms_commitment: Hash32,
    pub portfolio_collateral_resolution_required: bool,
    pub oracle_resolution_required: bool,
    pub emode_resolution_required: bool,
    pub facility_commitment: Hash32,
    pub blockers: Vec<AaveDebtFacilityBlocker>,
    pub evidence: Vec<CapitalEvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AaveDebtDiscoveryRejection {
    pub market_id: String,
    pub asset: Address,
    pub reason: AaveDebtDiscoveryRejectionReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AaveDebtDiscovery {
    pub candidate_count: usize,
    pub facility_count: usize,
    pub rejected_count: usize,
    pub coverage_commitment: Hash32,
    pub facilities: Vec<AaveDebtFacility>,
    pub rejections: Vec<AaveDebtDiscoveryRejection>,
}

impl AaveDebtDiscovery {
    pub const fn is_conserved(&self) -> bool {
        self.candidate_count == self.facility_count + self.rejected_count
            && self.facility_count == self.facilities.len()
            && self.rejected_count == self.rejections.len()
    }
}

fn field<'a>(row: &'a Json, key: &'static str) -> Result<&'a Json, CapitalError> {
    row.get(key)
        .ok_or(CapitalError::InvalidCanonical("missing Aave debt discovery field"))
}

fn text<'a>(row: &'a Json, key: &'static str) -> Result<&'a str, CapitalError> {
    field(row, key)?
        .as_str()
        .ok_or(CapitalError::InvalidCanonical(
            "Aave debt discovery field is not text",
        ))
}

fn bool_field(row: &Json, key: &'static str) -> Result<bool, CapitalError> {
    field(row, key)?
        .as_bool()
        .ok_or(CapitalError::InvalidCanonical(
            "Aave debt discovery field is not boolean",
        ))
}

fn u64_field(row: &Json, key: &'static str) -> Result<u64, CapitalError> {
    field(row, key)?
        .as_i64()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(CapitalError::InvalidCanonical(
            "Aave debt discovery field is not a nonnegative integer",
        ))
}

fn u16_field(row: &Json, key: &'static str) -> Result<u16, CapitalError> {
    let value = u64_field(row, key)?;
    u16::try_from(value)
        .map_err(|_| CapitalError::InvalidCanonical("Aave debt field exceeds uint16"))
}

fn u8_field(row: &Json, key: &'static str) -> Result<u8, CapitalError> {
    let value = u64_field(row, key)?;
    u8::try_from(value)
        .map_err(|_| CapitalError::InvalidCanonical("Aave debt field exceeds uint8"))
}

fn parse_jsonl(bytes: &[u8]) -> Result<Vec<Json>, CapitalError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| CapitalError::InvalidCanonical("Aave debt JSONL is not UTF-8"))?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            Json::parse(line.as_bytes())
                .map_err(|_| CapitalError::InvalidCanonical("Aave debt JSONL row parse failed"))
        })
        .collect()
}

fn token_amount_from_whole(whole: u64, decimals: u8) -> Result<Amount256, CapitalError> {
    if whole == 0 {
        return Ok(Amount256::ZERO);
    }
    if decimals > 77 {
        return Err(CapitalError::InvalidCanonical(
            "Aave debt token decimals exceed uint256 decimal range",
        ));
    }
    let mut decimal = whole.to_string();
    decimal.extend(std::iter::repeat_n('0', usize::from(decimals)));
    Amount256::parse_decimal(&decimal)
}

fn hash_json_domain(
    domain: &[u8],
    market_id: Hash32,
    pool: Address,
    asset: Address,
    parts: &[&Json],
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    hasher.update(market_id.as_bytes());
    hasher.update(pool.as_bytes());
    hasher.update(asset.as_bytes());
    for part in parts {
        let bytes = part
            .canonical()
            .map_err(|_| CapitalError::InvalidCanonical("Aave debt canonical JSON failed"))?;
        let len = u64::try_from(bytes.len())
            .map_err(|_| CapitalError::InvalidCanonical("Aave debt JSON length overflow"))?;
        hasher.update(len.to_be_bytes());
        hasher.update(bytes);
    }
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero Aave debt discovery commitment"))
}

fn facility_commitment(
    market_id: Hash32,
    pool: Address,
    asset: Address,
    reserve_id: u16,
    observed_upper_bound: Amount256,
    protocol_upper_bound: Amount256,
    reserve_terms_commitment: Hash32,
    blockers: &[AaveDebtFacilityBlocker],
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(FACILITY_DOMAIN);
    hasher.update([0]);
    hasher.update(market_id.as_bytes());
    hasher.update(pool.as_bytes());
    hasher.update(asset.as_bytes());
    hasher.update(reserve_id.to_be_bytes());
    hasher.update(observed_upper_bound.as_be_bytes());
    hasher.update(protocol_upper_bound.as_be_bytes());
    hasher.update(reserve_terms_commitment.as_bytes());
    hasher.update(
        u16::try_from(blockers.len())
            .map_err(|_| CapitalError::InvalidCanonical("too many Aave debt blockers"))?
            .to_be_bytes(),
    );
    for blocker in blockers {
        let code = blocker.code().as_bytes();
        hasher.update(
            u16::try_from(code.len())
                .map_err(|_| CapitalError::InvalidCanonical("Aave debt blocker code too long"))?
                .to_be_bytes(),
        );
        hasher.update(code);
    }
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero Aave debt facility commitment"))
}

pub fn discover_d08_aave_debt_facilities(
    state_manifest_jsonl: &[u8],
    token_admission_jsonl: &[u8],
    pool_and_factory_facts_json: &[u8],
    evidence_manifest_json: &[u8],
    authority: &UpstreamStageAuthority,
    context: &D08CapitalImportContext,
) -> Result<AaveDebtDiscovery, CapitalError> {
    verify_d08_artifact_binding(
        state_manifest_jsonl,
        token_admission_jsonl,
        pool_and_factory_facts_json,
        evidence_manifest_json,
        authority,
        context,
    )?;
    let (pool, _) = d08_aave_flash_terms(pool_and_factory_facts_json)?;

    let mut facilities = Vec::new();
    let mut rejections = Vec::new();
    let mut coverage_rows = Vec::<(String, [u8; 32])>::new();

    for row in parse_jsonl(state_manifest_jsonl)? {
        if text(&row, "protocol")? != "AAVE_V3" {
            continue;
        }
        if u64_field(&row, "schema_version")? != 1 {
            return Err(CapitalError::InvalidCanonical(
                "unsupported Aave debt discovery schema",
            ));
        }
        let market_id_text = text(&row, "market_id")?.to_owned();
        let asset = Address::parse_hex(text(&row, "asset")?)
            .map_err(|_| CapitalError::InvalidCanonical("invalid Aave debt asset"))?;

        if text(&row, "lifecycle")? != "CURRENT" {
            let reason = AaveDebtDiscoveryRejectionReason::HistoricalNoActiveState;
            rejections.push(AaveDebtDiscoveryRejection {
                market_id: market_id_text.clone(),
                asset,
                reason,
            });
            coverage_rows.push((
                format!("{market_id_text}:{}", reason.code()),
                Sha256::digest(reason.code().as_bytes()).into(),
            ));
            continue;
        }
        if text(&row, "stage_state_reconstructable")? != "ADVANCE" {
            let reason = AaveDebtDiscoveryRejectionReason::StateNotReconstructable;
            rejections.push(AaveDebtDiscoveryRejection {
                market_id: market_id_text.clone(),
                asset,
                reason,
            });
            coverage_rows.push((
                format!("{market_id_text}:{}", reason.code()),
                Sha256::digest(reason.code().as_bytes()).into(),
            ));
            continue;
        }

        let market_id = Hash32::parse_hex(&market_id_text)
            .map_err(|_| CapitalError::InvalidCanonical("invalid Aave debt market id"))?;
        let reserve_id = u16_field(&row, "reserve_id")?;
        let configuration = field(&row, "configuration")?;
        let indexes = field(&row, "indexes")?;
        let facts = field(&row, "protocol_facts")?;

        let active = bool_field(configuration, "active")?;
        let paused = bool_field(configuration, "paused")?;
        let frozen = bool_field(configuration, "frozen")?;
        let borrowing_enabled = bool_field(configuration, "borrowing_enabled")?;
        if bool_field(facts, "active")? != active
            || bool_field(facts, "paused")? != paused
            || bool_field(facts, "frozen")? != frozen
            || bool_field(facts, "borrowing_enabled")? != borrowing_enabled
        {
            return Err(CapitalError::InvalidCanonical(
                "Aave debt protocol facts disagree with decoded configuration",
            ));
        }

        let decimals = u8_field(configuration, "decimals")?;
        let available = Amount256::parse_decimal(text(facts, "available_liquidity")?)?;
        let total_debt =
            Amount256::parse_decimal(text(facts, "total_variable_and_stable_debt")?)?;
        let borrow_cap_whole = u64_field(configuration, "borrow_cap_whole_tokens")?;
        let borrow_cap = if borrow_cap_whole == 0 {
            None
        } else {
            Some(token_amount_from_whole(borrow_cap_whole, decimals)?)
        };
        let borrow_cap_remaining = match borrow_cap {
            None => None,
            Some(cap) if total_debt >= cap => Some(Amount256::ZERO),
            Some(cap) => Some(cap.checked_sub(total_debt)?),
        };
        let observed_upper_bound = borrow_cap_remaining.map_or(available, |remaining| {
            available.min(remaining)
        });

        let derived_cap_reached = borrow_cap.is_some_and(|cap| total_debt >= cap);
        if bool_field(facts, "borrow_cap_reached")? != derived_cap_reached {
            return Err(CapitalError::InvalidCanonical(
                "Aave debt borrow-cap fact disagrees with exact totals",
            ));
        }

        let mut blockers = Vec::new();
        if !active {
            blockers.push(AaveDebtFacilityBlocker::ReserveInactive);
        }
        if paused {
            blockers.push(AaveDebtFacilityBlocker::ReservePaused);
        }
        if frozen {
            blockers.push(AaveDebtFacilityBlocker::ReserveFrozen);
        }
        if !borrowing_enabled {
            blockers.push(AaveDebtFacilityBlocker::BorrowingDisabled);
        }
        if derived_cap_reached {
            blockers.push(AaveDebtFacilityBlocker::BorrowCapReached);
        }
        if available.is_zero() {
            blockers.push(AaveDebtFacilityBlocker::ZeroAvailableLiquidity);
        }
        blockers.sort();
        blockers.dedup();

        let protocol_upper_bound = if blockers.is_empty() {
            observed_upper_bound
        } else {
            Amount256::ZERO
        };

        let reserve_terms_commitment = hash_json_domain(
            DISCOVERY_DOMAIN,
            market_id,
            pool,
            asset,
            &[configuration, indexes, facts],
        )?;
        let facility_commitment = facility_commitment(
            market_id,
            pool,
            asset,
            reserve_id,
            observed_upper_bound,
            protocol_upper_bound,
            reserve_terms_commitment,
            &blockers,
        )?;

        let facility = AaveDebtFacility {
            market_id,
            pool,
            asset,
            reserve_id,
            decimals,
            observed_available_liquidity: available,
            total_variable_and_stable_debt: total_debt,
            borrow_cap,
            borrow_cap_remaining,
            observed_borrowable_upper_bound: observed_upper_bound,
            protocol_borrowable_upper_bound: protocol_upper_bound,
            portfolio_collateral_resolution_required: true,
            oracle_resolution_required: true,
            emode_resolution_required: true,
            current_variable_borrow_rate_ray: Amount256::parse_decimal(text(
                indexes,
                "current_variable_borrow_rate",
            )?)?,
            ltv_bps: u16_field(configuration, "ltv_bps")?,
            liquidation_threshold_bps: u16_field(configuration, "liquidation_threshold_bps")?,
            liquidation_bonus_bps: u16_field(configuration, "liquidation_bonus_bps")?,
            reserve_factor_bps: u16_field(configuration, "reserve_factor_bps")?,
            debt_ceiling_centi_units: u64_field(configuration, "debt_ceiling_centi_units")?,
            borrowable_in_isolation: bool_field(configuration, "borrowable_in_isolation")?,
            siloed_borrowing: bool_field(configuration, "siloed_borrowing")?,
            reserve_terms_commitment,
            facility_commitment,
            blockers,
            evidence: context.evidence.clone(),
        };
        coverage_rows.push((
            facility.market_id.to_hex(),
            *facility.facility_commitment.as_bytes(),
        ));
        facilities.push(facility);
    }

    facilities.sort_by_key(|facility| (facility.market_id, facility.asset));
    rejections.sort_by(|left, right| {
        (left.market_id.as_str(), left.asset).cmp(&(right.market_id.as_str(), right.asset))
    });
    coverage_rows.sort_by(|left, right| left.0.cmp(&right.0));

    let mut hasher = Sha256::new();
    hasher.update(DISCOVERY_DOMAIN);
    hasher.update([1]);
    hasher.update(context.anchor.chain().chain_id().to_be_bytes());
    hasher.update(context.anchor.block_number().to_be_bytes());
    hasher.update(context.anchor.block_hash().as_bytes());
    hasher.update(
        u64::try_from(coverage_rows.len())
            .map_err(|_| CapitalError::InvalidCanonical("Aave debt coverage count overflow"))?
            .to_be_bytes(),
    );
    for (key, digest) in &coverage_rows {
        hasher.update(
            u16::try_from(key.len())
                .map_err(|_| CapitalError::InvalidCanonical("Aave debt coverage key too long"))?
                .to_be_bytes(),
        );
        hasher.update(key.as_bytes());
        hasher.update(digest);
    }
    let coverage_digest: [u8; 32] = hasher.finalize().into();
    let coverage_commitment = Hash32::new(coverage_digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero Aave debt coverage commitment"))?;

    let discovery = AaveDebtDiscovery {
        candidate_count: facilities.len() + rejections.len(),
        facility_count: facilities.len(),
        rejected_count: rejections.len(),
        coverage_commitment,
        facilities,
        rejections,
    };
    if !discovery.is_conserved() {
        return Err(CapitalError::InvalidCanonical(
            "Aave debt discovery conservation failed",
        ));
    }
    Ok(discovery)
}
