//! Backend selection.
//!
//! Which store the runtime talks to is a deployment decision, expressed as
//! configuration and resolved once at startup. Keeping the choice in a small
//! typed enum rather than scattered `cfg!` checks means the selection is
//! testable, is logged verbatim, and cannot silently fall back.
//!
//! ## Fail loudly, never downgrade silently
//!
//! Asking for a durable backend and receiving a non-durable one because a
//! feature was not compiled in is exactly the class of failure that makes an
//! operator believe data is persisted when it is not. Resolution here returns
//! the requested backend; the service refuses to start if it cannot honour
//! it. See `services/graphd/src/main.rs`.

use nexus_event::{NexusError, Result};

/// Default database name when a Neo4j/Memgraph endpoint is selected without one.
pub const DEFAULT_DATABASE: &str = "neo4j";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GraphBackend {
    /// Process-local store. Not durable. The default for CI, the offline
    /// end-to-end demo and the examples.
    InMemory,
    /// Neo4j or Memgraph over the Bolt protocol. Requires `--features neo4j`.
    Neo4j { uri: String, database: String },
}

impl Default for GraphBackend {
    fn default() -> Self {
        GraphBackend::InMemory
    }
}

impl GraphBackend {
    pub fn name(&self) -> &'static str {
        match self {
            GraphBackend::InMemory => "in-memory",
            GraphBackend::Neo4j { .. } => "neo4j",
        }
    }

    /// True when the backend survives a process restart.
    pub fn is_durable(&self) -> bool {
        matches!(self, GraphBackend::Neo4j { .. })
    }

    /// Whether this build can actually reach the backend.
    pub fn is_available_in_this_build(&self) -> bool {
        match self {
            GraphBackend::InMemory => true,
            GraphBackend::Neo4j { .. } => cfg!(feature = "neo4j"),
        }
    }

    /// Resolves configuration into a backend selection.
    ///
    /// Tolerant of a missing or unrecognised selector — it falls back to the
    /// in-memory store, which is the safe default because it makes no
    /// durability promise. It is *not* tolerant of asking for Neo4j without
    /// an endpoint: see [`GraphBackend::resolve`] for the strict form.
    pub fn from_env_value(
        selector: Option<&str>,
        uri: Option<&str>,
        database: Option<&str>,
    ) -> Self {
        let selector = selector.unwrap_or("").trim().to_ascii_lowercase();
        match selector.as_str() {
            "neo4j" | "memgraph" | "bolt" => GraphBackend::Neo4j {
                uri: uri.unwrap_or("").trim().to_string(),
                database: database
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(DEFAULT_DATABASE)
                    .to_string(),
            },
            _ => GraphBackend::InMemory,
        }
    }

    /// Strict resolution: rejects a selection that cannot be honoured.
    pub fn resolve(
        selector: Option<&str>,
        uri: Option<&str>,
        database: Option<&str>,
    ) -> Result<Self> {
        let backend = GraphBackend::from_env_value(selector, uri, database);

        if let GraphBackend::Neo4j { uri, .. } = &backend {
            if uri.is_empty() {
                return Err(NexusError::invalid(
                    "NEXUS_GRAPH_BACKEND selects a graph database but NEXUS_GRAPH_URI is not set",
                ));
            }
            if !uri.starts_with("bolt://")
                && !uri.starts_with("bolt+s://")
                && !uri.starts_with("neo4j://")
                && !uri.starts_with("neo4j+s://")
            {
                return Err(NexusError::invalid(format!(
                    "unsupported graph URI scheme in '{uri}'; expected bolt:// or neo4j://"
                )));
            }
        }

        if !backend.is_available_in_this_build() {
            return Err(NexusError::unsupported(format!(
                "backend '{}' requires building with --features neo4j",
                backend.name()
            )));
        }

        Ok(backend)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_the_non_durable_store() {
        assert_eq!(
            GraphBackend::from_env_value(None, None, None),
            GraphBackend::InMemory
        );
        assert_eq!(
            GraphBackend::from_env_value(Some(""), None, None),
            GraphBackend::InMemory
        );
        assert!(!GraphBackend::InMemory.is_durable());
    }

    #[test]
    fn unrecognised_selectors_do_not_silently_become_a_database() {
        assert_eq!(
            GraphBackend::from_env_value(Some("postgres"), Some("x"), None),
            GraphBackend::InMemory
        );
    }

    #[test]
    fn selector_is_case_and_whitespace_insensitive() {
        for selector in ["neo4j", "NEO4J", " Neo4j ", "memgraph", "bolt"] {
            let backend =
                GraphBackend::from_env_value(Some(selector), Some("bolt://host:7687"), None);
            assert_eq!(backend.name(), "neo4j", "selector {selector}");
            assert!(backend.is_durable());
        }
    }

    #[test]
    fn database_falls_back_to_the_documented_default() {
        let backend =
            GraphBackend::from_env_value(Some("neo4j"), Some("bolt://host:7687"), Some("  "));
        match backend {
            GraphBackend::Neo4j { database, .. } => assert_eq!(database, DEFAULT_DATABASE),
            other => panic!("unexpected backend {other:?}"),
        }
    }

    #[test]
    fn strict_resolution_rejects_a_missing_endpoint() {
        let error = GraphBackend::resolve(Some("neo4j"), None, None).unwrap_err();
        assert_eq!(error.kind(), "invalid");
    }

    #[test]
    fn strict_resolution_rejects_a_wrong_scheme() {
        let error =
            GraphBackend::resolve(Some("neo4j"), Some("http://host:7474"), None).unwrap_err();
        assert_eq!(error.kind(), "invalid");
    }

    #[test]
    fn strict_resolution_refuses_a_backend_this_build_cannot_reach() {
        let outcome = GraphBackend::resolve(Some("neo4j"), Some("bolt://host:7687"), None);
        if cfg!(feature = "neo4j") {
            assert!(outcome.is_ok());
        } else {
            let error = outcome.unwrap_err();
            assert_eq!(error.kind(), "unsupported");
        }
    }

    #[test]
    fn in_memory_always_resolves() {
        assert_eq!(
            GraphBackend::resolve(None, None, None).unwrap(),
            GraphBackend::InMemory
        );
    }
}
