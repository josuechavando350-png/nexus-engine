//! Admission boundary for D11 permissionless atomic-liquidity observations.
//!
//! Live RPC acquisition is intentionally outside this module. This code accepts
//! only two independently authenticated provider views and requires exact
//! agreement on every economic/state field before constructing a CapitalSource.
//! A successful admission therefore proves semantic reconciliation, not that a
//! live acquisition has already occurred.

use crate::{
    adapters::{
        BalancerV2FlashObservation, UniswapV3FlashObservation, BALANCER_V2_PROVIDER_NAMESPACE,
        UNISWAP_V3_PROVIDER_NAMESPACE,
    },
    Amount256, CapitalError, CapitalEvidenceRef, CapitalSource,
};
use nqc_census_core::{Address, Hash32, StateAnchor};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BalancerV2AuthenticatedObservation {
    pub anchor: StateAnchor,
    pub vault: Address,
    pub asset: Address,
    pub available_vault_balance: Amount256,
    pub fee_percentage_1e18: u64,
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UniswapV3AuthenticatedObservation {
    pub anchor: StateAnchor,
    pub pool: Address,
    pub asset: Address,
    pub available_pool_balance: Amount256,
    pub fee_pips: u32,
}

fn require_independent_evidence(
    first: &Hash32,
    second: &Hash32,
) -> Result<Vec<CapitalEvidenceRef>, CapitalError> {
    if first.as_bytes().iter().all(|byte| *byte == 0)
        || second.as_bytes().iter().all(|byte| *byte == 0)
    {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "permissionless atomic source transcript digest is zero",
        ));
    }
    if first == second {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "permissionless atomic source requires two independent transcript digests",
        ));
    }
    Ok(vec![
        CapitalEvidenceRef::Artifact(*first),
        CapitalEvidenceRef::Artifact(*second),
    ])
}

fn protocol_contract_locator_hash(
    provider_namespace: u16,
    source_contract: Address,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-PROTOCOL-CONTRACT-LOCATOR-V1");
    hasher.update([0]);
    hasher.update(provider_namespace.to_be_bytes());
    hasher.update(source_contract.as_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero protocol contract locator hash"))
}

pub fn admit_balancer_v2_dual_provider(
    first: &BalancerV2AuthenticatedObservation,
    second: &BalancerV2AuthenticatedObservation,
    first_transcript: &Hash32,
    second_transcript: &Hash32,
) -> Result<CapitalSource, CapitalError> {
    if first != second {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "Balancer V2 provider observations disagree",
        ));
    }
    let evidence = require_independent_evidence(first_transcript, second_transcript)?;
    BalancerV2FlashObservation {
        anchor: first.anchor.clone(),
        vault: first.vault,
        asset: first.asset,
        available_vault_balance: first.available_vault_balance,
        fee_percentage_1e18: first.fee_percentage_1e18,
        paused: first.paused,
        provider_locator_hash: protocol_contract_locator_hash(
            BALANCER_V2_PROVIDER_NAMESPACE,
            first.vault,
        )?,
        evidence,
    }
    .into_capital_source()
}

pub fn admit_uniswap_v3_dual_provider(
    first: &UniswapV3AuthenticatedObservation,
    second: &UniswapV3AuthenticatedObservation,
    first_transcript: &Hash32,
    second_transcript: &Hash32,
) -> Result<CapitalSource, CapitalError> {
    if first != second {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "Uniswap V3 provider observations disagree",
        ));
    }
    let evidence = require_independent_evidence(first_transcript, second_transcript)?;
    UniswapV3FlashObservation {
        anchor: first.anchor.clone(),
        pool: first.pool,
        asset: first.asset,
        available_pool_balance: first.available_pool_balance,
        fee_pips: first.fee_pips,
        provider_locator_hash: protocol_contract_locator_hash(
            UNISWAP_V3_PROVIDER_NAMESPACE,
            first.pool,
        )?,
        evidence,
    }
    .into_capital_source()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nqc_census_core::ChainDomain;

    fn hash(byte: u8) -> Hash32 {
        Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
    }

    fn address(value: &str) -> Address {
        Address::parse_hex(value).unwrap_or_else(|_| unreachable!())
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

    fn balancer() -> BalancerV2AuthenticatedObservation {
        BalancerV2AuthenticatedObservation {
            anchor: anchor(),
            vault: address("0x1111111111111111111111111111111111111111"),
            asset: address("0x2222222222222222222222222222222222222222"),
            available_vault_balance: Amount256::from_u128(1_000_000),
            fee_percentage_1e18: 500_000_000_000_000,
            paused: false,
        }
    }

    fn uniswap_v3() -> UniswapV3AuthenticatedObservation {
        UniswapV3AuthenticatedObservation {
            anchor: anchor(),
            pool: address("0x3333333333333333333333333333333333333333"),
            asset: address("0x4444444444444444444444444444444444444444"),
            available_pool_balance: Amount256::from_u128(2_000_000),
            fee_pips: 3_000,
        }
    }

    #[test]
    fn balancer_requires_exact_dual_provider_agreement() {
        let first = balancer();
        let mut second = first.clone();
        second.available_vault_balance = Amount256::from_u128(999_999);
        assert!(admit_balancer_v2_dual_provider(&first, &second, &hash(6), &hash(7)).is_err());
    }

    #[test]
    fn balancer_pause_preserves_observed_balance_but_blocks_execution() {
        let mut first = balancer();
        first.paused = true;
        let source = admit_balancer_v2_dual_provider(&first, &first, &hash(6), &hash(7))
            .unwrap_or_else(|_| unreachable!());
        assert_eq!(source.maximum_available(), Amount256::from_u128(1_000_000));
        assert!(!source.execution_eligible());
        assert_eq!(
            source.execution_blockers(),
            &["BALANCER_VAULT_PAUSED".to_owned()]
        );
    }

    #[test]
    fn uniswap_v3_requires_exact_dual_provider_agreement() {
        let first = uniswap_v3();
        let mut second = first.clone();
        second.fee_pips = 500;
        assert!(admit_uniswap_v3_dual_provider(&first, &second, &hash(8), &hash(9)).is_err());
    }

    #[test]
    fn provider_transcripts_must_be_independent() {
        let first = uniswap_v3();
        assert!(admit_uniswap_v3_dual_provider(&first, &first, &hash(8), &hash(8)).is_err());
    }

    #[test]
    fn uniswap_v3_admission_preserves_exact_pool_balance() {
        let first = uniswap_v3();
        let source = admit_uniswap_v3_dual_provider(&first, &first, &hash(8), &hash(9))
            .unwrap_or_else(|_| unreachable!());
        assert_eq!(source.maximum_available(), Amount256::from_u128(2_000_000));
        assert!(source.execution_eligible());
    }
}
