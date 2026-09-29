use nqc_census_capital::{
    adapters::{
        AaveV3FlashObservation, BalancerV2FlashObservation, AAVE_V3_PROVIDER_NAMESPACE,
        BALANCER_V2_PROVIDER_NAMESPACE,
    },
    Amount256, CapitalAsset, CapitalClass, CapitalEvidenceRef, CapitalError, RoundingMode,
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

#[test]
fn aave_v3_adapter_preserves_half_up_fee_semantics() -> TestResult {
    let asset = address(20);
    let source = AaveV3FlashObservation {
        anchor: anchor(),
        pool: address(21),
        asset,
        available_underlying: Amount256::from_u128(10_000),
        premium_total_bps: 5,
        flash_loan_enabled: true,
        provider_locator_hash: hash(22),
        evidence: evidence(),
    }
    .into_capital_source()?;

    assert_eq!(source.class(), CapitalClass::ProtocolNativeFlashLoan);
    assert_eq!(source.asset(), CapitalAsset::Token(asset));
    assert_eq!(source.effective_capacity()?, Amount256::from_u128(10_000));
    let quote = source
        .quote_fee(Amount256::from_u128(1_000))?
        .ok_or("missing Aave fee quote")?;
    assert_eq!(quote.amount, Amount256::from_u128(1));
    assert_eq!(AAVE_V3_PROVIDER_NAMESPACE, 0x1103);
    Ok(())
}

#[test]
fn aave_v3_disabled_flash_source_fails_closed() -> TestResult {
    let result = AaveV3FlashObservation {
        anchor: anchor(),
        pool: address(21),
        asset: address(20),
        available_underlying: Amount256::from_u128(10_000),
        premium_total_bps: 5,
        flash_loan_enabled: false,
        provider_locator_hash: hash(22),
        evidence: evidence(),
    }
    .into_capital_source();

    assert!(matches!(result, Err(CapitalError::NoCompatibleSource)));
    Ok(())
}

#[test]
fn balancer_v2_adapter_preserves_ceil_fee_semantics() -> TestResult {
    let asset = address(20);
    let source = BalancerV2FlashObservation {
        anchor: anchor(),
        vault: address(30),
        asset,
        available_vault_balance: Amount256::from_u128(100_000),
        fee_percentage_1e18: 1_000_000_000_000_000,
        provider_locator_hash: hash(31),
        evidence: evidence(),
    }
    .into_capital_source()?;

    assert_eq!(source.class(), CapitalClass::AtomicFlashLiquidity);
    assert_eq!(source.asset(), CapitalAsset::Token(asset));
    let quote = source
        .quote_fee(Amount256::from_u128(1_001))?
        .ok_or("missing Balancer fee quote")?;
    assert_eq!(quote.amount, Amount256::from_u128(2));
    assert_eq!(BALANCER_V2_PROVIDER_NAMESPACE, 0x1202);
    Ok(())
}

#[test]
fn adapters_require_real_evidence_references() -> TestResult {
    let result = BalancerV2FlashObservation {
        anchor: anchor(),
        vault: address(30),
        asset: address(20),
        available_vault_balance: Amount256::from_u128(100_000),
        fee_percentage_1e18: 0,
        provider_locator_hash: hash(31),
        evidence: Vec::new(),
    }
    .into_capital_source();

    assert!(matches!(result, Err(CapitalError::MissingEvidence)));
    Ok(())
}

#[test]
fn adapter_records_roundtrip_through_generic_capital_source() -> TestResult {
    let source = AaveV3FlashObservation {
        anchor: anchor(),
        pool: address(21),
        asset: address(20),
        available_underlying: Amount256::from_u128(10_000),
        premium_total_bps: 5,
        flash_loan_enabled: true,
        provider_locator_hash: hash(22),
        evidence: evidence(),
    }
    .into_capital_source()?;

    let encoded = source.canonical_encode();
    let decoded = nqc_census_capital::CapitalSource::decode_canonical(&encoded)?;
    assert_eq!(source, decoded);

    // Keep the protocol-specific rounding mode part of the canonical source identity.
    let floor = nqc_census_capital::FeeModel::basis_points_with_rounding(5, RoundingMode::Floor)?;
    assert_ne!(source.fee_model(), floor);
    Ok(())
}
