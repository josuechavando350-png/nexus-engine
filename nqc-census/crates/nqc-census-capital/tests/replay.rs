use nqc_census_capital::{
    demands::import_d09_borrower_demands,
    replay::{
        verify_upstream_consumption_by_replay, D08ReplayInputs, D09ReplayInputs,
    },
    upstream::{import_d08_capital_sources, D08CapitalImportContext},
    CapitalCertificationContext, CapitalEvidenceRef, GitObjectId, UpstreamCensusStage,
    UpstreamConsumptionReceipt, UpstreamStageAuthority, UpstreamStageAuthoritySpec,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};

type TestResult = Result<(), Box<dyn std::error::Error>>;

const D08_CODE_COMMIT: &str = "1111111111111111111111111111111111111111";
const D08_CODE_TREE: &str = "2222222222222222222222222222222222222222";
const D09_CODE_COMMIT: &str = "3333333333333333333333333333333333333333";
const D09_CODE_TREE: &str = "4444444444444444444444444444444444444444";

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

fn sha256_hash(bytes: &[u8]) -> Hash32 {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    Hash32::new(digest).unwrap_or_else(|_| unreachable!())
}

fn sha256_plain(bytes: &[u8]) -> String {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn d08_fixture() -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
    let asset = address(20);
    let pool = address(90);
    let states = format!(
        "{{\"asset\":\"{}\",\"lifecycle\":\"CURRENT\",\"market_id\":\"m-aave\",\"protocol\":\"AAVE_V3\",\"protocol_facts\":{{\"active\":true,\"available_liquidity\":\"10000\",\"flash_loan_enabled\":true,\"paused\":false}},\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\"}}\n",
        asset.to_hex()
    )
    .into_bytes();
    let tokens = format!(
        "{{\"execution_compatibility\":{{\"blockers\":[],\"status\":\"PROVEN_COMPATIBLE\"}},\"token\":\"{}\"}}\n",
        asset.to_hex()
    )
    .into_bytes();
    let facts = format!(
        "{{\"aave_pool\":{{\"pool\":\"{}\",\"scalars\":{{\"FLASHLOAN_PREMIUM_TOTAL()\":{{\"data\":\"0x{}05\",\"status\":\"RETURNED\"}}}}}}}}",
        pool.to_hex(),
        "00".repeat(31),
    )
    .into_bytes();
    let manifest = format!(
        concat!(
            "{{\"artifacts\":[",
            "{{\"bytes\":{},\"path\":\"market-state-manifest.jsonl\",\"sha256\":\"{}\"}},",
            "{{\"bytes\":{},\"path\":\"token-admission.jsonl\",\"sha256\":\"{}\"}},",
            "{{\"bytes\":{},\"path\":\"pool-and-factory-facts.json\",\"sha256\":\"{}\"}}",
            "],\"code_commit\":\"{}\",\"code_tree\":\"{}\",\"schema_version\":1}}"
        ),
        states.len(),
        sha256_plain(&states),
        tokens.len(),
        sha256_plain(&tokens),
        facts.len(),
        sha256_plain(&facts),
        D08_CODE_COMMIT,
        D08_CODE_TREE,
    )
    .into_bytes();
    (states, tokens, facts, manifest)
}

fn d09_fixture() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let accounts = Vec::new();
    let summary = format!(
        concat!(
            "{{\"all_tokens_conserved\":true,\"anchor\":{{\"hash\":\"{}\",\"number\":25437474}},",
            "\"blocking_findings\":[],\"code_commit\":\"{}\",\"code_tree\":\"{}\",",
            "\"non_claims\":[\"LIQUIDATABILITY_NOT_CLAIMED\",\"PROFITABILITY_NOT_CLAIMED\",",
            "\"EXECUTION_NOT_CLAIMED\",\"ORACLE_FRESHNESS_NOT_ASSUMED\",\"POSITIONS_OUTSIDE_D06_NOT_CLAIMED\"],",
            "\"schema_version\":1,\"status\":\"RMC_009_PASS_CANDIDATE\",\"unexplained_mismatches\":0,",
            "\"uniswap_v2\":{{\"reason\":\"not applicable\",\"status\":\"NOT_APPLICABLE\"}}}}"
        ),
        anchor().block_hash().to_hex(),
        D09_CODE_COMMIT,
        D09_CODE_TREE,
    )
    .into_bytes();
    let manifest = format!(
        concat!(
            "{{\"artifacts\":[",
            "{{\"bytes\":{},\"path\":\"account-manifest.jsonl\",\"sha256\":\"{}\"}},",
            "{{\"bytes\":{},\"path\":\"account-summary.json\",\"sha256\":\"{}\"}}",
            "],\"code_commit\":\"{}\",\"code_tree\":\"{}\",\"schema_version\":1}}"
        ),
        accounts.len(),
        sha256_plain(&accounts),
        summary.len(),
        sha256_plain(&summary),
        D09_CODE_COMMIT,
        D09_CODE_TREE,
    )
    .into_bytes();
    (accounts, summary, manifest)
}

fn authority(
    stage: UpstreamCensusStage,
    artifact_sha256: Hash32,
    code_commit: &str,
    code_tree: &str,
) -> Result<UpstreamStageAuthority, nqc_census_capital::CapitalError> {
    UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
        stage,
        code_commit: GitObjectId::parse_hex(code_commit)?,
        code_tree: GitObjectId::parse_hex(code_tree)?,
        artifact_sha256,
        observation_anchor: anchor(),
        unresolved_mismatch_count: 0,
        unknown_failure_count: 0,
        coverage_complete: true,
        admitted: true,
    })
}

fn replay_context() -> Result<
    (
        CapitalCertificationContext,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
    ),
    Box<dyn std::error::Error>,
> {
    let (d08_states, d08_tokens, d08_facts, d08_manifest) = d08_fixture();
    let (d09_accounts, d09_summary, d09_manifest) = d09_fixture();
    let d08 = authority(
        UpstreamCensusStage::Rmc008StateAdmission,
        sha256_hash(&d08_manifest),
        D08_CODE_COMMIT,
        D08_CODE_TREE,
    )?;
    let d09 = authority(
        UpstreamCensusStage::Rmc009PositionUniverse,
        sha256_hash(&d09_manifest),
        D09_CODE_COMMIT,
        D09_CODE_TREE,
    )?;

    let d08_context = D08CapitalImportContext {
        anchor: anchor(),
        evidence: vec![CapitalEvidenceRef::Artifact(d08.artifact_sha256)],
    };
    let d08_import = import_d08_capital_sources(
        &d08_states,
        &d08_tokens,
        &d08_facts,
        &d08_manifest,
        &d08,
        &d08_context,
    )?;
    let d09_import =
        import_d09_borrower_demands(&d09_accounts, &d09_summary, &d09_manifest, &d09, &anchor())?;

    let mut stages = Vec::new();
    for stage in UpstreamCensusStage::ALL {
        let stage_authority = match stage {
            UpstreamCensusStage::Rmc008StateAdmission => d08.clone(),
            UpstreamCensusStage::Rmc009PositionUniverse => d09.clone(),
            _ => authority(
                stage,
                hash(100_u8.saturating_add(stage as u8)),
                "5555555555555555555555555555555555555555",
                "6666666666666666666666666666666666666666",
            )?,
        };
        stages.push(stage_authority);
    }
    let admitted_evidence = stages
        .iter()
        .map(|stage| CapitalEvidenceRef::Artifact(stage.artifact_sha256))
        .collect::<Vec<_>>();
    let context = CapitalCertificationContext::new(stages, admitted_evidence)?
        .with_consumption_receipts(vec![
            d08_import.consumption_receipt()?,
            d09_import.consumption_receipt()?,
        ])?;

    Ok((
        context,
        d08_states,
        d08_tokens,
        d08_facts,
        d08_manifest,
        d09_accounts,
        d09_summary,
        d09_manifest,
    ))
}

#[test]
fn exact_upstream_bytes_replay_to_committed_receipts() -> TestResult {
    let (
        context,
        d08_states,
        d08_tokens,
        d08_facts,
        d08_manifest,
        d09_accounts,
        d09_summary,
        d09_manifest,
    ) = replay_context()?;
    let verified = verify_upstream_consumption_by_replay(
        &context,
        D08ReplayInputs {
            state_manifest_jsonl: &d08_states,
            token_admission_jsonl: &d08_tokens,
            pool_and_factory_facts_json: &d08_facts,
            evidence_manifest_json: &d08_manifest,
        },
        D09ReplayInputs {
            account_manifest_jsonl: &d09_accounts,
            account_summary_json: &d09_summary,
            evidence_manifest_json: &d09_manifest,
        },
    )?;
    assert_eq!(verified.d08_source_count, 1);
    assert_eq!(verified.d09_requirement_count, 0);
    Ok(())
}

#[test]
fn upstream_replay_rejects_consumed_byte_substitution() -> TestResult {
    let (
        context,
        mut d08_states,
        d08_tokens,
        d08_facts,
        d08_manifest,
        d09_accounts,
        d09_summary,
        d09_manifest,
    ) = replay_context()?;
    let index = d08_states
        .windows(b"10000".len())
        .position(|window| window == b"10000")
        .ok_or("missing fixture amount")?;
    d08_states[index] = b'9';

    assert!(verify_upstream_consumption_by_replay(
        &context,
        D08ReplayInputs {
            state_manifest_jsonl: &d08_states,
            token_admission_jsonl: &d08_tokens,
            pool_and_factory_facts_json: &d08_facts,
            evidence_manifest_json: &d08_manifest,
        },
        D09ReplayInputs {
            account_manifest_jsonl: &d09_accounts,
            account_summary_json: &d09_summary,
            evidence_manifest_json: &d09_manifest,
        },
    )
    .is_err());
    Ok(())
}

#[test]
fn upstream_replay_rejects_forged_committed_output_set() -> TestResult {
    let (
        context,
        d08_states,
        d08_tokens,
        d08_facts,
        d08_manifest,
        d09_accounts,
        d09_summary,
        d09_manifest,
    ) = replay_context()?;
    let stages = context.stages().to_vec();
    let admitted_evidence = context.admitted_evidence().copied().collect::<Vec<_>>();
    let d08_authority = stages
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc008StateAdmission)
        .ok_or("missing D08 authority")?;
    let d09_receipt = context
        .consumption_receipts()
        .copied()
        .find(|receipt| receipt.stage() == UpstreamCensusStage::Rmc009PositionUniverse)
        .ok_or("missing D09 receipt")?;
    let forged = CapitalCertificationContext::new(stages, admitted_evidence)?
        .with_consumption_receipts(vec![
            UpstreamConsumptionReceipt::for_sources(
                d08_authority.artifact_sha256,
                hash(250),
                std::iter::empty(),
            )?,
            d09_receipt,
        ])?;

    assert!(verify_upstream_consumption_by_replay(
        &forged,
        D08ReplayInputs {
            state_manifest_jsonl: &d08_states,
            token_admission_jsonl: &d08_tokens,
            pool_and_factory_facts_json: &d08_facts,
            evidence_manifest_json: &d08_manifest,
        },
        D09ReplayInputs {
            account_manifest_jsonl: &d09_accounts,
            account_summary_json: &d09_summary,
            evidence_manifest_json: &d09_manifest,
        },
    )
    .is_err());
    Ok(())
}
