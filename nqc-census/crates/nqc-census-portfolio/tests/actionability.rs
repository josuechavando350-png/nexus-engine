use nqc_census_capital::{
    adapters::AAVE_V3_PROVIDER_NAMESPACE, Amount256, CapitalAsset, CapitalCaps, CapitalClass,
    CapitalEvidenceRef, CapitalFailureMode, CapitalFeasibility, CapitalOwnership,
    CapitalProviderKind, CapitalSource, CapitalSourceSpec, CollateralRequirement, FeeModel,
    RepaymentSemantics, RequirementKind, TemporaryLock, UtilizationConstraints,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use nqc_census_portfolio::actionability::{
    ActionabilityCoverage, ActionabilityError, ActionabilityPair, ActionabilityRecord,
    evaluate_protocol_native_flash_promotion, promote_protocol_native_flash_liquidation,
    ActionabilityRejectionReason, ActionableLiquidation, LiquidationFundingScope,
};
use nqc_census_capital::FeasibilityRejection;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Hash32 {
    Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
}

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!())
}

fn chain() -> ChainDomain {
    ChainDomain::new(1, hash(1), hash(2)).unwrap_or_else(|_| unreachable!())
}

fn anchor(block: u64, byte: u8) -> StateAnchor {
    StateAnchor::new(
        chain(),
        block,
        hash(byte),
        hash(byte.saturating_add(1)),
        1_800_000_000 + block,
        hash(byte.saturating_add(2)),
    )
    .unwrap_or_else(|_| unreachable!())
}

fn pair(anchor: StateAnchor, borrower: u8, collateral: u8, debt: u8) -> ActionabilityPair {
    ActionabilityPair::new(
        anchor,
        address(borrower),
        address(collateral),
        address(debt),
        u16::from(collateral),
        u16::from(debt),
    )
}

fn candidate(pair: ActionabilityPair) -> Result<ActionableLiquidation, ActionabilityError> {
    ActionableLiquidation::new(
        pair,
        Amount256::from_u128(900_000_000_000_000_000),
        Amount256::from_u128(1_000),
        Amount256::from_u128(550),
        Amount256::from_u128(5),
        Amount256::from_u128(1),
        10_500,
        Amount256::from_u128(2_000),
        Amount256::from_u128(1_000_000_000_000_000_000),
        Amount256::from_u128(1),
        Amount256::from_u128(1_000_000),
        Amount256::from_u128(1_100),
        Amount256::from_u128(1_001),
        hash(90),
        hash(91),
    )
}

#[test]
fn pair_key_is_stable_across_observations_but_observed_id_changes() {
    let left = pair(anchor(100, 10), 20, 30, 40);
    let right = pair(anchor(101, 20), 20, 30, 40);
    assert_eq!(left.key(), right.key());
    assert_ne!(left.id(), right.id());
}

#[test]
fn every_below_one_pair_is_conserved_as_admitted_or_rejected() -> TestResult {
    let anchor = anchor(100, 10);
    let admitted_pair = pair(anchor.clone(), 20, 30, 40);
    let rejected_pair = pair(anchor.clone(), 21, 31, 41);
    let records = vec![
        ActionabilityRecord::admitted(candidate(admitted_pair)?, vec![hash(100)])?,
        ActionabilityRecord::rejected(
            rejected_pair,
            ActionabilityRejectionReason::DebtReserveIneligible,
            vec![hash(101)],
        )?,
    ];
    let coverage = ActionabilityCoverage::new(anchor, 2, 2, records)?;
    assert_eq!(coverage.below_one_borrowers(), 2);
    assert_eq!(coverage.expected_pairs(), 2);
    assert_eq!(coverage.admitted_count(), 1);
    assert_eq!(coverage.rejected_count(), 1);
    assert_eq!(coverage.records().len(), 2);
    Ok(())
}

#[test]
fn disappearing_pair_fails_closed() -> TestResult {
    let anchor = anchor(100, 10);
    let record = ActionabilityRecord::rejected(
        pair(anchor.clone(), 20, 30, 40),
        ActionabilityRejectionReason::PftMathRejected,
        vec![hash(100)],
    )?;
    assert!(matches!(
        ActionabilityCoverage::new(anchor, 1, 2, vec![record]),
        Err(ActionabilityError::ConservationMismatch)
    ));
    Ok(())
}

#[test]
fn disappearing_below_one_borrower_fails_closed() -> TestResult {
    let anchor = anchor(100, 10);
    let records = vec![
        ActionabilityRecord::rejected(
            pair(anchor.clone(), 20, 30, 40),
            ActionabilityRejectionReason::PftMathRejected,
            vec![hash(100)],
        )?,
        ActionabilityRecord::rejected(
            pair(anchor.clone(), 20, 31, 41),
            ActionabilityRejectionReason::CollateralNotEnabled,
            vec![hash(101)],
        )?,
    ];
    assert!(matches!(
        ActionabilityCoverage::new(anchor, 2, 2, records),
        Err(ActionabilityError::BelowOneBorrowerCoverageMismatch)
    ));
    Ok(())
}

#[test]
fn cross_anchor_record_fails_closed() -> TestResult {
    let expected = anchor(100, 10);
    let record = ActionabilityRecord::rejected(
        pair(anchor(101, 20), 20, 30, 40),
        ActionabilityRejectionReason::PftMathRejected,
        vec![hash(100)],
    )?;
    assert!(matches!(
        ActionabilityCoverage::new(expected, 1, 1, vec![record]),
        Err(ActionabilityError::AnchorMismatch)
    ));
    Ok(())
}

#[test]
fn admitted_candidate_cannot_have_zero_principal() {
    let pair = pair(anchor(100, 10), 20, 30, 40);
    let result = ActionableLiquidation::new(
        pair,
        Amount256::from_u128(900_000_000_000_000_000),
        Amount256::ZERO,
        Amount256::from_u128(550),
        Amount256::ZERO,
        Amount256::ZERO,
        10_500,
        Amount256::from_u128(2_000),
        Amount256::from_u128(1_000_000_000_000_000_000),
        Amount256::from_u128(1),
        Amount256::from_u128(1_000_000),
        Amount256::from_u128(1_100),
        Amount256::from_u128(1_000),
        hash(90),
        hash(91),
    );
    assert!(matches!(
        result,
        Err(ActionabilityError::ZeroDebtToLiquidate)
    ));
}


#[test]
fn admitted_candidate_binds_flash_repayment_and_signed_oracle_edge() -> TestResult {
    let value = candidate(pair(anchor(100, 10), 20, 30, 40))?;
    assert_eq!(value.flash_loan_premium(), Amount256::from_u128(1));
    assert_eq!(value.flash_loan_repayment(), Amount256::from_u128(1_001));
    assert_eq!(
        value.oracle_collateral_value_base_wad(),
        Amount256::from_u128(1_100)
    );
    assert_eq!(
        value.oracle_repayment_value_base_wad(),
        Amount256::from_u128(1_001)
    );
    assert!(!value.oracle_edge_negative());
    assert_eq!(value.oracle_edge_base_wad(), Amount256::from_u128(99));
    Ok(())
}

#[test]
fn negative_oracle_edge_is_preserved_instead_of_erasing_actionability() -> TestResult {
    let value = ActionableLiquidation::new(
        pair(anchor(100, 10), 20, 30, 40),
        Amount256::from_u128(900_000_000_000_000_000),
        Amount256::from_u128(1_000),
        Amount256::from_u128(550),
        Amount256::from_u128(5),
        Amount256::from_u128(10),
        10_500,
        Amount256::from_u128(2_000),
        Amount256::from_u128(1_000_000_000_000_000_000),
        Amount256::from_u128(1),
        Amount256::from_u128(1_000_000),
        Amount256::from_u128(900),
        Amount256::from_u128(1_010),
        hash(90),
        hash(91),
    )?;
    assert!(value.oracle_edge_negative());
    assert_eq!(value.oracle_edge_base_wad(), Amount256::from_u128(110));
    Ok(())
}

fn flash_source(
    anchor: StateAnchor,
    pool: Address,
    debt: Address,
    ownership: CapitalOwnership,
    fee: Amount256,
) -> Result<CapitalSource, Box<dyn std::error::Error>> {
    Ok(CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::ProtocolNativeFlashLoan,
        anchor,
        provider_namespace: AAVE_V3_PROVIDER_NAMESPACE,
        provider_locator_hash: hash(120),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership,
        source_contract: Some(pool),
        asset: CapitalAsset::Token(debt),
        maximum_available: Amount256::from_u128(10_000),
        fee_model: FeeModel::Fixed {
            asset: CapitalAsset::Token(debt),
            amount: fee,
        },
        repayment_asset: CapitalAsset::Token(debt),
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: vec![CapitalEvidenceRef::Observation([121; 32])],
    })?)
}

#[test]
fn actionable_liquidation_promotes_to_exact_principal_settlement_requirement() -> TestResult {
    let liquidation = candidate(pair(anchor(100, 10), 20, 30, 40))?;
    let promotion = promote_protocol_native_flash_liquidation(&liquidation)?;
    let requirement = promotion.requirement();

    assert_eq!(promotion.actionable_candidate_id(), liquidation.id());
    assert_eq!(promotion.debt_asset(), address(40));
    assert_eq!(
        promotion.scope(),
        LiquidationFundingScope::PrincipalAndFlashSettlementOnlyGasUncertified
    );
    assert!(!promotion.scope().gas_funding_certified());
    assert!(!requirement.requires_native_gas());
    assert_eq!(promotion.portfolio_candidate().requirement_id(), requirement.id());
    assert_eq!(promotion.portfolio_candidate().anchor(), liquidation.pair().anchor());

    let principal = requirement
        .legs()
        .iter()
        .find(|leg| leg.kind() == RequirementKind::ActionPrincipal)
        .ok_or("missing action principal")?;
    let repayment = requirement
        .legs()
        .iter()
        .find(|leg| leg.kind() == RequirementKind::Repayment)
        .ok_or("missing repayment")?;
    let fee = requirement
        .legs()
        .iter()
        .find(|leg| leg.kind() == RequirementKind::FundingFee)
        .ok_or("missing funding fee")?;

    assert_eq!(principal.amount(), Amount256::from_u128(1_000));
    assert_eq!(repayment.amount(), Amount256::from_u128(1_000));
    assert_eq!(fee.amount(), Amount256::from_u128(1));
    assert!(!requirement
        .legs()
        .iter()
        .any(|leg| leg.kind() == RequirementKind::Gas));
    Ok(())
}

#[test]
fn zero_flash_premium_does_not_fabricate_zero_fee_leg() -> TestResult {
    let liquidation = ActionableLiquidation::new(
        pair(anchor(100, 10), 20, 30, 40),
        Amount256::from_u128(900_000_000_000_000_000),
        Amount256::from_u128(1_000),
        Amount256::from_u128(550),
        Amount256::from_u128(5),
        Amount256::ZERO,
        10_500,
        Amount256::from_u128(2_000),
        Amount256::from_u128(1_000_000_000_000_000_000),
        Amount256::from_u128(1),
        Amount256::from_u128(1_000_000),
        Amount256::from_u128(1_100),
        Amount256::from_u128(1_000),
        hash(90),
        hash(91),
    )?;
    let promotion = promote_protocol_native_flash_liquidation(&liquidation)?;
    assert!(!promotion
        .requirement()
        .legs()
        .iter()
        .any(|leg| leg.kind() == RequirementKind::FundingFee));
    Ok(())
}

#[test]
fn exact_aave_provider_and_fee_are_required_for_capital_feasibility() -> TestResult {
    let liquidation = candidate(pair(anchor(100, 10), 20, 30, 40))?;
    let promotion = promote_protocol_native_flash_liquidation(&liquidation)?;
    let pool = address(70);

    let exact = flash_source(
        liquidation.pair().anchor().clone(),
        pool,
        liquidation.pair().debt_asset(),
        CapitalOwnership::External,
        Amount256::from_u128(1),
    )?;
    assert!(matches!(
        evaluate_protocol_native_flash_promotion(&promotion, pool, &[exact])?,
        CapitalFeasibility::Feasible { .. }
    ));

    let wrong_pool_source = flash_source(
        liquidation.pair().anchor().clone(),
        address(71),
        liquidation.pair().debt_asset(),
        CapitalOwnership::External,
        Amount256::from_u128(1),
    )?;
    assert!(matches!(
        evaluate_protocol_native_flash_promotion(&promotion, pool, &[wrong_pool_source])?,
        CapitalFeasibility::Rejected {
            reason: FeasibilityRejection::NoCompatibleSource,
            ..
        }
    ));

    let wrong_fee = flash_source(
        liquidation.pair().anchor().clone(),
        pool,
        liquidation.pair().debt_asset(),
        CapitalOwnership::External,
        Amount256::from_u128(2),
    )?;
    assert!(matches!(
        evaluate_protocol_native_flash_promotion(&promotion, pool, &[wrong_fee])?,
        CapitalFeasibility::Rejected {
            reason: FeasibilityRejection::SettlementRequirementMismatch,
            ..
        }
    ));
    Ok(())
}

#[test]
fn operator_owned_aave_liquidity_cannot_satisfy_zero_own_capital_policy() -> TestResult {
    let liquidation = candidate(pair(anchor(100, 10), 20, 30, 40))?;
    let promotion = promote_protocol_native_flash_liquidation(&liquidation)?;
    let pool = address(70);
    let own = flash_source(
        liquidation.pair().anchor().clone(),
        pool,
        liquidation.pair().debt_asset(),
        CapitalOwnership::OperatorOwned,
        Amount256::from_u128(1),
    )?;
    assert!(matches!(
        evaluate_protocol_native_flash_promotion(&promotion, pool, &[own])?,
        CapitalFeasibility::Rejected {
            reason: FeasibilityRejection::OperatorOwnedCapitalRequired,
            ..
        }
    ));
    Ok(())
}

