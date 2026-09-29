use crate::{
    Amount256, CapitalAsset, CapitalCaps, CapitalClass, CapitalError, CapitalEvidenceRef,
    CapitalFailureMode, CapitalProviderKind, CapitalSource, CapitalSourceSpec,
    CollateralRequirement, FeeModel, RepaymentSemantics, RoundingMode, TemporaryLock,
    UtilizationConstraints,
};
use nqc_census_core::{Address, Hash32, StateAnchor};

pub const AAVE_V3_PROVIDER_NAMESPACE: u16 = 0x1103;
pub const BALANCER_V2_PROVIDER_NAMESPACE: u16 = 0x1202;

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
