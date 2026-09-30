use crate::{
    Amount256, CapitalAsset, CapitalCaps, CapitalClass, CapitalError, CapitalEvidenceRef,
    CapitalFailureMode, CapitalOwnership, CapitalProviderKind, CapitalSource, CapitalSourceSpec,
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
        let flash_loan_enabled = self.flash_loan_enabled;
        let source = CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::ProtocolNativeFlashLoan,
            anchor: self.anchor,
            provider_namespace: AAVE_V3_PROVIDER_NAMESPACE,
            provider_locator_hash: self.provider_locator_hash,
            provider_kind: CapitalProviderKind::ProtocolContract,
            ownership: CapitalOwnership::External,
            source_contract: Some(self.pool),
            asset: CapitalAsset::Token(self.asset),
            maximum_available: self.available_underlying,
            // PFT-COMPAT-009 measured the deployed Aave V3 flashLoanSimple
            // callback and proved positive fractional premiums round upward.
            // Half-up underquoted real repayment by one unit in the certified
            // historical witness.
            fee_model: FeeModel::basis_points_with_rounding(
                self.premium_total_bps,
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
                CapitalFailureMode::ProtocolCapReached,
                CapitalFailureMode::RepaymentFailure,
                CapitalFailureMode::CallbackOrHookRevert,
            ],
            evidence: self.evidence,
        })?;
        if flash_loan_enabled {
            Ok(source)
        } else {
            source.with_execution_blockers(vec!["FLASH_LOAN_DISABLED".to_owned()])
        }
    }
}

#[derive(Debug, Clone)]
pub struct BalancerV2FlashObservation {
    pub anchor: StateAnchor,
    pub vault: Address,
    pub asset: Address,
    pub available_vault_balance: Amount256,
    pub fee_percentage_1e18: u64,
    pub paused: bool,
    pub provider_locator_hash: Hash32,
    pub evidence: Vec<CapitalEvidenceRef>,
}

impl BalancerV2FlashObservation {
    pub fn into_capital_source(self) -> Result<CapitalSource, CapitalError> {
        let paused = self.paused;
        let source = CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::AtomicFlashLiquidity,
            anchor: self.anchor,
            provider_namespace: BALANCER_V2_PROVIDER_NAMESPACE,
            provider_locator_hash: self.provider_locator_hash,
            provider_kind: CapitalProviderKind::ProtocolContract,
            ownership: CapitalOwnership::External,
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
        })?;
        if paused {
            source.with_execution_blockers(vec!["BALANCER_VAULT_PAUSED".to_owned()])
        } else {
            Ok(source)
        }
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

        // Uniswap V2 requires amountOut < reserve. A reserve that cannot
        // support a positive draw is still an observed source at this exact
        // anchor; preserve it with zero capacity rather than erasing it from
        // the Capital Census.
        let maximum_available = if self.reserve <= one {
            Amount256::ZERO
        } else {
            self.reserve.checked_sub(one)?
        };

        // For same-token repayment, the exact extra amount required by the
        // 0.3% invariant is ceil(amount_out * 3 / 997).
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::FlashSwap,
            anchor: self.anchor,
            provider_namespace: UNISWAP_V2_PROVIDER_NAMESPACE,
            provider_locator_hash: self.provider_locator_hash,
            provider_kind: CapitalProviderKind::DexLiquidityPool,
            ownership: CapitalOwnership::External,
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
            ownership: CapitalOwnership::External,
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
pub struct ExternalGasCreditObservation {
    pub anchor: StateAnchor,
    pub provider_namespace: u16,
    pub provider_locator_hash: Hash32,
    pub facility_contract: Address,
    pub maximum_native_gas: Amount256,
    pub fee_model: FeeModel,
    pub repayment_deadline_blocks: u32,
    pub max_utilization_bps: u16,
    pub min_remaining_native_gas: Amount256,
    pub protocol_cap: Option<Amount256>,
    pub market_cap: Option<Amount256>,
    pub active: bool,
    pub evidence: Vec<CapitalEvidenceRef>,
}

impl ExternalGasCreditObservation {
    pub fn into_capital_source(self) -> Result<CapitalSource, CapitalError> {
        if let FeeModel::Fixed { asset, .. } = self.fee_model {
            if asset != CapitalAsset::NativeGas {
                return Err(CapitalError::InvalidCanonical(
                    "gas credit fixed fee must use native gas",
                ));
            }
        }

        let active = self.active;
        let source = CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::GasFunding,
            anchor: self.anchor,
            provider_namespace: self.provider_namespace,
            provider_locator_hash: self.provider_locator_hash,
            provider_kind: CapitalProviderKind::ExternalCreditFacility,
            ownership: CapitalOwnership::External,
            source_contract: Some(self.facility_contract),
            asset: CapitalAsset::NativeGas,
            maximum_available: self.maximum_native_gas,
            fee_model: self.fee_model,
            repayment_asset: CapitalAsset::NativeGas,
            repayment: RepaymentSemantics::DeadlineBlocks(self.repayment_deadline_blocks),
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(
                self.max_utilization_bps,
                self.min_remaining_native_gas,
            )?,
            caps: CapitalCaps {
                protocol_cap: self.protocol_cap,
                market_cap: self.market_cap,
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
            evidence: self.evidence,
        })?;
        if active {
            Ok(source)
        } else {
            source.with_execution_blockers(vec!["GAS_CREDIT_FACILITY_INACTIVE".to_owned()])
        }
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
        if let FeeModel::Fixed { asset, .. } = self.fee_model {
            if asset != self.fee_asset {
                return Err(CapitalError::InvalidCanonical(
                    "gas sponsor fixed fee asset differs from declared fee asset",
                ));
            }
        }

        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::GasFunding,
            anchor: self.anchor,
            provider_namespace: self.provider_namespace,
            provider_locator_hash: self.provider_locator_hash,
            provider_kind: CapitalProviderKind::ExternalSponsor,
            ownership: CapitalOwnership::External,
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
