use nqc_census_capital::{
    Amount256, CapitalAsset, CapitalClass, CapitalEvidenceRef, CapitalRequirement,
    CapitalRequirementLeg, CapitalTargetId, RequiredAtomicity, RequirementKind,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use nqc_census_economics::{
    mul_div_floor, CalibrationState, CapacityCurve, CapacityCurvePoint, CaptureEstimate,
    EconomicQuote, EconomicsError, ExecutionCostVector, GasValuation, ProbabilityPpb,
    ProfitBucket, TailRiskBound, ValueUnit,
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
        vec![CapitalClass::FlashLoan],
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

fn capture(calibrated: bool) -> Result<CaptureEstimate, EconomicsError> {
    let calibration = if calibrated {
        CalibrationState::ShadowCalibrated {
            sample_count: 10_000,
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
    gross: u128,
    cost: u128,
    calibrated: bool,
) -> Result<EconomicQuote, Box<dyn std::error::Error>> {
    let candidate = candidate(anchor.clone(), target, variant)?;
    Ok(EconomicQuote::new(
        candidate.id(),
        hash(90),
        anchor,
        ValueUnit::UsdWad,
        wad(gross),
        ExecutionCostVector {
            gas: wad(cost),
            ..ExecutionCostVector::default()
        },
        capture(calibrated)?,
        wad(4),
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
fn expected_ev_separates_success_value_from_loss_path() -> TestResult {
    let quote = quote(anchor(), 40, 41, 100, 20, true)?;
    assert_eq!(quote.require_positive_success_net()?, wad(80));

    let expected = quote.expected_realized_ev()?;
    assert!(expected.is_positive());
    assert_eq!(expected.magnitude(), wad(59));

    let tail = quote.tail_adjusted_ev()?;
    assert!(tail.is_positive());
    assert_eq!(tail.magnitude(), wad(54));
    assert_eq!(quote.profit_bucket()?, Some(ProfitBucket::Usd50To100));
    assert_eq!(quote.certified_expected_realized_ev()?, expected);
    Ok(())
}

#[test]
fn prior_capture_can_drive_shadow_prediction_but_not_certified_capture_ev() -> TestResult {
    let quote = quote(anchor(), 40, 41, 100, 20, false)?;
    assert!(quote.expected_realized_ev()?.is_positive());
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
            wad(100),
            ExecutionCostVector {
                gas: wad(20),
                ..ExecutionCostVector::default()
            },
            capture(true)?,
            wad(4),
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
fn capacity_curve_selects_best_tail_adjusted_size_not_largest_trade() -> TestResult {
    let anchor = anchor();
    let small = CapacityCurvePoint::new(
        Amount256::from_u128(10),
        quote(anchor.clone(), 40, 41, 100, 20, true)?,
    )?;
    let best = CapacityCurvePoint::new(
        Amount256::from_u128(20),
        quote(anchor.clone(), 40, 42, 120, 30, true)?,
    )?;
    let too_large = CapacityCurvePoint::new(
        Amount256::from_u128(30),
        quote(anchor, 40, 43, 80, 90, true)?,
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
fn probability_interval_and_tail_bound_fail_closed() -> TestResult {
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
