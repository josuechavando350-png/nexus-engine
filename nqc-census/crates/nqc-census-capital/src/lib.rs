//! Protocol-agnostic, evidence-bound capital semantics for RMC-011.
//!
//! This crate deliberately does not discover live liquidity or make profitability claims.
//! It defines exact integer capital sources, candidate requirements, deterministic identities,
//! and fail-closed feasibility semantics consumed by later protocol adapters.

use nqc_census_core::{
    Address, CensusUnitId, ChainDomain, EvidenceRef, Hash32, ObservationDigest, StateAnchor,
};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::BTreeSet,
    fmt::{Display, Formatter},
};

pub const CAPITAL_SCHEMA_VERSION: u16 = 1;

const SOURCE_MAGIC: &[u8] = b"NQC-CAP-SOURCE";
const REQUIREMENT_MAGIC: &[u8] = b"NQC-CAP-REQUIREMENT";
const SOURCE_DOMAIN: &[u8] = b"NQC-RMC011-CAPITAL-SOURCE-ID-V1";
const REQUIREMENT_DOMAIN: &[u8] = b"NQC-RMC011-CAPITAL-REQUIREMENT-ID-V1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapitalError {
    ZeroValue(&'static str),
    InvalidBasisPoints(u16),
    InvalidRatio,
    MissingEvidence,
    EmptyFailureModes,
    UnknownFailureMode,
    MissingAllowedClass,
    DuplicateAllowedClass,
    DuplicateLeg,
    GasLegMustUseNativeAsset,
    GasLegMustAllowGasFunding,
    NativeGasRequiredButMissing,
    PersistentDebtTermsRequired,
    PersistentTermsOnNonPersistentSource,
    CollateralSemanticsRequired,
    TemporaryLockSemanticsRequired,
    InvalidCanonical(&'static str),
    CanonicalDigestMismatch,
    WrongCanonicalType,
    AnchorMismatch,
    AmountUnderflow,
    InsufficientCapacity,
    MissingGasFunding,
    OperatorOwnedCapitalRequired,
    AtomicityMismatch,
    RepaymentRequirementMissing,
    CollateralRequirementUnfunded,
    TemporaryLockUnfunded,
    NoCompatibleSource,
}

impl Display for CapitalError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroValue(name) => write!(f, "{name} must not be zero"),
            Self::InvalidBasisPoints(value) => write!(f, "invalid basis points {value}"),
            Self::InvalidRatio => f.write_str("invalid exact ratio"),
            Self::MissingEvidence => f.write_str("real capital record requires evidence"),
            Self::EmptyFailureModes => f.write_str("capital source must enumerate failure modes"),
            Self::UnknownFailureMode => {
                f.write_str("UNKNOWN capital failure mode cannot be admitted")
            }
            Self::MissingAllowedClass => {
                f.write_str("requirement leg has no allowed capital class")
            }
            Self::DuplicateAllowedClass => f.write_str("requirement leg repeats a capital class"),
            Self::DuplicateLeg => f.write_str("duplicate capital requirement leg"),
            Self::GasLegMustUseNativeAsset => {
                f.write_str("gas funding leg must use native gas asset")
            }
            Self::GasLegMustAllowGasFunding => {
                f.write_str("gas funding leg must permit GAS_FUNDING capital")
            }
            Self::NativeGasRequiredButMissing => {
                f.write_str("candidate requires native gas but no gas leg exists")
            }
            Self::PersistentDebtTermsRequired => {
                f.write_str("persistent debt requires explicit risk semantics")
            }
            Self::PersistentTermsOnNonPersistentSource => {
                f.write_str("non-persistent source cannot carry persistent debt terms")
            }
            Self::CollateralSemanticsRequired => {
                f.write_str("collateralized capital requires explicit collateral semantics")
            }
            Self::TemporaryLockSemanticsRequired => {
                f.write_str("temporary-lock capital requires explicit lock semantics")
            }
            Self::InvalidCanonical(reason) => {
                write!(f, "invalid canonical capital bytes: {reason}")
            }
            Self::CanonicalDigestMismatch => f.write_str("canonical capital digest mismatch"),
            Self::WrongCanonicalType => f.write_str("canonical capital object has wrong type"),
            Self::AnchorMismatch => f.write_str("capital source and requirement anchors differ"),
            Self::AmountUnderflow => f.write_str("capital amount underflow"),
            Self::InsufficientCapacity => f.write_str("insufficient capital capacity"),
            Self::MissingGasFunding => f.write_str("required native gas funding is absent"),
            Self::OperatorOwnedCapitalRequired => {
                f.write_str("zero-own-capital policy forbids operator treasury funding")
            }
            Self::AtomicityMismatch => {
                f.write_str("capital source does not satisfy required atomicity")
            }
            Self::RepaymentRequirementMissing => f.write_str(
                "capital source repayment asset is not represented by candidate requirements",
            ),
            Self::CollateralRequirementUnfunded => {
                f.write_str("capital source collateral requirement is unfunded")
            }
            Self::TemporaryLockUnfunded => f.write_str("capital source temporary lock is unfunded"),
            Self::NoCompatibleSource => f.write_str("no compatible capital source"),
        }
    }
}

impl std::error::Error for CapitalError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Amount256([u8; 32]);

impl Amount256 {
    pub const ZERO: Self = Self([0; 32]);

    pub const fn from_be_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn from_u128(value: u128) -> Self {
        let mut bytes = [0_u8; 32];
        bytes[16..].copy_from_slice(&value.to_be_bytes());
        Self(bytes)
    }

    pub const fn as_be_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn is_zero(self) -> bool {
        self.0 == [0; 32]
    }

    pub fn checked_sub(self, rhs: Self) -> Result<Self, CapitalError> {
        if self < rhs {
            return Err(CapitalError::AmountUnderflow);
        }
        let mut out = [0_u8; 32];
        let mut borrow = 0_u16;
        for index in (0..32).rev() {
            let lhs = u16::from(self.0[index]);
            let sub = u16::from(rhs.0[index]) + borrow;
            if lhs >= sub {
                out[index] = u8::try_from(lhs - sub).map_err(|_| CapitalError::AmountUnderflow)?;
                borrow = 0;
            } else {
                out[index] =
                    u8::try_from(lhs + 256 - sub).map_err(|_| CapitalError::AmountUnderflow)?;
                borrow = 1;
            }
        }
        if borrow != 0 {
            return Err(CapitalError::AmountUnderflow);
        }
        Ok(Self(out))
    }

    pub fn min(self, rhs: Self) -> Self {
        if self <= rhs {
            self
        } else {
            rhs
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapitalClass {
    ProtocolNativeFlashLoan,
    AtomicFlashLiquidity,
    FlashSwap,
    TransientCredit,
    CollateralizedBorrowing,
    PersistentDebt,
    InventoryRequirement,
    GasFunding,
    BondOrStake,
    SolverOrBuilderDeposit,
    IntraBlockTemporaryLock,
}

impl CapitalClass {
    pub const ALL: [Self; 11] = [
        Self::ProtocolNativeFlashLoan,
        Self::AtomicFlashLiquidity,
        Self::FlashSwap,
        Self::TransientCredit,
        Self::CollateralizedBorrowing,
        Self::PersistentDebt,
        Self::InventoryRequirement,
        Self::GasFunding,
        Self::BondOrStake,
        Self::SolverOrBuilderDeposit,
        Self::IntraBlockTemporaryLock,
    ];

    pub const fn code(self) -> &'static str {
        match self {
            Self::ProtocolNativeFlashLoan => "PROTOCOL_NATIVE_FLASH_LOAN",
            Self::AtomicFlashLiquidity => "ATOMIC_FLASH_LIQUIDITY",
            Self::FlashSwap => "FLASH_SWAP",
            Self::TransientCredit => "TRANSIENT_CREDIT",
            Self::CollateralizedBorrowing => "COLLATERALIZED_BORROWING",
            Self::PersistentDebt => "PERSISTENT_DEBT",
            Self::InventoryRequirement => "INVENTORY_REQUIREMENT",
            Self::GasFunding => "GAS_FUNDING",
            Self::BondOrStake => "BOND_OR_STAKE",
            Self::SolverOrBuilderDeposit => "SOLVER_OR_BUILDER_DEPOSIT",
            Self::IntraBlockTemporaryLock => "INTRA_BLOCK_TEMPORARY_LOCK",
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::ProtocolNativeFlashLoan => 1,
            Self::AtomicFlashLiquidity => 2,
            Self::FlashSwap => 3,
            Self::TransientCredit => 4,
            Self::CollateralizedBorrowing => 5,
            Self::PersistentDebt => 6,
            Self::InventoryRequirement => 7,
            Self::GasFunding => 8,
            Self::BondOrStake => 9,
            Self::SolverOrBuilderDeposit => 10,
            Self::IntraBlockTemporaryLock => 11,
        }
    }

    fn from_tag(tag: u8) -> Result<Self, CapitalError> {
        Self::ALL
            .into_iter()
            .find(|class| class.tag() == tag)
            .ok_or(CapitalError::InvalidCanonical("unknown capital class"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapitalProviderKind {
    ProtocolContract,
    DexLiquidityPool,
    ExternalSponsor,
    ExternalCreditFacility,
    OperatorTreasury,
    BuilderOrSolver,
    OtherExternal,
}

impl CapitalProviderKind {
    const ALL: [Self; 7] = [
        Self::ProtocolContract,
        Self::DexLiquidityPool,
        Self::ExternalSponsor,
        Self::ExternalCreditFacility,
        Self::OperatorTreasury,
        Self::BuilderOrSolver,
        Self::OtherExternal,
    ];

    pub const fn code(self) -> &'static str {
        match self {
            Self::ProtocolContract => "PROTOCOL_CONTRACT",
            Self::DexLiquidityPool => "DEX_LIQUIDITY_POOL",
            Self::ExternalSponsor => "EXTERNAL_SPONSOR",
            Self::ExternalCreditFacility => "EXTERNAL_CREDIT_FACILITY",
            Self::OperatorTreasury => "OPERATOR_TREASURY",
            Self::BuilderOrSolver => "BUILDER_OR_SOLVER",
            Self::OtherExternal => "OTHER_EXTERNAL",
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::ProtocolContract => 1,
            Self::DexLiquidityPool => 2,
            Self::ExternalSponsor => 3,
            Self::ExternalCreditFacility => 4,
            Self::OperatorTreasury => 5,
            Self::BuilderOrSolver => 6,
            Self::OtherExternal => 7,
        }
    }

    fn from_tag(tag: u8) -> Result<Self, CapitalError> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.tag() == tag)
            .ok_or(CapitalError::InvalidCanonical(
                "unknown capital provider kind",
            ))
    }

    pub const fn is_operator_owned(self) -> bool {
        matches!(self, Self::OperatorTreasury)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapitalAsset {
    NativeGas,
    Token(Address),
}

impl CapitalAsset {
    fn encode(self, writer: &mut Writer) {
        match self {
            Self::NativeGas => writer.u8(1),
            Self::Token(address) => {
                writer.u8(2);
                writer.bytes(address.as_bytes());
            }
        }
    }

    fn decode(reader: &mut Reader<'_>) -> Result<Self, CapitalError> {
        match reader.u8()? {
            1 => Ok(Self::NativeGas),
            2 => Ok(Self::Token(Address::new(reader.array::<20>()?).map_err(
                |_| CapitalError::InvalidCanonical("invalid token address"),
            )?)),
            _ => Err(CapitalError::InvalidCanonical("unknown capital asset")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeModel {
    None,
    BasisPoints(u16),
    Fixed {
        asset: CapitalAsset,
        amount: Amount256,
    },
    ExactRatio {
        numerator: u128,
        denominator: u128,
    },
}

impl FeeModel {
    pub fn basis_points(value: u16) -> Result<Self, CapitalError> {
        if value > 10_000 {
            return Err(CapitalError::InvalidBasisPoints(value));
        }
        Ok(Self::BasisPoints(value))
    }

    pub fn exact_ratio(numerator: u128, denominator: u128) -> Result<Self, CapitalError> {
        if denominator == 0 {
            return Err(CapitalError::InvalidRatio);
        }
        Ok(Self::ExactRatio {
            numerator,
            denominator,
        })
    }

    fn encode(self, writer: &mut Writer) {
        match self {
            Self::None => writer.u8(1),
            Self::BasisPoints(value) => {
                writer.u8(2);
                writer.u16(value);
            }
            Self::Fixed { asset, amount } => {
                writer.u8(3);
                asset.encode(writer);
                writer.bytes(amount.as_be_bytes());
            }
            Self::ExactRatio {
                numerator,
                denominator,
            } => {
                writer.u8(4);
                writer.u128(numerator);
                writer.u128(denominator);
            }
        }
    }

    fn decode(reader: &mut Reader<'_>) -> Result<Self, CapitalError> {
        match reader.u8()? {
            1 => Ok(Self::None),
            2 => Self::basis_points(reader.u16()?),
            3 => Ok(Self::Fixed {
                asset: CapitalAsset::decode(reader)?,
                amount: Amount256::from_be_bytes(reader.array::<32>()?),
            }),
            4 => Self::exact_ratio(reader.u128()?, reader.u128()?),
            _ => Err(CapitalError::InvalidCanonical("unknown fee model")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PersistentDebtTerms {
    pub interest_model_hash: Hash32,
    pub liquidation_model_hash: Hash32,
    pub solvency_model_hash: Hash32,
    pub oracle_risk_hash: Hash32,
    pub liquidity_withdrawal_risk_hash: Hash32,
    pub facility_disappearance_risk_hash: Hash32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepaymentSemantics {
    AtomicSameTransaction,
    SameBlock,
    DeadlineBlocks(u32),
    Persistent(PersistentDebtTerms),
}

impl RepaymentSemantics {
    fn encode(self, writer: &mut Writer) {
        match self {
            Self::AtomicSameTransaction => writer.u8(1),
            Self::SameBlock => writer.u8(2),
            Self::DeadlineBlocks(blocks) => {
                writer.u8(3);
                writer.u32(blocks);
            }
            Self::Persistent(terms) => {
                writer.u8(4);
                for hash in [
                    terms.interest_model_hash,
                    terms.liquidation_model_hash,
                    terms.solvency_model_hash,
                    terms.oracle_risk_hash,
                    terms.liquidity_withdrawal_risk_hash,
                    terms.facility_disappearance_risk_hash,
                ] {
                    writer.bytes(hash.as_bytes());
                }
            }
        }
    }

    fn decode(reader: &mut Reader<'_>) -> Result<Self, CapitalError> {
        match reader.u8()? {
            1 => Ok(Self::AtomicSameTransaction),
            2 => Ok(Self::SameBlock),
            3 => {
                let blocks = reader.u32()?;
                if blocks == 0 {
                    return Err(CapitalError::ZeroValue("repayment_deadline_blocks"));
                }
                Ok(Self::DeadlineBlocks(blocks))
            }
            4 => Ok(Self::Persistent(PersistentDebtTerms {
                interest_model_hash: nonzero_hash(reader.array::<32>()?)?,
                liquidation_model_hash: nonzero_hash(reader.array::<32>()?)?,
                solvency_model_hash: nonzero_hash(reader.array::<32>()?)?,
                oracle_risk_hash: nonzero_hash(reader.array::<32>()?)?,
                liquidity_withdrawal_risk_hash: nonzero_hash(reader.array::<32>()?)?,
                facility_disappearance_risk_hash: nonzero_hash(reader.array::<32>()?)?,
            })),
            _ => Err(CapitalError::InvalidCanonical(
                "unknown repayment semantics",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollateralRequirement {
    None,
    Required {
        asset: CapitalAsset,
        amount: Amount256,
        liquidation_conditions_hash: Hash32,
    },
}

impl CollateralRequirement {
    fn encode(self, writer: &mut Writer) {
        match self {
            Self::None => writer.u8(1),
            Self::Required {
                asset,
                amount,
                liquidation_conditions_hash,
            } => {
                writer.u8(2);
                asset.encode(writer);
                writer.bytes(amount.as_be_bytes());
                writer.bytes(liquidation_conditions_hash.as_bytes());
            }
        }
    }

    fn decode(reader: &mut Reader<'_>) -> Result<Self, CapitalError> {
        match reader.u8()? {
            1 => Ok(Self::None),
            2 => {
                let asset = CapitalAsset::decode(reader)?;
                let amount = Amount256::from_be_bytes(reader.array::<32>()?);
                if amount.is_zero() {
                    return Err(CapitalError::ZeroValue("collateral_amount"));
                }
                Ok(Self::Required {
                    asset,
                    amount,
                    liquidation_conditions_hash: nonzero_hash(reader.array::<32>()?)?,
                })
            }
            _ => Err(CapitalError::InvalidCanonical(
                "unknown collateral requirement",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockRelease {
    EndOfTransaction,
    EndOfBlock,
    DeadlineBlocks(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemporaryLock {
    None,
    Required {
        asset: CapitalAsset,
        amount: Amount256,
        release: LockRelease,
    },
}

impl TemporaryLock {
    fn encode(self, writer: &mut Writer) {
        match self {
            Self::None => writer.u8(1),
            Self::Required {
                asset,
                amount,
                release,
            } => {
                writer.u8(2);
                asset.encode(writer);
                writer.bytes(amount.as_be_bytes());
                match release {
                    LockRelease::EndOfTransaction => writer.u8(1),
                    LockRelease::EndOfBlock => writer.u8(2),
                    LockRelease::DeadlineBlocks(blocks) => {
                        writer.u8(3);
                        writer.u32(blocks);
                    }
                }
            }
        }
    }

    fn decode(reader: &mut Reader<'_>) -> Result<Self, CapitalError> {
        match reader.u8()? {
            1 => Ok(Self::None),
            2 => {
                let asset = CapitalAsset::decode(reader)?;
                let amount = Amount256::from_be_bytes(reader.array::<32>()?);
                if amount.is_zero() {
                    return Err(CapitalError::ZeroValue("temporary_lock_amount"));
                }
                let release = match reader.u8()? {
                    1 => LockRelease::EndOfTransaction,
                    2 => LockRelease::EndOfBlock,
                    3 => {
                        let blocks = reader.u32()?;
                        if blocks == 0 {
                            return Err(CapitalError::ZeroValue("lock_deadline_blocks"));
                        }
                        LockRelease::DeadlineBlocks(blocks)
                    }
                    _ => {
                        return Err(CapitalError::InvalidCanonical(
                            "unknown lock release semantics",
                        ))
                    }
                };
                Ok(Self::Required {
                    asset,
                    amount,
                    release,
                })
            }
            _ => Err(CapitalError::InvalidCanonical("unknown temporary lock")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UtilizationConstraints {
    pub max_utilization_bps: u16,
    pub min_remaining: Amount256,
}

impl UtilizationConstraints {
    pub fn new(max_utilization_bps: u16, min_remaining: Amount256) -> Result<Self, CapitalError> {
        if max_utilization_bps > 10_000 {
            return Err(CapitalError::InvalidBasisPoints(max_utilization_bps));
        }
        Ok(Self {
            max_utilization_bps,
            min_remaining,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapitalCaps {
    pub protocol_cap: Option<Amount256>,
    pub market_cap: Option<Amount256>,
}

impl CapitalCaps {
    pub const fn none() -> Self {
        Self {
            protocol_cap: None,
            market_cap: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapitalFailureMode {
    SourceUnavailable,
    CapacityChanged,
    FeeChanged,
    ProtocolCapReached,
    MarketCapReached,
    RepaymentFailure,
    CallbackOrHookRevert,
    CollateralLiquidation,
    OracleRisk,
    LiquidityWithdrawal,
    FacilityDisappearance,
    NonAtomicRequirement,
    Unknown,
}

impl CapitalFailureMode {
    const ALL: [Self; 13] = [
        Self::SourceUnavailable,
        Self::CapacityChanged,
        Self::FeeChanged,
        Self::ProtocolCapReached,
        Self::MarketCapReached,
        Self::RepaymentFailure,
        Self::CallbackOrHookRevert,
        Self::CollateralLiquidation,
        Self::OracleRisk,
        Self::LiquidityWithdrawal,
        Self::FacilityDisappearance,
        Self::NonAtomicRequirement,
        Self::Unknown,
    ];

    const fn tag(self) -> u8 {
        match self {
            Self::SourceUnavailable => 1,
            Self::CapacityChanged => 2,
            Self::FeeChanged => 3,
            Self::ProtocolCapReached => 4,
            Self::MarketCapReached => 5,
            Self::RepaymentFailure => 6,
            Self::CallbackOrHookRevert => 7,
            Self::CollateralLiquidation => 8,
            Self::OracleRisk => 9,
            Self::LiquidityWithdrawal => 10,
            Self::FacilityDisappearance => 11,
            Self::NonAtomicRequirement => 12,
            Self::Unknown => 255,
        }
    }

    fn from_tag(tag: u8) -> Result<Self, CapitalError> {
        Self::ALL
            .into_iter()
            .find(|mode| mode.tag() == tag)
            .ok_or(CapitalError::InvalidCanonical("unknown failure mode tag"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapitalEvidenceRef {
    Observation([u8; 32]),
    Artifact(Hash32),
}

impl CapitalEvidenceRef {
    pub fn from_core(value: EvidenceRef) -> Self {
        match value {
            EvidenceRef::Observation(digest) => Self::Observation(*digest.as_bytes()),
            EvidenceRef::Artifact(hash) => Self::Artifact(hash),
        }
    }

    fn encode(self, writer: &mut Writer) {
        match self {
            Self::Observation(digest) => {
                writer.u8(1);
                writer.bytes(&digest);
            }
            Self::Artifact(hash) => {
                writer.u8(2);
                writer.bytes(hash.as_bytes());
            }
        }
    }

    fn decode(reader: &mut Reader<'_>) -> Result<Self, CapitalError> {
        match reader.u8()? {
            1 => {
                let digest = reader.array::<32>()?;
                if digest == [0; 32] {
                    return Err(CapitalError::InvalidCanonical(
                        "zero observation evidence digest",
                    ));
                }
                Ok(Self::Observation(digest))
            }
            2 => Ok(Self::Artifact(nonzero_hash(reader.array::<32>()?)?)),
            _ => Err(CapitalError::InvalidCanonical("unknown evidence ref")),
        }
    }
}

impl From<ObservationDigest> for CapitalEvidenceRef {
    fn from(value: ObservationDigest) -> Self {
        Self::Observation(*value.as_bytes())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CapitalSourceId([u8; 32]);

impl CapitalSourceId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalSource {
    id: CapitalSourceId,
    class: CapitalClass,
    anchor: StateAnchor,
    provider_namespace: u16,
    provider_locator_hash: Hash32,
    provider_kind: CapitalProviderKind,
    source_contract: Option<Address>,
    asset: CapitalAsset,
    maximum_available: Amount256,
    fee_model: FeeModel,
    repayment_asset: CapitalAsset,
    repayment: RepaymentSemantics,
    collateral: CollateralRequirement,
    utilization: UtilizationConstraints,
    caps: CapitalCaps,
    temporary_lock: TemporaryLock,
    failure_modes: Vec<CapitalFailureMode>,
    evidence: Vec<CapitalEvidenceRef>,
}

#[derive(Debug, Clone)]
pub struct CapitalSourceSpec {
    pub class: CapitalClass,
    pub anchor: StateAnchor,
    pub provider_namespace: u16,
    pub provider_locator_hash: Hash32,
    pub provider_kind: CapitalProviderKind,
    pub source_contract: Option<Address>,
    pub asset: CapitalAsset,
    pub maximum_available: Amount256,
    pub fee_model: FeeModel,
    pub repayment_asset: CapitalAsset,
    pub repayment: RepaymentSemantics,
    pub collateral: CollateralRequirement,
    pub utilization: UtilizationConstraints,
    pub caps: CapitalCaps,
    pub temporary_lock: TemporaryLock,
    pub failure_modes: Vec<CapitalFailureMode>,
    pub evidence: Vec<CapitalEvidenceRef>,
}

impl CapitalSource {
    pub fn new(mut spec: CapitalSourceSpec) -> Result<Self, CapitalError> {
        if spec.provider_namespace == 0 {
            return Err(CapitalError::ZeroValue("provider_namespace"));
        }
        if spec.maximum_available.is_zero() {
            return Err(CapitalError::ZeroValue("maximum_available"));
        }
        if spec.failure_modes.is_empty() {
            return Err(CapitalError::EmptyFailureModes);
        }
        spec.failure_modes.sort_unstable();
        spec.failure_modes.dedup();
        if spec.failure_modes.contains(&CapitalFailureMode::Unknown) {
            return Err(CapitalError::UnknownFailureMode);
        }
        spec.evidence.sort_unstable();
        spec.evidence.dedup();
        if spec.evidence.is_empty() {
            return Err(CapitalError::MissingEvidence);
        }

        match (spec.class, spec.repayment) {
            (CapitalClass::PersistentDebt, RepaymentSemantics::Persistent(_)) => {}
            (CapitalClass::PersistentDebt, _) => {
                return Err(CapitalError::PersistentDebtTermsRequired)
            }
            (_, RepaymentSemantics::Persistent(_)) => {
                return Err(CapitalError::PersistentTermsOnNonPersistentSource)
            }
            _ => {}
        }
        if matches!(
            spec.class,
            CapitalClass::CollateralizedBorrowing | CapitalClass::PersistentDebt
        ) && matches!(spec.collateral, CollateralRequirement::None)
        {
            return Err(CapitalError::CollateralSemanticsRequired);
        }
        if spec.class == CapitalClass::IntraBlockTemporaryLock
            && matches!(spec.temporary_lock, TemporaryLock::None)
        {
            return Err(CapitalError::TemporaryLockSemanticsRequired);
        }

        let mut source = Self {
            id: CapitalSourceId([0; 32]),
            class: spec.class,
            anchor: spec.anchor,
            provider_namespace: spec.provider_namespace,
            provider_locator_hash: spec.provider_locator_hash,
            provider_kind: spec.provider_kind,
            source_contract: spec.source_contract,
            asset: spec.asset,
            maximum_available: spec.maximum_available,
            fee_model: spec.fee_model,
            repayment_asset: spec.repayment_asset,
            repayment: spec.repayment,
            collateral: spec.collateral,
            utilization: spec.utilization,
            caps: spec.caps,
            temporary_lock: spec.temporary_lock,
            failure_modes: spec.failure_modes,
            evidence: spec.evidence,
        };
        source.id = CapitalSourceId(domain_hash(SOURCE_DOMAIN, &source.content_bytes()));
        Ok(source)
    }

    pub const fn id(&self) -> CapitalSourceId {
        self.id
    }

    pub const fn class(&self) -> CapitalClass {
        self.class
    }

    pub const fn anchor(&self) -> &StateAnchor {
        &self.anchor
    }

    pub const fn provider_kind(&self) -> CapitalProviderKind {
        self.provider_kind
    }

    pub const fn asset(&self) -> CapitalAsset {
        self.asset
    }

    pub const fn repayment_asset(&self) -> CapitalAsset {
        self.repayment_asset
    }

    pub const fn repayment(&self) -> RepaymentSemantics {
        self.repayment
    }

    pub const fn collateral(&self) -> CollateralRequirement {
        self.collateral
    }

    pub const fn temporary_lock(&self) -> TemporaryLock {
        self.temporary_lock
    }

    pub fn evidence(&self) -> &[CapitalEvidenceRef] {
        &self.evidence
    }

    pub fn effective_capacity(&self) -> Result<Amount256, CapitalError> {
        let mut capacity = self.maximum_available;
        if let Some(cap) = self.caps.protocol_cap {
            capacity = capacity.min(cap);
        }
        if let Some(cap) = self.caps.market_cap {
            capacity = capacity.min(cap);
        }
        capacity = apply_utilization(capacity, self.utilization.max_utilization_bps)?;
        if capacity <= self.utilization.min_remaining {
            return Ok(Amount256::ZERO);
        }
        capacity.checked_sub(self.utilization.min_remaining)
    }

    pub fn canonical_encode(&self) -> Vec<u8> {
        let content = self.content_bytes();
        envelope(SOURCE_MAGIC, &content)
    }

    pub fn decode_canonical(bytes: &[u8]) -> Result<Self, CapitalError> {
        let content = open_envelope(SOURCE_MAGIC, bytes)?;
        let mut reader = Reader::new(content);
        let class = CapitalClass::from_tag(reader.u8()?)?;
        let anchor = decode_anchor(&mut reader)?;
        let provider_namespace = reader.u16()?;
        let provider_locator_hash = nonzero_hash(reader.array::<32>()?)?;
        let provider_kind = CapitalProviderKind::from_tag(reader.u8()?)?;
        let source_contract = match reader.u8()? {
            0 => None,
            1 => Some(
                Address::new(reader.array::<20>()?)
                    .map_err(|_| CapitalError::InvalidCanonical("invalid source contract"))?,
            ),
            _ => {
                return Err(CapitalError::InvalidCanonical(
                    "invalid source contract marker",
                ))
            }
        };
        let asset = CapitalAsset::decode(&mut reader)?;
        let maximum_available = Amount256::from_be_bytes(reader.array::<32>()?);
        let fee_model = FeeModel::decode(&mut reader)?;
        let repayment_asset = CapitalAsset::decode(&mut reader)?;
        let repayment = RepaymentSemantics::decode(&mut reader)?;
        let collateral = CollateralRequirement::decode(&mut reader)?;
        let utilization = UtilizationConstraints::new(
            reader.u16()?,
            Amount256::from_be_bytes(reader.array::<32>()?),
        )?;
        let protocol_cap = decode_optional_amount(&mut reader)?;
        let market_cap = decode_optional_amount(&mut reader)?;
        let temporary_lock = TemporaryLock::decode(&mut reader)?;
        let failure_count = usize::from(reader.u16()?);
        let mut failure_modes = Vec::with_capacity(failure_count);
        for _ in 0..failure_count {
            failure_modes.push(CapitalFailureMode::from_tag(reader.u8()?)?);
        }
        let evidence_count = usize::from(reader.u16()?);
        let mut evidence = Vec::with_capacity(evidence_count);
        for _ in 0..evidence_count {
            evidence.push(CapitalEvidenceRef::decode(&mut reader)?);
        }
        reader.finish()?;
        Self::new(CapitalSourceSpec {
            class,
            anchor,
            provider_namespace,
            provider_locator_hash,
            provider_kind,
            source_contract,
            asset,
            maximum_available,
            fee_model,
            repayment_asset,
            repayment,
            collateral,
            utilization,
            caps: CapitalCaps {
                protocol_cap,
                market_cap,
            },
            temporary_lock,
            failure_modes,
            evidence,
        })
    }

    fn content_bytes(&self) -> Vec<u8> {
        let mut writer = Writer::default();
        writer.u8(self.class.tag());
        encode_anchor(&self.anchor, &mut writer);
        writer.u16(self.provider_namespace);
        writer.bytes(self.provider_locator_hash.as_bytes());
        writer.u8(self.provider_kind.tag());
        match self.source_contract {
            None => writer.u8(0),
            Some(address) => {
                writer.u8(1);
                writer.bytes(address.as_bytes());
            }
        }
        self.asset.encode(&mut writer);
        writer.bytes(self.maximum_available.as_be_bytes());
        self.fee_model.encode(&mut writer);
        self.repayment_asset.encode(&mut writer);
        self.repayment.encode(&mut writer);
        self.collateral.encode(&mut writer);
        writer.u16(self.utilization.max_utilization_bps);
        writer.bytes(self.utilization.min_remaining.as_be_bytes());
        encode_optional_amount(self.caps.protocol_cap, &mut writer);
        encode_optional_amount(self.caps.market_cap, &mut writer);
        self.temporary_lock.encode(&mut writer);
        writer.u16(u16::try_from(self.failure_modes.len()).unwrap_or(u16::MAX));
        for mode in &self.failure_modes {
            writer.u8(mode.tag());
        }
        writer.u16(u16::try_from(self.evidence.len()).unwrap_or(u16::MAX));
        for evidence in &self.evidence {
            evidence.encode(&mut writer);
        }
        writer.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CapitalTargetId([u8; 32]);

impl CapitalTargetId {
    pub fn from_census_unit(value: CensusUnitId) -> Self {
        Self(*value.as_bytes())
    }

    pub fn from_hash(hash: Hash32) -> Self {
        Self(*hash.as_bytes())
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RequirementKind {
    ActionPrincipal,
    Gas,
    ProtocolFee,
    FundingFee,
    BuilderOrSolverDeposit,
    Inventory,
    Collateral,
    PersistentDebtPrincipal,
    Repayment,
    TemporaryLock,
}

impl RequirementKind {
    const ALL: [Self; 10] = [
        Self::ActionPrincipal,
        Self::Gas,
        Self::ProtocolFee,
        Self::FundingFee,
        Self::BuilderOrSolverDeposit,
        Self::Inventory,
        Self::Collateral,
        Self::PersistentDebtPrincipal,
        Self::Repayment,
        Self::TemporaryLock,
    ];

    const fn tag(self) -> u8 {
        match self {
            Self::ActionPrincipal => 1,
            Self::Gas => 2,
            Self::ProtocolFee => 3,
            Self::FundingFee => 4,
            Self::BuilderOrSolverDeposit => 5,
            Self::Inventory => 6,
            Self::Collateral => 7,
            Self::PersistentDebtPrincipal => 8,
            Self::Repayment => 9,
            Self::TemporaryLock => 10,
        }
    }

    fn from_tag(tag: u8) -> Result<Self, CapitalError> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.tag() == tag)
            .ok_or(CapitalError::InvalidCanonical("unknown requirement kind"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequiredAtomicity {
    SameTransaction,
    SameBlock,
    Flexible,
}

impl RequiredAtomicity {
    const fn tag(self) -> u8 {
        match self {
            Self::SameTransaction => 1,
            Self::SameBlock => 2,
            Self::Flexible => 3,
        }
    }

    fn from_tag(tag: u8) -> Result<Self, CapitalError> {
        match tag {
            1 => Ok(Self::SameTransaction),
            2 => Ok(Self::SameBlock),
            3 => Ok(Self::Flexible),
            _ => Err(CapitalError::InvalidCanonical("unknown required atomicity")),
        }
    }

    fn accepts(self, repayment: RepaymentSemantics) -> bool {
        match self {
            Self::SameTransaction => matches!(repayment, RepaymentSemantics::AtomicSameTransaction),
            Self::SameBlock => matches!(
                repayment,
                RepaymentSemantics::AtomicSameTransaction | RepaymentSemantics::SameBlock
            ),
            Self::Flexible => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CapitalRequirementLeg {
    kind: RequirementKind,
    asset: CapitalAsset,
    amount: Amount256,
    allowed_classes: Vec<CapitalClass>,
}

impl CapitalRequirementLeg {
    pub fn new(
        kind: RequirementKind,
        asset: CapitalAsset,
        amount: Amount256,
        mut allowed_classes: Vec<CapitalClass>,
    ) -> Result<Self, CapitalError> {
        if amount.is_zero() {
            return Err(CapitalError::ZeroValue("requirement_amount"));
        }
        if allowed_classes.is_empty() {
            return Err(CapitalError::MissingAllowedClass);
        }
        let original = allowed_classes.len();
        allowed_classes.sort_unstable();
        allowed_classes.dedup();
        if allowed_classes.len() != original {
            return Err(CapitalError::DuplicateAllowedClass);
        }
        if kind == RequirementKind::Gas {
            if asset != CapitalAsset::NativeGas {
                return Err(CapitalError::GasLegMustUseNativeAsset);
            }
            if !allowed_classes.contains(&CapitalClass::GasFunding) {
                return Err(CapitalError::GasLegMustAllowGasFunding);
            }
        }
        Ok(Self {
            kind,
            asset,
            amount,
            allowed_classes,
        })
    }

    pub const fn kind(&self) -> RequirementKind {
        self.kind
    }

    pub const fn asset(&self) -> CapitalAsset {
        self.asset
    }

    pub const fn amount(&self) -> Amount256 {
        self.amount
    }

    pub fn allowed_classes(&self) -> &[CapitalClass] {
        &self.allowed_classes
    }

    fn encode(&self, writer: &mut Writer) {
        writer.u8(self.kind.tag());
        self.asset.encode(writer);
        writer.bytes(self.amount.as_be_bytes());
        writer.u16(u16::try_from(self.allowed_classes.len()).unwrap_or(u16::MAX));
        for class in &self.allowed_classes {
            writer.u8(class.tag());
        }
    }

    fn decode(reader: &mut Reader<'_>) -> Result<Self, CapitalError> {
        let kind = RequirementKind::from_tag(reader.u8()?)?;
        let asset = CapitalAsset::decode(reader)?;
        let amount = Amount256::from_be_bytes(reader.array::<32>()?);
        let count = usize::from(reader.u16()?);
        let mut allowed = Vec::with_capacity(count);
        for _ in 0..count {
            allowed.push(CapitalClass::from_tag(reader.u8()?)?);
        }
        Self::new(kind, asset, amount, allowed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CapitalRequirementId([u8; 32]);

impl CapitalRequirementId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalRequirement {
    id: CapitalRequirementId,
    target: CapitalTargetId,
    anchor: StateAnchor,
    atomicity: RequiredAtomicity,
    requires_native_gas: bool,
    legs: Vec<CapitalRequirementLeg>,
    evidence: Vec<CapitalEvidenceRef>,
}

impl CapitalRequirement {
    pub fn new(
        target: CapitalTargetId,
        anchor: StateAnchor,
        atomicity: RequiredAtomicity,
        requires_native_gas: bool,
        mut legs: Vec<CapitalRequirementLeg>,
        mut evidence: Vec<CapitalEvidenceRef>,
    ) -> Result<Self, CapitalError> {
        if legs.is_empty() {
            return Err(CapitalError::ZeroValue("capital_requirement_legs"));
        }
        legs.sort_unstable();
        if legs.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(CapitalError::DuplicateLeg);
        }
        evidence.sort_unstable();
        evidence.dedup();
        if evidence.is_empty() {
            return Err(CapitalError::MissingEvidence);
        }
        let gas_present = legs.iter().any(|leg| leg.kind == RequirementKind::Gas);
        if requires_native_gas && !gas_present {
            return Err(CapitalError::NativeGasRequiredButMissing);
        }

        let mut requirement = Self {
            id: CapitalRequirementId([0; 32]),
            target,
            anchor,
            atomicity,
            requires_native_gas,
            legs,
            evidence,
        };
        requirement.id = CapitalRequirementId(domain_hash(
            REQUIREMENT_DOMAIN,
            &requirement.content_bytes(),
        ));
        Ok(requirement)
    }

    pub const fn id(&self) -> CapitalRequirementId {
        self.id
    }

    pub const fn target(&self) -> CapitalTargetId {
        self.target
    }

    pub const fn anchor(&self) -> &StateAnchor {
        &self.anchor
    }

    pub const fn atomicity(&self) -> RequiredAtomicity {
        self.atomicity
    }

    pub fn legs(&self) -> &[CapitalRequirementLeg] {
        &self.legs
    }

    pub fn canonical_encode(&self) -> Vec<u8> {
        envelope(REQUIREMENT_MAGIC, &self.content_bytes())
    }

    pub fn decode_canonical(bytes: &[u8]) -> Result<Self, CapitalError> {
        let content = open_envelope(REQUIREMENT_MAGIC, bytes)?;
        let mut reader = Reader::new(content);
        let target_bytes = reader.array::<32>()?;
        if target_bytes == [0; 32] {
            return Err(CapitalError::InvalidCanonical("zero target id"));
        }
        let target = CapitalTargetId(target_bytes);
        let anchor = decode_anchor(&mut reader)?;
        let atomicity = RequiredAtomicity::from_tag(reader.u8()?)?;
        let requires_native_gas = match reader.u8()? {
            0 => false,
            1 => true,
            _ => return Err(CapitalError::InvalidCanonical("invalid boolean")),
        };
        let leg_count = usize::from(reader.u16()?);
        let mut legs = Vec::with_capacity(leg_count);
        for _ in 0..leg_count {
            legs.push(CapitalRequirementLeg::decode(&mut reader)?);
        }
        let evidence_count = usize::from(reader.u16()?);
        let mut evidence = Vec::with_capacity(evidence_count);
        for _ in 0..evidence_count {
            evidence.push(CapitalEvidenceRef::decode(&mut reader)?);
        }
        reader.finish()?;
        Self::new(
            target,
            anchor,
            atomicity,
            requires_native_gas,
            legs,
            evidence,
        )
    }

    fn content_bytes(&self) -> Vec<u8> {
        let mut writer = Writer::default();
        writer.bytes(self.target.as_bytes());
        encode_anchor(&self.anchor, &mut writer);
        writer.u8(self.atomicity.tag());
        writer.u8(u8::from(self.requires_native_gas));
        writer.u16(u16::try_from(self.legs.len()).unwrap_or(u16::MAX));
        for leg in &self.legs {
            leg.encode(&mut writer);
        }
        writer.u16(u16::try_from(self.evidence.len()).unwrap_or(u16::MAX));
        for evidence in &self.evidence {
            evidence.encode(&mut writer);
        }
        writer.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeasibilityRejection {
    AnchorMismatch,
    NoCompatibleSource,
    InsufficientCapacity,
    MissingGasFunding,
    OperatorOwnedCapitalRequired,
    AtomicityMismatch,
    RepaymentRequirementMissing,
    CollateralRequirementUnfunded,
    TemporaryLockUnfunded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceAllocation {
    pub source_id: CapitalSourceId,
    pub leg_kind: RequirementKind,
    pub amount: Amount256,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapitalFeasibility {
    Feasible {
        requirement_id: CapitalRequirementId,
        allocations: Vec<SourceAllocation>,
    },
    Rejected {
        requirement_id: CapitalRequirementId,
        reason: FeasibilityRejection,
        failed_leg: Option<RequirementKind>,
    },
}

pub fn evaluate_capital_feasibility(
    requirement: &CapitalRequirement,
    sources: &[CapitalSource],
) -> CapitalFeasibility {
    if sources
        .iter()
        .any(|source| source.anchor() != requirement.anchor())
    {
        let same_anchor_exists = sources
            .iter()
            .any(|source| source.anchor() == requirement.anchor());
        if !same_anchor_exists {
            return rejected(requirement, FeasibilityRejection::AnchorMismatch, None);
        }
    }

    let mut ordered = sources.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|source| source.id());
    let mut remaining = ordered
        .iter()
        .map(|source| source.effective_capacity().unwrap_or(Amount256::ZERO))
        .collect::<Vec<_>>();
    let mut allocations = Vec::new();
    let mut used_sources = BTreeSet::new();

    for leg in requirement.legs() {
        let mut need = leg.amount();
        let mut any_asset_class = false;
        let mut any_atomic = false;
        for (index, source) in ordered.iter().enumerate() {
            if source.anchor() != requirement.anchor()
                || source.asset() != leg.asset()
                || !leg.allowed_classes().contains(&source.class())
            {
                continue;
            }
            if source.provider_kind().is_operator_owned() {
                return rejected(
                    requirement,
                    FeasibilityRejection::OperatorOwnedCapitalRequired,
                    Some(leg.kind()),
                );
            }
            any_asset_class = true;
            if !requirement.atomicity().accepts(source.repayment()) {
                continue;
            }
            any_atomic = true;
            if remaining[index].is_zero() {
                continue;
            }
            let take = remaining[index].min(need);
            if take.is_zero() {
                continue;
            }
            remaining[index] = remaining[index]
                .checked_sub(take)
                .unwrap_or(Amount256::ZERO);
            need = need.checked_sub(take).unwrap_or(Amount256::ZERO);
            allocations.push(SourceAllocation {
                source_id: source.id(),
                leg_kind: leg.kind(),
                amount: take,
            });
            used_sources.insert(index);
            if need.is_zero() {
                break;
            }
        }

        if !need.is_zero() {
            let reason = if leg.kind() == RequirementKind::Gas {
                FeasibilityRejection::MissingGasFunding
            } else if any_asset_class && !any_atomic {
                FeasibilityRejection::AtomicityMismatch
            } else if any_asset_class {
                FeasibilityRejection::InsufficientCapacity
            } else {
                FeasibilityRejection::NoCompatibleSource
            };
            return rejected(requirement, reason, Some(leg.kind()));
        }
    }

    for index in used_sources {
        let source = ordered[index];
        if !has_leg(
            requirement,
            RequirementKind::Repayment,
            source.repayment_asset(),
        ) {
            return rejected(
                requirement,
                FeasibilityRejection::RepaymentRequirementMissing,
                Some(RequirementKind::Repayment),
            );
        }
        if let CollateralRequirement::Required { asset, amount, .. } = source.collateral() {
            if !has_sufficient_leg(requirement, RequirementKind::Collateral, asset, amount) {
                return rejected(
                    requirement,
                    FeasibilityRejection::CollateralRequirementUnfunded,
                    Some(RequirementKind::Collateral),
                );
            }
        }
        if let TemporaryLock::Required { asset, amount, .. } = source.temporary_lock() {
            if !has_sufficient_leg(requirement, RequirementKind::TemporaryLock, asset, amount) {
                return rejected(
                    requirement,
                    FeasibilityRejection::TemporaryLockUnfunded,
                    Some(RequirementKind::TemporaryLock),
                );
            }
        }
    }

    CapitalFeasibility::Feasible {
        requirement_id: requirement.id(),
        allocations,
    }
}

fn has_leg(requirement: &CapitalRequirement, kind: RequirementKind, asset: CapitalAsset) -> bool {
    requirement
        .legs()
        .iter()
        .any(|leg| leg.kind() == kind && leg.asset() == asset)
}

fn has_sufficient_leg(
    requirement: &CapitalRequirement,
    kind: RequirementKind,
    asset: CapitalAsset,
    amount: Amount256,
) -> bool {
    requirement
        .legs()
        .iter()
        .any(|leg| leg.kind() == kind && leg.asset() == asset && leg.amount() >= amount)
}

fn rejected(
    requirement: &CapitalRequirement,
    reason: FeasibilityRejection,
    failed_leg: Option<RequirementKind>,
) -> CapitalFeasibility {
    CapitalFeasibility::Rejected {
        requirement_id: requirement.id(),
        reason,
        failed_leg,
    }
}

fn apply_utilization(amount: Amount256, bps: u16) -> Result<Amount256, CapitalError> {
    if bps > 10_000 {
        return Err(CapitalError::InvalidBasisPoints(bps));
    }
    if bps == 10_000 {
        return Ok(amount);
    }
    if bps == 0 {
        return Ok(Amount256::ZERO);
    }

    // Exact integer floor(amount * bps / 10_000) across the full 256-bit domain.
    // This streams the base-256 digits while carrying only the division remainder,
    // so no intermediate 256-bit multiplication can overflow.
    let numerator = u32::from(bps);
    let denominator = 10_000_u32;
    let mut remainder = 0_u32;
    let mut out = [0_u8; 32];
    for (index, byte) in amount.0.iter().copied().enumerate() {
        let expanded = remainder
            .checked_mul(256)
            .and_then(|value| value.checked_add(u32::from(byte) * numerator))
            .ok_or(CapitalError::InvalidCanonical(
                "utilization arithmetic overflow",
            ))?;
        let quotient_digit = expanded / denominator;
        if quotient_digit > 255 {
            return Err(CapitalError::InvalidCanonical(
                "utilization quotient digit overflow",
            ));
        }
        out[index] = u8::try_from(quotient_digit)
            .map_err(|_| CapitalError::InvalidCanonical("utilization quotient conversion"))?;
        remainder = expanded % denominator;
    }
    Ok(Amount256::from_be_bytes(out))
}

fn encode_anchor(anchor: &StateAnchor, writer: &mut Writer) {
    writer.u64(anchor.chain().chain_id());
    writer.bytes(anchor.chain().genesis_hash().as_bytes());
    writer.bytes(anchor.chain().fork_lineage().as_bytes());
    writer.u64(anchor.block_number());
    writer.bytes(anchor.block_hash().as_bytes());
    writer.bytes(anchor.parent_hash().as_bytes());
    writer.u64(anchor.timestamp());
    writer.bytes(anchor.state_root().as_bytes());
}

fn decode_anchor(reader: &mut Reader<'_>) -> Result<StateAnchor, CapitalError> {
    let chain = ChainDomain::new(
        reader.u64()?,
        nonzero_hash(reader.array::<32>()?)?,
        nonzero_hash(reader.array::<32>()?)?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid chain domain"))?;
    StateAnchor::new(
        chain,
        reader.u64()?,
        nonzero_hash(reader.array::<32>()?)?,
        nonzero_hash(reader.array::<32>()?)?,
        reader.u64()?,
        nonzero_hash(reader.array::<32>()?)?,
    )
    .map_err(|_| CapitalError::InvalidCanonical("invalid state anchor"))
}

fn encode_optional_amount(value: Option<Amount256>, writer: &mut Writer) {
    match value {
        None => writer.u8(0),
        Some(amount) => {
            writer.u8(1);
            writer.bytes(amount.as_be_bytes());
        }
    }
}

fn decode_optional_amount(reader: &mut Reader<'_>) -> Result<Option<Amount256>, CapitalError> {
    match reader.u8()? {
        0 => Ok(None),
        1 => Ok(Some(Amount256::from_be_bytes(reader.array::<32>()?))),
        _ => Err(CapitalError::InvalidCanonical(
            "invalid optional amount marker",
        )),
    }
}

fn nonzero_hash(bytes: [u8; 32]) -> Result<Hash32, CapitalError> {
    Hash32::new(bytes).map_err(|_| CapitalError::InvalidCanonical("zero hash"))
}

fn envelope(magic: &[u8], content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(magic.len() + 2 + 4 + content.len() + 32);
    out.extend_from_slice(magic);
    out.extend_from_slice(&CAPITAL_SCHEMA_VERSION.to_be_bytes());
    out.extend_from_slice(
        &u32::try_from(content.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    out.extend_from_slice(content);
    out.extend_from_slice(&domain_hash(magic, content));
    out
}

fn open_envelope<'a>(magic: &[u8], bytes: &'a [u8]) -> Result<&'a [u8], CapitalError> {
    let minimum = magic.len() + 2 + 4 + 32;
    if bytes.len() < minimum || &bytes[..magic.len()] != magic {
        return Err(CapitalError::WrongCanonicalType);
    }
    let version_start = magic.len();
    let version = u16::from_be_bytes(
        bytes[version_start..version_start + 2]
            .try_into()
            .map_err(|_| CapitalError::InvalidCanonical("version"))?,
    );
    if version != CAPITAL_SCHEMA_VERSION {
        return Err(CapitalError::InvalidCanonical("schema version"));
    }
    let length_start = version_start + 2;
    let content_len = u32::from_be_bytes(
        bytes[length_start..length_start + 4]
            .try_into()
            .map_err(|_| CapitalError::InvalidCanonical("content length"))?,
    ) as usize;
    let content_start = length_start + 4;
    let digest_start = content_start
        .checked_add(content_len)
        .ok_or(CapitalError::InvalidCanonical("content length overflow"))?;
    if digest_start + 32 != bytes.len() {
        return Err(CapitalError::InvalidCanonical("length mismatch"));
    }
    let content = &bytes[content_start..digest_start];
    if bytes[digest_start..] != domain_hash(magic, content) {
        return Err(CapitalError::CanonicalDigestMismatch);
    }
    Ok(content)
}

fn domain_hash(domain: &[u8], payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    hasher.update(payload);
    let digest = hasher.finalize();
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

#[derive(Default)]
struct Writer(Vec<u8>);

impl Writer {
    fn bytes(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }

    fn u8(&mut self, value: u8) {
        self.0.push(value);
    }

    fn u16(&mut self, value: u16) {
        self.bytes(&value.to_be_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes(&value.to_be_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes(&value.to_be_bytes());
    }

    fn u128(&mut self, value: u128) {
        self.bytes(&value.to_be_bytes());
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], CapitalError> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or(CapitalError::InvalidCanonical("offset overflow"))?;
        if end > self.bytes.len() {
            return Err(CapitalError::InvalidCanonical("truncated bytes"));
        }
        let out = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(out)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], CapitalError> {
        self.take(N)?
            .try_into()
            .map_err(|_| CapitalError::InvalidCanonical("array width"))
    }

    fn u8(&mut self) -> Result<u8, CapitalError> {
        Ok(self.array::<1>()?[0])
    }

    fn u16(&mut self) -> Result<u16, CapitalError> {
        Ok(u16::from_be_bytes(self.array::<2>()?))
    }

    fn u32(&mut self) -> Result<u32, CapitalError> {
        Ok(u32::from_be_bytes(self.array::<4>()?))
    }

    fn u64(&mut self) -> Result<u64, CapitalError> {
        Ok(u64::from_be_bytes(self.array::<8>()?))
    }

    fn u128(&mut self) -> Result<u128, CapitalError> {
        Ok(u128::from_be_bytes(self.array::<16>()?))
    }

    fn finish(self) -> Result<(), CapitalError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(CapitalError::InvalidCanonical("trailing bytes"))
        }
    }
}

impl PartialOrd for CapitalSource {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.id.cmp(&other.id))
    }
}
