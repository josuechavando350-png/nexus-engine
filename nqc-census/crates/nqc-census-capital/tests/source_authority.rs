use nqc_census_capital::{
    adapters::AaveV3FlashObservation,
    permissionless_atomic::{
        admit_balancer_v2_dual_provider, admit_uniswap_v3_dual_provider,
        BalancerV2AuthenticatedObservation, UniswapV3AuthenticatedObservation,
    },
    source_authority::{
        certify_with_d11_source_authorities, certify_with_d11_sources, D11SourceAuthority,
        D11SourceAuthoritySet,
    },
    Amount256, CapitalCensusLedger, CapitalCertificationContext, CapitalError, CapitalEvidenceRef,
    CapitalRequirement, GitObjectId, UpstreamCensusStage, UpstreamConsumptionReceipt,
    UpstreamStageAuthority, UpstreamStageAuthoritySpec,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Hash32 {
    Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
}

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!())
}

fn anchor() -> StateAnchor {
    StateAnchor::new(
        ChainDomain::new(1, hash(1), hash(2)).unwrap_or_else(|_| unreachable!()),
        25_437_474,
        hash(3),
        hash(4),
        1_700_000_000,
        hash(5),
    )
    .unwrap_or_else(|_| unreachable!())
}

fn stages() -> Result<Vec<UpstreamStageAuthority>, CapitalError> {
    UpstreamCensusStage::ALL
        .into_iter()
        .enumerate()
        .map(|(index, stage)| {
            let nibble = u8::try_from(index + 1)
                .map_err(|_| CapitalError::InvalidUpstreamAuthority("test stage index overflow"))?;
            UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
                stage,
                code_commit: GitObjectId::parse_hex(&format!("{nibble:040x}"))?,
                code_tree: GitObjectId::parse_hex(&format!("{:040x}", u64::from(nibble) + 10))?,
                artifact_sha256: hash(nibble.saturating_add(20)),
                observation_anchor: anchor(),
                unresolved_mismatch_count: 0,
                unknown_failure_count: 0,
                coverage_complete: true,
                admitted: true,
            })
        })
        .collect()
}

fn d08_artifact(stages: &[UpstreamStageAuthority]) -> Result<Hash32, CapitalError> {
    stages
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc008StateAdmission)
        .map(|stage| stage.artifact_sha256)
        .ok_or(CapitalError::InvalidUpstreamAuthority(
            "test RMC-008 authority missing",
        ))
}

fn d09_artifact(stages: &[UpstreamStageAuthority]) -> Result<Hash32, CapitalError> {
    stages
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc009PositionUniverse)
        .map(|stage| stage.artifact_sha256)
        .ok_or(CapitalError::InvalidUpstreamAuthority(
            "test RMC-009 authority missing",
        ))
}

fn d08_source(d08: Hash32) -> Result<nqc_census_capital::CapitalSource, CapitalError> {
    AaveV3FlashObservation {
        anchor: anchor(),
        pool: address(40),
        asset: address(41),
        available_underlying: Amount256::from_u128(1_000_000),
        premium_total_bps: 5,
        flash_loan_enabled: true,
        provider_locator_hash: hash(42),
        evidence: vec![CapitalEvidenceRef::Artifact(d08)],
    }
    .into_capital_source()
}

fn native_balancer_source(
    asset: u8,
    first_evidence: Hash32,
    second_evidence: Hash32,
) -> Result<nqc_census_capital::CapitalSource, CapitalError> {
    let observation = BalancerV2AuthenticatedObservation {
        anchor: anchor(),
        vault: address(50),
        asset: address(asset),
        available_vault_balance: Amount256::from_u128(2_000_000),
        fee_percentage_1e18: 500_000_000_000_000,
        paused: false,
    };
    admit_balancer_v2_dual_provider(
        &observation,
        &observation,
        &first_evidence,
        &second_evidence,
    )
}

fn native_uniswap_v3_source(
    asset: u8,
    first_evidence: Hash32,
    second_evidence: Hash32,
) -> Result<nqc_census_capital::CapitalSource, CapitalError> {
    let observation = UniswapV3AuthenticatedObservation {
        anchor: anchor(),
        pool: address(70),
        asset: address(asset),
        available_pool_balance: Amount256::from_u128(3_000_000),
        fee_pips: 3_000,
    };
    admit_uniswap_v3_dual_provider(
        &observation,
        &observation,
        &first_evidence,
        &second_evidence,
    )
}

fn context_for_d08_source(
    stage_rows: Vec<UpstreamStageAuthority>,
    source: &nqc_census_capital::CapitalSource,
) -> Result<CapitalCertificationContext, CapitalError> {
    let d08 = d08_artifact(&stage_rows)?;
    let d09 = d09_artifact(&stage_rows)?;
    let admitted = stage_rows
        .iter()
        .map(|stage| CapitalEvidenceRef::Artifact(stage.artifact_sha256))
        .collect::<Vec<_>>();
    CapitalCertificationContext::new(stage_rows, admitted)?.with_consumption_receipts(vec![
        UpstreamConsumptionReceipt::for_sources(d08, hash(80), [source])?,
        UpstreamConsumptionReceipt::for_requirements(
            d09,
            hash(81),
            std::iter::empty::<&CapitalRequirement>(),
        )?,
    ])
}

#[test]
fn expanded_certificate_preserves_d08_receipt_and_admits_native_d11_sources() -> TestResult {
    let stage_rows = stages()?;
    let upstream_source = d08_source(d08_artifact(&stage_rows)?)?;
    let native = native_balancer_source(51, hash(60), hash(61))?;
    let context = context_for_d08_source(stage_rows, &upstream_source)?;
    let native_authority = D11SourceAuthority::from_reconciliation_artifact(
        anchor(),
        b"exact-balancer-reconciliation",
        &[native.clone()],
    )?;

    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(upstream_source)?;
    ledger.register_source(native)?;
    ledger.evaluate_all()?;

    let certificate = certify_with_d11_sources(&ledger, &context, &native_authority)?;
    assert_eq!(certificate.d08_source_count, 1);
    assert_eq!(certificate.d11_native_source_count, 1);
    assert_eq!(certificate.summary.source_count, 2);

    // The legacy certifier must continue to reject the expanded source set.
    assert!(ledger.certify(&context).is_err());
    Ok(())
}

#[test]
fn expanded_certificate_accepts_multiple_disjoint_native_families() -> TestResult {
    let stage_rows = stages()?;
    let upstream_source = d08_source(d08_artifact(&stage_rows)?)?;
    let balancer = native_balancer_source(51, hash(60), hash(61))?;
    let uniswap_v3 = native_uniswap_v3_source(71, hash(62), hash(63))?;
    let context = context_for_d08_source(stage_rows, &upstream_source)?;

    let balancer_authority = D11SourceAuthority::from_reconciliation_artifact(
        anchor(),
        b"exact-balancer-reconciliation",
        &[balancer.clone()],
    )?;
    let uniswap_authority = D11SourceAuthority::from_reconciliation_artifact(
        anchor(),
        b"exact-uniswap-v3-reconciliation",
        &[uniswap_v3.clone()],
    )?;
    let authority_set = D11SourceAuthoritySet::new(vec![balancer_authority, uniswap_authority])?;

    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(upstream_source)?;
    ledger.register_source(balancer)?;
    ledger.register_source(uniswap_v3)?;
    ledger.evaluate_all()?;

    let certificate = certify_with_d11_source_authorities(&ledger, &context, &authority_set)?;
    assert_eq!(certificate.d08_source_count, 1);
    assert_eq!(certificate.d11_native_source_count, 2);
    assert_eq!(certificate.summary.source_count, 3);
    assert_eq!(authority_set.source_count(), 2);
    assert_eq!(authority_set.authorities().count(), 2);
    Ok(())
}

#[test]
fn native_authority_set_rejects_duplicate_family() -> TestResult {
    let first = native_balancer_source(51, hash(60), hash(61))?;
    let second = native_balancer_source(52, hash(62), hash(63))?;
    let first_authority =
        D11SourceAuthority::from_reconciliation_artifact(anchor(), b"balancer-a", &[first])?;
    let second_authority =
        D11SourceAuthority::from_reconciliation_artifact(anchor(), b"balancer-b", &[second])?;
    assert!(matches!(
        D11SourceAuthoritySet::new(vec![first_authority, second_authority]),
        Err(CapitalError::InvalidUpstreamAuthority(_))
    ));
    Ok(())
}

#[test]
fn native_authority_set_rejects_source_union_mutation() -> TestResult {
    let balancer = native_balancer_source(51, hash(60), hash(61))?;
    let uniswap_v3 = native_uniswap_v3_source(71, hash(62), hash(63))?;
    let balancer_authority = D11SourceAuthority::from_reconciliation_artifact(
        anchor(),
        b"exact-balancer-reconciliation",
        &[balancer.clone()],
    )?;
    let uniswap_authority = D11SourceAuthority::from_reconciliation_artifact(
        anchor(),
        b"exact-uniswap-v3-reconciliation",
        &[uniswap_v3.clone()],
    )?;
    let authority_set = D11SourceAuthoritySet::new(vec![balancer_authority, uniswap_authority])?;
    assert!(authority_set
        .verify_source_set([&balancer, &uniswap_v3])
        .is_ok());
    assert!(authority_set.verify_source_set([&balancer]).is_err());
    Ok(())
}

#[test]
fn expanded_certificate_rejects_source_smuggled_under_other_upstream_evidence() -> TestResult {
    let stage_rows = stages()?;
    let d08 = d08_artifact(&stage_rows)?;
    let upstream_source = d08_source(d08)?;
    let native = native_balancer_source(51, hash(60), hash(61))?;
    let rogue_upstream_artifact = stage_rows
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc006DiscoveryAave)
        .ok_or("missing D06")?
        .artifact_sha256;
    let rogue = native_balancer_source(52, rogue_upstream_artifact, hash(62))?;
    let context = context_for_d08_source(stage_rows, &upstream_source)?;
    let native_authority = D11SourceAuthority::from_reconciliation_artifact(
        anchor(),
        b"exact-balancer-reconciliation",
        &[native.clone()],
    )?;

    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(upstream_source)?;
    ledger.register_source(native)?;
    ledger.register_source(rogue)?;
    ledger.evaluate_all()?;

    assert!(matches!(
        certify_with_d11_sources(&ledger, &context, &native_authority),
        Err(CapitalError::UnresolvedEvidenceRef)
    ));
    Ok(())
}

#[test]
fn expanded_certificate_rejects_missing_d08_source_even_with_valid_native_authority() -> TestResult
{
    let stage_rows = stages()?;
    let upstream_source = d08_source(d08_artifact(&stage_rows)?)?;
    let context = context_for_d08_source(stage_rows, &upstream_source)?;
    let native = native_balancer_source(51, hash(60), hash(61))?;
    let native_authority = D11SourceAuthority::from_reconciliation_artifact(
        anchor(),
        b"exact-balancer-reconciliation",
        &[native.clone()],
    )?;

    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(native)?;
    ledger.evaluate_all()?;

    assert!(matches!(
        certify_with_d11_sources(&ledger, &context, &native_authority),
        Err(CapitalError::InvalidUpstreamAuthority(_))
    ));
    Ok(())
}
