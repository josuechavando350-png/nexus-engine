use nqc_census_capital::{
    Amount256, CapitalAsset, CapitalClass, CapitalEvidenceRef, CapitalRequirement,
    CapitalRequirementLeg, CapitalTargetId, RequiredAtomicity, RequirementKind,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use nqc_census_economics::{
    evaluate_scenarios, CapacityCurve, CaptureCalibration, CostComponent, CostKind,
    EconomicsError, ExecutionCostVector, ExecutionQuote, PnlScenario, ProbabilityWad,
    QuoteDecision, SignedAmount, ValuationUnitId, WAD,
};
use nqc_census_portfolio::PortfolioCandidate;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Hash32 {
    Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
}

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!())
}

fn anchor(block: u64, byte: u8) -> StateAnchor {
    let chain = ChainDomain::new(1, hash(1), hash(2)).unwrap_or_else(|_| unreachable!());
    StateAnchor::new(
        chain,
        block,
        hash(byte),
        hash(byte.saturating_add(1)),
        1_800_000_000 + block,
        hash(byte.saturating_add(2)),
    )
    .unwrap_or_else(|_| unreachable!())
}

fn candidate_at(anchor: &StateAnchor) -> Result<PortfolioCandidate, Box<dyn std::error::Error>> {
    let leg = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        CapitalAsset::Token(address(20)),
        Amount256::from_u128(1_000),
        vec![CapitalClass::ProtocolNativeFlashLoan],
    )?;
    let requirement = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(40)),
        anchor.clone(),
        RequiredAtomicity::SameTransaction,
        false,
        vec![leg],
        vec![CapitalEvidenceRef::Artifact(hash(41))],
    )?;
    Ok(PortfolioCandidate::new(
        requirement.id(),
        anchor.clone(),
        vec![],
    )?)
}

fn complete_costs(
    gas_unconditional: u128,
    protocol_on_capture: u128,
    failure_on_failure: u128,
) -> Result<ExecutionCostVector, EconomicsError> {
    let mut components = Vec::new();
    for (index, kind) in CostKind::ALL.into_iter().enumerate() {
        let evidence_byte =
            u8::try_from(index + 60).map_err(|_| EconomicsError::AmountOverflow)?;
        let unconditional = if kind == CostKind::Gas {
            Amount256::from_u128(gas_unconditional)
        } else {
            Amount256::ZERO
        };
        let on_capture = if kind == CostKind::ProtocolFee {
            Amount256::from_u128(protocol_on_capture)
        } else {
            Amount256::ZERO
        };
        let on_failure = if kind == CostKind::ExpectedFailureRevert {
            Amount256::from_u128(failure_on_failure)
        } else {
            Amount256::ZERO
        };
        components.push(CostComponent::new(
            kind,
            unconditional,
            on_capture,
            on_failure,
            hash(evidence_byte),
        ));
    }
    ExecutionCostVector::new(components)
}

fn empirical(probability: u64) -> Result<CaptureCalibration, EconomicsError> {
    CaptureCalibration::empirical(
        ProbabilityWad::new(probability)?,
        10_000,
        hash(90),
        hash(91),
        hash(92),
    )
}

fn quote(
    candidate: &PortfolioCandidate,
    anchor: &StateAnchor,
    trade_size: u128,
    gross: u128,
    costs: ExecutionCostVector,
    capture: CaptureCalibration,
) -> Result<ExecutionQuote, EconomicsError> {
    ExecutionQuote::new(
        candidate.id(),
        anchor.clone(),
        ValuationUnitId::from_commitment(hash(50)),
        Amount256::from_u128(trade_size),
        Amount256::from_u128(gross),
        costs,
        capture,
        vec![hash(51), hash(52)],
    )
}

#[test]
fn probability_weighting_supports_full_uint256_without_float() -> TestResult {
    let half = ProbabilityWad::new(WAD / 2)?;
    let weighted = half.apply_floor(Amount256::MAX)?;
    let mut expected = [0xff_u8; 32];
    expected[0] = 0x7f;
    assert_eq!(weighted, Amount256::from_be_bytes(expected));
    Ok(())
}

#[test]
fn complete_cost_taxonomy_is_mandatory() -> TestResult {
    let mut components = complete_costs(1, 1, 1)?.components().to_vec();
    components.retain(|component| component.kind != CostKind::Mev);
    assert!(matches!(
        ExecutionCostVector::new(components),
        Err(EconomicsError::MissingCostKind(CostKind::Mev))
    ));
    Ok(())
}

#[test]
fn positive_quote_is_not_admitted_before_capture_calibration() -> TestResult {
    let anchor = anchor(100, 10);
    let candidate = candidate_at(&anchor)?;
    let quote = quote(
        &candidate,
        &anchor,
        1_000,
        1_000,
        complete_costs(100, 20, 30)?,
        CaptureCalibration::Uncalibrated {
            model_commitment: hash(91),
        },
    )?;
    let report = quote.evaluate()?;
    assert_eq!(report.success_path_net, SignedAmount::positive(Amount256::from_u128(880)));
    assert_eq!(report.capture_adjusted_net, None);
    assert_eq!(report.decision, QuoteDecision::CaptureUncalibrated);
    Ok(())
}

#[test]
fn expected_value_weights_success_and_failure_costs_separately() -> TestResult {
    let anchor = anchor(100, 10);
    let candidate = candidate_at(&anchor)?;
    let quote = quote(
        &candidate,
        &anchor,
        1_000,
        1_000,
        complete_costs(100, 20, 30)?,
        empirical(WAD / 2)?,
    )?;
    let report = quote.evaluate()?;

    // expected gross = 500
    // expected costs = 100 unconditional gas + 10 capture protocol fee
    //                + 15 failure-only reserve = 125
    assert_eq!(
        report.capture_adjusted_net,
        Some(SignedAmount::positive(Amount256::from_u128(375)))
    );
    assert_eq!(report.decision, QuoteDecision::Admitted);
    Ok(())
}

#[test]
fn low_capture_can_kill_a_profitable_success_path() -> TestResult {
    let anchor = anchor(100, 10);
    let candidate = candidate_at(&anchor)?;
    let quote = quote(
        &candidate,
        &anchor,
        1_000,
        1_000,
        complete_costs(100, 20, 30)?,
        empirical(WAD / 10)?,
    )?;
    let report = quote.evaluate()?;
    assert!(report.success_path_net.is_positive());
    assert!(matches!(
        report.capture_adjusted_net,
        Some(value) if value.is_negative()
    ));
    assert_eq!(
        report.decision,
        QuoteDecision::NonPositiveCaptureAdjustedNet
    );
    Ok(())
}

#[test]
fn capacity_curve_selects_observed_best_point_without_linear_extrapolation() -> TestResult {
    let anchor = anchor(100, 10);
    let candidate = candidate_at(&anchor)?;
    let p = empirical(WAD)?;

    let q1 = quote(
        &candidate,
        &anchor,
        1_000,
        50,
        complete_costs(10, 0, 0)?,
        p.clone(),
    )?;
    let q2 = quote(
        &candidate,
        &anchor,
        5_000,
        140,
        complete_costs(20, 0, 0)?,
        p.clone(),
    )?;
    let q3 = quote(
        &candidate,
        &anchor,
        10_000,
        170,
        complete_costs(80, 0, 0)?,
        p,
    )?;
    let curve = CapacityCurve::new(vec![q3, q1, q2])?;
    let best = curve.best_admitted_point()?.ok_or("no admitted point")?;
    assert_eq!(best.trade_size(), Amount256::from_u128(5_000));
    assert_eq!(curve.points().len(), 3);
    Ok(())
}

#[test]
fn capacity_curve_rejects_duplicate_trade_size() -> TestResult {
    let anchor = anchor(100, 10);
    let candidate = candidate_at(&anchor)?;
    let q1 = quote(
        &candidate,
        &anchor,
        1_000,
        50,
        complete_costs(10, 0, 0)?,
        empirical(WAD)?,
    )?;
    let q2 = quote(
        &candidate,
        &anchor,
        1_000,
        60,
        complete_costs(10, 0, 0)?,
        empirical(WAD)?,
    )?;
    assert!(matches!(
        CapacityCurve::new(vec![q1, q2]),
        Err(EconomicsError::CurveTradeSizeNotStrictlyIncreasing)
    ));
    Ok(())
}

#[test]
fn scenario_distribution_is_exact_and_reports_loss_probability() -> TestResult {
    let report = evaluate_scenarios(&[
        PnlScenario {
            probability: ProbabilityWad::new(WAD * 3 / 4)?,
            pnl: SignedAmount::positive(Amount256::from_u128(100)),
            evidence: hash(100),
        },
        PnlScenario {
            probability: ProbabilityWad::new(WAD / 4)?,
            pnl: SignedAmount::negative(Amount256::from_u128(100)),
            evidence: hash(101),
        },
    ])?;
    assert_eq!(
        report.conservative_expected_pnl,
        SignedAmount::positive(Amount256::from_u128(50))
    );
    assert_eq!(
        report.worst_case_pnl,
        SignedAmount::negative(Amount256::from_u128(100))
    );
    assert_eq!(report.loss_probability, ProbabilityWad::new(WAD / 4)?);
    Ok(())
}

#[test]
fn scenario_probabilities_must_sum_to_exactly_one() -> TestResult {
    assert!(matches!(
        evaluate_scenarios(&[PnlScenario {
            probability: ProbabilityWad::new(WAD - 1)?,
            pnl: SignedAmount::positive(Amount256::from_u128(1)),
            evidence: hash(100),
        }]),
        Err(EconomicsError::ScenarioProbabilityNotOne)
    ));
    Ok(())
}

#[test]
fn quote_commitment_is_independent_of_evidence_input_order() -> TestResult {
    let anchor = anchor(100, 10);
    let candidate = candidate_at(&anchor)?;
    let costs = complete_costs(10, 5, 3)?;
    let capture = empirical(WAD / 2)?;
    let left = ExecutionQuote::new(
        candidate.id(),
        anchor.clone(),
        ValuationUnitId::from_commitment(hash(50)),
        Amount256::from_u128(1_000),
        Amount256::from_u128(100),
        costs.clone(),
        capture.clone(),
        vec![hash(51), hash(52)],
    )?;
    let right = ExecutionQuote::new(
        candidate.id(),
        anchor,
        ValuationUnitId::from_commitment(hash(50)),
        Amount256::from_u128(1_000),
        Amount256::from_u128(100),
        costs,
        capture,
        vec![hash(52), hash(51)],
    )?;
    assert_eq!(left.commitment(), right.commitment());
    Ok(())
}

#[test]
fn anchor_change_changes_quote_commitment() -> TestResult {
    let a0 = anchor(100, 10);
    let a1 = anchor(101, 20);
    let candidate_a0 = candidate_at(&a0)?;
    let candidate_a1 = candidate_at(&a1)?;
    let left = quote(
        &candidate_a0,
        &a0,
        1_000,
        100,
        complete_costs(10, 5, 3)?,
        empirical(WAD / 2)?,
    )?;
    let right = quote(
        &candidate_a1,
        &a1,
        1_000,
        100,
        complete_costs(10, 5, 3)?,
        empirical(WAD / 2)?,
    )?;
    assert_ne!(left.commitment(), right.commitment());
    Ok(())
}
