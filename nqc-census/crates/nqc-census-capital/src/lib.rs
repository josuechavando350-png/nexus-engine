//! Protocol-agnostic, evidence-bound capital semantics for RMC-011.
//!
//! The core model makes no profitability claims. Live discovery is isolated in explicit
//! evidence-bound acquisition modules; all economic authority still flows through exact integer
//! capital sources, candidate requirements, deterministic identities, and fail-closed feasibility.

pub mod aave_debt_discovery;
pub mod adapters;
pub mod artifacts;
pub mod balancer_live;
pub mod demands;
pub mod external_debt;
pub mod gas_credit;
pub mod gas_sponsor;
pub mod permissionless_atomic;
pub mod replay;
pub mod source_authority;
pub mod transient_credit;
pub mod uniswap_v3_acquire;
pub mod uniswap_v3_live;
pub mod upstream;

use nqc_census_core::{
    Address, CensusUnitId, ChainDomain, EvidenceRef, Hash32, ObservationDigest, StateAnchor,
};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt::{Display, Formatter},
};

pub const CAPITAL_SCHEMA_VERSION: u16 = 5;

const SOURCE_MAGIC: &[u8] = b"NQC-CAP-SOURCE";
const REQUIREMENT_MAGIC: &[u8] = b"NQC-CAP-REQUIREMENT";
const SOURCE_KEY_DOMAIN: &[u8] = b"NQC-RMC011-CAPITAL-SOURCE-KEY-V1";
const SOURCE_DOMAIN: &[u8] = b"NQC-RMC011-CAPITAL-SOURCE-ID-V2";
const REQUIREMENT_DOMAIN: &[u8] = b"NQC-RMC011-CAPITAL-REQUIREMENT-ID-V1";
const LEDGER_DOMAIN: &[u8] = b"NQC-RMC011-CAPITAL-LEDGER-COMMITMENT-V2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapitalError {
    ZeroValue(&'static str),
    InvalidBasisPoints(u16),
    InvalidRatio,
    MissingEvidence,
    EmptyFailureModes,
    UnknownFailureMode,
    OwnershipProviderMismatch,
    MissingAllowedClass,
    DuplicateAllowedClass,
    DuplicateLeg,
    GasLegMustUseNativeAsset,
    GasLegMustAllowGasFunding,
    GasLegMustUseGasFundingOnly,
    NativeGasRequiredButMissing,
    NativeGasLegWithoutRequirementFlag,
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
    DuplicateSource,
    ConflictingSourceState,
    DuplicateRequirement,
    MissingSourceForAllocation,
    OperatorOwnedAllocation,
    UnevaluatedRequirement,
    NonEvidentiaryLedger,
    EmptyCapitalCensus,
    SettlementRequirementMismatch,
    RejectedFeasibilityHasNoObligations,
    InvalidGitObjectId,
    InvalidUpstreamAuthority(&'static str),
    UnresolvedEvidenceRef,
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
            Self::OwnershipProviderMismatch => {
                f.write_str("operator treasury cannot be classified as externally owned capital")
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
            Self::GasLegMustUseGasFundingOnly => {
                f.write_str("gas funding leg must permit only GAS_FUNDING capital")
            }
            Self::NativeGasRequiredButMissing => {
                f.write_str("candidate requires native gas but no gas leg exists")
            }
            Self::NativeGasLegWithoutRequirementFlag => {
                f.write_str("candidate declares a native gas leg but requires_native_gas is false")
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
                f.write_str("zero-own-capital policy forbids operator-owned funding")
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
            Self::DuplicateSource => f.write_str("duplicate capital source id"),
            Self::ConflictingSourceState => {
                f.write_str("same capital source key has multiple observed states in one census")
            }
            Self::DuplicateRequirement => f.write_str("duplicate capital requirement id"),
            Self::MissingSourceForAllocation => {
                f.write_str("feasibility allocation references an unknown capital source")
            }
            Self::OperatorOwnedAllocation => {
                f.write_str("feasible allocation uses operator-owned capital")
            }
            Self::UnevaluatedRequirement => {
                f.write_str("capital ledger contains requirement without feasibility result")
            }
            Self::NonEvidentiaryLedger => {
                f.write_str("synthetic capital ledger cannot be certified as real evidence")
            }
            Self::EmptyCapitalCensus => {
                f.write_str("capital census certification requires at least one observed source")
            }
            Self::SettlementRequirementMismatch => {
                f.write_str("candidate settlement requirements differ from source obligations")
            }
            Self::RejectedFeasibilityHasNoObligations => {
                f.write_str("rejected capital feasibility has no settlement obligations")
            }
            Self::InvalidGitObjectId => f.write_str("invalid 40-hex git object id"),
            Self::InvalidUpstreamAuthority(reason) => {
                write!(f, "invalid upstream capital authority: {reason}")
            }
            Self::UnresolvedEvidenceRef => {
                f.write_str("capital evidence reference is not admitted by upstream authority")
            }
        }
    }
}

impl std::error::Error for CapitalError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Amount256([u8; 32]);

impl Amount256 {
    pub const ZERO: Self = Self([0; 32]);
    pub const MAX: Self = Self([0xff; 32]);

    pub const fn from_be_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn from_u128(value: u128) -> Self {
        let mut bytes = [0_u8; 32];
        bytes[16..].copy_from_slice(&value.to_be_bytes());
        Self(bytes)
    }

    pub fn parse_decimal(value: &str) -> Result<Self, CapitalError> {
        if value.is_empty() {
            return Err(CapitalError::InvalidCanonical("empty decimal amount"));
        }
        if value.len() > 1 && value.as_bytes().first() == Some(&b'0') {
            return Err(CapitalError::InvalidCanonical(
                "non-canonical decimal amount",
            ));
        }
        let mut out = [0_u8; 32];
        for digit in value.bytes() {
            if !digit.is_ascii_digit() {
                return Err(CapitalError::InvalidCanonical(
                    "decimal amount contains non-digit",
                ));
            }
            let mut carry = u16::from(digit - b'0');
            for byte in out.iter_mut().rev() {
                let expanded = u16::from(*byte) * 10 + carry;
                *byte = u8::try_from(expanded & 0xff)
                    .map_err(|_| CapitalError::InvalidCanonical("decimal amount conversion"))?;
                carry = expanded >> 8;
            }
            if carry != 0 {
                return Err(CapitalError::InvalidCanonical(
                    "decimal amount exceeds uint256",
                ));
            }
        }
        Ok(Self(out))
    }

    pub const fn as_be_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }

    pub fn is_zero(self) -> bool {
        self.0 == [0; 32]
    }

    pub fn checked_add(self, rhs: Self) -> Result<Self, CapitalError> {
        let mut out = [0_u8; 32];
        let mut carry = 0_u16;
        for index in (0..32).rev() {
            let sum = u16::from(self.0[index]) + u16::from(rhs.0[index]) + carry;
            out[index] = u8::try_from(sum & 0xff)
                .map_err(|_| CapitalError::InvalidCanonical("amount addition conversion"))?;
            carry = sum >> 8;
        }
        if carry != 0 {
            return Err(CapitalError::InvalidCanonical("amount addition overflow"));
        }
        Ok(Self(out))
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapitalOwnership {
    External,
    OperatorOwned,
}

impl CapitalOwnership {
    pub const fn code(self) -> &'static str {
        match self {
            Self::External => "EXTERNAL",
            Self::OperatorOwned => "OPERATOR_OWNED",
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::External => 1,
            Self::OperatorOwned => 2,
        }
    }

    fn from_tag(tag: u8) -> Result<Self, CapitalError> {
        match tag {
            1 => Ok(Self::External),
            2 => Ok(Self::OperatorOwned),
            _ => Err(CapitalError::InvalidCanonical("unknown capital ownership")),
        }
    }

    pub const fn is_operator_owned(self) -> bool {
        matches!(self, Self::OperatorOwned)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapitalAsset {
    NativeGas,
    Token(Address),
}

impl CapitalAsset {
    pub fn code(self) -> String {
        match self {
            Self::NativeGas => "NATIVE_GAS".to_owned(),
            Self::Token(address) => format!("TOKEN:{}", address.to_hex()),
        }
    }

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
pub enum RoundingMode {
    Floor,
    Ceil,
    HalfUp,
}

impl RoundingMode {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Floor => "FLOOR",
            Self::Ceil => "CEIL",
            Self::HalfUp => "HALF_UP",
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::Floor => 1,
            Self::Ceil => 2,
            Self::HalfUp => 3,
        }
    }

    fn from_tag(tag: u8) -> Result<Self, CapitalError> {
        match tag {
            1 => Ok(Self::Floor),
            2 => Ok(Self::Ceil),
            3 => Ok(Self::HalfUp),
            _ => Err(CapitalError::InvalidCanonical("unknown rounding mode")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeModel {
    None,
    BasisPoints {
        bps: u16,
        rounding: RoundingMode,
    },
    Fixed {
        asset: CapitalAsset,
        amount: Amount256,
    },
    ExactRatio {
        numerator: u64,
        denominator: u64,
        rounding: RoundingMode,
    },
}

impl FeeModel {
    pub fn basis_points(value: u16) -> Result<Self, CapitalError> {
        Self::basis_points_with_rounding(value, RoundingMode::Floor)
    }

    pub fn basis_points_with_rounding(
        value: u16,
        rounding: RoundingMode,
    ) -> Result<Self, CapitalError> {
        if value > 10_000 {
            return Err(CapitalError::InvalidBasisPoints(value));
        }
        Ok(Self::BasisPoints {
            bps: value,
            rounding,
        })
    }

    pub fn exact_ratio(numerator: u64, denominator: u64) -> Result<Self, CapitalError> {
        Self::exact_ratio_with_rounding(numerator, denominator, RoundingMode::Floor)
    }

    pub fn exact_ratio_with_rounding(
        numerator: u64,
        denominator: u64,
        rounding: RoundingMode,
    ) -> Result<Self, CapitalError> {
        if denominator == 0 {
            return Err(CapitalError::InvalidRatio);
        }
        Ok(Self::ExactRatio {
            numerator,
            denominator,
            rounding,
        })
    }

    pub fn quote(
        self,
        drawn_amount: Amount256,
        default_asset: CapitalAsset,
    ) -> Result<Option<FeeQuote>, CapitalError> {
        match self {
            Self::None => Ok(None),
            Self::BasisPoints { bps, rounding } => Ok(Some(FeeQuote {
                asset: default_asset,
                amount: mul_div_u64_round(drawn_amount, u64::from(bps), 10_000, rounding)?,
            })),
            Self::Fixed { asset, amount } => Ok(Some(FeeQuote { asset, amount })),
            Self::ExactRatio {
                numerator,
                denominator,
                rounding,
            } => Ok(Some(FeeQuote {
                asset: default_asset,
                amount: mul_div_u64_round(drawn_amount, numerator, denominator, rounding)?,
            })),
        }
    }

    fn encode(self, writer: &mut Writer) {
        match self {
            Self::None => writer.u8(1),
            Self::BasisPoints { bps, rounding } => {
                writer.u8(2);
                writer.u16(bps);
                writer.u8(rounding.tag());
            }
            Self::Fixed { asset, amount } => {
                writer.u8(3);
                asset.encode(writer);
                writer.bytes(amount.as_be_bytes());
            }
            Self::ExactRatio {
                numerator,
                denominator,
                rounding,
            } => {
                writer.u8(4);
                writer.u64(numerator);
                writer.u64(denominator);
                writer.u8(rounding.tag());
            }
        }
    }

    fn decode(reader: &mut Reader<'_>) -> Result<Self, CapitalError> {
        match reader.u8()? {
            1 => Ok(Self::None),
            2 => Self::basis_points_with_rounding(
                reader.u16()?,
                RoundingMode::from_tag(reader.u8()?)?,
            ),
            3 => Ok(Self::Fixed {
                asset: CapitalAsset::decode(reader)?,
                amount: Amount256::from_be_bytes(reader.array::<32>()?),
            }),
            4 => Self::exact_ratio_with_rounding(
                reader.u64()?,
                reader.u64()?,
                RoundingMode::from_tag(reader.u8()?)?,
            ),
            _ => Err(CapitalError::InvalidCanonical("unknown fee model")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeQuote {
    pub asset: CapitalAsset,
    pub amount: Amount256,
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
    NoRepayment,
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
            Self::NoRepayment => writer.u8(5),
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
            5 => Ok(Self::NoRepayment),
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
    Proportional {
        asset: CapitalAsset,
        numerator: u64,
        denominator: u64,
        rounding: RoundingMode,
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
            Self::Proportional {
                asset,
                numerator,
                denominator,
                rounding,
                liquidation_conditions_hash,
            } => {
                writer.u8(3);
                asset.encode(writer);
                writer.u64(numerator);
                writer.u64(denominator);
                writer.u8(rounding.tag());
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
            3 => {
                let asset = CapitalAsset::decode(reader)?;
                let numerator = reader.u64()?;
                let denominator = reader.u64()?;
                let rounding = RoundingMode::from_tag(reader.u8()?)?;
                if numerator == 0 || denominator == 0 {
                    return Err(CapitalError::InvalidRatio);
                }
                if rounding != RoundingMode::Ceil {
                    return Err(CapitalError::InvalidCanonical(
                        "proportional collateral must round up",
                    ));
                }
                Ok(Self::Proportional {
                    asset,
                    numerator,
                    denominator,
                    rounding,
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

    pub const fn code(self) -> &'static str {
        match self {
            Self::SourceUnavailable => "SOURCE_UNAVAILABLE",
            Self::CapacityChanged => "CAPACITY_CHANGED",
            Self::FeeChanged => "FEE_CHANGED",
            Self::ProtocolCapReached => "PROTOCOL_CAP_REACHED",
            Self::MarketCapReached => "MARKET_CAP_REACHED",
            Self::RepaymentFailure => "REPAYMENT_FAILURE",
            Self::CallbackOrHookRevert => "CALLBACK_OR_HOOK_REVERT",
            Self::CollateralLiquidation => "COLLATERAL_LIQUIDATION",
            Self::OracleRisk => "ORACLE_RISK",
            Self::LiquidityWithdrawal => "LIQUIDITY_WITHDRAWAL",
            Self::FacilityDisappearance => "FACILITY_DISAPPEARANCE",
            Self::NonAtomicRequirement => "NON_ATOMIC_REQUIREMENT",
            Self::Unknown => "UNKNOWN",
        }
    }

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

fn validate_execution_blocker_code(code: &str) -> Result<(), CapitalError> {
    if code.is_empty()
        || code.len() > 128
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(CapitalError::InvalidCanonical(
            "invalid execution blocker code",
        ));
    }
    Ok(())
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
pub struct CapitalSourceKeyId([u8; 32]);

impl CapitalSourceKeyId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
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
    key_id: CapitalSourceKeyId,
    class: CapitalClass,
    anchor: StateAnchor,
    provider_namespace: u16,
    provider_locator_hash: Hash32,
    provider_kind: CapitalProviderKind,
    ownership: CapitalOwnership,
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
    execution_blockers: Vec<String>,
    evidence: Vec<CapitalEvidenceRef>,
}

#[derive(Debug, Clone)]
pub struct CapitalSourceSpec {
    pub class: CapitalClass,
    pub anchor: StateAnchor,
    pub provider_namespace: u16,
    pub provider_locator_hash: Hash32,
    pub provider_kind: CapitalProviderKind,
    pub ownership: CapitalOwnership,
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
        if spec.provider_kind == CapitalProviderKind::OperatorTreasury
            && spec.ownership != CapitalOwnership::OperatorOwned
        {
            return Err(CapitalError::OwnershipProviderMismatch);
        }

        match spec.fee_model {
            FeeModel::BasisPoints { bps, .. } if bps > 10_000 => {
                return Err(CapitalError::InvalidBasisPoints(bps))
            }
            FeeModel::ExactRatio { denominator: 0, .. } => return Err(CapitalError::InvalidRatio),
            _ => {}
        }
        if matches!(spec.repayment, RepaymentSemantics::DeadlineBlocks(0)) {
            return Err(CapitalError::ZeroValue("repayment_deadline_blocks"));
        }
        match spec.collateral {
            CollateralRequirement::Required { amount, .. } => {
                if amount.is_zero() {
                    return Err(CapitalError::ZeroValue("collateral_amount"));
                }
            }
            CollateralRequirement::Proportional {
                numerator,
                denominator,
                rounding,
                ..
            } => {
                if numerator == 0 || denominator == 0 {
                    return Err(CapitalError::InvalidRatio);
                }
                if rounding != RoundingMode::Ceil {
                    return Err(CapitalError::InvalidCanonical(
                        "proportional collateral must round up",
                    ));
                }
            }
            CollateralRequirement::None => {}
        }
        if spec.utilization.max_utilization_bps > 10_000 {
            return Err(CapitalError::InvalidBasisPoints(
                spec.utilization.max_utilization_bps,
            ));
        }
        if let TemporaryLock::Required {
            amount, release, ..
        } = spec.temporary_lock
        {
            if amount.is_zero() {
                return Err(CapitalError::ZeroValue("temporary_lock_amount"));
            }
            if matches!(release, LockRelease::DeadlineBlocks(0)) {
                return Err(CapitalError::ZeroValue("lock_deadline_blocks"));
            }
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
        if spec.evidence.len() > usize::from(u16::MAX) {
            return Err(CapitalError::InvalidCanonical(
                "too many capital source evidence references",
            ));
        }
        if spec.evidence.is_empty() {
            return Err(CapitalError::MissingEvidence);
        }
        if spec.evidence.iter().any(
            |reference| matches!(reference, CapitalEvidenceRef::Observation(digest) if *digest == [0; 32]),
        ) {
            return Err(CapitalError::InvalidCanonical(
                "zero observation evidence digest",
            ));
        }

        match (spec.class, spec.repayment) {
            (
                CapitalClass::PersistentDebt | CapitalClass::CollateralizedBorrowing,
                RepaymentSemantics::Persistent(_),
            ) => {}
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
            key_id: CapitalSourceKeyId([0; 32]),
            class: spec.class,
            anchor: spec.anchor,
            provider_namespace: spec.provider_namespace,
            provider_locator_hash: spec.provider_locator_hash,
            provider_kind: spec.provider_kind,
            ownership: spec.ownership,
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
            execution_blockers: Vec::new(),
            evidence: spec.evidence,
        };
        source.key_id =
            CapitalSourceKeyId(domain_hash(SOURCE_KEY_DOMAIN, &source.key_content_bytes()));
        source.id = CapitalSourceId(domain_hash(SOURCE_DOMAIN, &source.content_bytes()));
        Ok(source)
    }

    pub const fn id(&self) -> CapitalSourceId {
        self.id
    }

    pub const fn key_id(&self) -> CapitalSourceKeyId {
        self.key_id
    }

    pub const fn class(&self) -> CapitalClass {
        self.class
    }

    pub const fn anchor(&self) -> &StateAnchor {
        &self.anchor
    }

    pub const fn provider_namespace(&self) -> u16 {
        self.provider_namespace
    }

    pub const fn provider_locator_hash(&self) -> Hash32 {
        self.provider_locator_hash
    }

    pub const fn provider_kind(&self) -> CapitalProviderKind {
        self.provider_kind
    }

    pub const fn ownership(&self) -> CapitalOwnership {
        self.ownership
    }

    pub const fn source_contract(&self) -> Option<Address> {
        self.source_contract
    }

    pub const fn asset(&self) -> CapitalAsset {
        self.asset
    }

    pub const fn maximum_available(&self) -> Amount256 {
        self.maximum_available
    }

    pub const fn fee_model(&self) -> FeeModel {
        self.fee_model
    }

    pub fn quote_fee(&self, drawn_amount: Amount256) -> Result<Option<FeeQuote>, CapitalError> {
        self.fee_model.quote(drawn_amount, self.repayment_asset)
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

    pub const fn utilization(&self) -> UtilizationConstraints {
        self.utilization
    }

    pub const fn caps(&self) -> CapitalCaps {
        self.caps
    }

    pub const fn temporary_lock(&self) -> TemporaryLock {
        self.temporary_lock
    }

    pub fn failure_modes(&self) -> &[CapitalFailureMode] {
        &self.failure_modes
    }

    pub fn execution_blockers(&self) -> &[String] {
        &self.execution_blockers
    }

    pub fn execution_eligible(&self) -> bool {
        self.execution_blockers.is_empty()
    }

    pub fn with_execution_blockers(
        mut self,
        mut blockers: Vec<String>,
    ) -> Result<Self, CapitalError> {
        for blocker in &blockers {
            validate_execution_blocker_code(blocker)?;
        }
        blockers.sort();
        blockers.dedup();
        if blockers.len() > usize::from(u16::MAX) {
            return Err(CapitalError::InvalidCanonical(
                "too many execution blocker codes",
            ));
        }
        self.execution_blockers = blockers;
        self.id = CapitalSourceId(domain_hash(SOURCE_DOMAIN, &self.content_bytes()));
        Ok(self)
    }

    pub fn executable_capacity(&self) -> Result<Amount256, CapitalError> {
        if self.execution_eligible() {
            self.effective_capacity()
        } else {
            Ok(Amount256::ZERO)
        }
    }

    pub fn evidence(&self) -> &[CapitalEvidenceRef] {
        &self.evidence
    }

    pub fn effective_capacity(&self) -> Result<Amount256, CapitalError> {
        // Each field is an independent upper bound on the same executable draw.
        // Do not apply utilization to an already-capped amount or subtract the
        // reserve floor after utilization: either would compound independent
        // constraints and understate capacity.
        let observed = self.maximum_available;
        let utilization_capacity =
            apply_utilization(observed, self.utilization.max_utilization_bps)?;
        let reserve_capacity = if observed <= self.utilization.min_remaining {
            Amount256::ZERO
        } else {
            observed.checked_sub(self.utilization.min_remaining)?
        };

        let mut capacity = observed.min(utilization_capacity).min(reserve_capacity);
        if let Some(cap) = self.caps.protocol_cap {
            capacity = capacity.min(cap);
        }
        if let Some(cap) = self.caps.market_cap {
            capacity = capacity.min(cap);
        }
        Ok(capacity)
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
        let ownership = CapitalOwnership::from_tag(reader.u8()?)?;
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
        let execution_blockers = if reader.remaining() == 0 {
            Vec::new()
        } else {
            if reader.u8()? != 0xe1 {
                return Err(CapitalError::InvalidCanonical(
                    "unknown capital source extension",
                ));
            }
            let blocker_count = usize::from(reader.u16()?);
            let mut blockers = Vec::with_capacity(blocker_count);
            for _ in 0..blocker_count {
                let length = usize::from(reader.u16()?);
                let bytes = reader.take(length)?;
                let blocker = std::str::from_utf8(bytes)
                    .map_err(|_| CapitalError::InvalidCanonical("execution blocker is not UTF-8"))?
                    .to_owned();
                validate_execution_blocker_code(&blocker)?;
                blockers.push(blocker);
            }
            if blockers.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err(CapitalError::InvalidCanonical(
                    "execution blockers are not strictly sorted",
                ));
            }
            blockers
        };
        reader.finish()?;
        Self::new(CapitalSourceSpec {
            class,
            anchor,
            provider_namespace,
            provider_locator_hash,
            provider_kind,
            ownership,
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
        })?
        .with_execution_blockers(execution_blockers)
    }

    fn key_content_bytes(&self) -> Vec<u8> {
        let mut writer = Writer::default();
        encode_chain(self.anchor.chain(), &mut writer);
        writer.u8(self.class.tag());
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
        self.repayment_asset.encode(&mut writer);
        writer.0
    }

    fn content_bytes(&self) -> Vec<u8> {
        let mut writer = Writer::default();
        writer.u8(self.class.tag());
        encode_anchor(&self.anchor, &mut writer);
        writer.u16(self.provider_namespace);
        writer.bytes(self.provider_locator_hash.as_bytes());
        writer.u8(self.provider_kind.tag());
        writer.u8(self.ownership.tag());
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
        if !self.execution_blockers.is_empty() {
            writer.u8(0xe1);
            writer.u16(u16::try_from(self.execution_blockers.len()).unwrap_or(u16::MAX));
            for blocker in &self.execution_blockers {
                writer.u16(u16::try_from(blocker.len()).unwrap_or(u16::MAX));
                writer.bytes(blocker.as_bytes());
            }
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
    BondOrStake,
}

impl RequirementKind {
    const ALL: [Self; 11] = [
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
        Self::BondOrStake,
    ];

    pub const fn code(self) -> &'static str {
        match self {
            Self::ActionPrincipal => "ACTION_PRINCIPAL",
            Self::Gas => "GAS",
            Self::ProtocolFee => "PROTOCOL_FEE",
            Self::FundingFee => "FUNDING_FEE",
            Self::BuilderOrSolverDeposit => "BUILDER_OR_SOLVER_DEPOSIT",
            Self::Inventory => "INVENTORY",
            Self::Collateral => "COLLATERAL",
            Self::PersistentDebtPrincipal => "PERSISTENT_DEBT_PRINCIPAL",
            Self::Repayment => "REPAYMENT",
            Self::TemporaryLock => "TEMPORARY_LOCK",
            Self::BondOrStake => "BOND_OR_STAKE",
        }
    }

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
            Self::BondOrStake => 11,
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
    pub const fn code(self) -> &'static str {
        match self {
            Self::SameTransaction => "SAME_TRANSACTION",
            Self::SameBlock => "SAME_BLOCK",
            Self::Flexible => "FLEXIBLE",
        }
    }

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
            Self::SameTransaction => matches!(
                repayment,
                RepaymentSemantics::AtomicSameTransaction | RepaymentSemantics::NoRepayment
            ),
            Self::SameBlock => matches!(
                repayment,
                RepaymentSemantics::AtomicSameTransaction
                    | RepaymentSemantics::SameBlock
                    | RepaymentSemantics::NoRepayment
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
            if allowed_classes.len() != 1 {
                return Err(CapitalError::GasLegMustUseGasFundingOnly);
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
    /// Reconstruct an already-certified requirement identity from its exact
    /// non-zero content hash. This does not certify requirement semantics;
    /// callers must bind the hash to an authenticated upstream artifact.
    pub fn from_hash(hash: Hash32) -> Self {
        Self(*hash.as_bytes())
    }

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
        if legs.len() > usize::from(u16::MAX) {
            return Err(CapitalError::InvalidCanonical(
                "too many capital requirement legs",
            ));
        }
        evidence.sort_unstable();
        evidence.dedup();
        if evidence.len() > usize::from(u16::MAX) {
            return Err(CapitalError::InvalidCanonical(
                "too many capital requirement evidence references",
            ));
        }
        if evidence.is_empty() {
            return Err(CapitalError::MissingEvidence);
        }
        if evidence.iter().any(
            |reference| matches!(reference, CapitalEvidenceRef::Observation(digest) if *digest == [0; 32]),
        ) {
            return Err(CapitalError::InvalidCanonical(
                "zero observation evidence digest",
            ));
        }
        let gas_present = legs.iter().any(|leg| leg.kind == RequirementKind::Gas);
        if requires_native_gas && !gas_present {
            return Err(CapitalError::NativeGasRequiredButMissing);
        }
        if !requires_native_gas && gas_present {
            return Err(CapitalError::NativeGasLegWithoutRequirementFlag);
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

    pub const fn requires_native_gas(&self) -> bool {
        self.requires_native_gas
    }

    pub fn legs(&self) -> &[CapitalRequirementLeg] {
        &self.legs
    }

    pub fn evidence(&self) -> &[CapitalEvidenceRef] {
        &self.evidence
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
    AllocationInvariantViolation,
    ExecutionBlocked,
    SettlementRequirementMismatch,
}

impl FeasibilityRejection {
    pub const fn code(self) -> &'static str {
        match self {
            Self::AnchorMismatch => "ANCHOR_MISMATCH",
            Self::NoCompatibleSource => "NO_COMPATIBLE_SOURCE",
            Self::InsufficientCapacity => "INSUFFICIENT_CAPACITY",
            Self::MissingGasFunding => "MISSING_GAS_FUNDING",
            Self::OperatorOwnedCapitalRequired => "OPERATOR_OWNED_CAPITAL_REQUIRED",
            Self::AtomicityMismatch => "ATOMICITY_MISMATCH",
            Self::RepaymentRequirementMissing => "REPAYMENT_REQUIREMENT_MISSING",
            Self::CollateralRequirementUnfunded => "COLLATERAL_REQUIREMENT_UNFUNDED",
            Self::TemporaryLockUnfunded => "TEMPORARY_LOCK_UNFUNDED",
            Self::AllocationInvariantViolation => "ALLOCATION_INVARIANT_VIOLATION",
            Self::ExecutionBlocked => "EXECUTION_BLOCKED",
            Self::SettlementRequirementMismatch => "SETTLEMENT_REQUIREMENT_MISMATCH",
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::AnchorMismatch => 1,
            Self::NoCompatibleSource => 2,
            Self::InsufficientCapacity => 3,
            Self::MissingGasFunding => 4,
            Self::OperatorOwnedCapitalRequired => 5,
            Self::AtomicityMismatch => 6,
            Self::RepaymentRequirementMissing => 7,
            Self::CollateralRequirementUnfunded => 8,
            Self::TemporaryLockUnfunded => 9,
            Self::AllocationInvariantViolation => 10,
            Self::ExecutionBlocked => 11,
            Self::SettlementRequirementMismatch => 12,
        }
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CapitalObligation {
    pub kind: RequirementKind,
    pub asset: CapitalAsset,
    pub amount: Amount256,
}

pub fn derive_settlement_obligations(
    feasibility: &CapitalFeasibility,
    sources: &[CapitalSource],
) -> Result<Vec<CapitalObligation>, CapitalError> {
    let allocations = match feasibility {
        CapitalFeasibility::Feasible { allocations, .. } => allocations,
        CapitalFeasibility::Rejected { .. } => {
            return Err(CapitalError::RejectedFeasibilityHasNoObligations)
        }
    };
    let by_id = sources
        .iter()
        .map(|source| (source.id(), source))
        .collect::<BTreeMap<_, _>>();
    let mut drawn_by_source = BTreeMap::<CapitalSourceId, Amount256>::new();
    for allocation in allocations {
        let current = drawn_by_source
            .get(&allocation.source_id)
            .copied()
            .unwrap_or(Amount256::ZERO);
        drawn_by_source.insert(
            allocation.source_id,
            current.checked_add(allocation.amount)?,
        );
    }

    let mut totals = BTreeMap::<(RequirementKind, CapitalAsset), Amount256>::new();
    for (source_id, drawn) in drawn_by_source {
        let source = by_id
            .get(&source_id)
            .copied()
            .ok_or(CapitalError::MissingSourceForAllocation)?;

        if !matches!(
            source.repayment(),
            RepaymentSemantics::Persistent(_) | RepaymentSemantics::NoRepayment
        ) {
            add_obligation(
                &mut totals,
                RequirementKind::Repayment,
                source.repayment_asset(),
                drawn,
            )?;
        }
        if let Some(fee) = source.quote_fee(drawn)? {
            if !fee.amount.is_zero() {
                add_obligation(
                    &mut totals,
                    RequirementKind::FundingFee,
                    fee.asset,
                    fee.amount,
                )?;
            }
        }
    }

    Ok(totals
        .into_iter()
        .map(|((kind, asset), amount)| CapitalObligation {
            kind,
            asset,
            amount,
        })
        .collect())
}

pub fn validate_settlement_requirements(
    requirement: &CapitalRequirement,
    feasibility: &CapitalFeasibility,
    sources: &[CapitalSource],
) -> Result<(), CapitalError> {
    let obligations = derive_settlement_obligations(feasibility, sources)?;
    let mut declared = BTreeMap::<(RequirementKind, CapitalAsset), Amount256>::new();
    for leg in requirement.legs() {
        if !matches!(
            leg.kind(),
            RequirementKind::Repayment | RequirementKind::FundingFee
        ) {
            continue;
        }
        add_obligation(&mut declared, leg.kind(), leg.asset(), leg.amount())?;
    }

    let required = obligations
        .into_iter()
        .map(|obligation| ((obligation.kind, obligation.asset), obligation.amount))
        .collect::<BTreeMap<_, _>>();
    if declared != required {
        return Err(CapitalError::SettlementRequirementMismatch);
    }

    let allocations = match feasibility {
        CapitalFeasibility::Feasible { allocations, .. } => allocations,
        CapitalFeasibility::Rejected { .. } => {
            return Err(CapitalError::RejectedFeasibilityHasNoObligations)
        }
    };
    let by_id = sources
        .iter()
        .map(|source| (source.id(), source))
        .collect::<BTreeMap<_, _>>();
    let mut drawn_by_source = BTreeMap::<CapitalSourceId, Amount256>::new();
    for allocation in allocations {
        let current = drawn_by_source
            .get(&allocation.source_id)
            .copied()
            .unwrap_or(Amount256::ZERO);
        drawn_by_source.insert(
            allocation.source_id,
            current.checked_add(allocation.amount)?,
        );
    }

    let mut required_by_class =
        BTreeMap::<(RequirementKind, CapitalAsset, CapitalClass), Amount256>::new();
    for (source_id, drawn) in drawn_by_source {
        let source = by_id
            .get(&source_id)
            .copied()
            .ok_or(CapitalError::MissingSourceForAllocation)?;
        if !matches!(
            source.repayment(),
            RepaymentSemantics::Persistent(_) | RepaymentSemantics::NoRepayment
        ) {
            add_class_obligation(
                &mut required_by_class,
                RequirementKind::Repayment,
                source.repayment_asset(),
                source.class(),
                drawn,
            )?;
        }
        if let Some(fee) = source.quote_fee(drawn)? {
            if !fee.amount.is_zero() {
                add_class_obligation(
                    &mut required_by_class,
                    RequirementKind::FundingFee,
                    fee.asset,
                    source.class(),
                    fee.amount,
                )?;
            }
        }
    }
    if !settlement_class_amounts_assignable(requirement, &required_by_class)? {
        return Err(CapitalError::SettlementRequirementMismatch);
    }
    Ok(())
}

fn add_class_obligation(
    totals: &mut BTreeMap<(RequirementKind, CapitalAsset, CapitalClass), Amount256>,
    kind: RequirementKind,
    asset: CapitalAsset,
    class: CapitalClass,
    amount: Amount256,
) -> Result<(), CapitalError> {
    let current = totals
        .get(&(kind, asset, class))
        .copied()
        .unwrap_or(Amount256::ZERO);
    totals.insert((kind, asset, class), current.checked_add(amount)?);
    Ok(())
}

fn settlement_class_amounts_assignable(
    requirement: &CapitalRequirement,
    required_by_class: &BTreeMap<(RequirementKind, CapitalAsset, CapitalClass), Amount256>,
) -> Result<bool, CapitalError> {
    let groups = required_by_class
        .keys()
        .map(|(kind, asset, _)| (*kind, *asset))
        .collect::<BTreeSet<_>>();

    for (kind, asset) in groups {
        let class_obligations = required_by_class
            .iter()
            .filter_map(|((required_kind, required_asset, class), amount)| {
                (*required_kind == kind && *required_asset == asset).then_some((*class, *amount))
            })
            .collect::<Vec<_>>();
        let legs = requirement
            .legs()
            .iter()
            .filter(|leg| leg.kind() == kind && leg.asset() == asset)
            .collect::<Vec<_>>();

        let class_count = class_obligations.len();
        let leg_count = legs.len();
        let class_node = |index: usize| 1 + index;
        let leg_node = |index: usize| 1 + class_count + index;
        let super_source = 0_usize;
        let sink = 1 + class_count + leg_count;
        let mut graph = vec![Vec::<ResidualEdge>::new(); sink + 1];
        let mut class_source_edges = Vec::with_capacity(class_count);

        for (class_index, (class, amount)) in class_obligations.iter().enumerate() {
            let edge_index =
                add_residual_edge(&mut graph, super_source, class_node(class_index), *amount);
            class_source_edges.push(edge_index);
            for (leg_index, leg) in legs.iter().enumerate() {
                if !leg.allowed_classes().contains(class) {
                    continue;
                }
                let capacity = (*amount).min(leg.amount());
                if capacity.is_zero() {
                    continue;
                }
                add_residual_edge(
                    &mut graph,
                    class_node(class_index),
                    leg_node(leg_index),
                    capacity,
                );
            }
        }
        for (leg_index, leg) in legs.iter().enumerate() {
            add_residual_edge(&mut graph, leg_node(leg_index), sink, leg.amount());
        }

        run_residual_flow(&mut graph, super_source, sink)?;

        if class_source_edges
            .iter()
            .any(|edge| !graph[super_source][*edge].capacity.is_zero())
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn add_obligation(
    totals: &mut BTreeMap<(RequirementKind, CapitalAsset), Amount256>,
    kind: RequirementKind,
    asset: CapitalAsset,
    amount: Amount256,
) -> Result<(), CapitalError> {
    let current = totals
        .get(&(kind, asset))
        .copied()
        .unwrap_or(Amount256::ZERO);
    totals.insert((kind, asset), current.checked_add(amount)?);
    Ok(())
}

#[derive(Debug, Clone)]
struct ResidualEdge {
    to: usize,
    reverse: usize,
    capacity: Amount256,
}

#[derive(Debug)]
struct FundingSolution {
    allocations: Vec<SourceAllocation>,
    unmet_leg: Option<(usize, Amount256)>,
}

fn add_residual_edge(
    graph: &mut [Vec<ResidualEdge>],
    from: usize,
    to: usize,
    capacity: Amount256,
) -> usize {
    let forward = graph[from].len();
    let reverse = graph[to].len();
    graph[from].push(ResidualEdge {
        to,
        reverse,
        capacity,
    });
    graph[to].push(ResidualEdge {
        to: from,
        reverse: forward,
        capacity: Amount256::ZERO,
    });
    forward
}

fn source_satisfies_leg_atomicity(
    requirement: &CapitalRequirement,
    source: &CapitalSource,
    leg: &CapitalRequirementLeg,
) -> bool {
    // Native gas must be available before EVM execution. Its external financing
    // can legitimately settle after the action transaction (for example a
    // deadline-bound gas credit facility). The requirement's action atomicity
    // therefore does not constrain GAS_FUNDING repayment horizon. Settlement
    // obligations are still derived exactly and must be declared.
    if leg.kind() == RequirementKind::Gas {
        return source.class() == CapitalClass::GasFunding;
    }
    requirement.atomicity().accepts(source.repayment())
}

fn source_can_fund_leg(
    requirement: &CapitalRequirement,
    source: &CapitalSource,
    leg: &CapitalRequirementLeg,
    allow_operator_owned: bool,
    require_anchor: bool,
    require_atomicity: bool,
) -> bool {
    if source.asset() != leg.asset() || !leg.allowed_classes().contains(&source.class()) {
        return false;
    }
    if require_anchor && source.anchor() != requirement.anchor() {
        return false;
    }
    if require_atomicity && !source_satisfies_leg_atomicity(requirement, source, leg) {
        return false;
    }
    if !allow_operator_owned && source.ownership().is_operator_owned() {
        return false;
    }

    // Collateral and lock funding are pre-funded resources. A source used to
    // satisfy either leg must itself be free of both collateral and temporary-lock
    // dependencies. This deliberately fails closed on cross-kind cycles such as
    // "borrow collateral using a source that itself needs a lock" or the inverse.
    if matches!(
        leg.kind(),
        RequirementKind::Collateral | RequirementKind::TemporaryLock
    ) && (!matches!(source.collateral(), CollateralRequirement::None)
        || !matches!(source.temporary_lock(), TemporaryLock::None))
    {
        return false;
    }
    true
}

fn run_residual_flow(
    graph: &mut [Vec<ResidualEdge>],
    source: usize,
    sink: usize,
) -> Result<(), CapitalError> {
    loop {
        let mut parent = vec![None::<(usize, usize)>; graph.len()];
        let mut visited = vec![false; graph.len()];
        let mut queue = VecDeque::new();
        visited[source] = true;
        queue.push_back(source);

        while let Some(node) = queue.pop_front() {
            if node == sink {
                break;
            }
            for (edge_index, edge) in graph[node].iter().enumerate() {
                if edge.capacity.is_zero() || visited[edge.to] {
                    continue;
                }
                visited[edge.to] = true;
                parent[edge.to] = Some((node, edge_index));
                queue.push_back(edge.to);
                if edge.to == sink {
                    break;
                }
            }
        }

        if !visited[sink] {
            return Ok(());
        }

        let mut bottleneck = Amount256::MAX;
        let mut node = sink;
        while node != source {
            let (previous, edge_index) = parent[node].ok_or(CapitalError::InvalidCanonical(
                "residual flow path lacks predecessor",
            ))?;
            bottleneck = bottleneck.min(graph[previous][edge_index].capacity);
            node = previous;
        }
        if bottleneck.is_zero() {
            return Err(CapitalError::InvalidCanonical(
                "residual flow produced zero bottleneck",
            ));
        }

        node = sink;
        while node != source {
            let (previous, edge_index) = parent[node].ok_or(CapitalError::InvalidCanonical(
                "residual flow update lacks predecessor",
            ))?;
            let (to, reverse, forward_capacity) = {
                let edge = &graph[previous][edge_index];
                (edge.to, edge.reverse, edge.capacity)
            };
            if to != node {
                return Err(CapitalError::InvalidCanonical(
                    "residual flow predecessor points to another node",
                ));
            }
            graph[previous][edge_index].capacity = forward_capacity.checked_sub(bottleneck)?;
            let reverse_capacity = graph[to][reverse].capacity.checked_add(bottleneck)?;
            graph[to][reverse].capacity = reverse_capacity;
            node = previous;
        }
    }
}

fn solve_funding(
    requirement: &CapitalRequirement,
    sources: &[CapitalSource],
) -> Result<FundingSolution, CapitalError> {
    // Raw feasibility callers must not be able to manufacture capacity by
    // passing the same observed source more than once, or by passing multiple
    // observed states for one stable source key. The ledger already enforces
    // this invariant at registration; enforce it here too so the public
    // checked evaluator is independently fail-closed.
    let mut source_ids = BTreeSet::new();
    let mut source_keys = BTreeSet::new();
    for source in sources {
        if !source_ids.insert(source.id()) {
            return Err(CapitalError::DuplicateSource);
        }
        if !source_keys.insert(source.key_id()) {
            return Err(CapitalError::ConflictingSourceState);
        }
    }

    let mut ordered = sources.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|source| source.id());

    let funding_legs = requirement
        .legs()
        .iter()
        .enumerate()
        .filter(|(_, leg)| {
            !matches!(
                leg.kind(),
                RequirementKind::Repayment | RequirementKind::FundingFee
            )
        })
        .collect::<Vec<_>>();

    if funding_legs.is_empty() {
        return Ok(FundingSolution {
            allocations: Vec::new(),
            unmet_leg: None,
        });
    }

    let source_count = ordered.len();
    let leg_count = funding_legs.len();
    let source_node = |index: usize| 1 + index;
    let leg_node = |index: usize| 1 + source_count + index;
    let super_source = 0_usize;
    let sink = 1 + source_count + leg_count;
    let mut graph = vec![Vec::<ResidualEdge>::new(); sink + 1];
    let mut source_leg_edges = vec![vec![None::<usize>; leg_count]; source_count];
    let mut leg_sink_edges = Vec::with_capacity(leg_count);

    for (source_index, source) in ordered.iter().enumerate() {
        if source.ownership().is_operator_owned() || source.anchor() != requirement.anchor() {
            continue;
        }
        let capacity = source.executable_capacity()?;
        if capacity.is_zero() {
            continue;
        }
        add_residual_edge(
            &mut graph,
            super_source,
            source_node(source_index),
            capacity,
        );

        for (leg_index, (_, leg)) in funding_legs.iter().enumerate() {
            if !source_can_fund_leg(requirement, source, leg, false, true, true) {
                continue;
            }
            let edge_capacity = capacity.min(leg.amount());
            if edge_capacity.is_zero() {
                continue;
            }
            source_leg_edges[source_index][leg_index] = Some(add_residual_edge(
                &mut graph,
                source_node(source_index),
                leg_node(leg_index),
                edge_capacity,
            ));
        }
    }

    for (leg_index, (_, leg)) in funding_legs.iter().enumerate() {
        let edge_index = add_residual_edge(&mut graph, leg_node(leg_index), sink, leg.amount());
        leg_sink_edges.push(edge_index);
    }

    run_residual_flow(&mut graph, super_source, sink)?;

    let mut allocations = Vec::new();
    for (leg_index, (_, leg)) in funding_legs.iter().enumerate() {
        for (source_index, source) in ordered.iter().enumerate() {
            let Some(edge_index) = source_leg_edges[source_index][leg_index] else {
                continue;
            };
            let forward = &graph[source_node(source_index)][edge_index];
            let flow = graph[forward.to][forward.reverse].capacity;
            if flow.is_zero() {
                continue;
            }
            allocations.push(SourceAllocation {
                source_id: source.id(),
                leg_kind: leg.kind(),
                amount: flow,
            });
        }
    }

    let unmet_leg =
        funding_legs
            .iter()
            .enumerate()
            .find_map(|(leg_index, (requirement_index, _))| {
                let remaining = graph[leg_node(leg_index)][leg_sink_edges[leg_index]].capacity;
                (!remaining.is_zero()).then_some((*requirement_index, remaining))
            });

    Ok(FundingSolution {
        allocations,
        unmet_leg,
    })
}

fn classify_unmet_leg(
    requirement: &CapitalRequirement,
    leg: &CapitalRequirementLeg,
    unmet: Amount256,
    sources: &[CapitalSource],
) -> Result<FeasibilityRejection, CapitalError> {
    let mut same_anchor_class = false;
    let mut same_anchor_atomic = false;
    let mut foreign_anchor = false;
    let mut operator_capacity = Amount256::ZERO;
    let mut execution_blocked_capacity = Amount256::ZERO;

    for source in sources {
        if !source_can_fund_leg(requirement, source, leg, true, false, false) {
            continue;
        }
        if source.anchor() != requirement.anchor() {
            foreign_anchor = true;
            continue;
        }
        same_anchor_class = true;
        if !source_satisfies_leg_atomicity(requirement, source, leg) {
            continue;
        }
        same_anchor_atomic = true;
        if source.ownership().is_operator_owned() {
            operator_capacity = operator_capacity
                .checked_add(source.effective_capacity()?)
                .unwrap_or(Amount256::MAX);
        } else if !source.execution_eligible() {
            execution_blocked_capacity = execution_blocked_capacity
                .checked_add(source.effective_capacity()?)
                .unwrap_or(Amount256::MAX);
        }
    }

    if operator_capacity >= unmet {
        return Ok(FeasibilityRejection::OperatorOwnedCapitalRequired);
    }
    if !same_anchor_class && foreign_anchor {
        return Ok(FeasibilityRejection::AnchorMismatch);
    }
    if execution_blocked_capacity >= unmet {
        return Ok(FeasibilityRejection::ExecutionBlocked);
    }
    if leg.kind() == RequirementKind::Gas {
        return Ok(FeasibilityRejection::MissingGasFunding);
    }
    if same_anchor_class && !same_anchor_atomic {
        return Ok(FeasibilityRejection::AtomicityMismatch);
    }
    if same_anchor_atomic {
        return Ok(FeasibilityRejection::InsufficientCapacity);
    }
    Ok(FeasibilityRejection::NoCompatibleSource)
}

pub fn evaluate_capital_feasibility_checked(
    requirement: &CapitalRequirement,
    sources: &[CapitalSource],
) -> Result<CapitalFeasibility, CapitalError> {
    let solution = solve_funding(requirement, sources)?;
    if let Some((leg_index, unmet)) = solution.unmet_leg {
        let leg = requirement
            .legs()
            .get(leg_index)
            .ok_or(CapitalError::InvalidCanonical(
                "funding solution references missing requirement leg",
            ))?;
        let reason = classify_unmet_leg(requirement, leg, unmet, sources)?;
        return Ok(rejected(requirement, reason, Some(leg.kind())));
    }

    let allocations = solution.allocations;
    let mut used_source_amounts = BTreeMap::<CapitalSourceId, Amount256>::new();
    for allocation in &allocations {
        let total = used_source_amounts
            .entry(allocation.source_id)
            .or_insert(Amount256::ZERO);
        *total = total.checked_add(allocation.amount)?;
    }

    let mut source_dependencies = BTreeMap::<(RequirementKind, CapitalAsset), Amount256>::new();
    for (source_id, drawn_amount) in used_source_amounts {
        let source = sources
            .iter()
            .find(|source| source.id() == source_id)
            .ok_or(CapitalError::MissingSourceForAllocation)?;
        if !matches!(
            source.repayment(),
            RepaymentSemantics::Persistent(_) | RepaymentSemantics::NoRepayment
        ) && !has_leg(
            requirement,
            RequirementKind::Repayment,
            source.repayment_asset(),
        ) {
            return Ok(rejected(
                requirement,
                FeasibilityRejection::RepaymentRequirementMissing,
                Some(RequirementKind::Repayment),
            ));
        }
        match source.collateral() {
            CollateralRequirement::None => {}
            CollateralRequirement::Required { asset, amount, .. } => {
                add_obligation(
                    &mut source_dependencies,
                    RequirementKind::Collateral,
                    asset,
                    amount,
                )?;
            }
            CollateralRequirement::Proportional {
                asset,
                numerator,
                denominator,
                rounding,
                ..
            } => {
                let amount = mul_div_u64_round(drawn_amount, numerator, denominator, rounding)?;
                if amount.is_zero() {
                    return Err(CapitalError::InvalidCanonical(
                        "positive draw produced zero proportional collateral",
                    ));
                }
                add_obligation(
                    &mut source_dependencies,
                    RequirementKind::Collateral,
                    asset,
                    amount,
                )?;
            }
        }
        if let TemporaryLock::Required { asset, amount, .. } = source.temporary_lock() {
            add_obligation(
                &mut source_dependencies,
                RequirementKind::TemporaryLock,
                asset,
                amount,
            )?;
        }
    }

    for ((kind, asset), required_amount) in source_dependencies {
        if declared_leg_total(requirement, kind, asset)? >= required_amount {
            continue;
        }
        let reason = match kind {
            RequirementKind::Collateral => FeasibilityRejection::CollateralRequirementUnfunded,
            RequirementKind::TemporaryLock => FeasibilityRejection::TemporaryLockUnfunded,
            _ => {
                return Err(CapitalError::InvalidCanonical(
                    "unexpected aggregated source dependency kind",
                ))
            }
        };
        return Ok(rejected(requirement, reason, Some(kind)));
    }

    let feasible = CapitalFeasibility::Feasible {
        requirement_id: requirement.id(),
        allocations,
    };
    match validate_settlement_requirements(requirement, &feasible, sources) {
        Ok(()) => Ok(feasible),
        Err(CapitalError::SettlementRequirementMismatch) => Ok(rejected(
            requirement,
            FeasibilityRejection::SettlementRequirementMismatch,
            None,
        )),
        Err(error) => Err(error),
    }
}

pub fn evaluate_capital_feasibility(
    requirement: &CapitalRequirement,
    sources: &[CapitalSource],
) -> CapitalFeasibility {
    evaluate_capital_feasibility_checked(requirement, sources).unwrap_or_else(|_| {
        rejected(
            requirement,
            FeasibilityRejection::AllocationInvariantViolation,
            None,
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CapitalCensusCommitment([u8; 32]);

impl CapitalCensusCommitment {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalCensusSummary {
    pub source_count: usize,
    pub requirement_count: usize,
    pub feasible_count: usize,
    pub feasible_external_gas_count: usize,
    pub rejected_count: usize,
    pub operator_owned_sources_observed: usize,
    pub operator_owned_sources_used: usize,
    pub sources_by_class: BTreeMap<CapitalClass, usize>,
}

impl CapitalCensusSummary {
    pub const fn is_conserved(&self) -> bool {
        self.requirement_count == self.feasible_count + self.rejected_count
    }

    pub const fn uses_zero_operator_capital(&self) -> bool {
        self.operator_owned_sources_used == 0
    }

    pub const fn proves_zero_own_capital(&self) -> bool {
        self.feasible_count > 0
            && self.feasible_external_gas_count == self.feasible_count
            && self.uses_zero_operator_capital()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapitalLedgerMode {
    SyntheticFixture,
    Evidentiary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GitObjectId([u8; 20]);

impl GitObjectId {
    pub fn parse_hex(value: &str) -> Result<Self, CapitalError> {
        if value.len() != 40 {
            return Err(CapitalError::InvalidGitObjectId);
        }
        let mut bytes = [0_u8; 20];
        let raw = value.as_bytes();
        for index in 0..20 {
            let high = hex_nibble(raw[index * 2])?;
            let low = hex_nibble(raw[index * 2 + 1])?;
            bytes[index] = (high << 4) | low;
        }
        if bytes == [0; 20] {
            return Err(CapitalError::InvalidGitObjectId);
        }
        Ok(Self(bytes))
    }

    pub const fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum UpstreamCensusStage {
    Rmc006DiscoveryAave,
    Rmc007DiscoveryV2,
    Rmc008StateAdmission,
    Rmc009PositionUniverse,
    Rmc010IncrementalParity,
}

impl UpstreamCensusStage {
    pub const ALL: [Self; 5] = [
        Self::Rmc006DiscoveryAave,
        Self::Rmc007DiscoveryV2,
        Self::Rmc008StateAdmission,
        Self::Rmc009PositionUniverse,
        Self::Rmc010IncrementalParity,
    ];

    pub const fn code(self) -> &'static str {
        match self {
            Self::Rmc006DiscoveryAave => "RMC-006",
            Self::Rmc007DiscoveryV2 => "RMC-007",
            Self::Rmc008StateAdmission => "RMC-008",
            Self::Rmc009PositionUniverse => "RMC-009",
            Self::Rmc010IncrementalParity => "RMC-010",
        }
    }

    pub fn parse_code(value: &str) -> Result<Self, CapitalError> {
        match value {
            "RMC-006" => Ok(Self::Rmc006DiscoveryAave),
            "RMC-007" => Ok(Self::Rmc007DiscoveryV2),
            "RMC-008" => Ok(Self::Rmc008StateAdmission),
            "RMC-009" => Ok(Self::Rmc009PositionUniverse),
            "RMC-010" => Ok(Self::Rmc010IncrementalParity),
            _ => Err(CapitalError::InvalidUpstreamAuthority(
                "unknown upstream stage code",
            )),
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::Rmc006DiscoveryAave => 6,
            Self::Rmc007DiscoveryV2 => 7,
            Self::Rmc008StateAdmission => 8,
            Self::Rmc009PositionUniverse => 9,
            Self::Rmc010IncrementalParity => 10,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamStageAuthority {
    pub stage: UpstreamCensusStage,
    pub code_commit: GitObjectId,
    pub code_tree: GitObjectId,
    pub artifact_sha256: Hash32,
    pub observation_anchor: StateAnchor,
    pub unresolved_mismatch_count: u64,
    pub unknown_failure_count: u64,
    pub coverage_complete: bool,
    pub admitted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamStageAuthoritySpec {
    pub stage: UpstreamCensusStage,
    pub code_commit: GitObjectId,
    pub code_tree: GitObjectId,
    pub artifact_sha256: Hash32,
    pub observation_anchor: StateAnchor,
    pub unresolved_mismatch_count: u64,
    pub unknown_failure_count: u64,
    pub coverage_complete: bool,
    pub admitted: bool,
}

impl UpstreamStageAuthority {
    pub fn new(spec: UpstreamStageAuthoritySpec) -> Result<Self, CapitalError> {
        if spec.unresolved_mismatch_count != 0 {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "unresolved mismatch count is nonzero",
            ));
        }
        if spec.unknown_failure_count != 0 {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "UNKNOWN failure count is nonzero",
            ));
        }
        if !spec.coverage_complete {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "upstream stage coverage is incomplete",
            ));
        }
        if !spec.admitted {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "upstream artifact is not admitted",
            ));
        }
        Ok(Self {
            stage: spec.stage,
            code_commit: spec.code_commit,
            code_tree: spec.code_tree,
            artifact_sha256: spec.artifact_sha256,
            observation_anchor: spec.observation_anchor,
            unresolved_mismatch_count: spec.unresolved_mismatch_count,
            unknown_failure_count: spec.unknown_failure_count,
            coverage_complete: spec.coverage_complete,
            admitted: spec.admitted,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UpstreamConsumptionReceipt {
    stage: UpstreamCensusStage,
    authority_artifact_sha256: Hash32,
    coverage_commitment: Hash32,
    output_count: u64,
    output_set_commitment: Hash32,
}

fn consumed_id_set_commitment(
    domain: &[u8],
    ids: impl IntoIterator<Item = [u8; 32]>,
) -> Result<(u64, Hash32), CapitalError> {
    let mut ids = ids.into_iter().collect::<Vec<_>>();
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "consumed output set contains duplicate identifiers",
        ));
    }
    let count = u64::try_from(ids.len())
        .map_err(|_| CapitalError::InvalidUpstreamAuthority("consumed output count exceeds u64"))?;
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    hasher.update(count.to_be_bytes());
    for id in ids {
        hasher.update(id);
    }
    let commitment = Hash32::new(finalize_sha256(hasher)).map_err(|_| {
        CapitalError::InvalidUpstreamAuthority("zero consumed output set commitment")
    })?;
    Ok((count, commitment))
}

fn source_output_set_commitment<'a>(
    sources: impl IntoIterator<Item = &'a CapitalSource>,
) -> Result<(u64, Hash32), CapitalError> {
    consumed_id_set_commitment(
        b"NQC-RMC011-D08-SOURCE-SET-V1",
        sources.into_iter().map(|source| *source.id().as_bytes()),
    )
}

fn requirement_output_set_commitment<'a>(
    requirements: impl IntoIterator<Item = &'a CapitalRequirement>,
) -> Result<(u64, Hash32), CapitalError> {
    consumed_id_set_commitment(
        b"NQC-RMC011-D09-REQUIREMENT-SET-V1",
        requirements
            .into_iter()
            .map(|requirement| *requirement.id().as_bytes()),
    )
}

impl UpstreamConsumptionReceipt {
    pub fn for_sources<'a>(
        authority_artifact_sha256: Hash32,
        coverage_commitment: Hash32,
        sources: impl IntoIterator<Item = &'a CapitalSource>,
    ) -> Result<Self, CapitalError> {
        let (output_count, output_set_commitment) = source_output_set_commitment(sources)?;
        Self::from_parts(
            UpstreamCensusStage::Rmc008StateAdmission,
            authority_artifact_sha256,
            coverage_commitment,
            output_count,
            output_set_commitment,
        )
    }

    pub fn for_requirements<'a>(
        authority_artifact_sha256: Hash32,
        coverage_commitment: Hash32,
        requirements: impl IntoIterator<Item = &'a CapitalRequirement>,
    ) -> Result<Self, CapitalError> {
        let (output_count, output_set_commitment) =
            requirement_output_set_commitment(requirements)?;
        Self::from_parts(
            UpstreamCensusStage::Rmc009PositionUniverse,
            authority_artifact_sha256,
            coverage_commitment,
            output_count,
            output_set_commitment,
        )
    }

    pub(crate) fn from_parts(
        stage: UpstreamCensusStage,
        authority_artifact_sha256: Hash32,
        coverage_commitment: Hash32,
        output_count: u64,
        output_set_commitment: Hash32,
    ) -> Result<Self, CapitalError> {
        if !matches!(
            stage,
            UpstreamCensusStage::Rmc008StateAdmission | UpstreamCensusStage::Rmc009PositionUniverse
        ) {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "only RMC-008 and RMC-009 may issue capital consumption receipts",
            ));
        }
        Ok(Self {
            stage,
            authority_artifact_sha256,
            coverage_commitment,
            output_count,
            output_set_commitment,
        })
    }

    pub const fn stage(self) -> UpstreamCensusStage {
        self.stage
    }

    pub const fn authority_artifact_sha256(self) -> Hash32 {
        self.authority_artifact_sha256
    }

    pub const fn coverage_commitment(self) -> Hash32 {
        self.coverage_commitment
    }

    pub const fn output_count(self) -> u64 {
        self.output_count
    }

    pub const fn output_set_commitment(self) -> Hash32 {
        self.output_set_commitment
    }
}

fn upstream_authority_commitment(
    stages: &[UpstreamStageAuthority],
    admitted_evidence: &BTreeSet<CapitalEvidenceRef>,
    consumption_receipts: &BTreeMap<UpstreamCensusStage, UpstreamConsumptionReceipt>,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-UPSTREAM-AUTHORITY-V5");
    hasher.update([0]);
    for authority in stages {
        hasher.update([authority.stage.tag()]);
        hasher.update(authority.code_commit.as_bytes());
        hasher.update(authority.code_tree.as_bytes());
        hasher.update(authority.artifact_sha256.as_bytes());
        encode_anchor_into_hasher(&authority.observation_anchor, &mut hasher);
        hasher.update(authority.unresolved_mismatch_count.to_be_bytes());
        hasher.update(authority.unknown_failure_count.to_be_bytes());
        hasher.update([u8::from(authority.coverage_complete)]);
        hasher.update([u8::from(authority.admitted)]);
    }
    hasher.update(
        u64::try_from(admitted_evidence.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    for evidence in admitted_evidence {
        let mut writer = Writer::default();
        evidence.encode(&mut writer);
        hasher.update(
            u64::try_from(writer.0.len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
        hasher.update(&writer.0);
    }
    hasher.update(
        u64::try_from(consumption_receipts.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    for receipt in consumption_receipts.values() {
        hasher.update([receipt.stage.tag()]);
        hasher.update(receipt.authority_artifact_sha256.as_bytes());
        hasher.update(receipt.coverage_commitment.as_bytes());
        hasher.update(receipt.output_count.to_be_bytes());
        hasher.update(receipt.output_set_commitment.as_bytes());
    }
    Hash32::new(finalize_sha256(hasher))
        .map_err(|_| CapitalError::InvalidUpstreamAuthority("zero authority commitment"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalCertificationContext {
    stages: Vec<UpstreamStageAuthority>,
    observation_anchor: StateAnchor,
    admitted_evidence: BTreeSet<CapitalEvidenceRef>,
    consumption_receipts: BTreeMap<UpstreamCensusStage, UpstreamConsumptionReceipt>,
    commitment: Hash32,
}

impl CapitalCertificationContext {
    pub fn new(
        mut stages: Vec<UpstreamStageAuthority>,
        admitted_evidence: Vec<CapitalEvidenceRef>,
    ) -> Result<Self, CapitalError> {
        stages.sort_by_key(|authority| authority.stage);
        if stages.len() != UpstreamCensusStage::ALL.len() {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "exactly RMC-006 through RMC-010 authorities are required",
            ));
        }
        for (expected, observed) in UpstreamCensusStage::ALL.into_iter().zip(&stages) {
            if observed.stage != expected {
                return Err(CapitalError::InvalidUpstreamAuthority(
                    "required upstream stage is missing or duplicated",
                ));
            }
            if observed.unresolved_mismatch_count != 0
                || observed.unknown_failure_count != 0
                || !observed.coverage_complete
                || !observed.admitted
            {
                return Err(CapitalError::InvalidUpstreamAuthority(
                    "upstream stage is not certifiable",
                ));
            }
        }
        let observation_anchor = stages
            .first()
            .ok_or(CapitalError::InvalidUpstreamAuthority(
                "upstream authority stages are empty",
            ))?
            .observation_anchor
            .clone();
        if stages
            .iter()
            .any(|authority| authority.observation_anchor != observation_anchor)
        {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "upstream stages do not share one exact observation anchor",
            ));
        }
        let admitted_evidence = admitted_evidence.into_iter().collect::<BTreeSet<_>>();
        if admitted_evidence.is_empty() {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "admitted evidence catalog is empty",
            ));
        }
        for authority in &stages {
            let authority_evidence = CapitalEvidenceRef::Artifact(authority.artifact_sha256);
            if !admitted_evidence.contains(&authority_evidence) {
                return Err(CapitalError::InvalidUpstreamAuthority(
                    "upstream stage artifact is not present in admitted evidence catalog",
                ));
            }
        }

        let consumption_receipts = BTreeMap::new();
        let commitment =
            upstream_authority_commitment(&stages, &admitted_evidence, &consumption_receipts)?;
        Ok(Self {
            stages,
            observation_anchor,
            admitted_evidence,
            consumption_receipts,
            commitment,
        })
    }

    pub fn with_consumption_receipts(
        mut self,
        receipts: Vec<UpstreamConsumptionReceipt>,
    ) -> Result<Self, CapitalError> {
        let mut by_stage = BTreeMap::new();
        for receipt in receipts {
            if by_stage.insert(receipt.stage(), receipt).is_some() {
                return Err(CapitalError::InvalidUpstreamAuthority(
                    "duplicate upstream consumption receipt",
                ));
            }
        }
        for required in [
            UpstreamCensusStage::Rmc008StateAdmission,
            UpstreamCensusStage::Rmc009PositionUniverse,
        ] {
            let receipt = by_stage
                .get(&required)
                .ok_or(CapitalError::InvalidUpstreamAuthority(
                    "RMC-008 and RMC-009 consumption receipts are required",
                ))?;
            let authority = self
                .stages
                .iter()
                .find(|authority| authority.stage == required)
                .ok_or(CapitalError::InvalidUpstreamAuthority(
                    "consumption receipt stage authority is missing",
                ))?;
            if receipt.authority_artifact_sha256() != authority.artifact_sha256 {
                return Err(CapitalError::InvalidUpstreamAuthority(
                    "consumption receipt does not bind the admitted stage artifact",
                ));
            }
        }
        if by_stage.len() != 2 {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "unexpected upstream consumption receipt",
            ));
        }
        self.consumption_receipts = by_stage;
        self.commitment = upstream_authority_commitment(
            &self.stages,
            &self.admitted_evidence,
            &self.consumption_receipts,
        )?;
        Ok(self)
    }

    fn has_required_consumption_receipts(&self) -> bool {
        self.consumption_receipts.len() == 2
            && self
                .consumption_receipts
                .contains_key(&UpstreamCensusStage::Rmc008StateAdmission)
            && self
                .consumption_receipts
                .contains_key(&UpstreamCensusStage::Rmc009PositionUniverse)
    }

    pub const fn commitment(&self) -> Hash32 {
        self.commitment
    }

    pub fn stages(&self) -> &[UpstreamStageAuthority] {
        &self.stages
    }

    pub const fn observation_anchor(&self) -> &StateAnchor {
        &self.observation_anchor
    }

    pub fn admitted_evidence(&self) -> impl Iterator<Item = &CapitalEvidenceRef> {
        self.admitted_evidence.iter()
    }

    pub fn consumption_receipts(&self) -> impl Iterator<Item = &UpstreamConsumptionReceipt> {
        self.consumption_receipts.values()
    }

    pub fn admits_evidence(&self, reference: &CapitalEvidenceRef) -> bool {
        self.admitted_evidence.contains(reference)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalCensusCertificate {
    pub commitment: CapitalCensusCommitment,
    pub upstream_authority_commitment: Hash32,
    pub summary: CapitalCensusSummary,
}

#[derive(Debug)]
pub struct CapitalCensusLedger {
    mode: CapitalLedgerMode,
    sources: BTreeMap<CapitalSourceId, CapitalSource>,
    source_keys: BTreeMap<CapitalSourceKeyId, CapitalSourceId>,
    requirements: BTreeMap<CapitalRequirementId, CapitalRequirement>,
    results: BTreeMap<CapitalRequirementId, CapitalFeasibility>,
}

impl Default for CapitalCensusLedger {
    fn default() -> Self {
        Self::synthetic_fixture()
    }
}

impl CapitalCensusLedger {
    pub fn synthetic_fixture() -> Self {
        Self {
            mode: CapitalLedgerMode::SyntheticFixture,
            sources: BTreeMap::new(),
            source_keys: BTreeMap::new(),
            requirements: BTreeMap::new(),
            results: BTreeMap::new(),
        }
    }

    pub fn evidentiary() -> Self {
        Self {
            mode: CapitalLedgerMode::Evidentiary,
            sources: BTreeMap::new(),
            source_keys: BTreeMap::new(),
            requirements: BTreeMap::new(),
            results: BTreeMap::new(),
        }
    }

    pub const fn mode(&self) -> CapitalLedgerMode {
        self.mode
    }

    pub fn register_source(&mut self, source: CapitalSource) -> Result<(), CapitalError> {
        if self.sources.contains_key(&source.id()) {
            return Err(CapitalError::DuplicateSource);
        }
        if self.source_keys.contains_key(&source.key_id()) {
            return Err(CapitalError::ConflictingSourceState);
        }
        self.source_keys.insert(source.key_id(), source.id());
        self.sources.insert(source.id(), source);
        Ok(())
    }

    pub fn register_requirement(
        &mut self,
        requirement: CapitalRequirement,
    ) -> Result<(), CapitalError> {
        if self.requirements.contains_key(&requirement.id()) {
            return Err(CapitalError::DuplicateRequirement);
        }
        self.requirements.insert(requirement.id(), requirement);
        Ok(())
    }

    pub fn evaluate_all(&mut self) -> Result<(), CapitalError> {
        self.results.clear();
        let sources = self.sources.values().cloned().collect::<Vec<_>>();
        for requirement in self.requirements.values() {
            let result = evaluate_capital_feasibility_checked(requirement, &sources)?;
            self.results.insert(requirement.id(), result);
        }
        self.validate_allocations()
    }

    pub fn result(&self, id: CapitalRequirementId) -> Option<&CapitalFeasibility> {
        self.results.get(&id)
    }

    pub fn sources(&self) -> impl Iterator<Item = &CapitalSource> {
        self.sources.values()
    }

    pub fn requirements(&self) -> impl Iterator<Item = &CapitalRequirement> {
        self.requirements.values()
    }

    pub fn results(&self) -> impl Iterator<Item = &CapitalFeasibility> {
        self.results.values()
    }

    pub fn commitment(&self) -> Result<CapitalCensusCommitment, CapitalError> {
        if self.results.len() != self.requirements.len() {
            return Err(CapitalError::UnevaluatedRequirement);
        }
        self.validate_allocations()?;

        let mut hasher = Sha256::new();
        hasher.update(LEDGER_DOMAIN);
        hasher.update([0]);

        for source in self.sources.values() {
            let encoded = source.canonical_encode();
            hasher.update(source.key_id().as_bytes());
            hasher.update(source.id().as_bytes());
            hasher.update(
                u64::try_from(encoded.len())
                    .unwrap_or(u64::MAX)
                    .to_be_bytes(),
            );
            hasher.update(domain_hash(b"NQC-RMC011-SOURCE-RECORD-V1", &encoded));
        }
        for requirement in self.requirements.values() {
            let encoded = requirement.canonical_encode();
            hasher.update(requirement.id().as_bytes());
            hasher.update(
                u64::try_from(encoded.len())
                    .unwrap_or(u64::MAX)
                    .to_be_bytes(),
            );
            hasher.update(domain_hash(b"NQC-RMC011-REQUIREMENT-RECORD-V1", &encoded));
        }
        for result in self.results.values() {
            let encoded = encode_feasibility(result);
            hasher.update(
                u64::try_from(encoded.len())
                    .unwrap_or(u64::MAX)
                    .to_be_bytes(),
            );
            hasher.update(encoded);
        }

        Ok(CapitalCensusCommitment(finalize_sha256(hasher)))
    }

    pub fn certify(
        &self,
        authority: &CapitalCertificationContext,
    ) -> Result<CapitalCensusCertificate, CapitalError> {
        if self.mode != CapitalLedgerMode::Evidentiary {
            return Err(CapitalError::NonEvidentiaryLedger);
        }
        if self.results.len() != self.requirements.len() {
            return Err(CapitalError::UnevaluatedRequirement);
        }
        if self
            .sources
            .values()
            .any(|source| source.anchor() != authority.observation_anchor())
            || self
                .requirements
                .values()
                .any(|requirement| requirement.anchor() != authority.observation_anchor())
        {
            return Err(CapitalError::AnchorMismatch);
        }
        if self.sources.values().any(|source| {
            source
                .evidence()
                .iter()
                .any(|reference| !authority.admits_evidence(reference))
        }) || self.requirements.values().any(|requirement| {
            requirement
                .evidence()
                .iter()
                .any(|reference| !authority.admits_evidence(reference))
        }) {
            return Err(CapitalError::UnresolvedEvidenceRef);
        }
        if !authority.has_required_consumption_receipts() {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "RMC-008 and RMC-009 consumption receipts are required for certification",
            ));
        }
        self.validate_consumed_output_bindings(authority)?;
        self.validate_settlements()?;
        let summary = self.summary()?;
        if summary.source_count == 0 {
            return Err(CapitalError::EmptyCapitalCensus);
        }
        let commitment = self.commitment()?;
        Ok(CapitalCensusCertificate {
            commitment,
            upstream_authority_commitment: authority.commitment(),
            summary,
        })
    }

    fn validate_consumed_output_bindings(
        &self,
        authority: &CapitalCertificationContext,
    ) -> Result<(), CapitalError> {
        let d08 = authority
            .consumption_receipts
            .get(&UpstreamCensusStage::Rmc008StateAdmission)
            .ok_or(CapitalError::InvalidUpstreamAuthority(
                "RMC-008 consumption receipt missing",
            ))?;
        let (source_count, source_set_commitment) =
            source_output_set_commitment(self.sources.values())?;
        if d08.output_count != source_count || d08.output_set_commitment != source_set_commitment {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "capital source ledger does not equal the consumed RMC-008 source set",
            ));
        }

        let d09 = authority
            .consumption_receipts
            .get(&UpstreamCensusStage::Rmc009PositionUniverse)
            .ok_or(CapitalError::InvalidUpstreamAuthority(
                "RMC-009 consumption receipt missing",
            ))?;
        let (requirement_count, requirement_set_commitment) =
            requirement_output_set_commitment(self.requirements.values())?;
        if d09.output_count != requirement_count
            || d09.output_set_commitment != requirement_set_commitment
        {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "capital requirement ledger does not equal the consumed RMC-009 requirement set",
            ));
        }
        Ok(())
    }

    pub fn summary(&self) -> Result<CapitalCensusSummary, CapitalError> {
        self.validate_allocations()?;
        let mut sources_by_class = BTreeMap::new();
        let mut operator_owned_sources_observed = 0_usize;
        for source in self.sources.values() {
            *sources_by_class.entry(source.class()).or_insert(0) += 1;
            if source.ownership().is_operator_owned() {
                operator_owned_sources_observed += 1;
            }
        }

        let mut feasible_count = 0_usize;
        let mut feasible_external_gas_count = 0_usize;
        let mut rejected_count = 0_usize;
        let mut operator_owned_sources_used = 0_usize;
        for result in self.results.values() {
            match result {
                CapitalFeasibility::Feasible {
                    requirement_id,
                    allocations,
                } => {
                    feasible_count += 1;
                    let requirement = self.requirements.get(requirement_id).ok_or(
                        CapitalError::InvalidCanonical(
                            "feasible result references missing requirement",
                        ),
                    )?;
                    let required_gas = if requirement.requires_native_gas() {
                        declared_leg_total(
                            requirement,
                            RequirementKind::Gas,
                            CapitalAsset::NativeGas,
                        )?
                    } else {
                        Amount256::ZERO
                    };
                    let mut external_gas_funded = Amount256::ZERO;
                    for allocation in allocations {
                        let source = self
                            .sources
                            .get(&allocation.source_id)
                            .ok_or(CapitalError::MissingSourceForAllocation)?;
                        if source.ownership().is_operator_owned() {
                            operator_owned_sources_used += 1;
                        }
                        if allocation.leg_kind == RequirementKind::Gas
                            && source.class() == CapitalClass::GasFunding
                            && source.ownership() == CapitalOwnership::External
                        {
                            external_gas_funded =
                                external_gas_funded.checked_add(allocation.amount)?;
                        }
                    }
                    if !required_gas.is_zero() && external_gas_funded == required_gas {
                        feasible_external_gas_count += 1;
                    }
                }
                CapitalFeasibility::Rejected { .. } => rejected_count += 1,
            }
        }

        let summary = CapitalCensusSummary {
            source_count: self.sources.len(),
            requirement_count: self.requirements.len(),
            feasible_count,
            feasible_external_gas_count,
            rejected_count,
            operator_owned_sources_observed,
            operator_owned_sources_used,
            sources_by_class,
        };
        if !summary.is_conserved() {
            return Err(CapitalError::InvalidCanonical(
                "capital feasibility result conservation failed",
            ));
        }
        if !summary.uses_zero_operator_capital() {
            return Err(CapitalError::OperatorOwnedAllocation);
        }
        Ok(summary)
    }

    fn validate_settlements(&self) -> Result<(), CapitalError> {
        let sources = self.sources.values().cloned().collect::<Vec<_>>();
        for (requirement_id, result) in &self.results {
            if !matches!(result, CapitalFeasibility::Feasible { .. }) {
                continue;
            }
            let requirement =
                self.requirements
                    .get(requirement_id)
                    .ok_or(CapitalError::InvalidCanonical(
                        "feasibility result lacks registered requirement",
                    ))?;
            validate_settlement_requirements(requirement, result, &sources)?;
        }
        Ok(())
    }

    fn validate_allocations(&self) -> Result<(), CapitalError> {
        for result in self.results.values() {
            if let CapitalFeasibility::Feasible { allocations, .. } = result {
                for allocation in allocations {
                    let source = self
                        .sources
                        .get(&allocation.source_id)
                        .ok_or(CapitalError::MissingSourceForAllocation)?;
                    if source.ownership().is_operator_owned() {
                        return Err(CapitalError::OperatorOwnedAllocation);
                    }
                }
            }
        }
        Ok(())
    }
}

fn encode_feasibility(result: &CapitalFeasibility) -> Vec<u8> {
    let mut writer = Writer::default();
    match result {
        CapitalFeasibility::Feasible {
            requirement_id,
            allocations,
        } => {
            writer.u8(1);
            writer.bytes(requirement_id.as_bytes());
            writer.u32(u32::try_from(allocations.len()).unwrap_or(u32::MAX));
            for allocation in allocations {
                writer.bytes(allocation.source_id.as_bytes());
                writer.u8(allocation.leg_kind.tag());
                writer.bytes(allocation.amount.as_be_bytes());
            }
        }
        CapitalFeasibility::Rejected {
            requirement_id,
            reason,
            failed_leg,
        } => {
            writer.u8(2);
            writer.bytes(requirement_id.as_bytes());
            writer.u8(reason.tag());
            match failed_leg {
                None => writer.u8(0),
                Some(kind) => {
                    writer.u8(1);
                    writer.u8(kind.tag());
                }
            }
        }
    }
    writer.0
}

fn has_leg(requirement: &CapitalRequirement, kind: RequirementKind, asset: CapitalAsset) -> bool {
    requirement
        .legs()
        .iter()
        .any(|leg| leg.kind() == kind && leg.asset() == asset)
}

fn declared_leg_total(
    requirement: &CapitalRequirement,
    kind: RequirementKind,
    asset: CapitalAsset,
) -> Result<Amount256, CapitalError> {
    let mut total = Amount256::ZERO;
    for leg in requirement
        .legs()
        .iter()
        .filter(|leg| leg.kind() == kind && leg.asset() == asset)
    {
        total = total.checked_add(leg.amount())?;
    }
    Ok(total)
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
    mul_div_u64_round(amount, u64::from(bps), 10_000, RoundingMode::Floor)
}

fn mul_div_u64_round(
    amount: Amount256,
    numerator: u64,
    denominator: u64,
    rounding: RoundingMode,
) -> Result<Amount256, CapitalError> {
    if denominator == 0 {
        return Err(CapitalError::InvalidRatio);
    }
    if numerator == 0 || amount.is_zero() {
        return Ok(Amount256::ZERO);
    }

    // Multiply the 256-bit amount by a 64-bit numerator into a 320-bit
    // intermediate, then divide that exact intermediate by a 64-bit
    // denominator. Rounding is applied only after the exact quotient and
    // remainder are known.
    let mut product = [0_u8; 40];
    let mut carry = 0_u128;
    for index in (0..32).rev() {
        let expanded = u128::from(amount.0[index]) * u128::from(numerator) + carry;
        product[index + 8] = u8::try_from(expanded & 0xff)
            .map_err(|_| CapitalError::InvalidCanonical("fee multiplication conversion"))?;
        carry = expanded >> 8;
    }
    for index in (0..8).rev() {
        product[index] = u8::try_from(carry & 0xff)
            .map_err(|_| CapitalError::InvalidCanonical("fee carry conversion"))?;
        carry >>= 8;
    }
    if carry != 0 {
        return Err(CapitalError::InvalidCanonical(
            "fee multiplication overflow",
        ));
    }

    let divisor = u128::from(denominator);
    let mut quotient = [0_u8; 40];
    let mut remainder = 0_u128;
    for (index, byte) in product.iter().copied().enumerate() {
        let expanded = remainder * 256 + u128::from(byte);
        let digit = expanded / divisor;
        if digit > 255 {
            return Err(CapitalError::InvalidCanonical(
                "fee quotient digit overflow",
            ));
        }
        quotient[index] = u8::try_from(digit)
            .map_err(|_| CapitalError::InvalidCanonical("fee quotient conversion"))?;
        remainder = expanded % divisor;
    }

    if quotient[..8].iter().any(|byte| *byte != 0) {
        return Err(CapitalError::InvalidCanonical("fee result exceeds uint256"));
    }
    let mut out = [0_u8; 32];
    out.copy_from_slice(&quotient[8..]);
    let floor = Amount256::from_be_bytes(out);

    let round_up = match rounding {
        RoundingMode::Floor => false,
        RoundingMode::Ceil => remainder != 0,
        RoundingMode::HalfUp => {
            let threshold = u128::from(denominator / 2 + denominator % 2);
            remainder >= threshold
        }
    };
    if round_up {
        floor.checked_add(Amount256::from_u128(1))
    } else {
        Ok(floor)
    }
}

fn encode_chain(chain: &ChainDomain, writer: &mut Writer) {
    writer.u64(chain.chain_id());
    writer.bytes(chain.genesis_hash().as_bytes());
    writer.bytes(chain.fork_lineage().as_bytes());
}

fn encode_anchor_into_hasher(anchor: &StateAnchor, hasher: &mut Sha256) {
    hasher.update(anchor.chain().chain_id().to_be_bytes());
    hasher.update(anchor.chain().genesis_hash().as_bytes());
    hasher.update(anchor.chain().fork_lineage().as_bytes());
    hasher.update(anchor.block_number().to_be_bytes());
    hasher.update(anchor.block_hash().as_bytes());
    hasher.update(anchor.parent_hash().as_bytes());
    hasher.update(anchor.timestamp().to_be_bytes());
    hasher.update(anchor.state_root().as_bytes());
}

fn encode_anchor(anchor: &StateAnchor, writer: &mut Writer) {
    encode_chain(anchor.chain(), writer);
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
    finalize_sha256(hasher)
}

fn finalize_sha256(hasher: Sha256) -> [u8; 32] {
    let digest = hasher.finalize();
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn hex_nibble(byte: u8) -> Result<u8, CapitalError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(CapitalError::InvalidGitObjectId),
    }
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

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
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
