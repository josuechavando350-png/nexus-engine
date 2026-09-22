//! Read-only composition of the independent proof checker, standard-model
//! counterexample interpreter, and the existing trusted-source GAUSS contract.
//!
//! A closed STT theorem is *never* evidence of a real-world observation. A
//! finite model may refute a proposition, but testing finitely many models
//! cannot prove universal validity. A structurally sound ESTIMATED response
//! is never promoted to verified/calibrated or to PROVEN.
use crate::finite_model::FiniteModel;
use crate::handoff::{GaussProblemV1, GaussResponseV1, HandoffAssurance, HandoffLimits};
use crate::hol::{verify, Budget, Derivation, Expr};
use crate::semantic_archive::SemanticArchive;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuditLimits {
    pub max_individuals: usize,
    pub max_domain: usize,
    pub max_steps_per_model: usize,
    pub proof: Budget,
}

impl Default for AuditLimits {
    fn default() -> Self {
        Self {
            max_individuals: 2,
            max_domain: 256,
            max_steps_per_model: 1_000_000,
            proof: Budget::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FormalAudit {
    /// The independent deductive kernel checked a supplied CLOSED proof, and
    /// every requested finite standard model agrees. Not an external fact.
    ClosedTheoremChecked { models_checked: usize },
    /// The formula was false in a concrete full finite standard model.
    FiniteCounterexample { individuals: usize },
    /// Finite checks found no countermodel; no closed proof was supplied.
    Undetermined { models_checked: usize },
}

/// No effects or GAUSS calls. A supplied certificate that does not check is
/// an ERROR, never silently discarded in favor of an inconclusive result.
/// A model resource failure is also an ERROR, never mistaken for validity.
/// Only closed formulas without uninterpreted constants are admitted: there
/// is no implicit, fabricated mapping from ontology entities to HOL domains.
pub fn audit_closed(
    proposition: &Expr,
    certificate: Option<&Derivation>,
    limits: AuditLimits,
) -> Result<FormalAudit, String> {
    if !(1..=4).contains(&limits.max_individuals)
        || limits.max_domain == 0
        || limits.max_steps_per_model == 0
        || limits.proof.max_nodes == 0
        || limits.proof.max_reductions == 0
    {
        return Err("invalid formal-audit resource limits".into());
    }
    if let Some(proof) = certificate {
        verify(proposition, &[], proof, limits.proof)
            .map_err(|error| format!("invalid closed higher-order proof: {error}"))?;
    }
    // The model interpreter rejects open variables, undeclared constants and
    // ill-typed terms even when no proof is supplied.
    for individuals in 1..=limits.max_individuals {
        let model = FiniteModel::new(individuals, limits.max_domain, limits.max_steps_per_model)?;
        if !model.evaluate(proposition)? {
            if certificate.is_some() {
                return Err(format!("checked derivation contradicts independent {individuals}-individual standard model"));
            }
            return Ok(FormalAudit::FiniteCounterexample { individuals });
        }
    }
    Ok(if certificate.is_some() {
        FormalAudit::ClosedTheoremChecked { models_checked: limits.max_individuals }
    } else {
        FormalAudit::Undetermined { models_checked: limits.max_individuals }
    })
}

/// These assurances are deliberately separate. In particular, proving a
/// tautology does not turn an external estimate into a factual prediction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadOnlyAudit {
    pub handoff: HandoffAssurance,
    pub formal: FormalAudit,
}

/// Reconstructs the problem from an independently trusted local archive and
/// checks the actual supplied GAUSS response against its source graph before
/// running the unrelated closed logical theorem audit. Does NOT invoke GAUSS.
/// Caller must authorize the problem ID, question and instant independently.
pub fn audit_trusted_handoff(
    response: &GaussResponseV1,
    problem: &GaussProblemV1,
    trusted_archive: &SemanticArchive,
    handoff_limits: HandoffLimits,
    proposition: &Expr,
    certificate: Option<&Derivation>,
    formal_limits: AuditLimits,
) -> Result<ReadOnlyAudit, String> {
    let handoff = response.assess_against_trusted_source(problem, trusted_archive, handoff_limits)?;
    let formal = audit_closed(proposition, certificate, formal_limits)?;
    Ok(ReadOnlyAudit { handoff, formal })
}
