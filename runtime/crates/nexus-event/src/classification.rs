//! Data classification.
//!
//! Classification drives which zone an event may cross into. It is ordered:
//! the one-way gateway refuses to emit anything above its configured ceiling,
//! so a mislabelled event fails closed.

use crate::error::{NexusError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Classification {
    /// Safe to expose outside the operator's network.
    Public,
    /// Ordinary operational data.
    Internal,
    /// Process data whose disclosure would help an attacker.
    Sensitive,
    /// Control-plane material: keys, policies, approvals.
    Restricted,
}

impl Classification {
    pub fn as_str(self) -> &'static str {
        match self {
            Classification::Public => "public",
            Classification::Internal => "internal",
            Classification::Sensitive => "sensitive",
            Classification::Restricted => "restricted",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "public" => Classification::Public,
            "internal" => Classification::Internal,
            "sensitive" => Classification::Sensitive,
            "restricted" => Classification::Restricted,
            other => {
                return Err(NexusError::schema(format!(
                    "unknown classification '{other}'"
                )))
            }
        })
    }

    /// Fails closed: anything strictly above the ceiling is refused.
    pub fn may_cross_to(self, ceiling: Classification) -> bool {
        self <= ceiling
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordering_is_least_to_most_sensitive() {
        assert!(Classification::Public < Classification::Internal);
        assert!(Classification::Internal < Classification::Sensitive);
        assert!(Classification::Sensitive < Classification::Restricted);
    }

    #[test]
    fn crossing_fails_closed_above_the_ceiling() {
        assert!(Classification::Internal.may_cross_to(Classification::Sensitive));
        assert!(Classification::Internal.may_cross_to(Classification::Internal));
        assert!(!Classification::Restricted.may_cross_to(Classification::Sensitive));
    }

    #[test]
    fn round_trips_through_strings() {
        for value in [
            Classification::Public,
            Classification::Internal,
            Classification::Sensitive,
            Classification::Restricted,
        ] {
            assert_eq!(Classification::parse(value.as_str()).unwrap(), value);
        }
        assert!(Classification::parse("top-secret").is_err());
    }
}
