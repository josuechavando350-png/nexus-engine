//! RMC-012 exact actionability boundary.
//!
//! D09 proves the position universe but deliberately does not claim
//! liquidatability.  This module is the protocol-agnostic receiving boundary
//! for an isolated, PFT-bound liquidation bridge.  Every below-one
//! borrower/debt/collateral pair is preserved as exactly one admitted
//! opportunity or one explicit rejection; nothing may disappear because the
//! expected profit looks unattractive.

use nqc_census_capital::Amount256;
use nqc_census_core::{Address, Hash32, StateAnchor};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fmt::{Display, Formatter},
};

const PAIR_KEY_DOMAIN: &[u8] = b"NQC-RMC012-ACTION-PAIR-KEY-V1";
const PAIR_ID_DOMAIN: &[u8] = b"NQC-RMC012-ACTION-PAIR-ID-V1";
const CANDIDATE_DOMAIN: &[u8] = b"NQC-RMC012-ACTIONABLE-LIQUIDATION-V1";
const COVERAGE_DOMAIN: &[u8] = b"NQC-RMC012-ACTIONABILITY-COVERAGE-V1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionabilityError {
    DuplicateEvidence,
    MissingEvidence,
    DuplicatePair,
    DuplicateCandidate,
    AnchorMismatch,
    InvalidLiquidationBonus,
    ZeroDebtToLiquidate,
    ZeroCollateralToLiquidator,
    ZeroSnapshotCommitment,
    ConservationMismatch,
    BelowOneBorrowerCoverageMismatch,
}

impl Display for ActionabilityError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateEvidence => f.write_str("actionability record repeats evidence"),
            Self::MissingEvidence => f.write_str("actionability record requires evidence"),
            Self::DuplicatePair => f.write_str("actionability coverage repeats one position pair"),
            Self::DuplicateCandidate => {
                f.write_str("actionability coverage repeats one admitted candidate")
            }
            Self::AnchorMismatch => {
                f.write_str("actionability records are not pinned to one exact anchor")
            }
            Self::InvalidLiquidationBonus => {
                f.write_str("liquidation bonus must be at least 10000 bps")
            }
            Self::ZeroDebtToLiquidate => {
                f.write_str("admitted liquidation has zero debt to liquidate")
            }
            Self::ZeroCollateralToLiquidator => {
                f.write_str("admitted liquidation has zero collateral output")
            }
            Self::ZeroSnapshotCommitment => {
                f.write_str("PFT market/account snapshot commitment must be non-zero")
            }
            Self::ConservationMismatch => {
                f.write_str("actionability pair classification is not conserved")
            }
            Self::BelowOneBorrowerCoverageMismatch => {
                f.write_str("below-one borrower coverage is incomplete")
            }
        }
    }
}

impl std::error::Error for ActionabilityError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ActionabilityPairKey([u8; 32]);

impl ActionabilityPairKey {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ActionabilityPairId([u8; 32]);

impl ActionabilityPairId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ActionableCandidateId([u8; 32]);

impl ActionableCandidateId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ActionabilityRejectionReason {
    CollateralNotEnabled,
    CollateralReserveIneligible,
    DebtReserveIneligible,
    DebtFlashLiquidityUnavailable,
    CollateralTokenExecutionBlocked,
    DebtTokenExecutionBlocked,
    UnknownEmodeCategory,
    SnapshotMismatch,
    PftMathRejected,
    PftPolicyRejected,
    UnsupportedPosition,
}

impl ActionabilityRejectionReason {
    pub const fn code(self) -> &'static str {
        match self {
            Self::CollateralNotEnabled => "COLLATERAL_NOT_ENABLED",
            Self::CollateralReserveIneligible => "COLLATERAL_RESERVE_INELIGIBLE",
            Self::DebtReserveIneligible => "DEBT_RESERVE_INELIGIBLE",
            Self::DebtFlashLiquidityUnavailable => "DEBT_FLASH_LIQUIDITY_UNAVAILABLE",
            Self::CollateralTokenExecutionBlocked => "COLLATERAL_TOKEN_EXECUTION_BLOCKED",
            Self::DebtTokenExecutionBlocked => "DEBT_TOKEN_EXECUTION_BLOCKED",
            Self::UnknownEmodeCategory => "UNKNOWN_EMODE_CATEGORY",
            Self::SnapshotMismatch => "SNAPSHOT_MISMATCH",
            Self::PftMathRejected => "PFT_MATH_REJECTED",
            Self::PftPolicyRejected => "PFT_POLICY_REJECTED",
            Self::UnsupportedPosition => "UNSUPPORTED_POSITION",
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::CollateralNotEnabled => 1,
            Self::CollateralReserveIneligible => 2,
            Self::DebtReserveIneligible => 3,
            Self::DebtFlashLiquidityUnavailable => 4,
            Self::CollateralTokenExecutionBlocked => 5,
            Self::DebtTokenExecutionBlocked => 6,
            Self::UnknownEmodeCategory => 7,
            Self::SnapshotMismatch => 8,
            Self::PftMathRejected => 9,
            Self::PftPolicyRejected => 10,
            Self::UnsupportedPosition => 11,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionabilityPair {
    key: ActionabilityPairKey,
    id: ActionabilityPairId,
    anchor: StateAnchor,
    borrower: Address,
    collateral_asset: Address,
    debt_asset: Address,
    collateral_reserve_id: u16,
    debt_reserve_id: u16,
}

impl ActionabilityPair {
    pub fn new(
        anchor: StateAnchor,
        borrower: Address,
        collateral_asset: Address,
        debt_asset: Address,
        collateral_reserve_id: u16,
        debt_reserve_id: u16,
    ) -> Self {
        let mut stable = Vec::with_capacity(20 * 3 + 4 + 96);
        encode_chain(anchor.chain(), &mut stable);
        stable.extend_from_slice(borrower.as_bytes());
        stable.extend_from_slice(collateral_asset.as_bytes());
        stable.extend_from_slice(debt_asset.as_bytes());
        stable.extend_from_slice(&collateral_reserve_id.to_be_bytes());
        stable.extend_from_slice(&debt_reserve_id.to_be_bytes());
        let key = ActionabilityPairKey(domain_hash(PAIR_KEY_DOMAIN, &stable));

        let mut observed = stable;
        encode_anchor(&anchor, &mut observed);
        let id = ActionabilityPairId(domain_hash(PAIR_ID_DOMAIN, &observed));
        Self {
            key,
            id,
            anchor,
            borrower,
            collateral_asset,
            debt_asset,
            collateral_reserve_id,
            debt_reserve_id,
        }
    }

    pub const fn key(&self) -> ActionabilityPairKey {
        self.key
    }

    pub const fn id(&self) -> ActionabilityPairId {
        self.id
    }

    pub const fn anchor(&self) -> &StateAnchor {
        &self.anchor
    }

    pub const fn borrower(&self) -> Address {
        self.borrower
    }

    pub const fn collateral_asset(&self) -> Address {
        self.collateral_asset
    }

    pub const fn debt_asset(&self) -> Address {
        self.debt_asset
    }

    pub const fn collateral_reserve_id(&self) -> u16 {
        self.collateral_reserve_id
    }

    pub const fn debt_reserve_id(&self) -> u16 {
        self.debt_reserve_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionableLiquidation {
    id: ActionableCandidateId,
    pair: ActionabilityPair,
    health_factor_wad: Amount256,
    debt_to_liquidate: Amount256,
    collateral_to_liquidator: Amount256,
    liquidation_protocol_fee_collateral: Amount256,
    flash_loan_premium: Amount256,
    flash_loan_repayment: Amount256,
    liquidation_bonus_bps: u32,
    oracle_collateral_value_wad: Amount256,
    oracle_repayment_value_wad: Amount256,
    oracle_edge_wad: Amount256,
    pft_market_snapshot: Hash32,
    pft_account_snapshot: Hash32,
}

#[allow(clippy::too_many_arguments)]
impl ActionableLiquidation {
    pub fn new(
        pair: ActionabilityPair,
        health_factor_wad: Amount256,
        debt_to_liquidate: Amount256,
        collateral_to_liquidator: Amount256,
        liquidation_protocol_fee_collateral: Amount256,
        flash_loan_premium: Amount256,
        flash_loan_repayment: Amount256,
        liquidation_bonus_bps: u32,
        oracle_collateral_value_wad: Amount256,
        oracle_repayment_value_wad: Amount256,
        oracle_edge_wad: Amount256,
        pft_market_snapshot: Hash32,
        pft_account_snapshot: Hash32,
    ) -> Result<Self, ActionabilityError> {
        if debt_to_liquidate.is_zero() {
            return Err(ActionabilityError::ZeroDebtToLiquidate);
        }
        if collateral_to_liquidator.is_zero() {
            return Err(ActionabilityError::ZeroCollateralToLiquidator);
        }
        if liquidation_bonus_bps < 10_000 {
            return Err(ActionabilityError::InvalidLiquidationBonus);
        }
        if pft_market_snapshot.as_bytes().iter().all(|byte| *byte == 0)
            || pft_account_snapshot
                .as_bytes()
                .iter()
                .all(|byte| *byte == 0)
        {
            return Err(ActionabilityError::ZeroSnapshotCommitment);
        }

        let mut bytes = Vec::with_capacity(32 * 14);
        bytes.extend_from_slice(pair.id().as_bytes());
        for amount in [
            health_factor_wad,
            debt_to_liquidate,
            collateral_to_liquidator,
            liquidation_protocol_fee_collateral,
            flash_loan_premium,
            flash_loan_repayment,
            oracle_collateral_value_wad,
            oracle_repayment_value_wad,
            oracle_edge_wad,
        ] {
            bytes.extend_from_slice(amount.as_be_bytes());
        }
        bytes.extend_from_slice(&liquidation_bonus_bps.to_be_bytes());
        bytes.extend_from_slice(pft_market_snapshot.as_bytes());
        bytes.extend_from_slice(pft_account_snapshot.as_bytes());
        let id = ActionableCandidateId(domain_hash(CANDIDATE_DOMAIN, &bytes));
        Ok(Self {
            id,
            pair,
            health_factor_wad,
            debt_to_liquidate,
            collateral_to_liquidator,
            liquidation_protocol_fee_collateral,
            flash_loan_premium,
            flash_loan_repayment,
            liquidation_bonus_bps,
            oracle_collateral_value_wad,
            oracle_repayment_value_wad,
            oracle_edge_wad,
            pft_market_snapshot,
            pft_account_snapshot,
        })
    }

    pub const fn id(&self) -> ActionableCandidateId {
        self.id
    }

    pub const fn pair(&self) -> &ActionabilityPair {
        &self.pair
    }

    pub const fn health_factor_wad(&self) -> Amount256 {
        self.health_factor_wad
    }

    pub const fn debt_to_liquidate(&self) -> Amount256 {
        self.debt_to_liquidate
    }

    pub const fn collateral_to_liquidator(&self) -> Amount256 {
        self.collateral_to_liquidator
    }

    pub const fn liquidation_protocol_fee_collateral(&self) -> Amount256 {
        self.liquidation_protocol_fee_collateral
    }

    pub const fn flash_loan_premium(&self) -> Amount256 {
        self.flash_loan_premium
    }

    pub const fn flash_loan_repayment(&self) -> Amount256 {
        self.flash_loan_repayment
    }

    pub const fn liquidation_bonus_bps(&self) -> u32 {
        self.liquidation_bonus_bps
    }

    pub const fn oracle_collateral_value_wad(&self) -> Amount256 {
        self.oracle_collateral_value_wad
    }

    pub const fn oracle_repayment_value_wad(&self) -> Amount256 {
        self.oracle_repayment_value_wad
    }

    pub const fn oracle_edge_wad(&self) -> Amount256 {
        self.oracle_edge_wad
    }

    pub const fn pft_market_snapshot(&self) -> Hash32 {
        self.pft_market_snapshot
    }

    pub const fn pft_account_snapshot(&self) -> Hash32 {
        self.pft_account_snapshot
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionabilityDisposition {
    Admitted(Box<ActionableLiquidation>),
    Rejected(ActionabilityRejectionReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionabilityRecord {
    pair: ActionabilityPair,
    disposition: ActionabilityDisposition,
    evidence: Vec<Hash32>,
}

impl ActionabilityRecord {
    pub fn admitted(
        candidate: ActionableLiquidation,
        evidence: Vec<Hash32>,
    ) -> Result<Self, ActionabilityError> {
        let pair = candidate.pair().clone();
        Self::build(
            pair,
            ActionabilityDisposition::Admitted(Box::new(candidate)),
            evidence,
        )
    }

    pub fn rejected(
        pair: ActionabilityPair,
        reason: ActionabilityRejectionReason,
        evidence: Vec<Hash32>,
    ) -> Result<Self, ActionabilityError> {
        Self::build(pair, ActionabilityDisposition::Rejected(reason), evidence)
    }

    fn build(
        pair: ActionabilityPair,
        disposition: ActionabilityDisposition,
        mut evidence: Vec<Hash32>,
    ) -> Result<Self, ActionabilityError> {
        if evidence.is_empty() {
            return Err(ActionabilityError::MissingEvidence);
        }
        evidence.sort_unstable();
        if evidence.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(ActionabilityError::DuplicateEvidence);
        }
        if let ActionabilityDisposition::Admitted(candidate) = &disposition {
            if candidate.pair().id() != pair.id() {
                return Err(ActionabilityError::ConservationMismatch);
            }
        }
        Ok(Self {
            pair,
            disposition,
            evidence,
        })
    }

    pub const fn pair(&self) -> &ActionabilityPair {
        &self.pair
    }

    pub const fn disposition(&self) -> &ActionabilityDisposition {
        &self.disposition
    }

    pub fn evidence(&self) -> &[Hash32] {
        &self.evidence
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionabilityCoverage {
    anchor: StateAnchor,
    below_one_borrowers: u64,
    expected_pairs: u64,
    records: Vec<ActionabilityRecord>,
    admitted_count: u64,
    rejected_count: u64,
    commitment: [u8; 32],
}

impl ActionabilityCoverage {
    pub fn new(
        anchor: StateAnchor,
        below_one_borrowers: u64,
        expected_pairs: u64,
        mut records: Vec<ActionabilityRecord>,
    ) -> Result<Self, ActionabilityError> {
        records.sort_by_key(|record| record.pair().id());
        let mut pairs = BTreeSet::new();
        let mut candidates = BTreeSet::new();
        let mut borrowers = BTreeSet::new();
        let mut admitted_count = 0_u64;
        let mut rejected_count = 0_u64;

        for record in &records {
            if record.pair().anchor() != &anchor {
                return Err(ActionabilityError::AnchorMismatch);
            }
            if !pairs.insert(record.pair().id()) {
                return Err(ActionabilityError::DuplicatePair);
            }
            borrowers.insert(record.pair().borrower());
            match record.disposition() {
                ActionabilityDisposition::Admitted(candidate) => {
                    admitted_count = admitted_count
                        .checked_add(1)
                        .ok_or(ActionabilityError::ConservationMismatch)?;
                    if !candidates.insert(candidate.id()) {
                        return Err(ActionabilityError::DuplicateCandidate);
                    }
                }
                ActionabilityDisposition::Rejected(_) => {
                    rejected_count = rejected_count
                        .checked_add(1)
                        .ok_or(ActionabilityError::ConservationMismatch)?;
                }
            }
        }

        let record_count =
            u64::try_from(records.len()).map_err(|_| ActionabilityError::ConservationMismatch)?;
        if record_count != expected_pairs
            || admitted_count
                .checked_add(rejected_count)
                .ok_or(ActionabilityError::ConservationMismatch)?
                != expected_pairs
        {
            return Err(ActionabilityError::ConservationMismatch);
        }
        if u64::try_from(borrowers.len())
            .map_err(|_| ActionabilityError::BelowOneBorrowerCoverageMismatch)?
            != below_one_borrowers
        {
            return Err(ActionabilityError::BelowOneBorrowerCoverageMismatch);
        }

        let commitment = coverage_commitment(
            &anchor,
            below_one_borrowers,
            expected_pairs,
            admitted_count,
            rejected_count,
            &records,
        );
        Ok(Self {
            anchor,
            below_one_borrowers,
            expected_pairs,
            records,
            admitted_count,
            rejected_count,
            commitment,
        })
    }

    pub const fn anchor(&self) -> &StateAnchor {
        &self.anchor
    }

    pub const fn below_one_borrowers(&self) -> u64 {
        self.below_one_borrowers
    }

    pub const fn expected_pairs(&self) -> u64 {
        self.expected_pairs
    }

    pub fn records(&self) -> &[ActionabilityRecord] {
        &self.records
    }

    pub const fn admitted_count(&self) -> u64 {
        self.admitted_count
    }

    pub const fn rejected_count(&self) -> u64 {
        self.rejected_count
    }

    pub const fn commitment(&self) -> &[u8; 32] {
        &self.commitment
    }

    pub fn commitment_hex(&self) -> String {
        hex_encode(&self.commitment)
    }
}

fn coverage_commitment(
    anchor: &StateAnchor,
    below_one_borrowers: u64,
    expected_pairs: u64,
    admitted_count: u64,
    rejected_count: u64,
    records: &[ActionabilityRecord],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(COVERAGE_DOMAIN);
    hasher.update([0]);
    let mut anchor_bytes = Vec::new();
    encode_anchor(anchor, &mut anchor_bytes);
    hasher.update(anchor_bytes);
    hasher.update(below_one_borrowers.to_be_bytes());
    hasher.update(expected_pairs.to_be_bytes());
    hasher.update(admitted_count.to_be_bytes());
    hasher.update(rejected_count.to_be_bytes());
    for record in records {
        hasher.update(record.pair().id().as_bytes());
        match record.disposition() {
            ActionabilityDisposition::Admitted(candidate) => {
                hasher.update([1]);
                hasher.update(candidate.id().as_bytes());
            }
            ActionabilityDisposition::Rejected(reason) => {
                hasher.update([2, reason.tag()]);
            }
        }
        hasher.update(
            u64::try_from(record.evidence().len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
        for evidence in record.evidence() {
            hasher.update(evidence.as_bytes());
        }
    }
    hasher.finalize().into()
}

fn encode_chain(chain: &nqc_census_core::ChainDomain, out: &mut Vec<u8>) {
    out.extend_from_slice(&chain.chain_id().to_be_bytes());
    out.extend_from_slice(chain.genesis_hash().as_bytes());
    out.extend_from_slice(chain.fork_lineage().as_bytes());
}

fn encode_anchor(anchor: &StateAnchor, out: &mut Vec<u8>) {
    encode_chain(anchor.chain(), out);
    out.extend_from_slice(&anchor.block_number().to_be_bytes());
    out.extend_from_slice(anchor.block_hash().as_bytes());
    out.extend_from_slice(anchor.parent_hash().as_bytes());
    out.extend_from_slice(&anchor.timestamp().to_be_bytes());
    out.extend_from_slice(anchor.state_root().as_bytes());
}

fn domain_hash(domain: &[u8], payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    hasher.update(payload);
    hasher.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(TABLE[usize::from(byte >> 4)]));
        out.push(char::from(TABLE[usize::from(byte & 0x0f)]));
    }
    out
}
