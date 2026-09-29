use nqc_census_capital::{
    artifacts::{
        export_capital_artifacts, ArtifactProvenance, CAPITAL_EVIDENCE_MANIFEST_FILE,
        CAPITAL_FEASIBILITY_FILE, CAPITAL_REJECTION_LEDGER_FILE, CAPITAL_REQUIREMENTS_FILE,
        CAPITAL_SOURCES_FILE, CAPITAL_SUMMARY_FILE,
    },
    Amount256, CapitalAsset, CapitalCaps, CapitalCensusLedger, CapitalClass,
    CapitalEvidenceRef, CapitalFailureMode, CapitalProviderKind, CapitalRequirement,
    CapitalRequirementLeg, CapitalSource, CapitalSourceSpec, CapitalTargetId,
    CollateralRequirement, FeeModel, RepaymentSemantics, RequiredAtomicity, RequirementKind,
    TemporaryLock, UtilizationConstraints,
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

fn evidence() -> Vec<CapitalEvidenceRef> {
    vec![CapitalEvidenceRef::Artifact(hash(99))]
}

fn ledger() -> Result<CapitalCensusLedger, Box<dyn std::error::Error>> {
    let token = CapitalAsset::Token(address(20));
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(),
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
    let requirement = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(50)),
        anchor(),
        RequiredAtomicity::SameTransaction,
        false,
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
        ],
        evidence(),
    )?;
    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(source)?;
    ledger.register_requirement(requirement)?;
    ledger.evaluate_all()?;
    Ok(ledger)
}

#[test]
fn capital_artifacts_are_deterministic_and_complete() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2026-09-29T00:00:00Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let first = export_capital_artifacts(&ledger, &provenance)?;
    let second = export_capital_artifacts(&ledger, &provenance)?;
    assert_eq!(first, second);

    for name in [
        CAPITAL_SOURCES_FILE,
        CAPITAL_REQUIREMENTS_FILE,
        CAPITAL_FEASIBILITY_FILE,
        CAPITAL_REJECTION_LEDGER_FILE,
        CAPITAL_SUMMARY_FILE,
        CAPITAL_EVIDENCE_MANIFEST_FILE,
    ] {
        assert!(first.file(name).is_some(), "missing artifact {name}");
    }

    let manifest = first
        .file(CAPITAL_EVIDENCE_MANIFEST_FILE)
        .ok_or("missing manifest")?;
    let text = std::str::from_utf8(&manifest.bytes)?;
    assert!(text.contains(CAPITAL_SOURCES_FILE));
    assert!(text.contains(CAPITAL_SUMMARY_FILE));
    assert!(text.contains("\"profitability_claimed\":false") == false);
    Ok(())
}

#[test]
fn jsonl_records_carry_exact_anchor_and_provenance() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2026-09-29T00:00:00Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let bundle = export_capital_artifacts(&ledger, &provenance)?;
    let sources = bundle.file(CAPITAL_SOURCES_FILE).ok_or("missing sources")?;
    let text = std::str::from_utf8(&sources.bytes)?;
    assert!(text.contains("\"block_number\":25437474"));
    assert!(text.contains("\"provider_namespace\":11"));
    assert!(text.contains("\"code_commit\":\"0123456789abcdef0123456789abcdef01234567\""));
    assert!(text.ends_with('\n'));
    Ok(())
}

#[test]
fn artifact_hashes_change_when_provenance_changes() -> TestResult {
    let ledger = ledger()?;
    let a = export_capital_artifacts(
        &ledger,
        &ArtifactProvenance::new("A", "commit-a", "tree-a")?,
    )?;
    let b = export_capital_artifacts(
        &ledger,
        &ArtifactProvenance::new("B", "commit-a", "tree-a")?,
    )?;
    assert_ne!(
        a.file(CAPITAL_SUMMARY_FILE).ok_or("missing summary A")?.sha256,
        b.file(CAPITAL_SUMMARY_FILE).ok_or("missing summary B")?.sha256
    );
    Ok(())
}

#[test]
fn synthetic_ledger_cannot_export_evidentiary_artifacts() -> TestResult {
    let ledger = CapitalCensusLedger::synthetic_fixture();
    let provenance = ArtifactProvenance::new("t", "c", "r")?;
    assert!(export_capital_artifacts(&ledger, &provenance).is_err());
    Ok(())
}
