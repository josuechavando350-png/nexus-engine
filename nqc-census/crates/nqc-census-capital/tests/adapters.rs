use nqc_census_capital::{
    adapters::{
        AaveV3FlashObservation, BalancerV2FlashObservation, ExternalGasSponsorObservation,
        UniswapV2FlashSwapObservation, UniswapV3FlashObservation, AAVE_V3_PROVIDER_NAMESPACE,
        BALANCER_V2_PROVIDER_NAMESPACE, UNISWAP_V2_PROVIDER_NAMESPACE,
        UNISWAP_V3_PROVIDER_NAMESPACE,
    },
    Amount256, CapitalAsset, CapitalClass, CapitalError, CapitalEvidenceRef, RoundingMode,
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

#[test]
fn uniswap_v2_flash_swap_binds_strict_reserve_capacity_and_fee() -> TestResult {
    let asset = address(40);
    let source = UniswapV2FlashSwapObservation {
        anchor: anchor(),
        pair: address(41),
        asset,
        reserve: Amount256::from_u128(10_000),
        provider_locator_hash: hash(42),
        evidence: evidence(),
    }
    .into_capital_source()?;

    assert_eq!(source.class(), CapitalClass::FlashSwap);
    assert_eq!(source.asset(), CapitalAsset::Token(asset));
    assert_eq!(source.effective_capacity()?, Amount256::from_u128(9_999));

    let quote = source
        .quote_fee(Amount256::from_u128(997))?
        .ok_or("missing Uniswap V2 fee quote")?;
    assert_eq!(quote.amount, Amount256::from_u128(3));

    let rounded = source
        .quote_fee(Amount256::from_u128(1_000))?
        .ok_or("missing Uniswap V2 rounded fee quote")?;
    assert_eq!(rounded.amount, Amount256::from_u128(4));
    assert_eq!(UNISWAP_V2_PROVIDER_NAMESPACE, 0x1302);
    Ok(())
}

#[test]
fn uniswap_v2_flash_swap_rejects_reserve_that_cannot_satisfy_strict_output_bound() -> TestResult {
    for reserve in [Amount256::ZERO, Amount256::from_u128(1)] {
        let result = UniswapV2FlashSwapObservation {
            anchor: anchor(),
            pair: address(41),
            asset: address(40),
            reserve,
            provider_locator_hash: hash(42),
            evidence: evidence(),
        }
        .into_capital_source();
        assert!(matches!(result, Err(CapitalError::NoCompatibleSource)));
    }
    Ok(())
}

#[test]
fn uniswap_v2_flash_swap_requires_evidence() -> TestResult {
    let result = UniswapV2FlashSwapObservation {
        anchor: anchor(),
        pair: address(41),
        asset: address(40),
        reserve: Amount256::from_u128(10_000),
        provider_locator_hash: hash(42),
        evidence: Vec::new(),
    }
    .into_capital_source();

    assert!(matches!(result, Err(CapitalError::MissingEvidence)));
    Ok(())
}

#[test]
fn external_gas_sponsor_is_non_operator_native_gas_capital() -> TestResult {
    let source = ExternalGasSponsorObservation {
        anchor: anchor(),
        provider_namespace: 0x2201,
        provider_locator_hash: hash(50),
        sponsor_contract: Some(address(51)),
        maximum_native_gas: Amount256::from_u128(1_000),
        fee_model: nqc_census_capital::FeeModel::None,
        fee_asset: CapitalAsset::NativeGas,
        evidence: evidence(),
    }
    .into_capital_source()?;

    assert_eq!(source.class(), CapitalClass::GasFunding);
    assert_eq!(source.asset(), CapitalAsset::NativeGas);
    assert_eq!(
        source.repayment(),
        nqc_census_capital::RepaymentSemantics::NoRepayment
    );
    assert_eq!(source.effective_capacity()?, Amount256::from_u128(1_000));
    assert!(source.quote_fee(Amount256::from_u128(100))?.is_none());
    Ok(())
}

#[test]
fn external_gas_sponsor_can_charge_evidence_bound_fee_without_principal_repayment() -> TestResult {
    let fee_asset = CapitalAsset::Token(address(52));
    let source = ExternalGasSponsorObservation {
        anchor: anchor(),
        provider_namespace: 0x2201,
        provider_locator_hash: hash(50),
        sponsor_contract: Some(address(51)),
        maximum_native_gas: Amount256::from_u128(1_000),
        fee_model: nqc_census_capital::FeeModel::Fixed {
            asset: fee_asset,
            amount: Amount256::from_u128(7),
        },
        fee_asset,
        evidence: evidence(),
    }
    .into_capital_source()?;

    let quote = source
        .quote_fee(Amount256::from_u128(100))?
        .ok_or("missing sponsor fee quote")?;
    assert_eq!(quote.asset, fee_asset);
    assert_eq!(quote.amount, Amount256::from_u128(7));
    Ok(())
}


#[test]
fn uniswap_v3_flash_binds_pool_balance_and_ceil_fee() -> TestResult {
    let asset = address(60);
    let source = UniswapV3FlashObservation {
        anchor: anchor(),
        pool: address(61),
        asset,
        available_pool_balance: Amount256::from_u128(1_000_000),
        fee_pips: 500,
        provider_locator_hash: hash(62),
        evidence: evidence(),
    }
    .into_capital_source()?;

    assert_eq!(source.class(), CapitalClass::AtomicFlashLiquidity);
    assert_eq!(source.asset(), CapitalAsset::Token(asset));
    assert_eq!(
        source.effective_capacity()?,
        Amount256::from_u128(1_000_000)
    );
    let exact = source
        .quote_fee(Amount256::from_u128(2_000))?
        .ok_or("missing Uniswap V3 fee quote")?;
    assert_eq!(exact.amount, Amount256::from_u128(1));

    let rounded = source
        .quote_fee(Amount256::from_u128(1))?
        .ok_or("missing Uniswap V3 rounded fee quote")?;
    assert_eq!(rounded.amount, Amount256::from_u128(1));
    assert_eq!(UNISWAP_V3_PROVIDER_NAMESPACE, 0x1303);
    Ok(())
}

#[test]
fn uniswap_v3_zero_balance_remains_an_observed_source() -> TestResult {
    let source = UniswapV3FlashObservation {
        anchor: anchor(),
        pool: address(61),
        asset: address(60),
        available_pool_balance: Amount256::ZERO,
        fee_pips: 3_000,
        provider_locator_hash: hash(62),
        evidence: evidence(),
    }
    .into_capital_source()?;

    assert_eq!(source.effective_capacity()?, Amount256::ZERO);
    Ok(())
}

#[test]
fn uniswap_v3_rejects_impossible_fee_scale() -> TestResult {
    let result = UniswapV3FlashObservation {
        anchor: anchor(),
        pool: address(61),
        asset: address(60),
        available_pool_balance: Amount256::from_u128(100),
        fee_pips: 1_000_001,
        provider_locator_hash: hash(62),
        evidence: evidence(),
    }
    .into_capital_source();

    assert!(matches!(result, Err(CapitalError::InvalidRatio)));
    Ok(())
}
