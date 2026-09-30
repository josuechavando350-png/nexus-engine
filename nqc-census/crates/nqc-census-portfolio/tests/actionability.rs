use nqc_census_capital::Amount256;
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use nqc_census_portfolio::actionability::{
    ActionabilityCoverage, ActionabilityError, ActionabilityPair, ActionabilityRecord,
    ActionabilityRejectionReason, ActionableLiquidation,
};

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
        Amount256::from_u128(1_001),
        10_500,
        Amount256::from_u128(1_100),
        Amount256::from_u128(1_001),
        Amount256::from_u128(99),
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
            ActionabilityRejectionReason::DebtFlashLiquidityUnavailable,
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
        ActionabilityRejectionReason::PftPolicyRejected,
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
            ActionabilityRejectionReason::PftPolicyRejected,
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
        ActionabilityRejectionReason::PftPolicyRejected,
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
        Amount256::from_u128(1_001),
        10_500,
        Amount256::from_u128(1_100),
        Amount256::from_u128(1_001),
        Amount256::from_u128(99),
        hash(90),
        hash(91),
    );
    assert!(matches!(result, Err(ActionabilityError::ZeroDebtToLiquidate)));
}
