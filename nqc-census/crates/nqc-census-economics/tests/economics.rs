use nqc_census_capital::{
    Amount256, CapitalAsset, CapitalClass, CapitalEvidenceRef, CapitalRequirement,
    CapitalRequirementLeg, CapitalTargetId, RequiredAtomicity, RequirementKind,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use nqc_census_economics::{
    evaluate_scenarios, mul_div_floor, CalibrationState, CapacityCurve, CapacityCurvePoint,
    CaptureEstimate, CostComponent, CostKind, EconomicDecision, EconomicQuote, EconomicsError,
    ExecutionCostVector, GasValuation, PnlScenario, ProbabilityPpb, ProfitBucket, SignedValue,
    TailRiskBound, ValueUnit,
};
use nqc_census_portfolio::PortfolioCandidate;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Hash32 {
    Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
}

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!())
}

fn chain(chain_id: u64, byte: u8) -> ChainDomain {
    ChainDomain::new(chain_id, hash(byte), hash(byte.saturating_add(1)))
        .unwrap_or_else(|_| unreachable!())
}

fn anchor() -> StateAnchor {
    StateAnchor::new(
        chain(1, 1),
        25_000_000,
        hash(10),
        hash(11),
        1_800_000_000,
        hash(12),
    )
    .unwrap_or_else(|_| unreachable!())
}

fn capital_evidence() -> Vec<CapitalEvidenceRef> {
    vec![CapitalEvidenceRef::Artifact(hash(200))]
}

fn candidate(
    anchor: StateAnchor,
    target: u8,
    variant: u8,
) -> Result<PortfolioCandidate, Box<dyn std::error::Error>> {
    let leg = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        CapitalAsset::Token(address(20)),
        Amount256::from_u128(1),
        vec![CapitalClass::ProtocolNativeFlashLoan],
    )?;
    let requirement = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(target)),
        anchor.clone(),
        RequiredAtomicity::SameTransaction,
        false,
        vec![leg],
        capital_evidence(),
    )?;
    Ok(PortfolioCandidate::new_variant(
        requirement.id(),
        hash(variant),
        anchor,
        vec![],
    )?)
}

fn wad(dollars: u128) -> Amount256 {
    Amount256::from_u128(dollars * 1_000_000_000_000_000_000)
}

fn complete_costs(
    gas_unconditional: u128,
    protocol_on_capture: u128,
    failure_on_failure: u128,
) -> Result<ExecutionCostVector, EconomicsError> {
    let mut components = Vec::new();
    for (index, kind) in CostKind::ALL.into_iter().enumerate() {
        let evidence_byte =
            u8::try_from(index + 60).map_err(|_| EconomicsError::ArithmeticOverflow)?;
        let unconditional = if kind == CostKind::Gas {
            wad(gas_unconditional)
        } else {
            Amount256::ZERO
        };
        let on_capture = if kind == CostKind::ProtocolFee {
            wad(protocol_on_capture)
        } else {
            Amount256::ZERO
        };
        let on_failure = if kind == CostKind::ExpectedFailureRevert {
            wad(failure_on_failure)
        } else {
            Amount256::ZERO
        };
        components.push(CostComponent::new(
            kind,
            unconditional,
            on_capture,
            on_failure,
            hash(evidence_byte),
        )?);
    }
    ExecutionCostVector::new(components)
}

fn capture(calibrated: bool) -> Result<CaptureEstimate, EconomicsError> {
    let calibration = if calibrated {
        CalibrationState::ShadowCalibrated {
            sample_count: 10_000,
            window_commitment: hash(208),
            model_commitment: hash(209),
            calibration_commitment: hash(210),
        }
    } else {
        CalibrationState::PriorOnly {
            prior_commitment: hash(211),
        }
    };
    CaptureEstimate::new(
        ProbabilityPpb::new(700_000_000)?,
        ProbabilityPpb::new(750_000_000)?,
        ProbabilityPpb::new(800_000_000)?,
        calibration,
    )
}

fn quote(
    anchor: StateAnchor,
    target: u8,
    variant: u8,
    trade_size: u128,
    gross: u128,
    costs: ExecutionCostVector,
    calibrated: bool,
) -> Result<EconomicQuote, Box<dyn std::error::Error>> {
    let candidate = candidate(anchor.clone(), target, variant)?;
    Ok(EconomicQuote::new(
        candidate.id(),
        hash(90),
        anchor,
        ValueUnit::UsdWad,
        Amount256::from_u128(trade_size),
        wad(gross),
        costs,
        capture(calibrated)?,
        TailRiskBound::new(
            ProbabilityPpb::new(990_000_000)?,
            wad(8),
            wad(20),
            wad(5),
        )?,
        hash(91),
        hash(92),
        vec![hash(220), hash(221)],
    )?)
}

#[test]
fn mul_div_uses_full_512_bit_intermediate_without_truncation() -> TestResult {
    assert_eq!(
        mul_div_floor(Amount256::MAX, Amount256::from_u128(2), 2)?,
        Amount256::MAX
    );
    assert!(matches!(
        mul_div_floor(Amount256::MAX, Amount256::from_u128(2), 1),
        Err(EconomicsError::ArithmeticOverflow)
    ));
    Ok(())
}

#[test]
fn gas_is_valued_exactly_in_usd_wad() -> TestResult {
    let quote = GasValuation::new(
        21_000,
        Amount256::from_u128(1_000_000_000),
        wad(2_000),
    )?;
    assert_eq!(quote.gas_wei(), Amount256::from_u128(21_000_000_000_000));
    assert_eq!(
        quote.gas_usd_wad(),
        Amount256::from_u128(42_000_000_000_000_000)
    );
    Ok(())
}

#[test]
fn complete_cost_taxonomy_is_mandatory_and_evidence_bound() -> TestResult {
    let mut components = complete_costs(20, 20, 20)?.components().to_vec();
    components.retain(|component| component.kind != CostKind::Mev);
    assert!(matches!(
        ExecutionCostVector::new(components),
        Err(EconomicsError::MissingCostKind(CostKind::Mev))
    ));
    assert!(matches!(
        CostComponent::new(
            CostKind::Mev,
            Amount256::ZERO,
            Amount256::ZERO,
            Amount256::ZERO,
            Hash32::new([0; 32]).unwrap_or_else(|_| unreachable!())
        ),
        Err(EconomicsError::EmptyEvidence)
    ));
    Ok(())
}

#[test]
fn expected_ev_weights_cost_incidence_instead_of_scaling_all_costs_by_capture() -> TestResult {
    let quote = quote(
        anchor(),
        40,
        41,
        1_000,
        100,
        complete_costs(20, 20, 20)?,
        true,
    )?;
    assert_eq!(quote.require_positive_success_net()?, wad(60));

    // p=0.75: 75 expected gross - 20 unconditional gas
    // - 15 capture-only protocol fee - 5 failure-only reserve = 35.
    assert_eq!(quote.expected_realized_ev()?, SignedValue::positive(wad(35)));
    // Interval endpoint values are 30 at p=.70 and 40 at p=.80.
    assert_eq!(
        quote.lower_bound_realized_ev()?,
        SignedValue::positive(wad(30))
    );
    assert_eq!(quote.tail_adjusted_ev()?, SignedValue::positive(wad(25)));
    assert_eq!(quote.profit_bucket()?, Some(ProfitBucket::Usd20To50));
    assert_eq!(
        quote.certified_expected_realized_ev()?,
        SignedValue::positive(wad(30))
    );
    assert_eq!(quote.decision()?, EconomicDecision::Admitted);
    Ok(())
}

#[test]
fn capture_interval_bound_checks_both_endpoints_not_just_lower_probability() -> TestResult {
    let mut components = complete_costs(0, 0, 0)?.components().to_vec();
    for component in &mut components {
        if component.kind == CostKind::BuilderPayment {
            component.on_capture = wad(200);
        }
        if component.kind == CostKind::ExpectedFailureRevert {
            component.on_failure = wad(10);
        }
    }
    let quote = quote(
        anchor(),
        40,
        41,
        1_000,
        100,
        ExecutionCostVector::new(components)?,
        true,
    )?;
    // EV is decreasing with capture probability in this deliberately bad plan.
    assert!(
        quote.expected_realized_ev()? > quote.lower_bound_realized_ev()?,
        "the conservative interval bound must select the worse endpoint"
    );
    Ok(())
}

#[test]
fn prior_capture_can_drive_shadow_prediction_but_never_certified_profitability() -> TestResult {
    let quote = quote(
        anchor(),
        40,
        41,
        1_000,
        100,
        complete_costs(20, 20, 20)?,
        false,
    )?;
    assert!(quote.expected_realized_ev()?.is_positive());
    assert_eq!(quote.decision()?, EconomicDecision::CaptureUncalibrated);
    assert!(matches!(
        quote.certified_expected_realized_ev(),
        Err(EconomicsError::UncalibratedCapture)
    ));
    Ok(())
}

#[test]
fn evidence_order_does_not_change_quote_commitment() -> TestResult {
    let anchor = anchor();
    let candidate = candidate(anchor.clone(), 40, 41)?;
    let make = |evidence: Vec<Hash32>| {
        EconomicQuote::new(
            candidate.id(),
            hash(90),
            anchor.clone(),
            ValueUnit::UsdWad,
            Amount256::from_u128(1_000),
            wad(100),
            complete_costs(20, 20, 20)?,
            capture(true)?,
            TailRiskBound::new(
                ProbabilityPpb::new(990_000_000)?,
                wad(8),
                wad(20),
                wad(5),
            )?,
            hash(91),
            hash(92),
            evidence,
        )
    };
    let left = make(vec![hash(220), hash(221)])?;
    let right = make(vec![hash(221), hash(220)])?;
    assert_eq!(left.commitment(), right.commitment());
    Ok(())
}

#[test]
fn capacity_curve_selects_best_conservative_size_not_largest_trade() -> TestResult {
    let anchor = anchor();
    let small = CapacityCurvePoint::new(
        Amount256::from_u128(10),
        quote(
            anchor.clone(),
            40,
            41,
            10,
            100,
            complete_costs(20, 20, 20)?,
            true,
        )?,
    )?;
    let best = CapacityCurvePoint::new(
        Amount256::from_u128(20),
        quote(
            anchor.clone(),
            40,
            41,
            20,
            140,
            complete_costs(20, 20, 20)?,
            true,
        )?,
    )?;
    let too_large = CapacityCurvePoint::new(
        Amount256::from_u128(30),
        quote(
            anchor,
            40,
            41,
            30,
            80,
            complete_costs(70, 40, 20)?,
            true,
        )?,
    )?;

    let curve = CapacityCurve::new(vec![too_large, small, best])?;
    assert_eq!(
        curve
            .best_tail_adjusted_positive()?
            .ok_or("no positive curve point")?
            .trade_size(),
        Amount256::from_u128(20)
    );
    assert_eq!(
        curve.largest_positive_size()?,
        Some(Amount256::from_u128(20))
    );
    Ok(())
}

#[test]
fn quote_commitment_binds_trade_size_and_curve_rejects_mismatch() -> TestResult {
    let quote = quote(
        anchor(),
        40,
        41,
        10,
        100,
        complete_costs(20, 20, 20)?,
        true,
    )?;
    assert!(matches!(
        CapacityCurvePoint::new(Amount256::from_u128(11), quote),
        Err(EconomicsError::TradeSizeMismatch)
    ));
    Ok(())
}

#[test]
fn capacity_curve_rejects_mixed_execution_variants() -> TestResult {
    let anchor = anchor();
    let a = CapacityCurvePoint::new(
        Amount256::from_u128(10),
        quote(
            anchor.clone(),
            40,
            41,
            10,
            100,
            complete_costs(20, 20, 20)?,
            true,
        )?,
    )?;
    let b = CapacityCurvePoint::new(
        Amount256::from_u128(20),
        quote(
            anchor,
            40,
            42,
            20,
            120,
            complete_costs(20, 20, 20)?,
            true,
        )?,
    )?;
    assert!(matches!(
        CapacityCurve::new(vec![a, b]),
        Err(EconomicsError::CandidateMismatch)
    ));
    Ok(())
}

#[test]
fn probability_interval_tail_and_calibration_fail_closed() -> TestResult {
    assert!(matches!(
        CaptureEstimate::new(
            ProbabilityPpb::new(800_000_000)?,
            ProbabilityPpb::new(700_000_000)?,
            ProbabilityPpb::new(900_000_000)?,
            CalibrationState::PriorOnly {
                prior_commitment: hash(1)
            }
        ),
        Err(EconomicsError::InvalidProbabilityInterval)
    ));
    assert!(matches!(
        CaptureEstimate::new(
            ProbabilityPpb::new(700_000_000)?,
            ProbabilityPpb::new(750_000_000)?,
            ProbabilityPpb::new(800_000_000)?,
            CalibrationState::ShadowCalibrated {
                sample_count: 0,
                window_commitment: hash(2),
                model_commitment: hash(3),
                calibration_commitment: hash(4),
            }
        ),
        Err(EconomicsError::InvalidCalibration)
    ));
    assert!(matches!(
        TailRiskBound::new(
            ProbabilityPpb::new(990_000_000)?,
            wad(30),
            wad(20),
            wad(5)
        ),
        Err(EconomicsError::InvalidTailBound)
    ));
    Ok(())
}

#[test]
fn exact_scenario_distribution_reports_expected_worst_and_loss_probability() -> TestResult {
    let scenarios = [
        PnlScenario::new(
            hash(1),
            ProbabilityPpb::new(750_000_000)?,
            SignedValue::positive(wad(100)),
            hash(11),
        )?,
        PnlScenario::new(
            hash(2),
            ProbabilityPpb::new(250_000_000)?,
            SignedValue::negative(wad(20)),
            hash(12),
        )?,
    ];
    let report = evaluate_scenarios(&scenarios)?;
    assert_eq!(report.expected_pnl(), SignedValue::positive(wad(70)));
    assert_eq!(report.worst_case(), SignedValue::negative(wad(20)));
    assert_eq!(report.loss_probability(), ProbabilityPpb::new(250_000_000)?);

    let incomplete = [PnlScenario::new(
        hash(3),
        ProbabilityPpb::new(900_000_000)?,
        SignedValue::positive(wad(1)),
        hash(13),
    )?];
    assert!(matches!(
        evaluate_scenarios(&incomplete),
        Err(EconomicsError::ScenarioProbabilityNotOne)
    ));
    Ok(())
}
