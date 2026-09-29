use nqc_census_capital::{
    upstream::{import_d08_capital_sources, CapitalImportRejectionReason, D08CapitalImportContext},
    Amount256, CapitalAsset, CapitalClass, CapitalEvidenceRef,
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

fn context() -> D08CapitalImportContext {
    D08CapitalImportContext {
        anchor: anchor(),
        aave_pool: address(90),
        aave_premium_total_bps: 5,
        aave_provider_locator_hash: hash(91),
        uniswap_v2_provider_locator_hash: hash(92),
        evidence: vec![
            CapitalEvidenceRef::Artifact(hash(93)),
            CapitalEvidenceRef::Artifact(hash(94)),
        ],
    }
}

fn token_row(token: Address, compatible: bool) -> String {
    format!(
        "{{\"execution_compatibility\":{{\"blockers\":{},\"status\":\"{}\"}},\"token\":\"{}\"}}",
        if compatible {
            "[]"
        } else {
            "[\"FEE_ON_TRANSFER_UNPROVEN\"]"
        },
        if compatible {
            "PROVEN_COMPATIBLE"
        } else {
            "BLOCKED"
        },
        token.to_hex()
    )
}

#[test]
fn amount256_decimal_parser_is_exact_and_rejects_overflow() -> TestResult {
    assert_eq!(Amount256::parse_decimal("0")?, Amount256::ZERO);
    assert_eq!(Amount256::parse_decimal("10")?, Amount256::from_u128(10));
    assert!(Amount256::parse_decimal("").is_err());
    assert!(Amount256::parse_decimal("01").is_err());
    assert!(Amount256::parse_decimal("-1").is_err());
    assert!(Amount256::parse_decimal(
        "115792089237316195423570985008687907853269984665640564039457584007913129639936"
    )
    .is_err());
    assert_eq!(
        Amount256::parse_decimal(
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        )?,
        Amount256::MAX
    );
    Ok(())
}

#[test]
fn d08_import_builds_aave_and_v2_sources_only_for_proven_compatible_tokens() -> TestResult {
    let aave_asset = address(20);
    let token0 = address(30);
    let token1 = address(31);
    let pair = address(32);
    let tokens = format!(
        "{}\n{}\n{}\n",
        token_row(aave_asset, true),
        token_row(token0, true),
        token_row(token1, true)
    );
    let states = format!(
        concat!(
            "{{\"asset\":\"{}\",\"lifecycle\":\"CURRENT\",\"market_id\":\"m-aave\",",
            "\"protocol\":\"AAVE_V3\",\"protocol_facts\":{{\"active\":true,\"available_liquidity\":\"10000\",",
            "\"flash_loan_enabled\":true,\"paused\":false}},\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\"}}\n",
            "{{\"factory_membership\":true,\"fee_semantics\":{{\"basis\":\"EXPLICIT_CONFIGURATION_BOUND_TO_ADMITTED_PAIR_RUNTIME\",\"protocol_fee_enabled\":false,\"swap_fee_bps\":30}},",
            "\"liquidity_state\":\"LIQUID\",\"market_id\":\"m-v2\",\"pair\":\"{}\",\"protocol\":\"UNISWAP_V2\",",
            "\"reserves\":[\"5000\",\"7000\",1],\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\",\"token0\":\"{}\",\"token1\":\"{}\"}}\n"
        ),
        aave_asset.to_hex(),
        pair.to_hex(),
        token0.to_hex(),
        token1.to_hex()
    );

    let imported = import_d08_capital_sources(states.as_bytes(), tokens.as_bytes(), &context())?;
    assert_eq!(imported.sources.len(), 3);
    assert!(imported.rejections.is_empty());
    assert_eq!(imported.candidate_count, 3);
    assert_eq!(imported.admitted_count, 3);
    assert_eq!(imported.rejected_count, 0);
    assert!(imported.is_conserved());

    let mut classes = imported
        .sources
        .iter()
        .map(|source| source.class())
        .collect::<Vec<_>>();
    classes.sort();
    assert_eq!(
        classes,
        vec![
            CapitalClass::ProtocolNativeFlashLoan,
            CapitalClass::FlashSwap,
            CapitalClass::FlashSwap
        ]
    );
    Ok(())
}

#[test]
fn d08_import_fails_closed_on_unproven_token_compatibility() -> TestResult {
    let asset = address(20);
    let tokens = format!("{}\n", token_row(asset, false));
    let states = format!(
        concat!(
            "{{\"asset\":\"{}\",\"lifecycle\":\"CURRENT\",\"market_id\":\"m-aave\",",
            "\"protocol\":\"AAVE_V3\",\"protocol_facts\":{{\"active\":true,\"available_liquidity\":\"10000\",",
            "\"flash_loan_enabled\":true,\"paused\":false}},\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\"}}\n"
        ),
        asset.to_hex()
    );
    let imported = import_d08_capital_sources(states.as_bytes(), tokens.as_bytes(), &context())?;
    assert!(imported.sources.is_empty());
    assert_eq!(imported.rejections.len(), 1);
    assert_eq!(
        imported.rejections[0].reason,
        CapitalImportRejectionReason::TokenExecutionCompatibilityBlocked
    );
    Ok(())
}

#[test]
fn d08_import_preserves_zero_aave_capacity_but_rejects_disabled_flash() -> TestResult {
    let enabled = address(20);
    let disabled = address(21);
    let tokens = format!(
        "{}\n{}\n",
        token_row(enabled, true),
        token_row(disabled, true)
    );
    let states = format!(
        concat!(
            "{{\"asset\":\"{}\",\"lifecycle\":\"CURRENT\",\"market_id\":\"m0\",",
            "\"protocol\":\"AAVE_V3\",\"protocol_facts\":{{\"active\":true,\"available_liquidity\":\"0\",",
            "\"flash_loan_enabled\":true,\"paused\":false}},\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\"}}\n",
            "{{\"asset\":\"{}\",\"lifecycle\":\"CURRENT\",\"market_id\":\"m1\",",
            "\"protocol\":\"AAVE_V3\",\"protocol_facts\":{{\"active\":true,\"available_liquidity\":\"10\",",
            "\"flash_loan_enabled\":false,\"paused\":false}},\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\"}}\n"
        ),
        enabled.to_hex(),
        disabled.to_hex()
    );
    let imported = import_d08_capital_sources(states.as_bytes(), tokens.as_bytes(), &context())?;
    assert_eq!(imported.sources.len(), 1);
    assert_eq!(imported.sources[0].effective_capacity()?, Amount256::ZERO);
    assert_eq!(imported.rejections.len(), 1);
    assert_eq!(
        imported.rejections[0].reason,
        CapitalImportRejectionReason::FlashLoanDisabled
    );
    Ok(())
}

#[test]
fn d08_import_rejects_v2_reserve_without_strict_flash_swap_headroom() -> TestResult {
    let token0 = address(30);
    let token1 = address(31);
    let pair = address(32);
    let tokens = format!("{}\n{}\n", token_row(token0, true), token_row(token1, true));
    let states = format!(
        concat!(
            "{{\"factory_membership\":true,\"fee_semantics\":{{\"basis\":\"EXPLICIT_CONFIGURATION_BOUND_TO_ADMITTED_PAIR_RUNTIME\",\"protocol_fee_enabled\":false,\"swap_fee_bps\":30}},",
            "\"liquidity_state\":\"LIQUID\",\"market_id\":\"m-v2\",\"pair\":\"{}\",\"protocol\":\"UNISWAP_V2\",",
            "\"reserves\":[\"1\",\"2\",1],\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\",\"token0\":\"{}\",\"token1\":\"{}\"}}\n"
        ),
        pair.to_hex(),
        token0.to_hex(),
        token1.to_hex()
    );
    let imported = import_d08_capital_sources(states.as_bytes(), tokens.as_bytes(), &context())?;
    assert_eq!(imported.sources.len(), 1);
    assert_eq!(imported.rejections.len(), 1);
    assert_eq!(
        imported.rejections[0].reason,
        CapitalImportRejectionReason::FlashSwapReserveUnavailable
    );
    assert_eq!(imported.rejections[0].asset, CapitalAsset::Token(token0));
    Ok(())
}

#[test]
fn d08_import_requires_token_admission_row_for_every_source_asset() -> TestResult {
    let asset = address(20);
    let states = format!(
        concat!(
            "{{\"asset\":\"{}\",\"lifecycle\":\"CURRENT\",\"market_id\":\"m-aave\",",
            "\"protocol\":\"AAVE_V3\",\"protocol_facts\":{{\"active\":true,\"available_liquidity\":\"10000\",",
            "\"flash_loan_enabled\":true,\"paused\":false}},\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\"}}\n"
        ),
        asset.to_hex()
    );
    assert!(import_d08_capital_sources(states.as_bytes(), b"", &context()).is_err());
    Ok(())
}

#[test]
fn d08_import_coverage_is_order_independent_and_conserved() -> TestResult {
    let aave_asset = address(20);
    let token0 = address(30);
    let token1 = address(31);
    let pair = address(32);
    let tokens = format!(
        "{}\n{}\n{}\n",
        token_row(aave_asset, true),
        token_row(token0, true),
        token_row(token1, false)
    );
    let aave = format!(
        concat!(
            "{{\"asset\":\"{}\",\"lifecycle\":\"CURRENT\",\"market_id\":\"m-aave\",",
            "\"protocol\":\"AAVE_V3\",\"protocol_facts\":{{\"active\":true,\"available_liquidity\":\"10000\",",
            "\"flash_loan_enabled\":true,\"paused\":false}},\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\"}}"
        ),
        aave_asset.to_hex()
    );
    let v2 = format!(
        concat!(
            "{{\"factory_membership\":true,\"fee_semantics\":{{\"basis\":\"EXPLICIT_CONFIGURATION_BOUND_TO_ADMITTED_PAIR_RUNTIME\",\"protocol_fee_enabled\":false,\"swap_fee_bps\":30}},",
            "\"liquidity_state\":\"LIQUID\",\"market_id\":\"m-v2\",\"pair\":\"{}\",\"protocol\":\"UNISWAP_V2\",",
            "\"reserves\":[\"5000\",\"7000\",1],\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\",\"token0\":\"{}\",\"token1\":\"{}\"}}"
        ),
        pair.to_hex(),
        token0.to_hex(),
        token1.to_hex()
    );
    let first = format!("{aave}\n{v2}\n");
    let second = format!("{v2}\n{aave}\n");
    let a = import_d08_capital_sources(first.as_bytes(), tokens.as_bytes(), &context())?;
    let b = import_d08_capital_sources(second.as_bytes(), tokens.as_bytes(), &context())?;
    assert!(a.is_conserved());
    assert!(b.is_conserved());
    assert_eq!(a.candidate_count, 3);
    assert_eq!(a.admitted_count, 2);
    assert_eq!(a.rejected_count, 1);
    assert_eq!(a.coverage_commitment, b.coverage_commitment);
    Ok(())
}

#[test]
fn d08_import_rejects_duplicate_capital_candidates() -> TestResult {
    let asset = address(20);
    let tokens = format!("{}\n", token_row(asset, true));
    let row = format!(
        concat!(
            "{{\"asset\":\"{}\",\"lifecycle\":\"CURRENT\",\"market_id\":\"m-aave\",",
            "\"protocol\":\"AAVE_V3\",\"protocol_facts\":{{\"active\":true,\"available_liquidity\":\"10000\",",
            "\"flash_loan_enabled\":true,\"paused\":false}},\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\"}}"
        ),
        asset.to_hex()
    );
    let duplicate = format!("{row}\n{row}\n");
    assert!(
        import_d08_capital_sources(duplicate.as_bytes(), tokens.as_bytes(), &context()).is_err()
    );
    Ok(())
}

#[test]
fn current_d08_blocked_token_semantics_admit_no_capital_source() -> TestResult {
    let asset = address(20);
    let tokens = format!(
        "{{\"behavior\":{{\"fee_on_transfer\":\"UNPROVEN\",\"rebasing\":\"UNPROVEN\",\"transfer_hooks\":\"UNPROVEN\",\"upgradeable\":\"UNPROVEN\"}},\"execution_compatibility\":{{\"blockers\":[\"FEE_ON_TRANSFER_UNPROVEN\",\"REBASING_UNPROVEN\",\"TRANSFER_HOOKS_UNPROVEN\",\"UPGRADEABLE_UNPROVEN\"],\"status\":\"BLOCKED\"}},\"token\":\"{}\"}}\n",
        asset.to_hex()
    );
    let states = format!(
        "{{\"asset\":\"{}\",\"lifecycle\":\"CURRENT\",\"market_id\":\"m-aave\",\"protocol\":\"AAVE_V3\",\"protocol_facts\":{{\"active\":true,\"available_liquidity\":\"10000\",\"flash_loan_enabled\":true,\"paused\":false}},\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\"}}\n",
        asset.to_hex()
    );
    let imported = import_d08_capital_sources(states.as_bytes(), tokens.as_bytes(), &context())?;
    assert!(imported.sources.is_empty());
    assert_eq!(imported.rejected_count, 1);
    assert_eq!(
        imported.rejections[0].reason,
        CapitalImportRejectionReason::TokenExecutionCompatibilityBlocked
    );
    assert!(imported.is_conserved());
    Ok(())
}

#[test]
fn d08_import_rejects_noncanonical_fee_or_liquidity_semantics() -> TestResult {
    let token0 = address(30);
    let token1 = address(31);
    let pair = address(32);
    let tokens = format!("{}\n{}\n", token_row(token0, true), token_row(token1, true));
    let bad_fee = format!(
        "{{\"factory_membership\":true,\"fee_semantics\":{{\"basis\":\"EXPLICIT_CONFIGURATION_BOUND_TO_ADMITTED_PAIR_RUNTIME\",\"protocol_fee_enabled\":false,\"swap_fee_bps\":25}},\"liquidity_state\":\"LIQUID\",\"market_id\":\"m-v2\",\"pair\":\"{}\",\"protocol\":\"UNISWAP_V2\",\"reserves\":[\"5000\",\"7000\",1],\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\",\"token0\":\"{}\",\"token1\":\"{}\"}}\n",
        pair.to_hex(), token0.to_hex(), token1.to_hex()
    );
    let fee_import = import_d08_capital_sources(bad_fee.as_bytes(), tokens.as_bytes(), &context())?;
    assert_eq!(fee_import.sources.len(), 0);
    assert_eq!(fee_import.rejected_count, 2);
    assert!(fee_import
        .rejections
        .iter()
        .all(|row| row.reason == CapitalImportRejectionReason::FeeSemanticsUnsupported));

    let no_liquidity = bad_fee
        .replace("\"swap_fee_bps\":25", "\"swap_fee_bps\":30")
        .replace(
            "\"liquidity_state\":\"LIQUID\"",
            "\"liquidity_state\":\"ZERO_LIQUIDITY_NOT_ROUTABLE\"",
        );
    let liquidity_import =
        import_d08_capital_sources(no_liquidity.as_bytes(), tokens.as_bytes(), &context())?;
    assert_eq!(liquidity_import.sources.len(), 0);
    assert_eq!(liquidity_import.rejected_count, 2);
    assert!(liquidity_import
        .rejections
        .iter()
        .all(|row| row.reason == CapitalImportRejectionReason::V2LiquidityUnavailable));
    Ok(())
}

#[test]
fn d08_import_rejects_inactive_or_paused_aave_reserve() -> TestResult {
    let asset = address(20);
    let tokens = format!("{}\n", token_row(asset, true));
    for (active, paused) in [(false, false), (true, true)] {
        let states = format!(
            "{{\"asset\":\"{}\",\"lifecycle\":\"CURRENT\",\"market_id\":\"m-aave\",\"protocol\":\"AAVE_V3\",\"protocol_facts\":{{\"active\":{},\"available_liquidity\":\"10000\",\"flash_loan_enabled\":true,\"paused\":{}}},\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\"}}\n",
            asset.to_hex(), active, paused
        );
        let imported =
            import_d08_capital_sources(states.as_bytes(), tokens.as_bytes(), &context())?;
        assert_eq!(imported.sources.len(), 0);
        assert_eq!(
            imported.rejections[0].reason,
            CapitalImportRejectionReason::ReserveInactiveOrPaused
        );
    }
    Ok(())
}
