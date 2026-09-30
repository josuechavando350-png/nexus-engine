use nqc_census_capital::{
    evaluate_capital_feasibility, Amount256, CapitalAsset, CapitalCaps, CapitalClass,
    CapitalEvidenceRef, CapitalFailureMode, CapitalFeasibility, CapitalOwnership,
    CapitalProviderKind, CapitalRequirement, CapitalRequirementLeg, CapitalSource,
    CapitalSourceSpec, CapitalTargetId, CollateralRequirement, FeeModel, RepaymentSemantics,
    RequiredAtomicity, RequirementKind, TemporaryLock, UtilizationConstraints,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use nqc_census_portfolio::{
    evaluate_portfolio, ConflictResource, PortfolioCandidate, PortfolioError, ResourceClaim,
    ResourceLimit, ResourceUnit, SharedResource, SharedResourceKind,
};

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

fn anchor_on(chain: ChainDomain, block: u64, byte: u8) -> StateAnchor {
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

fn evidence() -> Vec<CapitalEvidenceRef> {
    vec![CapitalEvidenceRef::Artifact(hash(200))]
}

fn source(
    anchor: StateAnchor,
    locator: u8,
    maximum: u128,
    ownership: CapitalOwnership,
) -> Result<CapitalSource, nqc_census_capital::CapitalError> {
    let asset = CapitalAsset::Token(address(20));
    CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::InventoryRequirement,
        anchor,
        provider_namespace: 12,
        provider_locator_hash: hash(locator),
        provider_kind: CapitalProviderKind::ExternalSponsor,
        ownership,
        source_contract: None,
        asset,
        maximum_available: Amount256::from_u128(maximum),
        fee_model: FeeModel::None,
        repayment_asset: asset,
        repayment: RepaymentSemantics::NoRepayment,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    })
}

fn requirement(
    anchor: StateAnchor,
    target: u8,
    amount: u128,
) -> Result<CapitalRequirement, nqc_census_capital::CapitalError> {
    let leg = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        CapitalAsset::Token(address(20)),
        Amount256::from_u128(amount),
        vec![CapitalClass::InventoryRequirement],
    )?;
    CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(target)),
        anchor,
        RequiredAtomicity::SameTransaction,
        false,
        vec![leg],
        evidence(),
    )
}

#[test]
fn individually_feasible_candidates_cannot_double_spend_one_source() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let shared = source(anchor.clone(), 30, 100, CapitalOwnership::External)?;
    let a = requirement(anchor.clone(), 40, 70)?;
    let b = requirement(anchor.clone(), 41, 70)?;
    let fa = evaluate_capital_feasibility(&a, std::slice::from_ref(&shared));
    let fb = evaluate_capital_feasibility(&b, std::slice::from_ref(&shared));
    assert!(matches!(fa, CapitalFeasibility::Feasible { .. }));
    assert!(matches!(fb, CapitalFeasibility::Feasible { .. }));

    let candidates = vec![
        PortfolioCandidate::new(a.id(), anchor.clone(), vec![])?,
        PortfolioCandidate::new(b.id(), anchor, vec![])?,
    ];
    let report = evaluate_portfolio(
        &candidates,
        &[a, b],
        &[fa, fb],
        std::slice::from_ref(&shared),
        &[],
    )?;
    assert!(!report.simultaneously_feasible());
    assert_eq!(report.conflicts().len(), 1);
    assert!(matches!(
        report.conflicts()[0].resource,
        ConflictResource::CapitalSource(key) if key == shared.key_id()
    ));
    assert_eq!(report.conflicts()[0].capacity, Amount256::from_u128(100));
    assert_eq!(report.conflicts()[0].claimed, Amount256::from_u128(140));
    assert_eq!(report.conflicts()[0].claimants.len(), 2);
    Ok(())
}

#[test]
fn same_locator_on_different_chains_never_aliases() -> TestResult {
    let ethereum = anchor_on(chain(1, 1), 100, 10);
    let base = anchor_on(chain(8453, 20), 100, 30);
    let locator = hash(50);

    let a = SharedResource::new(
        ethereum,
        SharedResourceKind::DexLiquidity,
        locator,
        ResourceUnit::AssetUnits(CapitalAsset::Token(address(60))),
        ResourceLimit::Capacity(Amount256::from_u128(1_000)),
        evidence(),
    )?;
    let b = SharedResource::new(
        base,
        SharedResourceKind::DexLiquidity,
        locator,
        ResourceUnit::AssetUnits(CapitalAsset::Token(address(60))),
        ResourceLimit::Capacity(Amount256::from_u128(1_000)),
        evidence(),
    )?;
    assert_ne!(a.key_id(), b.key_id());
    assert_ne!(a.id(), b.id());
    Ok(())
}

#[test]
fn stable_resource_key_changes_observation_id_when_capacity_changes() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let locator = hash(50);
    let a = SharedResource::new(
        anchor.clone(),
        SharedResourceKind::FlashPool,
        locator,
        ResourceUnit::AssetUnits(CapitalAsset::Token(address(60))),
        ResourceLimit::Capacity(Amount256::from_u128(1_000)),
        evidence(),
    )?;
    let b = SharedResource::new(
        anchor,
        SharedResourceKind::FlashPool,
        locator,
        ResourceUnit::AssetUnits(CapitalAsset::Token(address(60))),
        ResourceLimit::Capacity(Amount256::from_u128(900)),
        evidence(),
    )?;
    assert_eq!(a.key_id(), b.key_id());
    assert_ne!(a.id(), b.id());
    Ok(())
}

#[test]
fn exclusive_borrower_position_creates_conflict_set() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let funding = source(anchor.clone(), 30, 200, CapitalOwnership::External)?;
    let a = requirement(anchor.clone(), 40, 50)?;
    let b = requirement(anchor.clone(), 41, 50)?;
    let fa = evaluate_capital_feasibility(&a, std::slice::from_ref(&funding));
    let fb = evaluate_capital_feasibility(&b, std::slice::from_ref(&funding));
    let borrower = SharedResource::new(
        anchor.clone(),
        SharedResourceKind::BorrowerPosition,
        hash(70),
        ResourceUnit::Count,
        ResourceLimit::Exclusive,
        evidence(),
    )?;
    let claim = ResourceClaim::new(borrower.key_id(), Amount256::from_u128(1))?;
    let candidates = vec![
        PortfolioCandidate::new(a.id(), anchor.clone(), vec![claim])?,
        PortfolioCandidate::new(b.id(), anchor, vec![claim])?,
    ];

    let report = evaluate_portfolio(
        &candidates,
        &[a, b],
        &[fa, fb],
        &[funding],
        std::slice::from_ref(&borrower),
    )?;
    assert!(!report.simultaneously_feasible());
    assert!(report.conflicts().iter().any(|conflict| {
        matches!(
            conflict.resource,
            ConflictResource::Shared(key) if key == borrower.key_id()
        ) && conflict.capacity == Amount256::from_u128(1)
            && conflict.claimed == Amount256::from_u128(2)
    }));
    Ok(())
}

#[test]
fn disjoint_candidates_are_simultaneously_feasible() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let source_a = source(anchor.clone(), 30, 100, CapitalOwnership::External)?;
    let source_b = source(anchor.clone(), 31, 100, CapitalOwnership::External)?;
    let a = requirement(anchor.clone(), 40, 70)?;
    let b = requirement(anchor.clone(), 41, 70)?;
    let fa = evaluate_capital_feasibility(&a, std::slice::from_ref(&source_a));
    let fb = evaluate_capital_feasibility(&b, std::slice::from_ref(&source_b));
    let route_a = SharedResource::new(
        anchor.clone(),
        SharedResourceKind::DexLiquidity,
        hash(80),
        ResourceUnit::AssetUnits(CapitalAsset::Token(address(20))),
        ResourceLimit::Capacity(Amount256::from_u128(100)),
        evidence(),
    )?;
    let route_b = SharedResource::new(
        anchor.clone(),
        SharedResourceKind::DexLiquidity,
        hash(81),
        ResourceUnit::AssetUnits(CapitalAsset::Token(address(20))),
        ResourceLimit::Capacity(Amount256::from_u128(100)),
        evidence(),
    )?;
    let candidates = vec![
        PortfolioCandidate::new(
            a.id(),
            anchor.clone(),
            vec![ResourceClaim::new(
                route_a.key_id(),
                Amount256::from_u128(70),
            )?],
        )?,
        PortfolioCandidate::new(
            b.id(),
            anchor,
            vec![ResourceClaim::new(
                route_b.key_id(),
                Amount256::from_u128(70),
            )?],
        )?,
    ];

    let report = evaluate_portfolio(
        &candidates,
        &[a, b],
        &[fa, fb],
        &[source_a, source_b],
        &[route_a, route_b],
    )?;
    assert!(report.simultaneously_feasible());
    assert_eq!(report.capital_feasible_count(), 2);
    assert!(report.conflicts().is_empty());
    Ok(())
}

#[test]
fn capital_rejection_is_preserved_in_portfolio_report() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let too_small = source(anchor.clone(), 30, 10, CapitalOwnership::External)?;
    let req = requirement(anchor.clone(), 40, 70)?;
    let feasibility = evaluate_capital_feasibility(&req, std::slice::from_ref(&too_small));
    assert!(matches!(feasibility, CapitalFeasibility::Rejected { .. }));
    let report = evaluate_portfolio(
        &[PortfolioCandidate::new(req.id(), anchor, vec![])?],
        &[req],
        &[feasibility],
        &[too_small],
        &[],
    )?;
    assert!(!report.simultaneously_feasible());
    assert_eq!(report.capital_feasible_count(), 0);
    assert_eq!(report.capital_rejected().len(), 1);
    Ok(())
}

#[test]
fn operator_owned_allocation_fails_closed_even_if_manually_injected() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let owned = source(anchor.clone(), 30, 100, CapitalOwnership::OperatorOwned)?;
    let req = requirement(anchor.clone(), 40, 70)?;
    let feasibility = CapitalFeasibility::Feasible {
        requirement_id: req.id(),
        allocations: vec![nqc_census_capital::SourceAllocation {
            source_id: owned.id(),
            leg_kind: RequirementKind::ActionPrincipal,
            amount: Amount256::from_u128(70),
        }],
    };
    let result = evaluate_portfolio(
        &[PortfolioCandidate::new(req.id(), anchor, vec![])?],
        &[req],
        &[feasibility],
        &[owned],
        &[],
    );
    assert!(matches!(result, Err(PortfolioError::OperatorOwnedSource)));
    Ok(())
}

#[test]
fn shared_resource_must_match_candidate_anchor() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let other = anchor_on(chain(1, 1), 101, 13);
    let funding = source(anchor.clone(), 30, 100, CapitalOwnership::External)?;
    let req = requirement(anchor.clone(), 40, 50)?;
    let feasibility = evaluate_capital_feasibility(&req, std::slice::from_ref(&funding));
    let resource = SharedResource::new(
        other,
        SharedResourceKind::Market,
        hash(90),
        ResourceUnit::Count,
        ResourceLimit::Exclusive,
        evidence(),
    )?;
    let result = evaluate_portfolio(
        &[PortfolioCandidate::new(
            req.id(),
            anchor,
            vec![ResourceClaim::new(
                resource.key_id(),
                Amount256::from_u128(1),
            )?],
        )?],
        &[req],
        &[feasibility],
        &[funding],
        &[resource],
    );
    assert!(matches!(
        result,
        Err(PortfolioError::ResourceAnchorMismatch)
    ));
    Ok(())
}

#[test]
fn report_commitment_is_independent_of_input_order() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let funding = source(anchor.clone(), 30, 200, CapitalOwnership::External)?;
    let a = requirement(anchor.clone(), 40, 50)?;
    let b = requirement(anchor.clone(), 41, 50)?;
    let fa = evaluate_capital_feasibility(&a, std::slice::from_ref(&funding));
    let fb = evaluate_capital_feasibility(&b, std::slice::from_ref(&funding));
    let resource = SharedResource::new(
        anchor.clone(),
        SharedResourceKind::ProtocolCap,
        hash(91),
        ResourceUnit::Count,
        ResourceLimit::Capacity(Amount256::from_u128(10)),
        evidence(),
    )?;
    let claim = ResourceClaim::new(resource.key_id(), Amount256::from_u128(1))?;
    let ca = PortfolioCandidate::new(a.id(), anchor.clone(), vec![claim])?;
    let cb = PortfolioCandidate::new(b.id(), anchor, vec![claim])?;

    let left = evaluate_portfolio(
        &[ca.clone(), cb.clone()],
        &[a.clone(), b.clone()],
        &[fa.clone(), fb.clone()],
        std::slice::from_ref(&funding),
        std::slice::from_ref(&resource),
    )?;
    let right = evaluate_portfolio(&[cb, ca], &[b, a], &[fb, fa], &[funding], &[resource])?;
    assert_eq!(left.commitment(), right.commitment());
    Ok(())
}

#[test]
fn commitment_binds_candidate_identity_even_without_conflicts() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let funding = source(anchor.clone(), 30, 500, CapitalOwnership::External)?;
    let a = requirement(anchor.clone(), 40, 50)?;
    let b = requirement(anchor.clone(), 41, 50)?;
    let fa = evaluate_capital_feasibility(&a, std::slice::from_ref(&funding));
    let fb = evaluate_capital_feasibility(&b, std::slice::from_ref(&funding));

    let one = evaluate_portfolio(
        &[PortfolioCandidate::new(a.id(), anchor.clone(), vec![])?],
        std::slice::from_ref(&a),
        std::slice::from_ref(&fa),
        std::slice::from_ref(&funding),
        &[],
    )?;
    let two = evaluate_portfolio(
        &[PortfolioCandidate::new(b.id(), anchor, vec![])?],
        &[b],
        &[fb],
        &[funding],
        &[],
    )?;
    assert!(one.simultaneously_feasible());
    assert!(two.simultaneously_feasible());
    assert_ne!(one.commitment(), two.commitment());
    Ok(())
}

#[test]
fn commitment_binds_observed_capacity_even_without_conflicts() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let source_100 = source(anchor.clone(), 30, 100, CapitalOwnership::External)?;
    let source_200 = source(anchor.clone(), 30, 200, CapitalOwnership::External)?;
    assert_eq!(source_100.key_id(), source_200.key_id());
    assert_ne!(source_100.id(), source_200.id());

    let req = requirement(anchor.clone(), 40, 50)?;
    let f100 = evaluate_capital_feasibility(&req, std::slice::from_ref(&source_100));
    let f200 = evaluate_capital_feasibility(&req, std::slice::from_ref(&source_200));
    let candidate = PortfolioCandidate::new(req.id(), anchor, vec![])?;

    let low = evaluate_portfolio(
        std::slice::from_ref(&candidate),
        std::slice::from_ref(&req),
        &[f100],
        &[source_100],
        &[],
    )?;
    let high = evaluate_portfolio(&[candidate], &[req], &[f200], &[source_200], &[])?;
    assert!(low.simultaneously_feasible());
    assert!(high.simultaneously_feasible());
    assert_ne!(low.commitment(), high.commitment());
    Ok(())
}


#[test]
fn contention_graph_decomposes_into_independent_components() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let shared = source(anchor.clone(), 30, 500, CapitalOwnership::External)?;
    let isolated = source(anchor.clone(), 31, 500, CapitalOwnership::External)?;
    let a = requirement(anchor.clone(), 40, 50)?;
    let b = requirement(anchor.clone(), 41, 50)?;
    let c_req = requirement(anchor.clone(), 42, 50)?;
    let fa = evaluate_capital_feasibility(&a, std::slice::from_ref(&shared));
    let fb = evaluate_capital_feasibility(&b, std::slice::from_ref(&shared));
    let fc = evaluate_capital_feasibility(&c_req, std::slice::from_ref(&isolated));

    let candidate_a = PortfolioCandidate::new(a.id(), anchor.clone(), vec![])?;
    let candidate_b = PortfolioCandidate::new(b.id(), anchor.clone(), vec![])?;
    let candidate_c = PortfolioCandidate::new(c_req.id(), anchor, vec![])?;
    let candidate_a_id = candidate_a.id();
    let candidate_b_id = candidate_b.id();
    let candidate_c_id = candidate_c.id();

    let report = evaluate_portfolio(
        &[candidate_a, candidate_b, candidate_c],
        &[a, b, c_req],
        &[fa, fb, fc],
        &[shared, isolated],
        &[],
    )?;

    assert!(report.simultaneously_feasible());
    assert_eq!(report.components().len(), 2);
    let sizes = report
        .components()
        .iter()
        .map(|component| component.candidates.len())
        .collect::<Vec<_>>();
    assert_eq!(sizes, vec![2, 1]);
    assert!(report.components().iter().any(|component| {
        component.candidates.contains(&candidate_a_id)
            && component.candidates.contains(&candidate_b_id)
    }));
    assert!(report
        .components()
        .iter()
        .any(|component| component.candidates == vec![candidate_c_id]));
    Ok(())
}


#[test]
fn route_variants_share_requirement_but_keep_distinct_candidate_identity() -> TestResult {
    let anchor = anchor_on(chain(1, 1), 100, 10);
    let funding = source(anchor.clone(), 30, 500, CapitalOwnership::External)?;
    let req = requirement(anchor.clone(), 40, 50)?;
    let feasibility = evaluate_capital_feasibility(&req, std::slice::from_ref(&funding));
    let opportunity = SharedResource::new(
        anchor.clone(),
        SharedResourceKind::Opportunity,
        hash(93),
        ResourceUnit::Count,
        ResourceLimit::Exclusive,
        evidence(),
    )?;
    let claim = ResourceClaim::new(opportunity.key_id(), Amount256::from_u128(1))?;
    let route_a = PortfolioCandidate::new_variant(req.id(), hash(94), anchor.clone(), vec![claim])?;
    let route_b = PortfolioCandidate::new_variant(req.id(), hash(95), anchor, vec![claim])?;
    assert_ne!(route_a.id(), route_b.id());
    assert_eq!(route_a.requirement_id(), route_b.requirement_id());

    let report = evaluate_portfolio(
        &[route_a.clone(), route_b.clone()],
        &[req],
        &[feasibility],
        &[funding],
        std::slice::from_ref(&opportunity),
    )?;
    assert_eq!(report.candidate_count(), 2);
    assert_eq!(report.capital_feasible_count(), 2);
    assert!(report.conflicts().iter().any(|conflict| {
        matches!(
            conflict.resource,
            ConflictResource::Shared(key) if key == opportunity.key_id()
        ) && conflict.claimants.contains(&route_a.id())
            && conflict.claimants.contains(&route_b.id())
    }));
    Ok(())
}
