use alloy::primitives::{keccak256, Address, B256};
use nqc_state::CanonicalBlock;
use thiserror::Error;

const DOMAIN: &[u8] = b"NEXUS_QUANT_CAPITAL_REPLAY_V3";
const STRATEGY_CLASS_DOMAIN: &[u8] = b"NQC_STRATEGY_CLASS_V1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum StrategyKind {
    AaveLiquidation = 1,
    MevShareBackrun = 2,
    DexArbitrage = 3,
}

impl StrategyKind {
    #[must_use]
    pub fn class_hash(self) -> B256 {
        let mut bytes = Vec::with_capacity(STRATEGY_CLASS_DOMAIN.len() + 1);
        bytes.extend_from_slice(STRATEGY_CLASS_DOMAIN);
        bytes.push(self as u8);
        keccak256(bytes)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplayContext {
    pub chain_id: u64,
    pub anchor: CanonicalBlock,
    pub target_block: u64,
    pub strategy: StrategyKind,
    pub subject: Address,
    pub market_snapshot_hash: B256,
    pub state_snapshot_hash: B256,
    pub execution_plan_hash: B256,
    pub transaction_intent_hash: B256,
    pub simulation_environment_hash: B256,
    pub simulation_result_hash: B256,
    pub settlement_result_hash: B256,
    pub edge_assessment_hash: B256,
    pub fee_envelope_hash: B256,
    pub risk_policy_hash: B256,
}

impl ReplayContext {
    #[must_use]
    pub fn fingerprint(self) -> B256 {
        let mut encoded = Vec::with_capacity(
            DOMAIN.len() + 8 + 8 + 32 + 8 + 9 + 8 + 1 + 20 + (32 * 10),
        );
        encoded.extend_from_slice(DOMAIN);
        encoded.extend_from_slice(&self.chain_id.to_be_bytes());
        encoded.extend_from_slice(&self.anchor.number.to_be_bytes());
        encoded.extend_from_slice(self.anchor.hash.as_slice());
        encoded.extend_from_slice(&self.anchor.timestamp.to_be_bytes());
        match self.anchor.base_fee_per_gas {
            Some(base_fee) => {
                encoded.push(1);
                encoded.extend_from_slice(&base_fee.to_be_bytes());
            }
            None => {
                encoded.push(0);
                encoded.extend_from_slice(&0u64.to_be_bytes());
            }
        }
        encoded.extend_from_slice(&self.target_block.to_be_bytes());
        encoded.push(self.strategy as u8);
        encoded.extend_from_slice(self.subject.as_slice());
        encoded.extend_from_slice(self.market_snapshot_hash.as_slice());
        encoded.extend_from_slice(self.state_snapshot_hash.as_slice());
        encoded.extend_from_slice(self.execution_plan_hash.as_slice());
        encoded.extend_from_slice(self.transaction_intent_hash.as_slice());
        encoded.extend_from_slice(self.simulation_environment_hash.as_slice());
        encoded.extend_from_slice(self.simulation_result_hash.as_slice());
        encoded.extend_from_slice(self.settlement_result_hash.as_slice());
        encoded.extend_from_slice(self.edge_assessment_hash.as_slice());
        encoded.extend_from_slice(self.fee_envelope_hash.as_slice());
        encoded.extend_from_slice(self.risk_policy_hash.as_slice());
        keccak256(encoded)
    }

    #[must_use]
    pub fn seal(self) -> ReplayCapsule {
        let fingerprint = self.fingerprint();
        ReplayCapsule {
            context: self,
            fingerprint,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplayCapsule {
    pub context: ReplayContext,
    pub fingerprint: B256,
}

impl ReplayCapsule {
    pub fn verify(self) -> Result<(), ReplayError> {
        let actual = self.context.fingerprint();
        if actual != self.fingerprint {
            return Err(ReplayError::FingerprintMismatch {
                expected: self.fingerprint,
                actual,
            });
        }
        Ok(())
    }

    pub fn require_anchor(self, anchor: CanonicalBlock) -> Result<(), ReplayError> {
        self.verify()?;
        if self.context.anchor != anchor {
            return Err(ReplayError::AnchorMismatch {
                expected: self.context.anchor,
                actual: anchor,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum ReplayError {
    #[error("replay fingerprint mismatch: expected {expected}, computed {actual}")]
    FingerprintMismatch { expected: B256, actual: B256 },
    #[error("replay anchor mismatch: expected {expected:?}, got {actual:?}")]
    AnchorMismatch {
        expected: CanonicalBlock,
        actual: CanonicalBlock,
    },
}

#[must_use]
pub fn hash_artifact(bytes: impl AsRef<[u8]>) -> B256 {
    keccak256(bytes.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> ReplayContext {
        ReplayContext {
            chain_id: 1,
            anchor: CanonicalBlock {
                number: 21_000_000,
                hash: B256::with_last_byte(1),
                timestamp: 1_700_000_000,
                base_fee_per_gas: Some(30_000_000_000),
            },
            target_block: 21_000_001,
            strategy: StrategyKind::AaveLiquidation,
            subject: Address::from([7u8; 20]),
            market_snapshot_hash: B256::with_last_byte(2),
            state_snapshot_hash: B256::with_last_byte(3),
            execution_plan_hash: B256::with_last_byte(4),
            transaction_intent_hash: B256::with_last_byte(5),
            simulation_environment_hash: B256::with_last_byte(6),
            simulation_result_hash: B256::with_last_byte(7),
            settlement_result_hash: B256::with_last_byte(8),
            edge_assessment_hash: B256::with_last_byte(9),
            fee_envelope_hash: B256::with_last_byte(10),
            risk_policy_hash: B256::with_last_byte(11),
        }
    }

    #[test]
    fn strategy_classes_are_domain_separated() {
        assert_ne!(
            StrategyKind::AaveLiquidation.class_hash(),
            StrategyKind::MevShareBackrun.class_hash()
        );
    }

    #[test]
    fn fingerprint_is_deterministic() {
        assert_eq!(context().fingerprint(), context().fingerprint());
    }

    #[test]
    fn any_execution_plan_drift_changes_fingerprint() {
        let original = context();
        let mut drifted = original;
        drifted.execution_plan_hash = B256::with_last_byte(99);
        assert_ne!(original.fingerprint(), drifted.fingerprint());
    }

    #[test]
    fn tampered_capsule_fails_closed() {
        let mut capsule = context().seal();
        capsule.fingerprint = B256::ZERO;
        assert!(matches!(
            capsule.verify(),
            Err(ReplayError::FingerprintMismatch { .. })
        ));
    }
}
