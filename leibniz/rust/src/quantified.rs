//! Finite, explicitly quantified queries over the declared predicate catalog.
//!
//! Quantifiers range exclusively over an enumerated domain supplied by the
//! caller. Each ground instance uses the original graph inference engine and
//! source-anchored proof checker. Non-entailment in this open-world graph is
//! unknown, never proof of a negation. This is NOT unrestricted higher-order
//! logic or a claim about the truth of external sources.

use crate::{ArgumentKind, Atom, Decision, Graph, Limits, Proof, Term};
use std::collections::BTreeSet;

pub const MAX_QUANTIFIED_CANDIDATES: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PredicateQuantifier {
    /// Every explicitly named predicate has a checked proof for these terms.
    All,
    /// At least one explicitly named predicate has a checked proof.
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuantifiedQuery {
    pub quantifier: PredicateQuantifier,
    /// Full, explicit finite domain, not a request to search for predicates.
    pub candidates: Vec<String>,
    pub terms: Vec<Term>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PredicateWitness {
    pub predicate: String,
    pub proof: Proof,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuantifiedDecision {
    Proven { witnesses: Vec<PredicateWitness> },
    Unidentifiable { reason: String },
    Abstain { reason: String },
}

fn checked_domain(
    graph: &Graph,
    query: &QuantifiedQuery,
    max_candidates: usize,
) -> Result<Vec<String>, String> {
    if max_candidates == 0
        || query.candidates.is_empty()
        || query.candidates.len() > max_candidates
        || query.candidates.len() > MAX_QUANTIFIED_CANDIDATES
    {
        return Err("quantified predicate domain is empty or exceeds the instance budget".into());
    }
    let mut unique = BTreeSet::new();
    let mut signature: Option<&[ArgumentKind]> = None;
    for name in &query.candidates {
        if name.trim().is_empty() || !unique.insert(name.clone()) {
            return Err("quantified domain contains a blank or duplicate predicate".into());
        }
        let arguments = graph
            .predicate_signature(name)
            .ok_or_else(|| format!("quantified domain includes undeclared predicate {name}"))?;
        if arguments.len() != query.terms.len() {
            return Err(format!(
                "quantified predicate {name} has incompatible arity"
            ));
        }
        if let Some(previous) = &signature {
            if *previous != arguments {
                return Err("quantified predicates must have identical argument signatures".into());
            }
        } else {
            signature = Some(arguments);
        }
    }
    Ok(unique.into_iter().collect())
}

/// Computes explicit finite `forall P` or `exists P`, anchored to source proofs.
/// A missing open-world derivation is UNIDENTIFIABLE; a budget failure or
/// contradictory closure is ABSTAIN, never a fabricated negative answer.
/// Each candidate uses the caller's individual inference budget; the number
/// of such computations is bounded by `max_candidates` and the global cap.
pub fn infer_quantified(
    graph: &Graph,
    query: &QuantifiedQuery,
    limits: Limits,
    max_candidates: usize,
) -> Result<QuantifiedDecision, String> {
    let domain = checked_domain(graph, query, max_candidates)?;
    let mut witnesses = Vec::new();
    let mut missing = false;
    let mut uncertain = None;
    for predicate in &domain {
        let atom = Atom {
            predicate: predicate.clone(),
            terms: query.terms.clone(),
        };
        match graph.infer(&atom, limits) {
            Decision::Proven { proof } => {
                // Verify separately rather than trusting a constructed proof.
                graph
                    .verify_consistent_proof(&atom, &proof, limits)
                    .map_err(|reason| format!("quantified proof verification failed: {reason}"))?;
                witnesses.push(PredicateWitness {
                    predicate: predicate.clone(),
                    proof,
                });
            }
            Decision::Unidentifiable { .. } => missing = true,
            Decision::Abstain { reason } if reason.starts_with("invalid query:") => {
                return Err(format!("quantified predicate {predicate}: {reason}"));
            }
            Decision::Abstain { reason } => uncertain = Some(reason),
            Decision::Estimated { .. } => {
                return Err("deterministic quantified inference received an estimate".into());
            }
        }
    }
    if query.quantifier == PredicateQuantifier::Any && !witnesses.is_empty() {
        // Only one independently checked witness is needed for existence.
        return Ok(QuantifiedDecision::Proven {
            witnesses: vec![witnesses.remove(0)],
        });
    }
    if let Some(reason) = uncertain {
        return Ok(QuantifiedDecision::Abstain { reason });
    }
    if missing {
        return Ok(QuantifiedDecision::Unidentifiable {
            reason: "at least one required predicate is not entailed (open-world semantics)".into(),
        });
    }
    Ok(QuantifiedDecision::Proven { witnesses })
}

/// Independently checks the entire finite universal witness bundle, or one
/// existential witness, against the actual original graph and resource limits.
/// It cannot certify a missing predicate by omission or a forged derivation.
pub fn verify_quantified_proof(
    graph: &Graph,
    query: &QuantifiedQuery,
    witnesses: &[PredicateWitness],
    limits: Limits,
    max_candidates: usize,
) -> Result<(), String> {
    let domain = checked_domain(graph, query, max_candidates)?;
    let actual: Vec<&str> = witnesses.iter().map(|w| w.predicate.as_str()).collect();
    match query.quantifier {
        PredicateQuantifier::All => {
            if actual != domain.iter().map(String::as_str).collect::<Vec<_>>() {
                return Err(
                    "universal proof omits, repeats or reorders predicate witnesses".into(),
                );
            }
        }
        PredicateQuantifier::Any => {
            if actual.len() != 1
                || domain
                    .binary_search_by(|p| p.as_str().cmp(actual[0]))
                    .is_err()
            {
                return Err("existential proof must contain exactly one domain witness".into());
            }
        }
    }
    for witness in witnesses {
        let atom = Atom {
            predicate: witness.predicate.clone(),
            terms: query.terms.clone(),
        };
        graph.verify_consistent_proof(&atom, &witness.proof, limits)?;
    }
    Ok(())
}
