use nqc_census_closeout::{
    CloseoutCertificate, CloseoutError, EconomicBoundary, GitObjectId, PipelineCounts, RmcStage,
    StageProof,
};
use nqc_census_core::Hash32;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Hash32 {
    Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
}

fn git(byte: u8) -> Result<GitObjectId, CloseoutError> {
    GitObjectId::parse_hex(&format!("{byte:02x}").repeat(20))
}

fn proof(stage: RmcStage, byte: u8) -> Result<StageProof, CloseoutError> {
    StageProof::new(
        stage,
        git(byte)?,
        git(byte.saturating_add(1))?,
        hash(byte.saturating_add(2)),
        hash(byte.saturating_add(3)),
        hash(byte.saturating_add(4)),
        true,
        true,
        0,
        0,
        0,
        vec![hash(byte.saturating_add(5))],
    )
}

fn proofs() -> Result<Vec<StageProof>, CloseoutError> {
    RmcStage::REQUIRED
        .into_iter()
        .enumerate()
        .map(|(index, stage)| {
            let byte = u8::try_from(index + 10).map_err(|_| CloseoutError::InvalidGitObjectId)?;
            proof(stage, byte)
        })
        .collect()
}

fn counts() -> PipelineCounts {
    PipelineCounts {
        markets_discovered: 100,
        markets_canonicalized: 90,
        markets_state_reconstructable: 80,
        markets_economically_active: 70,
        markets_borrowable: 60,
        actionable_candidates: 20,
        capital_feasible_candidates: 15,
        execution_simulatable_candidates: 10,
        positive_gross_value_candidates: 9,
        positive_success_path_net_candidates: 7,
        capacity_material_candidates: 2,
        shadow_eligible_candidates: 1,
    }
}

fn economics() -> EconomicBoundary {
    EconomicBoundary {
        real_candidate_count: 20,
        economics_quote_count: 10,
        shadow_prediction_count: 1,
        capture_calibrated_count: 0,
        zero_own_capital_proven: true,
        realized_profitability_proven: false,
        monthly_target_probability_proven: false,
    }
}

#[test]
fn all_terminal_proofs_close_rmc_without_claiming_profitability() -> TestResult {
    let certificate =
        CloseoutCertificate::certify(proofs()?, counts(), economics(), vec![hash(200), hash(201)])?;
    assert!(certificate.real_market_census_closed());
    assert_eq!(certificate.status(), "REAL_MARKET_CENSUS_CLOSED");
    assert_eq!(certificate.stages().len(), 8);
    assert_eq!(certificate.economics().capture_calibrated_count, 0);
    Ok(())
}

#[test]
fn missing_stage_fails_closed() -> TestResult {
    let mut stages = proofs()?;
    stages.retain(|proof| proof.stage != RmcStage::Rmc010);
    assert!(matches!(
        CloseoutCertificate::certify(stages, counts(), economics(), vec![hash(200)]),
        Err(CloseoutError::MissingStage(RmcStage::Rmc010))
    ));
    Ok(())
}

#[test]
fn duplicate_stage_fails_closed() -> TestResult {
    let mut stages = proofs()?;
    stages.push(proof(RmcStage::Rmc013, 99)?);
    assert!(matches!(
        CloseoutCertificate::certify(stages, counts(), economics(), vec![hash(200)]),
        Err(CloseoutError::DuplicateStage(RmcStage::Rmc013))
    ));
    Ok(())
}

#[test]
fn mismatch_unknown_and_blocker_each_fail_closed() -> TestResult {
    for field in 0..3 {
        let mut stages = proofs()?;
        let target = stages
            .iter_mut()
            .find(|proof| proof.stage == RmcStage::Rmc012)
            .ok_or("missing test stage")?;
        match field {
            0 => target.unresolved_mismatch_count = 1,
            1 => target.unknown_failure_count = 1,
            _ => target.blocker_count = 1,
        }
        assert!(
            CloseoutCertificate::certify(stages, counts(), economics(), vec![hash(200)]).is_err()
        );
    }
    Ok(())
}

#[test]
fn non_monotonic_pipeline_is_rejected() -> TestResult {
    let mut bad = counts();
    bad.positive_success_path_net_candidates = bad.positive_gross_value_candidates + 1;
    assert!(matches!(
        CloseoutCertificate::certify(proofs()?, bad, economics(), vec![hash(200)]),
        Err(CloseoutError::PipelineNotMonotonic)
    ));
    Ok(())
}

#[test]
fn opportunity_count_may_exceed_borrowable_market_count_without_aliasing_domains() -> TestResult {
    let mut independent = counts();
    independent.markets_discovered = 10;
    independent.markets_canonicalized = 10;
    independent.markets_state_reconstructable = 9;
    independent.markets_economically_active = 8;
    independent.markets_borrowable = 7;
    independent.actionable_candidates = 100;
    independent.capital_feasible_candidates = 90;
    independent.execution_simulatable_candidates = 80;
    independent.positive_gross_value_candidates = 70;
    independent.positive_success_path_net_candidates = 60;
    independent.capacity_material_candidates = 40;
    independent.shadow_eligible_candidates = 30;

    let boundary = EconomicBoundary {
        real_candidate_count: 100,
        economics_quote_count: 80,
        shadow_prediction_count: 30,
        capture_calibrated_count: 0,
        zero_own_capital_proven: true,
        realized_profitability_proven: false,
        monthly_target_probability_proven: false,
    };
    let certificate =
        CloseoutCertificate::certify(proofs()?, independent, boundary, vec![hash(200)])?;
    assert!(certificate.real_market_census_closed());
    Ok(())
}

#[test]
fn capital_feasible_opportunity_requires_zero_own_capital_proof() -> TestResult {
    let mut boundary = economics();
    boundary.zero_own_capital_proven = false;
    assert!(matches!(
        CloseoutCertificate::certify(proofs()?, counts(), boundary, vec![hash(200)]),
        Err(CloseoutError::ZeroOwnCapitalNotProven)
    ));
    Ok(())
}

#[test]
fn rmc_cannot_smuggle_realized_or_monthly_target_profitability_claim() -> TestResult {
    for monthly in [false, true] {
        let mut boundary = economics();
        boundary.realized_profitability_proven = !monthly;
        boundary.monthly_target_probability_proven = monthly;
        assert!(matches!(
            CloseoutCertificate::certify(proofs()?, counts(), boundary, vec![hash(200)]),
            Err(CloseoutError::ProfitabilityClaimForbidden)
        ));
    }
    Ok(())
}

#[test]
fn terminal_commitment_is_input_order_independent() -> TestResult {
    let left =
        CloseoutCertificate::certify(proofs()?, counts(), economics(), vec![hash(200), hash(201)])?;
    let mut reversed = proofs()?;
    reversed.reverse();
    let right =
        CloseoutCertificate::certify(reversed, counts(), economics(), vec![hash(201), hash(200)])?;
    assert_eq!(left.commitment(), right.commitment());
    Ok(())
}

#[test]
fn changing_any_stage_artifact_changes_terminal_commitment() -> TestResult {
    let left = CloseoutCertificate::certify(proofs()?, counts(), economics(), vec![hash(200)])?;
    let mut changed = proofs()?;
    let target = changed
        .iter_mut()
        .find(|proof| proof.stage == RmcStage::Rmc013)
        .ok_or("missing test stage")?;
    target.artifact_sha256 = hash(250);
    let right = CloseoutCertificate::certify(changed, counts(), economics(), vec![hash(200)])?;
    assert_ne!(left.commitment(), right.commitment());
    Ok(())
}

#[test]
fn invalid_uppercase_or_short_git_identity_is_rejected() {
    assert!(GitObjectId::parse_hex("ABCDEF0123456789ABCDEF0123456789ABCDEF01").is_err());
    assert!(GitObjectId::parse_hex("0000000000000000000000000000000000000000").is_err());
    assert!(GitObjectId::parse_hex("abcd").is_err());
}
