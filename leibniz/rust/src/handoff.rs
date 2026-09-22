//! LEIBNIZ -> GAUSS: *read-only* and explicitly versioned problem boundary.
//!
//! Preparing a problem is real data validation and normalization. It does not
//! call GAUSS, simulate a future, identify a causal effect, or mint a proof.
//! GAUSS's existing algorithms and the original manifesto are untouched.

use crate::schema::{AttributeValue, Entity};
use crate::semantic_archive::SemanticArchive;
use crate::semantics::{validate_unit_symbols, QualifiedFlow, QualifiedRestriction, Unit};
use crate::{Atom, GraphArchive, Limits, Proof};
use std::collections::BTreeSet;

pub const CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Minimize,
    Maximize,
}

/// A user-supplied, *declared* objective, not an automatically derived law.
/// Evidence that the objective is appropriate must come from a domain model.
#[derive(Debug, Clone, PartialEq)]
pub struct Objective {
    pub metric: String,
    pub subject_entity_id: String,
    pub unit: Unit,
    pub direction: Direction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandoffLimits {
    pub max_entities: usize,
    pub max_numeric_records: usize,
    pub max_assertions: usize,
    pub max_rules: usize,
}

impl Default for HandoffLimits {
    fn default() -> Self {
        Self {
            max_entities: 100_000,
            max_numeric_records: 100_000,
            max_assertions: 100_000,
            max_rules: 10_000,
        }
    }
}

/// Prepared input includes all asserted sources and registered rules, plus
/// only measurements valid at the explicitly chosen instant. Nothing is
/// inferred from an expired measurement or silently interpreted as zero.
#[derive(Debug, Clone, PartialEq)]
pub struct GaussProblemV1 {
    pub contract_version: u32,
    pub problem_id: String,
    pub as_of_utc_ms: i64,
    pub objective: Objective,
    pub entities: Vec<Entity>,
    pub active_flows: Vec<QualifiedFlow>,
    pub active_restrictions: Vec<QualifiedRestriction>,
    pub source_graph: GraphArchive,
}

fn nonempty(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(())
    }
}

impl GaussProblemV1 {
    pub fn prepare(
        archive: &SemanticArchive,
        problem_id: impl Into<String>,
        as_of_utc_ms: i64,
        objective: Objective,
        limits: HandoffLimits,
    ) -> Result<Self, String> {
        let problem_id = problem_id.into();
        nonempty(&problem_id, "problem_id")?;
        nonempty(&objective.metric, "objective metric")?;
        nonempty(&objective.subject_entity_id, "objective subject")?;
        let unit = Unit::new(
            objective.unit.symbol.clone(),
            objective.unit.dimension.clone(),
            objective.unit.scale_to_reference,
        )?;
        if limits.max_entities == 0
            || limits.max_numeric_records == 0
            || limits.max_assertions == 0
            || limits.max_rules == 0
        {
            return Err("all handoff limits must be positive".into());
        }
        let snapshot = &archive.snapshot;
        if snapshot.problem.entities.len() > limits.max_entities
            || snapshot
                .flows
                .len()
                .saturating_add(snapshot.restrictions.len())
                > limits.max_numeric_records
            || snapshot.problem.asserted_facts.len() > limits.max_assertions
        {
            return Err("handoff resource limit exceeded".into());
        }
        // The public archive and snapshot fields may have been mutated since
        // construction. Rebind and validate them before exporting any data.
        SemanticArchive::new(archive.graph.clone(), snapshot.clone())?;
        let source_graph = archive.graph.export_archive();
        if source_graph.rules.len() > limits.max_rules {
            return Err("handoff rule limit exceeded".into());
        }
        let entities = snapshot.problem.entities.clone();
        if !entities.iter().any(|e| e.id == objective.subject_entity_id) {
            return Err("objective subject does not exist in source graph".into());
        }
        // The objective must not redefine an existing unit symbol with a
        // different dimension or scale, including an expired measurement.
        validate_unit_symbols(
            snapshot
                .flows
                .iter()
                .map(|item| &item.annotation.unit)
                .chain(
                    snapshot
                        .restrictions
                        .iter()
                        .map(|item| &item.annotation.unit),
                )
                .chain(std::iter::once(&unit)),
        )?;
        let active_flows: Vec<_> = snapshot
            .flows_at(as_of_utc_ms)
            .into_iter()
            .cloned()
            .collect();
        let active_restrictions: Vec<_> = snapshot
            .restrictions_at(as_of_utc_ms)
            .into_iter()
            .cloned()
            .collect();
        if active_flows.len().saturating_add(active_restrictions.len()) > limits.max_numeric_records
        {
            return Err("active measurement limit exceeded".into());
        }
        // Dimensional compatibility is necessary, but does not establish that
        // the objective is causally identifiable or mathematically solvable.
        let relevant = active_flows.iter().any(|flow| {
            (flow.from_entity == objective.subject_entity_id
                || flow.to_entity == objective.subject_entity_id)
                && flow.annotation.unit.dimension == unit.dimension
        }) || active_restrictions.iter().any(|restriction| {
            (restriction.source_id == objective.subject_entity_id
                || restriction.target_id == objective.subject_entity_id)
                && restriction.annotation.unit.dimension == unit.dimension
        });
        if !relevant {
            return Err("no active, dimension-compatible evidence for the objective".into());
        }
        Ok(Self {
            contract_version: CONTRACT_VERSION,
            problem_id,
            as_of_utc_ms,
            objective: Objective { unit, ..objective },
            entities,
            active_flows,
            active_restrictions,
            source_graph,
        })
    }

    /// Computes a *measured sum* of simultaneous rates on one directed edge.
    /// This is not a forecast, a conservation law or a GAUSS simulation.
    /// Unlike a zero default, a missing measurement returns an error.
    pub fn measured_flow_sum(
        &self,
        from_entity: &str,
        to_entity: &str,
        target_unit: &Unit,
    ) -> Result<MeasuredRate, String> {
        nonempty(from_entity, "from_entity")?;
        nonempty(to_entity, "to_entity")?;
        let target_unit = Unit::new(
            target_unit.symbol.clone(),
            target_unit.dimension.clone(),
            target_unit.scale_to_reference,
        )?;
        validate_unit_symbols(
            self.active_flows
                .iter()
                .map(|item| &item.annotation.unit)
                .chain(
                    self.active_restrictions
                        .iter()
                        .map(|item| &item.annotation.unit),
                )
                .chain(std::iter::once(&target_unit)),
        )?;
        if target_unit.dimension.exponent("time") != -1 {
            return Err("flow aggregation requires a per-time target unit".into());
        }
        let mut count = 0usize;
        let mut sum = 0.0_f64;
        let mut correction = 0.0_f64;
        let mut evidence_ids = Vec::new();
        let mut distinct_evidence = BTreeSet::new();
        for flow in self
            .active_flows
            .iter()
            .filter(|f| f.from_entity == from_entity && f.to_entity == to_entity)
        {
            if flow.annotation.unit.dimension != target_unit.dimension {
                return Err("mixed dimensions on the same edge; refuse to aggregate".into());
            }
            if !distinct_evidence.insert(&flow.annotation.evidence_id) {
                return Err(
                    "repeated evidence ID on the same edge; refuse possible double counting".into(),
                );
            }
            // Neumaier compensated summation; protects against avoidable
            // rounding loss, without promising arbitrary-precision arithmetic.
            let value = flow.annotation.unit.convert(flow.rate, &target_unit)?;
            let next = sum + value;
            if !next.is_finite() {
                return Err("rate accumulation overflow".into());
            }
            if sum.abs() >= value.abs() {
                correction += (sum - next) + value;
            } else {
                correction += (value - next) + sum;
            }
            if !correction.is_finite() {
                return Err("rate correction overflow".into());
            }
            sum = next;
            evidence_ids.push(flow.annotation.evidence_id.clone());
            count += 1;
        }
        if count == 0 {
            return Err("no active measured flow for this directed edge".into());
        }
        let total = sum + correction;
        if !total.is_finite() {
            return Err("aggregated flow overflow".into());
        }
        Ok(MeasuredRate {
            value: total,
            unit: target_unit,
            evidence_ids,
        })
    }

    /// Only this entry point binds the returned measurement to a trusted
    /// local archive. The older measured_flow_sum API operates on caller-
    /// supplied public fields and cannot authenticate their provenance.
    pub fn measured_flow_sum_against_trusted_source(
        &self,
        from_entity: &str,
        to_entity: &str,
        target_unit: &Unit,
        trusted_archive: &SemanticArchive,
        limits: HandoffLimits,
    ) -> Result<MeasuredRate, String> {
        let trusted = self.rebuild_from_trusted_source(trusted_archive, limits)?;
        trusted.measured_flow_sum(from_entity, to_entity, target_unit)
    }

    /// Source check shared by numerical aggregation and response assessment:
    /// bitwise checks disallow signed-zero substitution in public f64 fields.
    fn rebuild_from_trusted_source(
        &self,
        trusted_archive: &SemanticArchive,
        limits: HandoffLimits,
    ) -> Result<Self, String> {
        let reconstructed = Self::prepare(
            trusted_archive,
            self.problem_id.clone(),
            self.as_of_utc_ms,
            self.objective.clone(),
            limits,
        )?;
        let received_graph_bytes =
            crate::Graph::from_archive(self.source_graph.clone())?.to_archive_bytes()?;
        let trusted_graph_bytes = trusted_archive.graph.to_archive_bytes()?;
        let same_flow_bits = reconstructed
            .active_flows
            .iter()
            .zip(&self.active_flows)
            .all(|(left, right)| left.rate.to_bits() == right.rate.to_bits());
        let same_boundary_bits = reconstructed
            .active_restrictions
            .iter()
            .zip(&self.active_restrictions)
            .all(|(left, right)| left.boundary.to_bits() == right.boundary.to_bits());
        let same_entity_bits =
            reconstructed
                .entities
                .iter()
                .zip(&self.entities)
                .all(|(left, right)| {
                    left.attributes.iter().all(|(name, value)| {
                        match (value, right.attributes.get(name)) {
                            (AttributeValue::Number(a), Some(AttributeValue::Number(b))) => {
                                a.to_bits() == b.to_bits()
                            }
                            _ => true, // PartialEq below checks attribute existence and text.
                        }
                    })
                });
        if &reconstructed != self
            || received_graph_bytes != trusted_graph_bytes
            || !same_flow_bits
            || !same_boundary_bits
            || !same_entity_bits
        {
            return Err("GAUSS problem does not match trusted LEIBNIZ source".into());
        }
        Ok(reconstructed)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeasuredRate {
    pub value: f64,
    pub unit: Unit,
    pub evidence_ids: Vec<String>,
}

/// An **untrusted external response**. Validating shape and logical proofs
/// never certifies probabilistic calibration or that a forecast came true.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GaussOutcomeV1 {
    Proven {
        query: Atom,
        proof: Proof,
    },
    Estimated {
        /// 1..=9999: 10000 is not allowed to masquerade as logical proof.
        probability_basis_points: u16,
        claim: String,
        model_id: String,
        estimation_evidence_id: String,
        calibration_evidence_id: String,
    },
    Unidentifiable {
        reason: String,
    },
    Abstain {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GaussResponseV1 {
    pub contract_version: u32,
    pub problem_id: String,
    pub outcome: GaussOutcomeV1,
}

/// Do not confuse syntactic response acceptance with mathematical assurance.
/// The standalone workbench cannot validate an external estimator's calibration,
/// or independently confirm why an external engine abstained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffAssurance {
    LogicalProofVerified,
    EstimateStructureOnly,
    UnidentifiableReported,
    AbstentionReported,
}

impl GaussResponseV1 {
    /// Rebind the response's *mutable, caller-provided* problem to a trusted
    /// local source. `assess_against` alone assumes that its problem has not
    /// been replaced or altered after preparation; it does not authenticate
    /// a problem. Do not use an untrusted copy as `trusted_archive`.
    ///
    /// The chosen objective, instant and problem ID still require caller-side
    /// authorization: a source graph cannot decide which question was asked.
    pub fn assess_against_trusted_source(
        &self,
        problem: &GaussProblemV1,
        trusted_archive: &SemanticArchive,
        limits: HandoffLimits,
    ) -> Result<HandoffAssurance, String> {
        let reconstructed = problem.rebuild_from_trusted_source(trusted_archive, limits)?;
        self.assess_against(&reconstructed)
    }

    /// Checks the response is for this request and a PROVEN proof is derivable
    /// from the source graph AND consistent under bounded full closure.
    /// A locally valid proof in a contradictory graph cannot become PROVEN.
    /// ESTIMATED passes *structural validation only*;
    /// an independently benchmarked GAUSS adapter is required for calibration.
    pub fn validate_against(&self, problem: &GaussProblemV1) -> Result<(), String> {
        self.assess_against(problem).map(|_| ())
    }

    /// The assurance distinguishes a verified logical derivation from an
    /// uncalibrated numerical estimate or a merely reported abstention.
    pub fn assess_against(&self, problem: &GaussProblemV1) -> Result<HandoffAssurance, String> {
        if self.contract_version != CONTRACT_VERSION || problem.contract_version != CONTRACT_VERSION
        {
            return Err("unsupported LEIBNIZ-GAUSS contract version".into());
        }
        if self.problem_id != problem.problem_id || self.problem_id.trim().is_empty() {
            return Err("GAUSS response problem_id mismatch".into());
        }
        match &self.outcome {
            GaussOutcomeV1::Proven { query, proof } => {
                let graph = crate::Graph::from_archive(problem.source_graph.clone())?;
                graph.verify_consistent_proof(query, proof, Limits::default())?;
                Ok(HandoffAssurance::LogicalProofVerified)
            }
            GaussOutcomeV1::Estimated {
                probability_basis_points,
                claim,
                model_id,
                estimation_evidence_id,
                calibration_evidence_id,
            } => {
                if *probability_basis_points == 0 || *probability_basis_points >= 10_000 {
                    return Err("estimated probability must be 1..=9999 basis points".into());
                }
                for (value, label) in [
                    (claim.as_str(), "estimated claim"),
                    (model_id.as_str(), "model ID"),
                    (estimation_evidence_id.as_str(), "estimation evidence ID"),
                    (calibration_evidence_id.as_str(), "calibration evidence ID"),
                ] {
                    nonempty(value, label)?;
                }
                Ok(HandoffAssurance::EstimateStructureOnly)
            }
            GaussOutcomeV1::Unidentifiable { reason } => {
                nonempty(reason, "decision reason")?;
                Ok(HandoffAssurance::UnidentifiableReported)
            }
            GaussOutcomeV1::Abstain { reason } => {
                nonempty(reason, "decision reason")?;
                Ok(HandoffAssurance::AbstentionReported)
            }
        }
    }
}
