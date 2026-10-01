use nqc_census_capital::{
    external_debt::{
        external_debt_facts_commitment, external_debt_terms_commitment,
        import_external_debt_observation, ExternalDebtKind, EXTERNAL_DEBT_FAMILY,
        EXTERNAL_DEBT_SCHEMA_VERSION, EXTERNAL_DEBT_STATUS,
    },
    Amount256, CapitalAsset, CapitalClass, CapitalError, CapitalOwnership, CapitalProviderKind,
    CollateralRequirement, PersistentDebtTerms, RepaymentSemantics,
};
use nqc_census_chain::json::Json;
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

fn amount(value: u128) -> Amount256 {
    Amount256::from_u128(value)
}

fn amount_json(value: Amount256) -> Json {
    Json::string(format!("0x{}", value.to_hex()))
}

fn risk() -> PersistentDebtTerms {
    PersistentDebtTerms {
        interest_model_hash: hash(21),
        liquidation_model_hash: hash(22),
        solvency_model_hash: hash(23),
        oracle_risk_hash: hash(24),
        liquidity_withdrawal_risk_hash: hash(25),
        facility_disappearance_risk_hash: hash(26),
    }
}

fn observation(
    observed_anchor: &StateAnchor,
    kind: ExternalDebtKind,
    facility_balance: Amount256,
    credit_limit: Amount256,
    outstanding: Amount256,
    active: bool,
    provider_b_facts: Option<Hash32>,
    provider_b_transcript: Option<Hash32>,
) -> Result<Vec<u8>, CapitalError> {
    let provider_identity = hash(8);
    let facility_contract = address(9);
    let principal_token = address(10);
    let collateral_token = address(11);
    let principal_asset = CapitalAsset::Token(principal_token);
    let collateral_asset = CapitalAsset::Token(collateral_token);
    let collateral_amount = amount(600);
    let liquidation_conditions_hash = hash(27);
    let fee_bps = 125_u16;
    let max_utilization_bps = 8_500_u16;
    let min_remaining = amount(50);
    let protocol_cap = Some(amount(900));
    let market_cap = Some(amount(800));
    let risk = risk();

    let terms = external_debt_terms_commitment(
        kind,
        provider_identity,
        principal_asset,
        collateral_asset,
        collateral_amount,
        liquidation_conditions_hash,
        fee_bps,
        max_utilization_bps,
        min_remaining,
        protocol_cap,
        market_cap,
        risk,
        active,
    )?;
    let facts = external_debt_facts_commitment(
        observed_anchor,
        kind,
        provider_identity,
        Some(facility_contract),
        principal_asset,
        terms,
        facility_balance,
        credit_limit,
        outstanding,
    )?;

    let kind_text = match kind {
        ExternalDebtKind::CollateralizedBorrowing => "COLLATERALIZED_BORROWING",
        ExternalDebtKind::PersistentDebt => "PERSISTENT_DEBT",
    };
    let provider_a_transcript = hash(40);
    let provider_b_transcript = provider_b_transcript.unwrap_or(hash(41));
    let provider_b_facts = provider_b_facts.unwrap_or(facts);

    Json::object([
        ("schema_version", Json::uint(EXTERNAL_DEBT_SCHEMA_VERSION)),
        ("status", Json::string(EXTERNAL_DEBT_STATUS)),
        ("provider_family", Json::string(EXTERNAL_DEBT_FAMILY)),
        ("capital_ownership", Json::string("EXTERNAL")),
        (
            "observation_anchor",
            Json::object([
                ("chain_id", Json::uint(observed_anchor.chain().chain_id())),
                (
                    "genesis_hash",
                    Json::string(observed_anchor.chain().genesis_hash().to_hex()),
                ),
                (
                    "fork_lineage",
                    Json::string(observed_anchor.chain().fork_lineage().to_hex()),
                ),
                ("block_number", Json::uint(observed_anchor.block_number())),
                (
                    "block_hash",
                    Json::string(observed_anchor.block_hash().to_hex()),
                ),
                (
                    "parent_hash",
                    Json::string(observed_anchor.parent_hash().to_hex()),
                ),
                ("timestamp", Json::uint(observed_anchor.timestamp())),
                (
                    "state_root",
                    Json::string(observed_anchor.state_root().to_hex()),
                ),
            ]),
        ),
        ("debt_kind", Json::string(kind_text)),
        (
            "provider_identity",
            Json::string(provider_identity.to_hex()),
        ),
        (
            "facility_contract",
            Json::string(facility_contract.to_hex()),
        ),
        (
            "principal_asset",
            Json::string(format!("TOKEN:{}", principal_token.to_hex())),
        ),
        (
            "collateral_asset",
            Json::string(format!("TOKEN:{}", collateral_token.to_hex())),
        ),
        ("collateral_amount", amount_json(collateral_amount)),
        (
            "liquidation_conditions_hash",
            Json::string(liquidation_conditions_hash.to_hex()),
        ),
        ("facility_balance", amount_json(facility_balance)),
        ("credit_limit", amount_json(credit_limit)),
        ("outstanding", amount_json(outstanding)),
        ("fee_bps", Json::uint(u64::from(fee_bps))),
        (
            "max_utilization_bps",
            Json::uint(u64::from(max_utilization_bps)),
        ),
        ("min_remaining", amount_json(min_remaining)),
        ("protocol_cap", protocol_cap.map_or(Json::Null, amount_json)),
        ("market_cap", market_cap.map_or(Json::Null, amount_json)),
        (
            "interest_model_hash",
            Json::string(risk.interest_model_hash.to_hex()),
        ),
        (
            "liquidation_model_hash",
            Json::string(risk.liquidation_model_hash.to_hex()),
        ),
        (
            "solvency_model_hash",
            Json::string(risk.solvency_model_hash.to_hex()),
        ),
        (
            "oracle_risk_hash",
            Json::string(risk.oracle_risk_hash.to_hex()),
        ),
        (
            "liquidity_withdrawal_risk_hash",
            Json::string(risk.liquidity_withdrawal_risk_hash.to_hex()),
        ),
        (
            "facility_disappearance_risk_hash",
            Json::string(risk.facility_disappearance_risk_hash.to_hex()),
        ),
        ("active", Json::Bool(active)),
        ("terms_commitment", Json::string(terms.to_hex())),
        (
            "provider_observations",
            Json::array(vec![
                Json::object([
                    ("provider_id", Json::string("provider-a")),
                    ("facts_commitment", Json::string(facts.to_hex())),
                    (
                        "transcript_sha256",
                        Json::string(provider_a_transcript.to_hex()),
                    ),
                ]),
                Json::object([
                    ("provider_id", Json::string("provider-b")),
                    ("facts_commitment", Json::string(provider_b_facts.to_hex())),
                    (
                        "transcript_sha256",
                        Json::string(provider_b_transcript.to_hex()),
                    ),
                ]),
            ]),
        ),
    ])
    .canonical()
    .map_err(|_| CapitalError::InvalidCanonical("test external debt canonicalization"))
}

fn assert_common_source(
    source: &nqc_census_capital::CapitalSource,
    expected_class: CapitalClass,
) -> TestResult {
    assert_eq!(source.class(), expected_class);
    assert_eq!(
        source.provider_kind(),
        CapitalProviderKind::ExternalCreditFacility
    );
    assert_eq!(source.ownership(), CapitalOwnership::External);
    assert_eq!(source.asset(), CapitalAsset::Token(address(10)));
    assert!(matches!(
        source.repayment(),
        RepaymentSemantics::Persistent(_)
    ));
    assert!(matches!(
        source.collateral(),
        CollateralRequirement::Required {
            asset,
            amount: collateral,
            ..
        } if asset == CapitalAsset::Token(address(11)) && collateral == amount(600)
    ));
    assert_eq!(source.evidence().len(), 3);
    Ok(())
}

#[test]
fn imports_collateralized_borrowing() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(
        &observed_anchor,
        ExternalDebtKind::CollateralizedBorrowing,
        amount(1_000),
        amount(900),
        amount(100),
        true,
        None,
        None,
    )?;
    let source = import_external_debt_observation(&bytes, &observed_anchor)?;
    assert_common_source(&source, CapitalClass::CollateralizedBorrowing)?;
    assert_eq!(source.maximum_available(), amount(800));
    assert!(source.execution_eligible());
    Ok(())
}

#[test]
fn imports_persistent_debt() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(
        &observed_anchor,
        ExternalDebtKind::PersistentDebt,
        amount(1_000),
        amount(900),
        amount(100),
        true,
        None,
        None,
    )?;
    let source = import_external_debt_observation(&bytes, &observed_anchor)?;
    assert_common_source(&source, CapitalClass::PersistentDebt)?;
    assert_eq!(source.maximum_available(), amount(800));
    Ok(())
}

#[test]
fn rejects_anchor_substitution() -> TestResult {
    let expected = anchor();
    let other = StateAnchor::new(
        ChainDomain::new(1, hash(1), hash(2))?,
        expected.block_number() + 1,
        hash(13),
        expected.block_hash(),
        expected.timestamp() + 12,
        hash(14),
    )?;
    let bytes = observation(
        &other,
        ExternalDebtKind::PersistentDebt,
        amount(1_000),
        amount(900),
        amount(100),
        true,
        None,
        None,
    )?;
    assert!(matches!(
        import_external_debt_observation(&bytes, &expected),
        Err(CapitalError::AnchorMismatch)
    ));
    Ok(())
}

#[test]
fn rejects_provider_semantic_divergence() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(
        &observed_anchor,
        ExternalDebtKind::PersistentDebt,
        amount(1_000),
        amount(900),
        amount(100),
        true,
        Some(hash(90)),
        None,
    )?;
    assert!(matches!(
        import_external_debt_observation(&bytes, &observed_anchor),
        Err(CapitalError::CanonicalDigestMismatch)
    ));
    Ok(())
}

#[test]
fn rejects_duplicate_provider_transcript() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(
        &observed_anchor,
        ExternalDebtKind::PersistentDebt,
        amount(1_000),
        amount(900),
        amount(100),
        true,
        None,
        Some(hash(40)),
    )?;
    assert!(matches!(
        import_external_debt_observation(&bytes, &observed_anchor),
        Err(CapitalError::InvalidCanonical(_))
    ));
    Ok(())
}

#[test]
fn inactive_debt_preserves_observation_but_is_not_executable() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(
        &observed_anchor,
        ExternalDebtKind::PersistentDebt,
        amount(1_000),
        amount(900),
        amount(100),
        false,
        None,
        None,
    )?;
    let source = import_external_debt_observation(&bytes, &observed_anchor)?;

    assert_eq!(source.maximum_available(), amount(800));
    assert!(!source.execution_eligible());
    assert_eq!(source.executable_capacity()?, Amount256::ZERO);
    assert_eq!(
        source.execution_blockers(),
        &["PERSISTENT_DEBT_FACILITY_INACTIVE".to_owned()]
    );
    Ok(())
}

#[test]
fn stable_source_key_does_not_rotate_with_observed_state() -> TestResult {
    let observed_anchor = anchor();
    let first = import_external_debt_observation(
        &observation(
            &observed_anchor,
            ExternalDebtKind::PersistentDebt,
            amount(1_000),
            amount(900),
            amount(100),
            true,
            None,
            None,
        )?,
        &observed_anchor,
    )?;
    let second = import_external_debt_observation(
        &observation(
            &observed_anchor,
            ExternalDebtKind::PersistentDebt,
            amount(700),
            amount(900),
            amount(200),
            false,
            None,
            None,
        )?,
        &observed_anchor,
    )?;

    assert_eq!(first.key_id(), second.key_id());
    assert_ne!(first.id(), second.id());
    Ok(())
}
