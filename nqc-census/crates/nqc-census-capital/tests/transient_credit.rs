use nqc_census_capital::{
    transient_credit::{
        import_transient_credit_observation, transient_credit_facts_commitment,
        transient_credit_terms_commitment, TransientCreditRepaymentMode, TRANSIENT_CREDIT_FAMILY,
        TRANSIENT_CREDIT_SCHEMA_VERSION, TRANSIENT_CREDIT_STATUS,
    },
    Amount256, CapitalAsset, CapitalClass, CapitalError, CapitalOwnership, CapitalProviderKind,
    RepaymentSemantics,
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

fn observation(
    observed_anchor: &StateAnchor,
    active: bool,
    repayment: TransientCreditRepaymentMode,
    provider_b_facts: Option<Hash32>,
    provider_b_transcript: Option<Hash32>,
) -> Result<Vec<u8>, CapitalError> {
    let provider_identity = hash(20);
    let facility = address(21);
    let asset = CapitalAsset::Token(address(22));
    let facility_balance = amount(1_000);
    let credit_limit = amount(800);
    let outstanding = amount(125);
    let fee_bps = 125_u16;
    let utilization = 9_000_u16;
    let min_remaining = amount(50);
    let protocol_cap = Some(amount(700));
    let market_cap = Some(amount(650));

    let terms = transient_credit_terms_commitment(
        provider_identity,
        asset,
        fee_bps,
        repayment,
        utilization,
        min_remaining,
        protocol_cap,
        market_cap,
        active,
    )?;
    let facts = transient_credit_facts_commitment(
        observed_anchor,
        provider_identity,
        Some(facility),
        asset,
        terms,
        facility_balance,
        credit_limit,
        outstanding,
    )?;

    let (repayment_mode, deadline) = match repayment {
        TransientCreditRepaymentMode::SameBlock => ("SAME_BLOCK", 0_u64),
        TransientCreditRepaymentMode::DeadlineBlocks(blocks) => {
            ("DEADLINE_BLOCKS", u64::from(blocks))
        }
    };

    Json::object([
        (
            "schema_version",
            Json::uint(TRANSIENT_CREDIT_SCHEMA_VERSION),
        ),
        ("status", Json::string(TRANSIENT_CREDIT_STATUS)),
        ("provider_family", Json::string(TRANSIENT_CREDIT_FAMILY)),
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
        (
            "provider_identity",
            Json::string(provider_identity.to_hex()),
        ),
        ("facility_contract", Json::string(facility.to_hex())),
        ("asset", Json::string(asset.code())),
        ("facility_balance", amount_json(facility_balance)),
        ("credit_limit", amount_json(credit_limit)),
        ("outstanding", amount_json(outstanding)),
        ("fee_bps", Json::uint(u64::from(fee_bps))),
        ("repayment_mode", Json::string(repayment_mode)),
        ("repayment_deadline_blocks", Json::uint(deadline)),
        ("max_utilization_bps", Json::uint(u64::from(utilization))),
        ("min_remaining", amount_json(min_remaining)),
        (
            "protocol_cap",
            amount_json(protocol_cap.unwrap_or(Amount256::ZERO)),
        ),
        (
            "market_cap",
            amount_json(market_cap.unwrap_or(Amount256::ZERO)),
        ),
        ("active", Json::Bool(active)),
        ("terms_commitment", Json::string(terms.to_hex())),
        (
            "provider_observations",
            Json::array(vec![
                Json::object([
                    ("provider_id", Json::string("provider-a")),
                    ("facts_commitment", Json::string(facts.to_hex())),
                    ("transcript_sha256", Json::string(hash(40).to_hex())),
                ]),
                Json::object([
                    ("provider_id", Json::string("provider-b")),
                    (
                        "facts_commitment",
                        Json::string(provider_b_facts.unwrap_or(facts).to_hex()),
                    ),
                    (
                        "transcript_sha256",
                        Json::string(provider_b_transcript.unwrap_or(hash(41)).to_hex()),
                    ),
                ]),
            ]),
        ),
    ])
    .canonical()
    .map_err(|_| CapitalError::InvalidCanonical("test transient credit canonicalization"))
}

#[test]
fn imports_transient_credit_with_exact_capacity_and_terms() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(
        &observed_anchor,
        true,
        TransientCreditRepaymentMode::DeadlineBlocks(64),
        None,
        None,
    )?;
    let source = import_transient_credit_observation(&bytes, &observed_anchor)?;

    assert_eq!(source.class(), CapitalClass::TransientCredit);
    assert_eq!(
        source.provider_kind(),
        CapitalProviderKind::ExternalCreditFacility
    );
    assert_eq!(source.ownership(), CapitalOwnership::External);
    assert_eq!(source.asset(), CapitalAsset::Token(address(22)));
    assert_eq!(source.maximum_available(), amount(675));
    assert_eq!(source.repayment(), RepaymentSemantics::DeadlineBlocks(64));
    assert!(source.execution_eligible());
    assert_eq!(source.evidence().len(), 3);
    Ok(())
}

#[test]
fn imports_same_block_repayment_semantics() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(
        &observed_anchor,
        true,
        TransientCreditRepaymentMode::SameBlock,
        None,
        None,
    )?;
    let source = import_transient_credit_observation(&bytes, &observed_anchor)?;
    assert_eq!(source.repayment(), RepaymentSemantics::SameBlock);
    Ok(())
}

#[test]
fn rejects_anchor_substitution() -> TestResult {
    let expected = anchor();
    let other = StateAnchor::new(
        expected.chain().clone(),
        expected.block_number() + 1,
        hash(50),
        expected.block_hash(),
        expected.timestamp() + 12,
        hash(51),
    )?;
    let bytes = observation(
        &other,
        true,
        TransientCreditRepaymentMode::DeadlineBlocks(64),
        None,
        None,
    )?;
    assert!(matches!(
        import_transient_credit_observation(&bytes, &expected),
        Err(CapitalError::AnchorMismatch)
    ));
    Ok(())
}

#[test]
fn rejects_provider_semantic_divergence() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(
        &observed_anchor,
        true,
        TransientCreditRepaymentMode::DeadlineBlocks(64),
        Some(hash(90)),
        None,
    )?;
    assert!(matches!(
        import_transient_credit_observation(&bytes, &observed_anchor),
        Err(CapitalError::CanonicalDigestMismatch)
    ));
    Ok(())
}

#[test]
fn rejects_duplicate_provider_transcript() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(
        &observed_anchor,
        true,
        TransientCreditRepaymentMode::DeadlineBlocks(64),
        None,
        Some(hash(40)),
    )?;
    assert!(matches!(
        import_transient_credit_observation(&bytes, &observed_anchor),
        Err(CapitalError::InvalidCanonical(_))
    ));
    Ok(())
}

#[test]
fn inactive_facility_preserves_observation_but_blocks_execution() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(
        &observed_anchor,
        false,
        TransientCreditRepaymentMode::DeadlineBlocks(64),
        None,
        None,
    )?;
    let source = import_transient_credit_observation(&bytes, &observed_anchor)?;

    assert_eq!(source.maximum_available(), amount(675));
    assert_eq!(source.executable_capacity()?, Amount256::ZERO);
    assert_eq!(
        source.execution_blockers(),
        &["TRANSIENT_CREDIT_FACILITY_INACTIVE".to_owned()]
    );
    Ok(())
}
