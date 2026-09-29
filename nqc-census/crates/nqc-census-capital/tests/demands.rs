use nqc_census_capital::{
    demands::{import_d09_borrower_demands, DemandBlockerReason},
    Amount256,
};
use nqc_census_core::{ChainDomain, Hash32, StateAnchor};

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

fn summary(status: &str, liquidatability_nonclaim: bool) -> Vec<u8> {
    let nonclaims = if liquidatability_nonclaim {
        "[\"LIQUIDATABILITY_NOT_CLAIMED\",\"PROFITABILITY_NOT_CLAIMED\"]"
    } else {
        "[\"PROFITABILITY_NOT_CLAIMED\"]"
    };
    format!(
        concat!(
            "{{\"all_tokens_conserved\":true,\"anchor\":{{\"hash\":\"{}\",\"number\":25437474}},",
            "\"blocking_findings\":[],\"non_claims\":{},\"status\":\"{}\",",
            "\"unexplained_mismatches\":0}}"
        ),
        anchor().block_hash().to_hex(),
        nonclaims,
        status
    )
    .into_bytes()
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
    assert!(imported.is_conserved());
    assert_eq!(
        imported.borrowers[0].blocker,
        Some(DemandBlockerReason::LiquidatabilityNotCertifiedByRmc009)
    );
    assert_eq!(
        imported.borrowers[0].debt_positions[0].balance,
        Amount256::from_u128(500)
    );
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
