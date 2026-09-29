use nqc_census_capital::{
    demands::{
        import_d09_borrower_demands as import_d09_borrower_demands_bound, D09DemandImport,
        DemandBlockerReason,
    },
    Amount256, CapitalError, CapitalEvidenceRef, GitObjectId, UpstreamCensusStage,
    UpstreamStageAuthority, UpstreamStageAuthoritySpec,
};
use nqc_census_chain::hex;
use nqc_census_core::{ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Hash32 {
    Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
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

const D09_CODE_COMMIT: &str = "3333333333333333333333333333333333333333";
const D09_CODE_TREE: &str = "4444444444444444444444444444444444444444";

fn summary(status: &str, liquidatability_nonclaim: bool) -> Vec<u8> {
    let nonclaims = if liquidatability_nonclaim {
        "[\"LIQUIDATABILITY_NOT_CLAIMED\",\"PROFITABILITY_NOT_CLAIMED\",\"EXECUTION_NOT_CLAIMED\",\"ORACLE_FRESHNESS_NOT_ASSUMED\",\"POSITIONS_OUTSIDE_D06_NOT_CLAIMED\"]"
    } else {
        "[\"PROFITABILITY_NOT_CLAIMED\",\"EXECUTION_NOT_CLAIMED\"]"
    };
    format!(
        concat!(
            "{{\"all_tokens_conserved\":true,\"anchor\":{{\"hash\":\"{}\",\"number\":25437474}},",
            "\"blocking_findings\":[],\"code_commit\":\"{}\",\"code_tree\":\"{}\",",
            "\"non_claims\":{},\"schema_version\":1,\"status\":\"{}\",",
            "\"unexplained_mismatches\":0,\"uniswap_v2\":{{\"reason\":\"Uniswap V2 pairs carry no borrower, debt or collateral positions; no account universe is claimed or fabricated for them\",\"status\":\"NOT_APPLICABLE\"}}}}"
        ),
        anchor().block_hash().to_hex(),
        D09_CODE_COMMIT,
        D09_CODE_TREE,
        nonclaims,
        status
    )
    .into_bytes()
}

fn sha256_hash(bytes: &[u8]) -> Hash32 {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    Hash32::new(digest).unwrap_or_else(|_| unreachable!())
}

fn d09_evidence_manifest(accounts: &[u8], summary: &[u8]) -> Vec<u8> {
    let account_digest: [u8; 32] = Sha256::digest(accounts).into();
    let summary_digest: [u8; 32] = Sha256::digest(summary).into();
    format!(
        concat!(
            "{{\"artifacts\":[",
            "{{\"bytes\":{},\"path\":\"account-manifest.jsonl\",\"sha256\":\"{}\"}},",
            "{{\"bytes\":{},\"path\":\"account-summary.json\",\"sha256\":\"{}\"}}",
            "],\"code_commit\":\"{}\",\"code_tree\":\"{}\",\"schema_version\":1}}"
        ),
        accounts.len(),
        hex::plain(&account_digest),
        summary.len(),
        hex::plain(&summary_digest),
        D09_CODE_COMMIT,
        D09_CODE_TREE,
    )
    .into_bytes()
}

fn d09_authority(evidence_manifest: &[u8]) -> Result<UpstreamStageAuthority, CapitalError> {
    UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
        stage: UpstreamCensusStage::Rmc009PositionUniverse,
        code_commit: GitObjectId::parse_hex(D09_CODE_COMMIT)?,
        code_tree: GitObjectId::parse_hex(D09_CODE_TREE)?,
        artifact_sha256: sha256_hash(evidence_manifest),
        observation_anchor: anchor(),
        unresolved_mismatch_count: 0,
        unknown_failure_count: 0,
        coverage_complete: true,
        admitted: true,
    })
}

fn exact_account_fixture(account_manifest_jsonl: &[u8]) -> Vec<u8> {
    let input = String::from_utf8_lossy(account_manifest_jsonl);
    let mut out = String::new();
    for line in input.lines() {
        if line.is_empty() {
            continue;
        }
        if line.contains("\"configuration\":") {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let health = if line.contains("\"health_factor_below_one\":true") {
            "[\"0\",\"1\",\"0\",\"0\",\"0\",\"999999999999999999\"]"
        } else if line.contains("\"health_factor_below_one\":false") {
            "[\"0\",\"1\",\"0\",\"0\",\"0\",\"1000000000000000000\"]"
        } else {
            "{\"status\":\"HALTED\"}"
        };
        let prefix = line.strip_suffix('}').unwrap_or(line);
        out.push_str(prefix);
        out.push_str(&format!(
            ",\"configuration\":\"0\",\"emode\":\"0\",\"account_data\":{health},\"configuration_divergences\":[]}}\n"
        ));
    }
    out.into_bytes()
}

fn import_d09_borrower_demands(
    account_manifest_jsonl: &[u8],
    account_summary_json: &[u8],
    anchor: &StateAnchor,
) -> Result<D09DemandImport, CapitalError> {
    let account_manifest_jsonl = exact_account_fixture(account_manifest_jsonl);
    let evidence_manifest = d09_evidence_manifest(&account_manifest_jsonl, account_summary_json);
    let authority = d09_authority(&evidence_manifest)?;
    import_d09_borrower_demands_bound(
        &account_manifest_jsonl,
        account_summary_json,
        &evidence_manifest,
        &authority,
        anchor,
    )
}

fn position(asset_byte: u8, token_byte: u8, balance: &str) -> String {
    let address = |byte: u8| format!("0x{}", format!("{byte:02x}").repeat(20));
    format!(
        concat!(
            "{{\"asset\":\"{}\",\"balance\":\"{}\",\"market_id\":\"m{}\",",
            "\"scaled\":\"{}\",\"token\":\"{}\"}}"
        ),
        address(asset_byte),
        balance,
        asset_byte,
        balance,
        address(token_byte)
    )
}

#[test]
fn below_one_borrower_is_imported_but_not_promoted_to_capital_requirement() -> TestResult {
    let account = format!("0x{}", "44".repeat(20));
    let manifest = format!(
        concat!(
            "{{\"account\":\"{}\",\"classification\":\"POSITION_HOLDER\",",
            "\"debt_positions\":[{}],\"health_factor_below_one\":true,",
            "\"supply_positions\":[{}]}}\n"
        ),
        account,
        position(20, 30, "500"),
        position(21, 31, "900")
    );
    let imported = import_d09_borrower_demands(
        manifest.as_bytes(),
        &summary("RMC_009_PASS_CANDIDATE", true),
        &anchor(),
    )?;
    assert_eq!(imported.borrowers.len(), 1);
    assert_eq!(imported.borrower_count, 1);
    assert_eq!(imported.below_one_count, 1);
    assert_eq!(imported.not_below_one_count, 0);
    assert_eq!(imported.unavailable_count, 0);
    assert_eq!(imported.blocked_count, 1);
    assert_eq!(imported.requirements_certified, 0);
    assert!(imported.requirements.is_empty());
    assert!(imported.is_conserved());
    assert_eq!(
        imported.borrowers[0].blocker,
        Some(DemandBlockerReason::LiquidatabilityNotCertifiedByRmc009)
    );
    assert_eq!(imported.borrowers[0].evidence.len(), 1);
    assert!(matches!(
        imported.borrowers[0].evidence[0],
        CapitalEvidenceRef::Artifact(_)
    ));
    assert_eq!(
        imported.borrowers[0].debt_positions[0].balance,
        Amount256::from_u128(500)
    );
    assert_eq!(
        imported.borrowers[0]
            .account_risk
            .as_ref()
            .ok_or("missing exact account risk")?
            .health_factor_wad,
        Amount256::from_u128(999_999_999_999_999_999)
    );
    assert_eq!(imported.borrowers[0].user_configuration, Amount256::ZERO);
    Ok(())
}

#[test]
fn borrower_with_unavailable_account_data_is_explicitly_blocked() -> TestResult {
    let account = format!("0x{}", "45".repeat(20));
    let manifest = format!(
        concat!(
            "{{\"account\":\"{}\",\"classification\":\"POSITION_HOLDER\",",
            "\"debt_positions\":[{}],\"health_factor_below_one\":null,",
            "\"supply_positions\":[]}}\n"
        ),
        account,
        position(20, 30, "1")
    );
    let imported = import_d09_borrower_demands(
        manifest.as_bytes(),
        &summary("RMC_009_PASS_CANDIDATE", true),
        &anchor(),
    )?;
    assert_eq!(
        imported.borrowers[0].blocker,
        Some(DemandBlockerReason::AccountDataUnavailable)
    );
    assert_eq!(imported.unavailable_count, 1);
    assert_eq!(imported.blocked_count, 1);
    assert!(imported.is_conserved());
    assert_eq!(imported.requirements_certified, 0);
    assert!(imported.requirements.is_empty());
    let receipt = imported.consumption_receipt()?;
    assert_eq!(receipt.stage(), UpstreamCensusStage::Rmc009PositionUniverse);
    assert_eq!(receipt.coverage_commitment(), imported.coverage_commitment);
    assert_eq!(receipt.output_count(), 0);
    Ok(())
}

#[test]
fn non_borrowers_are_not_capital_demand_candidates() -> TestResult {
    let account = format!("0x{}", "46".repeat(20));
    let manifest = format!(
        concat!(
            "{{\"account\":\"{}\",\"classification\":\"POSITION_HOLDER\",",
            "\"debt_positions\":[],\"health_factor_below_one\":null,",
            "\"supply_positions\":[{}]}}\n"
        ),
        account,
        position(21, 31, "900")
    );
    let imported = import_d09_borrower_demands(
        manifest.as_bytes(),
        &summary("RMC_009_PASS_CANDIDATE", true),
        &anchor(),
    )?;
    assert!(imported.borrowers.is_empty());
    Ok(())
}

#[test]
fn d09_import_refuses_non_pass_or_missing_liquidatability_boundary() -> TestResult {
    assert!(
        import_d09_borrower_demands(b"", &summary("RMC_009_BLOCKED", true), &anchor()).is_err()
    );
    assert!(
        import_d09_borrower_demands(b"", &summary("RMC_009_PASS_CANDIDATE", false), &anchor())
            .is_err()
    );
    Ok(())
}

#[test]
fn d09_import_refuses_wrong_anchor() -> TestResult {
    let other = StateAnchor::new(
        anchor().chain().clone(),
        25_437_475,
        hash(9),
        hash(3),
        1_700_000_001,
        hash(5),
    )
    .unwrap_or_else(|_| unreachable!());
    assert!(
        import_d09_borrower_demands(b"", &summary("RMC_009_PASS_CANDIDATE", true), &other).is_err()
    );
    Ok(())
}

#[test]
fn d09_import_rejects_duplicate_accounts_and_noncanonical_amounts() -> TestResult {
    let account = format!("0x{}", "47".repeat(20));
    let row = format!(
        concat!(
            "{{\"account\":\"{}\",\"classification\":\"POSITION_HOLDER\",",
            "\"debt_positions\":[{}],\"health_factor_below_one\":false,",
            "\"supply_positions\":[]}}"
        ),
        account,
        position(20, 30, "10")
    );
    let duplicate = format!("{row}\n{row}\n");
    assert!(import_d09_borrower_demands(
        duplicate.as_bytes(),
        &summary("RMC_009_PASS_CANDIDATE", true),
        &anchor()
    )
    .is_err());

    let bad = row.replace("\"balance\":\"10\"", "\"balance\":\"01\"");
    assert!(import_d09_borrower_demands(
        format!("{bad}\n").as_bytes(),
        &summary("RMC_009_PASS_CANDIDATE", true),
        &anchor()
    )
    .is_err());
    Ok(())
}

#[test]
fn healthy_borrower_is_explicitly_blocked_and_conserved() -> TestResult {
    let account = format!("0x{}", "48".repeat(20));
    let manifest = format!(
        concat!(
            "{{\"account\":\"{}\",\"classification\":\"POSITION_HOLDER\",",
            "\"debt_positions\":[{}],\"health_factor_below_one\":false,",
            "\"supply_positions\":[]}}\n"
        ),
        account,
        position(20, 30, "10")
    );
    let imported = import_d09_borrower_demands(
        manifest.as_bytes(),
        &summary("RMC_009_PASS_CANDIDATE", true),
        &anchor(),
    )?;
    assert_eq!(imported.borrower_count, 1);
    assert_eq!(imported.not_below_one_count, 1);
    assert_eq!(
        imported.borrowers[0].blocker,
        Some(DemandBlockerReason::HealthFactorNotBelowOne)
    );
    assert!(imported.is_conserved());
    Ok(())
}

#[test]
fn d09_demand_coverage_commitment_is_input_order_independent() -> TestResult {
    let account_a = format!("0x{}", "49".repeat(20));
    let account_b = format!("0x{}", "50".repeat(20));
    let row_a = format!(
        concat!(
            "{{\"account\":\"{}\",\"classification\":\"POSITION_HOLDER\",",
            "\"debt_positions\":[{}],\"health_factor_below_one\":true,",
            "\"supply_positions\":[]}}"
        ),
        account_a,
        position(20, 30, "10")
    );
    let row_b = format!(
        concat!(
            "{{\"account\":\"{}\",\"classification\":\"POSITION_HOLDER\",",
            "\"debt_positions\":[{}],\"health_factor_below_one\":null,",
            "\"supply_positions\":[]}}"
        ),
        account_b,
        position(21, 31, "20")
    );
    let first = format!("{row_a}\n{row_b}\n");
    let second = format!("{row_b}\n{row_a}\n");
    let a = import_d09_borrower_demands(
        first.as_bytes(),
        &summary("RMC_009_PASS_CANDIDATE", true),
        &anchor(),
    )?;
    let b = import_d09_borrower_demands(
        second.as_bytes(),
        &summary("RMC_009_PASS_CANDIDATE", true),
        &anchor(),
    )?;
    assert!(a.is_conserved());
    assert!(b.is_conserved());
    assert_eq!(a.borrower_count, 2);
    assert_eq!(a.below_one_count, 1);
    assert_eq!(a.unavailable_count, 1);
    assert_eq!(a.coverage_commitment, b.coverage_commitment);
    Ok(())
}

#[test]
fn d09_import_refuses_schema_or_v2_scope_drift() -> TestResult {
    let exact = String::from_utf8(summary("RMC_009_PASS_CANDIDATE", true))?;
    let wrong_schema = exact.replace("\"schema_version\":1", "\"schema_version\":2");
    assert!(import_d09_borrower_demands(b"", wrong_schema.as_bytes(), &anchor()).is_err());

    let fabricated_v2 = exact.replace(
        "\"status\":\"NOT_APPLICABLE\"}}",
        "\"status\":\"APPLICABLE\"}}",
    );
    assert!(import_d09_borrower_demands(b"", fabricated_v2.as_bytes(), &anchor()).is_err());
    Ok(())
}

#[test]
fn d09_evidentiary_import_rejects_account_artifact_substitution() -> TestResult {
    let account = format!("0x{}", "51".repeat(20));
    let accounts = format!(
        concat!(
            "{{\"account\":\"{}\",\"classification\":\"POSITION_HOLDER\",",
            "\"debt_positions\":[{}],\"health_factor_below_one\":true,",
            "\"supply_positions\":[]}}\n"
        ),
        account,
        position(20, 30, "10")
    );
    let accounts = exact_account_fixture(accounts.as_bytes());
    let summary = summary("RMC_009_PASS_CANDIDATE", true);
    let evidence_manifest = d09_evidence_manifest(&accounts, &summary);
    let authority = d09_authority(&evidence_manifest)?;
    let tampered = String::from_utf8_lossy(&accounts).replace("\"10\"", "\"11\"");

    assert!(import_d09_borrower_demands_bound(
        tampered.as_bytes(),
        &summary,
        &evidence_manifest,
        &authority,
        &anchor(),
    )
    .is_err());
    Ok(())
}

#[test]
fn d09_evidentiary_import_rejects_manifest_not_named_by_authority() -> TestResult {
    let summary = summary("RMC_009_PASS_CANDIDATE", true);
    let evidence_manifest = d09_evidence_manifest(b"", &summary);
    let mut authority = d09_authority(&evidence_manifest)?;
    authority.artifact_sha256 = hash(252);

    assert!(import_d09_borrower_demands_bound(
        b"",
        &summary,
        &evidence_manifest,
        &authority,
        &anchor(),
    )
    .is_err());
    Ok(())
}
