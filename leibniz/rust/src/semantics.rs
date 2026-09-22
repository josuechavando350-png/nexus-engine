//! Explicit, read-only domain semantics for LEIBNIZ's existing flow and
//! restriction records. Nothing here guesses units, exchange rates, a
//! physical conservation law, or whether a source is telling the truth.
//!
//! The source models in `models/schema.rs` are unchanged. A semantic snapshot
//! requires one independently sourced annotation for *every* existing record.
//! It cannot silently interpret an unannotated number as a physical quantity.

use crate::{Graph, ProblemSnapshot};
use std::collections::BTreeMap;

/// Integer exponents over named base dimensions. `MXN` and `USD` intentionally
/// have different dimensions: exchange rates must be supplied and justified
/// explicitly, not inferred from numeric equality.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dimension {
    powers: BTreeMap<String, i16>,
}

impl Dimension {
    pub fn new(powers: impl IntoIterator<Item = (String, i16)>) -> Result<Self, String> {
        let mut terms = BTreeMap::new();
        for (name, power) in powers {
            if name.trim().is_empty() || power == 0 {
                return Err("dimension requires nonempty names and nonzero exponents".into());
            }
            if terms.insert(name, power).is_some() {
                return Err("duplicate base dimension".into());
            }
        }
        if terms.is_empty() {
            return Err("dimension cannot be empty".into());
        }
        Ok(Self { powers: terms })
    }

    /// A pure fraction, probability or dimensionless ratio.
    pub fn dimensionless() -> Self {
        Self {
            powers: BTreeMap::new(),
        }
    }

    /// Deterministic read-only exposure for versioned semantic serialization.
    pub fn powers(&self) -> &BTreeMap<String, i16> {
        &self.powers
    }

    pub fn exponent(&self, name: &str) -> i16 {
        self.powers.get(name).copied().unwrap_or(0)
    }
}

/// The scale converts this unit to its named dimension's agreed reference
/// unit. It does not make a cross-currency or cross-domain conversion.
#[derive(Debug, Clone, PartialEq)]
pub struct Unit {
    pub symbol: String,
    pub dimension: Dimension,
    pub scale_to_reference: f64,
}

impl Unit {
    pub fn new(
        symbol: impl Into<String>,
        dimension: Dimension,
        scale_to_reference: f64,
    ) -> Result<Self, String> {
        let symbol = symbol.into();
        if symbol.trim().is_empty() || !scale_to_reference.is_finite() || scale_to_reference <= 0.0
        {
            return Err("unit requires a name and a finite positive scale".into());
        }
        Ok(Self {
            symbol,
            dimension,
            scale_to_reference,
        })
    }

    /// The caller must provide the reference scales. Failure on overflow is
    /// preferable to manufacturing a finite but incorrect prediction.
    pub fn convert(&self, amount: f64, target: &Unit) -> Result<f64, String> {
        if self.dimension != target.dimension {
            return Err(
                "incompatible dimensions; conversion requires an explicit domain model".into(),
            );
        }
        // Unit fields are public. Recheck both operands at the point of use;
        // a caller can mutate an otherwise valid unit after construction.
        if self.symbol.trim().is_empty()
            || target.symbol.trim().is_empty()
            || !self.scale_to_reference.is_finite()
            || !target.scale_to_reference.is_finite()
            || self.scale_to_reference <= 0.0
            || target.scale_to_reference <= 0.0
        {
            return Err("unit conversion requires valid finite positive scales".into());
        }
        // A symbol is one named unit, not a license to provide a second,
        // conflicting conversion factor for that very same unit.
        if self.symbol == target.symbol
            && self.scale_to_reference.to_bits() != target.scale_to_reference.to_bits()
        {
            return Err("conflicting scale declarations for the same unit symbol".into());
        }
        if !amount.is_finite() {
            return Err("nonfinite quantity".into());
        }
        if amount == 0.0 {
            return Ok(amount);
        }

        // Neither evaluation order is safe for every representable f64:
        // (amount * source) / target can overflow/underflow in the product,
        // while amount * (source / target) can overflow/underflow in the ratio.
        // Use the first order when its intermediates are finite and nonzero,
        // otherwise try the second. Never silently turn a nonzero measurement
        // into zero or accept an infinity as a usable numerical observation.
        let scaled = amount * self.scale_to_reference;
        if scaled.is_finite() && scaled != 0.0 {
            let converted = scaled / target.scale_to_reference;
            if converted.is_finite() && converted != 0.0 {
                return Ok(converted);
            }
        }
        let ratio = self.scale_to_reference / target.scale_to_reference;
        if ratio.is_finite() && ratio > 0.0 {
            let converted = amount * ratio;
            if converted.is_finite() && converted != 0.0 {
                return Ok(converted);
            }
        }
        Err("unit conversion overflow or underflow; refusing a misleading value".into())
    }
}

/// One symbol must identify one dimension and one *exact* reference scale
/// within the same problem. Otherwise a caller can claim two incompatible
/// definitions for "contacts/day" and obtain a fabricated sum or objective.
/// Cross-symbol conversion still requires explicitly supplied reference scales.
pub(crate) fn validate_unit_symbols<'a>(
    units: impl IntoIterator<Item = &'a Unit>,
) -> Result<(), String> {
    let mut known: BTreeMap<&'a str, (&'a Dimension, u64)> = BTreeMap::new();
    for unit in units {
        if unit.symbol.trim().is_empty()
            || !unit.scale_to_reference.is_finite()
            || unit.scale_to_reference <= 0.0
        {
            return Err("unit requires a name and a finite positive scale".into());
        }
        let definition = (&unit.dimension, unit.scale_to_reference.to_bits());
        if let Some(previous) = known.get(unit.symbol.as_str()) {
            if *previous != definition {
                return Err(format!(
                    "conflicting dimension or scale for unit symbol: {}",
                    unit.symbol
                ));
            }
        } else {
            known.insert(unit.symbol.as_str(), definition);
        }
    }
    Ok(())
}

/// Half-open time interval [start_ms, end_ms); `None` means no known end.
/// Time values are UTC Unix milliseconds, not local wall-clock strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Validity {
    pub start_ms: i64,
    pub end_ms: Option<i64>,
}

impl Validity {
    pub fn new(start_ms: i64, end_ms: Option<i64>) -> Result<Self, String> {
        if end_ms.is_some_and(|end| end <= start_ms) {
            return Err("validity end must be after start".into());
        }
        Ok(Self { start_ms, end_ms })
    }

    pub fn contains(&self, at_ms: i64) -> bool {
        at_ms >= self.start_ms && self.end_ms.is_none_or(|end| at_ms < end)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Annotation {
    pub unit: Unit,
    pub validity: Validity,
    /// Identifies the external evidence supporting this measurement; a label
    /// is not a cryptographic signature or a verification of the source.
    pub evidence_id: String,
}

impl Annotation {
    pub fn new(
        unit: Unit,
        validity: Validity,
        evidence_id: impl Into<String>,
    ) -> Result<Self, String> {
        let evidence_id = evidence_id.into();
        if evidence_id.trim().is_empty() {
            return Err("measurement requires a nonempty evidence ID".into());
        }
        Ok(Self {
            unit,
            validity,
            evidence_id,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct QualifiedFlow {
    pub from_entity: String,
    pub to_entity: String,
    pub rate: f64,
    pub annotation: Annotation,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QualifiedRestriction {
    pub source_id: String,
    pub target_id: String,
    pub constraint_type: crate::schema::RestrictionType,
    pub boundary: f64,
    pub annotation: Annotation,
}

/// A detached read-only snapshot. Existing Graph, persistence format, GAUSS
/// operators and the four certainty states are not changed by this layer.
#[derive(Debug, Clone, PartialEq)]
pub struct SemanticSnapshot {
    pub problem: ProblemSnapshot,
    pub flows: Vec<QualifiedFlow>,
    pub restrictions: Vec<QualifiedRestriction>,
}

impl SemanticSnapshot {
    /// Every existing numeric flow and restriction must have one annotation,
    /// in the exact order they appear in `Graph::snapshot()`. No gap or
    /// extrapolation is permitted. Every transfer rate must be per unit time.
    pub fn from_graph(
        graph: &Graph,
        flow_annotations: Vec<Annotation>,
        restriction_annotations: Vec<Annotation>,
    ) -> Result<Self, String> {
        let problem = graph.snapshot();
        if problem.flows.len() != flow_annotations.len()
            || problem.restrictions.len() != restriction_annotations.len()
        {
            return Err("every flow and restriction needs exactly one annotation".into());
        }
        for annotation in flow_annotations.iter().chain(&restriction_annotations) {
            if annotation.evidence_id.trim().is_empty() {
                return Err("empty evidence ID".into());
            }
            if annotation.unit.symbol.trim().is_empty()
                || !annotation.unit.scale_to_reference.is_finite()
                || annotation.unit.scale_to_reference <= 0.0
            {
                return Err("invalid unit supplied in annotation".into());
            }
            if annotation
                .validity
                .end_ms
                .is_some_and(|end| end <= annotation.validity.start_ms)
            {
                return Err("invalid validity interval".into());
            }
        }
        validate_unit_symbols(
            flow_annotations
                .iter()
                .map(|item| &item.unit)
                .chain(restriction_annotations.iter().map(|item| &item.unit)),
        )?;
        let mut flows = Vec::with_capacity(problem.flows.len());
        for (flow, annotation) in problem.flows.iter().zip(flow_annotations) {
            if annotation.unit.dimension.exponent("time") != -1 {
                return Err("flow must have a per-time dimension (time exponent -1)".into());
            }
            if !flow.rate_of_transfer.is_finite() || flow.rate_of_transfer < 0.0 {
                return Err("invalid flow rate".into());
            }
            flows.push(QualifiedFlow {
                from_entity: flow.from_entity.clone(),
                to_entity: flow.to_entity.clone(),
                rate: flow.rate_of_transfer,
                annotation,
            });
        }
        let mut restrictions = Vec::with_capacity(problem.restrictions.len());
        for (restriction, annotation) in problem.restrictions.iter().zip(restriction_annotations) {
            if !restriction.boundary_value.is_finite() {
                return Err("invalid restriction boundary".into());
            }
            restrictions.push(QualifiedRestriction {
                source_id: restriction.source_id.clone(),
                target_id: restriction.target_id.clone(),
                constraint_type: restriction.constraint_type,
                boundary: restriction.boundary_value,
                annotation,
            });
        }
        Ok(Self {
            problem,
            flows,
            restrictions,
        })
    }

    /// Returns only measurements whose explicitly provided interval covers
    /// the instant; absence is not treated as zero or as a negative fact.
    pub fn flows_at(&self, at_ms: i64) -> Vec<&QualifiedFlow> {
        self.flows
            .iter()
            .filter(|flow| flow.annotation.validity.contains(at_ms))
            .collect()
    }

    pub fn restrictions_at(&self, at_ms: i64) -> Vec<&QualifiedRestriction> {
        self.restrictions
            .iter()
            .filter(|item| item.annotation.validity.contains(at_ms))
            .collect()
    }
}
