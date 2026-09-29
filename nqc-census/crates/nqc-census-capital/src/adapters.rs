use crate::{
    Amount256, CapitalAsset, CapitalCaps, CapitalClass, CapitalError, CapitalEvidenceRef,
    CapitalFailureMode, CapitalProviderKind, CapitalSource, CapitalSourceSpec,
    CollateralRequirement, FeeModel, RepaymentSemantics, RoundingMode, TemporaryLock,
    UtilizationConstraints,
};
use nqc_census_core::{Address, Hash32, StateAnchor};

pub const AAVE_V3_PROVIDER_NAMESPACE: u16 = 0x1103;
pub const BALANCER_V2_PROVIDER_NAMESPACE: u16 = 0x1202;
pub const UNISWAP_V2_PROVIDER_NAMESPACE: u16 = 0x1302;
pub const UNISWAP_V3_PROVIDER_NAMESPACE: u16 = 0x1303;

#[derive(Debug, Clone)]
pub struct AaveV3FlashObservation {
    pub anchor: StateAnchor,
    pub pool: Address,
    pub asset: Address,
    pub available_underlying: Amount256,
    pub premium_total_bps: u16,
    pub flash_loan_enabled: bool,
    pub provider_locator_hash: Hash32,
    pub evidence: Vec<CapitalEvidenceRef>,
}

impl AaveV3FlashObservation {
    pub fn into_capital_source(self) -> Result<CapitalSource, CapitalError> {
        if !self.flash_loan_enabled {
            return Err(CapitalError::NoCompatibleSource);
        }
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::ProtocolNativeFlashLoan,
            anchor: self.anchor,
            provider_namespace: AAVE_V3_PROVIDER_NAMESPACE,
            provider_locator_hash: self.provider_locator_hash,
            provider_kind: CapitalProviderKind::ProtocolContract,
            source_contract: Some(self.pool),
            asset: CapitalAsset::Token(self.asset),
            maximum_available: self.available_underlying,
            fee_model: FeeModel::basis_points_with_rounding(
                self.premium_total_bps,
                RoundingMode::HalfUp,
            )?,
            repayment_asset: CapitalAsset::Token(self.asset),
            repayment: RepaymentSemantics::AtomicSameTransaction,
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
            caps: CapitalCaps::none(),
            temporary_lock: TemporaryLock::None,
            failure_modes: vec![
                CapitalFailureMode::SourceUnavailable,
                CapitalFailureMode::CapacityChanged,
                CapitalFailureMode::FeeChanged,
                CapitalFailureMode::ProtocolCapReached,
                CapitalFailureMode::RepaymentFailure,
                CapitalFailureMode::CallbackOrHookRevert,
            ],
            evidence: self.evidence,
        })
    }
}

#[derive(Debug, Clone)]
pub struct BalancerV2FlashObservation {
    pub anchor: StateAnchor,
    pub vault: Address,
    pub asset: Address,
    pub available_vault_balance: Amount256,
    pub fee_percentage_1e18: u64,
    pub provider_locator_hash: Hash32,
    pub evidence: Vec<CapitalEvidenceRef>,
}

impl BalancerV2FlashObservation {
    pub fn into_capital_source(self) -> Result<CapitalSource, CapitalError> {
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::AtomicFlashLiquidity,
            anchor: self.anchor,
            provider_namespace: BALANCER_V2_PROVIDER_NAMESPACE,
            provider_locator_hash: self.provider_locator_hash,
            provider_kind: CapitalProviderKind::ProtocolContract,
            source_contract: Some(self.vault),
            asset: CapitalAsset::Token(self.asset),
            maximum_available: self.available_vault_balance,
            fee_model: FeeModel::exact_ratio_with_rounding(
                self.fee_percentage_1e18,
                1_000_000_000_000_000_000,
                RoundingMode::Ceil,
            )?,
            repayment_asset: CapitalAsset::Token(self.asset),
            repayment: RepaymentSemantics::AtomicSameTransaction,
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
            caps: CapitalCaps::none(),
            temporary_lock: TemporaryLock::None,
            failure_modes: vec![
                CapitalFailureMode::SourceUnavailable,
                CapitalFailureMode::CapacityChanged,
                CapitalFailureMode::FeeChanged,
                CapitalFailureMode::RepaymentFailure,
                CapitalFailureMode::CallbackOrHookRevert,
            ],
            evidence: self.evidence,
        })
    }
}

#[derive(Debug, Clone)]
pub struct UniswapV2FlashSwapObservation {
    pub anchor: StateAnchor,
    pub pair: Address,
    pub asset: Address,
    pub reserve: Amount256,
    pub provider_locator_hash: Hash32,
    pub evidence: Vec<CapitalEvidenceRef>,
}

impl UniswapV2FlashSwapObservation {
    pub fn into_capital_source(self) -> Result<CapitalSource, CapitalError> {
        let one = Amount256::from_u128(1);
        if self.reserve <= one {
            return Err(CapitalError::NoCompatibleSource);
        }

        // Uniswap V2 requires amountOut < reserve, so the largest same-token
        // flash-swap draw is reserve - 1 base unit. For same-token repayment,
        // the exact extra amount required by the 0.3% invariant is
        // ceil(amount_out * 3 / 997).
        let maximum_available = self.reserve.checked_sub(one)?;
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::FlashSwap,
            anchor: self.anchor,
            provider_namespace: UNISWAP_V2_PROVIDER_NAMESPACE,
            provider_locator_hash: self.provider_locator_hash,
            provider_kind: CapitalProviderKind::DexLiquidityPool,
            source_contract: Some(self.pair),
            asset: CapitalAsset::Token(self.asset),
            maximum_available,
            fee_model: FeeModel::exact_ratio_with_rounding(3, 997, RoundingMode::Ceil)?,
            repayment_asset: CapitalAsset::Token(self.asset),
            repayment: RepaymentSemantics::AtomicSameTransaction,
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
            caps: CapitalCaps::none(),
            temporary_lock: TemporaryLock::None,
            failure_modes: vec![
                CapitalFailureMode::SourceUnavailable,
                CapitalFailureMode::CapacityChanged,
                CapitalFailureMode::RepaymentFailure,
                CapitalFailureMode::CallbackOrHookRevert,
            ],
            evidence: self.evidence,
        })
    }
}

#[derive(Debug, Clone)]
pub struct UniswapV3FlashObservation {
    pub anchor: StateAnchor,
    pub pool: Address,
    pub asset: Address,
    pub available_pool_balance: Amount256,
    pub fee_pips: u32,
    pub provider_locator_hash: Hash32,
    pub evidence: Vec<CapitalEvidenceRef>,
}

impl UniswapV3FlashObservation {
    pub fn into_capital_source(self) -> Result<CapitalSource, CapitalError> {
        if self.fee_pips > 1_000_000 {
            return Err(CapitalError::InvalidRatio);
        }
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::AtomicFlashLiquidity,
            anchor: self.anchor,
            provider_namespace: UNISWAP_V3_PROVIDER_NAMESPACE,
            provider_locator_hash: self.provider_locator_hash,
            provider_kind: CapitalProviderKind::DexLiquidityPool,
            source_contract: Some(self.pool),
            asset: CapitalAsset::Token(self.asset),
            maximum_available: self.available_pool_balance,
            fee_model: FeeModel::exact_ratio_with_rounding(
                u64::from(self.fee_pips),
                1_000_000,
                RoundingMode::Ceil,
            )?,
            repayment_asset: CapitalAsset::Token(self.asset),
            repayment: RepaymentSemantics::AtomicSameTransaction,
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
            caps: CapitalCaps::none(),
            temporary_lock: TemporaryLock::None,
            failure_modes: vec![
                CapitalFailureMode::SourceUnavailable,
                CapitalFailureMode::CapacityChanged,
                CapitalFailureMode::FeeChanged,
                CapitalFailureMode::RepaymentFailure,
                CapitalFailureMode::CallbackOrHookRevert,
            ],
            evidence: self.evidence,
        })
    }
}

#[derive(Debug, Clone)]
pub struct ExternalGasSponsorObservation {
    pub anchor: StateAnchor,
    pub provider_namespace: u16,
    pub provider_locator_hash: Hash32,
    pub sponsor_contract: Option<Address>,
    pub maximum_native_gas: Amount256,
    pub fee_model: FeeModel,
    pub fee_asset: CapitalAsset,
    pub evidence: Vec<CapitalEvidenceRef>,
}

impl ExternalGasSponsorObservation {
    pub fn into_capital_source(self) -> Result<CapitalSource, CapitalError> {
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::GasFunding,
            anchor: self.anchor,
            provider_namespace: self.provider_namespace,
            provider_locator_hash: self.provider_locator_hash,
            provider_kind: CapitalProviderKind::ExternalSponsor,
            source_contract: self.sponsor_contract,
            asset: CapitalAsset::NativeGas,
            maximum_available: self.maximum_native_gas,
            fee_model: self.fee_model,
            repayment_asset: self.fee_asset,
            repayment: RepaymentSemantics::NoRepayment,
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
            caps: CapitalCaps::none(),
            temporary_lock: TemporaryLock::None,
            failure_modes: vec![
                CapitalFailureMode::SourceUnavailable,
                CapitalFailureMode::CapacityChanged,
                CapitalFailureMode::FeeChanged,
            ],
            evidence: self.evidence,
        })
    }
}
