use nqc_census_capital::{
    gas_credit::{
        external_gas_credit_facts_commitment, external_gas_credit_terms_commitment,
        import_external_gas_credit_observation, EXTERNAL_GAS_CREDIT_FAMILY,
        EXTERNAL_GAS_CREDIT_STATUS,
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

fn observation_with_active(
    observed_anchor: &StateAnchor,
    outstanding: Amount256,
    provider_b_facts: Option<Hash32>,
    declared_terms_override: Option<Hash32>,
    active: bool,
) -> Result<Vec<u8>, CapitalError> {
    let facility = address(10);
    let borrower = address(11);
    let lender = address(12);
    let runtime = hash(13);
    let fee_bps = 100_u16;
    let deadline = 64_u32;
    let utilization = 8_000_u16;
    let min_remaining = amount(100);
    let protocol_cap = Some(amount(750));
    let market_cap = Some(amount(700));
    let balance = amount(1_000);
    let limit = amount(900);

    let terms = external_gas_credit_terms_commitment(
        borrower,
        lender,
        fee_bps,
        deadline,
        utilization,
        min_remaining,
        protocol_cap,
        market_cap,
        active,
    )?;
    let facts = external_gas_credit_facts_commitment(
        observed_anchor,
        facility,
        borrower,
        lender,
        runtime,
        terms,
        balance,
        limit,
        outstanding,
    )?;

    let row = Json::object([
        ("schema_version", Json::uint(1)),
        ("status", Json::string(EXTERNAL_GAS_CREDIT_STATUS)),
        ("provider_family", Json::string(EXTERNAL_GAS_CREDIT_FAMILY)),
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
        ("facility_contract", Json::string(facility.to_hex())),
        ("borrower", Json::string(borrower.to_hex())),
        ("lender", Json::string(lender.to_hex())),
        ("facility_runtime_sha256", Json::string(runtime.to_hex())),
        (
            "terms_commitment",
            Json::string(declared_terms_override.unwrap_or(terms).to_hex()),
        ),
        ("facility_balance_native", amount_json(balance)),
        ("credit_limit_native", amount_json(limit)),
        ("outstanding_native", amount_json(outstanding)),
        ("fee_bps", Json::uint(u64::from(fee_bps))),
        ("repayment_deadline_blocks", Json::uint(u64::from(deadline))),
        ("max_utilization_bps", Json::uint(u64::from(utilization))),
        ("min_remaining_native_gas", amount_json(min_remaining)),
        ("protocol_cap", protocol_cap.map_or(Json::Null, amount_json)),
        ("market_cap", market_cap.map_or(Json::Null, amount_json)),
        ("active", Json::Bool(active)),
        (
            "provider_observations",
            Json::array([
                Json::object([
                    ("provider_id", Json::string("blastapi-public")),
                    ("facts_commitment", Json::string(facts.to_hex())),
                    ("transcript_sha256", Json::string(hash(20).to_hex())),
                ]),
                Json::object([
                    ("provider_id", Json::string("mevblocker-rpc")),
                    (
                        "facts_commitment",
                        Json::string(provider_b_facts.unwrap_or(facts).to_hex()),
                    ),
                    ("transcript_sha256", Json::string(hash(21).to_hex())),
                ]),
            ]),
        ),
    ]);
    row.canonical()
        .map_err(|_| CapitalError::InvalidCanonical("test observation canonicalization"))
}

fn observation(
    observed_anchor: &StateAnchor,
    outstanding: Amount256,
    provider_b_facts: Option<Hash32>,
    declared_terms_override: Option<Hash32>,
) -> Result<Vec<u8>, CapitalError> {
    observation_with_active(
        observed_anchor,
        outstanding,
        provider_b_facts,
        declared_terms_override,
        true,
    )
}

#[test]
fn active_state_changes_observation_id_but_not_stable_source_key() -> TestResult {
    let anchor = anchor();
    let active = import_external_gas_credit_observation(
        &observation_with_active(&anchor, amount(100), None, None, true)?,
        &anchor,
    )?;
    let inactive = import_external_gas_credit_observation(
        &observation_with_active(&anchor, amount(100), None, None, false)?,
        &anchor,
    )?;

    assert_eq!(active.key_id(), inactive.key_id());
    assert_ne!(active.id(), inactive.id());
    assert!(active.execution_eligible());
    assert!(!inactive.execution_eligible());
    assert_eq!(inactive.executable_capacity()?, Amount256::ZERO);
    Ok(())
}

#[test]
fn exact_two_provider_gas_credit_imports_as_external_native_gas() -> TestResult {
    let anchor = anchor();
    let bytes = observation(&anchor, amount(100), None, None)?;
    let source = import_external_gas_credit_observation(&bytes, &anchor)?;

    assert_eq!(source.class(), CapitalClass::GasFunding);
    assert_eq!(source.asset(), CapitalAsset::NativeGas);
    assert_eq!(source.ownership(), CapitalOwnership::External);
    assert_eq!(
        source.provider_kind(),
        CapitalProviderKind::ExternalCreditFacility
    );
    assert_eq!(source.maximum_available(), amount(800));
    assert_eq!(source.effective_capacity()?, amount(640));
    assert_eq!(source.executable_capacity()?, amount(640));
    assert_eq!(source.repayment(), RepaymentSemantics::DeadlineBlocks(64));

    let fee = source
        .quote_fee(amount(100))?
        .ok_or("missing gas-credit fee quote")?;
    assert_eq!(fee.asset, CapitalAsset::NativeGas);
    assert_eq!(fee.amount, amount(1));
    Ok(())
}

#[test]
fn one_wei_state_drift_cannot_reuse_old_provider_facts_commitment() -> TestResult {
    let anchor = anchor();
    let old_bytes = observation(&anchor, amount(100), None, None)?;
    let old_source = import_external_gas_credit_observation(&old_bytes, &anchor)?;

    let old_facts = {
        let row = Json::parse(&old_bytes)?;
        let providers = row
            .get("provider_observations")
            .and_then(Json::as_array)
            .ok_or("missing provider observations")?;
        Hash32::parse_hex(
            providers[0]
                .get("facts_commitment")
                .and_then(Json::as_str)
                .ok_or("missing facts commitment")?,
        )?
    };

    let drifted = observation(&anchor, amount(101), Some(old_facts), None)?;
    assert!(matches!(
        import_external_gas_credit_observation(&drifted, &anchor),
        Err(CapitalError::CanonicalDigestMismatch)
    ));
    assert_eq!(old_source.maximum_available(), amount(800));
    Ok(())
}

#[test]
fn provider_disagreement_fails_closed() -> TestResult {
    let anchor = anchor();
    let bytes = observation(&anchor, amount(100), Some(hash(88)), None)?;
    assert!(matches!(
        import_external_gas_credit_observation(&bytes, &anchor),
        Err(CapitalError::CanonicalDigestMismatch)
    ));
    Ok(())
}

#[test]
fn forged_terms_commitment_fails_closed() -> TestResult {
    let anchor = anchor();
    let bytes = observation(&anchor, amount(100), None, Some(hash(89)))?;
    assert!(matches!(
        import_external_gas_credit_observation(&bytes, &anchor),
        Err(CapitalError::CanonicalDigestMismatch)
    ));
    Ok(())
}

#[test]
fn foreign_anchor_and_noncanonical_bytes_fail_closed() -> TestResult {
    let anchor = anchor();
    let bytes = observation(&anchor, amount(100), None, None)?;
    let foreign = StateAnchor::new(
        anchor.chain().clone(),
        anchor.block_number() + 1,
        hash(31),
        anchor.block_hash(),
        anchor.timestamp() + 12,
        hash(32),
    )?;
    assert!(matches!(
        import_external_gas_credit_observation(&bytes, &foreign),
        Err(CapitalError::AnchorMismatch)
    ));

    let mut noncanonical = bytes.clone();
    noncanonical.push(b'\n');
    assert!(matches!(
        import_external_gas_credit_observation(&noncanonical, &anchor),
        Err(CapitalError::InvalidCanonical(_))
    ));
    Ok(())
}
