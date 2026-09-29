use nqc_census_capital::{
    evaluate_capital_feasibility, Amount256, CapitalAsset, CapitalCaps, CapitalCensusLedger,
    CapitalClass, CapitalEvidenceRef, CapitalFailureMode, CapitalFeasibility, CapitalProviderKind,
    CapitalRequirement, CapitalRequirementLeg, CapitalSource, CapitalSourceSpec, CapitalTargetId,
    CollateralRequirement, FeeModel, PersistentDebtTerms, RepaymentSemantics, RequiredAtomicity,
    RequirementKind, TemporaryLock, UtilizationConstraints,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Hash32 {
    Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
}

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!())
}

fn anchor(block: u64) -> StateAnchor {
    StateAnchor::new(
        ChainDomain::new(1, hash(1), hash(2)).unwrap_or_else(|_| unreachable!()),
        block,
        hash(3),
        hash(4),
        1_700_000_000,
        hash(5),
    )
    .unwrap_or_else(|_| unreachable!())
}

fn evidence() -> Vec<CapitalEvidenceRef> {
    vec![CapitalEvidenceRef::Artifact(hash(99))]
}

fn source(
    class: CapitalClass,
    asset: CapitalAsset,
    maximum: u128,
    repayment_asset: CapitalAsset,
    repayment: RepaymentSemantics,
) -> Result<CapitalSource, nqc_census_capital::CapitalError> {
    CapitalSource::new(CapitalSourceSpec {
        class,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        source_contract: Some(address(13)),
        asset,
        maximum_available: Amount256::from_u128(maximum),
        fee_model: FeeModel::basis_points(5)?,
        repayment_asset,
        repayment,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::SourceUnavailable,
            CapitalFailureMode::CapacityChanged,
        ],
        evidence: evidence(),
    })
}

fn repayment_leg(
    asset: CapitalAsset,
) -> Result<CapitalRequirementLeg, nqc_census_capital::CapitalError> {
    CapitalRequirementLeg::new(
        RequirementKind::Repayment,
        asset,
        Amount256::from_u128(1),
        vec![
            CapitalClass::ProtocolNativeFlashLoan,
            CapitalClass::AtomicFlashLiquidity,
            CapitalClass::FlashSwap,
            CapitalClass::TransientCredit,
            CapitalClass::GasFunding,
            CapitalClass::InventoryRequirement,
        ],
    )
}

fn requirement(
    legs: Vec<CapitalRequirementLeg>,
    atomicity: RequiredAtomicity,
    requires_gas: bool,
) -> Result<CapitalRequirement, nqc_census_capital::CapitalError> {
    CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(50)),
        anchor(100),
        atomicity,
        requires_gas,
        legs,
        evidence(),
    )
}

#[test]
fn source_id_is_deterministic_and_class_separated() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let a = source(
        CapitalClass::ProtocolNativeFlashLoan,
        asset,
        1_000,
        asset,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let b = source(
        CapitalClass::ProtocolNativeFlashLoan,
        asset,
        1_000,
        asset,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let c = source(
        CapitalClass::AtomicFlashLiquidity,
        asset,
        1_000,
        asset,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    assert_eq!(a.id(), b.id());
    assert_ne!(a.id(), c.id());
    Ok(())
}

#[test]
fn source_canonical_roundtrip_and_tamper_rejection() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let source = source(
        CapitalClass::FlashSwap,
        asset,
        9_999,
        asset,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let encoded = source.canonical_encode();
    let decoded = CapitalSource::decode_canonical(&encoded)?;
    assert_eq!(decoded, source);

    let mut tampered = encoded;
    let index = tampered.len() / 2;
    tampered[index] ^= 0x01;
    assert!(CapitalSource::decode_canonical(&tampered).is_err());
    Ok(())
}

#[test]
fn persistent_debt_cannot_hide_missing_risk_terms() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let result = source(
        CapitalClass::PersistentDebt,
        asset,
        1_000,
        asset,
        RepaymentSemantics::SameBlock,
    );
    assert!(matches!(
        result,
        Err(nqc_census_capital::CapitalError::PersistentDebtTermsRequired)
    ));
    Ok(())
}

#[test]
fn persistent_debt_requires_collateral_semantics() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let terms = PersistentDebtTerms {
        interest_model_hash: hash(21),
        liquidation_model_hash: hash(22),
        solvency_model_hash: hash(23),
        oracle_risk_hash: hash(24),
        liquidity_withdrawal_risk_hash: hash(25),
        facility_disappearance_risk_hash: hash(26),
    };
    let result = source(
        CapitalClass::PersistentDebt,
        asset,
        1_000,
        asset,
        RepaymentSemantics::Persistent(terms),
    );
    assert!(matches!(
        result,
        Err(nqc_census_capital::CapitalError::CollateralSemanticsRequired)
    ));
    Ok(())
}

#[test]
fn unknown_source_failure_mode_is_never_admitted() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let result = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        source_contract: Some(address(13)),
        asset,
        maximum_available: Amount256::from_u128(100),
        fee_model: FeeModel::None,
        repayment_asset: asset,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::Unknown],
        evidence: evidence(),
    });
    assert!(matches!(
        result,
        Err(nqc_census_capital::CapitalError::UnknownFailureMode)
    ));
    Ok(())
}

#[test]
fn gas_is_independent_and_required() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(500),
        vec![CapitalClass::ProtocolNativeFlashLoan],
    )?;
    let gas = CapitalRequirementLeg::new(
        RequirementKind::Gas,
        CapitalAsset::NativeGas,
        Amount256::from_u128(5),
        vec![CapitalClass::GasFunding],
    )?;
    let req = requirement(
        vec![
            principal,
            gas,
            repayment_leg(token)?,
            repayment_leg(CapitalAsset::NativeGas)?,
        ],
        RequiredAtomicity::SameTransaction,
        true,
    )?;
    let flash = source(
        CapitalClass::ProtocolNativeFlashLoan,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let result = evaluate_capital_feasibility(&req, &[flash]);
    assert!(matches!(
        result,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::MissingGasFunding,
            ..
        }
    ));
    Ok(())
}

#[test]
fn exact_gas_and_flash_sources_can_be_feasible() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(500),
        vec![CapitalClass::ProtocolNativeFlashLoan],
    )?;
    let gas = CapitalRequirementLeg::new(
        RequirementKind::Gas,
        CapitalAsset::NativeGas,
        Amount256::from_u128(5),
        vec![CapitalClass::GasFunding],
    )?;
    let req = requirement(
        vec![
            principal,
            gas,
            repayment_leg(token)?,
            repayment_leg(CapitalAsset::NativeGas)?,
        ],
        RequiredAtomicity::SameTransaction,
        true,
    )?;
    let flash = source(
        CapitalClass::ProtocolNativeFlashLoan,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let gas_source = source(
        CapitalClass::GasFunding,
        CapitalAsset::NativeGas,
        100,
        CapitalAsset::NativeGas,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let result = evaluate_capital_feasibility(&req, &[gas_source, flash]);
    assert!(matches!(result, CapitalFeasibility::Feasible { .. }));
    Ok(())
}

#[test]
fn protocol_cap_limits_effective_capacity() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let mut spec = CapitalSourceSpec {
        class: CapitalClass::AtomicFlashLiquidity,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps {
            protocol_cap: Some(Amount256::from_u128(400)),
            market_cap: Some(Amount256::from_u128(800)),
        },
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::ProtocolCapReached],
        evidence: evidence(),
    };
    let capped = CapitalSource::new(spec.clone())?;
    assert_eq!(capped.effective_capacity()?, Amount256::from_u128(400));
    spec.caps.market_cap = Some(Amount256::from_u128(300));
    let lower = CapitalSource::new(spec)?;
    assert_eq!(lower.effective_capacity()?, Amount256::from_u128(300));
    Ok(())
}

#[test]
fn mismatched_anchor_fails_closed() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let mut spec = CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(101),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    };
    let foreign = CapitalSource::new(spec.clone())?;
    spec.anchor = anchor(100);
    let matching = CapitalSource::new(spec)?;
    assert!(matches!(
        evaluate_capital_feasibility(&req, &[foreign]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::AnchorMismatch,
            ..
        }
    ));
    assert!(matches!(
        evaluate_capital_feasibility(&req, &[matching]),
        CapitalFeasibility::Feasible { .. }
    ));
    Ok(())
}

#[test]
fn same_block_credit_cannot_satisfy_same_transaction_requirement() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::TransientCredit],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let credit = source(
        CapitalClass::TransientCredit,
        token,
        1_000,
        token,
        RepaymentSemantics::SameBlock,
    )?;
    assert!(matches!(
        evaluate_capital_feasibility(&req, &[credit]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::AtomicityMismatch,
            ..
        }
    ));
    Ok(())
}

#[test]
fn requirement_roundtrip_and_cross_type_rejection() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let requirement = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
            repayment_leg(token)?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let bytes = requirement.canonical_encode();
    assert_eq!(CapitalRequirement::decode_canonical(&bytes)?, requirement);

    let source = source(
        CapitalClass::FlashSwap,
        token,
        100,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    assert!(CapitalRequirement::decode_canonical(&source.canonical_encode()).is_err());
    assert!(CapitalSource::decode_canonical(&bytes).is_err());
    Ok(())
}

#[test]
fn zero_capacity_and_amount_edges_fail() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let zero_source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::ZERO,
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    });
    assert!(zero_source.is_err());
    assert!(CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::ZERO,
        vec![CapitalClass::FlashSwap],
    )
    .is_err());
    Ok(())
}

#[test]
fn zero_own_capital_policy_rejects_operator_treasury_source() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::InventoryRequirement],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let operator = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::InventoryRequirement,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::OperatorTreasury,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    })?;
    assert!(matches!(
        evaluate_capital_feasibility(&req, &[operator]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::OperatorOwnedCapitalRequired,
            ..
        }
    ));
    Ok(())
}

#[test]
fn utilization_math_handles_full_256_bit_capacity_exactly() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let mut bytes = [0_u8; 32];
    bytes[0] = 0x80;
    let maximum = Amount256::from_be_bytes(bytes);
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::AtomicFlashLiquidity,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: maximum,
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(5_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    })?;
    let mut expected = [0_u8; 32];
    expected[0] = 0x40;
    assert_eq!(
        source.effective_capacity()?,
        Amount256::from_be_bytes(expected)
    );
    Ok(())
}

#[test]
fn ledger_proves_no_operator_owned_capital_was_used() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let external = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let operator = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::InventoryRequirement,
        anchor: anchor(100),
        provider_namespace: 77,
        provider_locator_hash: hash(78),
        provider_kind: CapitalProviderKind::OperatorTreasury,
        source_contract: Some(address(79)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    })?;

    let mut ledger = CapitalCensusLedger::default();
    ledger.register_source(external)?;
    ledger.register_source(operator)?;
    ledger.register_requirement(req)?;
    ledger.evaluate_all()?;
    let summary = ledger.summary()?;
    assert!(summary.is_conserved());
    assert!(summary.proves_zero_own_capital());
    assert_eq!(summary.operator_owned_sources_observed, 1);
    assert_eq!(summary.operator_owned_sources_used, 0);
    assert_eq!(summary.feasible_count, 1);
    Ok(())
}

#[test]
fn source_key_is_stable_across_state_refreshes() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let first = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    })?;
    let second = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(101),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(2_000),
        fee_model: FeeModel::basis_points(30)?,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(9_000, Amount256::from_u128(10))?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::CapacityChanged,
            CapitalFailureMode::FeeChanged,
        ],
        evidence: evidence(),
    })?;
    assert_eq!(first.key_id(), second.key_id());
    assert_ne!(first.id(), second.id());
    Ok(())
}

#[test]
fn repayment_obligation_does_not_double_count_initial_capital() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let repayment = CapitalRequirementLeg::new(
        RequirementKind::Repayment,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, repayment],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let only_exact_principal = source(
        CapitalClass::FlashSwap,
        token,
        100,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    assert!(matches!(
        evaluate_capital_feasibility(&req, &[only_exact_principal]),
        CapitalFeasibility::Feasible { .. }
    ));
    Ok(())
}

#[test]
fn ledger_commitment_is_registration_order_independent() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let primary = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let spare = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::AtomicFlashLiquidity,
        anchor: anchor(100),
        provider_namespace: 21,
        provider_locator_hash: hash(22),
        provider_kind: CapitalProviderKind::ProtocolContract,
        source_contract: Some(address(23)),
        asset: token,
        maximum_available: Amount256::from_u128(50),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    })?;

    let mut first = CapitalCensusLedger::default();
    first.register_source(primary.clone())?;
    first.register_source(spare.clone())?;
    first.register_requirement(req.clone())?;
    first.evaluate_all()?;

    let mut second = CapitalCensusLedger::default();
    second.register_source(spare)?;
    second.register_source(primary)?;
    second.register_requirement(req)?;
    second.evaluate_all()?;

    assert_eq!(first.commitment()?, second.commitment()?);
    Ok(())
}

#[test]
fn ledger_commitment_changes_with_observed_capacity() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(10),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;

    let make_source = |maximum| {
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::FlashSwap,
            anchor: anchor(100),
            provider_namespace: 11,
            provider_locator_hash: hash(12),
            provider_kind: CapitalProviderKind::DexLiquidityPool,
            source_contract: Some(address(13)),
            asset: token,
            maximum_available: Amount256::from_u128(maximum),
            fee_model: FeeModel::None,
            repayment_asset: token,
            repayment: RepaymentSemantics::AtomicSameTransaction,
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
            caps: CapitalCaps::none(),
            temporary_lock: TemporaryLock::None,
            failure_modes: vec![CapitalFailureMode::CapacityChanged],
            evidence: evidence(),
        })
    };

    let mut first = CapitalCensusLedger::default();
    first.register_source(make_source(100)?)?;
    first.register_requirement(req.clone())?;
    first.evaluate_all()?;

    let mut second = CapitalCensusLedger::default();
    second.register_source(make_source(200)?)?;
    second.register_requirement(req)?;
    second.evaluate_all()?;

    assert_ne!(first.commitment()?, second.commitment()?);
    Ok(())
}

#[test]
fn fee_quotes_are_integer_exact_across_full_uint256_domain() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let bps = FeeModel::basis_points(5)?
        .quote(Amount256::from_u128(10_000), token)?
        .ok_or("missing bps fee quote")?;
    assert_eq!(bps.asset, token);
    assert_eq!(bps.amount, Amount256::from_u128(5));

    let ratio = FeeModel::exact_ratio(3, 1_000)?
        .quote(Amount256::from_u128(10_000), token)?
        .ok_or("missing ratio fee quote")?;
    assert_eq!(ratio.amount, Amount256::from_u128(30));

    let mut maximum = [0xff_u8; 32];
    maximum[0] = 0x80;
    let half = FeeModel::exact_ratio(1, 2)?
        .quote(Amount256::from_be_bytes(maximum), token)?
        .ok_or("missing full-width fee quote")?;
    let mut expected = [0_u8; 32];
    expected[0] = 0x40;
    expected[1..].fill(0xff);
    assert_eq!(half.amount, Amount256::from_be_bytes(expected));
    Ok(())
}

#[test]
fn fee_quote_rejects_uint256_overflow() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let maximum = Amount256::from_be_bytes([0xff; 32]);
    assert!(FeeModel::exact_ratio(2, 1)?.quote(maximum, token).is_err());
    Ok(())
}

#[test]
fn fixed_fee_preserves_explicit_fee_asset() -> TestResult {
    let borrowed = CapitalAsset::Token(address(20));
    let fee_asset = CapitalAsset::Token(address(21));
    let quote = FeeModel::Fixed {
        asset: fee_asset,
        amount: Amount256::from_u128(77),
    }
    .quote(Amount256::from_u128(1_000), borrowed)?
    .ok_or("missing fixed fee quote")?;
    assert_eq!(quote.asset, fee_asset);
    assert_eq!(quote.amount, Amount256::from_u128(77));
    Ok(())
}
