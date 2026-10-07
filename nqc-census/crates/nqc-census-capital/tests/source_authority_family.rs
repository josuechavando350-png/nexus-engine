use nqc_census_capital::{
    permissionless_atomic::{
        admit_balancer_v2_dual_provider, admit_uniswap_v3_dual_provider,
        BalancerV2AuthenticatedObservation, UniswapV3AuthenticatedObservation,
    },
    source_authority::{D11SourceAuthority, D11SourceFamily},
    Amount256,
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

fn balancer() -> Result<nqc_census_capital::CapitalSource, nqc_census_capital::CapitalError> {
    let observation = BalancerV2AuthenticatedObservation {
        anchor: anchor(),
        vault: address(10),
        asset: address(11),
        available_vault_balance: Amount256::from_u128(1_000),
        fee_percentage_1e18: 500_000_000_000_000,
        paused: false,
    };
    admit_balancer_v2_dual_provider(&observation, &observation, &hash(20), &hash(21))
}

fn uniswap_v3() -> Result<nqc_census_capital::CapitalSource, nqc_census_capital::CapitalError> {
    let observation = UniswapV3AuthenticatedObservation {
        anchor: anchor(),
        pool: address(12),
        asset: address(13),
        available_pool_balance: Amount256::from_u128(2_000),
        active_liquidity: Amount256::from_u128(2_000),
        fee_pips: 3_000,
    };
    admit_uniswap_v3_dual_provider(&observation, &observation, &hash(22), &hash(23))
}

#[test]
fn inferred_authority_binds_balancer_family() -> TestResult {
    let source = balancer()?;
    let authority = D11SourceAuthority::from_reconciliation_artifact(
        anchor(),
        b"balancer-artifact",
        &[source],
    )?;
    assert_eq!(authority.family(), D11SourceFamily::BalancerV2FlashLoan);
    Ok(())
}

#[test]
fn explicit_family_cannot_relabel_balancer_as_uniswap_v3() -> TestResult {
    let source = balancer()?;
    assert!(D11SourceAuthority::from_family_reconciliation_artifact(
        D11SourceFamily::UniswapV3Flash,
        anchor(),
        b"forged-family-artifact",
        &[source],
    )
    .is_err());
    Ok(())
}

#[test]
fn one_authority_cannot_mix_balancer_and_uniswap_v3() -> TestResult {
    let sources = vec![balancer()?, uniswap_v3()?];
    assert!(D11SourceAuthority::from_reconciliation_artifact(
        anchor(),
        b"mixed-family-artifact",
        &sources,
    )
    .is_err());
    Ok(())
}

#[test]
fn family_changes_authority_commitment() -> TestResult {
    let balancer = balancer()?;
    let uniswap = uniswap_v3()?;
    let first =
        D11SourceAuthority::from_reconciliation_artifact(anchor(), b"same-bytes", &[balancer])?;
    let second =
        D11SourceAuthority::from_reconciliation_artifact(anchor(), b"same-bytes", &[uniswap])?;
    assert_ne!(first.commitment(), second.commitment());
    Ok(())
}
