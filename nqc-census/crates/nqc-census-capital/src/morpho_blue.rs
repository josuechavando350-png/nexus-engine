//! Morpho Blue flash capital semantics for RMC V2 (nominal-only, fail-closed).
//!
//! The deployed Morpho Blue flashLoan(address token, uint256 assets, bytes data)
//! transfers assets, calls onMorphoFlashLoan, and takes back precisely `assets`
//! through ERC20.transferFrom. Upstream: morpho-org/morpho-blue
//! 8e26ca6a8dbc5089edcd67fb576248810fd2870a, src/Morpho.sol.
//!
//! A double-RPC state match is NOT sufficient to authenticate RPC operator
//! independence, deployed runtime code, our executor callback and repayment,
//! gas sponsorship, route economics or D11 terminal source-family authority.
//! This module deliberately preserves reported token balance as nominal
//! capital with ZERO executable capacity, regardless of witness flag content.

use crate::{
    Amount256, CapitalAsset, CapitalCaps, CapitalClass, CapitalError, CapitalEvidenceRef,
    CapitalFailureMode, CapitalOwnership, CapitalProviderKind, CapitalSource,
    CapitalSourceSpec, CollateralRequirement, FeeModel, RepaymentSemantics,
    TemporaryLock, UtilizationConstraints,
};
use nqc_census_core::{Address, Hash32, StateAnchor};
use sha2::{Digest, Sha256};

pub const MORPHO_BLUE_PROVIDER_NAMESPACE: u16 = 0x1401;
pub const MORPHO_BLUE_MAINNET_ADDRESS: &str =
    "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
pub const MORPHO_BLUE_UPSTREAM_COMMIT: &str =
    "8e26ca6a8dbc5089edcd67fb576248810fd2870a";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MorphoBlueObservedState {
    /// Exact canonical StateAnchor includes the Ethereum block hash.
    pub anchor: StateAnchor,
    pub morpho: Address,
    pub asset: Address,
    /// ERC20.balanceOf(Morpho) at `anchor`, not a committed loan quote.
    pub nominal_token_balance: Amount256,
    /// Observed deployed runtime bytecode hash (identity NOT validated here).
    pub runtime_code_hash: Hash32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MorphoBlueOperatorWitness {
    /// Declared distinct operator IDs are necessary, not proof of independence.
    pub operator_id: String,
    /// Digest of an externally preserved canonical source transcript.
    pub transcript: Hash32,
    pub state: MorphoBlueObservedState,
}

fn operator_id_syntax_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
        })
}

fn protocol_contract_locator_hash(morpho: Address) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-PROTOCOL-CONTRACT-LOCATOR-V1");
    hasher.update([0]);
    hasher.update(MORPHO_BLUE_PROVIDER_NAMESPACE.to_be_bytes());
    hasher.update(morpho.as_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidCanonical("zero Morpho locator digest"))
}

/// Reconcile two declared operator observations into a *non-executable*
/// external CapitalSource. This function is NOT a live-provider attestation.
/// The caller must separately authenticate both archived RPC transcripts,
/// their distinct operators, block/canonicality, deployed code, and fork
/// callback/repayment before any future D11 V2 promotion.
pub fn reconcile_morpho_blue_nominal(
    first: &MorphoBlueOperatorWitness,
    second: &MorphoBlueOperatorWitness,
) -> Result<CapitalSource, CapitalError> {
    if !operator_id_syntax_valid(&first.operator_id)
        || !operator_id_syntax_valid(&second.operator_id)
        || first.operator_id == second.operator_id
    {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "Morpho requires two distinct declared RPC operator identifiers",
        ));
    }
    if first.transcript == second.transcript {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "Morpho requires separate recorded RPC transcript digests",
        ));
    }
    if first.state != second.state {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "Morpho dual RPC token/code/anchor observations disagree",
        ));
    }

    let expected = Address::parse_hex(MORPHO_BLUE_MAINNET_ADDRESS)
        .map_err(|_| CapitalError::InvalidCanonical(
            "invalid pinned Morpho Blue mainnet address",
        ))?;
    if first.state.morpho != expected {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "Morpho flash source contract differs from pinned mainnet deployment",
        ));
    }

    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::ProtocolNativeFlashLoan,
        anchor: first.state.anchor.clone(),
        provider_namespace: MORPHO_BLUE_PROVIDER_NAMESPACE,
        provider_locator_hash: protocol_contract_locator_hash(first.state.morpho)?,
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(first.state.morpho),
        asset: CapitalAsset::Token(first.state.asset),
        maximum_available: first.state.nominal_token_balance,
        // Upstream Morpho.sol charges 0 flash fee. Do not extrapolate from
        // pinned upstream source to unverified deployed runtime identity.
        fee_model: FeeModel::None,
        repayment_asset: CapitalAsset::Token(first.state.asset),
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::SourceUnavailable,
            CapitalFailureMode::CapacityChanged,
            CapitalFailureMode::RepaymentFailure,
            CapitalFailureMode::CallbackOrHookRevert,
        ],
        evidence: vec![
            CapitalEvidenceRef::Artifact(first.transcript),
            CapitalEvidenceRef::Artifact(second.transcript),
        ],
    })?;

    // Never let a synthetic or unauthenticated witness grant production
    // capital authority merely by setting a boolean in JSON/caller memory.
    let mut blockers = vec![
        "MORPHO_RPC_OPERATORS_NOT_INDEPENDENTLY_AUTHENTICATED".to_owned(),
        "MORPHO_DEPLOYED_CODE_NOT_CERTIFIED_AGAINST_UPSTREAM".to_owned(),
        "MORPHO_EXECUTOR_CALLBACK_AND_REPAYMENT_NOT_FORK_CERTIFIED".to_owned(),
        "MORPHO_D11_V2_SOURCE_FAMILY_NOT_TERMINAL".to_owned(),
    ];
    if first.state.nominal_token_balance.is_zero() {
        blockers.push("MORPHO_ZERO_TOKEN_BALANCE".to_owned());
    }
    source.with_execution_blockers(blockers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nqc_census_core::ChainDomain;

    fn hash(b: u8) -> Hash32 {
        Hash32::new([b; 32]).unwrap_or_else(|_| unreachable!())
    }
    fn address(s: &str) -> Address {
        Address::parse_hex(s).unwrap_or_else(|_| unreachable!())
    }
    fn anchor() -> StateAnchor {
        StateAnchor::new(
            ChainDomain::new(1, hash(1), hash(2))
                .unwrap_or_else(|_| unreachable!()),
            26_184_415,
            hash(3),
            hash(4),
            1_791_904_679,
            hash(5),
        ).unwrap_or_else(|_| unreachable!())
    }
    fn state() -> MorphoBlueObservedState {
        MorphoBlueObservedState {
            anchor: anchor(),
            morpho: address(MORPHO_BLUE_MAINNET_ADDRESS),
            asset: address("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
            nominal_token_balance: Amount256::from_u128(65_581_714_595_588),
            runtime_code_hash: hash(6),
        }
    }
    fn witness(name: &str, transcript_byte: u8) -> MorphoBlueOperatorWitness {
        MorphoBlueOperatorWitness {
            operator_id: name.to_owned(),
            transcript: hash(transcript_byte),
            state: state(),
        }
    }

    #[test]
    fn reconciles_nominal_token_balance_with_zero_executable_capital() {
        let x = reconcile_morpho_blue_nominal(
            &witness("rpc-org-a", 7), &witness("rpc-org-b", 8),
        ).unwrap_or_else(|_| unreachable!());
        assert_eq!(x.maximum_available(), Amount256::from_u128(65_581_714_595_588));
        assert_eq!(x.executable_capacity().unwrap_or(Amount256::MAX), Amount256::ZERO);
        assert!(!x.execution_eligible());
        assert_eq!(x.class(), CapitalClass::ProtocolNativeFlashLoan);
        assert_eq!(x.provider_namespace(), MORPHO_BLUE_PROVIDER_NAMESPACE);
        assert_eq!(x.provider_kind(), CapitalProviderKind::ProtocolContract);
        assert_eq!(x.ownership(), CapitalOwnership::External);
        assert_eq!(x.repayment(), RepaymentSemantics::AtomicSameTransaction);
        assert_eq!(x.fee_model(), FeeModel::None);
        assert_eq!(x.quote_fee(Amount256::from_u128(1000)).unwrap_or_else(|_| unreachable!()), None);
    }

    #[test]
    fn same_operator_cannot_fake_independence() {
        assert!(reconcile_morpho_blue_nominal(
            &witness("rpc-org-a", 7), &witness("rpc-org-a", 8),
        ).is_err());
    }

    #[test]
    fn same_transcript_cannot_be_counted_twice() {
        assert!(reconcile_morpho_blue_nominal(
            &witness("rpc-org-a", 7), &witness("rpc-org-b", 7),
        ).is_err());
    }

    #[test]
    fn independent_identifiers_are_only_declared_not_certified() {
        let src = reconcile_morpho_blue_nominal(
            &witness("provider-A", 7), &witness("provider-B", 8),
        ).unwrap_or_else(|_| unreachable!());
        assert!(src.execution_blockers().iter()
            .any(|x| x == "MORPHO_RPC_OPERATORS_NOT_INDEPENDENTLY_AUTHENTICATED"));
    }

    #[test]
    fn rejects_different_state_or_balance() {
        let first = witness("rpc-org-a", 7);
        let mut second = witness("rpc-org-b", 8);
        second.state.nominal_token_balance = Amount256::from_u128(1);
        assert!(reconcile_morpho_blue_nominal(&first, &second).is_err());
        second.state = first.state.clone();
        second.state.runtime_code_hash = hash(9);
        assert!(reconcile_morpho_blue_nominal(&first, &second).is_err());
    }

    #[test]
    fn rejects_wrong_deployment_and_token() {
        let mut first = witness("rpc-org-a", 7);
        let mut second = witness("rpc-org-b", 8);
        first.state.morpho = address("0x1111111111111111111111111111111111111111");
        second.state.morpho = first.state.morpho;
        assert!(reconcile_morpho_blue_nominal(&first, &second).is_err());
        // A different asset is a distinct flash source, not an equivalent view.
        first = witness("rpc-org-a", 7);
        second = witness("rpc-org-b", 8);
        second.state.asset = address("0x2222222222222222222222222222222222222222");
        assert!(reconcile_morpho_blue_nominal(&first, &second).is_err());
    }

    #[test]
    fn rejects_wrong_canonical_anchor() {
        let first = witness("rpc-org-a", 7);
        let mut second = witness("rpc-org-b", 8);
        second.state.anchor = StateAnchor::new(
            ChainDomain::new(1, hash(1), hash(2))
                .unwrap_or_else(|_| unreachable!()),
            26_184_416, hash(3), hash(4), 1_791_904_691, hash(5),
        ).unwrap_or_else(|_| unreachable!());
        assert!(reconcile_morpho_blue_nominal(&first, &second).is_err());
    }

    #[test]
    fn zero_nominal_balance_is_preserved_as_zero_not_discarded() {
        let mut a = witness("rpc-org-a", 7);
        let mut b = witness("rpc-org-b", 8);
        a.state.nominal_token_balance = Amount256::ZERO;
        b.state.nominal_token_balance = Amount256::ZERO;
        let src = reconcile_morpho_blue_nominal(&a, &b)
            .unwrap_or_else(|_| unreachable!());
        assert_eq!(src.maximum_available(), Amount256::ZERO);
        assert!(!src.execution_eligible());
        assert!(src.execution_blockers().contains(&"MORPHO_ZERO_TOKEN_BALANCE".to_owned()));
    }

    #[test]
    fn malformed_operator_identifiers_fail_closed() {
        for name in ["", "source/foo", "has whitespace", "🔑"] {
            assert!(reconcile_morpho_blue_nominal(
                &witness(name, 7), &witness("rpc-org-b", 8),
            ).is_err());
        }
    }

    #[test]
    fn same_evidence_is_deterministic() {
        let a = reconcile_morpho_blue_nominal(
            &witness("rpc-org-a", 7), &witness("rpc-org-b", 8),
        ).unwrap_or_else(|_| unreachable!());
        let b = reconcile_morpho_blue_nominal(
            &witness("rpc-org-a", 7), &witness("rpc-org-b", 8),
        ).unwrap_or_else(|_| unreachable!());
        assert_eq!(a, b);
    }
}
