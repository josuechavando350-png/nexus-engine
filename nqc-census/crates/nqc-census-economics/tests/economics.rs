use nqc_census_capital::{
    Amount256, CapitalAsset, CapitalClass, CapitalEvidenceRef, CapitalRequirement,
    CapitalRequirementLeg, CapitalTargetId, RequiredAtomicity, RequirementKind,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use nqc_census_economics::{
    evaluate_scenarios, mul_div_floor, CapacityCurve, CaptureCalibration, CostComponent, CostKind,
    EconomicsError, ExecutionCostVector, ExecutionQuote, GasValuation, PnlScenario, ProbabilityWad,
    ProfitBucket, QuoteDecision, SignedAmount, TailRiskBound, ValuationUnitId, WAD,
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
        let evidence_byte = u8::try_from(index + 60).map_err(|_| EconomicsError::AmountOverflow)?;
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

fn interval(lower: u64, point: u64, upper: u64) -> Result<CaptureCalibration, EconomicsError> {
    CaptureCalibration::shadow_calibrated(
        ProbabilityWad::new(lower)?,
        ProbabilityWad::new(point)?,
        ProbabilityWad::new(upper)?,
        10_000,
        hash(90),
        hash(91),
        hash(92),
    )
}

fn tail(reserve: u128) -> Result<TailRiskBound, EconomicsError> {
    TailRiskBound::new(
        ProbabilityWad::new(WAD * 99 / 100)?,
        Amount256::from_u128(reserve),
        Amount256::from_u128(reserve.max(1_000)),
        Amount256::from_u128(reserve),
        hash(93),
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
        hash(47),
        hash(48),
        hash(49),
        anchor.clone(),
        ValuationUnitId::usd_wad(),
        Amount256::from_u128(trade_size),
        Amount256::from_u128(gross),
        costs,
        capture,
        tail(0)?,
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
    assert_eq!(
        report.success_path_net,
        SignedAmount::positive(Amount256::from_u128(880))
    );
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
        hash(47),
        hash(48),
        hash(49),
        anchor.clone(),
        ValuationUnitId::usd_wad(),
        Amount256::from_u128(1_000),
        Amount256::from_u128(100),
        costs.clone(),
        capture.clone(),
        tail(0)?,
        vec![hash(51), hash(52)],
    )?;
    let right = ExecutionQuote::new(
        candidate.id(),
        hash(47),
        hash(48),
        hash(49),
        anchor,
        ValuationUnitId::usd_wad(),
        Amount256::from_u128(1_000),
        Amount256::from_u128(100),
        costs,
        capture,
        tail(0)?,
        vec![hash(52), hash(51)],
    )?;
    assert_eq!(left.commitment(), right.commitment());
    Ok(())
}

#[test]
fn opportunity_plan_and_model_bind_quote_commitment() -> TestResult {
    let anchor = anchor(100, 10);
    let candidate = candidate_at(&anchor)?;
    let costs = complete_costs(10, 5, 3)?;
    let capture = empirical(WAD / 2)?;
    let baseline = ExecutionQuote::new(
        candidate.id(),
        hash(47),
        hash(48),
        hash(49),
        anchor.clone(),
        ValuationUnitId::usd_wad(),
        Amount256::from_u128(1_000),
        Amount256::from_u128(100),
        costs.clone(),
        capture.clone(),
        tail(0)?,
        vec![hash(51), hash(52)],
    )?;
    let opportunity_changed = ExecutionQuote::new(
        candidate.id(),
        hash(57),
        hash(48),
        hash(49),
        anchor.clone(),
        ValuationUnitId::usd_wad(),
        Amount256::from_u128(1_000),
        Amount256::from_u128(100),
        costs.clone(),
        capture.clone(),
        tail(0)?,
        vec![hash(51), hash(52)],
    )?;
    let plan_changed = ExecutionQuote::new(
        candidate.id(),
        hash(47),
        hash(58),
        hash(49),
        anchor.clone(),
        ValuationUnitId::usd_wad(),
        Amount256::from_u128(1_000),
        Amount256::from_u128(100),
        costs.clone(),
        capture.clone(),
        tail(0)?,
        vec![hash(51), hash(52)],
    )?;
    let model_changed = ExecutionQuote::new(
        candidate.id(),
        hash(47),
        hash(48),
        hash(59),
        anchor,
        ValuationUnitId::usd_wad(),
        Amount256::from_u128(1_000),
        Amount256::from_u128(100),
        costs,
        capture,
        tail(0)?,
        vec![hash(51), hash(52)],
    )?;
    assert_ne!(baseline.commitment(), opportunity_changed.commitment());
    assert_ne!(baseline.commitment(), plan_changed.commitment());
    assert_ne!(baseline.commitment(), model_changed.commitment());
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

#[test]
fn capture_interval_admission_uses_worst_endpoint_not_point_estimate() -> TestResult {
    let anchor = anchor(100, 10);
    let candidate = candidate_at(&anchor)?;
    let quote = ExecutionQuote::new(
        candidate.id(),
        hash(47),
        hash(48),
        hash(49),
        anchor,
        ValuationUnitId::usd_wad(),
        Amount256::from_u128(1_000),
        Amount256::from_u128(1_000),
        complete_costs(100, 20, 30)?,
        interval(WAD * 4 / 10, WAD / 2, WAD * 6 / 10)?,
        tail(20)?,
        vec![hash(51), hash(52)],
    )?;
    let report = quote.evaluate()?;
    assert_eq!(
        report.capture_adjusted_net,
        Some(SignedAmount::positive(Amount256::from_u128(375)))
    );
    assert_eq!(
        report.interval_worst_case_net,
        Some(SignedAmount::positive(Amount256::from_u128(274)))
    );
    assert_eq!(
        report.tail_adjusted_net,
        Some(SignedAmount::positive(Amount256::from_u128(254)))
    );
    assert_eq!(report.decision, QuoteDecision::Admitted);
    Ok(())
}

#[test]
fn tail_reserve_can_reject_positive_capture_adjusted_ev() -> TestResult {
    let anchor = anchor(100, 10);
    let candidate = candidate_at(&anchor)?;
    let quote = ExecutionQuote::new(
        candidate.id(),
        hash(47),
        hash(48),
        hash(49),
        anchor,
        ValuationUnitId::usd_wad(),
        Amount256::from_u128(1_000),
        Amount256::from_u128(100),
        complete_costs(80, 0, 0)?,
        empirical(WAD)?,
        tail(25)?,
        vec![hash(51), hash(52)],
    )?;
    let report = quote.evaluate()?;
    assert_eq!(
        report.interval_worst_case_net,
        Some(SignedAmount::positive(Amount256::from_u128(20)))
    );
    assert!(matches!(
        report.tail_adjusted_net,
        Some(value) if value.is_negative()
    ));
    assert_eq!(report.decision, QuoteDecision::NonPositiveTailAdjustedNet);
    Ok(())
}

#[test]
fn expected_cost_rounding_never_understates_one_atomic_unit() -> TestResult {
    let anchor = anchor(100, 10);
    let candidate = candidate_at(&anchor)?;
    let p = ProbabilityWad::new(WAD / 3)?;
    let quote = quote(
        &candidate,
        &anchor,
        1_000,
        4,
        complete_costs(0, 1, 0)?,
        CaptureCalibration::empirical(p, 1, hash(90), hash(91), hash(92))?,
    )?;
    let report = quote.evaluate()?;
    // floor(4p)=1 while ceil(1p)=1, so conservative EV is exactly zero.
    assert_eq!(report.capture_adjusted_net, Some(SignedAmount::ZERO));
    assert_eq!(
        report.decision,
        QuoteDecision::NonPositiveCaptureAdjustedNet
    );
    Ok(())
}

#[test]
fn signed_scenario_weighting_rounds_losses_up() -> TestResult {
    let tiny_loss_probability = ProbabilityWad::new(1)?;
    let report = evaluate_scenarios(&[
        PnlScenario {
            probability: ProbabilityWad::new(WAD - 1)?,
            pnl: SignedAmount::positive(Amount256::from_u128(1)),
            evidence: hash(110),
        },
        PnlScenario {
            probability: tiny_loss_probability,
            pnl: SignedAmount::negative(Amount256::from_u128(1)),
            evidence: hash(111),
        },
    ])?;
    assert_eq!(
        report.conservative_expected_pnl,
        SignedAmount::negative(Amount256::from_u128(1))
    );
    Ok(())
}

#[test]
fn duplicate_scenario_evidence_is_rejected() -> TestResult {
    assert!(matches!(
        evaluate_scenarios(&[
            PnlScenario {
                probability: ProbabilityWad::new(WAD / 2)?,
                pnl: SignedAmount::positive(Amount256::from_u128(1)),
                evidence: hash(112),
            },
            PnlScenario {
                probability: ProbabilityWad::new(WAD / 2)?,
                pnl: SignedAmount::negative(Amount256::from_u128(1)),
                evidence: hash(112),
            },
        ]),
        Err(EconomicsError::DuplicateEvidence)
    ));
    Ok(())
}

#[test]
fn exact_gas_valuation_uses_full_precision_integer_math() -> TestResult {
    let gas = GasValuation::new(
        21_000,
        Amount256::from_u128(1_000_000_000),
        Amount256::from_u128(2_000 * u128::from(WAD)),
        hash(120),
    )?;
    assert_eq!(gas.gas_wei(), Amount256::from_u128(21_000_000_000_000));
    assert_eq!(
        gas.gas_usd_wad(),
        Amount256::from_u128(42_000_000_000_000_000)
    );
    assert_eq!(gas.price_evidence(), hash(120));
    Ok(())
}

#[test]
fn full_width_mul_div_rejects_result_overflow_instead_of_truncating() -> TestResult {
    assert_eq!(
        mul_div_floor(Amount256::MAX, Amount256::from_u128(1), 1)?,
        Amount256::MAX
    );
    assert!(matches!(
        mul_div_floor(Amount256::MAX, Amount256::from_u128(2), 1),
        Err(EconomicsError::AmountOverflow)
    ));
    Ok(())
}

#[test]
fn profit_bucket_requires_canonical_usd_wad_and_uses_exact_boundaries() -> TestResult {
    let eight_fifty = SignedAmount::positive(Amount256::from_u128(8_500_000_000_000_000_000));
    assert_eq!(
        ProfitBucket::classify(ValuationUnitId::usd_wad(), eight_fifty)?,
        Some(ProfitBucket::FiveToTen)
    );
    assert!(matches!(
        ProfitBucket::classify(ValuationUnitId::from_commitment(hash(121)), eight_fifty),
        Err(EconomicsError::ProfitBucketRequiresUsdWad)
    ));
    Ok(())
}

#[test]
fn invalid_capture_interval_is_rejected() -> TestResult {
    assert!(matches!(
        interval(WAD * 8 / 10, WAD / 2, WAD * 9 / 10),
        Err(EconomicsError::InvalidCaptureInterval)
    ));
    Ok(())
}

#[test]
fn capacity_curve_reports_largest_positive_measured_size() -> TestResult {
    let anchor = anchor(100, 10);
    let candidate = candidate_at(&anchor)?;
    let q1 = quote(
        &candidate,
        &anchor,
        1_000,
        100,
        complete_costs(10, 0, 0)?,
        empirical(WAD)?,
    )?;
    let q2 = quote(
        &candidate,
        &anchor,
        5_000,
        100,
        complete_costs(99, 0, 0)?,
        empirical(WAD)?,
    )?;
    let q3 = quote(
        &candidate,
        &anchor,
        10_000,
        100,
        complete_costs(100, 0, 0)?,
        empirical(WAD)?,
    )?;
    let curve = CapacityCurve::new(vec![q3, q1, q2])?;
    assert_eq!(
        curve.largest_positive_size()?,
        Some(Amount256::from_u128(5_000))
    );
    Ok(())
}
