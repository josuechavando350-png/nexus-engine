use nqc_census_capital::{
    gas_sponsor::{
        external_gas_sponsor_facts_commitment, external_gas_sponsor_terms_commitment,
        import_external_gas_sponsor_observation, EXTERNAL_GAS_SPONSOR_DELIVERY_SEMANTICS,
        EXTERNAL_GAS_SPONSOR_FAMILY, EXTERNAL_GAS_SPONSOR_SCHEMA_VERSION,
        EXTERNAL_GAS_SPONSOR_STATUS,
    },
    Amount256, CapitalAsset, CapitalClass, CapitalError, CapitalOwnership, CapitalProviderKind,
    FeeModel, RepaymentSemantics,
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
    maximum_native_gas: Amount256,
    active: bool,
    provider_b_facts: Option<Hash32>,
    provider_b_transcript: Option<Hash32>,
) -> Result<Vec<u8>, CapitalError> {
    let sponsor_identity = hash(8);
    let sponsor_contract = address(9);
    let fee_token = address(10);
    let fee_asset = CapitalAsset::Token(fee_token);
    let fee_amount = amount(7);
    let fee_model = FeeModel::Fixed {
        asset: fee_asset,
        amount: fee_amount,
    };
    let delivery_route = hash(30);
    let terms = external_gas_sponsor_terms_commitment(
        sponsor_identity,
        fee_model,
        fee_asset,
        delivery_route,
        false,
    )?;
    let facts = external_gas_sponsor_facts_commitment(
        observed_anchor,
        sponsor_identity,
        Some(sponsor_contract),
        terms,
        maximum_native_gas,
        active,
    )?;
    let provider_b_facts = provider_b_facts.unwrap_or(facts);
    let provider_a_transcript = hash(40);
    let provider_b_transcript = provider_b_transcript.unwrap_or(hash(41));

    Json::object([
        (
            "schema_version",
            Json::uint(EXTERNAL_GAS_SPONSOR_SCHEMA_VERSION),
        ),
        ("status", Json::string(EXTERNAL_GAS_SPONSOR_STATUS)),
        ("provider_family", Json::string(EXTERNAL_GAS_SPONSOR_FAMILY)),
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
        ("sponsor_identity", Json::string(sponsor_identity.to_hex())),
        ("sponsor_contract", Json::string(sponsor_contract.to_hex())),
        ("maximum_native_gas", amount_json(maximum_native_gas)),
        ("fee_kind", Json::string("FIXED")),
        (
            "fee_asset",
            Json::string(format!("TOKEN:{}", fee_token.to_hex())),
        ),
        ("fee_amount", amount_json(fee_amount)),
        (
            "delivery_semantics",
            Json::string(EXTERNAL_GAS_SPONSOR_DELIVERY_SEMANTICS),
        ),
        (
            "delivery_route_commitment",
            Json::string(delivery_route.to_hex()),
        ),
        ("operator_prefund_required", Json::Bool(false)),
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
    .map_err(|_| CapitalError::InvalidCanonical("test sponsor canonicalization"))
}

#[test]
fn imports_authenticated_external_gas_sponsor() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(&observed_anchor, amount(1_000), true, None, None)?;
    let source = import_external_gas_sponsor_observation(&bytes, &observed_anchor)?;

    assert_eq!(source.class(), CapitalClass::GasFunding);
    assert_eq!(source.provider_kind(), CapitalProviderKind::ExternalSponsor);
    assert_eq!(source.ownership(), CapitalOwnership::External);
    assert_eq!(source.asset(), CapitalAsset::NativeGas);
    assert_eq!(source.maximum_available(), amount(1_000));
    assert_eq!(source.effective_capacity()?, amount(1_000));
    assert_eq!(source.executable_capacity()?, amount(1_000));
    assert_eq!(source.repayment(), RepaymentSemantics::NoRepayment);
    assert!(source.execution_eligible());
    assert_eq!(source.evidence().len(), 3);

    let quote = source
        .quote_fee(amount(500))?
        .ok_or("fixed sponsor fee missing")?;
    assert_eq!(quote.asset, CapitalAsset::Token(address(10)));
    assert_eq!(quote.amount, amount(7));
    Ok(())
}

#[test]
fn rejects_anchor_substitution() -> TestResult {
    let expected = anchor();
    let other = StateAnchor::new(
        expected.chain().clone(),
        expected.block_number() + 1,
        hash(13),
        expected.block_hash(),
        expected.timestamp() + 12,
        hash(14),
    )?;
    let bytes = observation(&other, amount(1_000), true, None, None)?;
    assert!(matches!(
        import_external_gas_sponsor_observation(&bytes, &expected),
        Err(CapitalError::AnchorMismatch)
    ));
    Ok(())
}

#[test]
fn rejects_provider_semantic_divergence() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(&observed_anchor, amount(1_000), true, Some(hash(90)), None)?;
    assert!(matches!(
        import_external_gas_sponsor_observation(&bytes, &observed_anchor),
        Err(CapitalError::CanonicalDigestMismatch)
    ));
    Ok(())
}

#[test]
fn rejects_duplicate_provider_transcript() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(&observed_anchor, amount(1_000), true, None, Some(hash(40)))?;
    assert!(matches!(
        import_external_gas_sponsor_observation(&bytes, &observed_anchor),
        Err(CapitalError::InvalidCanonical(_))
    ));
    Ok(())
}

#[test]
fn inactive_sponsor_preserves_observation_but_is_not_executable() -> TestResult {
    let observed_anchor = anchor();
    let bytes = observation(&observed_anchor, amount(1_000), false, None, None)?;
    let source = import_external_gas_sponsor_observation(&bytes, &observed_anchor)?;

    assert_eq!(source.maximum_available(), amount(1_000));
    assert_eq!(source.effective_capacity()?, amount(1_000));
    assert_eq!(source.executable_capacity()?, Amount256::ZERO);
    assert_eq!(
        source.execution_blockers(),
        &["GAS_SPONSOR_INACTIVE".to_owned()]
    );
    Ok(())
}

#[test]
fn stable_source_key_does_not_rotate_with_observed_state() -> TestResult {
    let observed_anchor = anchor();
    let active = import_external_gas_sponsor_observation(
        &observation(&observed_anchor, amount(1_000), true, None, None)?,
        &observed_anchor,
    )?;
    let inactive = import_external_gas_sponsor_observation(
        &observation(&observed_anchor, amount(800), false, None, None)?,
        &observed_anchor,
    )?;

    assert_eq!(active.key_id(), inactive.key_id());
    assert_ne!(active.id(), inactive.id());
    Ok(())
}

#[test]
fn rejects_noncanonical_json_bytes() -> TestResult {
    let observed_anchor = anchor();
    let mut bytes = observation(&observed_anchor, amount(1_000), true, None, None)?;
    bytes.push(b'\n');
    assert!(matches!(
        import_external_gas_sponsor_observation(&bytes, &observed_anchor),
        Err(CapitalError::InvalidCanonical(_))
    ));
    Ok(())
}
