use nqc_census_capital::{
    artifacts::{export_capital_artifacts, ArtifactProvenance, CAPITAL_SOURCES_FILE},
    Amount256, CapitalAsset, CapitalCaps, CapitalCensusLedger, CapitalCertificationContext,
    CapitalClass, CapitalEvidenceRef, CapitalFailureMode, CapitalOwnership, CapitalProviderKind,
    CapitalRequirement, CapitalRequirementLeg, CapitalSource, CapitalSourceSpec, CapitalTargetId,
    CollateralRequirement, FeeModel, GitObjectId, RepaymentSemantics, RequiredAtomicity,
    RequirementKind, TemporaryLock, UpstreamCensusStage, UpstreamStageAuthority,
    UpstreamStageAuthoritySpec, UtilizationConstraints,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

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

fn authority() -> Result<CapitalCertificationContext, nqc_census_capital::CapitalError> {
    let mut stages = Vec::new();
    for (index, stage) in UpstreamCensusStage::ALL.into_iter().enumerate() {
        let ordinal = u64::try_from(index + 1).map_err(|_| {
            nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
                "offline CLI test authority index overflow",
            )
        })?;
        stages.push(UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
            stage,
            code_commit: GitObjectId::parse_hex(&format!("{ordinal:040x}"))?,
            code_tree: GitObjectId::parse_hex(&format!("{:040x}", ordinal + 10))?,
            artifact_sha256: hash(u8::try_from(ordinal + 20).map_err(|_| {
                nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
                    "offline CLI test artifact ordinal overflow",
                )
            })?),
            observation_anchor: anchor(),
            unresolved_mismatch_count: 0,
            unknown_failure_count: 0,
            coverage_complete: true,
            admitted: true,
        })?);
    }
    let mut admitted_evidence = evidence();
    admitted_evidence.extend(
        stages
            .iter()
            .map(|stage| CapitalEvidenceRef::Artifact(stage.artifact_sha256)),
    );
    CapitalCertificationContext::new(stages, admitted_evidence)
}

fn ledger() -> Result<CapitalCensusLedger, Box<dyn std::error::Error>> {
    let token = CapitalAsset::Token(address(20));
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
        ownership: CapitalOwnership::External,
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

fn artifact_dir(suffix: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "nqc-rmc011-offline-cli-{}-{suffix}",
        std::process::id()
    ))
}

fn write_bundle(directory: &Path) -> TestResult {
    let _ = fs::remove_dir_all(directory);
    fs::create_dir_all(directory)?;
    let bundle = export_capital_artifacts(
        &ledger()?,
        &authority()?,
        &ArtifactProvenance::new("2026-09-29T00:00:00Z", CODE_COMMIT, CODE_TREE)?,
    )?;
    for file in bundle.files {
        fs::write(directory.join(file.name), file.bytes)?;
    }
    Ok(())
}

const CODE_COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const CODE_TREE: &str = "89abcdef0123456789abcdef0123456789abcdef";

fn verifier_with_identity(
    directory: &Path,
    code_commit: &str,
    code_tree: &str,
) -> std::io::Result<std::process::Output> {
    Command::new(env!("CARGO_BIN_EXE_nqc-rmc011-capital-verify"))
        .arg("--dir")
        .arg(directory)
        .arg("--expected-code-commit")
        .arg(code_commit)
        .arg("--expected-code-tree")
        .arg(code_tree)
        .output()
}

fn verifier(directory: &Path) -> std::io::Result<std::process::Output> {
    verifier_with_identity(directory, CODE_COMMIT, CODE_TREE)
}

#[test]
fn offline_verifier_binary_accepts_exact_export() -> TestResult {
    let directory = artifact_dir("valid");
    write_bundle(&directory)?;
    let output = verifier(&directory)?;
    let _ = fs::remove_dir_all(&directory);

    assert!(
        output.status.success(),
        "offline verifier failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout)?;
    assert!(stdout.contains("RMC_011_OFFLINE_VERIFY=PASS"));
    assert!(stdout.contains("sources=1"));
    assert!(stdout.contains("requirements=1"));
    assert!(stdout.contains("feasible=1"));
    assert!(stdout.contains("rejected=0"));
    Ok(())
}

#[test]
fn offline_verifier_binary_rejects_tampered_artifact() -> TestResult {
    let directory = artifact_dir("tampered");
    write_bundle(&directory)?;

    let source_path = directory.join(CAPITAL_SOURCES_FILE);
    let mut bytes = fs::read(&source_path)?;
    let index = bytes
        .iter()
        .position(|byte| byte.is_ascii_hexdigit())
        .ok_or("capital source artifact contains no mutable hex digit")?;
    bytes[index] = if bytes[index] == b'0' { b'1' } else { b'0' };
    fs::write(&source_path, bytes)?;

    let output = verifier(&directory)?;
    let _ = fs::remove_dir_all(&directory);
    assert!(!output.status.success());
    Ok(())
}

#[test]
fn offline_verifier_binary_rejects_wrong_exact_code_identity() -> TestResult {
    let directory = artifact_dir("wrong-code-identity");
    write_bundle(&directory)?;
    let output = verifier_with_identity(
        &directory,
        "1123456789abcdef0123456789abcdef01234567",
        CODE_TREE,
    )?;
    let _ = fs::remove_dir_all(&directory);
    assert!(!output.status.success());
    Ok(())
}
