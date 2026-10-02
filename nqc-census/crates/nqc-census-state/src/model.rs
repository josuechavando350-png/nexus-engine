//! Protocol-agnostic state and token admission core.
//!
//! Adapters turn observed chain facts into three kinds of record:
//!
//! - **state rows**: exact integer protocol state at one canonical anchor;
//! - **token admission records**: what is proven about a token, and what is
//!   not. Every behavior that execution would depend on is tri-state —
//!   `PROVEN_ABSENT`, `PRESENT` or `UNPROVEN` — and nothing is assumed;
//! - **mismatches**: any disagreement between two views of the same fact
//!   (a getter against its recomputation, a decimals value against the
//!   reserve configuration, ...). A mismatch is unexplained unless the record
//!   names concrete evidence for it.
//!
//! Stage decisions use the D-pipeline `StageLedger`, so rejection reasons are
//! the census's own `RejectionReason` codes and never free text.

use nqc_census_chain::json::Json;
use nqc_census_core::Address;
use std::collections::BTreeSet;

/// Tri-state property of a token or market.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tri {
    ProvenAbsent,
    Present,
    Unproven,
}

impl Tri {
    pub const fn code(self) -> &'static str {
        match self {
            Self::ProvenAbsent => "PROVEN_ABSENT",
            Self::Present => "PRESENT",
            Self::Unproven => "UNPROVEN",
        }
    }
}

/// How the token's runtime is identified at the anchor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeIdentity {
    /// Runtime code observed; sha256 of the exact bytes and their length.
    Code { sha256: String, size: u64 },
    /// Runtime answered ABI calls with canonical encodings; code bytes were
    /// not acquired.
    PresenceByCall,
    /// The account has no runtime code (calls returned empty data).
    Absent,
}

impl RuntimeIdentity {
    pub fn json(&self) -> Json {
        match self {
            Self::Code { sha256, size } => Json::object([
                ("kind", Json::string("CODE_SHA256")),
                ("sha256", Json::string(sha256.clone())),
                ("size", Json::uint(*size)),
            ]),
            Self::PresenceByCall => Json::object([("kind", Json::string("PRESENCE_BY_CALL"))]),
            Self::Absent => Json::object([("kind", Json::string("ABSENT"))]),
        }
    }
}

/// Upgradeability evidence read from standard proxy storage slots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyFact {
    /// No standard slot is set. Non-standard upgradeability is not excluded.
    NoStandardSlot,
    Eip1967 {
        implementation: Address,
        implementation_sha256: Option<String>,
    },
    Eip1967Beacon {
        beacon: Address,
    },
    ZeppelinOs {
        implementation: Address,
    },
    NotRead,
}

impl ProxyFact {
    pub fn upgradeable(&self) -> Tri {
        match self {
            Self::Eip1967 { .. } | Self::Eip1967Beacon { .. } | Self::ZeppelinOs { .. } => {
                Tri::Present
            }
            // An empty standard slot does not prove immutability.
            Self::NoStandardSlot | Self::NotRead => Tri::Unproven,
        }
    }

    pub fn json(&self) -> Json {
        match self {
            Self::NoStandardSlot => Json::object([("kind", Json::string("NO_STANDARD_SLOT"))]),
            Self::NotRead => Json::object([("kind", Json::string("NOT_READ"))]),
            Self::Eip1967 {
                implementation,
                implementation_sha256,
            } => Json::object([
                ("kind", Json::string("EIP1967")),
                ("implementation", Json::string(implementation.to_hex())),
                (
                    "implementation_sha256",
                    implementation_sha256
                        .as_ref()
                        .map_or(Json::Null, |hash| Json::string(hash.clone())),
                ),
            ]),
            Self::Eip1967Beacon { beacon } => Json::object([
                ("kind", Json::string("EIP1967_BEACON")),
                ("beacon", Json::string(beacon.to_hex())),
            ]),
            Self::ZeppelinOs { implementation } => Json::object([
                ("kind", Json::string("ZEPPELINOS")),
                ("implementation", Json::string(implementation.to_hex())),
            ]),
        }
    }
}

/// `decimals()` as observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decimals {
    Value(u8),
    Reverted,
    /// A deterministic EVM exceptional halt under the fixed gas bound.
    Halted,
    /// Empty return data: no runtime code answered.
    Empty,
    /// Returned data that is not one canonical uint8 word.
    NonCanonical,
}

impl Decimals {
    pub fn decode(outcome: &nqc_census_core::CallOutcome) -> Self {
        match outcome {
            nqc_census_core::CallOutcome::Reverted(_) => Self::Reverted,
            nqc_census_core::CallOutcome::Returned(bytes) if bytes.is_empty() => Self::Empty,
            nqc_census_core::CallOutcome::Returned(bytes) => {
                if bytes.len() != 32 || bytes[..31].iter().any(|byte| *byte != 0) {
                    Self::NonCanonical
                } else {
                    Self::Value(bytes[31])
                }
            }
        }
    }

    pub const fn value(self) -> Option<u8> {
        match self {
            Self::Value(value) => Some(value),
            _ => None,
        }
    }

    pub fn json(self) -> Json {
        match self {
            Self::Value(value) => Json::object([
                ("status", Json::string("VALUE")),
                ("value", Json::uint(u64::from(value))),
            ]),
            Self::Reverted => Json::object([("status", Json::string("REVERTED"))]),
            Self::Halted => Json::object([("status", Json::string("HALTED"))]),
            Self::Empty => Json::object([("status", Json::string("EMPTY_RETURN"))]),
            Self::NonCanonical => Json::object([("status", Json::string("NON_CANONICAL"))]),
        }
    }
}

/// Transfer-relevant behavior. Every field defaults to `UNPROVEN`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenBehavior {
    pub fee_on_transfer: Tri,
    pub rebasing: Tri,
    pub transfer_hooks: Tri,
    pub upgradeable: Tri,
    /// Concrete observations that bear on the above (never proofs of
    /// absence on their own), e.g. a holder balance below the protocol's
    /// accounted balance.
    pub signals: Vec<(String, String)>,
}

impl TokenBehavior {
    pub fn unproven() -> Self {
        Self {
            fee_on_transfer: Tri::Unproven,
            rebasing: Tri::Unproven,
            transfer_hooks: Tri::Unproven,
            upgradeable: Tri::Unproven,
            signals: Vec::new(),
        }
    }

    /// Reasons execution must stay blocked. Empty only when every
    /// transfer-relevant behavior is proven absent.
    pub fn execution_blockers(&self) -> Vec<String> {
        let mut out = Vec::new();
        for (name, value) in [
            ("FEE_ON_TRANSFER", self.fee_on_transfer),
            ("REBASING", self.rebasing),
            ("TRANSFER_HOOKS", self.transfer_hooks),
            ("UPGRADEABLE", self.upgradeable),
        ] {
            match value {
                Tri::ProvenAbsent => {}
                Tri::Present => out.push(format!("{name}_PRESENT")),
                Tri::Unproven => out.push(format!("{name}_UNPROVEN")),
            }
        }
        out
    }

    pub fn json(&self) -> Json {
        Json::object([
            ("fee_on_transfer", Json::string(self.fee_on_transfer.code())),
            ("rebasing", Json::string(self.rebasing.code())),
            ("transfer_hooks", Json::string(self.transfer_hooks.code())),
            ("upgradeable", Json::string(self.upgradeable.code())),
            (
                "signals",
                Json::array(self.signals.iter().map(|(name, value)| {
                    Json::object([
                        ("signal", Json::string(name.clone())),
                        ("value", Json::string(value.clone())),
                    ])
                })),
            ),
        ])
    }
}

/// Whether the token's state facts may be used by later census stages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateAdmission {
    Admitted,
    Rejected(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenAdmission {
    pub token: Address,
    pub roles: BTreeSet<String>,
    pub runtime: RuntimeIdentity,
    pub proxy: ProxyFact,
    pub decimals: Decimals,
    pub behavior: TokenBehavior,
    pub state: StateAdmission,
}

impl TokenAdmission {
    pub fn execution_blockers(&self) -> Vec<String> {
        let mut out = self.behavior.execution_blockers();
        match &self.runtime {
            RuntimeIdentity::Code { .. } => {}
            RuntimeIdentity::PresenceByCall => {
                out.push("RUNTIME_CODE_IDENTITY_NOT_ACQUIRED".into())
            }
            RuntimeIdentity::Absent => out.push("RUNTIME_CODE_ABSENT".into()),
        }
        if let StateAdmission::Rejected(reason) = &self.state {
            out.push(format!("STATE_REJECTED_{reason}"));
        }
        out.sort();
        out.dedup();
        out
    }

    pub fn json(&self) -> Json {
        let blockers = self.execution_blockers();
        Json::object([
            ("token", Json::string(self.token.to_hex())),
            (
                "roles",
                Json::array(self.roles.iter().map(|role| Json::string(role.clone()))),
            ),
            ("runtime", self.runtime.json()),
            ("proxy", self.proxy.json()),
            ("decimals", self.decimals.json()),
            ("behavior", self.behavior.json()),
            (
                "state_admission",
                match &self.state {
                    StateAdmission::Admitted => {
                        Json::object([("status", Json::string("ADMITTED"))])
                    }
                    StateAdmission::Rejected(reason) => Json::object([
                        ("status", Json::string("REJECTED")),
                        ("reason", Json::string(reason.clone())),
                    ]),
                },
            ),
            (
                "execution_compatibility",
                Json::object([
                    (
                        "status",
                        Json::string(if blockers.is_empty() {
                            "PROVEN_COMPATIBLE"
                        } else {
                            "BLOCKED"
                        }),
                    ),
                    (
                        "blockers",
                        Json::array(blockers.into_iter().map(Json::string)),
                    ),
                ]),
            ),
        ])
    }
}

/// One disagreement between two views of the same fact.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Mismatch {
    pub unit: String,
    pub dimension: String,
    pub expected: String,
    pub observed: String,
    /// Concrete evidence-backed explanation; `None` means unexplained.
    pub explanation: Option<String>,
}

impl Mismatch {
    pub fn json(&self) -> Json {
        Json::object([
            ("unit", Json::string(self.unit.clone())),
            ("dimension", Json::string(self.dimension.clone())),
            ("expected", Json::string(self.expected.clone())),
            ("observed", Json::string(self.observed.clone())),
            (
                "classification",
                Json::string(if self.explanation.is_some() {
                    "EXPLAINED"
                } else {
                    "UNEXPLAINED"
                }),
            ),
            (
                "explanation",
                self.explanation
                    .as_ref()
                    .map_or(Json::Null, |text| Json::string(text.clone())),
            ),
        ])
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MismatchLedger {
    entries: Vec<Mismatch>,
}

impl MismatchLedger {
    /// Records an unexplained mismatch when `expected != observed`.
    pub fn check(
        &mut self,
        unit: &str,
        dimension: &str,
        expected: impl ToString,
        observed: impl ToString,
    ) -> bool {
        let (expected, observed) = (expected.to_string(), observed.to_string());
        if expected == observed {
            return true;
        }
        self.entries.push(Mismatch {
            unit: unit.into(),
            dimension: dimension.into(),
            expected,
            observed,
            explanation: None,
        });
        false
    }

    pub fn push(&mut self, mismatch: Mismatch) {
        self.entries.push(mismatch);
    }

    pub fn extend(&mut self, other: Self) {
        self.entries.extend(other.entries);
    }

    pub fn unexplained(&self) -> usize {
        self.entries
            .iter()
            .filter(|entry| entry.explanation.is_none())
            .count()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Canonically ordered entries.
    pub fn sorted(&self) -> Vec<Mismatch> {
        let mut out = self.entries.clone();
        out.sort();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nqc_census_core::CallOutcome;

    #[test]
    fn decimals_decode_is_strict() {
        let mut word = vec![0u8; 32];
        word[31] = 18;
        assert_eq!(
            Decimals::decode(&CallOutcome::Returned(word.clone())),
            Decimals::Value(18)
        );
        word[0] = 1;
        assert_eq!(
            Decimals::decode(&CallOutcome::Returned(word)),
            Decimals::NonCanonical
        );
        assert_eq!(
            Decimals::decode(&CallOutcome::Returned(vec![0; 31])),
            Decimals::NonCanonical
        );
        assert_eq!(
            Decimals::decode(&CallOutcome::Returned(Vec::new())),
            Decimals::Empty
        );
        assert_eq!(
            Decimals::decode(&CallOutcome::Reverted(Vec::new())),
            Decimals::Reverted
        );
    }

    #[test]
    fn unproven_behavior_blocks_execution() {
        let behavior = TokenBehavior::unproven();
        assert_eq!(
            behavior.execution_blockers(),
            vec![
                "FEE_ON_TRANSFER_UNPROVEN",
                "REBASING_UNPROVEN",
                "TRANSFER_HOOKS_UNPROVEN",
                "UPGRADEABLE_UNPROVEN"
            ]
        );
        let proven = TokenBehavior {
            fee_on_transfer: Tri::ProvenAbsent,
            rebasing: Tri::ProvenAbsent,
            transfer_hooks: Tri::ProvenAbsent,
            upgradeable: Tri::Present,
            signals: Vec::new(),
        };
        assert_eq!(proven.execution_blockers(), vec!["UPGRADEABLE_PRESENT"]);
    }

    #[test]
    fn ledger_records_only_disagreement() {
        let mut ledger = MismatchLedger::default();
        assert!(ledger.check("u", "d", 1, 1));
        assert!(!ledger.check("u", "d", 1, 2));
        assert_eq!(ledger.unexplained(), 1);
        ledger.push(Mismatch {
            unit: "u".into(),
            dimension: "e".into(),
            expected: "a".into(),
            observed: "b".into(),
            explanation: Some("EVIDENCE".into()),
        });
        assert_eq!(ledger.unexplained(), 1);
        assert_eq!(ledger.len(), 2);
    }
}
